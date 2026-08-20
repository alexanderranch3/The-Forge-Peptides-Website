// Tests set-house-account.js and the house-account GATE in create-order.js.
// No network: fetch is stubbed. Run with `node test-house-account-grants.mjs`.
//
// WHAT THESE ASSERT, and why:
//  • 🚨 The gate is in create-order.js, not just in the page. A rule enforced
//    only by a hidden <option> is not enforced — the endpoint is reachable
//    directly and the page can be stale about who was revoked five minutes ago.
//  • A brand-new customer cannot be started on a tab: there is nobody to have
//    granted credit to yet, and create_manual_order would insert the party and
//    the charge in the same breath.
//  • Revoking clears the credit limit but NEVER the debt.
//  • The gate FAILS CLOSED. Everywhere else in create-order.js a wobble must
//    not stop a sale, but this is extending credit, not taking money.
//  • Being over the credit limit does NOT block — it is a warning at the
//    counter, not a refusal.
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

const setHouse    = require('./netlify/functions/set-house-account.js');
const createOrder = require('./netlify/functions/create-order.js');

const ALLOWED = '11111111-1111-1111-1111-111111111111';
const DENIED  = '22222222-2222-2222-2222-222222222222';
const MERGED  = '33333333-3333-3333-3333-333333333333';
const SURVIVOR= '44444444-4444-4444-4444-444444444444';
const VARIANT = '55555555-5555-5555-5555-555555555555';

let routes = {};
let calls = [];
global.fetch = async (url, opts = {}) => {
  calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
  for (const [frag, handler] of Object.entries(routes)) {
    if (url.includes(frag)) {
      const r = typeof handler === 'function' ? await handler(url, opts) : handler;
      return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body) };
    }
  }
  return { ok: false, status: 404, text: async () => JSON.stringify({ message: 'no route' }) };
};

const PARTIES = {
  [ALLOWED]:  { id: ALLOWED,  display_name: 'Yader Simpson', merged_into_id: null, house_account_enabled: true,  house_account_limit_cents: 30000 },
  [DENIED]:   { id: DENIED,   display_name: 'Cary Swett',    merged_into_id: null, house_account_enabled: false, house_account_limit_cents: null },
  [MERGED]:   { id: MERGED,   display_name: 'Frank (dupe)',  merged_into_id: SURVIVOR, house_account_enabled: false, house_account_limit_cents: null },
};

function defaultRoutes() {
  return {
    'parties?select': (url) => {
      const m = url.match(/id=eq\.([0-9a-f-]+)/i);
      const p = m && PARTIES[m[1]];
      return { status: 200, body: p ? [p] : [] };
    },
    'v_house_account_balance': (url) => {
      const m = url.match(/party_id=eq\.([0-9a-f-]+)/i);
      return { status: 200, body: m && m[1] === ALLOWED ? [{ balance_cents: 14400 }] : [] };
    },
    'rpc/create_manual_order': { status: 200, body: { created: true, order_no: 'FP-001200', total_cents: 16000 } },
  };
}

const grant = (body) => setHouse.handler({ httpMethod: 'POST', headers: auth, body: JSON.stringify(body) });
const sale = (extra) => createOrder.handler({
  httpMethod: 'POST', headers: auth,
  body: JSON.stringify({
    client_uid: 'pos-test-1', purpose: 'SALE', payment_state: 'PAID', channel: 'POS',
    lines: [{ variant_id: VARIANT, quantity: 1, unit_price_cents: 16000, name: 'Retatrutide 10mg' }],
    ...extra,
  }),
});

// ── set-house-account ────────────────────────────────────────────────────────
console.log('\n— giving someone an account —');
routes = defaultRoutes(); calls = [];
routes['parties?id=eq.'] = (url, opts) => ({ status: 200, body: [{
  id: DENIED, display_name: 'Cary Swett',
  house_account_enabled: JSON.parse(opts.body).house_account_enabled,
  house_account_limit_cents: JSON.parse(opts.body).house_account_limit_cents ?? null,
}] });
let res = await grant({ party_id: DENIED, enabled: true, limit_cents: 25000 });
let body = JSON.parse(res.body);
ok('200', res.statusCode, 200);
ok('now allowed', body.enabled, true);
ok('with a limit', body.limit_cents, 25000);
ok('and it says what changed', body.was_enabled, false);
okTrue('a PATCH was actually sent', calls.some((c) => c.method === 'PATCH'));

console.log('\n— 🚨 taking it away clears the LIMIT, never the DEBT —');
routes = defaultRoutes(); calls = [];
routes['parties?id=eq.'] = (url, opts) => {
  const patch = JSON.parse(opts.body);
  return { status: 200, body: [{ id: ALLOWED, display_name: 'Yader Simpson',
    house_account_enabled: patch.house_account_enabled,
    house_account_limit_cents: patch.house_account_limit_cents ?? null }] };
};
res = await grant({ party_id: ALLOWED, enabled: false });
body = JSON.parse(res.body);
ok('no longer allowed', body.enabled, false);
ok('limit cleared',     body.limit_cents, null);
// 🚨 The debt is reported back precisely so the page can say it out loud.
ok('the debt is reported, not cleared', body.owed_cents, 14400);
const patched = calls.find((c) => c.method === 'PATCH').body;
okTrue('nothing about tenders, orders or payments is touched',
  Object.keys(patched).every((k) => ['house_account_enabled', 'house_account_limit_cents', 'updated_at'].includes(k)));

console.log('\n— refusals —');
routes = defaultRoutes();
ok('no token', (await setHouse.handler({ httpMethod: 'POST', headers: {}, body: '{}' })).statusCode, 401);
ok('GET is not how you change credit', (await setHouse.handler({ httpMethod: 'GET', headers: auth })).statusCode, 405);
ok('a junk id',   (await grant({ party_id: 'not-a-uuid', enabled: true })).statusCode, 400);
ok('no decision', (await grant({ party_id: DENIED })).statusCode, 400);
ok('a stranger',  (await grant({ party_id: '99999999-9999-9999-9999-999999999999', enabled: true })).statusCode, 404);

// 🔑 A merged-away duplicate is not a person any more — its tab belongs to the
// survivor, so granting the dead row would grant nobody and look like it worked.
res = await grant({ party_id: MERGED, enabled: true });
ok('a merged duplicate', res.statusCode, 409);
ok('and it names the survivor', JSON.parse(res.body).merged_into_id, SURVIVOR);

// A decimal point in the wrong place is the realistic failure, not malice.
ok('a $200,000 credit limit', (await grant({ party_id: DENIED, enabled: true, limit_cents: 20000000 })).statusCode, 400);
ok('a negative limit',        (await grant({ party_id: DENIED, enabled: true, limit_cents: -5 })).statusCode, 400);

console.log('\n— before migration 028, it says which migration —');
routes = defaultRoutes();
routes['parties?select'] = { status: 400, body: { message: 'column parties.house_account_enabled does not exist' } };
res = await grant({ party_id: DENIED, enabled: true });
ok('503, not a raw Postgres error', res.statusCode, 503);
okTrue('and it names the file', /028/.test(JSON.parse(res.body).hint || ''));

// ── The gate in create-order.js ──────────────────────────────────────────────
console.log('\n— 🚨 the gate lives in create-order.js, not in the page —');
routes = defaultRoutes(); calls = [];
res = await sale({ tender_type: 'HOUSE_ACCOUNT', party_id: ALLOWED });
ok('an allowed customer goes on the tab', res.statusCode, 200);
okTrue('and the order was actually written',
  calls.some((c) => c.url.includes('rpc/create_manual_order')));

routes = defaultRoutes(); calls = [];
res = await sale({ tender_type: 'HOUSE_ACCOUNT', party_id: DENIED });
ok('a customer without an account is refused', res.statusCode, 403);
okTrue('by name', /Cary Swett/.test(JSON.parse(res.body).error));
okTrue('with what to do about it', /Customers tab|take payment/i.test(JSON.parse(res.body).hint || ''));
// 🚨 The order must not exist. A refusal that still wrote the sale would be
// worse than no gate at all.
okTrue('and NOTHING was written', !calls.some((c) => c.url.includes('rpc/create_manual_order')));

console.log('\n— the same customer can still buy, just not on credit —');
routes = defaultRoutes(); calls = [];
res = await sale({ tender_type: 'ZELLE', party_id: DENIED });
ok('a paid sale is unaffected', res.statusCode, 200);
okTrue('and it was written', calls.some((c) => c.url.includes('rpc/create_manual_order')));
// The gate must not run at all for an ordinary sale — a till that needs a
// permission lookup to take cash is a till that stops when Supabase hiccups.
okTrue('no permission lookup on a paid sale', !calls.some((c) => c.url.includes('parties?select')));

console.log('\n— 🚨 a brand-new customer cannot be started on a tab —');
routes = defaultRoutes(); calls = [];
res = await sale({ tender_type: 'HOUSE_ACCOUNT', customer: { name: 'Walk-in Wanda' } });
ok('refused', res.statusCode, 403);
okTrue('and it offers both ways out', /paid|Customers tab/i.test(JSON.parse(res.body).hint || ''));
okTrue('nothing written', !calls.some((c) => c.url.includes('rpc/create_manual_order')));

console.log('\n— 🚨 the gate fails CLOSED —');
// Everywhere else in create-order.js a Supabase wobble must not stop a sale.
// This is not taking money, it is extending credit, so silence means no.
routes = defaultRoutes(); calls = [];
routes['parties?select'] = { status: 500, body: { message: 'boom' } };
res = await sale({ tender_type: 'HOUSE_ACCOUNT', party_id: ALLOWED });
ok('unreadable permission refuses the credit', res.statusCode, 502);
okTrue('and says the sale was not recorded', /not recorded/i.test(JSON.parse(res.body).error));
okTrue('nothing written', !calls.some((c) => c.url.includes('rpc/create_manual_order')));

routes = defaultRoutes(); calls = [];
routes['parties?select'] = { status: 400, body: { message: 'column parties.house_account_enabled does not exist' } };
res = await sale({ tender_type: 'HOUSE_ACCOUNT', party_id: ALLOWED });
ok('a missing migration is a refusal too', res.statusCode, 503);
okTrue('naming 028', /028/.test(JSON.parse(res.body).hint || ''));

console.log('\n— being over the limit warns, it does not refuse —');
// Frank standing in front of a customer is better placed to make that call
// than a column is. Yader owes $144.00 against a $300.00 limit here; even a
// breach must still sell.
routes = defaultRoutes(); calls = [];
routes['v_house_account_balance'] = { status: 200, body: [{ balance_cents: 99999 }] };
res = await sale({ tender_type: 'HOUSE_ACCOUNT', party_id: ALLOWED });
ok('still sells', res.statusCode, 200);

console.log('\n— a house account is only for a SALE —');
routes = defaultRoutes(); calls = [];
res = await sale({ tender_type: 'HOUSE_ACCOUNT', party_id: ALLOWED, purpose: 'INTERNAL' });
ok('own use cannot go on a tab', res.statusCode, 400);
okTrue('nothing written', !calls.some((c) => c.url.includes('rpc/create_manual_order')));

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
