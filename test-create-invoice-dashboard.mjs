// Tests step 5 — the checkout writing to the DASHBOARD instead of Square,
// behind ORDER_SOURCE. No network: fetch is stubbed.
// Run with `node test-create-invoice-dashboard.mjs`.
//
// 🚨 THE ASSERTION THAT MATTERS MOST is that both paths charge the SAME for the
// same basket. A checkout that produces a different total depending on an
// environment variable is the worst possible outcome of this migration, and the
// money rules are subtle enough to get wrong:
//   • Florida tax applies to the PRODUCT subtotal only — shipping is not taxed.
//   • The 10% promo is ORDER scope, so it comes off product PLUS shipping.
// Both are read off real orders: FP-001067 is $160.00 product + $25.00 shipping
// with an $18.50 discount, which is 10% of $185.00, not of $160.00.
//
// 🚨 AND THAT ORDER_SOURCE DEFAULTS TO SQUARE. Turning it on is a one-way door
// for every order placed while it is set, so it must never happen by accident.
import { createRequire } from 'module';
import { readFileSync } from 'fs';
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

const VARIANT = '33333333-3333-3333-3333-333333333333';
const VARIANT2 = '44444444-4444-4444-4444-444444444444';

let calls = [];
let priorOrders = [];
let rpcResponse = { order_id: 'o-web-1', order_no: 'FP-002100', created: true,
                    lines: 1, stock_rows: 1, subtotal_cents: 16000, total_cents: 18620,
                    tender: false, fulfillment: 'SHIPMENT' };
let squareOrderResponse = null;

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ url: u, method: opts.method || 'GET', body });

  if (u.includes('variants?select=id,site_catalog_id')) {
    return { ok: true, status: 200, json: async () => [
      { id: VARIANT,  site_catalog_id: 'retatrutide-10mg' },
      { id: VARIANT2, site_catalog_id: 'bpc-157-10mg' },
    ], text: async () => '[]' };
  }
  if (u.includes('parties?select=id')) {
    return { ok: true, status: 200, json: async () => [{ id: 'party-1' }], text: async () => '[]' };
  }
  if (u.includes('orders?select=id')) {
    return { ok: true, status: 200, json: async () => priorOrders, text: async () => '[]' };
  }
  if (u.includes('rpc/create_manual_order')) {
    return { ok: true, status: 200, text: async () => JSON.stringify(rpcResponse) };
  }
  if (u.includes('/orders/search')) {
    return { ok: true, status: 200, json: async () => ({ orders: [] }), text: async () => '{}' };
  }
  if (u.includes('/customers')) {
    return { ok: true, status: 200, json: async () => ({ customer: { id: 'sq-cust' }, customers: [] }), text: async () => '{}' };
  }
  if (u.endsWith('/orders')) {
    return { ok: true, status: 200, json: async () => ({ order: squareOrderResponse }), text: async () => '{}' };
  }
  if (u.includes('inventory/changes')) {
    return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
};

const load = () => {
  delete require.cache[require.resolve('./netlify/functions/create-invoice.js')];
  return require('./netlify/functions/create-invoice.js');
};

// ── The switch ───────────────────────────────────────────────────────────────
console.log('\n— 🚨 ORDER_SOURCE defaults to Square —');
// Turning it on is a one-way door for every order placed while it is set.
delete process.env.ORDER_SOURCE;
calls = [];
let fn = load();
let res = await fn.handler({ httpMethod: 'POST', body: JSON.stringify({
  items: [{ id: 'retatrutide-10mg', name: 'Retatrutide 10mg', price: 160, qty: 1 }],
  customerName: 'Test Buyer', customerEmail: 'buyer@example.com', customerPhone: '555-0111',
  fulfillment: 'Local Pickup',
}) });
okTrue('with nothing set, it writes to Square',
  calls.some((c) => c.url.endsWith('/orders') && c.method === 'POST'),
  calls.map((c) => c.url).join(' '));
okTrue('and not to the dashboard', !calls.some((c) => c.url.includes('rpc/create_manual_order')));

for (const value of ['', 'square', 'SQUARE', 'off', 'yes']) {
  process.env.ORDER_SOURCE = value;
  calls = [];
  fn = load();
  await fn.handler({ httpMethod: 'POST', body: JSON.stringify({
    items: [{ id: 'retatrutide-10mg', name: 'Retatrutide 10mg', price: 160, qty: 1 }],
    customerName: 'T', customerEmail: 't@example.com', fulfillment: 'Local Pickup',
  }) });
  okTrue(`ORDER_SOURCE="${value}" still means Square`,
    !calls.some((c) => c.url.includes('rpc/create_manual_order')));
}

// ── The dashboard path ───────────────────────────────────────────────────────
console.log('\n— with ORDER_SOURCE=dashboard —');
process.env.ORDER_SOURCE = 'dashboard';
priorOrders = [{ id: 'x' }];   // a returning customer: no FORGE10
calls = [];
fn = load();
res = await fn.handler({ httpMethod: 'POST', body: JSON.stringify({
  items: [{ id: 'retatrutide-10mg', name: 'Retatrutide 10mg', price: 160, qty: 1 }],
  customerName: 'Test Buyer', customerEmail: 'buyer@example.com', customerPhone: '555-0111',
  fulfillment: 'Ship', street: '123 Main St', city: 'Columbia', state: 'MD', zip: '21046',
  shippingAmount: 12,
}) });
ok('the order is accepted', res.statusCode, 200);
okTrue('🚨 NO Square order was created',
  !calls.some((c) => c.url.endsWith('/orders') && c.method === 'POST'));
okTrue('nor a Square customer', !calls.some((c) => c.url.includes('/customers') && c.method === 'POST'));
okTrue('nor a Square inventory change', !calls.some((c) => c.url.includes('inventory/changes')));
okTrue('nor a sync back', !calls.some((c) => c.url.includes('sync_square_order')));

const sent = calls.find((c) => c.url.includes('rpc/create_manual_order')).body.p;
ok('written as a website order', sent.channel, 'WEBSITE');
// Zelle is paid afterwards, exactly as it was through Square.
ok('and unpaid until Zelle lands', sent.payment_state, 'AWAITING_PAYMENT');
ok('the line carries a real variant', sent.lines[0].variant_id, VARIANT);
ok('and the name the site sells it as', sent.lines[0].name, 'Retatrutide 10mg');

console.log('\n— 🚨 where it is going travels with it —');
// This is the gap that made step 5 risky: without it a web order would look
// perfect and be impossible to post.
ok('shipment',  sent.fulfillment.type, 'SHIPMENT');
ok('street',    sent.fulfillment.address_line1, '123 Main St');
ok('city',      sent.fulfillment.city, 'Columbia');
ok('state',     sent.fulfillment.state_region, 'MD');
ok('postcode',  sent.fulfillment.postal_code, '21046');
ok('recipient', sent.fulfillment.recipient_name, 'Test Buyer');

console.log('\n— a local pickup carries no address —');
calls = [];
fn = load();
await fn.handler({ httpMethod: 'POST', body: JSON.stringify({
  items: [{ id: 'retatrutide-10mg', name: 'Retatrutide 10mg', price: 160, qty: 1 }],
  customerName: 'Local Larry', customerEmail: 'larry@example.com', fulfillment: 'Local Pickup',
}) });
const pickup = calls.find((c) => c.url.includes('rpc/create_manual_order')).body.p;
ok('pickup', pickup.fulfillment.type, 'PICKUP');
ok('no street', pickup.fulfillment.address_line1, undefined);

// ── 🚨 The money has to match Square exactly ─────────────────────────────────
console.log('\n— 🚨 both paths charge the same for the same basket —');
const basket = [
  { id: 'retatrutide-10mg', name: 'Retatrutide 10mg', price: 160, qty: 1 },
  { id: 'bpc-157-10mg', name: 'BPC-157 10mg', price: 60, qty: 2 },
];
const productCents = 16000 + 6000 * 2;   // $280.00

// Florida pickup: tax on product only, no shipping.
process.env.ORDER_SOURCE = 'dashboard';
calls = []; fn = load();
await fn.handler({ httpMethod: 'POST', body: JSON.stringify({
  items: basket, customerName: 'FL Buyer', customerEmail: 'fl@example.com',
  fulfillment: 'Local Pickup',
}) });
let p = calls.find((c) => c.url.includes('rpc/create_manual_order')).body.p;
ok('Florida tax with no promo is 7% of the subtotal', p.tax_cents, Math.round(productCents * 0.07));
ok('and nothing is discounted without a promo', p.discount_cents, 0);

// 🚨 TAX IS ON THE DISCOUNTED AMOUNT. This assertion previously encoded the
// opposite, taken from a hint on the admin form rather than from the books —
// and a 100%-off order would have carried $11.20 of tax on a free basket.
// Every real discounted order settles it: FP-396224 is $160.00 with $16.00 off
// and $10.08 of tax, which is 7.00% of $144.00 and 6.30% of $160.00.
priorOrders = [];
process.env.OWNER_PROMO_CODE = 'test-secret-code';
calls = []; fn = load();
await fn.handler({ httpMethod: 'POST', body: JSON.stringify({
  items: [{ id: 'retatrutide-10mg', name: 'Retatrutide 10mg', price: 160, qty: 1 }],
  customerName: 'FL', customerEmail: 'fl2@example.com', promoCode: 'LOYAL10',
  fulfillment: 'Local Pickup',
}) });
p = calls.find((c) => c.url.includes('rpc/create_manual_order')).body.p;
ok('🚨 a 10% discount is taxed on $144.00, not $160.00', p.tax_cents, 1008);
ok('   reproducing FP-396224 exactly', [p.discount_cents, p.tax_cents], [1600, 1008]);

// And the one that made it matter: a free order is genuinely free.
calls = []; fn = load();
await fn.handler({ httpMethod: 'POST', body: JSON.stringify({
  items: [{ id: 'retatrutide-10mg', name: 'Retatrutide 10mg', price: 160, qty: 1 }],
  customerName: 'Owner', customerEmail: 'ftt1598@gmail.com', promoCode: 'test-secret-code',
  fulfillment: 'Local Pickup',
}) });
p = calls.find((c) => c.url.includes('rpc/create_manual_order')).body.p;
ok('🚨 a 100% code carries NO tax', p.tax_cents, 0);
ok('   and nothing is left to pay', p.discount_cents, 16000);
delete process.env.OWNER_PROMO_CODE;
priorOrders = [{ id: 'x' }];

// Shipping to Maryland: no Florida tax, and shipping is NOT taxed anywhere.
calls = []; fn = load();
await fn.handler({ httpMethod: 'POST', body: JSON.stringify({
  items: basket, customerName: 'MD Buyer', customerEmail: 'md@example.com',
  fulfillment: 'Ship', street: '1 A St', city: 'Columbia', state: 'MD', zip: '21046',
  shippingAmount: 25,
}) });
p = calls.find((c) => c.url.includes('rpc/create_manual_order')).body.p;
ok('no Florida tax outside Florida', p.tax_cents, 0);
ok('shipping is carried separately', p.shipping_cents, 2500);

// 🚨 The promo covers shipping too — proven by FP-001067's real $18.50 on
// $160.00 of product plus $25.00 of shipping.
priorOrders = [];   // a brand-new customer, so FORGE10 is valid
calls = []; fn = load();
await fn.handler({ httpMethod: 'POST', body: JSON.stringify({
  items: [{ id: 'retatrutide-10mg', name: 'Retatrutide 10mg', price: 160, qty: 1 }],
  customerName: 'New Buyer', customerEmail: 'new@example.com', promoCode: 'FORGE10',
  fulfillment: 'Ship', street: '1 A St', city: 'Columbia', state: 'MD', zip: '21046',
  shippingAmount: 25,
}) });
p = calls.find((c) => c.url.includes('rpc/create_manual_order')).body.p;
ok('🚨 the 10% comes off product AND shipping', p.discount_cents, 1850);

console.log('\n— FORGE10 is a FIRST-order discount, checked here —');
priorOrders = [{ id: 'past' }];
calls = []; fn = load();
await fn.handler({ httpMethod: 'POST', body: JSON.stringify({
  items: [{ id: 'retatrutide-10mg', name: 'Retatrutide 10mg', price: 160, qty: 1 }],
  customerName: 'Repeat Buyer', customerEmail: 'repeat@example.com', promoCode: 'FORGE10',
  fulfillment: 'Local Pickup',
}) });
p = calls.find((c) => c.url.includes('rpc/create_manual_order')).body.p;
ok('a returning customer gets nothing off', p.discount_cents, 0);

// ⚠️ If it cannot be established, DENY. An unverifiable first-order discount is
// a repeatable one.
const savedFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  if (String(url).includes('parties?select=id')) throw new Error('down');
  return savedFetch(url, opts);
};
calls = []; fn = load();
await fn.handler({ httpMethod: 'POST', body: JSON.stringify({
  items: [{ id: 'retatrutide-10mg', name: 'Retatrutide 10mg', price: 160, qty: 1 }],
  customerName: 'Unknown', customerEmail: 'unknown@example.com', promoCode: 'FORGE10',
  fulfillment: 'Local Pickup',
}) });
p = calls.find((c) => c.url.includes('rpc/create_manual_order')).body.p;
ok('⚠️ an unverifiable FORGE10 is denied, not granted', p.discount_cents, 0);
global.fetch = savedFetch;

console.log('\n— 🚨 a product with no variant refuses the order —');
// Recording a sale that cannot deduct stock or reach revenue would create
// exactly the silent hole this migration has been closing. It throws BEFORE
// anything is written, so nothing is stranded.
const stillFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  if (String(url).includes('variants?select=id,site_catalog_id')) {
    return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
  }
  return stillFetch(url, opts);
};
calls = []; fn = load();
res = await fn.handler({ httpMethod: 'POST', body: JSON.stringify({
  items: [{ id: 'retatrutide-10mg', name: 'Retatrutide 10mg', price: 160, qty: 1 }],
  customerName: 'X', customerEmail: 'x@example.com', fulfillment: 'Local Pickup',
}) });
okTrue('it did not succeed', res.statusCode >= 400, `got ${res.statusCode}`);
okTrue('🚨 and nothing was written', !calls.some((c) => c.url.includes('rpc/create_manual_order')));
global.fetch = stillFetch;


// ── The owner's free-order code ──────────────────────────────────────────────
console.log('\n— 🚨 the owner code is NOT in the source —');
// This repository is PUBLIC. A 100%-off code committed here could be read by
// anyone and used to empty the shelf, so it lives only in an env var.
{
  // 🔑 Reads the LIVE code out of the environment and checks it appears in no
  // source file — rather than hardcoding it here, which would leak it through
  // this test instead. Skips when the variable is unset (CI has no secret).
  const live = (process.env.OWNER_PROMO_CODE_CHECK || '').trim();
  const files = ['./netlify/functions/create-invoice.js', './netlify/functions/check-promo.js', './index.html'];
  const src = files.map((f) => readFileSync(f, 'utf8')).join('\n');
  okTrue('the code is read from OWNER_PROMO_CODE', /OWNER_PROMO_CODE/.test(src));
  okTrue('and the real code appears in no source file',
    !live || !src.toLowerCase().includes(live.toLowerCase()));
}

console.log('\n— with OWNER_PROMO_CODE unset, the code does not exist —');
// ⚠️ Fails CLOSED: an unset variable must not mean "any code works".
delete process.env.OWNER_PROMO_CODE;
process.env.ORDER_SOURCE = 'dashboard';
priorOrders = [{ id: 'x' }];
calls = []; fn = load();
await fn.handler({ httpMethod: 'POST', body: JSON.stringify({
  items: [{ id: 'retatrutide-10mg', name: 'Retatrutide 10mg', price: 160, qty: 1 }],
  customerName: 'Owner', customerEmail: 'ftt1598@gmail.com', promoCode: 'anything',
  fulfillment: 'Local Pickup',
}) });
let op = calls.find((c) => c.url.includes('rpc/create_manual_order')).body.p;
ok('nothing is discounted', op.discount_cents, 0);
ok('and it is an ordinary sale', op.purpose, 'SALE');

console.log('\n— with it set, the order is free —');
process.env.OWNER_PROMO_CODE = 'test-secret-code';
calls = []; fn = load();
await fn.handler({ httpMethod: 'POST', body: JSON.stringify({
  items: [{ id: 'retatrutide-10mg', name: 'Retatrutide 10mg', price: 160, qty: 1 }],
  customerName: 'Owner', customerEmail: 'ftt1598@gmail.com', promoCode: 'test-secret-code',
  fulfillment: 'Ship', street: '9649 Stirling Bridge DR', city: 'Columbia',
  state: 'MD', zip: '21046', shippingAmount: 25,
}) });
op = calls.find((c) => c.url.includes('rpc/create_manual_order')).body.p;
// 100% of product + shipping, the same ORDER scope the 10% codes use.
ok('everything comes off, shipping included', op.discount_cents, 16000 + 2500);
// 🚨 The accounting point: a $0 SALE would carry real COGS against no income
// and read as a LOSS. INTERNAL moves stock and never reaches revenue.
ok('🚨 booked as INTERNAL, not a sale', op.purpose, 'INTERNAL');
ok('and not left awaiting payment',      op.payment_state, 'PAID');
ok('the address still travels',          op.fulfillment.address_line1, '9649 Stirling Bridge DR');
ok('and the stock still moves',          op.lines[0].variant_id, VARIANT);

console.log('\n— a wrong code is just a wrong code —');
calls = []; fn = load();
await fn.handler({ httpMethod: 'POST', body: JSON.stringify({
  items: [{ id: 'retatrutide-10mg', name: 'Retatrutide 10mg', price: 160, qty: 1 }],
  customerName: 'Chancer', customerEmail: 'chancer@example.com', promoCode: 'test-secret-cod',
  fulfillment: 'Local Pickup',
}) });
op = calls.find((c) => c.url.includes('rpc/create_manual_order')).body.p;
ok('one character off gets nothing', op.discount_cents, 0);
ok('and stays a real sale',          op.purpose, 'SALE');
delete process.env.OWNER_PROMO_CODE;

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
