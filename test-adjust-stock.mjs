// Tests for adjust-stock.js. No network: fetch is stubbed.
import { createRequire } from 'module';
import crypto from 'crypto';
import { readFileSync } from 'fs';

const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ok = (label, got, want) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${label}${good ? '' : `  got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  good ? pass++ : fail++;
};
const okTrue = (label, cond) => ok(label, !!cond, true);

const SECRET = 'test-secret';
process.env.ADMIN_TOKEN_SECRET = SECRET;
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

function makeToken(secret, { expiresInSec = 3600 } = {}) {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expiresInSec })).toString('base64url');
  return `${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`;
}
const auth = (t = makeToken(SECRET)) => ({ authorization: `Bearer ${t}` });

let routes = {}, calls = [];
global.fetch = async (url, opts = {}) => {
  calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
  for (const [frag, h] of Object.entries(routes)) {
    if (url.includes(frag)) {
      const r = typeof h === 'function' ? await h(opts) : h;
      return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body), json: async () => r.body };
    }
  }
  return { ok: false, status: 404, text: async () => '{}', json: async () => ({}) };
};

const fn = require('./netlify/functions/adjust-stock.js');
const run = (e) => fn.handler({ headers: {}, httpMethod: 'GET', ...e });
const body = (r) => JSON.parse(r.body);
const VAR = '33333333-3333-3333-3333-333333333333';
const post = (b, h = auth()) => run({ httpMethod: 'POST', headers: h, body: JSON.stringify(b) });

console.log('\n1. auth');
ok('401 without a token', (await run({})).statusCode, 401);
ok('401 with the wrong secret', (await run({ headers: auth(makeToken('other')) })).statusCode, 401);

console.log('\n2. history');
{
  routes['v_stock_history'] = { status: 200, body: [
    { id: 'm1', variant_id: VAR, product_name: 'DSIP 5MG', variant_name: null, delta: '-1',
      reason: 'RECOUNT', note: 'shelf count', occurred_at: '2026-08-17T00:00:00Z', created_by: 'admin', order_no: null },
  ] };
  const d = body(await run({ headers: auth(), queryStringParameters: { variant_id: VAR } }));
  ok('movement returned', d.movements.length, 1);
  ok('delta coerced to a number', d.movements[0].delta, -1);
  ok('reason surfaced', d.movements[0].reason, 'RECOUNT');
  okTrue('scoped to the variant', calls.some(c => c.url.includes(`variant_id=eq.${VAR}`)));
  ok('rejects a bad variant id',
    (await run({ headers: auth(), queryStringParameters: { variant_id: 'nope' } })).statusCode, 400);
  calls = [];
  await run({ headers: auth(), queryStringParameters: { limit: '9999' } });
  okTrue('limit is clamped', calls.some(c => c.url.includes('limit=200')));
}

console.log('\n3. posting an adjustment');
{
  routes['rpc/post_stock_adjustment'] = { status: 200, body: { changed: true, before: 12, delta: -1, after: 11, reason: 'RECOUNT' } };
  calls = [];
  const r = await post({ variant_id: VAR, mode: 'RECOUNT', quantity: 11, note: 'counted' });
  ok('200', r.statusCode, 200);
  ok('reports the movement', body(r).after, 11);
  const sent = calls.find(c => c.url.includes('rpc/post_stock_adjustment')).body.p;
  // 🔑 The COUNTED TOTAL goes to the database, which derives the delta. The page
  // must never do that subtraction — that is how a recount gets stored backwards.
  ok('sends the counted total, not a delta', sent.quantity, 11);
  ok('mode forwarded', sent.mode, 'RECOUNT');
}

console.log('\n4. validation');
{
  ok('needs a product', (await post({ mode: 'RECOUNT', quantity: 1 })).statusCode, 400);
  ok('rejects a bad id', (await post({ variant_id: 'x', mode: 'RECOUNT', quantity: 1 })).statusCode, 400);
  ok('rejects an unknown mode', (await post({ variant_id: VAR, mode: 'DESTROY', quantity: 1 })).statusCode, 400);
  ok('rejects a fractional quantity', (await post({ variant_id: VAR, mode: 'ADD', quantity: 1.5 })).statusCode, 400);
  ok('rejects a negative quantity', (await post({ variant_id: VAR, mode: 'ADD', quantity: -1 })).statusCode, 400);
  ok('rejects a string quantity', (await post({ variant_id: VAR, mode: 'ADD', quantity: '3' })).statusCode, 400);
  ok('rejects a bad date', (await post({ variant_id: VAR, mode: 'ADD', quantity: 1, occurred_at: '17/08/2026' })).statusCode, 400);
  // 🚨 A sale carries an order and a purchase carries a cost. Neither may be
  // forged from this screen.
  ok('cannot forge a sale', (await post({ variant_id: VAR, mode: 'REMOVE', quantity: 1, reason: 'SALE' })).statusCode, 400);
  ok('cannot forge a purchase', (await post({ variant_id: VAR, mode: 'ADD', quantity: 1, reason: 'PURCHASE_RECEIVED' })).statusCode, 400);
  ok('cannot forge an opening balance', (await post({ variant_id: VAR, mode: 'ADD', quantity: 1, reason: 'OPENING' })).statusCode, 400);
  ok('405 on PUT', (await run({ httpMethod: 'PUT', headers: auth() })).statusCode, 405);
}

console.log('\n5. database refusals reach the user intact');
{
  routes['rpc/post_stock_adjustment'] = { status: 400, body: {
    message: 'that would leave DSIP 5MG at -3 vials. If the recorded figure is wrong, use a recount and enter what you actually have.' } };
  const r = await post({ variant_id: VAR, mode: 'REMOVE', quantity: 99 });
  ok('400 passed through', r.statusCode, 400);
  okTrue('the remedy survives', /use a recount/.test(body(r).error));
}

console.log('\n6. the page never computes the stored delta itself');
{
  const html = readFileSync('./admin.html', 'utf8');
  const fnSrc = html.match(/async function postAdjustment[\s\S]*?\n}/)[0];
  okTrue('postAdjustment posts `quantity`', /quantity:\s*n\b/.test(fnSrc));
  okTrue('and never posts a `delta` field', !/delta:/.test(fnSrc));
  okTrue('a preview function exists to show the effect first',
    /function renderAdjustPreview/.test(html));
  okTrue('and it warns the movement cannot be deleted',
    /cannot be deleted|can't be deleted/i.test(html));
}

console.log(`\n${fail ? `${fail} FAILED, ` : ''}${pass} passed.`);
process.exit(fail ? 1 : 0);
