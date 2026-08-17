// ─────────────────────────────────────────────────────────────────────────────
// Netlify Function: sync-orders.js
// Added 2026-08-17 — pulls Square orders into the dashboard database.
//
// Two jobs:
//   GET   — report how stale the database is (v_sync_status), no writes
//   POST  — sync a date range: every Square order in it, idempotently
//
// WHY A BUTTON AND NOT A SCHEDULE
// The checkout already mirrors each sale as it happens. This exists for the two
// cases that leaves: the gap before that shipped, and any live sync that failed
// and was logged rather than surfaced. It is deliberately manual because the
// Minisforum's scheduled tasks are still unverified — heartbeat.log does not
// exist — and a repair tool that silently never runs is worse than none.
//
// 🔑 Safe to run as often as you like. sync_square_order() keys on the Square
// order id: it inserts lines and stock only on first sight, and thereafter
// refreshes state, payment and totals only. stock_ledger is append-only, so
// "run it twice" had to be provably harmless rather than merely unlikely.
//
// 🔐 Token-gated — it exposes order and customer data.
// ─────────────────────────────────────────────────────────────────────────────

const { verifyToken } = require('./_auth-token');
const { syncOrder, configured, rpc } = require('./_order-sync');

const SQUARE_API  = 'https://connect.squareup.com/v2';
const TOKEN       = process.env.SQUARE_ACCESS_TOKEN;
const LOCATION_ID = process.env.SQUARE_LOCATION_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

const MAX_DAYS = 400;

function squareHeaders() {
  return {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    'Square-Version': '2024-01-18',
  };
}

async function searchOrders(startISO, endISO) {
  const orders = [];
  let cursor = null;
  do {
    const res = await fetch(`${SQUARE_API}/orders/search`, {
      method: 'POST',
      headers: squareHeaders(),
      body: JSON.stringify({
        location_ids: [LOCATION_ID],
        cursor: cursor || undefined,
        limit: 200,
        query: {
          filter: { date_time_filter: { created_at: { start_at: startISO, end_at: endISO } } },
          sort: { sort_field: 'CREATED_AT', sort_order: 'ASC' },
        },
      }),
    });
    const data = await res.json();
    if (data.errors) throw new Error(`Square: ${JSON.stringify(data.errors).slice(0, 300)}`);
    if (data.orders) orders.push(...data.orders);
    cursor = data.cursor || null;
  } while (cursor);
  return orders;
}

// One batched lookup rather than a call per order — a party must be matched on
// its real email, not invented per sale, or reorder cadence breaks.
async function fetchCustomers(ids) {
  const out = new Map();
  for (const id of ids) {
    try {
      const res = await fetch(`${SQUARE_API}/customers/${id}`, { headers: squareHeaders() });
      const data = await res.json();
      const c = data.customer;
      if (c) {
        out.set(id, {
          square_id: c.id,
          name: [c.given_name, c.family_name].filter(Boolean).join(' ') || c.company_name || null,
          email: c.email_address || null,
          phone: c.phone_number || null,
        });
      }
    } catch { /* a missing customer must not stop the sync */ }
  }
  return out;
}

async function status() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/v_sync_status?select=*`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Accept: 'application/json' },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${body.slice(0, 200)}`);
  const row = JSON.parse(body)[0] || {};
  return {
    last_order_at: row.last_order_at || null,
    days_since_last_order: row.days_since_last_order === null || row.days_since_last_order === undefined
      ? null : Number(row.days_since_last_order),
    orders_total: Number(row.orders_total || 0),
    orders_30d: Number(row.orders_30d || 0),
  };
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

  if (!configured()) {
    return {
      statusCode: 500, headers,
      body: JSON.stringify({
        error: 'Supabase is not configured.',
        detail: 'Set SUPABASE_URL and SUPABASE_SERVICE_KEY in Netlify → Site settings → Environment variables, then redeploy.',
      }),
    };
  }
  if (!TOKEN || !LOCATION_ID) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Square is not configured.' }) };
  }

  try {
    if (event.httpMethod === 'GET') {
      return { statusCode: 200, headers, body: JSON.stringify({ status: await status() }) };
    }
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    let input = {};
    try { input = JSON.parse(event.body || '{}'); } catch { /* defaults */ }

    const days = Math.min(MAX_DAYS, Math.max(1, Math.floor(Number(input.days) || 30)));
    const end   = new Date();
    const start = new Date(end.getTime() - days * 86400000);

    const orders = await searchOrders(start.toISOString(), end.toISOString());

    const customerIds = [...new Set(orders.map((o) => o.customer_id).filter(Boolean))];
    const customers = await fetchCustomers(customerIds);

    const result = { scanned: orders.length, created: 0, updated: 0, lines: 0, stock_rows: 0, unmatched: 0, failed: [] };

    for (const order of orders) {
      try {
        const r = await syncOrder(order, customers.get(order.customer_id));
        if (!r) continue;
        if (r.created) {
          result.created += 1;
          result.lines += r.lines || 0;
          result.stock_rows += r.stock_rows || 0;
          result.unmatched += r.unmatched || 0;
        } else {
          result.updated += 1;
        }
      } catch (err) {
        // One bad order must not abandon the rest — report it and continue.
        result.failed.push({ order: order.reference_id || order.id, error: err.message.slice(0, 200) });
      }
    }

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        ok: true,
        window: { days, from: start.toISOString(), to: end.toISOString() },
        ...result,
        status: await status(),
      }),
    };
  } catch (err) {
    console.error('sync-orders error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
