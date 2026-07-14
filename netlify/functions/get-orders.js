// Netlify Function: get-orders.js
// Fetches recent Square invoices + linked orders for the admin dashboard.

const { verifyToken } = require('./_auth-token');

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

// Fetch ALL invoices for the location, paginating until done.
// Square's invoice filter only supports location_ids + customer_ids — no date filter.
// We filter by date in JS after fetching.
async function fetchInvoices(since) {
  const invoices = [];
  let cursor = null;

  do {
    const body = {
      query: {
        filter: { location_ids: [LOCATION_ID] },
        sort:   { field: 'INVOICE_SORT_DATE', order: 'DESC' },
      },
      limit: 100,
    };
    if (cursor) body.cursor = cursor;

    const res  = await fetch(`${SQUARE_API}/invoices/search`, {
      method: 'POST', headers: squareHeaders(), body: JSON.stringify(body),
    });
    const data = await res.json();

    if (data.errors) {
      console.error('Invoice search error:', JSON.stringify(data.errors));
      break;
    }

    const batch = data.invoices || [];
    invoices.push(...batch);

    // Stop paginating once we hit invoices older than our window
    const oldest = batch[batch.length - 1];
    if (oldest && new Date(oldest.created_at) < since) {
      cursor = null;
    } else {
      cursor = data.cursor || null;
    }
  } while (cursor);

  // Filter by date — include DRAFT (awaiting Zelle), skip only CANCELED
  return invoices.filter(inv =>
    new Date(inv.created_at) >= since &&
    inv.status !== 'CANCELED'
  );
}

// Batch-fetch multiple orders at once (Square supports up to 100 per call)
async function batchFetchOrders(orderIds) {
  if (!orderIds.length) return {};
  const map = {};

  // Square batch-retrieve accepts up to 100 IDs
  for (let i = 0; i < orderIds.length; i += 100) {
    const chunk = orderIds.slice(i, i + 100);
    const res   = await fetch(`${SQUARE_API}/orders/batch-retrieve`, {
      method: 'POST',
      headers: squareHeaders(),
      body: JSON.stringify({ order_ids: chunk }),
    });
    const data = await res.json();
    if (data.errors) console.error('Batch order error:', JSON.stringify(data.errors));
    (data.orders || []).forEach(o => { map[o.id] = o; });
  }
  return map;
}

// Fetch customers in parallel (Square has no batch customer retrieve)
async function fetchCustomers(customerIds) {
  const unique = [...new Set(customerIds.filter(Boolean))];
  const map    = {};
  await Promise.all(unique.map(async id => {
    try {
      const res  = await fetch(`${SQUARE_API}/customers/${id}`, { headers: squareHeaders() });
      const data = await res.json();
      if (data.customer) map[id] = data.customer;
    } catch (e) {
      console.error(`Failed to fetch customer ${id}:`, e.message);
    }
  }));
  return map;
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  // Admin-only: require a valid signed token (issued by admin-auth on login).
  const SECRET = process.env.ADMIN_TOKEN_SECRET;
  if (!SECRET) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ADMIN_TOKEN_SECRET not configured.' }) };
  }
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const bearer = authHeader.replace(/^Bearer\s+/i, '');
  if (!verifyToken(SECRET, bearer)) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  if (!TOKEN || !LOCATION_ID) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing Square env vars.' }) };
  }

  try {
    const days  = parseInt(event.queryStringParameters?.days || '60', 10);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // 1. Fetch invoices
    const invoices = await fetchInvoices(since);
    if (!invoices.length) {
      return { statusCode: 200, headers, body: JSON.stringify({ orders: [] }) };
    }

    // 2. Batch-fetch all linked orders
    const orderIds  = [...new Set(invoices.map(i => i.order_id).filter(Boolean))];
    const ordersMap = await batchFetchOrders(orderIds);

    // 3. Fetch customers in parallel
    const customerIds  = [...new Set(invoices.map(i => i.primary_recipient?.customer_id).filter(Boolean))];
    const customersMap = await fetchCustomers(customerIds);

    // 4. Combine everything
    const result = invoices.map(inv => {
      const order    = ordersMap[inv.order_id]  || null;
      const custId   = inv.primary_recipient?.customer_id;
      const customer = custId ? customersMap[custId] : null;

      // Shipping address from order fulfillment
      let shipTo = null;
      let fulfillmentType = 'LOCAL_PICKUP';
      if (order?.fulfillments?.length) {
        const f = order.fulfillments[0];
        if (f.type === 'SHIPMENT') {
          fulfillmentType = 'SHIP';
          const addr = f.shipment_details?.recipient?.address;
          if (addr) {
            shipTo = {
              street:  addr.address_line_1 || '',
              city:    addr.locality || '',
              state:   addr.administrative_district_level_1 || '',
              zip:     addr.postal_code || '',
              country: addr.country || 'US',
            };
          }
        }
      }

      // Line items (exclude "Shipping")
      const items = (order?.line_items || [])
        .filter(li => li.name?.toLowerCase() !== 'shipping')
        .map(li => ({
          name:  li.name,
          qty:   parseInt(li.quantity, 10),
          price: (li.base_price_money?.amount || 0) / 100,
        }));

      const shippingLine   = (order?.line_items || []).find(li => li.name?.toLowerCase().startsWith('shipping'));
      const shippingAmount = shippingLine ? (shippingLine.base_price_money?.amount || 0) / 100 : 0;
      // Extract carrier label from "Shipping — USPS Priority Mail" format
      const shippingLabel  = shippingLine?.name?.includes('—')
        ? shippingLine.name.split('—').slice(1).join('—').trim()
        : null;

      const subtotal   = items.reduce((s, i) => s + i.price * i.qty, 0);
      const discountAmt = (order?.discounts || []).reduce((s, d) => {
        if (d.percentage) return s + subtotal * parseFloat(d.percentage) / 100;
        if (d.amount_money) return s + d.amount_money.amount / 100;
        return s;
      }, 0);
      const taxAmount  = (order?.total_tax_money?.amount || 0) / 100;
      const total = subtotal - discountAmt + shippingAmount + taxAmount;

      const name  = customer
        ? `${customer.given_name || ''} ${customer.family_name || ''}`.trim()
        : (inv.primary_recipient?.display_name || 'Unknown');
      const email = customer?.email_address  || inv.primary_recipient?.email_address || '';
      const phone = customer?.phone_number   || inv.primary_recipient?.phone_number  || '';

      return {
        invoiceId:      inv.id,
        invoiceNumber:  inv.invoice_number || '',
        status:         inv.status,
        createdAt:      inv.created_at,
        customerName:   name,
        customerEmail:  email,
        customerPhone:  phone,
        fulfillmentType,
        shipTo,
        items,
        subtotal:        parseFloat(subtotal.toFixed(2)),
        shippingAmount:  parseFloat(shippingAmount.toFixed(2)),
        shippingLabel,
        discount:        parseFloat(discountAmt.toFixed(2)),
        taxAmount:       parseFloat(taxAmount.toFixed(2)),
        total:           parseFloat(total.toFixed(2)),
      };
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ orders: result }),
    };

  } catch (err) {
    console.error('get-orders error:', err.message, err.stack);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
