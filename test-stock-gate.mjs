// Tests the dashboard stock source: _stock.js, the checkout gate in
// create-invoice.js, and the display switch in get-inventory.js.
// No network: fetch is stubbed.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ok = (label, got, want) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${label}${good ? '' : `  got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  good ? pass++ : fail++;
};
const okTrue = (label, cond) => ok(label, !!cond, true);

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'key';
process.env.SQUARE_ACCESS_TOKEN = 'sq';
process.env.SQUARE_LOCATION_ID = 'LOC1';

let routes = {}, calls = [];
global.fetch = async (url, opts = {}) => {
  calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
  for (const [frag, h] of Object.entries(routes)) {
    if (url.includes(frag)) {
      const r = typeof h === 'function' ? await h(opts) : h;
      if (r.throw) throw new Error('network down');
      return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body), json: async () => r.body };
    }
  }
  return { ok: false, status: 404, text: async () => '{}', json: async () => ({}) };
};

const fresh = (p) => { delete require.cache[require.resolve(p)]; return require(p); };

const STOCK_ROWS = [
  { variant_id: 'v1', product_name: 'Retatrutide 10mg', variant_name: '10mg', site_catalog_id: null, on_hand: 2 },
  { variant_id: 'v2', product_name: 'Glow Blend', variant_name: null, site_catalog_id: null, on_hand: 0 },
  { variant_id: 'v3', product_name: 'BPC-157 10mg', variant_name: '10mg', site_catalog_id: 'bpc-157-10mg', on_hand: 10 },
  // Two catalog rows for the same storefront product — quantities must sum.
  { variant_id: 'v4', product_name: 'DSIP 5MG', variant_name: null, site_catalog_id: 'dsip-5mg', on_hand: 4 },
  { variant_id: 'v5', product_name: 'DSIP 5mg legacy', variant_name: null, site_catalog_id: 'dsip-5mg', on_hand: 3 },
];

console.log('\n1. mapping catalog rows onto storefront ids');
{
  const { indexBySiteId } = fresh('./netlify/functions/_stock.js');
  const m = indexBySiteId(STOCK_ROWS);
  ok('matched by name when unpinned', m['retatrutide-10mg'].on_hand, 2);
  ok('the explicit pin is used', m['bpc-157-10mg'].on_hand, 10);
  ok('duplicate rows are summed, not overwritten', m['dsip-5mg'].on_hand, 7);
  ok('zero stock is recorded, not dropped', m['glow-blend'].on_hand, 0);
  // 🔑 The pin must WIN over the name, or a rename silently re-points stock.
  const pinned = indexBySiteId([{ product_name: 'Retatrutide 10mg', variant_name: '10mg',
                                  site_catalog_id: 'something-else', on_hand: 5 }]);
  okTrue('a pin beats the name match', pinned['something-else'] && !pinned['retatrutide-10mg']);
}

console.log('\n2. the source switch defaults to Square');
{
  delete process.env.STOCK_SOURCE;
  const s = fresh('./netlify/functions/_stock.js');
  ok('default', s.stockSource(), 'square');
  calls = [];
  const r = await s.checkAvailability([{ id: 'retatrutide-10mg', name: 'Reta 10mg', qty: 99 }]);
  ok('nothing is blocked', r.ok, true);
  ok('and it says why', r.reason, 'source is square');
  okTrue('the dashboard is not even called', calls.length === 0);
}

console.log('\n3. with the dashboard as the source');
{
  process.env.STOCK_SOURCE = 'dashboard';
  const s = fresh('./netlify/functions/_stock.js');
  routes['v_inventory_dashboard'] = { status: 200, body: STOCK_ROWS };

  ok('enough stock passes', (await s.checkAvailability([{ id: 'retatrutide-10mg', name: 'Reta 10mg', qty: 2 }])).ok, true);

  const short = await s.checkAvailability([{ id: 'retatrutide-10mg', name: 'Retatrutide 10mg', qty: 5 }]);
  ok('too many is refused', short.ok, false);
  ok('and it reports the real number', short.shortages[0], { id: 'retatrutide-10mg', name: 'Retatrutide 10mg', wanted: 5, available: 2 });
  ok('message names the shortfall', s.shortageMessage(short.shortages),
    'Only 2 of Retatrutide 10mg are left — you asked for 5.');

  const out = await s.checkAvailability([{ id: 'glow-blend', name: 'Glow Blend', qty: 1 }]);
  ok('zero stock is refused', out.ok, false);
  ok('worded as out of stock', s.shortageMessage(out.shortages), 'Glow Blend is out of stock.');

  const one = await s.checkAvailability([{ id: 'retatrutide-10mg', name: 'Reta', qty: 3 }]);
  okTrue('singular reads correctly', /is left/.test(s.shortageMessage([{ ...one.shortages[0], available: 1 }])));
}

console.log('\n4. 🔑 it fails OPEN — a reporting outage never refuses money');
{
  process.env.STOCK_SOURCE = 'dashboard';
  const s = fresh('./netlify/functions/_stock.js');

  routes['v_inventory_dashboard'] = { status: 500, body: {} };
  ok('Supabase erroring does not block', (await s.checkAvailability([{ id: 'glow-blend', name: 'x', qty: 9 }])).ok, true);

  routes['v_inventory_dashboard'] = { throw: true };
  ok('a thrown request does not block', (await s.checkAvailability([{ id: 'glow-blend', name: 'x', qty: 9 }])).ok, true);

  routes['v_inventory_dashboard'] = { status: 200, body: [] };
  ok('an empty answer does not block', (await s.checkAvailability([{ id: 'glow-blend', name: 'x', qty: 9 }])).ok, true);

  routes['v_inventory_dashboard'] = { status: 200, body: STOCK_ROWS };
  ok('an unknown product does not block',
    (await s.checkAvailability([{ id: 'brand-new-thing', name: 'New', qty: 99 }])).ok, true);
}

console.log('\n5. the checkout gate');
{
  process.env.STOCK_SOURCE = 'dashboard';
  process.env.ADMIN_TOKEN_SECRET = 'x';
  delete require.cache[require.resolve('./netlify/functions/_stock.js')];
  const ci = fresh('./netlify/functions/create-invoice.js');

  routes = {
    'v_inventory_dashboard': { status: 200, body: STOCK_ROWS },
    'customers/search': { status: 200, body: { customers: [{ id: 'c1' }] } },
    '/orders': { status: 200, body: { order: { id: 'o1', line_items: [], total_money: { amount: 0 } } } },
    'catalog/list': { status: 200, body: { objects: [] } },
  };

  const order = (qty) => ci.handler({
    httpMethod: 'POST', headers: {},
    body: JSON.stringify({
      customerName: 'Test Buyer', customerEmail: 't@example.com', fulfillment: 'Local Pickup',
      items: [{ id: 'retatrutide-10mg', qty }],
    }),
  });

  calls = [];
  const refused = await order(5);
  ok('over-ordering is refused', refused.statusCode, 400);
  okTrue('with a message the customer can act on', /Only 2 of Retatrutide 10mg/.test(JSON.parse(refused.body).error));
  // 🚨 The whole point of gating BEFORE the order exists.
  okTrue('and NO Square order was created', !calls.some(c => c.url.includes('/orders') && c.method === 'POST'));

  calls = [];
  const allowed = await order(2);
  ok('an order within stock succeeds', allowed.statusCode, 200);
  okTrue('and it did create the Square order', calls.some(c => c.url.includes('/orders') && c.method === 'POST'));
}

console.log('\n6. the display switch');
{
  const load = () => fresh('./netlify/functions/get-inventory.js');
  routes['catalog/list'] = { status: 200, body: { objects: [{
    type: 'ITEM', id: 'i1',
    item_data: { name: 'Retatrutide', variations: [
      { id: 'var1', item_variation_data: { name: '10mg', price_money: { amount: 16000 },
        location_overrides: [{ location_id: 'LOC1', sold_out: true }] } },
    ] },
  }] } };
  routes['v_inventory_dashboard'] = { status: 200, body: STOCK_ROWS };

  process.env.STOCK_SOURCE = 'square';
  let d = JSON.parse((await load().handler({ httpMethod: 'GET', headers: {} })).body);
  ok('square source keeps Square\'s flag', d['retatrutide-10mg'].soldOut, true);
  ok('and reports its source', d._source, 'square');

  process.env.STOCK_SOURCE = 'dashboard';
  d = JSON.parse((await load().handler({ httpMethod: 'GET', headers: {} })).body);
  // Square says sold out; the dashboard says 2 on hand. The dashboard wins —
  // which is the entire point, and is exactly the Retatrutide 10mg situation.
  ok('dashboard stock overrides a stale Square flag', d['retatrutide-10mg'].soldOut, false);
  ok('and the real count is exposed', d['retatrutide-10mg'].onHand, 2);
  ok('source reported', d._source, 'dashboard');

  routes['v_inventory_dashboard'] = { throw: true };
  d = JSON.parse((await load().handler({ httpMethod: 'GET', headers: {} })).body);
  ok('a dashboard outage falls back to Square', d['retatrutide-10mg'].soldOut, true);
  ok('and says the source was square', d._source, 'square');
}

console.log(`\n${fail ? `${fail} FAILED, ` : ''}${pass} passed.`);
process.exit(fail ? 1 : 0);
