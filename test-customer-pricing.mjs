// Tests per-customer pricing end to end through create-invoice.js. No network:
// fetch and the sign-in cookie are stubbed.
//
// Frank, 2026-08-20: "give them certain pricing for certain items so they don't
// have to use a promo code on the whole order" and — the rule that decides the
// arithmetic — "if any prices are adjusted on my end, those prices can't be
// adjusted further by a promo code."
//
// 🚨 THE TWO PROPERTIES THAT MATTER MOST, in order:
//   1. A PRICE IS KEYED TO THE SESSION COOKIE, NEVER TO THE TYPED EMAIL. The
//      checkout form's email is attacker-controlled. If knowing Antonio's
//      address were enough to get Antonio's price, this feature would be worse
//      than the leaked promo code it replaces.
//   2. AN ORDINARY BASKET IS CHARGED EXACTLY WHAT IT WAS CHARGED BEFORE. The
//      discount and tax expressions were rearranged to support the exclusion;
//      real orders are re-derived here to prove nothing moved by a cent.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ok = (label, got, want) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${label}${good ? '' : `  got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  good ? pass++ : fail++;
};
const okTrue = (label, cond, d = '') => ok(label + (cond ? '' : ` ${d}`), !!cond, true);

process.env.SQUARE_ACCESS_TOKEN = 'sq';
process.env.SQUARE_LOCATION_ID = 'LOC1';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'key';
process.env.CUSTOMER_SESSION_SECRET = 'test-secret-for-signing-sessions';
process.env.ORDER_SOURCE = 'dashboard';

const VARIANT = '33333333-3333-3333-3333-333333333333';

// What the database would say this signed-in customer has agreed.
let agreed = [];
// What create_manual_order was asked to write.
let lastOrder = null;
let calls = [];
let priceLookups = 0;

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ url: u, method: opts.method || 'GET', body });

  if (u.includes('rpc/customer_prices')) {
    priceLookups++;
    return { ok: true, status: 200, text: async () => JSON.stringify(agreed) };
  }
  if (u.includes('variants?select=id,site_catalog_id')) {
    return { ok: true, status: 200, json: async () => [
      { id: VARIANT, site_catalog_id: 'retatrutide-10mg' },
      { id: '44444444-4444-4444-4444-444444444444', site_catalog_id: 'glow-blend' },
    ], text: async () => '[]' };
  }
  if (u.includes('parties?select=id')) {
    return { ok: true, status: 200, json: async () => [{ id: 'party-1' }], text: async () => '[]' };
  }
  if (u.includes('orders?select=id')) {
    return { ok: true, status: 200, json: async () => [{ id: 'x' }], text: async () => '[]' };
  }
  if (u.includes('rpc/create_manual_order')) {
    // create_manual_order takes one jsonb argument, so the payload is nested.
    lastOrder = body && body.p ? body.p : body;
    return { ok: true, status: 200, text: async () => JSON.stringify({
      order_id: 'o-1', order_no: 'FP-009000', created: true, lines: 1, stock_rows: 1,
      subtotal_cents: 0, total_cents: 0, tender: false, fulfillment: 'PICKUP',
    }) };
  }
  if (u.includes('/orders/search')) {
    return { ok: true, status: 200, json: async () => ({ orders: [] }), text: async () => '{}' };
  }
  if (u.includes('/customers')) {
    return { ok: true, status: 200,
             json: async () => ({ customer: { id: 'sq-cust' }, customers: [] }), text: async () => '{}' };
  }
  if (u.endsWith('/orders')) {
    return { ok: true, status: 200, json: async () => ({ order: { id: 'sq-1', line_items: [] } }), text: async () => '{}' };
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
};

const auth = require('./netlify/functions/_customer-auth.js');
const signedInHeaders = () => ({ cookie: auth.sessionCookie(auth.signSession({
  accountId: '11111111-1111-1111-1111-111111111111', email: 'antonio@example.com',
})).split(';')[0] });

const load = () => {
  delete require.cache[require.resolve('./netlify/functions/create-invoice.js')];
  return require('./netlify/functions/create-invoice.js');
};

const place = async (payload, headers = {}) => {
  calls = []; lastOrder = null; priceLookups = 0;
  const fn = load();
  const res = await fn.handler({ httpMethod: 'POST', headers, body: JSON.stringify({
    customerName: 'Antonio Torres', customerEmail: 'antonio@example.com',
    fulfillment: 'Local Pickup', ...payload,
  }) });
  return { res, order: lastOrder };
};

const RETA = { id: 'retatrutide-10mg', name: 'Retatrutide 10mg', price: 160, qty: 1 };
// 🔑 The name the browser sends is IGNORED — sanitizeItems rewrites it from
// CATALOG, which is exactly why a manipulated body cannot rename a cheap item
// into an expensive one. So the line comes back as CATALOG's "Glow Blend".
const GLOW = { id: 'glow-blend', name: 'whatever the browser felt like', price: 999, qty: 1 };
const GLOW_NAME = 'Glow Blend';
const lineOf = (o, name) => (o.lines || []).find((l) => String(l.name || '').includes(name));
// The payload carries lines, tax and discount; create_manual_order works out
// the totals, so the subtotal is derived here the same way it does.
const subtotalOf = (o) => (o.lines || []).reduce((n, l) => n + l.unit_price_cents * l.quantity, 0);

// ── 1. 🚨 A signed-out shopper pays list, and nothing is even looked up ──────
console.log('\n1. 🚨 signed out means list price');
agreed = [{ site_catalog_id: 'retatrutide-10mg', price_cents: 7500 }];
let { order } = await place({ items: [RETA] });
ok('🚨 charged the list price', order.lines[0].unit_price_cents, 16000);
ok('🚨 and the price lookup never ran', priceLookups, 0);

// ── 2. 🚨 The typed email buys nothing ──────────────────────────────────────
// This is the whole attack: knowing a customer's address must not be enough.
console.log('\n2. 🚨 knowing the email is not being the customer');
({ order } = await place({ items: [RETA], customerEmail: 'antonio@example.com' }));
ok('🚨 the form email does not unlock a price', order.lines[0].unit_price_cents, 16000);
okTrue('🚨 and no request carried that email to the pricing lookup',
  !calls.some((c) => c.url.includes('customer_prices')));

// ── 3. Signed in, the agreed price applies ──────────────────────────────────
console.log('\n3. signed in, the agreed price is what is charged');
({ order } = await place({ items: [RETA] }, signedInHeaders()));
ok('Retatrutide 10mg at the agreed $75', order.lines[0].unit_price_cents, 7500);
ok('   the lookup ran once',              priceLookups, 1);
ok('   quantity still multiplies',        subtotalOf(order), 7500);
({ order } = await place({ items: [{ ...RETA, qty: 3 }] }, signedInHeaders()));
ok('   three of them',                    subtotalOf(order), 22500);

// ── 4. Only the agreed product moves ────────────────────────────────────────
console.log('\n4. a basket of one agreed item and one ordinary one');
({ order } = await place({ items: [RETA, GLOW] }, signedInHeaders()));
ok('the agreed line is discounted', lineOf(order, 'Retatrutide').unit_price_cents, 7500);
ok('the ordinary line is not',      lineOf(order, GLOW_NAME).unit_price_cents, 16500);

// ── 5. 🚨 A promo code cannot cut an agreed price further ───────────────────
console.log('\n5. 🚨 a promo code stops at an agreed price');
({ order } = await place({ items: [RETA, GLOW], promoCode: 'LOYAL10' }, signedInHeaders()));
// $75 agreed + $165 list. 10% applies to the $165 only = $16.50.
ok('🚨 the discount is 10% of the ORDINARY line only', order.discount_cents, 1650);
okTrue('🚨 and NOT 10% of the whole $240 basket', order.discount_cents !== 2400);
ok('   the agreed line still costs what was agreed',
   lineOf(order, 'Retatrutide').unit_price_cents, 7500);

({ order } = await place({ items: [RETA], promoCode: 'LOYAL10' }, signedInHeaders()));
ok('🚨 a basket of only agreed items gets no discount at all', order.discount_cents, 0);
ok('   and the line is the agreed price',                    subtotalOf(order), 7500);

// ── 6. Tax follows the same rule ────────────────────────────────────────────
console.log('\n6. tax is charged on what was actually charged');
// Local pickup is Florida. $75 agreed + $165 list, 10% off the $165 = $16.50.
// Taxable = 240.00 − 16.50 = 223.50 → 7% = 15.645 → 1564 cents.
({ order } = await place({ items: [RETA, GLOW], promoCode: 'LOYAL10' }, signedInHeaders()));
ok('🚨 tax is 7% of the discounted subtotal, agreed line included at its real price',
   order.tax_cents, Math.round((24000 - 1650) * 0.07));
({ order } = await place({ items: [RETA] }, signedInHeaders()));
ok('an agreed line is fully taxable — nothing was discounted off it',
   order.tax_cents, Math.round(7500 * 0.07));

// ── 7. 🚨 Nothing changed for an ordinary basket ────────────────────────────
// The discount and tax expressions were rearranged. These re-derive REAL orders.
console.log('\n7. 🚨 the untouched baskets still charge to the cent');
agreed = [];
({ order } = await place({
  items: [{ id: 'retatrutide-10mg', name: 'Retatrutide 10mg', price: 160, qty: 1 }],
  promoCode: 'LOYAL10', fulfillment: 'Ship', shippingAmount: 25,
  street: '1 A St', city: 'Miami', state: 'FL', zip: '33184',
}, signedInHeaders()));
// FP-001067: $160.00 product + $25.00 shipping, $18.50 off = 10% of $185.00.
ok('🚨 FP-001067 reproduces: $18.50 off product PLUS shipping', order.discount_cents, 1850);
ok('   tax on the discounted product subtotal', order.tax_cents, Math.round(16000 * 0.9 * 0.07));

({ order } = await place({ items: [RETA, GLOW], promoCode: 'LOYAL10' }, signedInHeaders()));
ok('🚨 with nothing agreed the discount is the whole basket again — 10% of $325',
   order.discount_cents, 3250);
ok('   and both lines carry list price',
   [lineOf(order, 'Retatrutide').unit_price_cents, lineOf(order, GLOW_NAME).unit_price_cents],
   [16000, 16500]);

// ── 8. A price above list is ignored ────────────────────────────────────────
console.log('\n8. a price above retail is a typo, not a price');
agreed = [{ site_catalog_id: 'retatrutide-10mg', price_cents: 99000 }];
({ order } = await place({ items: [RETA] }, signedInHeaders()));
ok('🚨 the customer is not overcharged', order.lines[0].unit_price_cents, 16000);
ok('   and the line is not treated as agreed, so a code still applies to it',
   (await place({ items: [RETA], promoCode: 'LOYAL10' }, signedInHeaders())).order.discount_cents, 1600);

// ── 9. Zero is a real agreed price ──────────────────────────────────────────
console.log('\n9. zero is a decision, not a missing value');
agreed = [{ site_catalog_id: 'retatrutide-10mg', price_cents: 0 }];
({ order } = await place({ items: [RETA] }, signedInHeaders()));
ok('🚨 a comp is charged nothing, not full retail', order.lines[0].unit_price_cents, 0);

// ── 10. The lookup fails open to list price ─────────────────────────────────
console.log('\n10. a lookup that breaks must not refuse the sale');
agreed = [{ site_catalog_id: 'retatrutide-10mg', price_cents: 7500 }];
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).includes('rpc/customer_prices')) throw new Error('database is down');
  return realFetch(url, opts);
};
const broken = await place({ items: [RETA] }, signedInHeaders());
global.fetch = realFetch;
ok('🚨 the order still goes through', broken.res.statusCode, 200);
ok('🚨 at list price — the worst case is paying what everyone pays',
   broken.order.lines[0].unit_price_cents, 16000);

// ── 11. The Square path agrees with the dashboard path ──────────────────────
// A total that depends on an environment variable is the worst outcome here.
console.log('\n11. 🚨 Square is not discounted twice');
agreed = [{ site_catalog_id: 'retatrutide-10mg', price_cents: 7500 }];
delete process.env.ORDER_SOURCE;
calls = [];
let fn = load();
await fn.handler({ httpMethod: 'POST', headers: signedInHeaders(), body: JSON.stringify({
  items: [RETA, GLOW], promoCode: 'LOYAL10',
  customerName: 'Antonio Torres', customerEmail: 'antonio@example.com', fulfillment: 'Local Pickup',
}) });
const sqOrder = calls.find((c) => c.url.endsWith('/orders') && c.method === 'POST');
okTrue('an order went to Square', !!sqOrder);
const sq = sqOrder.body.order;
ok('🚨 the agreed price is on the Square line too',
   sq.line_items.find((l) => l.name.includes('Retatrutide')).base_price_money.amount, 7500);
ok('🚨 the discount became LINE_ITEM scope so it can be excluded',
   sq.discounts[0].scope, 'LINE_ITEM');
okTrue('🚨 and it is NOT applied to the agreed line',
   !sq.line_items.find((l) => l.name.includes('Retatrutide')).applied_discounts);
okTrue('   but IS applied to the ordinary one',
   !!sq.line_items.find((l) => l.name.includes(GLOW_NAME)).applied_discounts);

// With nothing agreed the Square discount must stay exactly as it was: ORDER
// scope, so no existing order's total can shift on a rounding difference.
agreed = [];
calls = [];
fn = load();
await fn.handler({ httpMethod: 'POST', headers: signedInHeaders(), body: JSON.stringify({
  items: [RETA], promoCode: 'LOYAL10',
  customerName: 'A', customerEmail: 'a@example.com', fulfillment: 'Local Pickup',
}) });
const plain = calls.find((c) => c.url.endsWith('/orders') && c.method === 'POST').body.order;
ok('🚨 an ordinary basket keeps the ORDER-scope discount it always had',
   plain.discounts[0].scope, 'ORDER');
okTrue('   with no per-line discounts introduced',
   plain.line_items.every((l) => !l.applied_discounts));


// ── 12. What the shop is TOLD, via account.js ───────────────────────────────
// 🚨 Display only. create-invoice.js does its own lookup, so this list can be
// wrong or tampered with and the bill is unaffected — but it still must not
// advertise a price the checkout would refuse to honour.
console.log('\n12. the price the storefront shows');
let accountRpc = {};
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const fn = (u.match(/rpc\/(\w+)/) || [])[1];
  if (fn) return { ok: true, status: 200, text: async () => JSON.stringify(accountRpc[fn] ?? []) };
  return { ok: true, status: 200, json: async () => ({}), text: async () => '[]' };
};
accountRpc = {
  customer_details: [{ full_name: 'Antonio Torres' }],
  customer_orders: [],
  customer_order_items: [],
  customer_prices: [
    { site_catalog_id: 'retatrutide-10mg', price_cents: 7500 },
    { site_catalog_id: 'retatrutide-30mg', price_cents: 99000 },  // above list
    { site_catalog_id: 'no-such-product',  price_cents: 1000 },   // not in CATALOG
  ],
};
delete require.cache[require.resolve('./netlify/functions/account.js')];
const account = require('./netlify/functions/account.js');
let accRes = await account.handler({ httpMethod: 'GET', headers: signedInHeaders() });
let accBody = JSON.parse(accRes.body);
ok('the agreed price is offered to the page',
   accBody.prices.find((r) => r.id === 'retatrutide-10mg'),
   { id: 'retatrutide-10mg', price: 75, list: 160 });
okTrue('🚨 a price ABOVE list is dropped, not advertised',
   !accBody.prices.some((r) => r.id === 'retatrutide-30mg'));
okTrue('   and a product the shop does not sell is dropped',
   !accBody.prices.some((r) => r.id === 'no-such-product'));
ok('so the page is told about exactly one', accBody.prices.length, 1);

// 🔑 The prices call failing must not take the whole account panel down —
// orders and saved details are the reason a customer opens it.
accountRpc.customer_prices = undefined;
global.fetch = async (url) => {
  const u = String(url);
  const fn = (u.match(/rpc\/(\w+)/) || [])[1];
  if (fn === 'customer_prices') return { ok: false, status: 500, text: async () => 'boom' };
  return { ok: true, status: 200, text: async () => JSON.stringify(accountRpc[fn] ?? []) };
};
delete require.cache[require.resolve('./netlify/functions/account.js')];
accRes = await require('./netlify/functions/account.js').handler({ httpMethod: 'GET', headers: signedInHeaders() });
accBody = JSON.parse(accRes.body);
ok('🚨 a broken pricing lookup still returns the account', accRes.statusCode, 200);
ok('   with no prices rather than an error', accBody.prices, []);
okTrue('   and the rest of the panel intact', accBody.signedIn === true);

// A signed-out request never reaches any of it.
accRes = await require('./netlify/functions/account.js').handler({ httpMethod: 'GET', headers: {} });
ok('🚨 signed out gets 401, not a price list', accRes.statusCode, 401);

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
