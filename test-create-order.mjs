// Tests for create-order.js (the POS endpoint). No network: fetch is stubbed.
import { createRequire } from 'module';
import crypto from 'crypto';
import { readFileSync } from 'fs';
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ok = (l, got, want) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${l}${good ? '' : `  got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  good ? pass++ : fail++;
};
const okTrue = (l, c) => ok(l, !!c, true);

const SECRET = 'test-secret';
process.env.ADMIN_TOKEN_SECRET = SECRET;
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'key';

const tok = (s = SECRET, sec = 3600) => {
  const p = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now()/1000) + sec })).toString('base64url');
  return `${p}.${crypto.createHmac('sha256', s).update(p).digest('base64url')}`;
};
const auth = () => ({ authorization: `Bearer ${tok()}` });

let routes = {}, calls = [];
global.fetch = async (url, opts = {}) => {
  calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
  for (const [f, h] of Object.entries(routes)) {
    if (url.includes(f)) {
      const r = typeof h === 'function' ? await h(opts) : h;
      return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body) };
    }
  }
  return { ok: false, status: 404, text: async () => '{}' };
};

const fn = require('./netlify/functions/create-order.js');
const V = '33333333-3333-3333-3333-333333333333';
const post = (b, h = auth()) => fn.handler({ httpMethod: 'POST', headers: h, body: JSON.stringify(b) });
const body = (r) => JSON.parse(r.body);
const base = { purpose: 'SALE', payment_state: 'PAID', client_uid: 'pos-1',
               lines: [{ variant_id: V, quantity: 2, unit_price_cents: 6200 }] };

console.log('\n1. auth and method');
ok('401 without a token', (await post(base, {})).statusCode, 401);
ok('405 on GET', (await fn.handler({ httpMethod: 'GET', headers: auth() })).statusCode, 405);

console.log('\n2. a sale goes through');
routes['rpc/create_manual_order'] = { status: 200, body: { order_id: 'o1', order_no: 'FP-000200', created: true, lines: 1, stock_rows: 1, total_cents: 12400 } };
{
  calls = [];
  const r = await post(base);
  ok('200', r.statusCode, 200);
  ok('order number returned', body(r).order_no, 'FP-000200');
  const sent = calls.find(c => c.url.includes('rpc/create_manual_order')).body.p;
  ok('purpose forwarded', sent.purpose, 'SALE');
  ok('money stays in cents', sent.lines[0].unit_price_cents, 6200);
  // 🔑 The retry guard.
  ok('client_uid forwarded', sent.client_uid, 'pos-1');
}

console.log('\n3. rule 5 — purpose is required, never assumed');
{
  ok('missing purpose is refused', (await post({ ...base, purpose: undefined })).statusCode, 400);
  okTrue('and it asks the actual question',
    /own use|give-away|sale/i.test(body(await post({ ...base, purpose: undefined })).error));
  ok('an unknown purpose is refused', (await post({ ...base, purpose: 'REVENUE' })).statusCode, 400);
  ok('INTERNAL is accepted', (await post({ ...base, purpose: 'INTERNAL' })).statusCode, 200);
  ok('COMP is accepted', (await post({ ...base, purpose: 'COMP' })).statusCode, 200);
}

console.log('\n4. validation');
{
  ok('no lines', (await post({ ...base, lines: [] })).statusCode, 400);
  ok('a line with no product', (await post({ ...base, lines: [{ quantity: 1, unit_price_cents: 1 }] })).statusCode, 400);
  ok('a bad product id', (await post({ ...base, lines: [{ variant_id: 'x', quantity: 1, unit_price_cents: 1 }] })).statusCode, 400);
  ok('zero quantity', (await post({ ...base, lines: [{ variant_id: V, quantity: 0, unit_price_cents: 1 }] })).statusCode, 400);
  ok('absurd quantity', (await post({ ...base, lines: [{ variant_id: V, quantity: 5000, unit_price_cents: 1 }] })).statusCode, 400);
  ok('a fractional cent price', (await post({ ...base, lines: [{ variant_id: V, quantity: 1, unit_price_cents: 6.5 }] })).statusCode, 400);
  ok('a negative price', (await post({ ...base, lines: [{ variant_id: V, quantity: 1, unit_price_cents: -1 }] })).statusCode, 400);
  ok('a dollar-string price', (await post({ ...base, lines: [{ variant_id: V, quantity: 1, unit_price_cents: '62.00' }] })).statusCode, 400);
  ok('a negative discount', (await post({ ...base, discount_cents: -1 })).statusCode, 400);
  ok('too many lines', (await post({ ...base, lines: Array(101).fill(base.lines[0]) })).statusCode, 400);
  // A zero price is legal — that is what a comp IS.
  ok('a zero price is allowed', (await post({ ...base, purpose: 'COMP', lines: [{ variant_id: V, quantity: 1, unit_price_cents: 0 }] })).statusCode, 200);
}

console.log('\n5. the database has the last word');
{
  routes['rpc/create_manual_order'] = { status: 200, body: { created: false, order_no: 'FP-000200', message: 'This sale was already recorded.' } };
  const r = await post(base);
  ok('a repeat is reported, not duplicated', body(r).created, false);
  okTrue('and says so', /already recorded/.test(body(r).message));

  routes['rpc/create_manual_order'] = { status: 400, body: { message: 'line 1: pick a product' } };
  okTrue('refusals surface verbatim', /pick a product/.test(body(await post(base)).error));
}

console.log('\n6. the page generates one id per sale, not per click');
{
  const html = readFileSync('./admin.html', 'utf8');
  const open = html.match(/function openSale\(\)[\s\S]*?\n}/)[0];
  const record = html.match(/async function recordSale\(\)[\s\S]*?\n}/)[0];
  okTrue('openSale mints the id', /saleUid\s*=\s*'pos-'/.test(open));
  okTrue('recordSale reuses it rather than minting a new one', !/saleUid\s*=\s*'pos-'/.test(record));
  okTrue('and sends it', /client_uid:\s*saleUid/.test(record));
  okTrue('the till warns stock cannot be un-posted', /cannot be deleted/i.test(html));
}

console.log('\n7. party_id — picking an existing customer, not retyping them');
{
  const P = '44444444-4444-4444-4444-444444444444';
  routes['rpc/create_manual_order'] = { status: 200, body: { order_id: 'o2', order_no: 'FP-000201', created: true, lines: 1, stock_rows: 1, total_cents: 12400 } };

  calls = [];
  await post({ ...base, party_id: P, customer: { name: null, email: null, phone: null } });
  const sent = calls.find(c => c.url.includes('rpc/create_manual_order')).body.p;
  ok('party_id reaches the RPC', sent.party_id, P);

  // 🔑 The whole point: with an id present the DB must not fall back to
  // email-matching, which is what was inserting a duplicate party per sale.
  ok('no name is sent alongside it', sent.customer.name, null);
  ok('no email is sent alongside it', sent.customer.email, null);

  calls = [];
  await post({ ...base, customer: { name: 'Walk In', email: 'w@example.com', phone: null } });
  const anon = calls.find(c => c.url.includes('rpc/create_manual_order')).body.p;
  ok('a new customer still sends party_id null', anon.party_id, null);
  ok('and their typed details survive', anon.customer.name, 'Walk In');

  ok('a malformed party_id is refused', (await post({ ...base, party_id: 'not-a-uuid' })).statusCode, 400);
  okTrue('and says what to do about it',
    /pick again/i.test(body(await post({ ...base, party_id: 'not-a-uuid' })).error));
}

console.log('\n8. the picker cannot block a sale');
{
  const html = readFileSync('./admin.html', 'utf8');
  const record = html.match(/async function recordSale\(\)[\s\S]*?\n}/)[0];
  okTrue('recordSale sends the picked id', /party_id:\s*salePartyId/.test(record));
  okTrue('and suppresses the typed fields when one is picked', /salePartyId\s*\?\s*\{\s*name:\s*null/.test(record));

  const render = html.match(/function renderCustomerOptions\(\)[\s\S]*?\n}/)[0];
  okTrue('a failed load degrades to the manual fields', /setNewCustomerVisible\(true\)/.test(render));
  okTrue('and says so rather than showing an empty customer base', /Could not load the customer list/.test(render));

  const open = html.match(/function openSale\(\)[\s\S]*?\n}/)[0];
  okTrue('opening a sale clears the previous customer', /salePartyId\s*=\s*null/.test(open));
  okTrue('and refetches so a just-added customer appears', /saleCustomersState\s*=\s*'idle'/.test(open));
}

console.log(`\n${fail ? `${fail} FAILED, ` : ''}${pass} passed.`);
process.exit(fail ? 1 : 0);
