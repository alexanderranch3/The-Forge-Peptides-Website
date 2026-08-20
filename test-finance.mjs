// Tests _finance.js and get-finance.js — the Finance tab's arithmetic.
// No network: fetch is stubbed. Run with `node test-finance.mjs`.
//
// WHAT THESE ASSERT, and why each one is here:
//  • The revenue → cash bridge closes. FP-001159 is the real order that makes
//    this non-trivial: $160.00 of lines on a $144.00 order, because its
//    discount was never pushed down to the lines. A page that reported one
//    number as "revenue" would be wrong about the other.
//  • A house-account charge is a tender but is NOT money in hand.
//  • A line with no recorded cost blanks the margin instead of overstating it.
//  • An untendered order is reported, not silently dropped — v_product_sales
//    excludes it, and that exclusion is exactly how a paid order once went
//    missing from revenue (migration 026).
//  • get-finance pages past 1000 rows rather than reporting a short read.
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

const F = require('./netlify/functions/_finance.js');

// ── Dates ────────────────────────────────────────────────────────────────────
console.log('\n— local dates, because a 9pm counter sale is that day\'s sale —');
// 2026-08-21T01:30Z is 9:30pm on the 20th in New York. Bucketing the raw UTC
// timestamp would file it under the wrong day, and at a month end, wrong month.
ok('9:30pm EDT stays on its own day', F.nyDate('2026-08-21T01:30:00Z'), '2026-08-20');
ok('midnight EDT boundary',           F.nyDate('2026-09-01T03:59:00Z'), '2026-08-31');
ok('null in, null out',               F.nyDate(null), null);
ok('unparseable in, null out',        F.nyDate('not a date'), null);

console.log('\n— date arithmetic crosses a daylight-saving boundary —');
// 2026-11-01 is the US fall-back. Adding days as UTC midnights is immune to it;
// adding 24h to a local moment is not.
ok('back over the DST change', F.shiftDays('2026-11-02', -3), '2026-10-30');
ok('across a year',            F.shiftDays('2026-01-01', -1), '2025-12-31');
ok('span is inclusive-safe',   F.daysBetween('2026-08-01', '2026-08-31'), 30);

console.log('\n— periods carry the window immediately before them —');
const NOW = new Date('2026-08-20T16:00:00Z');
const p30 = F.resolvePeriod('30', NOW);
ok('30 days ends today',    p30.to, '2026-08-20');
ok('30 days starts',        p30.from, '2026-07-22');
ok('previous is equal',     p30.previous, { from: '2026-06-22', to: '2026-07-21', days: 30 });
ok('ytd starts in January', F.resolvePeriod('ytd', NOW).from, '2026-01-01');
ok('all time is unbounded', F.resolvePeriod('all', NOW).from, null);
ok('a junk period is all time, not a crash', F.resolvePeriod('../etc/passwd', NOW).period, 'all');

console.log('\n— growth from nothing is not infinity —');
ok('no baseline', F.change(500, 0), null);
ok('halved',      F.change(500, 1000), -50);
ok('doubled',     F.change(2000, 1000), 100);

// ── Fixture ──────────────────────────────────────────────────────────────────
// Two orders in August, one in July, plus a voided one and one awaiting
// payment. Amounts chosen so every total below is checkable by hand.
const V1 = 'v-reta-10', V2 = 'v-bpc-10';
const P1 = 'p-reta', P2 = 'p-bpc';

const variants = [
  { id: V1, name: '10mg', product_id: P1 },
  { id: V2, name: '10mg', product_id: P2 },
];
const products = [
  { id: P1, name: 'Retatrutide' },
  { id: P2, name: 'BPC-157' },
];

const sales = [
  // July — the "previous period" for a 30-day window ending 2026-08-20.
  { order_id: 'o-jul', order_no: 'FP-000900', placed_at: '2026-07-10T14:00:00Z', channel: 'WEBSITE',
    variant_id: V1, name_at_sale: 'Retatrutide 10mg', quantity: '2',
    revenue_cents: '32000', gross_collected_cents: '32000', sales_tax_cents: '0',
    cogs_cents: '3300', profit_cents: '28700' },

  // August — FP-001159 is the real shape: $160 of lines on a $144 order.
  { order_id: 'o-yader', order_no: 'FP-001159', placed_at: '2026-08-20T04:00:00Z', channel: 'MANUAL',
    variant_id: V1, name_at_sale: 'Retatrutide 10mg', quantity: '1',
    revenue_cents: '16000', gross_collected_cents: '16000', sales_tax_cents: '0',
    cogs_cents: '1650', profit_cents: '14350' },

  // A house-account charge: revenue when charged, but not cash.
  { order_id: 'o-house', order_no: 'FP-001100', placed_at: '2026-08-05T15:00:00Z', channel: 'POS',
    variant_id: V2, name_at_sale: 'BPC-157 10mg', quantity: '1',
    revenue_cents: '10000', gross_collected_cents: '10800', sales_tax_cents: '800',
    cogs_cents: '2000', profit_cents: '8000' },
];

const orders = [
  { id: 'o-jul',   order_no: 'FP-000900', placed_at: '2026-07-10T14:00:00Z', state: 'COMPLETED', purpose: 'SALE', payment_state: 'PAID', total_cents: '32000' },
  { id: 'o-yader', order_no: 'FP-001159', placed_at: '2026-08-20T04:00:00Z', state: 'COMPLETED', purpose: 'SALE', payment_state: 'PAID', total_cents: '14400' },
  { id: 'o-house', order_no: 'FP-001100', placed_at: '2026-08-05T15:00:00Z', state: 'COMPLETED', purpose: 'SALE', payment_state: 'PAID', total_cents: '10800' },
  { id: 'o-wait',  order_no: 'FP-001004', placed_at: '2026-08-12T15:00:00Z', state: 'OPEN',      purpose: 'SALE', payment_state: 'AWAITING_PAYMENT', total_cents: '25900' },
  { id: 'o-void',  order_no: 'FP-000777', placed_at: '2026-08-02T15:00:00Z', state: 'CANCELED',  purpose: 'SALE', payment_state: 'VOID', total_cents: '9900' },
  { id: 'o-int',   order_no: 'FP-000001', placed_at: '2026-08-03T15:00:00Z', state: 'COMPLETED', purpose: 'INTERNAL', payment_state: 'PAID', total_cents: '5000' },
];

const tenders = [
  { order_id: 'o-jul',   type: 'ZELLE',         amount_cents: '32000', received_at: '2026-07-10T14:05:00Z' },
  { order_id: 'o-yader', type: 'BANK_TRANSFER', amount_cents: '14400', received_at: '2026-08-20T04:05:00Z' },
  { order_id: 'o-house', type: 'HOUSE_ACCOUNT', amount_cents: '10800', received_at: '2026-08-05T15:05:00Z' },
  // 🚨 A tender on a CANCELED order. v_tender_summary counts this; the tab
  // must not — it is the live bug that view has today.
  { order_id: 'o-void',  type: 'CASH',          amount_cents: '9900',  received_at: '2026-08-02T15:05:00Z' },
];

const house = [
  { party_id: 'pa-1', display_name: 'Leo the Den', charged_cents: '38500', paid_cents: '0',
    balance_cents: '38500', payment_count: 0, last_charge_at: '2026-08-05T15:05:00Z' },
  { party_id: 'pa-2', display_name: 'Settled Sam', charged_cents: '10000', paid_cents: '10000',
    balance_cents: '0', payment_count: 1, last_charge_at: '2026-06-05T15:05:00Z' },
];

const bundle = { sales, orders, tenders, variants, products, house };
const all = F.summarise(bundle, { period: 'all', now: NOW });

console.log('\n— headline totals are the view\'s figures, added up —');
ok('revenue', all.totals.revenue_cents, 32000 + 16000 + 10000);
ok('COGS',    all.totals.cogs_cents,    3300 + 1650 + 2000);
ok('profit',  all.totals.profit_cents,  28700 + 14350 + 8000);
ok('tax kept out of revenue', all.totals.tax_cents, 800);
ok('orders',  all.totals.orders, 3);
ok('units',   all.totals.units, 4);
ok('margin',  all.totals.margin_pct, Math.round((1000 * 51050) / 58000) / 10);
ok('average order is revenue-based', all.totals.avg_order_cents, Math.round(58000 / 3));

console.log('\n— 🚨 the revenue → cash bridge closes to the cent —');
const c = all.cash;
ok('three tendered orders',   c.tendered_orders, 3);
ok('what the orders totalled', c.order_total_cents, 32000 + 14400 + 10800);
// revenue 58000 + tax 800 = 58800, against orders of 57200: the missing $16.00
// is FP-001159's order-level discount, which never reached its lines.
ok('the bridge names the gap', c.other_lines_cents, 57200 - 58000 - 800);
ok('bridge closes', all.totals.revenue_cents + all.totals.tax_cents + c.other_lines_cents, c.order_total_cents);
ok('tenders equal order totals', c.unreconciled_cents, 0);

console.log('\n— 🚨 a house-account charge is a tender, not money in hand —');
ok('charged on account', c.house_charged_cents, 10800);
ok('actually collected', c.settled_cents, 32000 + 14400);
ok('settled + house = every tender', c.settled_cents + c.house_charged_cents, c.tender_total_cents);

console.log('\n— 🚨 a tender on a voided order is not takings —');
okTrue('no CASH row: its only tender was on the voided order',
  !c.tenders.some((t) => t.type === 'CASH'));
ok('the void is reported, not hidden', c.voided, { orders: 1, amount_cents: 9900 });

console.log('\n— 🚨 an untendered order is stated, never just absent —');
ok('awaiting payment', c.awaiting.orders, 1);
ok('awaiting amount',  c.awaiting.amount_cents, 25900);
ok('and it is named',  c.awaiting.order_nos, ['FP-001004']);

console.log('\n— an INTERNAL order is not a sale —');
okTrue('internal order ignored entirely',
  !c.awaiting.order_nos.includes('FP-000001') && c.order_total_cents === 57200);

console.log('\n— products carry their real names, biggest profit first —');
ok('two products', all.products.length, 2);
ok('leader',       all.products[0].product, 'Retatrutide');
ok('its profit',   all.products[0].profit_cents, 28700 + 14350);
ok('variant named', all.products[0].variant, '10mg');
ok('runner-up',    all.products[1].product, 'BPC-157');

console.log('\n— an unknown variant keeps its money instead of vanishing —');
const orphan = F.summarise({ ...bundle, variants: [], products: [] }, { period: 'all', now: NOW });
ok('still three lines of money', orphan.totals.revenue_cents, 58000);
ok('and still listed',           orphan.products.length, 2);
ok('with an honest blank name',  orphan.products[0].product, null);

console.log('\n— months are the whole story, whatever the window says —');
const m30 = F.summarise(bundle, { period: '30', now: NOW });
ok('July survives a 30-day view', m30.months.map((m) => m.month), ['2026-07', '2026-08']);
ok('July\'s revenue',    m30.months.find((m) => m.month === '2026-07').revenue_cents, 32000);
// 🚨 The current month is 20 days of 31. A short final bar read as a downturn
// is the likeliest misreading of this chart, so the month says it is unfinished.
ok('the running month is flagged partial', m30.months.find((m) => m.month === '2026-08').partial, true);
ok('a finished month is not',              m30.months.find((m) => m.month === '2026-07').partial, false);

console.log('\n— the comparison answers "are sales moving" —');
// Given a trading history that already covers the baseline window, the
// comparison is a real one and gets reported as a direction.
const hist = {
  ...bundle,
  sales: [{ order_id: 'o-jun', order_no: 'FP-000800', placed_at: '2026-06-01T14:00:00Z', channel: 'WEBSITE',
    variant_id: V1, name_at_sale: 'Retatrutide 10mg', quantity: '1',
    revenue_cents: '5000', gross_collected_cents: '5000', sales_tax_cents: '0',
    cogs_cents: '1650', profit_cents: '3350' }, ...sales],
  orders: [{ id: 'o-jun', order_no: 'FP-000800', placed_at: '2026-06-01T14:00:00Z', state: 'COMPLETED',
    purpose: 'SALE', payment_state: 'PAID', total_cents: '5000' }, ...orders],
  tenders: [{ order_id: 'o-jun', type: 'ZELLE', amount_cents: '5000', received_at: '2026-06-01T14:05:00Z' }, ...tenders],
};
const h30 = F.summarise(hist, { period: '30', now: NOW });
ok('scoped revenue is August only', h30.totals.revenue_cents, 26000);
ok('previous window is July',       h30.comparison.revenue_cents, 32000);
ok('and the direction is down',     h30.comparison.revenue_change_pct, Math.round((1000 * (26000 - 32000)) / 32000) / 10);
ok('all-time has nothing to compare against', all.comparison, null);
ok('a real baseline is not flagged', h30.comparison.partial_baseline, false);

console.log('\n— 🚨 growth measured against a period the business predates —');
// The live bug this catches: the 90-day view reported "+850% revenue, +1150%
// orders" because its baseline window reached back to February and the first
// sale was in May. Arithmetically true, and meaningless.
const wide = F.summarise(bundle, { period: '365', now: NOW });
ok('the baseline is flagged',   wide.comparison.partial_baseline, true);
ok('and it names the first sale', wide.comparison.first_sale, '2026-07-10');
ok('revenue growth is withheld', wide.comparison.revenue_change_pct, null);
ok('profit growth too',          wide.comparison.profit_change_pct, null);
ok('orders growth too',          wide.comparison.orders_change_pct, null);
// The period's own figures are untouched — only the comparison is withheld.
ok('the window itself still reports', wide.totals.revenue_cents, 58000);

console.log('\n— 🚨 a missing cost blanks the margin, never overstates profit —');
const noCost = F.summarise({
  ...bundle,
  sales: [...sales, {
    order_id: 'o-nocost', order_no: 'FP-001200', placed_at: '2026-08-18T15:00:00Z', channel: 'MANUAL',
    variant_id: V2, name_at_sale: 'BPC-157 10mg', quantity: '1',
    revenue_cents: '10000', gross_collected_cents: '10000', sales_tax_cents: '0',
    cogs_cents: null, profit_cents: null,
  }],
}, { period: 'all', now: NOW });
ok('revenue includes it', noCost.totals.revenue_cents, 68000);
ok('profit does not',     noCost.totals.profit_cents, 51050);
ok('margin refuses to answer', noCost.totals.margin_pct, null);
ok('and says how many lines', noCost.totals.lines_missing_cost, 1);
ok('the affected product is flagged too',
  noCost.products.find((p) => p.product === 'BPC-157').margin_pct, null);

console.log('\n— house accounts: what is owed, and whether anyone has paid —');
ok('owed',            all.house_accounts.owed_cents, 38500);
ok('one person',      all.house_accounts.people, 1);
ok('settled tabs drop off', all.house_accounts.rows.map((r) => r.name), ['Leo the Den']);
ok('payments recorded is visible', all.house_accounts.payments_recorded, 0);

console.log('\n— an empty business does not divide by zero —');
const empty = F.summarise({ sales: [], orders: [], tenders: [], variants: [], products: [], house: [] }, { period: '30', now: NOW });
ok('no revenue',   empty.totals.revenue_cents, 0);
ok('no margin',    empty.totals.margin_pct, null);
ok('no average',   empty.totals.avg_order_cents, 0);
ok('bridge is 0',  empty.cash.other_lines_cents, 0);
ok('nothing unreconciled', empty.cash.unreconciled_cents, 0);
ok('no comparison to draw', empty.comparison.revenue_change_pct, null);

// ── The handler ──────────────────────────────────────────────────────────────
console.log('\n— get-finance.js —');

const SECRET = 'test-secret';
for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[k];
process.env.ADMIN_TOKEN_SECRET = SECRET;
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

// Mirrors netlify/functions/_auth-token.js — `exp` is in SECONDS there.
function makeToken(secret, { expiresInSec = 3600 } = {}) {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expiresInSec })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
const TOKEN = makeToken(SECRET);
const getFinance = require('./netlify/functions/get-finance.js');

let routes = {};
let calls = [];
global.fetch = async (url) => {
  calls.push(url);
  for (const [frag, handler] of Object.entries(routes)) {
    if (url.includes(frag)) {
      const r = typeof handler === 'function' ? await handler(url) : handler;
      return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body) };
    }
  }
  return { ok: false, status: 404, text: async () => JSON.stringify({ message: 'no route' }) };
};

function defaultRoutes() {
  return {
    'v_product_sales': { status: 200, body: sales },
    'orders?select':   { status: 200, body: orders },
    'tenders?select':  { status: 200, body: tenders },
    'variants?select': { status: 200, body: variants },
    'products?select': { status: 200, body: products },
    'v_house_account_balance': { status: 200, body: house },
  };
}

const call = (qs = null, token = TOKEN) => getFinance.handler({
  headers: token ? { authorization: `Bearer ${token}` } : {},
  queryStringParameters: qs,
});

routes = defaultRoutes(); calls = [];
let res = await call();
let body = JSON.parse(res.body);
ok('200 with a token', res.statusCode, 200);
ok('revenue survives the round trip', body.totals.revenue_cents, 58000);
ok('period defaults to all time', body.window.period, 'all');
okTrue('offers the period choices', body.periods.some((p) => p.key === '90'));
okTrue('never cached', res.headers['Cache-Control'] === 'no-store');

routes = defaultRoutes();
res = await call(null, null);
ok('401 without a token', res.statusCode, 401);
okTrue('and says nothing about the business', !JSON.parse(res.body).totals);

routes = defaultRoutes();
res = await call({ period: '30' });
ok('a period narrows the window', JSON.parse(res.body).totals.revenue_cents, 26000);

routes = defaultRoutes();
res = await call({ period: 'DROP TABLE orders' });
ok('an unknown period falls back rather than reaching the database',
  JSON.parse(res.body).window.period, 'all');

console.log('\n— 🚨 a short read is never reported as the answer —');
// 1000 rows is PostgREST's cap. If paging were missing, every total on the
// page would simply be too small and nothing on screen would look wrong.
const many = Array.from({ length: 1500 }, (_, i) => ({
  order_id: `o${i}`, order_no: `FP-${i}`, placed_at: '2026-08-10T15:00:00Z', channel: 'WEBSITE',
  variant_id: V1, name_at_sale: 'Retatrutide 10mg', quantity: '1',
  revenue_cents: '100', gross_collected_cents: '100', sales_tax_cents: '0',
  cogs_cents: '10', profit_cents: '90',
}));
routes = defaultRoutes();
routes['v_product_sales'] = (url) => {
  const offset = Number(new URL(url).searchParams.get('offset') || 0);
  return { status: 200, body: many.slice(offset, offset + 1000) };
};
res = await call();
ok('all 1500 rows counted', JSON.parse(res.body).totals.revenue_cents, 150000);

routes = defaultRoutes();
routes['v_product_sales'] = { status: 404, body: { message: 'not found' } };
res = await call();
ok('a missing view is an error, not a zero', res.statusCode, 502);
okTrue('and it names what is missing', /v_product_sales/.test(JSON.parse(res.body).error));

// The module reads its environment once, at require time — so this has to be a
// fresh require, not just a deleted variable. Worth covering: an unconfigured
// site must say so, never render a dashboard of zeroes that looks like a
// business with no sales.
delete require.cache[require.resolve('./netlify/functions/get-finance.js')];
delete process.env.SUPABASE_URL;
const unconfigured = require('./netlify/functions/get-finance.js');
process.env.SUPABASE_URL = 'https://example.supabase.co';
routes = defaultRoutes();
res = await unconfigured.handler({ headers: { authorization: `Bearer ${TOKEN}` }, queryStringParameters: null });
ok('unconfigured Supabase is an error, not an empty page', res.statusCode, 500);
okTrue('and it says where to set it', /Environment variables/.test(JSON.parse(res.body).detail));

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
