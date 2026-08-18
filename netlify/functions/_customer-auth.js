// Shared helper (NOT an endpoint). Passwordless customer sessions.
//
// 🚨 WHY THE BROWSER NEVER GETS A SUPABASE KEY. Checked against the live project
// on 2026-08-18: RLS is OFF on every table and there are ZERO policies. The anon
// key in a page would therefore expose all 52 parties, all 141 orders, every
// shipping address on fulfillments, and variant_costs -- the cost and margin data.
// So the browser talks only to these functions, which hold the service key. That
// keeps "anything exposing cost or margin is token-gated" a property of the
// architecture rather than a checklist that fails silently when one policy is
// missed. Do not "simplify" this by moving auth into the client.
//
// 🔑 NO PASSWORDS. Sign-in is a single-use emailed link. Nothing to hash, no reset
// flow, and a database dump contains no credential. Email is already the identity.
//
// 🔑 ONLY THE HASH OF A TOKEN IS EVER STORED OR LOGGED. The raw token exists in
// the customer's inbox and in one HTTP request, nowhere else.

const crypto = require('crypto');

const TOKEN_BYTES  = 32;                     // 256 bits
const SESSION_DAYS = 60;
const COOKIE       = 'forge_session';

/** Fail closed: with no secret configured, no session can be minted or trusted. */
function secret() {
  return process.env.CUSTOMER_SESSION_SECRET || '';
}
function configured() {
  return secret().length >= 32;
}

const b64u  = (buf) => Buffer.from(buf).toString('base64url');
const unb64 = (s) => Buffer.from(String(s), 'base64url');

/** A fresh sign-in token: the raw value to email, and the hash to store. */
function newLoginToken() {
  const raw = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  return { raw, hash: hashToken(raw) };
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

/**
 * Constant-time compare. timingSafeEqual THROWS on length mismatch, which would
 * itself leak length — so lengths are compared first and unequal lengths fall
 * through to a fixed-cost false.
 */
function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

/** Sign a session. Payload is not secret; the HMAC is what makes it unforgeable. */
function signSession({ accountId, email, days = SESSION_DAYS }) {
  if (!configured()) return null;
  const payload = { a: accountId, e: String(email).toLowerCase(), x: Date.now() + days * 86400000 };
  const body = b64u(JSON.stringify(payload));
  const mac = b64u(crypto.createHmac('sha256', secret()).update(body).digest());
  return `${body}.${mac}`;
}

/** Verify and decode. Returns null for anything not provably ours and unexpired. */
function verifySession(token) {
  if (!configured() || !token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const [body, mac] = parts;
  const expected = b64u(crypto.createHmac('sha256', secret()).update(body).digest());
  if (!safeEqual(mac, expected)) return null;
  let payload;
  try { payload = JSON.parse(unb64(body).toString('utf8')); } catch { return null; }
  if (!payload || !payload.a || !payload.x || Date.now() > Number(payload.x)) return null;
  return { accountId: payload.a, email: payload.e };
}

/**
 * Cookie flags, all load-bearing:
 *   HttpOnly  — script cannot read it, so an XSS bug cannot exfiltrate the session
 *   Secure    — never sent over plain HTTP
 *   SameSite=Lax — survives following a link from the emailed message, while still
 *                  refusing cross-site POSTs, which is the CSRF protection here
 *   Path=/    — the whole site
 */
function sessionCookie(token, { days = SESSION_DAYS } = {}) {
  return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${days * 86400}`;
}

function clearCookie() {
  return `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/** Pull our cookie out of a request without a cookie library. */
function readSession(headers = {}) {
  const raw = headers.cookie || headers.Cookie || '';
  const hit = String(raw).split(';').map((s) => s.trim())
    .find((s) => s.startsWith(`${COOKIE}=`));
  return hit ? verifySession(hit.slice(COOKIE.length + 1)) : null;
}

module.exports = {
  COOKIE, SESSION_DAYS, configured,
  newLoginToken, hashToken, safeEqual,
  signSession, verifySession, sessionCookie, clearCookie, readSession,
};
