// Netlify Function: create-invoice.js
// Creates a Square order + sends a Square invoice receipt via email.
// Invoice is a RECEIPT ONLY — payment is Zelle-only, not through Square.

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

// ── Inventory Adjustment ──────────────────────────────────────────────────────

function nameToId(name) {
  const n = name.toLowerCase();
  if (n.includes('klow'))                                                      return 'klow-blend';
  if (n.includes('glow'))                                                      return 'glow-blend';
  if (n.includes('phoenix') && n.includes('12'))                              return 'phoenix-blend-12-2';
  if (n.includes('phoenix'))                                                   return 'phoenix-blend';
  if (n.includes('tesamorelin') && n.includes('ipamorelin') && n.includes('12')) return 'phoenix-blend-12-2';
  if (n.includes('tesamorelin') && n.includes('ipamorelin'))                  return 'phoenix-blend';
  if (n.includes('wolverine') && (n.includes('blend') || n.includes('5mg'))) return 'wolverine-blend-5mg';
  if (n.includes('wolverine'))                                                 return 'wolverine-stack';
  if (n.includes('cjc'))                                                       return 'cjc1295-ipamorelin';
  if (n.includes('ipamorelin'))                                                return 'ipamorelin-10mg';
  if (n.includes('retatrutide') && n.includes('24'))                           return 'retatrutide-24mg';
  if (n.includes('retatrutide') && n.includes('15'))                           return 'retatrutide-15mg';
  if (n.includes('retatrutide') && n.includes('10'))                           return 'retatrutide-10mg';
  if (n.includes('retatrutide') && n.includes('12'))                           return 'retatrutide-12mg';
  if (n.includes('retatrutide'))                                               return 'retatrutide-12mg';
  if (n.includes('tesamorelin'))                                               return 'tesamorelin-10mg';
  if (n.includes('sermorelin'))                                                return 'sermorelin-10mg';
  if (n.includes('mots-c') || n.includes('mots c'))                           return 'mots-c-10mg';
  if ((n.includes('ghk-cu') || n.includes('ghk cu')) && n.includes('50'))    return 'ghk-cu-50mg';
  if (n.includes('ghk-cu') || n.includes('ghk cu'))                           return 'ghk-cu-100mg';
  if (n.includes('ss-31') || n.includes('ss31') || n.includes('elamipretide')) return 'ss-31-10mg';
  if (n.includes('semax') && n.includes('selank'))                            return 'semax-selank';
  if (n.includes('semax'))                                                     return 'semax-10mg';
  if (n.includes('selank'))                                                    return 'selank-10mg';
  if (n.includes('dsip'))                                                      return 'dsip-5mg';
  if (n.includes('nad') && n.includes('1000'))                                 return 'nad-1000mg';
  if (n.includes('nad') && n.includes('100'))                                  return 'nad-100mg';
  if (n.includes('nad'))                                                       return 'nad-500mg';
  if (n.includes('melanotan'))                                                 return 'melanotan-ii-10mg';
  if (n.includes('bacteriostatic') || n.includes('bac water') || n.includes('reconstitution')) return 'reconstitution-liquid-30ml';
  return null;
}

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

  const variationMap = {};
  for (const obj of catalogItems) {
    if (obj.type !== 'ITEM') continue;
    const siteId    = nameToId(obj.item_data?.name || '');
    const variation = obj.item_data?.variations?.[0];
    if (siteId && variation?.id) variationMap[siteId] = variation.id;
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

  // FORGE10 — 10% off first order only
  if (promoCode === 'FORGE10') {
    const res  = await fetch(`${SQUARE_API}/invoices/search`, {
      method: 'POST',
      headers: squareHeaders(),
      body: JSON.stringify({
        query: {
          filter: { location_ids: [LOCATION_ID], customer_ids: [customerId] },
          sort: { field: 'INVOICE_SORT_DATE', order: 'DESC' },
        },
        limit: 1,
      }),
    });
    const data = await res.json();
    const isFirstOrder = !(data.invoices && data.invoices.length > 0);
    return isFirstOrder ? 'FORGE10' : null;
  }

  return null; // invalid code
}

// ── Order ─────────────────────────────────────────────────────────────────────

const FL_TAX_RATE = 7.0; // Florida state (6%) + Miami-Dade county surtax (1%)
const FL_TAX_UID  = 'fl-sales-tax';

async function createOrder(customerId, items, shippingAmount, shippingLabel, promoValid, fulfillment, customerName, customerEmail, customerPhone, street, city, state, zip) {
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

  const orderBody = {
    idempotency_key: idempotencyKey(),
    order: { location_id: LOCATION_ID, customer_id: customerId, line_items: lineItems, fulfillments },
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

// ── Invoice Receipt ───────────────────────────────────────────────────────────

async function createInvoice(customerId, orderId, notes, promoValid, shippingAmount, fulfillment, address) {
  const invoiceNum = `FP-${Date.now().toString().slice(-6)}`;

  const fulfillmentLine = fulfillment === 'Local Pickup'
    ? 'Fulfillment: Local Pickup — we will contact you to arrange pickup.'
    : `Ship to: ${address || 'address on file'}`;

  const desc = [
    `Order #${invoiceNum} — The Forge Peptides`,
    '',
    'PAYMENT — ZELLE ONLY',
    `Send payment to @forgepeptides via Zelle.`,
    `Memo: ${invoiceNum}`,
    '',
    'Your order will NOT be processed until Zelle payment is confirmed.',
    '',
    fulfillmentLine,
  ];

  if (promoValid === 'LOYAL10') desc.push('', 'LOYAL10 discount (10% off) applied.');
  if (promoValid === 'FORGE10') desc.push('', 'FORGE10 discount (10% off) applied.');
  if (shippingAmount === 0)     desc.push('Free shipping applied.');
  if (notes)                    desc.push('', `Order notes: ${notes}`);
  desc.push('', 'Questions? theforgepeptides.com');
  desc.push('All products are sold for in-vitro research purposes only. Must be 21+.');

  const invoiceRes = await fetch(`${SQUARE_API}/invoices`, {
    method: 'POST',
    headers: squareHeaders(),
    body: JSON.stringify({
      idempotency_key: idempotencyKey(),
      invoice: {
        location_id:       LOCATION_ID,
        order_id:          orderId,
        primary_recipient: { customer_id: customerId },
        payment_requests: [{
          request_type:             'BALANCE',
          due_date:                 new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          automatic_payment_source: 'NONE',
        }],
        accepted_payment_methods: { bank_account: true },
        delivery_method:  'EMAIL', // Square will send receipt when Frank marks invoice paid — no email sent until then (invoice stays DRAFT)
        invoice_number:   invoiceNum,
        title:            'The Forge Peptides — Order Receipt',
        description:      desc.join('\n'),
      },
    }),
  });
  const invoiceData = await invoiceRes.json();
  if (!invoiceData.invoice) throw new Error('Failed to create invoice: ' + JSON.stringify(invoiceData));
  // Invoice stays as DRAFT — Square will send the receipt automatically when Frank marks it paid in Square dashboard
  return invoiceData.invoice;
}

// ── Handler ───────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  if (!TOKEN || !LOCATION_ID) return { statusCode: 500, body: JSON.stringify({ error: 'Missing Square env vars.' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { customerName, customerEmail, customerPhone, fulfillment, address, street, city, state, zip, notes, promoCode, shippingAmount, shippingLabel, items } = body;

  if (!customerName || !customerEmail || !fulfillment || !items?.length) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields.' }) };
  }

  try {
    const customerId = await findOrCreateCustomer(customerName, customerEmail, customerPhone);
    const validPromo = await validatePromo(promoCode, customerId);
    const shipping   = Number(shippingAmount) || 0;
    const order      = await createOrder(customerId, items, shipping, shippingLabel, validPromo, fulfillment, customerName, customerEmail, customerPhone, street, city, state, zip);
    const invoice    = await createInvoice(customerId, order.id, notes, validPromo, shipping, fulfillment, address);
    await adjustInventory(items); // deduct from Square inventory

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success:       true,
        invoiceNumber: invoice.invoice_number,
        invoiceId:     invoice.id,
        promoApplied:  validPromo,
      }),
    };
  } catch (err) {
    console.error('create-invoice error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
