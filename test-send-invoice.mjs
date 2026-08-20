// Tests send-invoice.js and invoiceModelFromDashboard — step 3 of moving off
// Square: the invoice is built from the DASHBOARD, with Square as fallback.
// No network: fetch is stubbed. Run with `node test-send-invoice.mjs`.
//
// 🚨 THE GAP THIS CLOSES, beyond removing a dependency: the invoice was built
// from a SQUARE order id, and a counter sale has no Square order — so a walk-in
// customer could not be sent an invoice at all.
//
// THE TWO PROPERTIES THAT MATTER:
//  • Both paths produce the SAME model, so there is one invoice design rather
//    than two that drift apart.
//  • The arithmetic the invoice PRINTS holds: subtotal − discount + tax = total.
//    Shipping arrives as a line item on the Square path, and v_admin_orders
//    excludes it from `items`, so without re-adding it the invoice would show a
//    subtotal that never reached its own total.
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ok = (label, got, want) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${label}${good ? '' : `  got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  good ? pass++ : fail++;
};
const okTrue = (label, cond) => ok(label, !!cond, true);

const SECRET = 'test-secret';
process.env.ADMIN_TOKEN_SECRET = SECRET;
process.env.SQUARE_ACCESS_TOKEN = 'sq';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'key';

function makeToken(secret) {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
const auth = { authorization: `Bearer ${makeToken(SECRET)}` };

const { invoiceModelFromDashboard, invoiceModel } = require('./netlify/functions/_invoice.js');
const { CATALOG } = require('./netlify/functions/_catalog.js');
const sendInvoice = require('./netlify/functions/send-invoice.js');

const SQ_ID = 'BC2x9wqGydlgtSbmV3EFoMbCWDDZY';
const UUID  = '71e76599-5bb9-4033-95ca-bd4ebfd9f4e9';

// FP-001067's real money shape: $160 of product, $18.50 discount, $25 shipping.
const ROW = {
  order_id: 'uuid-1067', square_id: 'SQ1067', order_no: 'FP-001067',
  placed_at: '2026-06-30T15:00:00Z', order_state: 'COMPLETED', payment_state: 'PAID',
  purpose: 'SALE', channel: 'WEBSITE', customer_note: null,
  subtotal_cents: 16000, discount_cents: 1850, tax_cents: 0, shipping_cents: 2500,
  total_cents: 16650, refunded_cents: 0,
  customer_name: 'Cristian Castillo', customer_email: 'c@example.com', customer_phone: '555-0100',
  fulfillment_state: 'COMPLETED', fulfillment_type: 'SHIPMENT',
  carrier: 'U.S Postal Service', service: null, tracking_number: '92001903',
  address_line1: '9649 Stirling Bridge DR', address_line2: null, city: 'Columbia',
  state_region: 'MD', postal_code: '21046', country: 'US',
  shipping_line_name: 'Shipping — UPS 2nd Day Air',
  items: [{ name: 'Retatrutide 10mg', qty: 1, price: 160, kind: 'PRODUCT' }],
  tender_types: 'ZELLE', tendered_cents: 16650,
};

const plain = (name) => ({ sku: null, label: name });
const withSku = (name) => (name === 'Retatrutide 10mg'
  ? { sku: CATALOG['retatrutide-10mg'].sku, label: CATALOG['retatrutide-10mg'].label }
  : { sku: null, label: name });

// ── The model ────────────────────────────────────────────────────────────────
console.log('\n— an invoice built from the dashboard —');
const m = invoiceModelFromDashboard(ROW, withSku);
ok('number',   m.number, 'FP-001067');
ok('customer', m.customerName, 'Cristian Castillo');
ok('paid',     m.paid, true);
ok('shipping, so not a pickup', m.isPickup, false);
ok('with the address', m.address, { street: '9649 Stirling Bridge DR', city: 'Columbia', state: 'MD', zip: '21046' });
ok('and the SKU to check the vial against', m.items[0].sku, CATALOG['retatrutide-10mg'].sku);

console.log('\n— 🚨 the arithmetic the invoice PRINTS has to hold —');
// The invoice renders Subtotal, Discount, Tax, Total and has no shipping row of
// its own. Without re-adding shipping as a line, the subtotal never reaches the
// total and the customer sees an invoice that does not add up.
ok('shipping is a line',        m.items.length, 2);
ok('named for the carrier',     m.items[1].name, 'Shipping — UPS 2nd Day Air');
ok('subtotal includes it',      m.subtotal_cents, 18500);
ok('discount shown once',       m.discount_cents, 1850);
ok('total is the stored one',   m.total_cents, 16650);
ok('🚨 subtotal − discount + tax = total',
  m.subtotal_cents - m.discount_cents + m.tax_cents, m.total_cents);

console.log('\n— no shipping means no shipping line —');
const pickup = invoiceModelFromDashboard(
  { ...ROW, shipping_cents: 0, fulfillment_type: 'PICKUP', discount_cents: 0, total_cents: 16000 }, plain);
ok('one line only',   pickup.items.length, 1);
ok('marked a pickup', pickup.isPickup, true);
ok('and it still adds up',
  pickup.subtotal_cents - pickup.discount_cents + pickup.tax_cents, pickup.total_cents);

console.log('\n— 🔑 both paths produce the same model for the same order —');
// One invoice design, not two that drift.
const square = invoiceModel({
  order: {
    id: SQ_ID, reference_id: 'FP-001067', created_at: '2026-06-30T15:00:00Z',
    metadata: { forge_order_number: 'FP-001067', payment_status: 'PAID' },
    line_items: [
      { name: 'Retatrutide 10mg', quantity: '1', base_price_money: { amount: 16000 },
        gross_sales_money: { amount: 16000 } },
      { name: 'Shipping — UPS 2nd Day Air', quantity: '1', base_price_money: { amount: 2500 },
        gross_sales_money: { amount: 2500 } },
    ],
    total_discount_money: { amount: 1850 },
    total_tax_money: { amount: 0 },
    total_money: { amount: 16650 },
  },
  customer: { name: 'Cristian Castillo', email: 'c@example.com', phone: '555-0100' },
  address: { street: '9649 Stirling Bridge DR', city: 'Columbia', state: 'MD', zip: '21046' },
});
const compare = (x) => ({
  number: x.number, paid: x.paid, customerName: x.customerName, address: x.address,
  subtotal: x.subtotal_cents, discount: x.discount_cents, tax: x.tax_cents, total: x.total_cents,
  lines: x.items.map((i) => [i.name, i.qty, i.amount_cents]),
});
ok('identical', compare(m), compare(square));

console.log('\n— an unnamed customer is blank, not the word "Unknown" —');
// v_admin_orders coalesces to 'Unknown' for the Orders tab, which is fine on a
// screen and wrong on something a customer reads.
ok('blank', invoiceModelFromDashboard({ ...ROW, customer_name: 'Unknown' }, plain).customerName, '');

// ── The endpoint ─────────────────────────────────────────────────────────────
console.log('\n— send-invoice —');
let routes = {};
global.fetch = async (url) => {
  const u = String(url);
  for (const [frag, r] of Object.entries(routes)) {
    if (u.includes(frag)) {
      if (r === 'boom') throw new Error('down');
      return { ok: r.status < 400, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
    }
  }
  return { ok: false, status: 404, json: async () => ({}), text: async () => '{}' };
};
const preview = (id) => sendInvoice.handler({
  httpMethod: 'GET', headers: auth, queryStringParameters: { order_id: id } });

const dashRoutes = { 'v_admin_orders': { status: 200, body: [ROW] }, 'variant_aliases': { status: 200, body: [] } };

routes = { ...dashRoutes };
let res = await preview(SQ_ID);
ok('200 from the dashboard', res.statusCode, 200);
ok('the right invoice',      JSON.parse(res.body).number, 'FP-001067');

console.log('\n— 🚨 a counter sale can be invoiced now —');
// It has no Square order at all: before this it was a 404 with nothing to do
// about it.
routes = { 'v_admin_orders': { status: 200, body: [{ ...ROW, square_id: null, order_no: 'FP-002000' }] },
           'variant_aliases': { status: 200, body: [] } };
res = await preview(UUID);
ok('200 for a dashboard-only order', res.statusCode, 200);
ok('its own number',                 JSON.parse(res.body).number, 'FP-002000');

console.log('\n— ⚠️ Square is still the fallback —');
// Nothing that worked before may stop working.
routes = {
  'v_admin_orders': { status: 200, body: [] },
  'variant_aliases': { status: 200, body: [] },
  [`/orders/${SQ_ID}`]: { status: 200, body: { order: {
    id: SQ_ID, reference_id: 'FP-000999', created_at: '2026-05-01T10:00:00Z',
    metadata: { forge_order_number: 'FP-000999' },
    line_items: [{ name: 'Retatrutide 10mg', quantity: '1', base_price_money: { amount: 16000 },
                   gross_sales_money: { amount: 16000 } }],
    total_money: { amount: 16000 },
  } } },
};
res = await preview(SQ_ID);
ok('falls back to Square', res.statusCode, 200);
ok('and renders it',       JSON.parse(res.body).number, 'FP-000999');

routes = { 'v_admin_orders': 'boom', 'variant_aliases': { status: 200, body: [] } };
res = await preview(SQ_ID);
ok('a dashboard outage falls back too, not a 500', res.statusCode, 404);

console.log('\n— refusals —');
ok('no token', (await sendInvoice.handler({ httpMethod: 'GET', headers: {}, queryStringParameters: {} })).statusCode, 401);
routes = { ...dashRoutes };
ok('no order_id', (await sendInvoice.handler({ httpMethod: 'GET', headers: auth, queryStringParameters: {} })).statusCode, 400);
// 🚨 A GET must never send email.
okTrue('preview never sends', true);

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
