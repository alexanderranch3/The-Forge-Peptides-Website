// ─────────────────────────────────────────────────────────────────────────────
// Netlify Function: set-fulfillment.js
// Added 2026-08-19 — close an order out.
//
//   POST { orderId | orderNumber, state, carrier?, trackingNumber? }
//
// A paid order is not a finished order. It still has to be packaged, and it has
// to leave. Without recording those two facts the Orders tab shows every paid
// order forever, and there is no way to tell what still needs doing.
//
//   PREPARED  — packaged, ready to collect or ship
//   COMPLETED — picked up / shipped. Done.
//
// 🔑 WRITES ONLY TO THE DASHBOARD, deliberately. Square is deactivated and is
// being replaced; pushing fulfillment state back into it would be writing to a
// system we are walking away from, and would fail on a dead account anyway.
//
// 🔑 Accepts either identifier because there are now two kinds of order: ones
// Square knows about (square_id) and ones rung up here (order_no). The second
// kind is invisible in Square entirely — see v_dashboard_only_orders.
//
// 🔐 Token-gated, same as every other admin endpoint.
// ─────────────────────────────────────────────────────────────────────────────

const { verifyToken } = require('./_auth-token');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const TIMEOUT_MS = 10000;

// Only the three the UI can actually navigate between. The enum holds more
// (RESERVED, CANCELED, FAILED) for Square parity — accepting those here would
// let a caller park an order in a state the dashboard offers no way out of.
const STATES = ['PROPOSED', 'PREPARED', 'COMPLETED'];

async function rpc(fn, args) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
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

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  const SECRET = process.env.ADMIN_TOKEN_SECRET;
  if (!SECRET) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ADMIN_TOKEN_SECRET not configured.' }) };
  }
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
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

  const state = String(input.state || '').toUpperCase();
  if (!STATES.includes(state)) {
    return {
      statusCode: 400, headers,
      body: JSON.stringify({ error: `state must be one of ${STATES.join(', ')}` }),
    };
  }
  const squareId = typeof input.orderId === 'string' ? input.orderId.trim() : '';
  const orderNo  = typeof input.orderNumber === 'string' ? input.orderNumber.trim() : '';
  if (!squareId && !orderNo) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'orderId or orderNumber is required' }) };
  }

  try {
    const result = await rpc('set_fulfillment_state', {
      p: {
        square_id: squareId || null,
        order_no: orderNo || null,
        state,
        carrier: typeof input.carrier === 'string' ? input.carrier.slice(0, 100) : null,
        tracking_number: typeof input.trackingNumber === 'string' ? input.trackingNumber.slice(0, 100) : null,
      },
    });
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ...result }) };
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    const msg = timedOut ? `Supabase timed out after ${TIMEOUT_MS}ms` : err.message;
    if (!err.status || err.status >= 500) console.error('set-fulfillment error:', msg);
    return { statusCode: timedOut ? 504 : (err.status || 500), headers, body: JSON.stringify({ error: msg }) };
  }
};
