// Netlify Function: request-login.js
// POST { email } -> emails a single-use sign-in link. No password, ever.
//
// 🚨 THE RESPONSE IS IDENTICAL WHETHER OR NOT THE EMAIL IS KNOWN, and that is the
// whole security design of this endpoint. Any difference -- a different message, a
// different status, even a measurably different latency path -- turns it into a
// customer-list oracle: anyone could sit here testing addresses to learn who buys
// peptides from us. That is a privacy leak about our customers, not just an
// account-enumeration nit. Rate limiting lives in the database (5/hour/email) so
// it holds for any future caller too.
//
// 🔑 Only the token HASH is sent to the database. The raw token exists in this
// one request and in the customer's inbox. It is never logged.

const { rpc } = require('./_order-sync');
const { newLoginToken, configured } = require('./_customer-auth');

const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.ORDER_FROM_EMAIL || 'The Forge Peptides <orders@theforgepeptides.com>';
const SITE        = process.env.SITE_URL || 'https://theforgepeptides.com';
const EMAIL_RE    = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// One reply for every outcome. Built once so no branch can accidentally differ.
const SAME_ANSWER = {
  statusCode: 200,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify({
    ok: true,
    message: 'If that email has ordered from us, a sign-in link is on its way. It expires in 20 minutes.',
  }),
};

function linkEmail(url) {
  return `<!doctype html><html><body style="margin:0;background:#f5f5f5;padding:24px;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:8px;padding:32px;">
    <tr><td style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#FF6A00;font-weight:bold;padding-bottom:8px;">The Forge Peptides</td></tr>
    <tr><td style="font-size:22px;font-weight:bold;color:#111;padding-bottom:12px;">Your sign-in link</td></tr>
    <tr><td style="font-size:15px;color:#444;line-height:1.5;padding-bottom:22px;">
      Tap the button to sign in and save your details, so you don't have to type them out next time.
      This link works once and expires in 20 minutes.
    </td></tr>
    <tr><td style="padding-bottom:22px;">
      <a href="${url}" style="display:inline-block;background:#FF6A00;color:#ffffff;text-decoration:none;font-weight:bold;font-size:16px;padding:14px 26px;border-radius:6px;">Sign in</a>
    </td></tr>
    <tr><td style="font-size:13px;color:#777;line-height:1.5;">
      If you didn't ask for this, you can ignore it — nothing changes until the link is opened.
    </td></tr>
  </table></td></tr></table></body></html>`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  // A missing session secret must not silently mint unusable links.
  if (!configured() || !RESEND_KEY) {
    console.error('request-login not configured:',
      { session_secret: configured(), resend: Boolean(RESEND_KEY) });
    return SAME_ANSWER;
  }

  let email = '';
  try { email = String(JSON.parse(event.body || '{}').email || '').trim().toLowerCase(); }
  catch { return SAME_ANSWER; }
  if (!EMAIL_RE.test(email)) return SAME_ANSWER;

  try {
    const { raw, hash } = newLoginToken();
    const rows = await rpc('request_login_token', {
      p_email: email,
      p_token_hash: hash,
      p_ttl_minutes: 20,
      p_ip: (event.headers['x-nf-client-connection-ip'] || '').slice(0, 45) || null,
    });

    // No row means malformed or rate-limited. Same answer either way — the caller
    // learns nothing, and a customer hammering "resend" simply gets no new email.
    if (Array.isArray(rows) && rows.length > 0) {
      const url = `${SITE}/.netlify/functions/verify-login?t=${encodeURIComponent(raw)}`;
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: FROM_EMAIL, to: [email],
          subject: 'Your Forge Peptides sign-in link',
          html: linkEmail(url),
        }),
      });
    }
  } catch (err) {
    // Never surface the reason: an error shape is as good an oracle as a message.
    console.error('request-login failed:', err.message);
  }

  return SAME_ANSWER;
};
