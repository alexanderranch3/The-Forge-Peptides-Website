// Netlify Function: set-order-status.js
// Flips an order's payment status between AWAITING_ZELLE and PAID.
//
// Added 2026-08-13. Square deactivated this account on 2026-08-12, so marking a
// Square invoice "paid" is no longer possible — that was how Frank tracked which
// Zelle payments had landed. The flag now lives in the Square order's metadata
// and this endpoint is what writes it, driven by the Mark Paid button in
// /admin.html. See create-invoice.js and get-orders.js.
//
// This records a bookkeeping flag. It does NOT move money and does not touch any
// Square payment endpoint — those are blocked on this account.

const { verifyToken } = require('./_auth-token');

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

    const existing = getData.order.metadata || {};
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

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        success: true,
        orderId,
        status,
        orderNumber: updData.order.metadata?.forge_order_number || updData.order.reference_id || '',
      }),
    };

  } catch (err) {
    console.error('set-order-status error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
