// Netlify Function: account.js
// GET  -> the signed-in customer's saved details + their own order history
// POST -> save details
// DELETE -> sign out
//
// 🚨 THIS IS THE ONLY ENDPOINT A SIGNED-IN CUSTOMER CAN REACH, and it returns
// exactly three things: their own saved details, customer_orders(), and
// customer_order_items() — all three built with NO cost, margin or vendor column.
// Anything added here is visible to a customer about their own account — never
// widen it with data from a table that carries cost.
//
// ⚠️ customer_order_items() reads order_line_items, which DOES carry
// unit_cost_cents and cost_source. It is safe only because migration 040 spells
// out its four columns rather than selecting the row; a dry-run assertion pins
// that column set. If that function is ever edited, re-read it before trusting
// this comment.
//
// 🔑 Identity comes ONLY from the HttpOnly cookie's HMAC, never from the request
// body. A body-supplied account id would let anyone read any account by guessing.

const { rpc } = require('./_order-sync');
const { CATALOG } = require('./_catalog');
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
      const [details, orders, items, prices] = await Promise.all([
        rpc('customer_details',     { p_account: session.accountId }),
        rpc('customer_orders',      { p_account: session.accountId }),
        rpc('customer_order_items', { p_account: session.accountId }),
        // Prices agreed with this customer (migration 043). Fails soft: the shop
        // showing list price is a cosmetic problem, and create-invoice.js does
        // its OWN lookup, so what they are CHARGED never depends on this call.
        rpc('customer_prices', { p_account: session.accountId }).catch(() => []),
      ]);
      const d = (Array.isArray(details) ? details[0] : null) || {};

      // Hang each order's lines off the order itself, so the page never has to
      // join two lists and can never mis-pair them.
      const byOrder = new Map();
      for (const it of (Array.isArray(items) ? items : [])) {
        if (!byOrder.has(it.order_no)) byOrder.set(it.order_no, []);
        byOrder.get(it.order_no).push({
          kind: it.kind, name: it.name, qty: Number(it.quantity) || 0,
        });
      }
      return json(200, {
        signedIn: true,
        email: session.email,
        details: {
          fullName: d.full_name || '', phone: d.phone || '',
          line1: d.address_line1 || '', line2: d.address_line2 || '',
          city: d.city || '', state: d.state_region || '',
          postal: d.postal_code || '', country: d.country || 'US',
        },
        orders: (Array.isArray(orders) ? orders : []).map((o) => ({
          ...o, items: byOrder.get(o.order_no) || [],
        })),

        // ── What this customer pays ──────────────────────────────────────
        // 🚨 DISPLAY ONLY. The storefront uses this to show their price on the
        // product cards; create-invoice.js looks the same prices up again from
        // the session when it charges. Two independent reads of one table, and
        // the browser can influence neither — so tampering with this list
        // changes what is shown and never what is billed.
        // ⚠️ A price above retail is dropped, matching what checkout does with
        // one: it is a decimal-point slip, and showing it would advertise a
        // higher price than the shop's own.
        prices: (Array.isArray(prices) ? prices : []).reduce((out, r) => {
          const entry = CATALOG[r.site_catalog_id];
          const cents = Number(r.price_cents);
          if (!entry || !Number.isFinite(cents) || cents < 0) return out;
          const listCents = Math.round(entry.price * 100);
          if (cents > listCents) return out;
          out.push({ id: r.site_catalog_id, price: cents / 100, list: entry.price });
          return out;
        }, []),
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
