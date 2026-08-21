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
const push = require('./_push');
const SUPABASE_KEY_FOR_PUSH = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const { checkAvailability, shortageMessage, checkFulfillable, blockedMessage } = require('./_stock');
const { nameToId } = require('./_catalog-map');
const { CATALOG } = require('./_catalog');
// 🔑 Aliased on purpose: `readSession` in this file would read as "the checkout
// session". This one is the CUSTOMER's sign-in cookie, and it is the only thing
// allowed to decide whose prices apply.
const { readSession: readCustomerSession } = require('./_customer-auth');

// Thrown for anything the caller got wrong, so the handler can answer 400 rather
// than 500. ⚠️ It lived beside the CATALOG literal and came within a line of
// being carried off with it when the catalog moved to its own module on
// 2026-08-19 — test-stock-gate.mjs caught the ReferenceError immediately.
class ValidationError extends Error {}

// ── Step 5 of leaving Square: where a web order is WRITTEN ───────────────────
//
// 🚨 OFF BY DEFAULT, AND THIS IS A ONE-WAY DOOR WHEN IT IS ON. With
// ORDER_SOURCE=dashboard the checkout stops creating Square orders entirely, so
// orders placed after the switch exist HERE AND NOWHERE ELSE. There is no
// rolling those back into Square afterwards.
//
// 🔑 The switch exists so the same code can be proved with a real order before
// it becomes the only path. Flip it in Netlify → Environment variables
// (--context production), reload, place an order, check it landed — address,
// stock, revenue — and flip it back if anything is off.
// A plain Supabase read. This file talks to Supabase only through rpc() today,
// which is a POST — resolving a variant needs a GET.
async function sbGet(path) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase is not configured.');
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Supabase returned ${res.status}`);
  return res.json();
}

const orderSource = () =>
  String(process.env.ORDER_SOURCE || 'square').trim().toLowerCase() === 'dashboard'
    ? 'dashboard' : 'square';

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



const MAX_QTY_PER_ITEM        = 50;
const FREE_SHIPPING_THRESHOLD = 300;
const MAX_SHIPPING_AMOUNT     = 100;
const FALLBACK_SHIPPING       = 25;

// Rebuild every line item from the server-side catalog. Client-supplied price
// and name are ignored entirely. Throws on unknown ids or invalid quantities.
//
// 🚨 `agreed` IS A MAP THE SERVER BUILT FROM THE SESSION COOKIE, never anything
// the browser sent. That distinction is the entire security of per-customer
// pricing: the checkout form's email is attacker-controlled, so keying a price
// off it would mean anyone who knows a customer's address gets their price —
// strictly worse than the leaked promo code this feature replaces. The caller
// gets this map from customerPricesFor(event) below and nowhere else.
function sanitizeItems(rawItems, agreed = null) {
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
    // A price of 0 is a legitimate agreed price, so check for presence rather
    // than truthiness — `agreed[id] || entry.price` would quietly bill a comp
    // at full retail.
    const has = agreed && Object.prototype.hasOwnProperty.call(agreed, raw.id)
      && Number.isFinite(agreed[raw.id]);
    // ⚠️ An agreed price ABOVE list is ignored. Frank sets these to give people
    // a better price; a number above retail is a decimal-point slip, and the
    // customer is the one who would pay for it.
    const useAgreed = has && agreed[raw.id] / 100 <= entry.price;
    return {
      id: raw.id,
      name: entry.name,
      price: useAgreed ? agreed[raw.id] / 100 : entry.price,
      qty,
      list_price: entry.price,
      agreed: useAgreed,
    };
  });
}

// The prices this SIGNED-IN customer has agreed with us, keyed by catalogue id.
//
// 🔑 Identity comes only from the HttpOnly cookie's HMAC — the same rule
// account.js states for itself. A signed-out shopper gets an empty map and
// therefore list price, which is correct: there is no way to recognise someone
// who has not identified themselves, and guessing is the vulnerability.
//
// ⚠️ FAILS OPEN TO LIST PRICE. If the lookup errors, the customer is charged
// retail and the sale goes through. A till must always take money, and the
// worst case here is that someone pays the price everybody else pays.
async function customerPricesFor(event) {
  try {
    const session = readCustomerSession(event.headers || {});
    if (!session) return null;
    const rows = await rpc('customer_prices', { p_account: session.accountId });
    if (!Array.isArray(rows) || !rows.length) return null;
    const out = {};
    for (const r of rows) {
      const cents = Number(r.price_cents);
      if (r.site_catalog_id && Number.isFinite(cents) && cents >= 0) out[r.site_catalog_id] = cents;
    }
    return Object.keys(out).length ? out : null;
  } catch (err) {
    console.error('customer pricing lookup failed, using list price:', err.message);
    return null;
  }
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

// How much each code takes off. 🔑 One place, so the Square path and the
// dashboard path can never disagree about what a customer was charged.
const PROMO_PERCENT = { LOYAL10: 10, FORGE10: 10, OWNER: 100 };
const promoPercent = (label) => PROMO_PERCENT[label] || 0;

async function validatePromo(promoCode, customerId, customerEmail) {
  if (!promoCode) return null;

  // ── The owner's own code — 100% off, for placing real test orders ──────────
  //
  // 🚨 THE CODE ITSELF IS NEVER IN THIS FILE, and that is not a style choice:
  // THIS REPOSITORY IS PUBLIC. A 100%-off code committed here could be read by
  // anyone and used to empty the shelf. It lives in OWNER_PROMO_CODE in Netlify,
  // and if that variable is unset the code simply does not exist — this returns
  // null and the order is charged in full. Fails closed.
  //
  // 🔑 An order using it is INTERNAL, not a SALE (see createOrderInDashboard).
  // It moves stock — the vial really does leave the shelf — but never reaches
  // revenue. Booked as a £0 SALE it would carry real COGS against no income and
  // show up as a LOSS in the books, which is worse than wrong: it is plausible.
  //
  // ⚠️ Every use is logged loudly. If this code ever leaks, the orders tab will
  // show INTERNAL orders nobody placed and the log will say so — rotate the
  // variable and it is dead immediately.
  // 🚨 Case-INSENSITIVE. The checkout box upper-cases what is typed, so
  // A mixed-case code typed into that box arrives here upper-cased, so a
  // case-sensitive match rejected the owner's own code — precisely the bug this
  // fixes. check-promo.js compares the same way, so the page and the charge
  // agree.
  // ⚠️ NEVER write the actual code in a comment here. This repo is public, and
  // test-create-invoice-dashboard.mjs fails the build if it appears.
  const ownerCode = (process.env.OWNER_PROMO_CODE || '').trim();
  if (ownerCode && promoCode.trim().toLowerCase() === ownerCode.toLowerCase()) {
    console.warn(`OWNER PROMO USED — free order for ${customerEmail || 'unknown email'}`);
    return 'OWNER';
  }

  // LOYAL10 — 10% off every order, no restrictions
  if (promoCode === 'LOYAL10') return 'LOYAL10';

  // ── FORGE10 on the dashboard path (step 5) ─────────────────────────────────
  // 🔑 Same question, asked of the system that now holds the orders: has this
  // email bought before? Square's customer id does not exist on this path.
  //
  // ⚠️ IT KEEPS THE ORIGINAL STANCE: if the answer cannot be established, the
  // discount is DENIED. A first-order discount that cannot be verified is a
  // repeatable discount, and handing one out is worse than refusing one.
  if (promoCode === 'FORGE10' && !customerId) {
    if (!customerEmail) return null;
    try {
      const parties = await sbGet(
        `parties?select=id&email=eq.${encodeURIComponent(customerEmail)}&merged_into_id=is.null`);
      if (!parties.length) return 'FORGE10';   // never seen — genuinely a first order
      const ids = parties.map((x) => x.id).join(',');
      const prior = await sbGet(
        `orders?select=id&purpose=eq.SALE&state=neq.CANCELED&party_id=in.(${ids})&limit=1`);
      return prior.length ? null : 'FORGE10';
    } catch (err) {
      console.error('FORGE10 dashboard lookup failed:', err.message);
      return null;
    }
  }

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
// A stable uid so line items can point at the discount, the way they already
// point at FL_TAX_UID. Only used when a basket mixes agreed and ordinary lines.
const PROMO_UID = 'forge-promo';
const FL_TAX_UID  = 'fl-sales-tax';

/**
 * Write the order into the DASHBOARD instead of Square (step 5).
 *
 * 🔑 THE MONEY RULES ARE MIRRORED FROM SQUARE'S, not reinvented, and the real
 * orders confirm them. FP-001067 carries $160.00 of product, $25.00 shipping and
 * an $18.50 discount — which is 10% of product PLUS shipping, not product alone
 * — with tax on the product subtotal only. Both are reproduced below, and
 * test-create-invoice-dashboard.mjs asserts the two paths agree on the total for
 * the same basket. A checkout that charges a different number depending on an
 * environment variable would be the worst possible outcome here.
 *
 * 🔑 THE ORDER NUMBER COMES BACK FROM THE DATABASE. create_manual_order mints
 * its own FP-xxxxxx from a sequence, so using the locally generated one would
 * put a number on the customer's email that matches nothing in the system.
 *
 * 🚨 STOCK MOVES INSIDE THE SAME TRANSACTION as the order — create_manual_order
 * writes the ledger row itself. So unlike the Square path there is no separate
 * "deduct stock" step that can fail on its own and leave a sale with no
 * movement behind it.
 */
async function createOrderInDashboard({
  items, shippingAmount, shippingLabel, promoValid, fulfillment,
  customerName, customerEmail, customerPhone, street, city, state, zip, notes,
}) {
  const productCents = items.reduce((n, i) => n + Math.round(i.price * 100) * i.qty, 0);
  const shipCents    = Math.round((shippingAmount || 0) * 100);

  // Local pickup is always FL; shipping to FL is taxed, elsewhere is not.
  // Shipping itself is not taxable in Florida.
  const applyFlTax = fulfillment === 'Local Pickup' || String(state || '').toUpperCase() === 'FL';

  // 🚨 A NEGOTIATED PRICE IS FINAL — A PROMO CODE CANNOT CUT IT FURTHER.
  // Frank, 2026-08-20: "if any prices are adjusted on my end, those prices can't
  // be adjusted further by a promo code." So this is not "the better of the
  // two": it is a per-LINE exclusion. A basket holding one agreed line and one
  // ordinary line still discounts the ordinary one normally.
  // 🔑 With no agreed line, agreedCents is 0 and every expression below is
  // arithmetically identical to what it was before — same single rounding, same
  // base. A test asserts the untouched baskets still charge to the cent.
  const agreedCents = items.reduce(
    (n, i) => (i.agreed ? n + Math.round(i.price * 100) * i.qty : n), 0);

  // ORDER scope in Square, so it covers shipping too — proven by FP-001067
  // ($160.00 product + $25.00 shipping, $18.50 off = 10% of $185.00).
  const pct        = promoPercent(promoValid);
  const discBase   = productCents - agreedCents + shipCents;
  const discCents  = pct ? Math.round(discBase * (pct / 100)) : 0;

  // 🚨 TAX IS CHARGED ON THE DISCOUNTED AMOUNT, NOT THE FULL SUBTOTAL. Every
  // real discounted order says so to two decimal places: FP-396224, FP-507650,
  // FP-001136, FP-001134 and FP-001104 all show tax at exactly 7.00% of
  // (subtotal − discount) and 6.30% of the subtotal.
  //
  // ⚠️ This was wrong when step 5 shipped, and the admin form's own hint still
  // claimed "before discount, the way Square applies it". A 100%-off order would
  // have been charged $11.20 of tax on a free basket. The lesson: the storefront
  // had it right all along, and the assertion that agreed with the hint was
  // testing a premise nobody had checked against the books.
  // 🔑 The product's share of the discount, which is what reduces taxable value —
  // the shipping share never did. With nothing agreed this is exactly the old
  // expression `productCents * (1 - pct/100)`; the two only diverge once a line
  // is excluded from the base, and then the excluded line is fully taxable,
  // which is right because nothing was discounted off it.
  const taxableCents = agreedCents === 0
    ? Math.round(productCents * (1 - pct / 100))
    : productCents - (pct ? Math.round((productCents - agreedCents) * (pct / 100)) : 0);
  const taxCents     = applyFlTax ? Math.round(taxableCents * (FL_TAX_RATE / 100)) : 0;

  // 🔑 An owner test order is INTERNAL, not a SALE. It moves stock because the
  // vial really does leave, but it is not income — and a $0 SALE would carry
  // real COGS against no revenue and read as a loss.
  const isOwner = promoValid === 'OWNER';

  // 🔑 create_manual_order takes a VARIANT id, so the site's catalogue id has to
  // be resolved first. Migration 020 pinned every storefront variant to its site
  // id precisely so this is a lookup and never a guess.
  //
  // 🚨 IT REFUSES RATHER THAN GUESSING. If a product on the site has no variant
  // here, the sale cannot deduct stock and cannot reach revenue — recording it
  // anyway would create exactly the silent hole this whole migration has been
  // closing. It throws BEFORE anything is written, so the customer gets an error
  // instead of a stranded order, and this file's hard rule is respected: nothing
  // AFTER the order exists may fail. All 26 catalogue ids map today, so this is
  // a guard against future drift, not a live risk.
  const siteIds = [...new Set(items.map((i) => nameToId(i.name)).filter(Boolean))];
  const variantRows = siteIds.length
    ? await sbGet(`variants?select=id,site_catalog_id&site_catalog_id=in.(${siteIds.join(',')})`)
    : [];
  const bySiteId = new Map((variantRows || []).map((v) => [v.site_catalog_id, v.id]));

  const lines = items.map((i) => {
    const siteId = nameToId(i.name);
    const variantId = siteId ? bySiteId.get(siteId) : null;
    if (!variantId) {
      throw new Error(`No product record for "${i.name}" — the order was not placed.`);
    }
    return {
      kind: 'PRODUCT',
      variant_id: variantId,
      // The stored name stays exactly what the site sells it as: it is what
      // resolve_variant matches on, and renaming silently stops stock deducting.
      name: i.name,
      quantity: i.qty,
      unit_price_cents: Math.round(i.price * 100),
    };
  });

  const isShip = fulfillment === 'Ship';
  const payload = {
    client_uid: `web-${idempotencyKey()}`,
    purpose: isOwner ? 'INTERNAL' : 'SALE',
    // Zelle is paid after the fact, so a web order starts unpaid — exactly as
    // it did through Square. set-order-status is what marks it paid later.
    // Nothing is owed on a free order, so it does not sit in "awaiting Zelle".
    payment_state: isOwner ? 'PAID' : 'AWAITING_PAYMENT',
    channel: 'WEBSITE',
    tax_cents: taxCents,
    discount_cents: discCents,
    shipping_cents: shipCents,
    note: notes || null,
    customer: { name: customerName, email: customerEmail, phone: customerPhone || null },
    lines,
    fulfillment: {
      type: isShip ? 'SHIPMENT' : 'PICKUP',
      recipient_name: customerName,
      recipient_email: customerEmail,
      recipient_phone: customerPhone || null,
      ...(isShip ? {
        address_line1: street, city, state_region: state, postal_code: zip, country: 'US',
      } : {}),
    },
  };

  const result = await rpc('create_manual_order', { p: payload });
  const row = Array.isArray(result) ? result[0] : result;
  if (!row || !row.order_no) throw new Error('The order was not recorded: ' + JSON.stringify(result));

  // 🔑 Returned in SQUARE'S SHAPE so the confirmation email and the invoice
  // renderer stay untouched — one invoice design, not two. The totals are the
  // database's, never re-derived here.
  const lineItems = items.map((i) => ({
    name: i.name, quantity: String(i.qty),
    base_price_money: { amount: Math.round(i.price * 100), currency: 'USD' },
    gross_sales_money: { amount: Math.round(i.price * 100) * i.qty, currency: 'USD' },
  }));
  if (shipCents > 0) {
    lineItems.push({
      name: shippingLabel ? `Shipping — ${shippingLabel}` : 'Shipping', quantity: '1',
      base_price_money: { amount: shipCents, currency: 'USD' },
      gross_sales_money: { amount: shipCents, currency: 'USD' },
    });
  }
  return {
    id: row.order_id,
    reference_id: row.order_no,
    created_at: new Date().toISOString(),
    metadata: { forge_order_number: row.order_no, fulfillment_type: isShip ? 'SHIP' : 'LOCAL_PICKUP' },
    line_items: lineItems,
    total_discount_money: { amount: discCents, currency: 'USD' },
    total_tax_money: { amount: taxCents, currency: 'USD' },
    total_money: { amount: row.total_cents, currency: 'USD' },
    _dashboard: true,
    _orderNo: row.order_no,
  };
}

async function createOrder(orderNum, customerId, items, shippingAmount, shippingLabel, promoValid, fulfillment, customerName, customerEmail, customerPhone, street, city, state, zip, notes) {
  // Local pickup is always FL; shipping applies tax only when destination is FL
  const applyFlTax = fulfillment === 'Local Pickup' || (state || '').toUpperCase() === 'FL';

  // Product line items — apply FL tax when shipping to Florida
  // 🚨 A NEGOTIATED PRICE IS FINAL HERE TOO. Square's ORDER-scope discount hits
  // every line, so a basket with an agreed price would have been discounted
  // twice on this path while the dashboard path excluded it — the same order
  // costing two different amounts depending on an environment variable, which
  // is the exact failure the money-rules tests exist to prevent.
  // 🔑 The scope only changes WHEN something is agreed. With an ordinary basket
  // the discount stays ORDER-scope exactly as before, so no existing order's
  // total can shift by a cent on a rounding difference between the two models.
  const anyAgreed = promoValid && items.some((i) => i.agreed);

  const lineItems = items.map(item => {
    const li = {
      name:     item.name,
      quantity: String(item.qty),
      base_price_money: { amount: Math.round(item.price * 100), currency: 'USD' },
    };
    if (applyFlTax) li.applied_taxes = [{ tax_uid: FL_TAX_UID }];
    if (anyAgreed && !item.agreed) li.applied_discounts = [{ discount_uid: PROMO_UID }];
    return li;
  });

  // Shipping is not taxable in Florida — but it IS discountable: the promo is
  // order scope and FP-001067 proves it covers shipping ($160 product + $25
  // shipping, $18.50 off = 10% of $185.00).
  if (shippingAmount > 0) {
    const ship = {
      name: shippingLabel ? `Shipping — ${shippingLabel}` : 'Shipping',
      quantity: '1',
      base_price_money: { amount: Math.round(shippingAmount * 100), currency: 'USD' },
    };
    if (anyAgreed) ship.applied_discounts = [{ discount_uid: PROMO_UID }];
    lineItems.push(ship);
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
    // 🔑 The percentage comes from the same table the dashboard path uses, so
    // the two can never disagree about what a customer was charged — a hardcoded
    // '10' here would have silently billed an owner test order in full if the
    // ORDER_SOURCE switch were ever flipped back.
    const promoLabel = {
      LOYAL10: 'LOYAL10 — 10% Loyal Customer Discount',
      FORGE10: 'FORGE10 — 10% New Customer Discount',
      OWNER:   'Owner test order — 100%',
    }[promoValid] || `${promoValid} discount`;
    orderBody.order.discounts = [anyAgreed
      ? {
          // Applied per line, and deliberately NOT applied to the agreed ones.
          uid: PROMO_UID,
          name: `${promoLabel} (not on your agreed prices)`,
          percentage: String(promoPercent(promoValid)),
          scope: 'LINE_ITEM',
        }
      : {
          name: promoLabel,
          percentage: String(promoPercent(promoValid)),
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

// ── Push the order to Frank's phone ──────────────────────────────────────────
// Added 2026-08-21. The email above already tells him, but email is not a thing
// that taps you on the shoulder. His ask: "notifications when there's an order
// placed directly to my phone, not a text but just a push notification. That
// way, I can check the dashboard when I want to."
//
// 🚨 BEST-EFFORT, ALWAYS. Every failure here is caught and logged and NEVER
// propagates. A customer's order must not fail because a notification could
// not be delivered — the order is the business, the notification is a
// convenience. Same reasoning as the email leg above it.
//
// 🔑 The payload carries the order NUMBER and TOTAL and nothing else. It is
// encrypted end-to-end to the device, but it still passes through Apple's push
// service, so there is no reason to put a customer's address or contact details
// on that wire when the dashboard is one tap away.
async function sendOwnerPush({ orderNum, customerName, order }) {
  if (!push.configured()) return;

  let subs;
  try {
    const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/push_subscriptions?select=id,endpoint,p256dh,auth`, {
      headers: {
        apikey: SUPABASE_KEY_FOR_PUSH,
        Authorization: `Bearer ${SUPABASE_KEY_FOR_PUSH}`,
      },
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}`);
    subs = await res.json();
  } catch (err) {
    console.error('PUSH: could not read subscriptions:', err.message);
    return;
  }
  if (!Array.isArray(subs) || !subs.length) return; // nobody has turned it on

  const total = money(order.total_money?.amount);
  const payload = {
    title: `New order ${orderNum}`,
    body: `${customerName || 'Customer'} — ${total}`,
    tag: `order-${orderNum}`,
    orderNumber: orderNum,
    url: '/admin.html',
  };

  const results = await Promise.all(subs.map((sub) => push.sendPush(sub, payload)));

  // 🔑 A subscription the push service calls dead (404/410) is deleted rather
  // than retried forever. Without this, one reinstalled phone leaves a row that
  // fails on every order until someone notices.
  await Promise.all(results.map(async (r, i) => {
    const sub = subs[i];
    try {
      if (r.gone) {
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/push_subscriptions?id=eq.${sub.id}`, {
          method: 'DELETE',
          headers: { apikey: SUPABASE_KEY_FOR_PUSH, Authorization: `Bearer ${SUPABASE_KEY_FOR_PUSH}` },
        });
        console.warn(`PUSH: dropped dead subscription ${sub.id}`);
        return;
      }
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/push_subscriptions?id=eq.${sub.id}`, {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_KEY_FOR_PUSH, Authorization: `Bearer ${SUPABASE_KEY_FOR_PUSH}`,
          'Content-Type': 'application/json', Prefer: 'return=minimal',
        },
        body: JSON.stringify(r.ok
          ? { last_sent_at: new Date().toISOString(), failures: 0, last_error: null }
          : { last_error: String(r.error || r.status).slice(0, 300) }),
      });
    } catch (bookErr) {
      console.error('PUSH: bookkeeping failed:', bookErr.message);
    }
  }));

  const sent = results.filter((r) => r.ok).length;
  if (sent < results.length) {
    console.error(`PUSH: ${sent}/${results.length} delivered for ${orderNum}`);
  }
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
    //
    // 🔑 The one exception is a price THIS SERVER looked up for THIS session:
    // customerPricesFor() reads the sign-in cookie and asks the database. The
    // browser cannot influence it, and a signed-out shopper gets list price.
    const agreedPrices = await customerPricesFor(event);
    const cleanItems = sanitizeItems(items, agreedPrices);
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

    // ── Where this order gets written (step 5) ───────────────────────────────
    // 🚨 ORDER_SOURCE=dashboard is a ONE-WAY DOOR for every order placed while
    // it is on: they exist here and nowhere else, and cannot be rolled back into
    // Square. It defaults to 'square' so nothing changes until it is set
    // deliberately.
    const writeTo = orderSource();
    let orderNum = orderNumber();
    let customerId = null;
    let validPromo = false;
    let order;

    if (writeTo === 'dashboard') {
      // 🔑 The promo still has to be checked, and it is checked against the
      // DASHBOARD's own history rather than Square's customer record — see
      // validatePromo. Passing null asks it to look the customer up by email.
      validPromo = await validatePromo(promoCode, null, customerEmail);
      order = await createOrderInDashboard({
        items: cleanItems, shippingAmount: shipping, shippingLabel: shipLabel,
        promoValid: validPromo, fulfillment,
        customerName, customerEmail, customerPhone, street, city, state, zip, notes,
      });
      // 🔑 The database mints the order number, so the one on the customer's
      // email matches the one in the system.
      orderNum = order._orderNo;
    } else {
      customerId = await findOrCreateCustomer(customerName, customerEmail, customerPhone);
      validPromo = await validatePromo(promoCode, customerId);
      order = await createOrder(
        orderNum, customerId, cleanItems, shipping, shipLabel, validPromo,
        fulfillment, customerName, customerEmail, customerPhone,
        street, city, state, zip, notes
      );
    }

    // ── Past this point the order EXISTS and the sale is real. Nothing below is
    // allowed to turn a placed order into an error screen for the customer.
    // Failures here get logged for Frank to reconcile, never surfaced.

    // Deduct stock. Verified working on the deactivated Square account
    // (2026-08-13), but wrapped regardless — a stock-sync problem is a
    // bookkeeping issue, not a reason to reject a paying customer.
    // 🔑 Skipped entirely on the dashboard path: create_manual_order writes the
    // stock ledger row inside the same transaction as the order, so there is no
    // separate deduction that can fail on its own and leave a sale with no
    // movement behind it. That is strictly better than this Square step, which
    // could and did fail independently.
    if (writeTo !== 'dashboard') {
      try {
        await adjustInventory(cleanItems);
      } catch (invErr) {
        console.error(`INVENTORY NOT DEDUCTED for ${orderNum}:`, invErr.message);
      }
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
    // 🔑 Nothing to mirror on the dashboard path — the order was written here in
    // the first place. Syncing it would try to key on a Square id it does not
    // have.
    if (writeTo !== 'dashboard') {
      try {
        await syncOrder(order, {
          square_id: customerId, name: customerName,
          email: customerEmail, phone: customerPhone,
        });
      } catch (syncErr) {
        console.error(`DASHBOARD SYNC FAILED for ${orderNum} (re-run Sync in /admin.html):`, syncErr.message);
      }
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

    // The phone alert. Separate try/catch from the email on purpose: one
    // failing must not stop the other, and neither may stop the order.
    try {
      await sendOwnerPush({ orderNum, customerName, order });
    } catch (pushErr) {
      console.error(`ORDER PUSH FAILED for ${orderNum}:`, pushErr.message);
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
