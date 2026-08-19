// Tests for get-purchasing.js and save-purchase-order.js.
// No network: fetch is stubbed. Run with `node test-purchasing.mjs`.
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

// ── Environment ──────────────────────────────────────────────────────────────
const SECRET = 'test-secret';
for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[k];
process.env.ADMIN_TOKEN_SECRET = SECRET;
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

// Mirrors netlify/functions/_auth-token.js — note `exp` is in SECONDS there.
function makeToken(secret, { expiresInSec = 3600 } = {}) {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expiresInSec })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
const TOKEN = makeToken(SECRET);
const auth = (t = TOKEN) => ({ authorization: `Bearer ${t}` });

const getPurchasing = require('./netlify/functions/get-purchasing.js');
const savePO        = require('./netlify/functions/save-purchase-order.js');

// ── fetch stub ───────────────────────────────────────────────────────────────
let routes = {};
let calls  = [];
global.fetch = async (url, opts = {}) => {
  calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
  for (const [frag, handler] of Object.entries(routes)) {
    if (url.includes(frag)) {
      const r = typeof handler === 'function' ? await handler(opts) : handler;
      return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body) };
    }
  }
  return { ok: false, status: 404, text: async () => JSON.stringify({ message: 'no route' }) };
};

const VENDOR = '11111111-1111-1111-1111-111111111111';
const PO     = '22222222-2222-2222-2222-222222222222';
const VARIANT= '33333333-3333-3333-3333-333333333333';

function defaultRoutes() {
  return {
    'vendors?select': { status: 200, body: [{ id: VENDOR, name: 'Direct Peptides', default_pack_size: 10 }] },
    'v_purchase_orders': { status: 200, body: [{
      id: PO, vendor_id: VENDOR, vendor_name: 'Direct Peptides', reference: '2675', state: 'ORDERED',
      ordered_on: '2026-07-23', received_on: null, shipping_cents: 1800, other_fees_cents: 1450,
      other_fees_note: 'labels', tax_cents: 0, allocation: 'PER_UNIT', payment_method: 'Zelle', notes: null,
      goods_cents: '84500', invoice_total_cents: '87750', units_received: '50', line_count: '4', lines_unmatched: '4',
    }] },
    'v_purchase_order_lines': { status: 200, body: [{
      line_id: 'l1', purchase_order_id: PO, variant_id: null, supplier_sku: 'DP3-R 10MG',
      description: 'DP3-R (10mg)', quantity: 20, free_quantity: 0, units_received: '20',
      unit_cost_cents: 1350, goods_cents: '27000', allocated_fees_cents: '1300',
      landed_unit_cost_cents: 1415, notes: null,
    }] },
    'v_inventory_dashboard': { status: 200, body: [{
      variant_id: VARIANT, product_name: 'Retatrutide 10mg', variant_name: '10mg',
      price_cents: 16000, unit_cost_cents: 1648, on_hand: 0,
    }] },
    'v_unmatched_sold_lines': { status: 200, body: [{
      name_at_sale: 'Phoenix Blend', lines: '5', units: '5.000', revenue_cents: '75000',
      first_sold: '2026-06-01', last_sold: '2026-07-14', suggested_variant_id: VARIANT,
    }] },
    'variant_aliases': { status: 200, body: [{ id: 'a1', alias: 'KLOW Blend', variant_id: VARIANT }] },
    'label_providers': { status: 200, body: [
      { id: 'lp1', name: 'Re-Up Supply', cost_per_unit_cents: 29, is_active: true, notes: 'Invoice #39444' },
      { id: 'lp2', name: 'Old Printer', cost_per_unit_cents: 150, is_active: false, notes: null },
    ] },
    'v_label_impact': { status: 200, body: [{
      active_rate_cents: 29, active_provider: 'Re-Up Supply',
      vials_on_hand: '99', label_cost_on_hand_cents: '2871',
    }] },
  };
}

const run = (fn, event) => fn.handler({ headers: {}, httpMethod: 'GET', ...event });
const body = (res) => JSON.parse(res.body);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n1. get-purchasing — auth gate');
routes = defaultRoutes();
ok('401 without a token', (await run(getPurchasing, {})).statusCode, 401);
ok('401 with a forged token', (await run(getPurchasing, { headers: auth('nonsense.sig') })).statusCode, 401);
ok('401 with a token signed by the wrong secret',
  (await run(getPurchasing, { headers: auth(makeToken('other-secret')) })).statusCode, 401);
ok('401 with an expired token',
  (await run(getPurchasing, { headers: auth(makeToken(SECRET, { expiresInSec: -60 })) })).statusCode, 401);
ok('200 with a valid token', (await run(getPurchasing, { headers: auth() })).statusCode, 200);

console.log('\n2. get-purchasing — payload');
{
  const d = body(await run(getPurchasing, { headers: auth() }));
  ok('vendors returned', d.vendors.length, 1);
  ok('pack size preserved for the 10x guard', d.vendors[0].default_pack_size, 10);
  ok('numeric strings coerced to numbers', d.orders[0].goods_cents, 84500);
  ok('units coerced', d.orders[0].units_received, 50);
  ok('landed cost passed through untouched', d.lines[0].landed_unit_cost_cents, 1415);
  ok('products shaped for the picker', d.products[0].product, 'Retatrutide 10mg');
  ok('open order counted', d.totals.open_orders, 1);
  ok('open value uses the invoice total', d.totals.open_value_cents, 87750);
  ok('unmatched lines surfaced', d.totals.orders_with_unmatched_lines, 1);
  ok('received count', d.totals.received_orders, 0);
}

console.log('\n3. get-purchasing — failure modes');
{
  // The module reads its config once, at load. So the unconfigured case has to
  // be exercised on a freshly-required copy with the variable genuinely absent
  // — deleting it after the fact would prove nothing.
  const saved = process.env.SUPABASE_URL;
  delete process.env.SUPABASE_URL;
  delete require.cache[require.resolve('./netlify/functions/get-purchasing.js')];
  const unconfigured = require('./netlify/functions/get-purchasing.js');
  const res = await unconfigured.handler({ headers: auth(), httpMethod: 'GET' });
  ok('500 when Supabase is unconfigured', res.statusCode, 500);
  okTrue('names the two variables to set', /SUPABASE_URL and SUPABASE_SERVICE_KEY/.test(body(res).detail));
  process.env.SUPABASE_URL = saved;
  delete require.cache[require.resolve('./netlify/functions/get-purchasing.js')];

  routes = { ...defaultRoutes(), 'v_purchase_orders': { status: 404, body: { message: 'not found' } } };
  const missing = await run(getPurchasing, { headers: auth() });
  ok('502 when the purchasing tables are missing', missing.statusCode, 502);
  okTrue('tells you which migration to run', /003-purchasing\.sql/.test(body(missing).error));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n4. save-purchase-order — auth and method');
routes = defaultRoutes();
const post = (b, headers = auth()) => run(savePO, { httpMethod: 'POST', headers, body: JSON.stringify(b) });
ok('405 on GET', (await run(savePO, { httpMethod: 'GET', headers: auth() })).statusCode, 405);
ok('401 without a token', (await post({}, {})).statusCode, 401);

console.log('\n5. save-purchase-order — validation happens server-side');
routes['rpc/save_purchase_order'] = { status: 200, body: PO };
const goodLine = { description: 'DP3-R (10mg)', quantity: 20, unit_cost_cents: 1350 };
const base = { action: 'save', vendor_id: VENDOR, lines: [goodLine] };

ok('rejects a missing vendor', (await post({ action: 'save', lines: [goodLine] })).statusCode, 400);
ok('rejects a non-uuid vendor', (await post({ ...base, vendor_id: 'nope' })).statusCode, 400);
ok('rejects a fractional cent', (await post({ ...base, shipping_cents: 12.5 })).statusCode, 400);
ok('rejects negative shipping', (await post({ ...base, shipping_cents: -1 })).statusCode, 400);
ok('rejects a dollar-string amount', (await post({ ...base, shipping_cents: '18.00' })).statusCode, 400);
ok('rejects quantity 0', (await post({ ...base, lines: [{ ...goodLine, quantity: 0 }] })).statusCode, 400);
ok('rejects a fractional quantity', (await post({ ...base, lines: [{ ...goodLine, quantity: 1.5 }] })).statusCode, 400);
ok('rejects negative free quantity', (await post({ ...base, lines: [{ ...goodLine, free_quantity: -1 }] })).statusCode, 400);
ok('rejects a blank description', (await post({ ...base, lines: [{ ...goodLine, description: '   ' }] })).statusCode, 400);
ok('rejects a bad date', (await post({ ...base, ordered_on: '07/23/2026' })).statusCode, 400);
ok('rejects an unknown state', (await post({ ...base, state: 'SHIPPED' })).statusCode, 400);
ok('rejects state=RECEIVED — receiving is its own action',
  (await post({ ...base, state: 'RECEIVED' })).statusCode, 400);
okTrue('and says why', /Receive/.test(body(await post({ ...base, state: 'RECEIVED' })).error));
ok('rejects an absurd number of lines',
  (await post({ ...base, lines: Array(201).fill(goodLine) })).statusCode, 400);
ok('accepts a valid order', (await post(base)).statusCode, 200);

console.log('\n6. save-purchase-order — what reaches the database');
{
  calls = [];
  await post({ ...base, shipping_cents: 1800, other_fees_cents: 1450, allocation: 'BY_VALUE',
               reference: '  2675  ', ordered_on: '2026-07-23' });
  const rpcCall = calls.find(c => c.url.includes('rpc/save_purchase_order'));
  okTrue('sent as a single atomic RPC, not multiple table writes',
    calls.filter(c => c.method === 'POST').length === 1);
  ok('reference trimmed', rpcCall.body.p.reference, '2675');
  ok('money forwarded as integer cents', rpcCall.body.p.shipping_cents, 1800);
  ok('allocation forwarded', rpcCall.body.p.allocation, 'BY_VALUE');
  ok('line kept in cents', rpcCall.body.p.lines[0].unit_cost_cents, 1350);
  ok('free_quantity defaulted, not dropped', rpcCall.body.p.lines[0].free_quantity, 0);
}

console.log('\n7. save-purchase-order — receive');
routes['rpc/receive_purchase_order'] = { status: 200, body: [{ lines: 4, units: 50 }] };
{
  const res = await post({ action: 'receive', id: PO, received_on: '2026-07-23' });
  ok('200 on receive', res.statusCode, 200);
  ok('reports what was posted', body(res).received, { lines: 4, units: 50 });
  ok('rejects receive without an id', (await post({ action: 'receive' })).statusCode, 400);
  ok('rejects a bad received date', (await post({ action: 'receive', id: PO, received_on: 'today' })).statusCode, 400);
}

console.log('\n8. database refusals are surfaced verbatim, not swallowed');
{
  routes['rpc/receive_purchase_order'] = { status: 400, body: {
    message: 'purchase order is already received — receiving twice would double the stock. Post a correcting adjustment instead.' } };
  const res = await post({ action: 'receive', id: PO });
  ok('400 passed through', res.statusCode, 400);
  okTrue('the reason reaches the user', /already received/.test(body(res).error));
  okTrue('and so does the remedy', /correcting adjustment/.test(body(res).error));

  routes['rpc/save_purchase_order'] = { status: 400, body: {
    message: 'every line must be matched to a product before receiving' } };
  okTrue('save refusals too', /must be matched/.test(body(await post(base)).error));
}

console.log('\n9. vendors');
{
  routes = defaultRoutes();
  routes['vendors'] = (opts) => opts.method === 'POST' || opts.method === 'PATCH'
    ? { status: 200, body: [{ id: VENDOR, name: 'New Supplier', default_pack_size: 10 }] }
    : { status: 200, body: [] };
  ok('adds a supplier', (await post({ action: 'save-vendor', name: 'New Supplier', default_pack_size: 10 })).statusCode, 200);
  ok('rejects a blank name', (await post({ action: 'save-vendor', name: '  ' })).statusCode, 400);
  ok('rejects pack size 0', (await post({ action: 'save-vendor', name: 'X', default_pack_size: 0 })).statusCode, 400);

  routes['vendors'] = { status: 409, body: { code: '23505', message: 'duplicate key value violates unique constraint "vendors_name_key"' } };
  const dup = await post({ action: 'save-vendor', name: 'Direct Peptides' });
  okTrue('a duplicate name reads like English', /already exists/.test(body(dup).error));
}

console.log('\n10. click-to-map for unmatched sold lines');
{
  routes = defaultRoutes();
  const d = body(await run(getPurchasing, { headers: auth() }));
  ok('unmatched names returned', d.unmatched.length, 1);
  ok('counts coerced from strings', d.unmatched[0].lines, 5);
  ok('units coerced', d.unmatched[0].units, 5);
  ok('revenue coerced', d.unmatched[0].revenue_cents, 75000);
  ok('a suggestion is offered', d.unmatched[0].suggested_variant_id, VARIANT);
  ok('only manual aliases are listed', d.aliases.length, 1);
  okTrue('and the query filters to manual',
    calls.some(c => c.url.includes('variant_aliases') && c.url.includes('source=eq.manual')));

  routes['rpc/map_sold_line'] = { status: 200, body: [{ lines_mapped: 5, lines_costed: 5 }] };
  const m = await post({ action: 'map-sold-line', name: 'Phoenix Blend', variant_id: VARIANT });
  ok('200 on map', m.statusCode, 200);
  ok('reports lines and costs', body(m).mapped, { lines: 5, costed: 5 });
  ok('rejects a map with no product', (await post({ action: 'map-sold-line', name: 'X' })).statusCode, 400);
  ok('rejects a map with no name',
    (await post({ action: 'map-sold-line', variant_id: VARIANT })).statusCode, 400);
  ok('rejects a non-uuid product',
    (await post({ action: 'map-sold-line', name: 'X', variant_id: 'nope' })).statusCode, 400);

  routes['rpc/unmap_sold_line'] = { status: 200, body: 5 };
  const un = await post({ action: 'unmap-sold-line', name: 'Phoenix Blend' });
  ok('200 on unmap', un.statusCode, 200);
  ok('reports what was put back', body(un).restored, 5);
  ok('rejects an unmap with no name', (await post({ action: 'unmap-sold-line' })).statusCode, 400);

  routes['rpc/map_sold_line'] = { status: 400, body: { message: 'unknown product' } };
  okTrue('database refusals surface',
    /unknown product/.test(body(await post({ action: 'map-sold-line', name: 'X', variant_id: VARIANT })).error));
}

console.log('\n11. labeling as its own cost layer');
{
  routes = defaultRoutes();
  const d = body(await run(getPurchasing, { headers: auth() }));
  ok('providers returned', d.label_providers.length, 2);
  ok('the active one is flagged', d.label_providers[0].is_active, true);
  ok('impact figures coerced', d.label_impact.vials_on_hand, 99);
  ok('label cost across stock', d.label_impact.label_cost_on_hand_cents, 2871);

  routes['rpc/save_label_provider'] = { status: 200, body: 'lp3' };
  ok('adds a provider',
    (await post({ action: 'save-label-provider', name: 'New Printer', cost_per_unit_cents: 45, is_active: true })).statusCode, 200);
  ok('rejects a blank name',
    (await post({ action: 'save-label-provider', name: '  ', cost_per_unit_cents: 45 })).statusCode, 400);
  ok('rejects a negative rate',
    (await post({ action: 'save-label-provider', name: 'X', cost_per_unit_cents: -1 })).statusCode, 400);
  ok('rejects a fractional cent rate',
    (await post({ action: 'save-label-provider', name: 'X', cost_per_unit_cents: 1.5 })).statusCode, 400);

  routes['rpc/delete_label_provider'] = { status: 400, body: {
    message: 'that provider is recorded on a purchase order and cannot be deleted -- set it inactive instead' } };
  okTrue('deleting a provider in use is refused, with the remedy',
    /set it inactive instead/.test(body(await post({ action: 'delete-label-provider', id: '11111111-1111-1111-1111-111111111111' })).error));

  // The distinction that matters: omitting the key means "use the active rate",
  // sending 0 means "this order genuinely had no labels".
  routes['rpc/save_purchase_order'] = { status: 200, body: PO };
  calls = [];
  await post({ ...base });
  let sent = calls.find(c => c.url.includes('rpc/save_purchase_order')).body.p;
  okTrue('omitting the label rate defers to the active provider', !('label_cost_cents' in sent));
  calls = [];
  await post({ ...base, label_cost_cents: 0 });
  sent = calls.find(c => c.url.includes('rpc/save_purchase_order')).body.p;
  ok('an explicit zero is forwarded as zero', sent.label_cost_cents, 0);
  calls = [];
  await post({ ...base, label_cost_cents: 29 });
  sent = calls.find(c => c.url.includes('rpc/save_purchase_order')).body.p;
  ok('an explicit rate is forwarded', sent.label_cost_cents, 29);

  // COA / QA fees follow the same omit-vs-zero rule, for a sharper reason: the
  // PO editor in an older deploy does not send this key at all, and a $75
  // invoice line must not vanish because someone fixed a typo in the notes.
  calls = [];
  await post({ ...base });
  sent = calls.find(c => c.url.includes('rpc/save_purchase_order')).body.p;
  okTrue('omitting QA fees leaves the stored value alone', !('qa_fees_cents' in sent));
  calls = [];
  await post({ ...base, qa_fees_cents: 0 });
  sent = calls.find(c => c.url.includes('rpc/save_purchase_order')).body.p;
  ok('an explicit zero clears them', sent.qa_fees_cents, 0);
  calls = [];
  await post({ ...base, qa_fees_cents: 7500, qa_fees_note: '3 x $25 COA' });
  sent = calls.find(c => c.url.includes('rpc/save_purchase_order')).body.p;
  ok('a COA fee is forwarded', sent.qa_fees_cents, 7500);
  ok('with its note', sent.qa_fees_note, '3 x $25 COA');
  ok('rejects a fractional cent QA fee',
    (await post({ ...base, qa_fees_cents: 12.5 })).statusCode, 400);
  ok('rejects a negative QA fee',
    (await post({ ...base, qa_fees_cents: -1 })).statusCode, 400);
}

console.log('\n12. unknown action');
ok('400 on an unknown action', (await post({ action: 'drop-everything' })).statusCode, 400);

// ─────────────────────────────────────────────────────────────────────────────
// The editor previews landed cost while you type, which means a second
// implementation of arithmetic the database owns. That is a drift risk, so it
// is pinned here against the real Direct Peptides #2675 invoice — the same
// numbers verified against v_purchase_order_lines and against Frank's own hand
// arithmetic in vault Finance/inventory-purchases.md.
console.log('\n13. the page preview agrees with the database view');
{
  const { readFileSync } = await import('fs');
  const html = readFileSync('./admin.html', 'utf8');
  const src  = html.match(/function previewLanded[\s\S]*?\n}/);
  okTrue('previewLanded() found in admin.html', !!src);

  const previewLanded = new Function(`${src[0]}; return previewLanded;`)();

  // #2675 modelled the way the app now does it: $18.00 shipping in the fee
  // pool, labels as their own $0.29/vial layer. Must still reproduce the
  // invoice exactly.
  const lines = [
    { quantity: 20, free_quantity: 0, unit_cost_cents: 1350 },
    { quantity: 10, free_quantity: 0, unit_cost_cents: 1800 },
    { quantity: 10, free_quantity: 0, unit_cost_cents: 2550 },
    { quantity: 10, free_quantity: 0, unit_cost_cents: 1400 },
  ];
  const got = previewLanded(lines, 1800, 'PER_UNIT', 29).map(r => r.landed);
  ok('landed cost matches the invoice, to the cent', got, [1415, 1865, 2615, 1465]);

  const split = previewLanded(lines, 1800, 'PER_UNIT', 29)[0];
  ok('vendor-only landed excludes the label', split.vendorLanded, 1386);
  ok('and the label is added on top', split.vendorLanded + split.label, split.landed);

  // The old shape — labels lumped into other fees — must give the same answer,
  // which is what makes moving them into their own layer safe.
  ok('lumping labels into fees agrees with separating them',
    previewLanded(lines, 1800 + 1450, 'PER_UNIT', 0).map(r => r.landed), got);

  // Free vials dilute the vendor cost but still each need a label.
  const free = previewLanded([{ quantity: 10, free_quantity: 2, unit_cost_cents: 1200 }], 0, 'PER_UNIT', 29);
  ok('free units dilute the vendor cost', free[0].vendorLanded, 1000);
  ok('but every vial still gets a label', free[0].landed, 1029);
  ok('label total covers free vials too', free[0].labelTotal, 29 * 12);

  // No fees, no division by zero, no NaN leaking into the page.
  ok('zero fees are handled', previewLanded(lines, 0, 'PER_UNIT', 0)[0].landed, 1350);
  ok('an empty line yields no landed figure, not NaN',
    previewLanded([{ quantity: 0, free_quantity: 0, unit_cost_cents: 500 }], 100, 'PER_UNIT', 29)[0].landed, null);

  // BY_VALUE puts more of the fee pool on the expensive line — but the label
  // stays flat, because a label costs the same whatever it is stuck to.
  const byValue = previewLanded(lines, 3250, 'BY_VALUE', 29);
  okTrue('BY_VALUE loads fees onto the expensive line',
    byValue[2].vendorLanded - 2550 > byValue[0].vendorLanded - 1350);
  ok('the label never varies by line value', byValue.map(r => r.label), [29, 29, 29, 29]);
}

console.log(`\n${fail ? `${fail} FAILED, ` : ''}${pass} passed.`);
process.exit(fail ? 1 : 0);
