// Exercises get-stock.js with no network: a stubbed Supabase and the real
// HMAC token helper, so the auth path is genuinely tested rather than mocked.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { signToken } = require('./netlify/functions/_auth-token.js');

const ROWS = [
  { variant_id:'v1', product_name:'Retatrutide 12mg', variant_name:'Regular', status:'OUT',
    on_hand:0, price_cents:16000, unit_cost_cents:9500, stock_value_cents:0, stock_retail_cents:0,
    units_life:'31', units_90d:'31', units_per_month:'10.33', months_cover:'0.0',
    margin_pct:'35.8', lines_missing_cost:0, suggested_buy:21, last_sold_at:'2026-08-12', is_hidden:true },
  { variant_id:'v2', product_name:'DSIP 5MG', variant_name:'Regular', status:'SLOW',
    on_hand:12, price_cents:6200, unit_cost_cents:3600, stock_value_cents:43200, stock_retail_cents:74400,
    units_life:'1', units_90d:'1', units_per_month:'0.33', months_cover:'36.0',
    margin_pct:'41.9', lines_missing_cost:0, suggested_buy:0, last_sold_at:'2026-06-01', is_hidden:false },
  { variant_id:'v3', product_name:'Phoenix Blend', variant_name:null, status:'NO_SALES',
    on_hand:10, price_cents:15500, unit_cost_cents:6260, stock_value_cents:62600, stock_retail_cents:155000,
    units_life:'0', units_90d:'0', units_per_month:'0.00', months_cover:null,
    margin_pct:null, lines_missing_cost:5, suggested_buy:0, last_sold_at:null, is_hidden:false },
];

function load(env, fetchImpl) {
  for (const k of ['SUPABASE_URL','SUPABASE_SERVICE_KEY','SUPABASE_SERVICE_ROLE_KEY','ADMIN_TOKEN_SECRET']) delete process.env[k];
  Object.assign(process.env, env);
  globalThis.fetch = fetchImpl;
  delete require.cache[require.resolve('./netlify/functions/get-stock.js')];
  return require('./netlify/functions/get-stock.js').handler;
}
const supa = (opts={}) => async () => {
  if (opts.throws) { const e=new Error('aborted'); e.name='AbortError'; throw e; }
  if (opts.status && opts.status >= 400)
    return { ok:false, status:opts.status, text: async () => '{"message":"relation does not exist"}' };
  return { ok:true, status:200, text: async () => JSON.stringify(ROWS) };
};
const ENV = { SUPABASE_URL:'https://x.supabase.co', SUPABASE_SERVICE_KEY:'k', ADMIN_TOKEN_SECRET:'s3cr3t' };
const auth = t => ({ headers: { authorization: 'Bearer ' + t } });

let fails = 0;
const ck = (l,c,x='') => { console.log(`${c?'  PASS':'  FAIL'}  ${l}${x?'  '+x:''}`); if(!c) fails++; };

let h = load(ENV, supa()); let r, b;

console.log('\n1. auth gate');
r = await h({ headers:{} });                          ck('401 with no token', r.statusCode===401);
r = await h(auth('garbage.token'));                   ck('401 with a forged token', r.statusCode===401);
r = await h(auth(signToken('the-wrong-secret')));     ck('401 with a token signed by another secret', r.statusCode===401);
r = await h(auth(signToken('s3cr3t', -10)));          ck('401 with an expired token', r.statusCode===401);
r = await h(auth(signToken('s3cr3t')));               ck('200 with a valid token', r.statusCode===200, `got ${r.statusCode}`);

console.log('\n2. payload');
b = JSON.parse(r.body);
ck('3 items returned', b.items.length===3);
ck('velocity window is stated, not implied', b.velocity_window_days===90);
ck('money stays in cents', b.items[1].stock_cost_cents===43200);
ck('numeric strings coerced', b.items[0].units_per_month===10.33 && b.items[0].units_life===31);
ck('null cover preserved, not zeroed', b.items[2].months_cover===null);
ck('null margin preserved', b.items[2].margin_pct===null);

console.log('\n3. totals');
ck('units sum', b.totals.units===22, `got ${b.totals.units}`);
ck('cost sum', b.totals.cost_cents===105800, `got ${b.totals.cost_cents}`);
ck('reorder counts OUT+LOW only', b.totals.needs_reorder===1, `got ${b.totals.needs_reorder}`);
ck('parked = SLOW + NO_SALES', b.totals.parked_cents===105800, `got ${b.totals.parked_cents}`);
ck('products missing cost flagged', b.totals.products_missing_cost===1);

console.log('\n4. failure modes');
h = load({ ADMIN_TOKEN_SECRET:'s3cr3t' }, supa());
r = await h(auth(signToken('s3cr3t'))); b = JSON.parse(r.body);
ck('500 + setup hint when Supabase env missing', r.statusCode===500 && /Environment variables/.test(b.detail));

h = load(ENV, supa({ status:404 }));
r = await h(auth(signToken('s3cr3t'))); b = JSON.parse(r.body);
ck('404 from PostgREST names the missing view', r.statusCode===502 && /run-sql\.sh/.test(b.hint));

h = load(ENV, supa({ throws:true }));
r = await h(auth(signToken('s3cr3t'))); b = JSON.parse(r.body);
ck('timeout reported, not a stack trace', r.statusCode===500 && /timed out/.test(b.error));

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(fails?1:0);
