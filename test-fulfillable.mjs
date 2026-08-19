// Tests the "in stock but cannot ship" gate (migration 017 + _stock.js).
// No network: fetch is stubbed.
//
// The case that matters: MOTS-C was ALREADY is_hidden=true and would still have
// sold, because a hidden variant never reaches the stock map and unknown fails
// OPEN. So these assertions are mostly "does the block hold where is_hidden did
// not", including with STOCK_SOURCE unset — an unlabelled vial cannot ship
// whichever system we believe about quantities.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ok = (label, got, want) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${label}` + (good ? '' : `  got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
  good ? pass++ : fail++;
};
const okTrue = (l, c) => ok(l, !!c, true);

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'key';

let routes = {};
global.fetch = async (url) => {
  for (const [frag, r] of Object.entries(routes)) {
    if (url.includes(frag)) {
      if (r.throw) throw new Error('network down');
      return { ok: r.status < 400, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
    }
  }
  return { ok: false, status: 404, json: async () => ({}), text: async () => '{}' };
};
const fresh = () => { delete require.cache[require.resolve('./netlify/functions/_stock')];
  return require('./netlify/functions/_stock'); };

const BLOCKED = [
  { site_catalog_id: 'bpc-157-10mg', reason: 'No labels yet — stock on hand, cannot ship' },
  { site_catalog_id: 'mots-c-10mg',  reason: 'No labels yet — stock on hand, cannot ship' },
];
const basket = (...ids) => ids.map((id) => ({ id, name: id, qty: 1 }));

console.log('\n— 🚨 an unshippable product is refused —');
routes = { v_unfulfillable: { status: 200, body: BLOCKED } };
let st = fresh();
let r = await st.checkFulfillable(basket('bpc-157-10mg'));
ok('BPC-157 is refused', r.ok, false);
ok('and says which', r.blocked.map((b) => b.id), ['bpc-157-10mg']);
okTrue('with a reason a human wrote', r.blocked[0].reason.includes('No labels'));
r = await st.checkFulfillable(basket('mots-c-10mg'));
ok('🚨 MOTS-C is refused too — is_hidden never did this', r.ok, false);
r = await st.checkFulfillable(basket('retatrutide-10mg', 'bpc-157-10mg'));
ok('a mixed basket is refused', r.ok, false);
ok('naming only the offending line', r.blocked.length, 1);

console.log('\n— unaffected products still sell —');
r = await st.checkFulfillable(basket('retatrutide-10mg', 'glow-blend'));
ok('a clean basket passes', r.ok, true);
ok('an empty basket passes', (await st.checkFulfillable([])).ok, true);

console.log('\n— 🔑 the block does NOT depend on STOCK_SOURCE —');
for (const src of [undefined, 'square', 'dashboard']) {
  if (src === undefined) delete process.env.STOCK_SOURCE; else process.env.STOCK_SOURCE = src;
  st = fresh();
  ok(`refused with STOCK_SOURCE=${src ?? '(unset)'}`, (await st.checkFulfillable(basket('bpc-157-10mg'))).ok, false);
}
// The quantity gate, by contrast, IS gated on the cutover — proving they are
// genuinely separate mechanisms rather than one doing both jobs.
delete process.env.STOCK_SOURCE;
st = fresh();
ok('the STOCK gate stays inert pre-cutover', (await st.checkAvailability(basket('anything'))).checked, false);

console.log('\n— ⚠️ fails open, like the rest of the stock layer —');
routes = { v_unfulfillable: { throw: true } };
st = fresh();
r = await st.checkFulfillable(basket('bpc-157-10mg'));
ok('a network failure does not take the shop down', r.ok, true);
ok('and says it did not really check', r.checked, false);
routes = { v_unfulfillable: { status: 500, body: {} } };
st = fresh();
ok('a 500 fails open too', (await st.checkFulfillable(basket('bpc-157-10mg'))).ok, true);

console.log('\n— an EMPTY blocklist is a real answer, not a failure —');
routes = { v_unfulfillable: { status: 200, body: [] } };
st = fresh();
r = await st.checkFulfillable(basket('bpc-157-10mg'));
ok('nothing blocked means the sale proceeds', r.ok, true);
ok('and it DID check', r.checked, true);

console.log('\n— the customer-facing wording —');
okTrue('says unavailable, not sold out',
  st.blockedMessage([{ id: 'x', name: 'BPC-157 10mg', reason: 'No labels yet' }])
    .includes('temporarily unavailable'));
okTrue('never leaks the internal reason to the customer',
  !st.blockedMessage([{ id: 'x', name: 'BPC-157 10mg', reason: 'No labels yet' }]).includes('labels'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
