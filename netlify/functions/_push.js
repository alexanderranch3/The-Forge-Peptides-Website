// ─────────────────────────────────────────────────────────────────────────────
// _push.js — Web Push, implemented on Node's own crypto and nothing else.
//
// 🔑 WHY THIS IS HAND-ROLLED RATHER THAN `npm i web-push`. netlify.toml states
// the rule plainly: "this repo has no package.json and no dependencies to
// install, and a monitor should not be the thing that introduces a build step."
// A push notification is not a good enough reason to break that either. Every
// primitive below is in node:crypto — ECDH P-256, HKDF, AES-128-GCM, ECDSA.
//
// 🚨 THE PART THAT MUST NOT BE "PROBABLY RIGHT": the payload encryption is
// RFC 8291, and it is verified against that RFC's own published test vector in
// test-push.mjs. Crypto that is merely plausible is crypto that fails silently
// on someone else's push service. If you change anything here, run that test.
//
//   RFC 8291 — Message Encryption for Web Push (aes128gcm)
//   RFC 8292 — VAPID: Voluntary Application Server Identification
//   RFC 8188 — Encrypted Content-Encoding (the aes128gcm framing)
//
// Apple's push service accepts standard VAPID + aes128gcm, so iOS needs no
// special case here — what it needs is the PWA to be on the Home Screen, which
// is a client-side constraint, not a server one. See admin-sw.js.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
// RFC 8292 wants a contact for whoever runs the application server, so a push
// service has someone to reach about a misbehaving sender.
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:alexanderranch3@gmail.com';

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function configured() {
  return Boolean(VAPID_PUBLIC && VAPID_PRIVATE);
}

// ── P-256 key handling ───────────────────────────────────────────────────────
// Raw uncompressed points (0x04 || X || Y) are what the Push API hands out and
// what VAPID puts on the wire; Node wants a KeyObject. JWK is the bridge, and
// it avoids hand-assembling DER.
function privateKeyFromRaw(rawPrivate, rawPublic) {
  const pub = Buffer.from(rawPublic);
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error('public key must be a 65-byte uncompressed P-256 point');
  return crypto.createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC', crv: 'P-256',
      x: b64url(pub.subarray(1, 33)),
      y: b64url(pub.subarray(33, 65)),
      d: b64url(rawPrivate),
    },
  });
}

// ── VAPID (RFC 8292) ─────────────────────────────────────────────────────────
// A JWT proving the sender controls the key the subscription was created with.
// `aud` is the ORIGIN of the push endpoint, not the whole URL — getting that
// wrong is a 401 from the push service with no other explanation.
function vapidHeaders(endpoint) {
  const aud = new URL(endpoint).origin;
  const header  = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64url(JSON.stringify({
    aud,
    // 12 hours. RFC 8292 caps it at 24; well short of the limit costs nothing
    // and keeps a leaked token short-lived.
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: VAPID_SUBJECT,
  }));
  const signingInput = `${header}.${payload}`;

  // 🔑 ieee-p1363, NOT der. JOSE wants the raw r||s pair; Node's default is a
  // DER SEQUENCE, which every push service rejects as a bad signature.
  const sig = crypto.sign('sha256', Buffer.from(signingInput), {
    key: privateKeyFromRaw(unb64url(VAPID_PRIVATE), unb64url(VAPID_PUBLIC)),
    dsaEncoding: 'ieee-p1363',
  });

  return {
    Authorization: `vapid t=${signingInput}.${b64url(sig)}, k=${VAPID_PUBLIC}`,
  };
}

// ── Payload encryption (RFC 8291 §3.3) ───────────────────────────────────────
// Exported with explicit salt/keys so the RFC's test vector can be reproduced
// exactly; sendPush() below calls it with random ones.
function encrypt(plaintext, uaPublicRaw, authSecret, asPrivateRaw, asPublicRaw, salt, recordSize = 4096) {
  const uaPublic = Buffer.from(uaPublicRaw);
  const asPublic = Buffer.from(asPublicRaw);

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(asPrivateRaw));
  const sharedSecret = ecdh.computeSecret(uaPublic);

  // Two-stage HKDF. The first stage mixes in BOTH public keys, which is what
  // binds the ciphertext to this exact subscription rather than to any holder
  // of the shared secret.
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic,
  ]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, Buffer.from(authSecret), keyInfo, 32));
  const cek   = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));

  // One record, so the delimiter is 0x02 ("last"). 0x01 here would tell the
  // client to expect another record that never arrives.
  const record = Buffer.concat([Buffer.from(plaintext, 'utf8'), Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body   = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

  // RFC 8188 header: salt(16) || rs(4, big-endian) || idlen(1) || keyid
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(recordSize, 16);
  header.writeUInt8(asPublic.length, 20);

  return Buffer.concat([header, asPublic, body]);
}

// ── Send ─────────────────────────────────────────────────────────────────────
// Returns { ok, status, gone }. `gone` means the push service says this
// subscription is dead (404/410) — the caller should delete it rather than
// retry forever. Everything else is reported, never thrown: a notification
// failing must not take an order down with it.
async function sendPush(subscription, payload, { ttl = 86400, urgency = 'high' } = {}) {
  if (!configured()) return { ok: false, status: 0, gone: false, error: 'VAPID keys not configured' };

  const endpoint = subscription.endpoint;
  const salt = crypto.randomBytes(16);
  const eph  = crypto.createECDH('prime256v1');
  eph.generateKeys();

  const body = encrypt(
    typeof payload === 'string' ? payload : JSON.stringify(payload),
    unb64url(subscription.p256dh),
    unb64url(subscription.auth),
    eph.getPrivateKey(),
    eph.getPublicKey(),
    salt,
  );

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...vapidHeaders(endpoint),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(ttl),
        Urgency: urgency,
      },
      body,
    });
    if (res.ok) return { ok: true, status: res.status, gone: false };
    const text = await res.text().catch(() => '');
    return {
      ok: false, status: res.status,
      gone: res.status === 404 || res.status === 410,
      error: `push service ${res.status}: ${text.slice(0, 200)}`,
    };
  } catch (err) {
    return { ok: false, status: 0, gone: false, error: err.message };
  }
}

// Generates a VAPID keypair. Used by tools/gen-vapid.mjs, never at request time.
function generateVapidKeys() {
  const ec = crypto.createECDH('prime256v1');
  ec.generateKeys();
  return { publicKey: b64url(ec.getPublicKey()), privateKey: b64url(ec.getPrivateKey()) };
}

module.exports = {
  configured, sendPush, encrypt, vapidHeaders, generateVapidKeys,
  b64url, unb64url, privateKeyFromRaw,
  publicKey: () => VAPID_PUBLIC,
};
