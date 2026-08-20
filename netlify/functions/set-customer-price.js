// ─────────────────────────────────────────────────────────────────────────────
// Netlify Function: set-customer-price.js
// Added 2026-08-20 — the price one customer pays for one product.
//
//   POST { party_id, variant_id, price_cents }      -> set or change it
//   POST { party_id, variant_id, price_cents: null } -> back to list price
//
// Frank, 2026-08-20: "give them certain pricing for certain items so they don't
// have to use a promo code on the whole order… Retatrutide 10mg, Antonio Torres
// gets that at a base price of seventy-five dollars."
//
// 🚨 THIS ENDPOINT ONLY RECORDS THE DECISION. create-invoice.js ENFORCES IT, and
// it does so by looking the price up itself from the signed-in session — never
// from anything the browser sends. A rule that lives only in the page it is
// drawn on is not a rule, and a price the client could name is not a price.
//
// 🚨 AND THE PRICE IS FINAL: a promo code cannot discount it further. Frank,
// same conversation: "if any prices are adjusted on my end, those prices can't
// be adjusted further by a promo code." That exclusion lives in
// create-invoice.js beside the discount arithmetic, where the base is computed.
//
// ⚠️ A signed-OUT customer pays list price, always. There is no way to recognise
// someone who has not identified themselves, and guessing from a typed email is
// the exact vulnerability this replaces the promo code to avoid.
//
// 🔐 Token-gated like every admin endpoint.
// ─────────────────────────────────────────────────────────────────────────────

const { verifyToken } = require('./_auth-token');
const { CATALOG } = require('./_catalog');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const TIMEOUT_MS = 10000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// $10,000 for a vial is not a price anybody sets on purpose — it is a decimal
// point in the wrong place. The floor is zero, deliberately: a genuine freebie
// is a decision Frank is allowed to make.
const MAX_PRICE_CENTS = 1000000;

async function sb(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
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
    const body = await res.text();
    if (!res.ok) {
      const missing = /party_prices|set_party_price|clear_party_price/.test(body);
      const err = new Error(missing
        ? 'Customer pricing is not set up in the database yet.'
        : `Supabase returned ${res.status}`);
      err.status = missing ? 503 : 502;
      err.hint = missing
        ? 'Apply replace-square-phase1/fixes/043-per-customer-pricing.sql, then reload.'
        : undefined;
      // 🔑 Surface the database's own refusal rather than a generic 502. It says
      // useful things — "that product is not sold on the site", "no such
      // customer" — and hiding them turns a clear answer into a shrug.
      try {
        const parsed = JSON.parse(body);
        if (parsed && parsed.message) { err.message = parsed.message; err.status = 400; }
      } catch (_) { /* not JSON; keep the generic message */ }
      err.detail = body.slice(0, 400);
      throw err;
    }
    return body ? JSON.parse(body) : null;
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

  let body = {};
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Bad request' }) }; }

  const partyId = String(body.party_id || '');
  const variantId = String(body.variant_id || '');
  if (!UUID.test(partyId))   return { statusCode: 400, headers, body: JSON.stringify({ error: 'party_id must be a customer id' }) };
  if (!UUID.test(variantId)) return { statusCode: 400, headers, body: JSON.stringify({ error: 'variant_id must be a product id' }) };

  const clearing = body.price_cents === null || body.price_cents === undefined || body.price_cents === '';
  let priceCents = null;
  if (!clearing) {
    priceCents = Math.round(Number(body.price_cents));
    if (!Number.isFinite(priceCents) || priceCents < 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'That is not a price.' }) };
    }
    if (priceCents > MAX_PRICE_CENTS) {
      return {
        statusCode: 400, headers,
        body: JSON.stringify({
          error: `$${(priceCents / 100).toFixed(2)} is higher than any vial we sell.`,
          hint: 'Check the decimal point.',
        }),
      };
    }
  }

  try {
    if (clearing) {
      const removed = await sb('rpc/clear_party_price', {
        method: 'POST',
        body: JSON.stringify({ p_party: partyId, p_variant: variantId }),
      });
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ ok: true, cleared: removed === true }),
      };
    }

    const rows = await sb('rpc/set_party_price', {
      method: 'POST',
      body: JSON.stringify({
        p_party: partyId, p_variant: variantId,
        p_price_cents: priceCents, p_note: body.note || null,
      }),
    });
    const row = Array.isArray(rows) ? rows[0] : rows;
    const entry = row && CATALOG[row.site_catalog_id];
    const listCents = entry ? Math.round(entry.price * 100) : null;

    // 🔑 The response carries the LIST price beside the agreed one, read from
    // CATALOG on the server — the same constant checkout charges from. The page
    // can then say "was $160, now $75" without holding its own copy of retail.
    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        ok: true,
        party_id: partyId,
        variant_id: variantId,
        name: entry ? entry.name : (row && row.product_name) || 'That product',
        price_cents: row ? row.price_cents : priceCents,
        list_cents: listCents,
        // Stated rather than left to be worked out: a price ABOVE retail is a
        // legitimate thing to set but almost always a typo, and the page warns.
        above_list: listCents != null && priceCents > listCents,
      }),
    };
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    const msg = timedOut ? `Supabase timed out after ${TIMEOUT_MS}ms` : err.message;
    if (!err.status || err.status >= 500) console.error('set-customer-price error:', msg);
    return {
      statusCode: timedOut ? 504 : (err.status || 500), headers,
      body: JSON.stringify({ error: msg, hint: err.hint }),
    };
  }
};
