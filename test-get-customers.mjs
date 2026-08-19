// Tests for get-customers.js (the New sale customer picker). No network: fetch is stubbed.
import { createRequire } from 'module';
import crypto from 'crypto';
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

let parties = [], orders = [], urls = [];
global.fetch = async (url) => {
  urls.push(url);
  const body = url.includes('/parties?') ? parties : url.includes('/orders?') ? orders : [];
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
};

const fn = require('./netlify/functions/get-customers.js');
const get = (h = auth()) => fn.handler({ httpMethod: 'GET', headers: h });
const body = (r) => JSON.parse(r.body);

const P1 = '11111111-1111-1111-1111-111111111111';
const P2 = '22222222-2222-2222-2222-222222222222';
const P3 = '33333333-3333-3333-3333-333333333333';

console.log('\n1. it is gated');
ok('401 without a token', (await get({})).statusCode, 401);
ok('401 with a token signed by someone else',
  (await get({ authorization: `Bearer ${tok('wrong-secret')}` })).statusCode, 401);
{
  // 🚨 This returns every customer's name, email and phone. If this test ever
  // fails, the customer list has been made public — stop and fix it.
  const r = await get({});
  okTrue('and leaks nothing in the refusal', !/@|phone/i.test(r.body));
}

console.log('\n2. what it asks Supabase for');
{
  urls = []; parties = []; orders = [];
  await get();
  const pq = urls.find(u => u.includes('/parties?'));
  const oq = urls.find(u => u.includes('/orders?'));
  okTrue('merged-away duplicates are excluded in the query, not the page',
    /merged_into_id=is\.null/.test(pq));
  okTrue('cancelled orders never date a customer\'s last purchase',
    /state=neq\.CANCELED/.test(oq));
}

console.log('\n3. order counts and last-order dates');
{
  parties = [
    { id: P1, display_name: 'George Cruz', email: 'g@example.com', phone: null, kind: 'CUSTOMER' },
    { id: P2, display_name: 'Never Ordered', email: null, phone: '555', kind: 'CUSTOMER' },
  ];
  orders = [
    { party_id: P1, placed_at: '2026-08-01', state: 'COMPLETED' },
    { party_id: P1, placed_at: '2026-08-19', state: 'COMPLETED' },
  ];
  const c = body(await get()).customers;
  const george = c.find(x => x.party_id === P1);
  ok('counts their orders', george.order_count, 2);
  ok('and takes the most recent date, not the last row seen', george.last_order_at, '2026-08-19');
  const nobody = c.find(x => x.party_id === P2);
  ok('a customer with no orders still appears', nobody.order_count, 0);
  ok('with a null last-order date', nobody.last_order_at, null);
}

console.log('\n4. ordering — the counter picks a returning buyer');
{
  parties = [
    { id: P1, display_name: 'Older',  email: null, phone: null, kind: 'CUSTOMER' },
    { id: P2, display_name: 'Newest', email: null, phone: null, kind: 'CUSTOMER' },
    { id: P3, display_name: 'Aaron Never', email: null, phone: null, kind: 'CUSTOMER' },
  ];
  orders = [
    { party_id: P1, placed_at: '2026-07-01', state: 'COMPLETED' },
    { party_id: P2, placed_at: '2026-08-19', state: 'COMPLETED' },
  ];
  const names = body(await get()).customers.map(c => c.name);
  ok('most recent buyer first', names[0], 'Newest');
  ok('then the older one', names[1], 'Older');
  ok('never-ordered sort last, whatever their name', names[2], 'Aaron Never');
}

console.log('\n5. the shape the picker relies on');
{
  parties = [{ id: P1, display_name: 'A', email: 'a@b.c', phone: '555', kind: 'CUSTOMER', notes: 'internal note' }];
  orders = [];
  const c = body(await get()).customers[0];
  ok('carries the party_id — the whole reason this endpoint exists', c.party_id, P1);
  okTrue('and the fields needed to tell two same-named people apart',
    'email' in c && 'phone' in c && 'kind' in c);
  okTrue('notes are NOT shipped to the browser', !('notes' in c));
  ok('count is reported alongside', body(await get()).count, 1);
}

console.log('\n6. failure is reported, never silently empty');
{
  global.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  const r = await get();
  ok('502 when Supabase is unhappy', r.statusCode, 502);
  okTrue('with an error the page can show', /Could not read the customer list/.test(body(r).error));
}

console.log(`\n${fail ? `${fail} FAILED, ` : ''}${pass} passed.`);
process.exit(fail ? 1 : 0);
