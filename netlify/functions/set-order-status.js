// Netlify Function: set-order-status.js
// Flips an order's payment status between AWAITING_ZELLE and PAID.
//
// Added 2026-08-13. Square deactivated this account on 2026-08-12, so marking a
// Square invoice "paid" is no longer possible — that was how Frank tracked which
// Zelle payments had landed. The flag now lives in the Square order's metadata
// and this endpoint is what writes it, driven by the Mark Paid button in
// /admin.html. See create-invoice.js and get-orders.js.
//
// This records a bookkeeping flag. It does NOT move money — but it DOES record an
// EXTERNAL tender (added 2026-08-14), which is bookkeeping rather than
// processing and works on a deactivated account.
//
// 🔑 AND IT NOW PUSHES THE RESULT STRAIGHT INTO THE DASHBOARD (2026-08-20,
// step 1 of moving off Square). It used to write to Square only, leaving the
// dashboard to find out on a sync — and FP-001004 proved how badly that fails:
// marked paid in Square, invisible here for three months, because the sync
// window was 60 days and the order was 91 days old. A payment you have just
// recorded must be true on the screen you recorded it from.
//
// 🚨 THE DOUBLE-COUNT TRAP THIS AVOIDS. The obvious shortcut is to write a
// dashboard tender directly from the payment response. Do not: Square's PAYMENT
// id is not the same thing as the order's TENDER id, and sync_order_tenders()
// upserts on the tender id (tenders_square_id_key). A directly-written row would
// carry the wrong key, and the next re-sync would add the real one alongside it
// — the same money, counted twice, in the books. So this re-READS the order
// after the payment and syncs THAT, letting the tender arrive with the id every
// future sync will match on.

const { verifyToken } = require('./_auth-token');
const { syncOrder, configured } = require('./_order-sync');

const SQUARE_API  = 'https://connect.squareup.com/v2';
const TOKEN       = process.env.SQUARE_ACCESS_TOKEN;
const LOCATION_ID = process.env.SQUARE_LOCATION_ID;

const ALLOWED_STATUSES = ['AWAITING_ZELLE', 'PAID'];

function squareHeaders() {
  return {
    'Authorization': `Bearer ${TOKEN}`,
    'Content-Type':  'application/json',
    'Square-Version': '2024-01-18',
  };
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const SECRET = process.env.ADMIN_TOKEN_SECRET;
  if (!SECRET) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ADMIN_TOKEN_SECRET not configured.' }) };
  }
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  if (!verifyToken(SECRET, authHeader.replace(/^Bearer\s+/i, ''))) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  if (!TOKEN || !LOCATION_ID) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing Square env vars.' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { orderId, status } = body;
  if (!orderId || !ALLOWED_STATUSES.includes(status)) {
    return {
      statusCode: 400, headers,
      body: JSON.stringify({ error: `orderId required; status must be one of ${ALLOWED_STATUSES.join(', ')}` }),
    };
  }

  try {
    // Square requires the current version for an optimistic-concurrency update,
    // so read before write. This also merges rather than clobbers metadata —
    // an UpdateOrder replaces the whole metadata map.
    const getRes  = await fetch(`${SQUARE_API}/orders/${encodeURIComponent(orderId)}`, {
      headers: squareHeaders(),
    });
    const getData = await getRes.json();
    if (!getData.order) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Order not found' }) };
    }

    const order       = getData.order;
    const hasTender   = Array.isArray(order.tenders) && order.tenders.length > 0;

    // ── Undo Paid is blocked once real money is on the books ─────────────────
    // Recording a tender is heavier than flipping a flag: get-orders trusts a
    // real tender over the metadata flag, so clearing the flag alone would
    // leave the dashboard still showing PAID and the button looking broken.
    // Voiding a recorded payment is a money operation — Frank does that in
    // Square, deliberately, not with a dashboard toggle.
    if (status === 'AWAITING_ZELLE' && hasTender) {
      return {
        statusCode: 409, headers,
        body: JSON.stringify({
          error: 'This order has a recorded payment in Square. Void or refund it in the Square dashboard first — a payment can\'t be undone from here.',
        }),
      };
    }

    const existing = order.metadata || {};
    const metadata = {
      ...existing,
      payment_status: status,
      // 10-key metadata cap: only add the timestamp if there's room or it's
      // already there, so a marked-paid order can't fail on a full map.
      ...(existing.paid_marked_at || Object.keys(existing).length < 10
        ? { paid_marked_at: new Date().toISOString().slice(0, 19) + 'Z' }
        : {}),
    };

    const updRes  = await fetch(`${SQUARE_API}/orders/${encodeURIComponent(orderId)}`, {
      method: 'PUT',
      headers: squareHeaders(),
      body: JSON.stringify({
        idempotency_key: `forge-status-${orderId}-${status}-${Date.now()}`,
        order: { location_id: LOCATION_ID, version: getData.order.version, metadata },
      }),
    });
    const updData = await updRes.json();
    if (!updData.order) {
      console.error('set-order-status update failed:', JSON.stringify(updData.errors || updData));
      return {
        statusCode: 502, headers,
        body: JSON.stringify({ error: 'Square rejected the update', detail: updData.errors || null }),
      };
    }

    // ── Record the Zelle payment as a real Square tender ─────────────────────
    // Added 2026-08-14. The metadata flag is private to this application, so
    // Square's own dashboard and every sales report were blind to it — revenue
    // under-reported by every Zelle sale. An EXTERNAL tender is bookkeeping,
    // not processing: no money moves through Square, and it still works on a
    // deactivated account (verified 2026-08-13).
    //
    // Best-effort by design: if this fails the order is still marked paid in
    // the dashboard, and the response says so rather than pretending.
    let tenderRecorded = hasTender;
    let tenderNote     = hasTender ? 'already recorded' : null;

    if (status === 'PAID' && !hasTender) {
      const due = order.net_amount_due_money?.amount ?? order.total_money?.amount ?? 0;
      if (due > 0) {
        try {
          const payRes = await fetch(`${SQUARE_API}/payments`, {
            method: 'POST',
            headers: squareHeaders(),
            body: JSON.stringify({
              // Deterministic key: a double-click can never double-record.
              idempotency_key: `forge-zelle-${orderId}`.slice(0, 45),
              source_id:  'EXTERNAL',
              order_id:   orderId,
              location_id: LOCATION_ID,
              amount_money: { amount: due, currency: 'USD' },
              external_details: { type: 'OTHER', source: 'Zelle' },
              note: 'Zelle',
            }),
          });
          const payData = await payRes.json();
          if (payData.payment) {
            tenderRecorded = true;
          } else {
            tenderNote = 'Square rejected the payment record';
            console.error(`TENDER NOT RECORDED for ${orderId}:`, JSON.stringify(payData.errors || payData));
          }
        } catch (payErr) {
          tenderNote = 'payment record failed';
          console.error(`TENDER NOT RECORDED for ${orderId}:`, payErr.message);
        }
      }
    }

    // ── Make the dashboard agree, now rather than on some later sync ─────────
    // ⚠️ Only ever syncs a FRESHLY READ order. Syncing the copy fetched before
    // the payment would carry the new PAID metadata with an empty tenders array,
    // and paymentState() reads that metadata — writing exactly the "paid with no
    // tender" state that hid $1,501.44 of revenue until migration 026. If the
    // re-read fails, the dashboard is left alone and a later sync fixes it;
    // being briefly behind is recoverable, being wrong is not.
    let dashboardSynced = false;
    let dashboardNote   = null;

    if (configured()) {
      try {
        const freshRes  = await fetch(`${SQUARE_API}/orders/${encodeURIComponent(orderId)}`, {
          headers: squareHeaders(),
        });
        const freshData = await freshRes.json();
        if (freshData.order) {
          await syncOrder(freshData.order);
          dashboardSynced = true;
          // Square can take a moment to attach a just-created payment to the
          // order. Saying so beats a silent "done" that leaves the money out of
          // revenue until someone presses Sync.
          const freshHasTender = Array.isArray(freshData.order.tenders) && freshData.order.tenders.length > 0;
          if (status === 'PAID' && tenderRecorded && !freshHasTender) {
            dashboardNote = 'Square has not attached the payment to the order yet — press Sync in a moment.';
          }
        } else {
          dashboardNote = 'Could not re-read the order from Square; the dashboard will catch up on the next sync.';
        }
      } catch (syncErr) {
        dashboardNote = 'The dashboard will catch up on the next sync.';
        console.error(`DASHBOARD SYNC FAILED for ${orderId}:`, syncErr.message);
      }
    }

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        success: true,
        orderId,
        status,
        tenderRecorded,
        tenderNote,
        // So the page can say whether this is true HERE, not just in Square.
        dashboardSynced,
        dashboardNote,
        orderNumber: updData.order.metadata?.forge_order_number || updData.order.reference_id || '',
      }),
    };

  } catch (err) {
    console.error('set-order-status error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
