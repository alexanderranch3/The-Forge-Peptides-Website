// Netlify Function: verify-login.js
// GET ?t=<token> -> consumes the link, sets the session cookie, redirects home.
//
// 🔑 THE TOKEN NEVER REACHES THE PAGE. This redirects with a Set-Cookie rather
// than handing the browser a token to store, so the session lives in an HttpOnly
// cookie that no script can read -- an XSS bug on the storefront cannot steal it.
// The redirect also strips the token from the address bar, so it does not sit in
// history, get pasted into a support chat, or leak through a Referer header.
//
// 🔑 REDEMPTION IS ATOMIC AND SINGLE-USE in the database (one UPDATE ... WHERE
// used_at IS NULL AND expires_at > now()), so two concurrent taps of the same
// link cannot both open a session.

const { rpc } = require('./_order-sync');
const { signSession, sessionCookie, configured } = require('./_customer-auth');
const { hashToken } = require('./_customer-auth');

function redirect(to, cookie) {
  const headers = { Location: to, 'Cache-Control': 'no-store' };
  if (cookie) headers['Set-Cookie'] = cookie;
  return { statusCode: 302, headers, body: '' };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }
  if (!configured()) {
    console.error('verify-login: CUSTOMER_SESSION_SECRET missing or too short');
    return redirect('/?signin=unavailable');
  }

  const raw = (event.queryStringParameters || {}).t || '';
  if (!raw) return redirect('/?signin=invalid');

  try {
    const rows = await rpc('redeem_login_token', { p_token_hash: hashToken(raw) });
    const acct = Array.isArray(rows) ? rows[0] : null;

    // Expired, already used, or never existed — all one answer. A customer who
    // taps an old link is told to request a new one, not what went wrong.
    if (!acct) return redirect('/?signin=expired');

    const token = signSession({ accountId: acct.account_id, email: acct.email });
    if (!token) return redirect('/?signin=unavailable');
    return redirect('/?signin=ok', sessionCookie(token));
  } catch (err) {
    console.error('verify-login failed:', err.message);
    return redirect('/?signin=error');
  }
};
