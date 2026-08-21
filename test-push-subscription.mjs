// Tests save-push-subscription.js — where a device registers for order alerts.
// No network: fetch is stubbed. Run with `node test-push-subscription.mjs`.
//
// 🚨 THE PROPERTY THAT MATTERS MOST is the re-key path. It is the one entry
// point on this endpoint that accepts an UNAUTHENTICATED request, because a
// service worker handling `pushsubscriptionchange` runs with no page and no
// sessionStorage and therefore cannot present an admin token. It is allowed to
// do exactly one thing: swap an endpoint the server ALREADY KNOWS for a new
// one. If it could create a subscription from nothing, anyone who found the URL
// could register their own phone for every order alert. These tests pin that.
import { createRequire } from 'module';
import crypto from 'crypto';
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ok = (l, g, w) => { const good = JSON.stringify(g) === JSON.stringify(w);
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${l}${good ? '' : `  got ${JSON.stringify(g)}, want ${JSON.stringify(w)}`}`); good ? pass++ : fail++; };
const okTrue = (l, c, why = '') => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : '  ' + why}`); c ? pass++ : fail++; };

const SECRET = 'test-secret';
process.env.ADMIN_TOKEN_SECRET = SECRET;
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
// 🔑 _push.js reads the VAPID env at MODULE LOAD (as every function in this
// repo reads its config), so the keys must be in the environment before either
// module is required. Generate with a throwaway load, then drop both from the
// cache so the real requires below see a configured module.
const vapid = require('./netlify/functions/_push.js').generateVapidKeys();
process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
delete require.cache[require.resolve('./netlify/functions/_push.js')];
delete require.cache[require.resolve('./netlify/functions/save-push-subscription.js')];

const makeToken = (secret) => {
  const p = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  return `${p}.${crypto.createHmac('sha256', secret).update(p).digest('base64url')}`;
};
const auth = { authorization: `Bearer ${makeToken(SECRET)}` };

// A real-shaped subscription: 65-byte P-256 point, 16-byte auth secret.
const b64 = (b) => Buffer.from(b).toString('base64url');
const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
const SUB = {
  endpoint: 'https://web.push.apple.com/QAAA-frank-iphone',
  keys: { p256dh: b64(ua.getPublicKey()), auth: b64(crypto.randomBytes(16)) },
};

let calls = [];
let existingRows = [];   // what a SELECT on push_subscriptions returns
let pushOk = true;

global.fetch = async (url, opts = {}) => {
  const u = String(url); const method = opts.method || 'GET';
  calls.push({ u, method, body: opts.body && !Buffer.isBuffer(opts.body) ? JSON.parse(opts.body) : opts.body });
  if (u.includes('/rest/v1/push_subscriptions')) {
    if (method === 'GET') return { ok: true, status: 200, text: async () => JSON.stringify(existingRows) };
    return { ok: true, status: 200, text: async () => '' };
  }
  // the push service itself
  return pushOk
    ? { ok: true, status: 201, text: async () => '' }
    : { ok: false, status: 410, text: async () => 'gone' };
};

const fn = require('./netlify/functions/save-push-subscription.js');
const call = (body, { headers = auth, httpMethod = 'POST' } = {}) =>
  fn.handler({ httpMethod, headers, body: body === undefined ? undefined : JSON.stringify(body) });
const reset = () => { calls = []; existingRows = []; pushOk = true; };

// ── Auth ─────────────────────────────────────────────────────────────────────
console.log('\n— the normal paths need a token —');
reset();
ok('no token is 401', (await call({ subscription: SUB }, { headers: {} })).statusCode, 401);
ok('a wrong token is 401',
  (await call({ subscription: SUB }, { headers: { authorization: 'Bearer ' + makeToken('not-the-secret') } })).statusCode, 401);
ok('GET without a token is 401', (await fn.handler({ httpMethod: 'GET', headers: {} })).statusCode, 401);

// ── Subscribing ──────────────────────────────────────────────────────────────
console.log('\n— a device subscribes —');
reset();
let res = await call({ subscription: SUB, label: 'iPhone', userAgent: 'iPhone; CPU iPhone OS 18_0' });
let body = JSON.parse(res.body);
ok('200', res.statusCode, 200);
okTrue('saved', body.saved === true);
const upsert = calls.find((c) => c.u.includes('push_subscriptions') && c.method === 'POST');
okTrue('🔑 upserts on the endpoint, so re-opening the app cannot pile up rows',
  upsert && upsert.u.includes('on_conflict=endpoint'), upsert && upsert.u);
ok('stores the endpoint', upsert.body.endpoint, SUB.endpoint);
ok('stores the label', upsert.body.label, 'iPhone');
ok('resets the failure count', upsert.body.failures, 0);
okTrue('🔑 sends a confirmation push, so "it is on" is something you SEE',
  calls.some((c) => c.u === SUB.endpoint && c.method === 'POST'));
okTrue('and reports that it went', body.testSent === true);

console.log('\n— a confirmation push that fails is reported, not hidden —');
reset(); pushOk = false;
body = JSON.parse((await call({ subscription: SUB })).body);
okTrue('still saved', body.saved === true);
okTrue('🚨 but testSent is false and the reason is given', body.testSent === false && !!body.testError, JSON.stringify(body));

// ── Validation ───────────────────────────────────────────────────────────────
console.log('\n— a malformed subscription is refused BEFORE it is stored —');
// Storing a bad one means a send that fails later with no clue why.
reset();
const bad = async (label, sub) => {
  const r = await call({ subscription: sub });
  const refused = r.statusCode === 400;
  okTrue(label, refused, `got ${r.statusCode}`);
  if (refused) okTrue('  …and nothing was written', !calls.some((c) => c.method === 'POST' && c.u.includes('push_subscriptions')));
  calls = [];
};
await bad('an http endpoint', { ...SUB, endpoint: 'http://insecure.example/x' });
await bad('a p256dh that is not a P-256 point', { ...SUB, keys: { ...SUB.keys, p256dh: b64(Buffer.alloc(10)) } });
await bad('an auth secret of the wrong length', { ...SUB, keys: { ...SUB.keys, auth: b64(Buffer.alloc(8)) } });
reset();
ok('no subscription at all', (await call({})).statusCode, 400);

// ── 🚨 Re-key ────────────────────────────────────────────────────────────────
console.log('\n— 🚨 the unauthenticated re-key path —');
reset();
const NEW = { endpoint: 'https://web.push.apple.com/QBBB-rotated', keys: SUB.keys };

existingRows = [];
res = await call({ rekey: true, oldEndpoint: SUB.endpoint, subscription: NEW }, { headers: {} });
ok('🚨 REFUSED when the old endpoint is not on file — it cannot create a device', res.statusCode, 403);
okTrue('and wrote nothing', !calls.some((c) => c.method === 'POST' || c.method === 'PATCH'));

reset();
existingRows = [{ id: 'row-1', label: 'iPhone' }];
res = await call({ rekey: true, oldEndpoint: SUB.endpoint, subscription: NEW }, { headers: {} });
body = JSON.parse(res.body);
ok('allowed when it REPLACES a known endpoint', res.statusCode, 200);
okTrue('rekeyed', body.rekeyed === true);
const patch = calls.find((c) => c.method === 'PATCH');
okTrue('patches the existing row rather than inserting', patch && patch.u.includes('id=eq.row-1'), patch && patch.u);
ok('to the new endpoint', patch.body.endpoint, NEW.endpoint);
ok('and clears the failure count', patch.body.failures, 0);

reset();
existingRows = [{ id: 'row-1' }];
ok('a re-key with no oldEndpoint is refused',
  (await call({ rekey: true, subscription: NEW }, { headers: {} })).statusCode, 400);
reset();
existingRows = [{ id: 'row-1' }];
ok('🚨 a re-key still validates the new subscription',
  (await call({ rekey: true, oldEndpoint: SUB.endpoint, subscription: { ...NEW, endpoint: 'http://nope/' } }, { headers: {} })).statusCode, 400);

// ── Unsubscribe + GET ────────────────────────────────────────────────────────
console.log('\n— turning it off, and listing devices —');
reset();
res = await call({ unsubscribe: true, endpoint: SUB.endpoint });
ok('200', res.statusCode, 200);
okTrue('deletes by endpoint', calls.some((c) => c.method === 'DELETE' && c.u.includes('endpoint=eq.')));

reset();
existingRows = [{ id: 'row-1', label: 'iPhone', failures: 0 }];
body = JSON.parse((await fn.handler({ httpMethod: 'GET', headers: auth })).body);
ok('reports configured', body.configured, true);
ok('🔑 hands the page the PUBLIC key only', body.publicKey, vapid.publicKey);
okTrue('🚨 and never the private one', !JSON.stringify(body).includes(vapid.privateKey));
ok('lists the devices', body.devices.length, 1);

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
