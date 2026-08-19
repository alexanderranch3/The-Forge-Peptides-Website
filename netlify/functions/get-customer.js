// ─────────────────────────────────────────────────────────────────────────────
// Netlify Function: get-customer.js
// Added 2026-08-19 — one customer, everything about them.
//
//   GET ?party_id=<uuid>
//
// Backs the client profile screen: who they are, what they have bought, how long
// since they last did, and what they owe on their house account.
//
// 🔐 TOKEN-GATED, PERMANENTLY, for the same reason get-customers.js is: this
// returns a named person's contact details, purchase history and debts. It is
// the most personal data the business holds. get-inventory.js is the public
// endpoint; this one must never be, however convenient that would be for testing.
//
// ⚠️ Reads Supabase with the SERVICE ROLE key, which bypasses row-level
// security. Safe only because it runs server-side, behind the token above.
//
// 🔑 Every number comes from v_customer_profile / v_house_account_balance, which
// derive them from orders and tenders. Nothing is summed here. Two surfaces
// computing the same total independently is how they end up disagreeing.
// ─────────────────────────────────────────────────────────────────────────────

const { verifyToken } = require('./_auth-token');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const TIMEOUT_MS = 8000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// How much history the profile shows. Enough to see a pattern, not so much that
// the screen becomes a scroll.
const ORDER_LIMIT = 50;

async function sb(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      let message = `Supabase ${res.status}`;
      try { message = JSON.parse(text).message || message; } catch { /* not json */ }
      throw Object.assign(new Error(message), { status: res.status });
    }
    return text ? JSON.parse(text) : [];
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
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  if (!verifyToken(SECRET, authHeader.replace(/^Bearer\s+/i, ''))) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase is not configured.' }) };
  }

  const partyId = (event.queryStringParameters || {}).party_id || '';
  if (!UUID.test(partyId)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'party_id must be a customer id' }) };
  }

  try {
    const id = encodeURIComponent(partyId);
    const [profile, orders, charges, payments] = await Promise.all([
      sb(`v_customer_profile?select=*&party_id=eq.${id}`),
      // Cancelled orders are included on purpose and labelled: a voided order is
      // part of this customer's history and hiding it invites the question
      // "where did that sale go?" with no way to answer it.
      sb(`orders?select=id,order_no,placed_at,state,payment_state,purpose,channel,total_cents`
         + `,tenders(type,amount_cents)`
         + `,order_line_items(name_at_sale,quantity,kind)`
         + `&party_id=eq.${id}&order=placed_at.desc&limit=${ORDER_LIMIT}`),
      sb(`tenders?select=amount_cents,received_at,note,orders(order_no,state)`
         + `&type=eq.HOUSE_ACCOUNT&house_account_party_id=eq.${id}&order=received_at.desc`),
      sb(`house_account_payments?select=id,amount_cents,method,reference,note,received_at`
         + `&party_id=eq.${id}&order=received_at.desc`),
    ]);

    if (!profile.length) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'No such customer' }) };
    }

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        profile: profile[0],
        orders: orders.map((o) => ({
          order_id: o.id,
          order_no: o.order_no,
          placed_at: o.placed_at,
          state: o.state,
          payment_state: o.payment_state,
          purpose: o.purpose,
          channel: o.channel,
          total_cents: o.total_cents,
          voided: o.state === 'CANCELED',
          // Surfaced so the profile can mark which orders went on the tab.
          on_house_account: (o.tenders || []).some((t) => t.type === 'HOUSE_ACCOUNT'),
          items: (o.order_line_items || [])
            .filter((li) => li.kind === 'PRODUCT')
            .map((li) => ({ name: li.name_at_sale, qty: Number(li.quantity) })),
        })),
        // The two sides of the tab, newest first, for the ledger on the profile.
        house_charges: charges.map((c) => ({
          amount_cents: c.amount_cents,
          received_at: c.received_at,
          order_no: c.orders?.order_no || null,
          // A charge on a voided order is excluded from the balance by
          // v_house_account_balance. Shown here, struck through, so the ledger
          // adds up to the balance instead of mysteriously not doing.
          voided: c.orders?.state === 'CANCELED',
        })),
        house_payments: payments,
      }),
    };
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    const msg = timedOut ? `Supabase timed out after ${TIMEOUT_MS}ms` : err.message;
    // A missing view means migration 024 has not been applied yet. Say that,
    // rather than handing the page a raw PostgREST error about a relation.
    const missing = /v_customer_profile|house_account_payments|v_house_account_balance/.test(msg)
      && /does not exist|not find|relation/i.test(msg);
    if (!err.status || err.status >= 500) console.error('get-customer error:', msg);
    return {
      statusCode: timedOut ? 504 : (err.status || 500), headers,
      body: JSON.stringify({
        error: missing ? 'House accounts are not set up in the database yet.' : msg,
        hint: missing ? 'Apply replace-square-phase1/fixes/024-house-accounts.sql, then reload.' : undefined,
      }),
    };
  }
};
