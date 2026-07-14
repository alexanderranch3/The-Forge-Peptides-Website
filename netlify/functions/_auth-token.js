// Shared admin-token helper (NOT a Netlify endpoint — leading underscore keeps
// it from being deployed as a function; it is bundled into functions that
// require it). Issues + verifies short-lived HMAC-signed tokens.
//
// Token format: base64url(JSON payload) + "." + base64url(HMAC-SHA256).
// The signing secret comes from ADMIN_TOKEN_SECRET (set in the Netlify UI).
// No secret is ever hardcoded here.

const crypto = require('crypto');

const DEFAULT_TTL_SECONDS = 8 * 60 * 60; // 8h admin session

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

// Constant-time compare that won't throw on length mismatch.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function signToken(secret, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const payload = { exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(secret, token) {
  if (!secret || !token || typeof token !== 'string' || !token.includes('.')) return false;
  const [body, sig] = token.split('.');
  if (!body || !sig) return false;

  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (!safeEqual(sig, expected)) return false;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  if (!payload || typeof payload.exp !== 'number') return false;
  if (payload.exp < Math.floor(Date.now() / 1000)) return false; // expired
  return true;
}

module.exports = { signToken, verifyToken };
