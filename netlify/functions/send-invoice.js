// ─────────────────────────────────────────────────────────────────────────────
// Netlify Function: send-invoice.js
// Added 2026-08-17 — our own invoice, replacing what Square's invoice email did
// before the account was deactivated.
//
//   GET  ?order_id=<square order id>            → the invoice HTML, for preview
//   POST { order_id, to? }                      → emails it via Resend
//
// 🔐 Token-gated. It reads customer contact details and can send mail as the
// business, so it must never be reachable without the admin token.
//
// 🚨 SENDING IS A REAL-WORLD ACTION. The preview exists so the invoice can be
// read before a customer ever sees it, and the admin page shows it first. This
// endpoint never sends as a side effect of a GET.
//
// Money comes from Square, which computed the tax and discount at sale time.
// Nothing is recalculated here — a second opinion about a total is how two
// systems end up disagreeing about what a customer owes.
// ─────────────────────────────────────────────────────────────────────────────

const { verifyToken } = require('./_auth-token');
const { invoiceModel, invoiceModelFromDashboard, invoiceHtml, ownerNotificationHtml, money } = require('./_invoice');
const { fetchAliasLines, packingLineFor } = require('./_alias-skus');

const SQUARE_API  = 'https://connect.squareup.com/v2';
const TOKEN       = process.env.SQUARE_ACCESS_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── The dashboard is asked first (step 3, 2026-08-20) ────────────────────────
//
// 🚨 THIS FIXES A GAP, not just a Square dependency. The invoice was built from
// a SQUARE order id, and a counter sale has no Square order — so a walk-in
// customer could not be sent an invoice at all. The Orders tab passes the Square
// id when there is one and the dashboard uuid otherwise, so both shapes arrive
// here and both are handled.
//
// ⚠️ Falls back to Square when the dashboard cannot answer, so nothing that
// worked before stops working. That fallback goes when checkout does.
async function loadFromDashboard(id) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  const column = UUID_RE.test(id) ? 'order_id' : 'square_id';
  try {
    const [rows, aliasLines] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/v_admin_orders?select=*&${column}=eq.${encodeURIComponent(id)}`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Accept: 'application/json' },
      }).then((r) => (r.ok ? r.json() : null)),
      fetchAliasLines(),
    ]);
    if (!Array.isArray(rows) || !rows.length) return null;
    // 🔑 The SKU comes from what the stock actually did, same as the picking
    // view — so the invoice and the packing list name the same vial.
    return invoiceModelFromDashboard(rows[0], (name) => packingLineFor(aliasLines, name));
  } catch {
    return null;
  }
}

const RESEND_KEY   = process.env.RESEND_API_KEY;
const FROM_EMAIL   = process.env.ORDER_FROM_EMAIL   || 'The Forge Peptides <orders@theforgepeptides.com>';
const NOTIFY_EMAIL = process.env.ORDER_NOTIFY_EMAIL || 'alexanderranch3@gmail.com';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function squareHeaders() {
  return {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    'Square-Version': '2024-01-18',
  };
}

async function loadOrder(orderId) {
  const res = await fetch(`${SQUARE_API}/orders/${encodeURIComponent(orderId)}`, { headers: squareHeaders() });
  const data = await res.json();
  if (!data.order) {
    const err = new Error('That order could not be found in Square.');
    err.status = 404;
    throw err;
  }
  const order = data.order;

  let customer = null;
  if (order.customer_id) {
    try {
      const cRes = await fetch(`${SQUARE_API}/customers/${order.customer_id}`, { headers: squareHeaders() });
      const cData = await cRes.json();
      if (cData.customer) {
        const c = cData.customer;
        customer = {
          name: [c.given_name, c.family_name].filter(Boolean).join(' ') || c.company_name || '',
          email: c.email_address || '',
          phone: c.phone_number || '',
        };
      }
    } catch { /* fall through to the fulfilment recipient */ }
  }

  // The fulfilment recipient is the fallback, and the only source of the
  // shipping address.
  const f = (order.fulfillments || [])[0];
  const recipient = f?.shipment_details?.recipient || f?.pickup_details?.recipient;
  if (!customer && recipient) {
    customer = {
      name: recipient.display_name || '',
      email: recipient.email_address || '',
      phone: recipient.phone_number || '',
    };
  }

  const a = f?.shipment_details?.recipient?.address;
  const address = a ? {
    street: a.address_line_1 || '',
    city: a.locality || '',
    state: a.administrative_district_level_1 || '',
    zip: a.postal_code || '',
  } : null;

  return { order, customer: customer || { name: '', email: '', phone: '' }, address };
}

async function resendSend(payload) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Resend ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

exports.handler = async (event) => {
  const jsonHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  const SECRET = process.env.ADMIN_TOKEN_SECRET;
  if (!SECRET) {
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: 'ADMIN_TOKEN_SECRET not configured.' }) };
  }
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  if (!verifyToken(SECRET, authHeader.replace(/^Bearer\s+/i, ''))) {
    return { statusCode: 401, headers: jsonHeaders, body: JSON.stringify({ error: 'Unauthorized' }) };
  }
  if (!TOKEN) {
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: 'Square is not configured.' }) };
  }

  try {
    // ── Preview ──────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
      const orderId = (event.queryStringParameters || {}).order_id;
      if (!orderId) {
        return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: 'order_id is required' }) };
      }
      let model = await loadFromDashboard(orderId);
      if (!model) {
        const { order, customer, address } = await loadOrder(orderId);
        model = invoiceModel({ order, customer, address });
      }
      return {
        statusCode: 200,
        headers: jsonHeaders,
        body: JSON.stringify({
          html: invoiceHtml(model),
          number: model.number,
          to: model.customerEmail,
          total: money(model.total_cents),
          paid: model.paid,
          // Surfaced so the page can warn BEFORE the send button is offered,
          // rather than failing after a click.
          can_send: Boolean(RESEND_KEY),
        }),
      };
    }

    // ── Send ─────────────────────────────────────────────────────────────────
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, headers: jsonHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
    }
    if (!RESEND_KEY) {
      return {
        statusCode: 500, headers: jsonHeaders,
        body: JSON.stringify({
          error: 'Email is not configured.',
          detail: 'Set RESEND_API_KEY in Netlify → Site settings → Environment variables, then redeploy.',
        }),
      };
    }

    let input = {};
    try { input = JSON.parse(event.body || '{}'); } catch { /* validated below */ }
    if (!input.order_id) {
      return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: 'order_id is required' }) };
    }

    // 🔑 Same order of preference as the preview, so what gets SENT is exactly
    // what was reviewed. Two different sources between preview and send is how a
    // customer receives an invoice nobody looked at.
    let model = await loadFromDashboard(input.order_id);
    if (!model) {
      const { order, customer, address } = await loadOrder(input.order_id);
      model = invoiceModel({ order, customer, address });
    }

    const to = String(input.to || model.customerEmail || '').trim();
    if (!EMAIL_RE.test(to)) {
      return {
        statusCode: 400, headers: jsonHeaders,
        body: JSON.stringify({ error: 'No valid email address for this order — add one before sending.' }),
      };
    }

    await resendSend({
      from: FROM_EMAIL,
      to: [to],
      subject: model.paid
        ? `Invoice ${model.number} from The Forge Peptides — paid`
        : `Invoice ${model.number} from The Forge Peptides — ${money(model.total_cents)} due`,
      html: invoiceHtml(model),
    });

    // Owner copy is best-effort: the customer's invoice is the thing that
    // matters, and a failed notification must not report the send as failed.
    let notified = true;
    try {
      await resendSend({
        from: FROM_EMAIL, to: [NOTIFY_EMAIL],
        subject: `Invoice ${model.number} sent — ${model.customerName || to} — ${money(model.total_cents)}`,
        html: ownerNotificationHtml(model),
      });
    } catch (notifyErr) {
      notified = false;
      console.error(`OWNER COPY FAILED for ${model.number}:`, notifyErr.message);
    }

    return {
      statusCode: 200, headers: jsonHeaders,
      body: JSON.stringify({ ok: true, sent_to: to, number: model.number, owner_notified: notified }),
    };
  } catch (err) {
    console.error('send-invoice error:', err.message);
    return {
      statusCode: err.status || 500, headers: jsonHeaders,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
