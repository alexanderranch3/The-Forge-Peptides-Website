// Tests _push.js — the Web Push crypto. Run with `node test-push.mjs`.
//
// 🚨 THE POINT OF THIS FILE. _push.js hand-rolls RFC 8291 encryption instead of
// pulling in `web-push`, because netlify.toml forbids introducing a build step
// for something this small. That trade is only acceptable if the crypto is
// PROVEN rather than plausible — encryption that is subtly wrong does not throw,
// it just produces a payload the phone silently fails to decrypt, and the bug
// shows up as "notifications don't work" with nothing in any log.
//
// So the first test below is RFC 8291 §5's own published test vector: given the
// exact keys, salt and plaintext from the RFC, we must produce the exact bytes
// the RFC says. If that passes, the implementation is right — not by inspection,
// but by agreeing with the specification byte for byte.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ok = (label, got, want) => {
  const good = String(got) === String(want);
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${label}`);
  if (!good) { console.log(`        got  ${got}\n        want ${want}`); fail++; } else pass++;
};
const okTrue = (label, cond, why = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '   ' + why}`);
  cond ? pass++ : fail++;
};

process.env.VAPID_SUBJECT = 'mailto:test@theforgepeptides.com';
const push = require('./netlify/functions/_push.js');
const { b64url, unb64url } = push;

// ── 1. RFC 8291 §5 test vector ───────────────────────────────────────────────
console.log('\n— 🚨 RFC 8291 §5 test vector: our bytes must equal the RFC\'s bytes —');
const V = {
  plaintext:  'When I grow up, I want to be a watermelon',
  uaPublic:   'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  asPrivate:  'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic:   'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  salt:       'DGv6ra1nlYgDCS1FRnbzlw',
  // Verified against https://www.rfc-editor.org/rfc/rfc8291.txt §5, not from memory.
  expected:   'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

const outBuf = push.encrypt(
  V.plaintext, unb64url(V.uaPublic), unb64url(V.authSecret),
  unb64url(V.asPrivate), unb64url(V.asPublic), unb64url(V.salt), 4096,
);
const out = b64url(outBuf);
ok('the full aes128gcm body matches the RFC exactly', out, V.expected);

// The header framing, checked separately so a mismatch above says WHERE.
ok('header: salt is the first 16 bytes', b64url(outBuf.subarray(0, 16)), V.salt);
ok('header: record size is 4096',        outBuf.readUInt32BE(16), 4096);
ok('header: key id length is 65',        outBuf.readUInt8(20), 65);
ok('header: key id is the sender public key', b64url(outBuf.subarray(21, 86)), V.asPublic);
okTrue('body carries the 16-byte GCM tag',
  outBuf.length === 86 + V.plaintext.length + 1 + 16,
  `length ${outBuf.length}, expected ${86 + V.plaintext.length + 1 + 16}`);

// ── 2. It must actually round-trip ───────────────────────────────────────────
// The vector proves we agree with the RFC. This proves the ciphertext is
// genuinely decryptable by the receiver, which is what the phone will do.
console.log('\n— and a receiver can decrypt it (the phone\'s side of the exchange) —');
const crypto = require('crypto');
function decrypt(body, uaPrivateRaw, uaPublicRaw, authSecret) {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivateRaw);
  const shared = ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), Buffer.from(uaPublicRaw), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(authSecret), keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(tag);
  const plain = Buffer.concat([d.update(ciphertext.subarray(0, ciphertext.length - 16)), d.final()]);
  return plain.subarray(0, plain.length - 1).toString('utf8'); // strip 0x02 delimiter
}
// A fresh subscriber keypair, as a browser would create.
const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
const auth = crypto.randomBytes(16);
const as2 = crypto.createECDH('prime256v1'); as2.generateKeys();
const msg = JSON.stringify({ title: 'New order FP-001180', body: 'Christian Herrera — $230.00' });
const enc = push.encrypt(msg, ua.getPublicKey(), auth, as2.getPrivateKey(), as2.getPublicKey(), crypto.randomBytes(16));
ok('a real order notification round-trips', decrypt(enc, ua.getPrivateKey(), ua.getPublicKey(), auth), msg);

// Tamper with one byte: the GCM tag must reject it.
const bad = Buffer.from(enc); bad[bad.length - 20] ^= 0xff;
let threw = false;
try { decrypt(bad, ua.getPrivateKey(), ua.getPublicKey(), auth); } catch { threw = true; }
okTrue('🚨 a tampered payload is rejected, not silently accepted', threw);

// ── 3. VAPID (RFC 8292) ──────────────────────────────────────────────────────
console.log('\n— VAPID auth header —');
const keys = push.generateVapidKeys();
okTrue('generated a 65-byte public key', unb64url(keys.publicKey).length === 65);
okTrue('generated a 32-byte private key', unb64url(keys.privateKey).length === 32);

process.env.VAPID_PUBLIC_KEY = keys.publicKey;
process.env.VAPID_PRIVATE_KEY = keys.privateKey;
delete require.cache[require.resolve('./netlify/functions/_push.js')];
const push2 = require('./netlify/functions/_push.js');

okTrue('configured() true once keys are set', push2.configured());
const h = push2.vapidHeaders('https://web.push.apple.com/QAbc123/def');
const m = /^vapid t=([^,]+), k=(.+)$/.exec(h.Authorization);
okTrue('Authorization is a well-formed vapid header', !!m, h.Authorization);
const [jh, jp, js] = m[1].split('.');
ok('alg is ES256', JSON.parse(unb64url(jh)).alg, 'ES256');
const claims = JSON.parse(unb64url(jp));
// 🚨 aud is the ORIGIN, not the endpoint. A full URL here is a 401 from the
// push service with nothing in the response explaining why.
ok('🚨 aud is the endpoint ORIGIN only', claims.aud, 'https://web.push.apple.com');
ok('sub is a contact', claims.sub, 'mailto:test@theforgepeptides.com');
okTrue('exp is in the future and within RFC 8292\'s 24h cap',
  claims.exp > Math.floor(Date.now() / 1000) && claims.exp <= Math.floor(Date.now() / 1000) + 86400);
// 🚨 JOSE needs raw r||s (64 bytes). Node's default DER encoding is variable
// length and every push service rejects it.
ok('🚨 signature is raw r||s, 64 bytes — not DER', unb64url(js).length, 64);
ok('k is the public key', m[2], keys.publicKey);

const verified = crypto.verify('sha256', Buffer.from(`${jh}.${jp}`), {
  key: push2.privateKeyFromRaw(unb64url(keys.privateKey), unb64url(keys.publicKey)),
  dsaEncoding: 'ieee-p1363',
}, unb64url(js));
okTrue('and the signature actually verifies', verified);

// ── 4. Failure handling ──────────────────────────────────────────────────────
console.log('\n— failures are reported, never thrown —');
const sub = { endpoint: 'https://web.push.apple.com/x', p256dh: b64url(ua.getPublicKey()), auth: b64url(auth) };
const realFetch = global.fetch;
global.fetch = async () => ({ ok: false, status: 410, text: async () => 'gone' });
let r = await push2.sendPush(sub, { title: 'x' });
okTrue('410 is reported as gone, so the caller can delete it', r.gone === true && r.ok === false);
global.fetch = async () => ({ ok: false, status: 500, text: async () => 'oops' });
r = await push2.sendPush(sub, { title: 'x' });
okTrue('500 is a failure but NOT gone', r.ok === false && r.gone === false);
global.fetch = async () => { throw new Error('network down'); };
r = await push2.sendPush(sub, { title: 'x' });
okTrue('🚨 a network error returns instead of throwing — an order must not fail over a notification',
  r.ok === false && /network down/.test(r.error));
global.fetch = async () => ({ ok: true, status: 201, text: async () => '' });
r = await push2.sendPush(sub, { title: 'x' });
okTrue('a 201 is success', r.ok === true);
global.fetch = realFetch;

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
