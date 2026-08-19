// ─────────────────────────────────────────────────────────────────────────────
// Netlify Function: void-order.js
// Added 2026-08-19 — undo an order that should never have existed.
//
//   POST { orderId | orderNumber, reason?, acknowledgePayment? }
//
// Frank's ask: "for orders that were placed by mistake, I need an option to
// archive that order and void it, undo whatever, take it off of revenue, and put
// that stock back in stock."
//
// Three things happen, in this order and for a reason:
//   1. the stock that left on this order comes back
//   2. the order is marked CANCELED, which takes it off revenue
//   3. the reason is written onto the order so the record says why
//
// 🚨 STOCK IS RETURNED BY REVERSING THE LEDGER, NOT BY RE-ADDING THE ORDER
// QUANTITY. Those are different numbers whenever an order did not actually move
// stock — which is the normal case for the 19 orders migration 021 cancelled,
// and for any line whose product never resolved to a variant. Adding back "what
// the order says" would invent inventory that never left the shelf. This adds
// back exactly what the ledger recorded leaving, and nothing else.
//
// 🔑 IDEMPOTENT BY CONSTRUCTION, because stock_ledger is APPEND-ONLY and a
// double restock cannot be deleted. For each line item it computes the NET of
// every ledger row already against it and returns only a net shortfall. Run it
// twice and the second run nets to zero and writes nothing.
//
// 🔑 THE ORDER OF OPERATIONS IS THE ERROR HANDLING. Restock first, cancel
// second. If the cancel then fails, the order is still open with its stock back
// — visible, and a retry finishes the job because the restock is a no-op by
// then. Cancelling first and failing the restock would leave stock silently
// missing with the order already closed, and a retry would refuse to touch it.
//
// 🚨 AN ALREADY-CANCELLED ORDER IS NOT RE-STOCKED unless a previous void wrote
// the reversal rows. Migration 021 cancelled 19 orders and DELIBERATELY left
// their stock alone: the 2026-08-19 physical count already counted whatever
// never left, so reversing on top would double-count — Tesamorelin would read 7
// against a counted 2. A prior void is identified by its ledger rows
// (created_by = 'void'), so a half-finished void can still be completed while
// those 19 stay untouched.
//
// ⚠️ A TENDER IS NOT REFUNDED. Voiding takes the order off revenue; it does not
// move money. An order with a recorded payment needs acknowledgePayment, so
// real money is never written off by a stray click.
//
// 🔐 Token-gated like every admin endpoint.
// ─────────────────────────────────────────────────────────────────────────────

const { verifyToken } = require('./_auth-token');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const TIMEOUT_MS = 10000;

// Marks the ledger rows this endpoint writes. Also how a previous void is
// recognised — see the already-cancelled rule above.
const VOID_ACTOR = 'void';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function sb(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...options,
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      let message = `Supabase ${res.status}`;
      try { message = JSON.parse(text).message || message; } catch { /* not json */ }
      throw Object.assign(new Error(message), { status: res.status });
    }
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
  }
}

// PostgREST needs values in an `in.(…)` list quoted, or a uuid with no quotes is
// fine but a name with a comma would break the list. Quote everything.
const inList = (values) => `(${values.map((v) => `"${v}"`).join(',')})`;

/**
 * Find the order by whichever identifier the Orders tab had to hand.
 *
 * 🔑 There are two kinds of order and they are keyed differently. Square orders
 * carry a Square id; orders rung up at the counter exist only here and carry a
 * uuid. get-orders emits whichever applies as `orderId`, so the shape of the
 * value tells us which column to search. order_no is accepted as a fallback but
 * is NOT the primary key to match on: the migration minted order numbers for
 * every historical Square order, so a dashboard order_no and the FP- number in
 * Square's metadata are not necessarily the same string.
 */
async function findOrder({ orderId, orderNumber }) {
  const select = 'select=id,order_no,square_id,state,purpose,payment_state,total_cents,note,placed_at'
               + ',tenders(id,amount_cents)'
               + ',order_line_items(id,kind,variant_id,name_at_sale,quantity)';
  const tries = [];
  if (orderId) {
    tries.push(UUID_RE.test(orderId)
      ? `orders?${select}&id=eq.${encodeURIComponent(orderId)}`
      : `orders?${select}&square_id=eq.${encodeURIComponent(orderId)}`);
  }
  if (orderNumber) tries.push(`orders?${select}&order_no=eq.${encodeURIComponent(orderNumber)}`);

  for (const q of tries) {
    const rows = await sb(q);
    if (Array.isArray(rows) && rows.length) return rows[0];
  }
  return null;
}

/**
 * What this order actually took out of stock, per line item, net of anything
 * already given back.
 *
 * Returns { rows: [ledger rows to insert], units, priorVoid }.
 * `priorVoid` is true when a previous void already wrote reversal rows here.
 */
async function planRestock(order) {
  const productLines = (order.order_line_items || [])
    .filter((li) => li.kind === 'PRODUCT' && li.variant_id);
  if (!productLines.length) return { rows: [], units: 0, priorVoid: false };

  const ledger = await sb(
    `stock_ledger?select=order_line_item_id,variant_id,delta,created_by`
    + `&order_line_item_id=in.${inList(productLines.map((li) => li.id))}`,
  );

  const net = {};
  let priorVoid = false;
  for (const row of ledger || []) {
    net[row.order_line_item_id] = (net[row.order_line_item_id] || 0) + Number(row.delta || 0);
    if (row.created_by === VOID_ACTOR) priorVoid = true;
  }

  const rows = [];
  let units = 0;
  for (const li of productLines) {
    const n = net[li.id] || 0;
    // Only a net shortfall is returned. Zero means nothing left on this line, or
    // it has already been given back — either way there is nothing to do.
    if (n >= 0) continue;
    rows.push({
      variant_id: li.variant_id,
      delta: -n,
      reason: 'RETURN',
      order_line_item_id: li.id,
      note: `void of order ${order.order_no}`,
      created_by: VOID_ACTOR,
    });
    units += -n;
  }
  return { rows, units, priorVoid };
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  const SECRET = process.env.ADMIN_TOKEN_SECRET;
  if (!SECRET) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ADMIN_TOKEN_SECRET not configured.' }) };
  }
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  if (!verifyToken(SECRET, authHeader.replace(/^Bearer\s+/i, ''))) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase is not configured.' }) };
  }

  let input = {};
  try { input = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Body is not valid JSON' }) }; }

  const orderId     = typeof input.orderId === 'string' ? input.orderId.trim() : '';
  const orderNumber = typeof input.orderNumber === 'string' ? input.orderNumber.trim() : '';
  const reason      = typeof input.reason === 'string' ? input.reason.trim().slice(0, 200) : '';
  if (!orderId && !orderNumber) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'orderId or orderNumber is required' }) };
  }

  try {
    const order = await findOrder({ orderId, orderNumber });
    if (!order) {
      return {
        statusCode: 404, headers,
        body: JSON.stringify({
          error: 'That order is not in the dashboard database yet.',
          hint: 'Press "Sync from Square" on the Orders tab, then try again. An order has to be here before its stock can be put back.',
        }),
      };
    }

    const { rows, units, priorVoid } = await planRestock(order);
    const alreadyCancelled = order.state === 'CANCELED';

    // 🚨 Cancelled by something other than this endpoint — migration 021's 19
    // orders. Their stock was left alone on purpose and reversing it now would
    // double-count against the physical count that is already the authority.
    if (alreadyCancelled && !priorVoid) {
      return {
        statusCode: 409, headers,
        body: JSON.stringify({
          error: `${order.order_no} was already cancelled by an earlier correction.`,
          hint: 'Its stock was deliberately left alone at the time, because the physical count had already accounted for it. Putting it back now would count those units twice. If the stock really is missing, use Adjust stock on the Inventory tab so the change is recorded on its own terms.',
          orderNumber: order.order_no,
        }),
      };
    }

    // ⚠️ Real money is on the books. Say the number and make the caller say yes
    // to it — voiding removes the sale from revenue and refunds nothing.
    const tenderCents = (order.tenders || []).reduce((s, t) => s + Number(t.amount_cents || 0), 0);
    if (tenderCents > 0 && input.acknowledgePayment !== true) {
      return {
        statusCode: 409, headers,
        body: JSON.stringify({
          error: 'This order has a recorded payment.',
          needsAcknowledgement: true,
          tenderCents,
          orderNumber: order.order_no,
          hint: `$${(tenderCents / 100).toFixed(2)} is recorded as received on ${order.order_no}. Voiding takes the sale off revenue and puts the stock back, but it does not refund anything — handle the money separately.`,
        }),
      };
    }

    // ── 1. Stock first ───────────────────────────────────────────────────────
    // See the header: restocking before cancelling is what makes a half-failure
    // recoverable instead of silent.
    if (rows.length) {
      await sb('stock_ledger', {
        method: 'POST',
        body: JSON.stringify(rows),
        headers: { Prefer: 'return=minimal' },
      });
    }

    // ── 2. Then take it off the books ────────────────────────────────────────
    // 🔑 `state=neq.CANCELED` in the filter makes this a compare-and-swap: two
    // simultaneous voids cannot both win, because the loser matches no row.
    const stamp = new Date().toISOString();
    const noteLine = `[voided ${stamp.slice(0, 10)}]${reason ? ` ${reason}` : ''}`;
    const cancelled = await sb(
      `orders?id=eq.${encodeURIComponent(order.id)}&state=neq.CANCELED`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          state: 'CANCELED',
          note: order.note ? `${order.note}\n${noteLine}` : noteLine,
        }),
        headers: { Prefer: 'return=representation' },
      },
    );
    const didCancel = Array.isArray(cancelled) && cancelled.length > 0;

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        ok: true,
        orderNumber: order.order_no,
        // Distinguishes "I just voided this" from "it was already voided and I
        // finished the job" — both are successes, and they read differently.
        cancelled: didCancel,
        alreadyVoided: alreadyCancelled || !didCancel,
        unitsReturned: units,
        linesReturned: rows.length,
        revenueRemovedCents: order.payment_state === 'PAID' ? order.total_cents : 0,
        tenderCents,
        reason: reason || null,
      }),
    };
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    const msg = timedOut ? `Supabase timed out after ${TIMEOUT_MS}ms` : err.message;
    if (!err.status || err.status >= 500) console.error('void-order error:', msg);
    return { statusCode: timedOut ? 504 : (err.status || 500), headers, body: JSON.stringify({ error: msg }) };
  }
};
