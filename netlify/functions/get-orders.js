// Netlify Function: get-orders.js
// Feeds the admin dashboard (/admin.html) with recent orders.
//
// ── 2026-08-13: REBUILT ON ORDERS, NOT INVOICES ──────────────────────────────
// Square deactivated this account on 2026-08-12, so create-invoice.js no longer
// creates Square invoices (see that file's header). This function used to search
// the Invoices API and join orders onto it — with no new invoices being created,
// that approach would have shown an empty dashboard forever.
//
// Now it searches ORDERS directly. Paid/unpaid lives in order metadata
// (payment_status), written at checkout and flipped by set-order-status.js.
//
// Orders created before the switchover have no metadata, so their paid state is
// inferred from whether Square recorded a tender against the order. That keeps
// historical orders — and the 14 orphaned ones from 2026-08-13 — rendering
// correctly alongside new ones.
// ─────────────────────────────────────────────────────────────────────────────

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

// Fetch orders for the location within the window, paginating until done.
async function fetchOrders(since) {
  const orders = [];
  let cursor = null;

  do {
    const body = {
      location_ids: [LOCATION_ID],
      query: {
        filter: {
          date_time_filter: { created_at: { start_at: since.toISOString() } },
          state_filter:     { states: ['OPEN', 'COMPLETED'] },
        },
        sort: { sort_field: 'CREATED_AT', sort_order: 'DESC' },
      },
      limit: 500,
    };
    if (cursor) body.cursor = cursor;

    const res  = await fetch(`${SQUARE_API}/orders/search`, {
      method: 'POST', headers: squareHeaders(), body: JSON.stringify(body),
    });
    const data = await res.json();

    if (data.errors) {
      console.error('Order search error:', JSON.stringify(data.errors));
      break;
    }

    orders.push(...(data.orders || []));
    cursor = data.cursor || null;
  } while (cursor);

  // 🚨 NOTHING IS DROPPED HERE ANY MORE. This used to keep only orders with a
  // fulfillment or a forge order number, on the reasoning that an in-person POS
  // quick-sale is not a web order to pack and ship. That is true about SHIPPING
  // and false about everything else: a POS sale is a real sale that moves real
  // stock, and hiding it made it invisible in the only screen Frank reads.
  //
  // It bit us on 2026-08-19: FP-001155 (Retatrutide 10mg, 08-17) deducted a vial
  // and appeared nowhere in the order list, so reconciling the count against the
  // dashboard silently disagreed by one vial with no visible cause.
  //
  // POS sales have no fulfillment, so they shape as LOCAL_PICKUP, and the
  // shipping workflow already defaults to fulfillmentType === 'SHIP' — they
  // cannot pollute a packing run. They are tagged `channel` so the UI can say
  // plainly where a sale came from.
  return orders;
}

// WEB = placed through our checkout (it carries our order number) or given a
// fulfillment. POS = rung up in person. The distinction drives display only —
// both are real sales and both move stock.
function orderChannel(order) {
  const isWeb = (order.fulfillments && order.fulfillments.length)
    || !!order.metadata?.forge_order_number;
  return isWeb ? 'WEB' : 'POS';
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

// Paid state resolution, most trustworthy signal first:
//   1. metadata.payment_status — written at checkout, flipped by set-order-status
//   2. a recorded tender on the order — covers pre-2026-08-13 invoice-paid orders
//   3. otherwise it's still awaiting Zelle
function resolveStatus(order) {
  const flag = order.metadata?.payment_status;
  if (flag === 'PAID')     return 'PAID';
  if (flag === 'CANCELED') return 'CANCELED';
  if (flag === 'AWAITING_ZELLE') {
    // Trust a real tender over a stale flag.
    return (order.tenders && order.tenders.length) ? 'PAID' : 'AWAITING_ZELLE';
  }
  if (order.tenders && order.tenders.length) return 'PAID';
  return 'AWAITING_ZELLE';
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

    const orders = await fetchOrders(since);
    if (!orders.length) {
      return { statusCode: 200, headers, body: JSON.stringify({ orders: [] }) };
    }

    const customersMap = await fetchCustomers(orders.map(o => o.customer_id));

    const result = orders.map(order => {
      const customer = order.customer_id ? customersMap[order.customer_id] : null;

      // Shipping address from order fulfillment
      let shipTo = null;
      let fulfillmentType = 'LOCAL_PICKUP';
      const f = order.fulfillments?.[0];
      if (f?.type === 'SHIPMENT') {
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

      // Line items (exclude the shipping line)
      const items = (order.line_items || [])
        .filter(li => !li.name?.toLowerCase().startsWith('shipping'))
        .map(li => ({
          name:  li.name,
          qty:   parseInt(li.quantity, 10),
          price: (li.base_price_money?.amount || 0) / 100,
        }));

      const shippingLine   = (order.line_items || []).find(li => li.name?.toLowerCase().startsWith('shipping'));
      const shippingAmount = shippingLine ? (shippingLine.base_price_money?.amount || 0) / 100 : 0;
      // Extract carrier label from "Shipping — USPS Priority Mail" format
      const shippingLabel  = order.metadata?.shipping_label
        || (shippingLine?.name?.includes('—')
              ? shippingLine.name.split('—').slice(1).join('—').trim()
              : null);

      // Square already computed these — use its numbers rather than re-deriving.
      const subtotal    = items.reduce((s, i) => s + i.price * i.qty, 0);
      const discountAmt = (order.total_discount_money?.amount || 0) / 100;
      const taxAmount   = (order.total_tax_money?.amount || 0) / 100;
      const total       = (order.total_money?.amount || 0) / 100;

      // Fall back to the fulfillment recipient when no customer record resolves.
      const recipient = f?.shipment_details?.recipient || f?.pickup_details?.recipient || {};
      const name  = customer
        ? `${customer.given_name || ''} ${customer.family_name || ''}`.trim()
        : (recipient.display_name || 'Unknown');
      const email = customer?.email_address || recipient.email_address || '';
      const phone = customer?.phone_number  || recipient.phone_number  || '';

      return {
        orderId:       order.id,
        orderNumber:   order.metadata?.forge_order_number || order.reference_id || '',
        status:        resolveStatus(order),
        createdAt:     order.created_at,
        customerName:  name,
        customerEmail: email,
        customerPhone: phone,
        customerNote:  order.metadata?.customer_note || '',
        promoCode:     order.metadata?.promo_code || null,
        fulfillmentType,
        channel: orderChannel(order),
        shipTo,
        items,
        subtotal:       parseFloat(subtotal.toFixed(2)),
        shippingAmount: parseFloat(shippingAmount.toFixed(2)),
        shippingLabel,
        discount:       parseFloat(discountAmt.toFixed(2)),
        taxAmount:      parseFloat(taxAmount.toFixed(2)),
        total:          parseFloat(total.toFixed(2)),
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
