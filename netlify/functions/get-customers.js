// ─────────────────────────────────────────────────────────────────────────────
// Netlify Function: get-customers.js
// Added 2026-08-19 — the customer list behind the New sale picker.
//
// 🔑 WHY THIS EXISTS AT ALL. create_manual_order resolves a customer by EMAIL,
// and inserts a brand-new party when it finds no match. Frank sells by Zelle, so
// most counter customers have no email on file — which means a returning buyer
// was getting a NEW party row on every single sale. Reorder cadence is computed
// per party, so each duplicate silently reset it. Picking a real party_id from
// this list is what stops that; pre-filling the name box would not have.
//
// 🚨 TOKEN-GATED, AND IT MUST STAY THAT WAY. This returns every customer's name,
// email and phone — the most personal data the business holds. Same reasoning
// get-purchasing.js documents for supplier pricing. get-inventory.js is the
// public one; this is not, and must never be made public "just to test it".
//
// ⚠️ Reads Supabase with the SERVICE ROLE key, which bypasses row-level security.
// Safe only because this runs server-side and behind the token above.
//
// 🔑 Merged-away duplicates are excluded here (merged_into_id is null), not in
// the page, so no caller can forget to. Un-merged duplicates DO still appear —
// that is pre-existing data, and the picker is the first place it becomes
// visible. Seeing them is the point; merging them is a separate job.
// ─────────────────────────────────────────────────────────────────────────────

const { verifyToken } = require('./_auth-token');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

const TIMEOUT_MS = 8000;

async function fetchWithTimeout(url, options = {}, ms = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function sb(path) {
  const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Accept: 'application/json',
    },
  });
  const body = await res.text();
  if (!res.ok) {
    const err = new Error(`Supabase returned ${res.status}`);
    err.status = 502;
    err.detail = body.slice(0, 400);
    throw err;
  }
  return JSON.parse(body);
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

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return {
      statusCode: 500, headers,
      body: JSON.stringify({
        error: 'Supabase is not configured.',
        detail: 'Set SUPABASE_URL and SUPABASE_SERVICE_KEY in Netlify → Site settings → Environment variables, then redeploy.',
      }),
    };
  }

  // What each customer still owes on their house account.
  //
  // 🔑 FAILS SOFT AND SILENTLY, on purpose. v_house_account_balance arrives with
  // migration 025; until that is applied this returns an empty map and the
  // picker works exactly as it did before. The customer list is the till's path
  // to ringing up a sale — it must never stop working because a reporting view
  // is missing.
  async function balances() {
    try {
      const rows = await sb('v_house_account_balance?select=party_id,balance_cents');
      return new Map(rows.filter((r) => Number(r.balance_cents) > 0)
                         .map((r) => [r.party_id, Number(r.balance_cents)]));
    } catch {
      return new Map();
    }
  }

  try {
    const [parties, orders, owed] = await Promise.all([
      // ⚠️ house_account_enabled ARRIVES WITH MIGRATION 028, and unlike the
      // balance below this select is NOT optional — if the column is missing the
      // whole picker fails, and the picker is the till's path to a sale. Deploy
      // order matters: schema first, then this code. It was applied on
      // 2026-08-20, before this shipped.
      sb('parties?select=id,display_name,email,phone,kind,notes,house_account_enabled,house_account_limit_cents&merged_into_id=is.null&order=display_name'),
      // ⚠️ Cancelled orders are excluded deliberately. 19 were cancelled on
      // 2026-08-19 as never-real, and counting them would date a customer's
      // "last order" to a sale that never happened.
      sb('orders?select=party_id,placed_at,state&party_id=not.is.null&state=neq.CANCELED'),
      balances(),
    ]);

    // Order count and most recent order date, per party. Done here rather than
    // in a view so this needs no migration — the whole picker ships without one.
    const stats = new Map();
    for (const o of orders) {
      const s = stats.get(o.party_id) || { order_count: 0, last_order_at: null };
      s.order_count += 1;
      if (o.placed_at && (!s.last_order_at || o.placed_at > s.last_order_at)) s.last_order_at = o.placed_at;
      stats.set(o.party_id, s);
    }

    const customers = parties.map((p) => {
      const s = stats.get(p.id) || { order_count: 0, last_order_at: null };
      return {
        party_id: p.id,
        name: p.display_name,
        email: p.email || null,
        phone: p.phone || null,
        kind: p.kind,
        // Who may buy on credit (migration 028). The New sale form reads this
        // to decide whether to offer the house-account option at all — though
        // create-order.js is what actually enforces it.
        house_account_enabled: p.house_account_enabled === true,
        house_account_limit_cents: p.house_account_limit_cents ?? null,
        order_count: s.order_count,
        last_order_at: s.last_order_at,
        // 0 when nothing is owed, and also 0 before migration 025 — the two are
        // indistinguishable here by design, because both mean "no tab to chase".
        house_balance_cents: owed.get(p.id) || 0,
      };
    });

    // Most recent buyer first — a counter picker is used for returning
    // customers, and the person who bought last week is the likeliest next.
    // Never-ordered parties sort last, alphabetically among themselves.
    customers.sort((a, b) => {
      if (a.last_order_at && b.last_order_at) return b.last_order_at.localeCompare(a.last_order_at);
      if (a.last_order_at) return -1;
      if (b.last_order_at) return 1;
      return a.name.localeCompare(b.name);
    });

    return { statusCode: 200, headers, body: JSON.stringify({ customers, count: customers.length }) };
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    return {
      statusCode: timedOut ? 504 : (err.status || 502),
      headers,
      body: JSON.stringify({
        error: timedOut ? 'Timed out reading the customer list.' : 'Could not read the customer list.',
        detail: err.detail || err.message,
      }),
    };
  }
};
