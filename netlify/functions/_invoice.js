// Shared helper (NOT an endpoint). Builds the customer-facing invoice.
//
// Replaces what Square's invoice email did before the account was deactivated,
// on our own infrastructure and with our own branding.
//
// ── Two deliberate design choices ────────────────────────────────────────────
// 1. LIGHT, NOT THE SITE'S DARK THEME. An invoice is a business document: it
//    gets forwarded, printed and filed. A dark background wastes ink, prints
//    grey-on-grey, and several mail clients invert it unpredictably. The brand
//    lives in the logo and the orange accents instead.
// 2. TABLE-BASED, FULLY INLINE STYLES. Mail clients strip <style> blocks and
//    ignore flexbox and grid. This markup is dull on purpose so it survives
//    Gmail, Outlook and Apple Mail intact.
//
// 🚨 COMPLIANCE — NON-NEGOTIABLE. Products are research-use-only. This document
// carries product names, quantities and prices and NOTHING ELSE about them: no
// dosing, no protocol, no suggested use, no therapeutic or medical claim. The
// RUO notice is part of the template, not an optional footer.

const LOGO_URL   = 'https://theforgepeptides.com/assets/logo.png';
const SITE_URL   = 'https://theforgepeptides.com';
const ZELLE_TAG  = '@forgepeptides';
const BRAND      = '#FF6A00';

const money = (cents) => `$${(((cents || 0) / 100)).toFixed(2)}`;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
}

/**
 * Normalise a Square order into what the template needs, so the template does
 * no arithmetic and no field-guessing of its own.
 *
 * 🔑 gross_sales_money is base price x quantity — pre-tax and pre-discount.
 * total_money is tax-INCLUSIVE. Using the latter on an item row while also
 * listing tax separately is what made a receipt read like a double charge on
 * 2026-08-14; the total was right and the breakdown was not.
 */
function invoiceModel({ order, customer, address }) {
  const items = (order.line_items || []).map((li) => ({
    name: li.name || 'Item',
    qty: Number(li.quantity || 1),
    unit_cents: li.base_price_money?.amount ?? 0,
    amount_cents: li.gross_sales_money?.amount
      ?? (li.base_price_money?.amount || 0) * Number(li.quantity || 1),
  }));

  const subtotal = items.reduce((n, i) => n + i.amount_cents, 0);
  const paid = String(order.metadata?.payment_status || '').toUpperCase() === 'PAID'
    || (order.tenders || []).length > 0;

  return {
    number: order.metadata?.forge_order_number || order.reference_id || order.id?.slice(0, 8) || '',
    issued: order.created_at,
    paid,
    customerName: customer?.name || '',
    customerEmail: customer?.email || '',
    customerPhone: customer?.phone || '',
    address: address || null,
    isPickup: String(order.metadata?.fulfillment_type || '').toUpperCase() === 'LOCAL_PICKUP',
    items,
    subtotal_cents: subtotal,
    discount_cents: order.total_discount_money?.amount ?? 0,
    discount_label: (order.discounts || [])[0]?.name || 'Discount',
    tax_cents: order.total_tax_money?.amount ?? 0,
    total_cents: order.total_money?.amount ?? subtotal,
  };
}

function invoiceHtml(m) {
  const rows = m.items.map((i, idx) => `
    <tr>
      <td style="padding:14px 12px;border-bottom:1px solid #ececec;color:#1a1a1a;font-size:14px;${idx === 0 ? '' : ''}">${esc(i.name)}</td>
      <td style="padding:14px 12px;border-bottom:1px solid #ececec;color:#555;font-size:14px;text-align:center;">${i.qty}</td>
      <td style="padding:14px 12px;border-bottom:1px solid #ececec;color:#555;font-size:14px;text-align:right;">${money(i.unit_cents)}</td>
      <td style="padding:14px 12px;border-bottom:1px solid #ececec;color:#1a1a1a;font-size:14px;text-align:right;font-weight:600;">${money(i.amount_cents)}</td>
    </tr>`).join('');

  const totalRow = (label, value, opts = {}) => `
    <tr>
      <td style="padding:6px 12px;text-align:right;color:${opts.color || '#666'};font-size:${opts.size || '14px'};${opts.weight ? `font-weight:${opts.weight};` : ''}">${esc(label)}</td>
      <td style="padding:6px 12px;text-align:right;color:${opts.color || '#1a1a1a'};font-size:${opts.size || '14px'};${opts.weight ? `font-weight:${opts.weight};` : ''}width:130px;">${value}</td>
    </tr>`;

  const totals = [
    totalRow('Subtotal', money(m.subtotal_cents)),
    m.discount_cents ? totalRow(m.discount_label, `&minus;${money(m.discount_cents)}`, { color: '#1a7f37' }) : '',
    m.tax_cents ? totalRow('Florida Sales Tax (7%)', money(m.tax_cents)) : '',
  ].join('');

  const statusBadge = m.paid
    ? `<span style="display:inline-block;background:#e6f4ea;color:#1a7f37;border:1px solid #b7e0c4;border-radius:4px;padding:5px 12px;font-size:12px;font-weight:700;letter-spacing:.04em;">PAID</span>`
    : `<span style="display:inline-block;background:#fff4e5;color:#a35200;border:1px solid #ffd8a8;border-radius:4px;padding:5px 12px;font-size:12px;font-weight:700;letter-spacing:.04em;">AWAITING PAYMENT</span>`;

  const shipTo = m.isPickup
    ? 'Local pickup — we\'ll arrange a time with you.'
    : (m.address
        ? [m.address.street, [m.address.city, m.address.state].filter(Boolean).join(', '), m.address.zip]
            .filter(Boolean).map(esc).join('<br/>')
        : 'Address on file');

  const payBlock = m.paid ? '' : `
    <tr><td style="padding:0 32px 28px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:2px solid ${BRAND};border-radius:8px;background:#fff8f3;">
        <tr><td style="padding:20px 22px;">
          <div style="color:${BRAND};font-weight:700;font-size:14px;letter-spacing:.04em;margin-bottom:12px;">HOW TO PAY — ZELLE</div>
          <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;color:#333;line-height:1.9;">
            <tr><td style="padding-right:10px;color:#999;">1.</td><td>Open your banking app and choose <strong>Zelle</strong></td></tr>
            <tr><td style="padding-right:10px;color:#999;">2.</td><td>Send <strong style="color:#1a1a1a;">${money(m.total_cents)}</strong> to <strong style="color:#1a1a1a;">${ZELLE_TAG}</strong></td></tr>
            <tr><td style="padding-right:10px;color:#999;">3.</td><td>Put <strong style="color:${BRAND};">${esc(m.number)}</strong> in the memo</td></tr>
          </table>
          <div style="margin-top:14px;padding-top:12px;border-top:1px solid #ffd8a8;color:#8a6d3b;font-size:12.5px;line-height:1.6;">
            Your order ships once payment is confirmed.
          </div>
        </td></tr>
      </table>
    </td></tr>`;

  return `<div style="background:#f4f4f5;padding:28px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">

    <tr><td style="padding:30px 32px 22px;border-bottom:3px solid ${BRAND};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:middle;">
          <img src="${LOGO_URL}" alt="The Forge Peptides" width="52" height="52" style="display:block;border:0;"/>
        </td>
        <td style="vertical-align:middle;padding-left:14px;">
          <div style="font-size:17px;font-weight:700;color:#1a1a1a;letter-spacing:.01em;">THE FORGE PEPTIDES</div>
          <div style="font-size:12.5px;color:#888;margin-top:3px;">Alexander Ranch LLC &middot; Miami, FL</div>
        </td>
        <td style="vertical-align:middle;text-align:right;">
          <div style="font-size:22px;font-weight:700;color:${BRAND};letter-spacing:.06em;">INVOICE</div>
          <div style="font-size:13px;color:#666;margin-top:4px;">${esc(m.number)}</div>
        </td>
      </tr></table>
    </td></tr>

    <tr><td style="padding:24px 32px 8px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:top;width:55%;">
          <div style="font-size:11px;color:#999;letter-spacing:.08em;font-weight:700;margin-bottom:7px;">BILL TO</div>
          <div style="font-size:14.5px;color:#1a1a1a;font-weight:600;">${esc(m.customerName)}</div>
          ${m.customerEmail ? `<div style="font-size:13px;color:#666;margin-top:3px;">${esc(m.customerEmail)}</div>` : ''}
          ${m.customerPhone ? `<div style="font-size:13px;color:#666;">${esc(m.customerPhone)}</div>` : ''}
        </td>
        <td style="vertical-align:top;text-align:right;">
          <div style="font-size:11px;color:#999;letter-spacing:.08em;font-weight:700;margin-bottom:7px;">DATE</div>
          <div style="font-size:14px;color:#1a1a1a;">${esc(formatDate(m.issued))}</div>
          <div style="margin-top:12px;">${statusBadge}</div>
        </td>
      </tr></table>
    </td></tr>

    <tr><td style="padding:20px 32px 4px;">
      <div style="font-size:11px;color:#999;letter-spacing:.08em;font-weight:700;margin-bottom:7px;">
        ${m.isPickup ? 'FULFILMENT' : 'SHIP TO'}
      </div>
      <div style="font-size:13.5px;color:#555;line-height:1.6;">${shipTo}</div>
    </td></tr>

    <tr><td style="padding:22px 20px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr style="background:#fafafa;">
          <th align="left"   style="padding:11px 12px;font-size:11px;color:#888;letter-spacing:.06em;border-bottom:2px solid #eee;">DESCRIPTION</th>
          <th align="center" style="padding:11px 12px;font-size:11px;color:#888;letter-spacing:.06em;border-bottom:2px solid #eee;width:50px;">QTY</th>
          <th align="right"  style="padding:11px 12px;font-size:11px;color:#888;letter-spacing:.06em;border-bottom:2px solid #eee;width:90px;">PRICE</th>
          <th align="right"  style="padding:11px 12px;font-size:11px;color:#888;letter-spacing:.06em;border-bottom:2px solid #eee;width:100px;">AMOUNT</th>
        </tr>
        ${rows}
      </table>
    </td></tr>

    <tr><td style="padding:14px 20px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${totals}
        <tr>
          <td style="padding:14px 12px 0;text-align:right;border-top:2px solid #1a1a1a;color:#1a1a1a;font-size:16px;font-weight:700;">Total</td>
          <td style="padding:14px 12px 0;text-align:right;border-top:2px solid #1a1a1a;color:${BRAND};font-size:19px;font-weight:700;width:130px;">${money(m.total_cents)}</td>
        </tr>
      </table>
    </td></tr>

    <tr><td style="height:26px;"></td></tr>
    ${payBlock}

    <tr><td style="padding:20px 32px 28px;border-top:1px solid #ececec;background:#fafafa;">
      <div style="font-size:11.5px;color:#8a8a8a;line-height:1.75;">
        <strong style="color:#666;">All products are sold for laboratory research use only and are not for human consumption.</strong>
        Not for diagnostic or therapeutic use. Must be 21 or older to purchase.
      </div>
      <div style="font-size:11.5px;color:#aaa;margin-top:12px;">
        <a href="${SITE_URL}" style="color:${BRAND};text-decoration:none;">theforgepeptides.com</a>
        &nbsp;&middot;&nbsp; Questions? Reply to this email.
      </div>
    </td></tr>
  </table>
</div>`;
}

// The owner's copy: dense, scannable, no branding needed.
function ownerNotificationHtml(m) {
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;color:#222;">
    <h2 style="color:#c44d00;margin:0 0 12px;">Invoice ${esc(m.number)} sent — ${money(m.total_cents)}</h2>
    <p style="margin:0 0 4px;"><strong>${esc(m.customerName)}</strong></p>
    <p style="margin:0 0 16px;">${esc(m.customerEmail)}${m.customerPhone ? ` · ${esc(m.customerPhone)}` : ''}</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      ${m.items.map(i => `<tr><td style="padding:5px 0;">${esc(i.name)}${i.qty > 1 ? ` &times;${i.qty}` : ''}</td>
        <td style="padding:5px 0;text-align:right;">${money(i.amount_cents)}</td></tr>`).join('')}
      <tr><td style="padding:10px 0 0;border-top:1px solid #ddd;font-weight:700;">Total</td>
          <td style="padding:10px 0 0;border-top:1px solid #ddd;text-align:right;font-weight:700;">${money(m.total_cents)}</td></tr>
    </table>
    <p style="margin:16px 0 0;color:#777;font-size:12.5px;">
      ${m.paid ? 'Already marked paid.' : 'Awaiting Zelle. Mark paid at theforgepeptides.com/admin.html'}
    </p>
  </div>`;
}

// ZELLE_TAG and SITE_URL are exported because _sms.js needs the same values.
// They were briefly duplicated there — the same mistake that let two copies of
// nameToId drift apart. One definition, imported.
module.exports = {
  invoiceModel, invoiceHtml, ownerNotificationHtml,
  money, esc, formatDate,
  ZELLE_TAG, SITE_URL,
};
