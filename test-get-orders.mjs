// Tests get-orders.js — step 2 of moving off Square: the DASHBOARD is now the
// primary order list and Square is merged in only for what it does not have.
// No network: fetch is stubbed. Run with `node test-get-orders.mjs`.
//
// WHAT THESE PROTECT. This is the screen Frank ships from. The failure that
// matters is not "wrong number" but "order missing" — FP-001004 was invisible
// for three months behind three stacked filters. So the assertions here are
// mostly about nothing disappearing:
//   • the dashboard feed is used when it answers
//   • a Square order the feed lacks is still shown, not dropped
//   • an order in both is shown ONCE
//   • and if the feed cannot be read at all, the old Square path still works
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
process.env.SQUARE_LOCATION_ID = 'LOC1';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'key';

function makeToken(secret) {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
const auth = { authorization: `Bearer ${makeToken(SECRET)}` };
const getOrders = require('./netlify/functions/get-orders.js');

// ── Fixtures ─────────────────────────────────────────────────────────────────
// FP-001004: the DRAFT order that was invisible. It lives in both systems.
const FEED_ROW = {
  order_id: 'uuid-1004', square_id: 'SQ1004', order_no: 'FP-001004',
  placed_at: '2026-05-21T04:00:00Z', order_state: 'DRAFT', payment_state: 'PAID',
  purpose: 'SALE', channel: 'MANUAL', customer_note: null,
  subtotal_cents: 25900, discount_cents: 0, tax_cents: 0, shipping_cents: 0,
  total_cents: 25900, refunded_cents: 0,
  customer_name: 'Leo the Den', customer_email: '', customer_phone: '',
  party_id: 'p1', fulfillment_state: 'PROPOSED', fulfillment_type: 'PICKUP',
  carrier: null, service: null, tracking_number: null,
  address_line1: null, address_line2: null, city: null, state_region: null,
  postal_code: null, country: null, shipping_line_name: null,
  items: [{ name: 'Retatrutide 10mg', qty: 1, price: 160, kind: 'PRODUCT' }],
  tender_types: null, tendered_cents: 0,
};
// A shipped web order, only in the dashboard feed.
const FEED_SHIPPED = {
  ...FEED_ROW,
  order_id: 'uuid-1067', square_id: 'SQ1067', order_no: 'FP-001067',
  placed_at: '2026-06-30T15:00:00Z', order_state: 'COMPLETED', channel: 'WEBSITE',
  customer_name: 'Cristian Castillo', fulfillment_type: 'SHIPMENT',
  fulfillment_state: 'COMPLETED', carrier: 'U.S Postal Service',
  tracking_number: '9200190324992812893139',
  address_line1: '9649 Stirling Bridge DR', city: 'Columbia',
  state_region: 'MD', postal_code: '21046', country: 'US',
  shipping_line_name: 'Shipping — UPS 2nd Day Air',
  shipping_cents: 1200,
};

// A Square order the dashboard has never heard of — the stray case.
const SQUARE_STRAY = {
  id: 'SQ-ONLY-1', created_at: '2026-08-01T12:00:00Z', state: 'OPEN',
  reference_id: 'FP-009999', metadata: { forge_order_number: 'FP-009999' },
  total_money: { amount: 5000 }, line_items: [
    { name: 'Retatrutide 10mg', quantity: '1', base_price_money: { amount: 5000 } },
  ],
};
// A Square order that IS in the feed (same square id) — must not appear twice.
const SQUARE_DUP = { ...SQUARE_STRAY, id: 'SQ1004', reference_id: 'FP-001004',
  metadata: { forge_order_number: 'FP-001004' } };

let routes = {};
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  for (const [frag, handler] of Object.entries(routes)) {
    if (u.includes(frag)) {
      const r = typeof handler === 'function' ? await handler(u, opts) : handler;
      if (r === 'boom') throw new Error('network down');
      return { ok: r.status < 400, status: r.status,
               json: async () => r.body, text: async () => JSON.stringify(r.body) };
    }
  }
  return { ok: false, status: 404, json: async () => ({}), text: async () => '{}' };
};

const base = (squareOrders = []) => ({
  'v_admin_orders':            { status: 200, body: [FEED_ROW, FEED_SHIPPED] },
  'v_dashboard_only_orders':   { status: 200, body: [] },
  'v_order_fulfillment':       { status: 200, body: [] },
  'orders?select=square_id':   { status: 200, body: [] },
  'variant_aliases':           { status: 200, body: [] },
  'orders/search':             { status: 200, body: { orders: squareOrders } },
  'customers/search':          { status: 200, body: { customers: [] } },
});

const call = async () => JSON.parse(
  (await getOrders.handler({ httpMethod: 'GET', headers: auth, queryStringParameters: { days: '180' } })).body);

// ── The dashboard leads ──────────────────────────────────────────────────────
console.log('\n— the dashboard feed is the list —');
routes = base([]);
let d = await call();
ok('source is the dashboard', d.source, 'dashboard');
ok('two orders', d.orders.length, 2);
ok('newest first', d.orders.map((o) => o.orderNumber), ['FP-001067', 'FP-001004']);

console.log('\n— the order that was invisible for three months —');
const fp = d.orders.find((o) => o.orderNumber === 'FP-001004');
ok('it is there',            !!fp, true);
ok('named',                  fp.customerName, 'Leo the Den');
ok('itemised',               fp.items.map((i) => i.name), ['Retatrutide 10mg']);
ok('and reads as paid',      fp.status, 'PAID');

console.log('\n— a shipped order keeps everything needed to post it —');
const sh = d.orders.find((o) => o.orderNumber === 'FP-001067');
ok('marked for shipping', sh.fulfillmentType, 'SHIP');
ok('with the address',    sh.shipTo, { street: '9649 Stirling Bridge DR', city: 'Columbia',
                                       state: 'MD', zip: '21046', country: 'US' });
ok('the tracking number', sh.trackingNumber, '9200190324992812893139');
// The carrier lived only inside the shipping line's name on Square-era orders.
ok('and the carrier, parsed out of the line name', sh.shippingLabel, 'UPS 2nd Day Air');
ok('shipping cost',       sh.shippingAmount, 12);

console.log('\n— 🚨 an order Square has and the dashboard does not is still shown —');
// This should never happen. It is carried anyway: an order missing from the
// screen Frank ships from is the one outcome worth a redundant path.
routes = base([SQUARE_STRAY]);
d = await call();
ok('the stray is merged in', d.orders.length, 3);
okTrue('and it is the right one', d.orders.some((o) => o.orderNumber === 'FP-009999'));
ok('and the source says so',  d.source, 'dashboard+square');

console.log('\n— 🚨 an order in BOTH systems appears exactly once —');
routes = base([SQUARE_DUP]);
d = await call();
ok('no duplicate', d.orders.length, 2);
ok('matched on the square id', d.orders.filter((o) => o.orderNumber === 'FP-001004').length, 1);
ok('and nothing was treated as stray', d.source, 'dashboard');

console.log('\n— ⚠️ if the feed cannot be read, the old Square path still works —');
// A reporting view being down must never empty the Orders tab.
routes = base([SQUARE_STRAY]);
routes['v_admin_orders'] = { status: 500, body: {} };
routes['v_dashboard_only_orders'] = { status: 200, body: [{
  order_id: 'uuid-counter', order_number: 'FP-002000', created_at: '2026-08-02T15:00:00Z',
  payment_state: 'PAID', order_state: 'COMPLETED', channel: 'POS',
  customer_name: 'Walk-in', customer_email: '', customer_phone: '', customer_note: null,
  total: 60, subtotal: 60, tax_amount: 0, shipping_amount: 0,
  fulfillment_state: 'PROPOSED', items: [{ name: 'MOTS-C 10MG', qty: 1, price: 60 }],
}] };
d = await call();
ok('it falls back',                 d.source, 'square');
okTrue('the Square order is there', d.orders.some((o) => o.orderNumber === 'FP-009999'));
okTrue('and the counter sale too',  d.orders.some((o) => o.orderNumber === 'FP-002000'));

console.log('\n— ⚠️ an empty feed is a real answer, not a failure —');
// [] means "no orders in this window". null means "could not ask". Collapsing
// the two would make an outage look like a quiet day.
routes = base([]);
routes['v_admin_orders'] = { status: 200, body: [] };
d = await call();
ok('no orders, from the dashboard', [d.orders.length, d.source], [0, 'dashboard']);

console.log('\n— 🚨 Square being unreachable does not empty the tab —');
// Before the inversion a Square outage took the whole request down with it.
// The dashboard is the record now; Square going quiet is not an empty day.
routes = base([]);
routes['orders/search'] = 'boom';
d = await call();
ok('the dashboard still answers', d.orders.length, 2);
ok('and says where it came from', d.source, 'dashboard');

console.log('\n— 🚨 but BOTH sources silent is an outage, not an empty day —');
// Serving [] here would read as "nothing to pack" on the screen used to decide
// what to pack.
routes = base([]);
routes['orders/search'] = 'boom';
routes['v_admin_orders'] = { status: 500, body: {} };
routes['v_dashboard_only_orders'] = { status: 500, body: {} };
const res502 = await getOrders.handler({ httpMethod: 'GET', headers: auth, queryStringParameters: { days: '180' } });
ok('502, not an empty list', res502.statusCode, 502);
okTrue('and it says so plainly', /not an empty order list/i.test(JSON.parse(res502.body).error));

console.log('\n— refusals —');
ok('no token', (await getOrders.handler({ httpMethod: 'GET', headers: {}, queryStringParameters: null })).statusCode, 401);

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
