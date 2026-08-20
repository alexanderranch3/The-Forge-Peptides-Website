// Tests set-variant-archived.js and the archive-aware totals in get-stock.js.
// No network: fetch is stubbed. Run with `node test-archive-variants.mjs`.
//
// WHAT THESE ASSERT, and why each one is here:
//  • 🚨 Archiving is a BUYING decision. It must not change units on hand, stock
//    value, or whether the storefront can sell what is left — selling through
//    is the point of archiving rather than deleting.
//  • An archived product leaves the reorder COUNT as well as the reorder list,
//    so the tile cannot disagree with the table beneath it.
//  • Bringing something back clears the reason with it.
//  • Before migration 029 it names the migration instead of leaking Postgres.
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
for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[k];
process.env.ADMIN_TOKEN_SECRET = SECRET;
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

function makeToken(secret) {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
const TOKEN = makeToken(SECRET);
const auth = { authorization: `Bearer ${TOKEN}` };

const setArchived = require('./netlify/functions/set-variant-archived.js');
const getStock    = require('./netlify/functions/get-stock.js');

const RETA12 = '11111111-1111-1111-1111-111111111111';   // retired, OUT, the offender
const PHOENIX = '22222222-2222-2222-2222-222222222222';  // a genuine reorder
const MOTSC  = '33333333-3333-3333-3333-333333333333';   // archived but 20 vials left

// Mirrors the real 2026-08-20 shape of v_inventory_dashboard.
const DASH = [
  { variant_id: RETA12, product_name: 'Retatrutide 12mg', variant_name: 'Regular', is_hidden: true,
    site_catalog_id: null, on_hand: 0, price_cents: 16000, unit_cost_cents: 1500,
    stock_value_cents: 0, stock_retail_cents: 0, units_life: '31', units_90d: '29',
    units_per_month: '9.67', last_sold_at: '2026-07-31T04:00:00Z', months_cover: '0.0',
    margin_pct: '35.8', lines_missing_cost: 0, status: 'OUT', suggested_buy: 20,
    archived_at: null, archived_reason: null },
  { variant_id: PHOENIX, product_name: 'TESAMORELIN / IPAMORELIN "PHOENIX BLEND"', variant_name: null, is_hidden: false,
    site_catalog_id: 'phoenix-blend', on_hand: 0, price_cents: 15500, unit_cost_cents: 9300,
    stock_value_cents: 0, stock_retail_cents: 0, units_life: '21', units_90d: '21',
    units_per_month: '7', last_sold_at: '2026-08-19T04:00:00Z', months_cover: '0.0',
    margin_pct: '38.0', lines_missing_cost: 0, status: 'OUT', suggested_buy: 14,
    archived_at: null, archived_reason: null },
  { variant_id: MOTSC, product_name: 'MOTS-C 10MG', variant_name: null, is_hidden: true,
    site_catalog_id: 'mots-c-10mg', on_hand: 20, price_cents: 7200, unit_cost_cents: 952,
    stock_value_cents: 19040, stock_retail_cents: 144000, units_life: '1', units_90d: '1',
    units_per_month: '0.33', last_sold_at: '2026-07-28T04:00:00Z', months_cover: '60.0',
    margin_pct: '80.0', lines_missing_cost: 0, status: 'SLOW', suggested_buy: 0,
    archived_at: null, archived_reason: null },
];

let routes = {};
let calls = [];
global.fetch = async (url, opts = {}) => {
  calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
  for (const [frag, handler] of Object.entries(routes)) {
    if (String(url).includes(frag)) {
      const r = typeof handler === 'function' ? await handler(String(url), opts) : handler;
      return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body) };
    }
  }
  return { ok: false, status: 404, text: async () => JSON.stringify({ message: 'no route' }) };
};

const dashRoutes = (rows = DASH) => ({
  'v_inventory_dashboard?select=variant_id': (url) => {
    const m = url.match(/variant_id=eq\.([0-9a-f-]+)/i);
    const row = m && rows.find((r) => r.variant_id === m[1]);
    return { status: 200, body: row ? [row] : [] };
  },
  'v_inventory_dashboard?select=*': { status: 200, body: rows },
  'variants?id=eq.': { status: 200, body: null },
});

const archive = (body) => setArchived.handler({ httpMethod: 'POST', headers: auth, body: JSON.stringify(body) });
const stock = () => getStock.handler({ headers: auth });

// ── set-variant-archived ─────────────────────────────────────────────────────
console.log('\n— archiving the product that was topping the reorder list —');
routes = dashRoutes(); calls = [];
let res = await archive({ variant_id: RETA12, archived: true, reason: 'Retired 2026-07-31' });
let body = JSON.parse(res.body);
ok('200', res.statusCode, 200);
ok('archived', body.archived, true);
ok('named',    body.product, 'Retatrutide 12mg');
ok('reason kept', body.reason, 'Retired 2026-07-31');

const patch = calls.find((c) => c.method === 'PATCH').body;
okTrue('a timestamp was written, not a boolean', typeof patch.archived_at === 'string');
// 🚨 The single most important assertion in this file: archiving writes to the
// variant and NOTHING else. No ledger row, no stock adjustment, no catalog edit.
okTrue('nothing but the variant is touched',
  Object.keys(patch).every((k) => ['archived_at', 'archived_reason', 'updated_at'].includes(k)));
okTrue('and only one write happened', calls.filter((c) => c.method === 'PATCH').length === 1);
okTrue('nothing went near the stock ledger', !calls.some((c) => /stock_ledger|adjust/.test(c.url)));
okTrue('nor the unfulfillable list',         !calls.some((c) => /unfulfillable/.test(c.url)));

console.log('\n— 🚨 the response says what is NOT changing —');
// "Archive" reads like "delete". The vials are the thing worth being sure about,
// so the endpoint reports them back and the toast repeats them.
routes = dashRoutes(); calls = [];
res = await archive({ variant_id: MOTSC, archived: true, reason: 'Distributor dropped it' });
body = JSON.parse(res.body);
ok('the stock is reported back', body.on_hand, 20);
ok('and so is its value',        body.stock_value_cents, 19040);

console.log('\n— bringing one back —');
routes = dashRoutes(); calls = [];
res = await archive({ variant_id: RETA12, archived: false });
body = JSON.parse(res.body);
ok('un-archived', body.archived, false);
const back = calls.find((c) => c.method === 'PATCH').body;
ok('the timestamp is cleared', back.archived_at, null);
// A note explaining why we stopped buying something we are buying again is
// just confusing.
ok('and the reason goes with it', back.archived_reason, null);

routes = dashRoutes(); calls = [];
res = await archive({ variant_id: RETA12, archived: false, reason: 'ignore me' });
ok('a reason sent with an un-archive is dropped',
  calls.find((c) => c.method === 'PATCH').body.archived_reason, null);

console.log('\n— refusals —');
routes = dashRoutes();
ok('no token', (await setArchived.handler({ httpMethod: 'POST', headers: {}, body: '{}' })).statusCode, 401);
ok('GET',      (await setArchived.handler({ httpMethod: 'GET', headers: auth })).statusCode, 405);
ok('junk id',  (await archive({ variant_id: 'nope', archived: true })).statusCode, 400);
ok('no decision', (await archive({ variant_id: RETA12 })).statusCode, 400);
ok('unknown product', (await archive({ variant_id: '99999999-9999-9999-9999-999999999999', archived: true })).statusCode, 404);

routes = dashRoutes();
res = await archive({ variant_id: RETA12, archived: true, reason: 'x'.repeat(500) });
ok('an overlong reason is trimmed, not rejected', JSON.parse(res.body).reason.length, 300);

console.log('\n— before migration 029, it names the migration —');
routes = dashRoutes();
routes['v_inventory_dashboard?select=variant_id'] = { status: 400, body: { message: 'column v_inventory_dashboard.archived_at does not exist' } };
res = await archive({ variant_id: RETA12, archived: true });
ok('503, not raw Postgres', res.statusCode, 503);
okTrue('and it names the file', /029/.test(JSON.parse(res.body).hint || ''));

// ── get-stock totals ─────────────────────────────────────────────────────────
console.log('\n— 🚨 the reorder COUNT drops, the stock totals do not —');
const archivedDash = DASH.map((r) => r.variant_id === RETA12
  ? { ...r, archived_at: '2026-08-20T14:00:00Z', archived_reason: 'Retired 2026-07-31', suggested_buy: 0 }
  : r);

routes = dashRoutes(); calls = [];
let plain = JSON.parse((await stock()).body);
routes = dashRoutes(archivedDash); calls = [];
let archivedRes = JSON.parse((await stock()).body);

ok('two products needed reordering', plain.totals.needs_reorder, 2);
ok('one after archiving',            archivedRes.totals.needs_reorder, 1);
// 🚨 The vials are still on the shelf. A stock total that quietly omitted them
// would not reconcile against a physical count — the one number that beats
// every inference drawn from the ledger.
ok('units on hand unchanged',  archivedRes.totals.units, plain.totals.units);
ok('stock value unchanged',    archivedRes.totals.cost_cents, plain.totals.cost_cents);
ok('retail value unchanged',   archivedRes.totals.retail_cents, plain.totals.retail_cents);
ok('every product still listed', archivedRes.items.length, plain.items.length);

console.log('\n— what is being wound down is counted separately —');
ok('no tile before anything is archived', plain.totals.archived_products, 0);
ok('one product after',                   archivedRes.totals.archived_products, 1);
ok('carrying its stock value',            archivedRes.totals.archived_cents, 0);   // Reta12 holds nothing

const withStock = DASH.map((r) => r.variant_id === MOTSC
  ? { ...r, archived_at: '2026-08-20T14:00:00Z', archived_reason: 'Distributor dropped it' } : r);
routes = dashRoutes(withStock);
const motsRes = JSON.parse((await stock()).body);
ok('archived stock shows its capital', motsRes.totals.archived_cents, 19040);
ok('and stays in the overall total',   motsRes.totals.cost_cents, plain.totals.cost_cents);

console.log('\n— the flag survives the round trip to the page —');
const row = archivedRes.items.find((i) => i.variant_id === RETA12);
ok('archived_at is carried',   row.archived_at, '2026-08-20T14:00:00Z');
ok('and the reason',           row.archived_reason, 'Retired 2026-07-31');
ok('suggested_buy is zeroed by the view', row.suggested_buy, 0);
// ⚠️ The status is deliberately NOT overwritten: an archived product that is
// OUT is still out, and that matters when deciding whether to chase the last few.
ok('the status is left alone', row.status, 'OUT');

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
