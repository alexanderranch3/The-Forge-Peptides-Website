// Tests webauthn.js + _webauthn.js — Face ID login for the dashboard.
// No network: fetch and the database are stubbed. Run with `node test-webauthn.mjs`.
//
// 🚨 THIS IS THE ONE UNAUTHENTICATED PATH THAT HANDS OUT AN ADMIN TOKEN, so the
// tests are written as attacks rather than as a happy path with a few extras:
// replay the same assertion twice, sign with the wrong key, claim a different
// origin, claim a different site, present a registration signature as a login,
// and turn off the "user verified" bit so Face ID is decorative. Every one must
// come back 401 and hand out nothing.
//
// A real P-256 keypair stands in for the Secure Enclave: the test signs exactly
// the bytes an authenticator signs, so a passing signature here is a genuine
// ECDSA verification, not a stub agreeing with itself.
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
process.env.WEBAUTHN_RP_ID = 'theforgepeptides.com';
process.env.WEBAUTHN_ORIGIN = 'https://theforgepeptides.com';

const wa = require('./netlify/functions/_webauthn.js');
const { verifyToken } = require('./netlify/functions/_auth-token.js');
const b64u = (b) => Buffer.from(b).toString('base64url');

// ── A stand-in Secure Enclave ────────────────────────────────────────────────
const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const SPKI = publicKey.export({ type: 'spki', format: 'der' });
const CRED_ID = b64u(crypto.randomBytes(32));

const RP_HASH = crypto.createHash('sha256').update('theforgepeptides.com').digest();
function authData({ rpHash = RP_HASH, uv = true, up = true, signCount = 0 } = {}) {
  const b = Buffer.alloc(37);
  rpHash.copy(b, 0);
  b.writeUInt8((up ? 0x01 : 0) | (uv ? 0x04 : 0), 32);
  b.writeUInt32BE(signCount, 33);
  return b;
}
function clientData({ challenge, type = 'webauthn.get', origin = 'https://theforgepeptides.com' }) {
  return b64u(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}
function sign(ad, cdj, key = privateKey) {
  const signed = Buffer.concat([ad, crypto.createHash('sha256').update(Buffer.from(cdj, 'base64url')).digest()]);
  return b64u(crypto.sign('sha256', signed, key)); // DER, as WebAuthn sends
}

// ── Database stub ────────────────────────────────────────────────────────────
let challenges = new Map();      // challenge -> purpose
let credentials = [];
let calls = [];

global.fetch = async (url, opts = {}) => {
  const u = String(url); const method = opts.method || 'GET';
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ u, method, body });
  const json = (v) => ({ ok: true, status: 200, text: async () => JSON.stringify(v) });

  if (u.includes('webauthn_challenges')) {
    if (method === 'POST') { challenges.set(body.challenge, body.purpose); return json([]); }
    if (method === 'DELETE') {
      const m = /challenge=eq\.([^&]+)/.exec(u);
      if (!m) return json([]);                       // the expiry sweep
      const ch = decodeURIComponent(m[1]);
      const pm = /purpose=eq\.([^&]+)/.exec(u);
      const want = pm ? decodeURIComponent(pm[1]) : null;
      // 🚨 The single-use property: delete returns a row only the first time.
      if (challenges.has(ch) && (!want || challenges.get(ch) === want)) {
        challenges.delete(ch);
        return json([{ challenge: ch }]);
      }
      return json([]);
    }
  }
  if (u.includes('webauthn_credentials')) {
    if (method === 'POST') { credentials.push(body); return json([]); }
    if (method === 'PATCH' || method === 'DELETE') return json([]);
    const m = /credential_id=eq\.([^&]+)/.exec(u);
    if (m) {
      const id = decodeURIComponent(m[1]);
      return json(credentials.filter((c) => c.credential_id === id).map((c) => ({ id: 'row-1', ...c })));
    }
    // 🔑 Honour `select=` the way PostgREST does. Without this the stub hands
    // back every column regardless, and the "no key is ever sent to the page"
    // assertion below would be testing the stub instead of the endpoint.
    const sel = /select=([^&]+)/.exec(u);
    const rows = credentials.map((c) => ({ id: 'row-1', ...c }));
    if (!sel) return json(rows);
    const cols = decodeURIComponent(sel[1]).split(',');
    return json(rows.map((r) => Object.fromEntries(cols.filter((k) => k in r).map((k) => [k, r[k]]))));
  }
  return json([]);
};

const fn = require('./netlify/functions/webauthn.js');
const tok = () => {
  const p = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  return `${p}.${crypto.createHmac('sha256', SECRET).update(p).digest('base64url')}`;
};
const auth = { authorization: `Bearer ${tok()}` };
const get = (qs, headers = {}) => fn.handler({ httpMethod: 'GET', headers, queryStringParameters: qs });
const post = (body, headers = {}) => fn.handler({ httpMethod: 'POST', headers, body: JSON.stringify(body) });

const getLoginChallenge = async () => JSON.parse((await get({ action: 'options', mode: 'login' })).body).challenge;

// ── Registration ─────────────────────────────────────────────────────────────
console.log('\n— registering a passkey requires an existing session —');
ok('options for register without a token is 401', (await get({ action: 'options', mode: 'register' })).statusCode, 401);
ok('register without a token is 401', (await post({ action: 'register' })).statusCode, 401);
ok('listing devices without a token is 401', (await get({ action: 'list' })).statusCode, 401);

let opts = JSON.parse((await get({ action: 'options', mode: 'register' }, auth)).body);
okTrue('a register challenge is issued', !!opts.challenge);
ok('user verification is REQUIRED, so Face ID must pass', opts.authenticatorSelection.userVerification, 'required');
ok('platform authenticator — the key stays in this device', opts.authenticatorSelection.authenticatorAttachment, 'platform');

let cdj = clientData({ challenge: opts.challenge, type: 'webauthn.create' });
let res = await post({
  action: 'register', credentialId: CRED_ID, publicKey: b64u(SPKI), algorithm: -7,
  clientDataJSON: cdj, authenticatorData: b64u(authData()), label: 'Frank iPhone',
}, auth);
ok('registration succeeds', res.statusCode, 200);
ok('and the credential is stored', credentials.length, 1);

console.log('\n— 🚨 a registration challenge cannot be spent twice —');
res = await post({
  action: 'register', credentialId: b64u(crypto.randomBytes(32)), publicKey: b64u(SPKI), algorithm: -7,
  clientDataJSON: cdj, authenticatorData: b64u(authData()),
}, auth);
ok('replay is refused', res.statusCode, 400);
ok('and nothing extra was stored', credentials.length, 1);

// ── Login: the happy path ────────────────────────────────────────────────────
console.log('\n— Face ID login —');
let ch = await getLoginChallenge();
let ad = authData(); cdj = clientData({ challenge: ch });
res = await post({ action: 'login', credentialId: CRED_ID, clientDataJSON: cdj, authenticatorData: b64u(ad), signature: sign(ad, cdj) });
let body = JSON.parse(res.body);
ok('200', res.statusCode, 200);
okTrue('🔑 and it hands back a REAL admin token', verifyToken(SECRET, body.token));

// ── Login: the attacks ───────────────────────────────────────────────────────
console.log('\n— 🚨 every one of these must be a flat 401 —');

// Replay the exact assertion that just worked.
res = await post({ action: 'login', credentialId: CRED_ID, clientDataJSON: cdj, authenticatorData: b64u(ad), signature: sign(ad, cdj) });
ok('🚨 REPLAY of a good assertion', res.statusCode, 401);
okTrue('  …and no token leaked', !JSON.parse(res.body).token);

// Signed by a different key.
const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
ch = await getLoginChallenge(); ad = authData(); cdj = clientData({ challenge: ch });
res = await post({ action: 'login', credentialId: CRED_ID, clientDataJSON: cdj, authenticatorData: b64u(ad), signature: sign(ad, cdj, other) });
ok('🚨 signature from the WRONG KEY', res.statusCode, 401);

// A phishing origin.
ch = await getLoginChallenge(); ad = authData(); cdj = clientData({ challenge: ch, origin: 'https://theforgepeptides.evil.com' });
res = await post({ action: 'login', credentialId: CRED_ID, clientDataJSON: cdj, authenticatorData: b64u(ad), signature: sign(ad, cdj) });
ok('🚨 a look-alike ORIGIN', res.statusCode, 401);

// A credential minted for another site.
ch = await getLoginChallenge();
ad = authData({ rpHash: crypto.createHash('sha256').update('someoneelse.com').digest() });
cdj = clientData({ challenge: ch });
res = await post({ action: 'login', credentialId: CRED_ID, clientDataJSON: cdj, authenticatorData: b64u(ad), signature: sign(ad, cdj) });
ok('🚨 a credential for a DIFFERENT SITE', res.statusCode, 401);

// 🚨 The one that would make Face ID decorative: present but not verified.
ch = await getLoginChallenge(); ad = authData({ uv: false }); cdj = clientData({ challenge: ch });
res = await post({ action: 'login', credentialId: CRED_ID, clientDataJSON: cdj, authenticatorData: b64u(ad), signature: sign(ad, cdj) });
ok('🚨 user PRESENT but not VERIFIED — a tap, not a face', res.statusCode, 401);

// A registration signature offered as a login.
ch = await getLoginChallenge(); ad = authData(); cdj = clientData({ challenge: ch, type: 'webauthn.create' });
res = await post({ action: 'login', credentialId: CRED_ID, clientDataJSON: cdj, authenticatorData: b64u(ad), signature: sign(ad, cdj) });
ok('🚨 a REGISTRATION assertion replayed into login', res.statusCode, 401);

// A challenge we never issued.
ad = authData(); cdj = clientData({ challenge: b64u(crypto.randomBytes(32)) });
res = await post({ action: 'login', credentialId: CRED_ID, clientDataJSON: cdj, authenticatorData: b64u(ad), signature: sign(ad, cdj) });
ok('🚨 a challenge we never issued', res.statusCode, 401);

// An unknown credential id.
ch = await getLoginChallenge(); ad = authData(); cdj = clientData({ challenge: ch });
res = await post({ action: 'login', credentialId: b64u(crypto.randomBytes(32)), clientDataJSON: cdj, authenticatorData: b64u(ad), signature: sign(ad, cdj) });
ok('🚨 an unregistered credential', res.statusCode, 401);

console.log('\n— and the error never says WHICH check failed —');
const msgs = new Set();
for (const t of [{}, { credentialId: CRED_ID }]) msgs.add(JSON.parse((await post({ action: 'login', ...t })).body).error);
okTrue('every rejection is the same flat message', msgs.size === 1 && [...msgs][0] === 'Unauthorized', [...msgs].join(' / '));

// ── Housekeeping ─────────────────────────────────────────────────────────────
console.log('\n— devices —');
body = JSON.parse((await get({ action: 'list' }, auth)).body);
ok('the device is listed', body.devices.length, 1);
okTrue('🚨 and the list never carries a public key or credential id',
  !JSON.stringify(body).includes(b64u(SPKI)) && !JSON.stringify(body).includes(CRED_ID));
ok('removing a device needs a token', (await post({ action: 'remove', id: 'row-1' })).statusCode, 401);
ok('with one it works', (await post({ action: 'remove', id: 'row-1' }, auth)).statusCode, 200);

console.log('\n— with nothing enrolled, the page is told so —');
credentials = [];
body = JSON.parse((await get({ action: 'options', mode: 'login' })).body);
ok('available:false rather than a challenge that cannot work', body.available, false);

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
