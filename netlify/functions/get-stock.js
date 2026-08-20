// ─────────────────────────────────────────────────────────────────────────────
// Netlify Function: get-stock.js
// Added 2026-08-17 — the first endpoint that reads the Square REPLACEMENT
// rather than Square itself.
//
// Serves the admin inventory page from the `v_inventory_dashboard` view in
// Supabase: stock on hand, 90-day velocity, months of cover, true margin and a
// per-product status. The view does all the arithmetic so every surface that
// reads it agrees — this function only fetches and shapes.
//
// 🔐 Behind the same admin token as get-orders.js. Unit costs, margins and
// supplier economics are the most commercially sensitive data in the business;
// this endpoint must never be public, unlike get-inventory.js which
// deliberately is.
//
// ⚠️ Reads Supabase with the SERVICE ROLE key, which bypasses row-level
// security. That is safe only because this runs server-side inside a Netlify
// Function and is token-gated above. Never move this logic into the browser.
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

// Money stays in cents all the way from Postgres to the browser. Formatting is
// the UI's job -- converting to floats here is how rounding drift starts.
function shapeRow(r) {
  return {
    variant_id:      r.variant_id,
    product:         r.product_name,
    variant:         r.variant_name || null,
    status:          r.status,
    on_hand:         r.on_hand,
    price_cents:     r.price_cents,
    unit_cost_cents: r.unit_cost_cents,
    stock_cost_cents:   r.stock_value_cents,
    stock_retail_cents: r.stock_retail_cents,
    units_life:      Number(r.units_life),
    units_90d:       Number(r.units_90d),
    units_per_month: r.units_per_month === null ? 0 : Number(r.units_per_month),
    months_cover:    r.months_cover === null ? null : Number(r.months_cover),
    margin_pct:      r.margin_pct === null ? null : Number(r.margin_pct),
    lines_missing_cost: r.lines_missing_cost,
    suggested_buy:   r.suggested_buy,
    last_sold_at:    r.last_sold_at,
    // 🚨 INERT Square-era residue — nothing reads it, and it hides nothing.
    // Retatrutide 10mg carries it today with 36 vials on hand and 15 sold.
    // `archived_at` below is the live flag; see migration 029.
    is_hidden:       r.is_hidden,
    // Retired from PURCHASING (029). Stock, value and sellability are
    // deliberately unaffected — archiving is a buying decision.
    archived_at:     r.archived_at || null,
    archived_reason: r.archived_reason || null,
  };
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  const SECRET = process.env.ADMIN_TOKEN_SECRET;
  if (!SECRET) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ADMIN_TOKEN_SECRET not configured.' }) };
  }
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const bearer = authHeader.replace(/^Bearer\s+/i, '');
  if (!verifyToken(SECRET, bearer)) {
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
    const url = `${SUPABASE_URL}/rest/v1/v_inventory_dashboard`
              + `?select=*&order=units_90d.desc,on_hand.asc`;
    const res = await fetchWithTimeout(url, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Accept: 'application/json',
      },
    });
    const body = await res.text();

    if (!res.ok) {
      // A 404 here almost always means the view hasn't been created yet, which
      // is a setup step rather than a bug. Say so instead of returning raw
      // PostgREST noise.
      const hint = res.status === 404
        ? 'The v_inventory_dashboard view is missing. Run: bash run-sql.sh fixes/002-inventory-dashboard-view.sql'
        : undefined;
      return { statusCode: 502, headers, body: JSON.stringify({ error: `Supabase returned ${res.status}`, hint, detail: body.slice(0, 400) }) };
    }

    const rows = JSON.parse(body).map(shapeRow);

    // Totals computed here, once, so the page never sums a filtered view by
    // accident and quietly reports a different number than the tiles.
    const totals = rows.reduce((a, r) => {
      // 🔑 Units and value count EVERYTHING, archived included. Those vials are
      // on the shelf and are worth what they cost; a stock total that quietly
      // omitted them would not reconcile against a physical count, which is the
      // one number that beats every inference drawn from the ledger.
      a.units        += r.on_hand;
      a.cost_cents   += r.stock_cost_cents   || 0;
      a.retail_cents += r.stock_retail_cents || 0;
      // 🚨 Archived products are NOT things to reorder — that is the whole
      // feature. The view already zeroes their suggested_buy; this keeps the
      // tile agreeing with the list beneath it.
      if (!r.archived_at && (r.status === 'OUT' || r.status === 'LOW')) a.needs_reorder += 1;
      if (r.status === 'SLOW' || r.status === 'NO_SALES') a.parked_cents += r.stock_cost_cents || 0;
      if (r.archived_at) {
        a.archived_products += 1;
        a.archived_cents += r.stock_cost_cents || 0;
      }
      if (r.lines_missing_cost > 0) a.products_missing_cost += 1;
      return a;
    }, { units: 0, cost_cents: 0, retail_cents: 0, needs_reorder: 0, parked_cents: 0,
         archived_products: 0, archived_cents: 0, products_missing_cost: 0 });

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        as_of: new Date().toISOString(),
        velocity_window_days: 90,
        totals,
        items: rows,
      }),
    };
  } catch (err) {
    const msg = err.name === 'AbortError' ? `Supabase timed out after ${TIMEOUT_MS}ms` : err.message;
    console.error('get-stock error:', msg);
    return { statusCode: 500, headers, body: JSON.stringify({ error: msg }) };
  }
};
