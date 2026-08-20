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
// ⚠️ FAILS SOFT SINCE STEP 2 (2026-08-20): returns null when Square cannot be
// reached at all, rather than throwing. The dashboard is the primary list now,
// so a Square outage must not empty the screen Frank ships from — it used to
// take the whole request down with it. null and [] are kept distinct: "could not
// ask Square" is not "Square has no orders", and only the first is a reason to
// stop trusting the stray check below.
async function fetchOrders(since) {
  try {
    return await fetchOrdersFromSquare(since);
  } catch (err) {
    console.error('get-orders: Square unreachable, serving the dashboard alone:', err.message);
    return null;
  }
}

async function fetchOrdersFromSquare(since) {
  const orders = [];
  let cursor = null;

  do {
    const body = {
      location_ids: [LOCATION_ID],
      query: {
        filter: {
          date_time_filter: { created_at: { start_at: since.toISOString() } },
          // 🚨 DRAFT IS INCLUDED, added 2026-08-20. Without it a DRAFT order is
          // invisible in this dashboard entirely: v_dashboard_only_orders skips
          // anything carrying a square_id, so Square is the ONLY route in — and
          // this filter was closing it. FP-001004 (Leo the Den, $259, 21 May)
          // sat that way for three months: the Finance tab flagged it as the
          // one order awaiting payment while the Orders tab could not show it,
          // so there was no way to mark it paid.
          // ⚠️ Safe against migration 021's 19 unreal orders — the dashboard's
          // CANCELED state is applied over whatever Square reports (see
          // fetchCancelledSquareIds), so those still read as voided.
          state_filter:     { states: ['OPEN', 'COMPLETED', 'DRAFT'] },
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

// ── The dashboard side ───────────────────────────────────────────────────────
// 🚨 This function reads SQUARE. Since order entry shipped, real sales are
// rung up here and never reach Square at all — FP-001158, a $275.00 Zelle sale,
// was invisible in the only screen anyone opens. And fulfillment state (packaged
// / collected) lives only in this database. Both are fetched and merged below.
//
// Both are non-fatal: if Supabase cannot answer, the Square orders still render.
// A dashboard outage must not blank the order list.
// The same packing identity the invoice prints, so the two never disagree
// about which vial a line means.
const { packingLine } = require('./_catalog');
const { fetchAliasLines, packingLineFor } = require('./_alias-skus');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) ? rows : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

// square_id -> fulfillment state, for orders that came from Square.
async function fetchFulfillmentBySquareId() {
  const rows = await sb('v_order_fulfillment?select=square_id,fulfillment_state,carrier,tracking_number&square_id=not.is.null');
  if (!rows) return null;
  return Object.fromEntries(rows.map((r) => [r.square_id, r]));
}

// Square ids the DASHBOARD has voided.
//
// 🚨 Square will never tell us this. Its account is deactivated, so a voided
// order cannot be cancelled at source and orders/search keeps returning it as
// OPEN — exactly the reason migration 021 needed a trigger to stop syncs
// reopening cancelled orders. The dashboard is the authority on whether a sale
// is real, so its CANCELED state is applied over whatever Square still believes.
//
// ⚠️ FAILS OPEN, like every other dashboard read in this file: if Supabase
// cannot answer, this returns null and voided orders show as live rather than
// the list failing. That is the safe direction — re-voiding one is harmless
// (void-order is idempotent), whereas hiding orders we could not verify would
// hide real work to do. The watchdog is what notices a persistent outage.
async function fetchCancelledSquareIds() {
  const rows = await sb('orders?select=square_id&state=eq.CANCELED&square_id=not.is.null');
  if (!rows) return null;
  return new Set(rows.map((r) => r.square_id));
}

// ── The dashboard's own order feed (step 2, 2026-08-20) ──────────────────────
//
// 🔑 THIS IS NOW THE PRIMARY LIST. It used to be Square's, with the dashboard
// merged in for counter sales only — which made Square the record and this
// database the copy. Everything the tab draws is in v_admin_orders (migration
// 034): customer, address, carrier, tracking, the money breakdown, and every
// line except shipping.
//
// ⚠️ SQUARE IS STILL FETCHED, and still merged in for any order this feed does
// not have. It should never find one — every Square order syncs here — but "it
// should never happen" is not a reason to drop an order off the screen Frank
// ships from. That fallback is what makes this switch safe to make before
// checkout stops writing to Square, and it is the last thing to remove.
//
// 🚨 It reads by PLACED_AT, not created_at. A Square-era order was imported long
// after it was placed, and filtering on the import date would have hidden every
// backdated order — the same shape of bug as the 90-day window that hid
// FP-001004.
async function fetchAdminOrders(since, aliasLinesPromise) {
  const [rows, aliasLines] = await Promise.all([
    sb(`v_admin_orders?select=*&placed_at=gte.${since.toISOString()}&order=placed_at.desc`),
    aliasLinesPromise,
  ]);
  if (!rows) return null;   // null, not [] — "could not ask" is not "no orders"

  return rows.map((r) => {
    const cents = (v) => Math.round(Number(v || 0)) / 100;
    const ship = r.address_line1 ? {
      street:  r.address_line1 + (r.address_line2 ? `, ${r.address_line2}` : ''),
      city:    r.city || '',
      state:   r.state_region || '',
      zip:     r.postal_code || '',
      country: r.country || 'US',
    } : null;

    // "Shipping — UPS 2nd Day Air" → "UPS 2nd Day Air". The carrier was only
    // ever written into the line's name on Square-era orders, and
    // fulfillments.service is populated on 0 of 93 rows.
    const label = r.service
      || (r.shipping_line_name && r.shipping_line_name.includes('—')
            ? r.shipping_line_name.split('—').slice(1).join('—').trim()
            : null)
      || r.carrier
      || null;

    return {
      orderId:     r.order_id,
      // Carried so a Square order already represented here can be recognised
      // and not shown twice — the two systems key orders differently.
      squareId:    r.square_id || null,
      orderNumber: r.order_no || '',
      // 🔑 The order's own state is read FIRST, so a voided sale reads as
      // voided rather than as whatever it was paid.
      status: r.order_state === 'CANCELED'
        ? 'CANCELED'
        : (r.payment_state === 'PAID' ? 'PAID' : 'AWAITING_ZELLE'),
      createdAt:     r.placed_at,
      customerName:  r.customer_name || 'Unknown',
      customerEmail: r.customer_email || '',
      customerPhone: r.customer_phone || '',
      customerNote:  r.customer_note || '',
      promoCode:     null,
      fulfillmentType: r.fulfillment_type === 'SHIPMENT' ? 'SHIP' : 'LOCAL_PICKUP',
      channel:       r.channel === 'WEBSITE' ? 'WEB' : r.channel,
      fulfillmentState: r.fulfillment_state || 'PROPOSED',
      trackingNumber:   r.tracking_number || null,
      // Kept so the page can still tell them apart, but it no longer decides
      // where the row came from — everything comes from here now.
      dashboardOnly: !r.square_id,
      shipTo: ship,
      items: (Array.isArray(r.items) ? r.items : []).map((i) => {
        const { sku, label: name } = packingLineFor(aliasLines, i.name);
        return { name, sku, qty: Number(i.qty) || 0, price: Number(i.price) || 0 };
      }),
      subtotal:       cents(r.subtotal_cents),
      shippingAmount: cents(r.shipping_cents),
      shippingLabel:  label,
      discount:       cents(r.discount_cents),
      taxAmount:      cents(r.tax_cents),
      total:          cents(r.total_cents),
    };
  });
}

// Orders that exist only here. Shaped to match a Square order exactly so the UI
// never has to care which system a sale came from.
// ⚠️ KEPT ONLY AS A FALLBACK for the case where v_admin_orders cannot be read —
// it is no longer the counter-sale path, because the feed above carries those
// too. Remove it when Square goes.
async function fetchDashboardOnlyOrders(since, aliasLinesPromise) {
  // Both are started by the caller and awaited here, so the alias lookup costs
  // no extra round trip — it runs alongside the order fetch, not after it.
  const [rows, aliasLines] = await Promise.all([
    sb(`v_dashboard_only_orders?select=*&created_at=gte.${since.toISOString()}`),
    aliasLinesPromise,
  ]);
  if (!rows) return [];
  return rows.map((r) => ({
    orderId:          r.order_id,
    orderNumber:      r.order_number || '',
    // 🔑 order_state is read FIRST so a voided counter sale reads as voided
    // rather than as whatever it was paid. v_dashboard_only_orders filters
    // CANCELED out today, so this is inert until that filter is lifted — but
    // without it, lifting the filter would put voided sales back on the screen
    // labelled PAID, which is worse than not showing them at all.
    status:           r.order_state === 'CANCELED'
                        ? 'CANCELED'
                        : (r.payment_state === 'PAID' ? 'PAID' : 'AWAITING_ZELLE'),
    createdAt:        r.created_at,
    customerName:     r.customer_name || 'Unknown',
    customerEmail:    r.customer_email || '',
    customerPhone:    r.customer_phone || '',
    customerNote:     r.customer_note || '',
    promoCode:        null,
    fulfillmentType:  'LOCAL_PICKUP',
    channel:          r.channel === 'POS' ? 'POS' : 'WEB',
    shipTo:           null,
    // Counter sales carry the dashboard's own variant name; run it through the
    // same resolver so a walk-in order reads identically to a web one.
    items: (Array.isArray(r.items) ? r.items : []).map((i) => {
      // 🔑 The database's own resolution first, this file's name parsing second
      // — `packingLine` already prefers the id it is handed. See _alias-skus.js:
      // the alias is what deducted the stock, so the SKU on the slip names the
      // vial that actually left the shelf.
      const { sku, label } = packingLineFor(aliasLines, i.name);
      return { ...i, name: label, sku };
    }),
    subtotal:         Number(r.subtotal || 0),
    shippingAmount:   Number(r.shipping_amount || 0),
    shippingLabel:    null,
    discount:         0,
    taxAmount:        Number(r.tax_amount || 0),
    total:            Number(r.total || 0),
    fulfillmentState: r.fulfillment_state || 'PROPOSED',
    // Flags an order Square has no record of, so the UI can say so plainly
    // rather than leaving Frank wondering why it is missing from Square.
    dashboardOnly:    true,
  }));
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

    // Square, the dashboard's own orders, and fulfillment state — in parallel,
    // since none depends on another.
    // Started here so both the Square path and the dashboard path share one
    // lookup, and it overlaps every other request rather than following them.
    const aliasLinesPromise = fetchAliasLines();

    const [orders, adminOrders, dashboardOnly, fulfillmentMap, cancelledIds, aliasLines] = await Promise.all([
      fetchOrders(since),
      fetchAdminOrders(since, aliasLinesPromise),
      fetchDashboardOnlyOrders(since, aliasLinesPromise),
      fetchFulfillmentBySquareId(),
      fetchCancelledSquareIds(),
      aliasLinesPromise,
    ]);


    // 🚨 NOT an early return on an empty Square list any more. Counter sales
    // live only in the dashboard, so "Square returned nothing" does not mean
    // "there are no orders" — that assumption is what hid FP-001158.
    // 🚨 NOT an early return on an empty Square list. Counter sales live only in
    // the dashboard, so "Square returned nothing" never meant "there are no
    // orders" — that assumption is what hid FP-001158. Now the dashboard feed
    // answers it outright.
    if (!orders || !orders.length) {
      // 🚨 Both sources silent is an OUTAGE, not an empty day. Serving [] would
      // read as "no orders" on the screen used to decide what to pack.
      if (!adminOrders && orders === null) {
        return {
          statusCode: 502, headers,
          body: JSON.stringify({
            error: 'Could not reach the dashboard or Square — this is not an empty order list.',
          }),
        };
      }
      // ⚠️ Sorted here too. This early exit used to return the list untouched,
      // which put orders in whatever order the source happened to yield — and
      // with the dashboard primary this is now a COMMON path, not a rare one.
      const only = [...(adminOrders || dashboardOnly)]
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          orders: only,
          source: adminOrders ? 'dashboard' : 'square',
        }),
      };
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
        .map(li => {
          // 🔑 The specific name and the SKU. Frank packs from this list, so
          // "Wolverine Stack" with no strength on it is a mis-pack waiting to
          // happen — and a Square-era name like
          // `BPC-157 / TB-500 "WOLVERINE BLEND"` carries no strength at all.
          // 🚨 The database is asked FIRST: `resolve_variant()` already matched
          // this exact string to decide which vial to deduct, so the alias table
          // knows what the parser correctly refuses to guess. 88 of 136 sold
          // lines printed bare before this. See _alias-skus.js.
          const { sku, label } = packingLineFor(aliasLines, li.name);
          return {
            name:  label,
            sku,
            qty:   parseInt(li.quantity, 10),
            price: (li.base_price_money?.amount || 0) / 100,
          };
        });

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
        // A dashboard void wins over anything Square says. See fetchCancelledSquareIds.
        status:        cancelledIds?.has(order.id) ? 'CANCELED' : resolveStatus(order),
        createdAt:     order.created_at,
        customerName:  name,
        customerEmail: email,
        customerPhone: phone,
        customerNote:  order.metadata?.customer_note || '',
        promoCode:     order.metadata?.promo_code || null,
        fulfillmentType,
        channel: orderChannel(order),
        fulfillmentState: fulfillmentMap?.[order.id]?.fulfillment_state || 'PROPOSED',
        trackingNumber:   fulfillmentMap?.[order.id]?.tracking_number || null,
        dashboardOnly: false,
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

    // ── Dashboard first (step 2, 2026-08-20) ─────────────────────────────────
    // 🔑 THE INVERSION. The dashboard's own feed is the list; Square is consulted
    // only for orders that feed does not already have. Every Square order syncs
    // here, so `strays` should always be empty — but an order silently missing
    // from the screen Frank ships from is the one outcome worth carrying a
    // redundant path to avoid. It goes when checkout stops writing to Square.
    //
    // ⚠️ Falls back to EXACTLY the previous behaviour when the feed cannot be
    // read (fetchAdminOrders returns null, never []). A reporting view being
    // down must never empty the Orders tab.
    let merged;
    let source;
    if (adminOrders) {
      const known       = new Set(adminOrders.map((o) => o.orderId));
      const knownSquare = new Set(adminOrders.map((o) => o.squareId).filter(Boolean));
      // `result` is empty when Square could not be reached; the dashboard feed
      // stands alone, which is the whole point of the inversion.
      const strays = (result || []).filter((o) => !known.has(o.orderId) && !knownSquare.has(o.orderId));
      if (strays.length) {
        // Loud, because it means an order reached Square and never reached here
        // — a sync gap, not a display quirk.
        console.warn(`get-orders: ${strays.length} Square order(s) missing from the dashboard feed: `
          + strays.map((o) => o.orderNumber || o.orderId).join(', '));
      }
      merged = [...adminOrders, ...strays];
      source = strays.length ? 'dashboard+square' : 'dashboard';
    } else {
      merged = [...result, ...dashboardOnly];
      source = 'square';
    }

    // Newest first, across both sources, so a counter sale and a web order sit
    // in one chronological list rather than two.
    merged.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ orders: merged, source }),
    };

  } catch (err) {
    console.error('get-orders error:', err.message, err.stack);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
