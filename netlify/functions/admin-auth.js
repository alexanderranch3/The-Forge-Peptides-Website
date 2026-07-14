// Netlify Function: admin-auth.js
// Server-side admin password check for the order dashboard (admin.html).
// The password lives ONLY in the ADMIN_PASSWORD environment variable
// (set in the Netlify UI) — never hardcoded in this repo.

const crypto = require('crypto');

// Constant-time compare that won't throw on a length mismatch.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ADMIN_PASSWORD not configured.' }) };
  }

  let submitted = '';
  try {
    submitted = JSON.parse(event.body || '{}').password || '';
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body.' }) };
  }

  if (submitted && safeEqual(submitted, expected)) {
    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  }
  return { statusCode: 401, headers, body: JSON.stringify({ error: 'Incorrect password' }) };
};
