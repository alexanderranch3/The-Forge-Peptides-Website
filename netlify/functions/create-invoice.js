// Netlify Function: create-invoice.js
// Creates a Square ORDER (record-keeping + inventory) and returns an order number.
// Payment is Zelle-only and always was — Square never processed a cent of it.
//
// ── 2026-08-13: SQUARE INVOICING REMOVED — DO NOT ADD IT BACK ────────────────
// On 2026-08-12 Square deactivated this account for a Terms of Service
// violation (Section 3 General Terms / Section 3 Payment Terms). The Invoices
// API now hard-fails on every call with:
//
//   BAD_REQUEST / INVALID_REQUEST_ERROR
//   "This account has not been enabled to take payments"
//
// That one failing call took the whole checkout down: the order was created
// fine, then the invoice threw, the handler returned 500, and the customer saw
// a generic error. 14 real orders were lost on 2026-08-13 before it was caught.
//
// Verified still working on the deactivated account: catalog read, customer
// create, order create, inventory adjustment. Only payment-related endpoints
// are blocked. So Square stays the inventory + order system of record and
// invoicing is gone. The order number is generated here now, not by Square.
//
// RULE: creating the order is the ONLY step allowed to fail this request.
// Every other Square call is best-effort and must be wrapped.
// ─────────────────────────────────────────────────────────────────────────────

const { syncOrder, rpc } = require('./_order-sync');
const { consentText, CURRENT_VERSION } = require('./_sms-consent');
const { invoiceModel, invoiceHtml, ownerNotificationHtml } = require('./_invoice');
const { checkAvailability, shortageMessage, checkFulfillable, blockedMessage } = require('./_stock');
const { nameToId } = require('./_catalog-map');

const SQUARE_API  = 'https://connect.squareup.com/v2';
const TOKEN       = process.env.SQUARE_ACCESS_TOKEN;
const LOCATION_ID = process.env.SQUARE_LOCATION_ID;

function squareHeaders() {
  return {
    'Authorization': `Bearer ${TOKEN}`,
    'Content-Type':  'application/json',
    'Square-Version': '2024-01-18',
  };
}

function idempotencyKey() {
  return `forge-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// Order number shown to the customer and used as their Zelle memo.
// Format is unchanged from the old Square invoice numbers (FP-######) so past
// and future orders read the same in Zelle memos and in the dashboard.
// Square enforced uniqueness on invoice_number; reference_id has no such
// constraint, so a collision here is cosmetic rather than a failed checkout.
function orderNumber() {
  return `FP-${Date.now().toString().slice(-6)}`;
}

// ── Server-Side Catalog (source of truth for prices) ──────────────────────────
// NEVER trust client-supplied prices or names — a manipulated POST body could
// otherwise generate a valid invoice at any price. Keep in sync with index.html.

class ValidationError extends Error {}

const CATALOG = {
  'retatrutide-10mg':           { name: 'Retatrutide 10mg',                  price: 160 },
  'retatrutide-15mg':           { name: 'Retatrutide 15mg',                  price: 195 },
  'retatrutide-30mg':           { name: 'Retatrutide 30mg',                  price: 275 },
  'tesamorelin-10mg':           { name: 'Tesamorelin 10mg',                  price: 89  },
  'sermorelin-10mg':            { name: 'Sermorelin 10mg',                   price: 119 },
  'ipamorelin-10mg':            { name: 'Ipamorelin 10mg',                   price: 99  },
  'mots-c-10mg':                { name: 'MOTS-C 10mg',                       price: 72  },
  'ghk-cu-50mg':                { name: 'GHK-Cu 50mg',                       price: 75  },
  'ghk-cu-100mg':               { name: 'GHK-Cu 100mg',                      price: 85  },
  'ss-31-10mg':                 { name: 'SS-31 10mg',                        price: 82  },
  'semax-10mg':                 { name: 'Semax 10mg',                        price: 99  },
  'selank-10mg':                { name: 'Selank 10mg',                       price: 95  },
  'dsip-5mg':                   { name: 'DSIP 5mg',                          price: 62  },
  'nad-100mg':                  { name: 'NAD+ 100mg',                        price: 85  },
  'nad-500mg':                  { name: 'NAD+ 500mg',                        price: 99  },
  'nad-1000mg':                 { name: 'NAD+ 1000mg',                       price: 140 },
  'melanotan-ii-10mg':          { name: 'Melanotan II 10mg',                 price: 65  },
  'reconstitution-liquid-30ml': { name: 'Reconstitution Liquid 30ml',        price: 40  },
  'bpc-157-10mg':               { name: 'BPC-157 10mg',                      price: 60  },
  'wolverine-stack':            { name: 'Wolverine Stack',                   price: 115 },
  'wolverine-blend-5mg':        { name: 'Wolverine Blend 5mg/5mg',           price: 100 },
  'cjc1295-ipamorelin':         { name: 'CJC-1295 / Ipamorelin (No DAC)',    price: 99  },
  'phoenix-blend':              { name: 'Phoenix Blend (10mg/5mg)',          price: 155 },
  'phoenix-blend-12-2':         { name: 'Phoenix Blend (12mg/2mg)',          price: 155 },
  'glow-blend':                 { name: 'Glow Blend',                        price: 165 },
  'klow-blend':                 { name: 'KLOW Blend',                        price: 195 },
};

const MAX_QTY_PER_ITEM        = 50;
const FREE_SHIPPING_THRESHOLD = 300;
const MAX_SHIPPING_AMOUNT     = 100;
const FALLBACK_SHIPPING       = 25;

// Rebuild every line item from the server-side catalog. Client-supplied price
// and name are ignored entirely. Throws on unknown ids or invalid quantities.
function sanitizeItems(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new ValidationError('No items in order.');
  }
  return rawItems.map(raw => {
    const entry = CATALOG[raw?.id];
    if (!entry) {
      throw new ValidationError(`Unknown item: ${String(raw?.id).slice(0, 60)}`);
    }
    const qty = Math.floor(Number(raw.qty));
    if (!Number.isFinite(qty) || qty < 1 || qty > MAX_QTY_PER_ITEM) {
      throw new ValidationError(`Invalid quantity for ${raw.id}`);
    }
    return { id: raw.id, name: entry.name, price: entry.price, qty };
  });
}

// Clamp shipping: pickup is always free, free-shipping threshold is enforced
// server-side, and a shipped order can never carry a negative/absurd amount.
function sanitizeShipping(rawAmount, fulfillment, subtotal) {
  if (fulfillment !== 'Ship') return 0;
  if (subtotal >= FREE_SHIPPING_THRESHOLD) return 0;
  const n = Number(rawAmount);
  if (!Number.isFinite(n) || n < 0 || n > MAX_SHIPPING_AMOUNT) return FALLBACK_SHIPPING;
  return Math.round(n * 100) / 100;
}

// ── Inventory Adjustment ──────────────────────────────────────────────────────

// Resolve a Square catalog name (item name + variation name) to a site id.
// IMPORTANT: pass the COMBINED "item + variation" name — some Square items hold
// multiple variations that belong to different site ids (e.g. the Wolverine
// item's 10/10 Stack and 5/5 Blend), so the size must come from the variation.

async function adjustInventory(items) {
  // Fetch catalog to build siteId -> Square variationId map
  const catalogItems = [];
  let cursor = null;
  do {
    const url  = `${SQUARE_API}/catalog/list?types=ITEM${cursor ? `&cursor=${cursor}` : ''}`;
    const res  = await fetch(url, { headers: { 'Authorization': `Bearer ${TOKEN}`, 'Square-Version': '2024-01-18' } });
    const data = await res.json();
    if (data.objects) catalogItems.push(...data.objects);
    cursor = data.cursor || null;
  } while (cursor);

  // Build siteId -> Square variationId at the VARIATION level so a multi-variation
  // item (e.g. Wolverine 10/10 Stack + 5/5 Blend) maps each variation to its own
  // site id and its own Square variation id — otherwise an order for one variation
  // would decrement the wrong variation's stock.
  const variationMap = {};
  for (const obj of catalogItems) {
    if (obj.type !== 'ITEM') continue;
    const itemName = obj.item_data?.name || '';
    for (const variation of (obj.item_data?.variations || [])) {
      const siteId = nameToId(`${itemName} ${variation.item_variation_data?.name || ''}`);
      if (siteId && variation.id && !variationMap[siteId]) variationMap[siteId] = variation.id;
    }
  }

  const changes = items
    .filter(item => item.id && variationMap[item.id] && item.qty > 0)
    .map(item => ({
      type: 'ADJUSTMENT',
      adjustment: {
        catalog_object_id: variationMap[item.id],
        from_state:   'IN_STOCK',
        to_state:     'SOLD',
        quantity:     String(item.qty),
        location_id:  LOCATION_ID,
        occurred_at:  new Date().toISOString(),
      },
    }));

  if (changes.length === 0) return;

  const res  = await fetch(`${SQUARE_API}/inventory/changes/batch-create`, {
    method: 'POST',
    headers: squareHeaders(),
    body: JSON.stringify({ idempotency_key: idempotencyKey(), changes }),
  });
  const data = await res.json();
  if (data.errors) console.error('Inventory adjustment errors:', JSON.stringify(data.errors));
}

// ── Customer ──────────────────────────────────────────────────────────────────

async function findOrCreateCustomer(name, email, phone) {
  const searchRes  = await fetch(`${SQUARE_API}/customers/search`, {
    method: 'POST',
    headers: squareHeaders(),
    body: JSON.stringify({ query: { filter: { email_address: { exact: email } } } }),
  });
  const searchData = await searchRes.json();
  if (searchData.customers?.length > 0) return searchData.customers[0].id;

  const [givenName, ...rest] = name.trim().split(' ');
  const createRes  = await fetch(`${SQUARE_API}/customers`, {
    method: 'POST',
    headers: squareHeaders(),
    body: JSON.stringify({
      idempotency_key: idempotencyKey(),
      given_name:   givenName,
      family_name:  rest.join(' ') || '',
      email_address: email,
      phone_number:  phone || undefined,
    }),
  });
  const createData = await createRes.json();
  if (!createData.customer) throw new Error('Failed to create customer: ' + JSON.stringify(createData));
  return createData.customer.id;
}

// ── Promo Validation ──────────────────────────────────────────────────────────
// Returns the valid promo code string, or null if invalid.
// Codes cannot be stacked — only one applies per order.

async function validatePromo(promoCode, customerId) {
  if (!promoCode) return null;

  // LOYAL10 — 10% off every order, no restrictions
  if (promoCode === 'LOYAL10') return 'LOYAL10';

  // FORGE10 — 10% off first order only.
  // Was: counted the customer's past INVOICES. Since 2026-08-13 no invoices are
  // created at all, so that check would return "first order" forever and let
  // anyone reuse FORGE10 on every purchase. Count past ORDERS instead.
  if (promoCode === 'FORGE10') {
    try {
      const res  = await fetch(`${SQUARE_API}/orders/search`, {
        method: 'POST',
        headers: squareHeaders(),
        body: JSON.stringify({
          location_ids: [LOCATION_ID],
          query: {
            filter: { customer_filter: { customer_ids: [customerId] } },
            sort:   { sort_field: 'CREATED_AT', sort_order: 'DESC' },
          },
          limit: 1,
        }),
      });
      const data = await res.json();
      if (data.errors) {
        // Can't verify — deny the discount rather than hand out a repeatable one.
        console.error('FORGE10 order lookup failed:', JSON.stringify(data.errors));
        return null;
      }
      const isFirstOrder = !(data.orders && data.orders.length > 0);
      return isFirstOrder ? 'FORGE10' : null;
    } catch (err) {
      console.error('FORGE10 order lookup threw:', err.message);
      return null;
    }
  }

  return null; // invalid code
}

// ── Order ─────────────────────────────────────────────────────────────────────

const FL_TAX_RATE = 7.0; // Florida state (6%) + Miami-Dade county surtax (1%)
const FL_TAX_UID  = 'fl-sales-tax';

async function createOrder(orderNum, customerId, items, shippingAmount, shippingLabel, promoValid, fulfillment, customerName, customerEmail, customerPhone, street, city, state, zip, notes) {
  // Local pickup is always FL; shipping applies tax only when destination is FL
  const applyFlTax = fulfillment === 'Local Pickup' || (state || '').toUpperCase() === 'FL';

  // Product line items — apply FL tax when shipping to Florida
  const lineItems = items.map(item => {
    const li = {
      name:     item.name,
      quantity: String(item.qty),
      base_price_money: { amount: Math.round(item.price * 100), currency: 'USD' },
    };
    if (applyFlTax) li.applied_taxes = [{ tax_uid: FL_TAX_UID }];
    return li;
  });

  // Shipping is not taxable in Florida
  if (shippingAmount > 0) {
    lineItems.push({
      name: shippingLabel ? `Shipping — ${shippingLabel}` : 'Shipping',
      quantity: '1',
      base_price_money: { amount: Math.round(shippingAmount * 100), currency: 'USD' },
    });
  }

  const recipient = {
    display_name:  customerName,
    email_address: customerEmail,
    phone_number:  customerPhone || undefined,
  };

  const fulfillments = fulfillment === 'Ship'
    ? [{
        type: 'SHIPMENT',
        shipment_details: {
          recipient: {
            ...recipient,
            address: {
              address_line_1: street,
              locality:       city,
              administrative_district_level_1: state,
              postal_code:    zip,
              country:        'US',
            },
          },
        },
      }]
    : [{
        type: 'PICKUP',
        pickup_details: {
          schedule_type: 'ASAP',
          recipient,
        },
      }];

  // reference_id surfaces the FP- number directly in the Square dashboard and
  // in /admin.html. metadata carries everything the old invoice description
  // used to hold — most importantly payment_status, which is the Awaiting-Zelle
  // vs Paid flag the dashboard reads and writes (see set-order-status.js).
  // Square caps metadata at 10 keys, 60-char keys, 255-char values.
  const metadata = {
    forge_order_number: orderNum,
    payment_status:     'AWAITING_ZELLE',
    payment_method:     'ZELLE',
    fulfillment_type:   fulfillment === 'Ship' ? 'SHIP' : 'LOCAL_PICKUP',
  };
  if (promoValid)    metadata.promo_code    = promoValid;
  if (shippingLabel) metadata.shipping_label = String(shippingLabel).slice(0, 255);
  if (notes)         metadata.customer_note  = String(notes).slice(0, 255);

  const orderBody = {
    idempotency_key: idempotencyKey(),
    order: {
      location_id:  LOCATION_ID,
      customer_id:  customerId,
      reference_id: orderNum,
      line_items:   lineItems,
      fulfillments,
      metadata,
    },
  };

  // Florida sales tax: 7% on product line items only (not shipping)
  if (applyFlTax) {
    orderBody.order.taxes = [{
      uid:        FL_TAX_UID,
      name:       'Florida Sales Tax (7%)',
      percentage: String(FL_TAX_RATE),
      scope:      'LINE_ITEM',
    }];
  }

  if (promoValid) {
    const promoLabel = promoValid === 'LOYAL10'
      ? 'LOYAL10 — 10% Loyal Customer Discount'
      : 'FORGE10 — 10% New Customer Discount';
    orderBody.order.discounts = [{
      name: promoLabel,
      percentage: '10',
      scope: 'ORDER',
    }];
  }

  const res  = await fetch(`${SQUARE_API}/orders`, {
    method: 'POST', headers: squareHeaders(), body: JSON.stringify(orderBody),
  });
  const data = await res.json();
  if (!data.order) throw new Error('Failed to create order: ' + JSON.stringify(data));
  return data.order;
}

// (The Square invoice step lived here until 2026-08-13. See the header comment
// for why it was removed and why it must not come back while the account is
// deactivated.)

// ── Confirmation Email ────────────────────────────────────────────────────────
// Replaces the Square invoice email that used to notify BOTH the customer and
// Frank that an order existed. Fully inert until RESEND_API_KEY is set in
// Netlify — checkout works with or without it, this just adds the paper trail.
//
// Setup: resend.com → verify theforgepeptides.com as a sending domain (3 DNS
// records) → put the key in Netlify as RESEND_API_KEY. Optionally override
// ORDER_FROM_EMAIL and ORDER_NOTIFY_EMAIL.

const RESEND_KEY   = process.env.RESEND_API_KEY;
const FROM_EMAIL   = process.env.ORDER_FROM_EMAIL   || 'The Forge Peptides <orders@theforgepeptides.com>';
const NOTIFY_EMAIL = process.env.ORDER_NOTIFY_EMAIL || 'alexanderranch3@gmail.com';

const money = cents => `$${((cents || 0) / 100).toFixed(2)}`;
const esc   = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function resendSend(payload) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
}


// 2026-08-17: the customer's copy is now the SAME branded invoice that
// send-invoice.js produces, built from _invoice.js. One template, so a
// customer who receives an invoice at checkout and one re-sent later from
// /admin.html sees the identical document — and there is only one place where
// the compliance notice and the payment instructions can drift.
async function sendConfirmationEmail({ orderNum, customerName, customerEmail, customerPhone, fulfillment, street, city, state, zip, notes, order }) {
  if (!RESEND_KEY) return; // not configured — silently skip

  const model = invoiceModel({
    order,
    customer: { name: customerName, email: customerEmail, phone: customerPhone },
    address: fulfillment === 'Ship' ? { street, city, state, zip } : null,
  });
  // The Square response echoes metadata back, but don't rely on it for the two
  // things the document is keyed on.
  model.number   = orderNum;
  model.isPickup = fulfillment === 'Local Pickup';

  // Customer first — their copy matters more than the owner alert.
  await resendSend({
    from: FROM_EMAIL, to: [customerEmail],
    subject: `Invoice ${orderNum} from The Forge Peptides — ${money(order.total_money?.amount)} due`,
    html: invoiceHtml(model),
  });

  await resendSend({
    from: FROM_EMAIL, to: [NOTIFY_EMAIL],
    subject: `New order ${orderNum} — ${customerName} — ${money(order.total_money?.amount)}`,
    html: ownerNotificationHtml(model) +
      (notes ? `<p style="font-family:sans-serif;margin:16px 0 0;"><strong>Customer note:</strong> ${esc(notes)}</p>` : ''),
  });
}

// ── Handler ───────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  if (!TOKEN || !LOCATION_ID) return { statusCode: 500, body: JSON.stringify({ error: 'Missing Square env vars.' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { customerName, customerEmail, customerPhone, fulfillment, address, street, city, state, zip, notes, promoCode, shippingAmount, shippingLabel, items,
    smsConsentOrder, smsConsentMarketing, smsConsentVersion } = body;

  if (!customerName || !customerEmail || !fulfillment || !items?.length) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields.' }) };
  }

  try {
    // Rebuild items + shipping from the server-side catalog — never trust
    // client-supplied prices, names, or amounts.
    const cleanItems = sanitizeItems(items);
    const subtotal   = cleanItems.reduce((s, i) => s + i.price * i.qty, 0);
    const shipping   = sanitizeShipping(shippingAmount, fulfillment, subtotal);
    const shipLabel  = shippingLabel ? String(shippingLabel).slice(0, 80) : null;

    // ── Stock gate ───────────────────────────────────────────────────────────
    // Added 2026-08-17. Until now nothing checked stock: a customer could order
    // 10 vials of something with 1 on the shelf and checkout would happily
    // succeed, because the storefront only ever saw Square's binary sold-out
    // flag and never a quantity.
    //
    // 🔑 THIS RUNS BEFORE THE ORDER EXISTS, ON PURPOSE. Refusing here is a clean
    // 400 the customer can act on. Refusing *after* the order is created would
    // break this file's one hard rule and strand a real order, which is exactly
    // what cost 14 of them on 2026-08-13.
    //
    // It fails open: if the dashboard cannot answer, or has never heard of the
    // product, the sale proceeds. A reporting outage must never refuse money.
    const availability = await checkAvailability(cleanItems);
    if (!availability.ok) {
      throw new ValidationError(shortageMessage(availability.shortages));
    }

    // Separate from the stock gate above, and NOT gated on STOCK_SOURCE: some
    // products we hold stock of still cannot ship — today, no labels for BPC-157
    // 10mg or MOTS-C 10mg. Quantity is not the question; the vial physically
    // cannot go out. Checked here for the same reason as the stock gate: before
    // the order exists, so the customer gets a 400 they can act on rather than a
    // stranded order.
    const shippable = await checkFulfillable(cleanItems);
    if (!shippable.ok) {
      throw new ValidationError(blockedMessage(shippable.blocked));
    }

    const orderNum   = orderNumber();
    const customerId = await findOrCreateCustomer(customerName, customerEmail, customerPhone);
    const validPromo = await validatePromo(promoCode, customerId);
    const order      = await createOrder(
      orderNum, customerId, cleanItems, shipping, shipLabel, validPromo,
      fulfillment, customerName, customerEmail, customerPhone,
      street, city, state, zip, notes
    );

    // ── Past this point the order EXISTS and the sale is real. Nothing below is
    // allowed to turn a placed order into an error screen for the customer.
    // Failures here get logged for Frank to reconcile, never surfaced.

    // Deduct stock. Verified working on the deactivated Square account
    // (2026-08-13), but wrapped regardless — a stock-sync problem is a
    // bookkeeping issue, not a reason to reject a paying customer.
    try {
      await adjustInventory(cleanItems);
    } catch (invErr) {
      console.error(`INVENTORY NOT DEDUCTED for ${orderNum}:`, invErr.message);
    }

    // Mirror the sale into the dashboard database. Added 2026-08-17: until now
    // nothing wrote sales there, so it sat frozen at the migration snapshot
    // while stock, velocity and margin quietly went stale.
    //
    // Wrapped like everything else past this line. A reporting database that
    // misses a row is a bookkeeping problem fixable from the Sync button in
    // /admin.html; a customer seeing an error on a placed order is not.
    // Double-posting is impossible by construction — sync_square_order() keys
    // on the Square order id and moves stock only on first sight.
    try {
      await syncOrder(order, {
        square_id: customerId, name: customerName,
        email: customerEmail, phone: customerPhone,
      });
    } catch (syncErr) {
      console.error(`DASHBOARD SYNC FAILED for ${orderNum} (re-run Sync in /admin.html):`, syncErr.message);
    }

    // SMS consent. Recorded SEPARATELY from the order sync and in its own try,
    // because the two failure modes are not comparable: a missed order row is
    // repairable from the Sync button, but a missed consent is gone -- there is
    // no backfill for a moment that has passed, and the number becomes untextable
    // forever. So it must not ride on the sync succeeding.
    //
    // 🚨 The WORDING is read from _sms-consent.js here, never from the request.
    // The page sends only booleans and a version; if it sent the text, a forged
    // POST could put words in a customer's mouth and the record would be worthless.
    // An unticked box writes no row at all (see 011) -- refusal is an absence.
    if (smsConsentOrder === true || smsConsentMarketing === true) {
      try {
        const v = smsConsentVersion || CURRENT_VERSION;
        const written = await rpc('record_sms_consent', {
          p_phone:      customerPhone,
          p_order:      smsConsentOrder === true,
          p_marketing:  smsConsentMarketing === true,
          p_version:    v,
          p_order_text: consentText('order', v),
          p_mkt_text:   consentText('marketing', v),
          p_source:     'checkout',
        });
        // 0 means the phone number could not be normalised to E.164 -- worth
        // knowing, because the customer ticked a box and got nothing recorded.
        if (Number(written) === 0) {
          console.error(`SMS CONSENT NOT RECORDED for ${orderNum}: unusable phone number`);
        }
      } catch (consentErr) {
        console.error(`SMS CONSENT WRITE FAILED for ${orderNum}:`, consentErr.message);
      }
    }

    // Confirmation email — no-op until RESEND_API_KEY is configured in Netlify.
    try {
      await sendConfirmationEmail({
        orderNum, customerName, customerEmail, customerPhone,
        fulfillment, street, city, state, zip, notes,
        order, // Square already computed tax/discount/total — don't recompute
      });
    } catch (mailErr) {
      console.error(`CONFIRMATION EMAIL FAILED for ${orderNum}:`, mailErr.message);
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success:       true,
        // Kept as `invoiceNumber` so the existing success screen in index.html
        // keeps working untouched. `orderNumber` is the name to prefer going forward.
        invoiceNumber: orderNum,
        orderNumber:   orderNum,
        orderId:       order.id,
        promoApplied:  validPromo,
      }),
    };
  } catch (err) {
    console.error('create-invoice error:', err.message);
    if (err instanceof ValidationError) {
      return { statusCode: 400, body: JSON.stringify({ error: err.message }) };
    }
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
