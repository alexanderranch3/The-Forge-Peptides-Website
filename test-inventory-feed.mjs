// Tests that the storefront feed can report a product SOLD OUT even when Square
// has never heard of it.
//
// 2026-08-19: get-inventory builds its result from Square's catalog, then walked
// the dashboard's stock with `if (!result[id]) continue`. Retatrutide 30mg and
// BPC-157 10mg exist in the dashboard and in the storefront CATALOG but were
// created after the Square cutover, so they were never in that result — and the
// skip meant their cards COULD NOT GO SOLD OUT however far the real count fell.
//
// 🔑 The failure was one-directional and silent: the product sells perfectly, so
// nothing complains until someone buys stock that is not there. That is why this
// asserts on the sold-out transition specifically, not just on the key existing.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ok = (l, c, d = '') => { c ? (pass++, console.log(`  PASS  ${l}`)) : (fail++, console.log(`  FAIL  ${l}${d ? '  — ' + d : ''}`)); };

process.env.SQUARE_ACCESS_TOKEN = 'tok';
process.env.SQUARE_LOCATION_ID  = 'LOC1';
process.env.SUPABASE_URL        = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'key';
process.env.STOCK_SOURCE        = 'dashboard';

const { CATALOG } = require('./netlify/functions/_catalog.js');

// A Square catalog holding ONE product, so everything else has to arrive via
// the dashboard — which is the situation the bug lived in.
const squareCatalog = {
  objects: [{
    type: 'ITEM',
    item_data: {
      name: 'Retatrutide',
      variations: [{
        item_variation_data: {
          name: '15mg', price_money: { amount: 19500 },
          location_overrides: [{ location_id: 'LOC1', sold_out: false }],
        },
      }],
    },
  }],
};

function run({ stock, blocked = [] }) {
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/catalog/list')) return { ok: true, status: 200, json: async () => squareCatalog, text: async () => JSON.stringify(squareCatalog) };
    // null stock = the dashboard could not answer, which must fail OPEN
    if (u.includes('v_inventory_dashboard')) return stock === null
      ? { ok: false, status: 500, json: async () => [], text: async () => '[]' }
      : { ok: true, status: 200, json: async () => stock, text: async () => JSON.stringify(stock) };
    if (u.includes('v_unfulfillable')) return { ok: true, status: 200, json: async () => blocked, text: async () => JSON.stringify(blocked) };
    return { ok: true, status: 200, text: async () => '[]', json: async () => [] };
  };
  const p = './netlify/functions/get-inventory.js';
  delete require.cache[require.resolve(p)];
  delete require.cache[require.resolve('./netlify/functions/_stock.js')];
  return require(p).handler({ httpMethod: 'GET', headers: {}, queryStringParameters: null });
}

console.log('\n1. the two post-Square products are still sold on the site');
ok('retatrutide-30mg is in CATALOG', !!CATALOG['retatrutide-30mg']);
ok('bpc-157-10mg is in CATALOG', !!CATALOG['bpc-157-10mg']);

console.log('\n2. 🔑 a product Square never had can now go sold out');
let res = await run({ stock: [
  { variant_id: 'v1', product_name: 'Retatrutide', variant_name: '30mg', site_catalog_id: 'retatrutide-30mg', on_hand: 0 },
  { variant_id: 'v2', product_name: 'Retatrutide', variant_name: '15mg', site_catalog_id: 'retatrutide-15mg', on_hand: 4 },
] });
let body = JSON.parse(res.body);
const reta30 = (body.items || body)['retatrutide-30mg'];
ok('it appears in the feed at all', !!reta30, JSON.stringify(body).slice(0, 200));
ok('🔑 and it reads SOLD OUT at zero on hand', reta30 && reta30.soldOut === true);
ok('its on-hand count comes through', reta30 && reta30.onHand === 0);

console.log('\n3. it is still buyable while stock lasts');
res = await run({ stock: [{ variant_id: 'v1', product_name: 'Retatrutide', variant_name: '30mg', site_catalog_id: 'retatrutide-30mg', on_hand: 6 }] });
body = JSON.parse(res.body);
const stocked = (body.items || body)['retatrutide-30mg'];
ok('not sold out with 6 on hand', stocked && stocked.soldOut === false);
ok('and the count is reported so the page can say "only 6 left"', stocked && stocked.onHand === 6);

console.log('\n4. 🔑 it still fails OPEN when the dashboard cannot answer');
res = await run({ stock: null });
body = JSON.parse(res.body);
const blind = (body.items || body)['retatrutide-30mg'];
ok('no sold-out sign is painted over stock we may have',
   !blind || blind.soldOut !== true, JSON.stringify(blind));

console.log('\n5. an id in neither Square nor CATALOG is still ignored');
res = await run({ stock: [{ variant_id: 'v9', product_name: 'Mystery', variant_name: 'X', site_catalog_id: 'not-a-real-product', on_hand: 0 }] });
body = JSON.parse(res.body);
ok('it did not invent a storefront entry', !(body.items || body)['not-a-real-product']);


console.log('\n6. 🚨 step 4: the shop does not need Square any more');
{
  // The public feed is what every page load reads. It must keep working when
  // the Square environment variables are removed — that removal is the point of
  // this migration, and an env guard that 500s would have made it impossible.
  const saved = { t: process.env.SQUARE_ACCESS_TOKEN, l: process.env.SQUARE_LOCATION_ID };
  delete process.env.SQUARE_ACCESS_TOKEN;
  delete process.env.SQUARE_LOCATION_ID;
  delete require.cache[require.resolve('./netlify/functions/get-inventory.js')];
  const fresh = require('./netlify/functions/get-inventory.js');

  const res = await fresh.handler();
  const feed = JSON.parse(res.body);
  const ids = Object.keys(feed).filter((k) => k[0] !== '_');
  ok('it answers with no Square env at all', res.statusCode, 200);
  ok('every catalogue product is listed', ids.length, Object.keys(CATALOG).length);
  // The dashboard still governs sold-out, exactly as before — removing Square
  // changed where the LIST comes from, not who decides availability.
  ok('the dashboard still decides availability', feed._source, 'dashboard');

  // ⚠️ AND WITH NO STOCK SOURCE EITHER, IT FAILS OPEN. This is the property
  // that matters most on a public page: a false "sold out" is a lost sale
  // nobody ever hears about, so silence must mean available.
  const savedSrc = process.env.STOCK_SOURCE;
  delete process.env.STOCK_SOURCE;
  delete require.cache[require.resolve('./netlify/functions/_stock.js')];
  delete require.cache[require.resolve('./netlify/functions/get-inventory.js')];
  const blind = require('./netlify/functions/get-inventory.js');
  const blindFeed = JSON.parse((await blind.handler()).body);
  const blindIds = Object.keys(blindFeed).filter((k) => k[0] !== '_');
  ok('every product still listed with nothing to ask', blindIds.length, Object.keys(CATALOG).length);
  // ⚠️ Except anything on the unfulfillable list, which reads sold-out on
  // purpose whatever the counts say — no labels means it physically cannot
  // ship, and that is true regardless of which system knows the quantity.
  const wrongly = blindIds.filter((k) => blindFeed[k].soldOut && !blindFeed[k].unavailable);
  ok('🚨 nothing is marked sold out for lack of stock information',
    wrongly.map((k) => [k, blindFeed[k]]), []);
  if (savedSrc) process.env.STOCK_SOURCE = savedSrc;
  delete require.cache[require.resolve('./netlify/functions/_stock.js')];

  // 🔑 The price now comes from CATALOG — the same line the server charges
  // from — so what a customer sees and what they are charged cannot drift.
  ok('the price is the catalogue price', feed['retatrutide-10mg'].price, CATALOG['retatrutide-10mg'].price);
  const mismatched = ids.filter((id) => feed[id].price !== CATALOG[id].price);
  ok('🚨 no product is published at a price the server would not charge', mismatched, []);

  if (saved.t) process.env.SQUARE_ACCESS_TOKEN = saved.t;
  if (saved.l) process.env.SQUARE_LOCATION_ID = saved.l;
  delete require.cache[require.resolve('./netlify/functions/get-inventory.js')];
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
