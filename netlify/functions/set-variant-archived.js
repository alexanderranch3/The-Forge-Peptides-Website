// ─────────────────────────────────────────────────────────────────────────────
// Netlify Function: set-variant-archived.js
// Added 2026-08-20 — stop reordering a product, and start again.
//
//   POST { variant_id, archived, reason? }
//
// Frank: "archive what we are not restocking so dead items stop appearing in
// the reorder list." The live symptom was the TOP of that list: Retatrutide
// 12mg, suggested buy 20 — a size retired on 2026-07-31 that is not in CATALOG
// and cannot be bought on the site at any price.
//
// 🚨 ARCHIVING IS A BUYING DECISION AND NOTHING ELSE. It writes one timestamp
// on the variant. It does not touch stock_ledger, on-hand counts, stock value,
// v_unfulfillable, or the storefront feed — the vials stay on the shelf, stay
// valued, and stay sellable, because SELLING THROUGH what is left is the point
// of archiving rather than deleting. Migration 029 has the full reasoning.
//
// 🔑 The reorder recommendation is zeroed in v_inventory_dashboard, not here and
// not in the page — the view owns every other inventory figure, and a second
// surface must not be able to go on recommending a restock.
//
// ⚠️ NOT `variants.is_hidden`, which looks purpose-built and is inert: nothing
// reads it, and Retatrutide 10mg is is_hidden today with 36 vials on hand and 15
// sold. Same trap as `parties.kind` in 028 — a column whose name promises more
// than its behaviour delivers.
//
// 🔐 Token-gated like every admin endpoint.
// ─────────────────────────────────────────────────────────────────────────────

const { verifyToken } = require('./_auth-token');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const TIMEOUT_MS = 10000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REASON = 300;

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
      const missingColumn = /archived_at|archived_reason/.test(body);
      const err = new Error(missingColumn
        ? 'Archiving is not set up in the database yet.'
        : `Supabase returned ${res.status}`);
      err.status = missingColumn ? 503 : 502;
      err.hint = missingColumn
        ? 'Apply replace-square-phase1/fixes/029-archive-variants.sql, then reload.'
        : undefined;
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

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };
  }

  const SECRET = process.env.ADMIN_TOKEN_SECRET;
  if (!SECRET) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ADMIN_TOKEN_SECRET not configured.' }) };
  }
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  if (!verifyToken(SECRET, authHeader.replace(/^Bearer\s+/i, ''))) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase is not configured.' }) };
  }

  let input;
  try { input = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Bad request body' }) }; }

  const variantId = String(input.variant_id || '');
  if (!UUID.test(variantId)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Pick a product first' }) };
  }
  if (typeof input.archived !== 'boolean') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Say whether it is being archived or brought back' }) };
  }
  const reason = String(input.reason || '').trim().slice(0, MAX_REASON) || null;

  try {
    // Read the whole dashboard row first: the response tells the page what is
    // being walked away from, so a wrong click is visible in the toast rather
    // than discovered at the next stock count.
    const found = await sb(`v_inventory_dashboard?select=variant_id,product_name,variant_name,on_hand,stock_value_cents,units_life,archived_at&variant_id=eq.${variantId}`);
    if (!found.length) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'No such product' }) };
    }
    const row = found[0];

    const patch = {
      archived_at: input.archived ? new Date().toISOString() : null,
      // Bringing something back clears the reason with it — a note explaining
      // why we stopped buying something we are buying again is just confusing.
      archived_reason: input.archived ? reason : null,
      updated_at: new Date().toISOString(),
    };
    await sb(`variants?id=eq.${variantId}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    });

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        variant_id: variantId,
        product: row.product_name,
        variant: row.variant_name || null,
        archived: input.archived,
        reason: patch.archived_reason,
        // 🔑 Reported back because these are exactly what archiving does NOT
        // change. If a number here looks alarming, that is the point: the
        // stock is still there and still yours to sell.
        on_hand: row.on_hand,
        stock_value_cents: row.stock_value_cents,
        units_life: Number(row.units_life),
      }),
    };
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    if (!err.status || err.status >= 500) console.error('set-variant-archived error:', err.message);
    return {
      statusCode: timedOut ? 504 : (err.status || 500), headers,
      body: JSON.stringify({ error: timedOut ? 'Timed out updating the product.' : err.message, hint: err.hint }),
    };
  }
};
