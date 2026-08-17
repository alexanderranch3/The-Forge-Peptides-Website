// Exercises health-check.js without touching Square. Proves the branches that
// matter: missing env, a healthy run, a silent-drift run (200 but wrong money),
// a Square rejection, a timeout, and that Supabase logging can never fail it.
import { createRequire } from 'module';

const CALCULATE_OK = {
  order: {
    total_money: { amount: 17658 }, total_tax_money: { amount: 1008 },
    total_discount_money: { amount: 1850 },
  },
};

function loadHandler(env, fetchImpl) {
  for (const k of ['SQUARE_ACCESS_TOKEN','SQUARE_LOCATION_ID','SUPABASE_URL','SUPABASE_SERVICE_KEY','SUPABASE_SERVICE_ROLE_KEY','HEALTH_CHECK_TOKEN']) delete process.env[k];
  Object.assign(process.env, env);
  globalThis.fetch = fetchImpl;
  const require = createRequire(import.meta.url);
  delete require.cache[require.resolve('./netlify/functions/health-check.js')];
  return require('./netlify/functions/health-check.js').handler;
}

const squareFetch = (overrides = {}) => async (url) => {
  if (url.includes('/catalog/list')) {
    return { ok: true, status: 200, json: async () => ({ objects: [{ type: 'ITEM' }, { type: 'ITEM' }] }) };
  }
  if (url.includes('/orders/calculate')) {
    if (overrides.calculateThrows) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    if (overrides.calculateStatus && overrides.calculateStatus >= 400) {
      return { ok: false, status: overrides.calculateStatus, json: async () => ({ errors: [{ code: 'BAD_REQUEST' }] }) };
    }
    return { ok: true, status: 200, json: async () => (overrides.calculateBody || CALCULATE_OK) };
  }
  if (url.includes('/rest/v1/health_checks')) {
    if (overrides.supabaseThrows) throw new Error('supabase exploded');
    return { ok: overrides.supabaseOk !== false, status: overrides.supabaseOk === false ? 500 : 201 };
  }
  throw new Error('unexpected url ' + url);
};

// Both values are deliberately fake. `publish = "."` serves this repo verbatim,
// so a real identifier here would be published AND would trip Netlify's secrets
// scanning (it fails any build whose output contains an env var's value).
const ENV = { SQUARE_ACCESS_TOKEN: 't', SQUARE_LOCATION_ID: 'LTESTLOCATION0' };
let failures = 0;
const check = (label, cond, extra='') => { console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${extra ? '  ' + extra : ''}`); if (!cond) failures++; };

// 1. Missing env
let h = loadHandler({}, squareFetch());
let r = await h({}); let b = JSON.parse(r.body);
console.log('\n1. missing Square env vars');
check('returns 500', r.statusCode === 500);
check('env probe fails and names the vars', b.probes[0].ok === false && b.probes[0].detail.missing.length === 2);
check('Square probes skipped, not spuriously failed', b.probes[1].detail.skipped !== undefined);
check('failing[] lists all three', b.failing.length === 3);

// 2. Fully healthy
h = loadHandler(ENV, squareFetch());
r = await h({}); b = JSON.parse(r.body);
console.log('\n2. everything healthy');
check('returns 200', r.statusCode === 200, `got ${r.statusCode}`);
check('ok true, nothing failing', b.ok === true && b.failing.length === 0);
check('reports computed money', b.probes[2].detail.computed.total === 17658);

// 3. THE FINDING: Square returns 200 but the money silently drifted
h = loadHandler(ENV, squareFetch({ calculateBody: { order: {
  total_money: { amount: 16650 }, total_tax_money: { amount: 0 }, total_discount_money: { amount: 1850 } } } }));
r = await h({}); b = JSON.parse(r.body);
console.log('\n3. HTTP 200 but tax silently dropped (the false-green case)');
check('goes RED despite a 200 from Square', r.statusCode === 500, `got ${r.statusCode}`);
check('names total_money and total_tax_money', b.probes[2].detail.mismatches.map(m=>m.field).join(',') === 'total_money,total_tax_money');

// 4. calculate returns an order id -> no longer non-destructive
h = loadHandler(ENV, squareFetch({ calculateBody: { order: { id: 'abc',
  total_money:{amount:17658}, total_tax_money:{amount:1008}, total_discount_money:{amount:1850} } } }));
r = await h({}); b = JSON.parse(r.body);
console.log('\n4. calculate unexpectedly created an order');
check('goes RED even though the money is correct', r.statusCode === 500);
check('detail says to disable the endpoint', /Disable this endpoint/.test(b.probes[2].detail.note));

// 5. Square rejects the body (the 2026-08-13 shape)
h = loadHandler(ENV, squareFetch({ calculateStatus: 500 }));
r = await h({}); b = JSON.parse(r.body);
console.log('\n5. Square 500s on a valid order body (the 08-13 outage)');
check('returns 500', r.statusCode === 500);
check('checkout named as failing', b.failing.includes('checkout'));

// 6. Timeout
h = loadHandler(ENV, squareFetch({ calculateThrows: true }));
r = await h({}); b = JSON.parse(r.body);
console.log('\n6. Square hangs');
check('returns 500 rather than throwing', r.statusCode === 500);
check('reports a timeout, not a stack trace', /timed out/.test(b.probes[2].detail.error));

// 7. Supabase logging must never be load-bearing
h = loadHandler({ ...ENV, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'k' }, squareFetch({ supabaseThrows: true }));
r = await h({}); b = JSON.parse(r.body);
console.log('\n7. healthy site, but Supabase logging blows up');
check('STILL returns 200', r.statusCode === 200, `got ${r.statusCode}`);
check('persistence reports the failure without failing the check', b.persistence.logged === false);

h = loadHandler({ ...ENV, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'k' }, squareFetch());
r = await h({}); b = JSON.parse(r.body);
check('logs 3 rows when Supabase is up', b.persistence.logged === true && b.persistence.rows === 3);

// 8. Optional token gate
h = loadHandler({ ...ENV, HEALTH_CHECK_TOKEN: 's3cret' }, squareFetch());
r = await h({ queryStringParameters: {}, headers: {} });
console.log('\n8. optional token gate');
check('401 without the token', r.statusCode === 401);
r = await h({ queryStringParameters: { token: 's3cret' }, headers: {} });
check('200 with the token', r.statusCode === 200);
r = await h({ queryStringParameters: {}, headers: { 'x-health-token': 's3cret' } });
check('200 via header too', r.statusCode === 200);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
