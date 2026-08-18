// Netlify Function: account.js
// GET  -> the signed-in customer's saved details + their own order history
// POST -> save details
// DELETE -> sign out
//
// 🚨 THIS IS THE ONLY ENDPOINT A SIGNED-IN CUSTOMER CAN REACH, and it returns
// exactly two things: their own saved details, and customer_orders(), which is
// built with NO cost, margin or vendor column. Anything added here is visible to
// a customer about their own account — never widen it with data from a table that
// carries cost.
//
// 🔑 Identity comes ONLY from the HttpOnly cookie's HMAC, never from the request
// body. A body-supplied account id would let anyone read any account by guessing.

const { rpc } = require('./_order-sync');
const { readSession, clearCookie, configured } = require('./_customer-auth');

const json = (statusCode, body, extra = {}) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (!configured()) return json(503, { error: 'Sign-in is not configured.' });

  const session = readSession(event.headers || {});
  if (!session) return json(401, { error: 'Not signed in.' });

  try {
    if (event.httpMethod === 'GET') {
      const [details, orders] = await Promise.all([
        rpc('customer_details', { p_account: session.accountId }),
        rpc('customer_orders',  { p_account: session.accountId }),
      ]);
      const d = (Array.isArray(details) ? details[0] : null) || {};
      return json(200, {
        signedIn: true,
        email: session.email,
        details: {
          fullName: d.full_name || '', phone: d.phone || '',
          line1: d.address_line1 || '', line2: d.address_line2 || '',
          city: d.city || '', state: d.state_region || '',
          postal: d.postal_code || '', country: d.country || 'US',
        },
        orders: Array.isArray(orders) ? orders : [],
      });
    }

    if (event.httpMethod === 'POST') {
      let b = {};
      try { b = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request.' }); }
      const saved = await rpc('save_customer_details', {
        p_account:   session.accountId,     // from the cookie, NOT the body
        p_full_name: String(b.fullName || '').slice(0, 120),
        p_phone:     String(b.phone    || '').slice(0, 40),
        p_line1:     String(b.line1    || '').slice(0, 160),
        p_line2:     String(b.line2    || '').slice(0, 160),
        p_city:      String(b.city     || '').slice(0, 80),
        p_state:     String(b.state    || '').slice(0, 40),
        p_postal:    String(b.postal   || '').slice(0, 20),
        p_country:   String(b.country  || 'US').slice(0, 2) || 'US',
      });
      return json(200, { ok: saved === true || saved === 'true' });
    }

    if (event.httpMethod === 'DELETE') {
      return json(200, { ok: true, signedIn: false }, { 'Set-Cookie': clearCookie() });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('account failed:', err.message);
    return json(500, { error: 'Something went wrong.' });
  }
};
