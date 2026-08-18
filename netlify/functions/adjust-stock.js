// ─────────────────────────────────────────────────────────────────────────────
// Netlify Function: adjust-stock.js
// Added 2026-08-17 — record a physical count, damage, or found stock.
//
//   GET  ?variant_id=…&limit=…  → recent stock movements (history)
//   POST { variant_id, mode, quantity, reason?, note?, occurred_at? }
//
// Receiving a purchase order is all-or-nothing and one-way. This is what covers
// the rest of reality: the box that held 19 instead of 20, the cracked vial, the
// customer return, the shelf that disagrees with the computer.
//
// 🔑 A CORRECTION IS A NEW ROW, NEVER AN EDIT. stock_ledger blocks UPDATE and
// DELETE by trigger, so the history shows both what was believed and what was
// found. That is deliberate — a silent fix to a stock record is worse than an
// obvious one.
//
// 🔑 RECOUNT TAKES THE COUNTED TOTAL, not a difference. After counting a shelf
// you know "there are 19", not "there are two fewer than the computer thinks".
// The database reads the current figure and derives the delta itself.
//
// 🔐 Token-gated — it writes stock.
// ─────────────────────────────────────────────────────────────────────────────

const { verifyToken } = require('./_auth-token');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

const TIMEOUT_MS = 8000;

const MODES = ['RECOUNT', 'REMOVE', 'ADD'];
// Deliberately excludes SALE and PURCHASE_RECEIVED: those carry an order or a
// cost behind them and must not be forgeable from this screen.
const REASONS = ['WASTE', 'ADJUSTMENT', 'TRANSFER', 'RETURN', 'RECOUNT'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

async function sb(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res, body;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...options,
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
    body = await res.text();
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let message;
    try { message = JSON.parse(body).message; } catch { /* not json */ }
    const err = new Error(message || `Supabase ${res.status}`);
    err.status = message ? 400 : 502;
    if (!message) err.detail = body.slice(0, 300);
    throw err;
  }
  return body ? JSON.parse(body) : null;
}

const int = (v) => (v === null || v === undefined ? null : Number(v));

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
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return {
      statusCode: 500, headers,
      body: JSON.stringify({
        error: 'Supabase is not configured.',
        detail: 'Set SUPABASE_URL and SUPABASE_SERVICE_KEY in Netlify → Site settings → Environment variables, then redeploy.',
      }),
    };
  }

  try {
    if (event.httpMethod === 'GET') {
      const q = event.queryStringParameters || {};
      const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || 40));
      let path = `v_stock_history?select=*&limit=${limit}`;
      if (q.variant_id) {
        if (!UUID.test(q.variant_id)) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'variant_id is not a valid id' }) };
        }
        path += `&variant_id=eq.${q.variant_id}`;
      }
      const rows = await sb(path);
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          movements: rows.map((r) => ({
            id: r.id,
            variant_id: r.variant_id,
            product: r.product_name,
            variant: r.variant_name || null,
            delta: int(r.delta),
            reason: r.reason,
            note: r.note,
            occurred_at: r.occurred_at,
            created_by: r.created_by,
            order_no: r.order_no,
          })),
        }),
      };
    }

    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    let input = {};
    try { input = JSON.parse(event.body || '{}'); } catch {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Body is not valid JSON' }) };
    }

    if (!UUID.test(String(input.variant_id || ''))) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Choose a product first' }) };
    }
    const mode = String(input.mode || 'RECOUNT').toUpperCase();
    if (!MODES.includes(mode)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `mode must be one of ${MODES.join(', ')}` }) };
    }
    const quantity = input.quantity;
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Quantity must be a whole number, zero or more' }) };
    }
    if (input.reason && !REASONS.includes(String(input.reason).toUpperCase())) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'That is not a reason this screen can record' }) };
    }
    if (input.occurred_at && !DATE.test(String(input.occurred_at))) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Date must look like 2026-08-17' }) };
    }

    const result = await sb('rpc/post_stock_adjustment', {
      method: 'POST',
      body: JSON.stringify({
        p: {
          variant_id: input.variant_id,
          mode,
          quantity,
          reason: input.reason ? String(input.reason).toUpperCase() : null,
          note: input.note ? String(input.note).slice(0, 500) : null,
          occurred_at: input.occurred_at || null,
        },
      }),
    });

    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    const msg = timedOut ? `Supabase timed out after ${TIMEOUT_MS}ms` : err.message;
    if (!err.status || err.status >= 500) console.error('adjust-stock error:', msg);
    return {
      statusCode: timedOut ? 504 : (err.status || 500), headers,
      body: JSON.stringify({ error: msg, detail: err.detail }),
    };
  }
};
