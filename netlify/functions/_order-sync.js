// Shared helper (NOT an endpoint — the leading underscore keeps Netlify from
// deploying it as one). Turns a Square order into this database's shape and
// hands it to sync_square_order().
//
// WHY IT IS SHARED
// Two code paths need it: the live checkout, which already holds the order it
// just created, and the backfill/repair sync, which fetches a date range. If
// each wrote orders its own way they would eventually disagree, and the
// disagreement would be invisible until a margin looked wrong.
//
// 🔑 The database decides what is idempotent, not this file. sync_square_order()
// keys on the Square order id and posts stock only on first sight, because
// stock_ledger is append-only — a double-posted sale cannot be deleted, only
// offset by a visible correction.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

const TIMEOUT_MS = 8000;

function configured() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY);
}

async function rpc(fn, args, ms = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  let res, body;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(args),
      signal: controller.signal,
    });
    body = await res.text();
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let message;
    try { message = JSON.parse(body).message; } catch { /* not json */ }
    throw new Error(message || `Supabase ${res.status}: ${body.slice(0, 200)}`);
  }
  return body ? JSON.parse(body) : null;
}

// Square's own line naming is the only signal for what a line IS. The checkout
// writes "Shipping — <carrier>"; historical data also carries "Balance Due"
// rows, which are emphatically not product revenue (that distinction is what
// keeps $1,190.80 out of the sales figures).
function lineKind(name) {
  const n = String(name || '').toLowerCase();
  if (n.startsWith('shipping')) return 'SHIPPING';
  if (n.includes('balance due')) return 'BALANCE_DUE';
  return 'PRODUCT';
}

// Square reports OPEN / COMPLETED / CANCELED; our order_state matches.
function orderState(square) {
  const s = String(square || '').toUpperCase();
  return ['OPEN', 'COMPLETED', 'CANCELED', 'DRAFT'].includes(s) ? s : 'OPEN';
}

// Paid is asserted two ways because the metadata flag is app-scoped: the
// website's Square app can read its own metadata, but a tender is visible to
// everyone. Either one counts.
function paymentState(order) {
  const flag = String(order?.metadata?.payment_status || '').toUpperCase();
  if (flag === 'PAID') return 'PAID';
  if ((order?.tenders || []).length > 0) return 'PAID';
  return 'AWAITING_PAYMENT';
}

/**
 * Map a Square order object into the payload sync_square_order() expects.
 * `customer` is optional — the checkout already knows it; the backfill looks
 * it up so a party can be matched rather than duplicated.
 */
function buildSyncPayload(order, customer) {
  const lines = (order.line_items || []).map((li) => {
    const kind = lineKind(li.name);
    // 🔑 gross_sales_money is base price x quantity — PRE-tax and pre-discount.
    // total_money is tax-INCLUSIVE. Mixing them is the exact bug that made a
    // receipt read like a double charge on 2026-08-14.
    const gross = li.gross_sales_money?.amount ?? (li.base_price_money?.amount || 0) * Number(li.quantity || 1);
    return {
      square_uid: li.uid || null,
      square_variation_id: kind === 'PRODUCT' ? (li.catalog_object_id || null) : null,
      name: li.name || 'Unnamed item',
      quantity: Number(li.quantity || 1),
      unit_price_cents: li.base_price_money?.amount ?? 0,
      gross_cents: gross,
      discount_cents: li.total_discount_money?.amount ?? 0,
      tax_cents: li.total_tax_money?.amount ?? 0,
      total_cents: li.total_money?.amount ?? gross,
      kind,
    };
  });

  const shipping = lines
    .filter((l) => l.kind === 'SHIPPING')
    .reduce((n, l) => n + l.gross_cents, 0);
  const subtotal = lines
    .filter((l) => l.kind !== 'SHIPPING')
    .reduce((n, l) => n + l.gross_cents, 0);

  return {
    square_id: order.id,
    order_no: order.metadata?.forge_order_number || order.reference_id || null,
    channel: order.metadata?.forge_order_number ? 'WEBSITE' : 'IMPORT',
    placed_at: order.created_at || new Date().toISOString(),
    state: orderState(order.state),
    payment_state: paymentState(order),
    note: order.metadata?.customer_note || null,
    subtotal_cents: subtotal,
    discount_cents: order.total_discount_money?.amount ?? 0,
    tax_cents: order.total_tax_money?.amount ?? 0,
    shipping_cents: shipping,
    total_cents: order.total_money?.amount ?? 0,
    customer: customer
      ? {
          square_id: customer.square_id || order.customer_id || null,
          name: customer.name || null,
          email: customer.email || null,
          phone: customer.phone || null,
        }
      : { square_id: order.customer_id || null, name: null, email: null, phone: null },
    lines,
    // 🚨 THE FIELD WHOSE ABSENCE COST $1,501.44. paymentState() above reads
    // order.tenders to decide PAID, and until 2026-08-20 that was the only use
    // of it — the payment itself was dropped on the floor. The order arrived
    // marked paid with no record of how, and v_product_sales tests for a
    // tender, so every website sale since the Square cutover was excluded from
    // revenue. Silent, one-directional, and growing.
    //
    // 🔑 Square's own tender id travels with it. sync_order_tenders() keys the
    // upsert on that id, which is what makes re-syncing a date range safe: the
    // same payment updates in place instead of being counted twice.
    tenders: (order.tenders || []).map((t) => ({
      square_id: t.id || null,
      type: t.type || null,
      note: t.note || null,
      amount_cents: t.amount_money?.amount ?? 0,
      // Cash drawer figures, when Square recorded them. The DB drops the pair
      // if it does not reconcile against amount_cents; the amount is the number
      // that has to be right.
      tendered_cents: t.cash_details?.buyer_tendered_money?.amount ?? null,
      change_cents: t.cash_details?.change_back_money?.amount ?? null,
      received_at: t.created_at || order.created_at || null,
    })),
  };
}

/**
 * Push one Square order into the database. Returns the function's own report
 * ({created, lines, stock_rows, unmatched}) or null when Supabase is not
 * configured — never throws for the "not set up yet" case, because the caller
 * on the checkout path must not care.
 */
async function syncOrder(order, customer) {
  if (!configured()) return null;
  return rpc('sync_square_order', { p: buildSyncPayload(order, customer) });
}

module.exports = { buildSyncPayload, syncOrder, lineKind, paymentState, orderState, configured, rpc };
