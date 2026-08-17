// ─────────────────────────────────────────────────────────────────────────────
// Netlify Function: get-purchasing.js
// Added 2026-08-17 — reads everything the Purchasing tab needs in one call.
//
// Vendors, purchase orders (v_purchase_orders), their lines with LANDED COST
// already computed (v_purchase_order_lines), and the product list used by the
// line pickers.
//
// 🔑 The landed cost is read, never recalculated here. It is derived once in
// v_purchase_order_lines so this page, a future POS, a report and a vault skill
// cannot quietly disagree about what a vial cost. If a number looks wrong, the
// view is the single place to fix it.
//
// 🔐 Token-gated exactly like get-stock.js. Supplier pricing is the most
// commercially sensitive data in the business — unlike get-inventory.js, which
// is public by design, this must never be.
//
// ⚠️ Reads Supabase with the SERVICE ROLE key, which bypasses row-level
// security. Safe only because this runs server-side and behind the token above.
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
    const missing = res.status === 404;
    const err = new Error(missing
      ? 'The purchasing tables are missing. Run: bash run-sql.sh fixes/003-purchasing.sql'
      : `Supabase returned ${res.status}`);
    err.status = missing ? 502 : 502;
    err.detail = body.slice(0, 400);
    throw err;
  }
  return JSON.parse(body);
}

// Postgres returns bigint/numeric as strings over PostgREST. Coerce at the
// boundary so the page never does arithmetic on a string by accident.
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
    const [vendors, orders, lines, products] = await Promise.all([
      // default_pack_size matters: Direct Peptides quotes per BOX OF 10, and a
      // cost entered without dividing by it is 10x wrong — an error the
      // landed-cost workbook has already made once. The editor uses it to show
      // a per-box cross-check beside every unit cost.
      sb('vendors?select=id,name,default_pack_size,contact_name,region&order=name'),
      sb('v_purchase_orders?select=*&order=ordered_on.desc,created_at.desc'),
      sb('v_purchase_order_lines?select=*'),
      // The picker reads the same inventory view the Inventory tab does, so a
      // product is named identically on both screens.
      sb('v_inventory_dashboard?select=variant_id,product_name,variant_name,price_cents,unit_cost_cents,on_hand&order=product_name'),
    ]);

    const shapedOrders = orders.map((o) => ({
      id: o.id,
      vendor_id: o.vendor_id,
      vendor_name: o.vendor_name,
      reference: o.reference,
      state: o.state,
      ordered_on: o.ordered_on,
      received_on: o.received_on,
      shipping_cents: int(o.shipping_cents),
      other_fees_cents: int(o.other_fees_cents),
      other_fees_note: o.other_fees_note,
      tax_cents: int(o.tax_cents),
      allocation: o.allocation,
      payment_method: o.payment_method,
      notes: o.notes,
      goods_cents: int(o.goods_cents),
      invoice_total_cents: int(o.invoice_total_cents),
      units_received: int(o.units_received),
      line_count: int(o.line_count),
      lines_unmatched: int(o.lines_unmatched),
    }));

    const shapedLines = lines.map((l) => ({
      line_id: l.line_id,
      purchase_order_id: l.purchase_order_id,
      variant_id: l.variant_id,
      supplier_sku: l.supplier_sku,
      description: l.description,
      quantity: int(l.quantity),
      free_quantity: int(l.free_quantity),
      units_received: int(l.units_received),
      unit_cost_cents: int(l.unit_cost_cents),
      goods_cents: int(l.goods_cents),
      allocated_fees_cents: int(l.allocated_fees_cents),
      landed_unit_cost_cents: int(l.landed_unit_cost_cents),
      notes: l.notes,
    }));

    // Computed once here rather than in the page, for the same reason the view
    // owns the per-line maths: two places that both add up money will disagree.
    const totals = shapedOrders.reduce((a, o) => {
      if (o.state === 'DRAFT' || o.state === 'ORDERED') {
        a.open_orders += 1;
        a.open_value_cents += o.invoice_total_cents || 0;
        a.open_units += o.units_received || 0;
      }
      if (o.state === 'RECEIVED') a.received_orders += 1;
      if (o.lines_unmatched > 0) a.orders_with_unmatched_lines += 1;
      return a;
    }, {
      open_orders: 0, open_value_cents: 0, open_units: 0,
      received_orders: 0, orders_with_unmatched_lines: 0,
    });

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        as_of: new Date().toISOString(),
        totals,
        vendors,
        orders: shapedOrders,
        lines: shapedLines,
        products: products.map((p) => ({
          variant_id: p.variant_id,
          product: p.product_name,
          variant: p.variant_name || null,
          price_cents: int(p.price_cents),
          unit_cost_cents: int(p.unit_cost_cents),
          on_hand: int(p.on_hand),
        })),
      }),
    };
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    const msg = timedOut ? `Supabase timed out after ${TIMEOUT_MS}ms` : err.message;
    console.error('get-purchasing error:', msg);
    return {
      statusCode: err.status || 500, headers,
      body: JSON.stringify({ error: msg, detail: err.detail }),
    };
  }
};
