// ─────────────────────────────────────────────────────────────────────────────
// Shared helper (NOT an endpoint — the leading underscore keeps Netlify from
// deploying it as one). The store watchdog: the probes, and nothing else.
//
// Added 2026-08-19, the day the STOCK_SOURCE=dashboard cutover went live.
//
// WHY THIS EXISTS
// Until the cutover, Square was a buffer. If the dashboard was wrong the
// storefront still showed Square's numbers and nobody noticed. That buffer is
// gone: the dashboard now decides what a customer can buy. Within minutes of
// the cutover an unpinned variant put the Semax/Selank combo's 3 vials onto
// standalone Semax 10mg, which had none. Square had it correctly sold out; we
// made it buyable. That was caught because someone happened to be reading the
// diff. The next one will not be.
//
// TWO FAILURE SHAPES, and the second is the expensive one:
//   🔴 Sells what we don't have — a mis-mapped variant, a negative that reads
//      as available, a sold line that took money and moved no stock.
//   🟠 Hides what we do have — the Retatrutide shape: vials on the shelf, the
//      storefront saying sold out. Nobody ever complains about a purchase they
//      quietly didn't make, so this one is silent by construction.
//
// 🔑 THE GOVERNING RULE: ABSENCE OF EVIDENCE IS A FINDING, NEVER A PASS.
// Every probe reports `answered` separately from `ok`. A probe that could not
// run says so and the run goes red. A monitor that quietly degrades to "no
// news" is worse than no monitor, because you trust it.
//
// 🚨 READ-ONLY, ALWAYS. Not one probe writes to business data. The only write
// anywhere in this feature is the run's own result row in `health_checks`, and
// that is recording, not repairing. A monitor that fixes things hides the fault
// it was built to surface.
//
// ⚠️ Probes are pure functions of a `sources` bundle that is fetched once, up
// front. That is what makes them testable: test-watchdog.mjs hands them
// fabricated sources and asserts every failure mode without a network.
// ─────────────────────────────────────────────────────────────────────────────

const { nameToId } = require('./_catalog-map');
const { variantDisplayName } = require('./_stock');
const { CATALOG } = require('./_catalog');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

// 🚨 THE PRODUCTION STORE IS theforgepeptides.com (Netlify).
// forgedpeptides.com is a different site on Wix entirely. Probing it would
// health-check something this code has nothing to do with and report green.
const SITE_URL = process.env.SITE_URL || process.env.URL || 'https://theforgepeptides.com';

// Generous next to health-check.js's 4s: this runs on a schedule and behind an
// admin page, never in a customer's checkout, so a slow answer beats no answer.
const TIMEOUT_MS = 8000;

// A label problem that lasts a fortnight has quietly become a dead product.
const BLOCKED_DAYS = 14;

// ⚠️ The proposal said 48 hours, written while Square was still the order feed.
// Post-cutover there is no sync to drift from — Square is deactivated and every
// new sale is written here directly — so this now asks a different question:
// "has the till gone quiet?" At roughly two or three orders a week, 48 hours
// would fire most Mondays, and a banner that cries wolf gets scrolled past.
// Seven days is quiet enough to mean something. It is advisory, never a page.
const QUIET_DAYS = 7;

// Bounded so this cannot become a full-table scan as the order history grows.
// 49 orders exist today; if this limit is ever reached the probe says so rather
// than silently reporting on a slice.
const ORDER_LIMIT = 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Fetching ─────────────────────────────────────────────────────────────────

async function fetchWithTimeout(url, options = {}, ms = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// One Supabase read. Returns a shape that can express "I could not answer",
// because every caller has to be able to tell that apart from "nothing found".
async function sb(query) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { ok: false, rows: null, error: 'Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_KEY).' };
  }
  try {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${query}`, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Accept: 'application/json',
      },
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, rows: null, error: `Supabase ${res.status}: ${text.slice(0, 200)}` };
    const rows = JSON.parse(text);
    if (!Array.isArray(rows)) return { ok: false, rows: null, error: 'Supabase returned a non-array body.' };
    return { ok: true, rows, error: null };
  } catch (err) {
    return {
      ok: false, rows: null,
      error: err.name === 'AbortError' ? `Supabase timed out after ${TIMEOUT_MS}ms` : err.message,
    };
  }
}

// What a customer's browser is actually served.
//
// 🔑 Deliberately NOT cache-busted. get-inventory sets max-age=60, so a cached
// answer is exactly what a real visitor gets — and a stale CDN entry serving a
// sold-out sign over stock we hold is a genuine finding, not noise to route
// around. Probe the store, not our idea of the store.
async function fetchStorefront() {
  try {
    const res = await fetchWithTimeout(`${SITE_URL}/.netlify/functions/get-inventory`);
    const text = await res.text();
    if (!res.ok) return { ok: false, feed: null, error: `get-inventory returned ${res.status}: ${text.slice(0, 200)}` };
    const feed = JSON.parse(text);
    if (!feed || typeof feed !== 'object') return { ok: false, feed: null, error: 'get-inventory returned a non-object body.' };
    return { ok: true, feed, error: null, source: feed._source || null };
  } catch (err) {
    return {
      ok: false, feed: null,
      error: err.name === 'AbortError' ? `The storefront timed out after ${TIMEOUT_MS}ms` : err.message,
    };
  }
}

/**
 * Everything every probe needs, fetched once.
 *
 * The order-shaped query pulls tenders and line items as embedded resources so
 * three separate probes read one response. The stock-ledger follow-up is the
 * only conditional call, and it only happens when there is something to ask
 * about.
 */
async function gatherSources() {
  const [inventory, unfulfillable, blockedVariants, unmappedSales, orders, storefront] = await Promise.all([
    sb('v_inventory_dashboard?select=variant_id,product_name,variant_name,is_hidden,site_catalog_id,on_hand,price_cents,unit_cost_cents,status'),
    sb('v_unfulfillable?select=variant_id,site_catalog_id,product_name,variant_name,reason,on_hand'),
    sb('variants?select=id,name,sku,site_catalog_id,unfulfillable_reason,updated_at&fulfillable=eq.false'),
    sb('v_product_sales?select=order_no,placed_at,name_at_sale,quantity,line_item_id,revenue_cents&variant_id=is.null'),
    sb(`orders?select=id,order_no,purpose,state,payment_state,placed_at,total_cents,tenders(id),order_line_items(id,kind)&state=neq.CANCELED&order=placed_at.desc&limit=${ORDER_LIMIT}`),
    fetchStorefront(),
  ]);

  // Only orders that took no money can have moved stock without it, so the
  // ledger question is asked about those line items and no others.
  let saleLedger = { ok: true, rows: [], error: null, skipped: true };
  if (orders.ok) {
    const suspectLineIds = orders.rows
      .filter((o) => (o.tenders || []).length === 0 && o.purpose === 'SALE')
      .flatMap((o) => (o.order_line_items || []).filter((li) => li.kind === 'PRODUCT').map((li) => li.id));
    if (suspectLineIds.length) {
      saleLedger = await sb(
        `stock_ledger?select=id,variant_id,delta,order_line_item_id,occurred_at&reason=eq.SALE`
        + `&order_line_item_id=in.(${suspectLineIds.join(',')})`,
      );
    }
  }

  return { inventory, unfulfillable, blockedVariants, unmappedSales, orders, saleLedger, storefront, now: Date.now() };
}

// ── Probe plumbing ───────────────────────────────────────────────────────────

const FAMILY_SEVERITY = {
  infra: 'critical',   // the monitor itself cannot see
  sells: 'critical',   // we are selling something we do not have
  hides: 'warning',    // we are hiding something we do have
  books: 'advisory',   // the money record disagrees with itself
};

function probe(name, family, { answered, findings = [], note = null, unanswered_reason = null }) {
  return {
    probe: name,
    family,
    severity: FAMILY_SEVERITY[family],
    answered,
    // 🔑 Unanswered is never ok. This single line is the anti-silence rule.
    ok: answered && findings.length === 0,
    findings,
    unanswered_reason,
    note,
  };
}

// Shorthand for "this probe's data source could not answer".
function blind(name, family, reason) {
  return probe(name, family, { answered: false, unanswered_reason: reason });
}

// ── The storefront view of a dashboard row ───────────────────────────────────
// Mirrors _stock.js exactly: an explicit pin wins, a name match is the fallback,
// and an unresolvable name is left alone rather than guessed at.
function siteIdFor(row) {
  return row.site_catalog_id || nameToId(variantDisplayName(row)) || null;
}

// ── 🔴 Sells what we don't have ──────────────────────────────────────────────

function probeNegativeStock(s) {
  if (!s.inventory.ok) return blind('negative_stock', 'sells', s.inventory.error);
  const findings = s.inventory.rows
    .filter((r) => Number(r.on_hand) < 0)
    .map((r) => ({
      product: variantDisplayName(r),
      variant_id: r.variant_id,
      on_hand: Number(r.on_hand),
      what: 'Stock is below zero, so more has been sold than was ever received.',
    }));
  return probe('negative_stock', 'sells', { answered: true, findings });
}

// The Semax class, and the reason migration 020 exists. An unpinned variant
// whose NAME happens to resolve to a storefront id is selling that product's
// stock by coincidence, and a rename anywhere re-points it silently.
//
// 🔑 Three variants are unpinned ON PURPOSE (Retatrutide 12mg and 24mg, and the
// Semax/Selank combo) and nameToId returns null for all three by design — so
// they do not appear here. If one ever does, the mapping changed underneath
// them and that is exactly what this is watching for.
function probeUnpinnedVariant(s) {
  if (!s.inventory.ok) return blind('unpinned_variant', 'sells', s.inventory.error);
  const findings = s.inventory.rows
    .filter((r) => !r.site_catalog_id)
    .map((r) => ({ row: r, id: nameToId(variantDisplayName(r)) }))
    .filter((x) => x.id)
    .map(({ row, id }) => ({
      product: variantDisplayName(row),
      variant_id: row.variant_id,
      on_hand: Number(row.on_hand),
      resolves_to: id,
      what: `Not pinned, but its name resolves to "${id}" — its ${row.on_hand} unit(s) are being sold as that product by name matching alone.`,
      fix: 'Pin it: update variants set site_catalog_id = … , then re-run audit-pins.mjs.',
    }));
  return probe('unpinned_variant', 'sells', { answered: true, findings });
}

// ⚠️ NARROWER THAN THE PROPOSAL, deliberately, and this is the change to know
// about. The proposal said "two rows map to the same site_catalog_id". But
// _stock.js SUMS them on purpose — the storefront sells one "Retatrutide 10mg"
// whatever the catalog history behind it, and test-stock-gate.mjs pins that
// behaviour with two dsip-5mg rows adding to 7. Firing on every duplicate would
// report a documented, tested, correct design as a fault every six hours, and a
// banner that is always red is a banner nobody reads.
//
// 🔑 So the finding is two DIFFERENT things sharing one storefront id — rows
// that disagree on the product name or on the price. Same product, two catalog
// rows, one price is the legitimate case and stays quiet.
function probeDuplicateSiteId(s) {
  if (!s.inventory.ok) return blind('duplicate_site_id', 'sells', s.inventory.error);
  const groups = {};
  for (const r of s.inventory.rows) {
    if (!r.site_catalog_id) continue;   // name-matched collisions are unpinned_variant's job
    (groups[r.site_catalog_id] ||= []).push(r);
  }
  const findings = [];
  for (const [id, rows] of Object.entries(groups)) {
    if (rows.length < 2) continue;
    const names  = new Set(rows.map((r) => String(r.product_name || '').trim().toLowerCase()));
    const prices = new Set(rows.map((r) => Number(r.price_cents)));
    if (names.size === 1 && prices.size === 1) continue;   // the legitimate merge
    findings.push({
      site_catalog_id: id,
      variants: rows.map((r) => ({ variant_id: r.variant_id, product: variantDisplayName(r), price_cents: r.price_cents, on_hand: Number(r.on_hand) })),
      what: names.size > 1
        ? 'Two different products are pinned to one storefront id, so one is being sold as the other.'
        : 'Two variants at different prices are pinned to one storefront id, so their stock is pooled across a price difference.',
    });
  }
  return probe('duplicate_site_id', 'sells', {
    answered: true, findings,
    note: 'Duplicates that agree on product and price are summed by design and are not reported.',
  });
}

// It took money and moved no stock. v_product_sales already restricts itself to
// real sales — purpose SALE, not cancelled, product lines, and a tender on the
// order — so anything here with no variant_id is money in with nothing deducted.
function probeUnmappedSoldLine(s) {
  if (!s.unmappedSales.ok) return blind('unmapped_sold_line', 'sells', s.unmappedSales.error);
  const findings = s.unmappedSales.rows.map((r) => ({
    order_no: r.order_no,
    sold_as: r.name_at_sale,
    quantity: Number(r.quantity),
    revenue_cents: r.revenue_cents,
    placed_at: r.placed_at,
    what: 'This line was paid for but points at no product, so it took money and deducted no stock.',
  }));
  return probe('unmapped_sold_line', 'sells', { answered: true, findings });
}

// On sale with no cost: the margin on it is unmeasurable, and a product whose
// margin nobody can compute is a product that can be sold at a loss forever.
function probeSellableNoCost(s) {
  if (!s.inventory.ok) return blind('sellable_no_cost', 'sells', s.inventory.error);
  if (!s.unfulfillable.ok) return blind('sellable_no_cost', 'sells', s.unfulfillable.error);
  const blocked = new Set(s.unfulfillable.rows.map((r) => r.site_catalog_id).filter(Boolean));
  const findings = s.inventory.rows
    .filter((r) => r.unit_cost_cents === null || r.unit_cost_cents === undefined)
    .filter((r) => Number(r.on_hand) > 0)
    .map((r) => ({ row: r, id: siteIdFor(r) }))
    .filter(({ id }) => id && CATALOG[id] && !blocked.has(id))
    .map(({ row, id }) => ({
      product: variantDisplayName(row),
      variant_id: row.variant_id,
      site_catalog_id: id,
      on_hand: Number(row.on_hand),
      price_cents: row.price_cents,
      what: 'On sale with no unit cost recorded, so its margin cannot be computed at all.',
    }));
  return probe('sellable_no_cost', 'sells', { answered: true, findings });
}

// ── 🟠 Hides what we do have ─────────────────────────────────────────────────

// Everything the storefront sells, that we hold stock of, and that is not
// deliberately blocked. Both hiding probes ask about exactly this set.
function sellableWithStock(s) {
  const blocked = new Set(s.unfulfillable.rows.map((r) => r.site_catalog_id).filter(Boolean));
  const bySite = {};
  for (const r of s.inventory.rows) {
    const id = siteIdFor(r);
    if (!id || !CATALOG[id] || blocked.has(id)) continue;
    (bySite[id] ||= { id, on_hand: 0, products: [] });
    bySite[id].on_hand += Number(r.on_hand || 0);
    bySite[id].products.push(variantDisplayName(r));
  }
  return Object.values(bySite).filter((e) => e.on_hand > 0);
}

// The Retatrutide shape. Stock on the shelf, storefront saying sold out, and no
// customer ever writes in to report a purchase they did not make.
function probeSoldOutWithStock(s) {
  if (!s.inventory.ok)     return blind('sold_out_with_stock', 'hides', s.inventory.error);
  if (!s.unfulfillable.ok) return blind('sold_out_with_stock', 'hides', s.unfulfillable.error);
  if (!s.storefront.ok)    return blind('sold_out_with_stock', 'hides', s.storefront.error);
  const findings = sellableWithStock(s)
    .filter((e) => s.storefront.feed[e.id]?.soldOut === true)
    .map((e) => ({
      site_catalog_id: e.id,
      product: CATALOG[e.id].name,
      on_hand: e.on_hand,
      what: `The storefront shows this sold out while ${e.on_hand} unit(s) sit on the shelf and nothing blocks shipping it.`,
    }));
  return probe('sold_out_with_stock', 'hides', { answered: true, findings });
}

// 🔑 NOT IN THE PROPOSAL — found by pointing the probes at production before
// shipping them. get-inventory builds its response from SQUARE's catalog and
// then only updates keys that already exist (`if (!result[id]) continue`). A
// product that lives in the dashboard and the storefront CATALOG but not in
// Square never appears in the feed at all, so syncInventory() never touches its
// card and it can NEVER show sold out, whatever the count falls to. Today that
// is Retatrutide 30mg: ten vials at $275, absent from the feed entirely.
//
// It is the mirror of sold_out_with_stock and belongs beside it: one is the
// storefront answering wrongly, this is the storefront not answering at all.
function probeNoLiveAnswer(s) {
  if (!s.inventory.ok)     return blind('no_live_answer', 'hides', s.inventory.error);
  if (!s.unfulfillable.ok) return blind('no_live_answer', 'hides', s.unfulfillable.error);
  if (!s.storefront.ok)    return blind('no_live_answer', 'hides', s.storefront.error);
  const findings = sellableWithStock(s)
    .filter((e) => s.storefront.feed[e.id] === undefined)
    .map((e) => ({
      site_catalog_id: e.id,
      product: CATALOG[e.id].name,
      on_hand: e.on_hand,
      what: 'The storefront gets no live answer for this product, so its card cannot go sold out on its own however low stock falls.',
      fix: 'Give it a Square catalog entry, or teach get-inventory to seed its response from CATALOG rather than from Square alone.',
    }));
  return probe('no_live_answer', 'hides', { answered: true, findings });
}

// A label problem that quietly became a dead product.
//
// ⚠️ variants.updated_at is the best signal available and it is not exact: ANY
// update to the row moves it, so this measures "untouched since", not "blocked
// since". It is honest about that rather than pretending to a precision the
// schema does not carry.
function probeBlockedTooLong(s) {
  if (!s.blockedVariants.ok) return blind('blocked_too_long', 'hides', s.blockedVariants.error);
  const findings = s.blockedVariants.rows
    .map((r) => ({ r, days: Math.floor((s.now - Date.parse(r.updated_at)) / DAY_MS) }))
    .filter((x) => Number.isFinite(x.days) && x.days > BLOCKED_DAYS)
    .map(({ r, days }) => ({
      variant_id: r.id,
      site_catalog_id: r.site_catalog_id,
      product: r.name || r.sku || r.id,
      reason: r.unfulfillable_reason,
      days_blocked: days,
      what: `Blocked from sale for ${days} days. Stock is sitting on it and nothing is moving.`,
      fix: "select set_fulfillable('<site id>', true); — no deploy needed.",
    }));
  return probe('blocked_too_long', 'hides', {
    answered: true, findings,
    note: 'Measured from variants.updated_at, which any edit to the row resets.',
  });
}

// ── 🟡 The books ─────────────────────────────────────────────────────────────

function probeQuietOrderFeed(s) {
  if (!s.orders.ok) return blind('quiet_order_feed', 'books', s.orders.error);
  if (s.orders.rows.length === 0) {
    return probe('quiet_order_feed', 'books', {
      answered: true,
      findings: [{ what: 'There are no orders on record at all.' }],
    });
  }
  const newest = s.orders.rows[0];
  const days = Math.floor((s.now - Date.parse(newest.placed_at)) / DAY_MS);
  const findings = days > QUIET_DAYS ? [{
    days_since_last_order: days,
    last_order_no: newest.order_no,
    last_order_at: newest.placed_at,
    what: `No order has been recorded in ${days} days. Either it has been quiet, or orders have stopped reaching the books.`,
  }] : [];
  return probe('quiet_order_feed', 'books', {
    answered: true, findings,
    note: `Threshold ${QUIET_DAYS} days. Advisory — a quiet week is not a fault.`,
  });
}

// The bug migration 018 fixed: a PAID counter sale that wrote no tender never
// reached revenue. This catches its return.
function probePaidNoTender(s) {
  if (!s.orders.ok) return blind('paid_no_tender', 'books', s.orders.error);
  const findings = s.orders.rows
    .filter((o) => o.payment_state === 'PAID' && (o.tenders || []).length === 0)
    .map((o) => ({
      order_no: o.order_no,
      placed_at: o.placed_at,
      total_cents: o.total_cents,
      purpose: o.purpose,
      what: 'Marked paid but carries no tender, so its money is missing from revenue.',
    }));
  return probe('paid_no_tender', 'books', { answered: true, findings });
}

// Stock left the shelf on an order that took no money and is not an internal or
// comped one. Either a sale was never recorded as paid, or stock moved for a
// reason nobody wrote down.
function probeStockMovedNoMoney(s) {
  if (!s.orders.ok) return blind('stock_moved_no_money', 'books', s.orders.error);
  if (!s.saleLedger.ok) return blind('stock_moved_no_money', 'books', s.saleLedger.error);

  const byLineId = {};
  for (const o of s.orders.rows) {
    if ((o.tenders || []).length > 0) continue;
    if (o.purpose === 'INTERNAL' || o.purpose === 'COMP') continue;
    for (const li of o.order_line_items || []) byLineId[li.id] = o;
  }
  const hits = {};
  for (const row of s.saleLedger.rows || []) {
    const o = byLineId[row.order_line_item_id];
    if (!o) continue;
    (hits[o.order_no] ||= { order_no: o.order_no, placed_at: o.placed_at, purpose: o.purpose, units: 0 });
    hits[o.order_no].units += Math.abs(Number(row.delta || 0));
  }
  const findings = Object.values(hits).map((h) => ({
    ...h,
    what: `${h.units} unit(s) left stock on an order with no tender and no INTERNAL/COMP purpose.`,
  }));
  return probe('stock_moved_no_money', 'books', { answered: true, findings });
}

// The page shows $155, the invoice charges $160, and the customer finds out at
// checkout. check-prices.js makes this comparison against the files in the
// build; this makes it against the running site.
function probePriceDrift(s) {
  if (!s.storefront.ok) return blind('price_drift', 'books', s.storefront.error);
  const findings = [];
  for (const [id, entry] of Object.entries(s.storefront.feed)) {
    if (id.startsWith('_')) continue;              // _source and friends
    if (!entry || entry.price === null || entry.price === undefined) continue;
    const known = CATALOG[id];
    if (!known) {
      findings.push({
        site_catalog_id: id, shown_price: entry.price,
        what: 'The storefront is quoting a price for a product the checkout catalog has never heard of, so it cannot be bought at any price.',
      });
      continue;
    }
    if (Math.round(Number(entry.price) * 100) !== Math.round(known.price * 100)) {
      findings.push({
        site_catalog_id: id, product: known.name,
        shown_price: Number(entry.price), charged_price: known.price,
        what: `The storefront shows $${entry.price} and checkout charges $${known.price}.`,
      });
    }
  }
  return probe('price_drift', 'books', { answered: true, findings });
}

// ── Infrastructure ───────────────────────────────────────────────────────────

// Runs first and is named plainly, because when it is red every other probe is
// blind and the breakdown below would otherwise read as twelve separate faults.
function probeReachable(s) {
  const down = [];
  if (!s.inventory.ok)   down.push({ source: 'v_inventory_dashboard', error: s.inventory.error });
  if (!s.orders.ok)      down.push({ source: 'orders',                error: s.orders.error });
  if (!s.storefront.ok)  down.push({ source: 'storefront get-inventory', error: s.storefront.error });
  return probe('reachable', 'infra', {
    answered: true,
    findings: down.map((d) => ({ ...d, what: 'The watchdog cannot see this, so anything it would have reported is unknown rather than fine.' })),
    note: s.storefront.ok ? `storefront stock source: ${s.storefront.source || 'unknown'}` : null,
  });
}

const PROBES = [
  probeReachable,
  probeNegativeStock,
  probeUnpinnedVariant,
  probeDuplicateSiteId,
  probeUnmappedSoldLine,
  probeSellableNoCost,
  probeSoldOutWithStock,
  probeNoLiveAnswer,
  probeBlockedTooLong,
  probeQuietOrderFeed,
  probePaidNoTender,
  probeStockMovedNoMoney,
  probePriceDrift,
];

/** Run every probe against an already-gathered sources bundle. */
function evaluate(sources) {
  const probes = PROBES.map((fn) => fn(sources));
  return { probes, summary: summarize(probes) };
}

function summarize(probes) {
  const failing   = probes.filter((p) => !p.ok);
  const blindOnes = probes.filter((p) => !p.answered);
  const findings  = probes.reduce((n, p) => n + p.findings.length, 0);
  // 🔑 Worst wins, and "could not answer" counts as critical. A monitor that
  // downgrades its own blindness to a warning is telling you it is fine.
  //
  // ⚠️ Written first as a reduce seeded with null, which silently never fired:
  // rank[null] is undefined and `3 > undefined` is false, so worst_severity was
  // null on every run and the banner had no severity to colour itself with. The
  // tests caught it. Kept as an explicit loop — this is the one number the whole
  // alert path is keyed on and it should be impossible to misread.
  const rank = { critical: 3, warning: 2, advisory: 1 };
  let worstRank = 0;
  let worst = null;
  for (const p of failing) {
    const r = rank[p.severity] || 0;
    if (r > worstRank) { worstRank = r; worst = p.severity; }
  }
  return {
    ok: failing.length === 0,
    findings,
    failing: failing.map((p) => p.probe),
    unanswered: blindOnes.map((p) => p.probe),
    worst_severity: worst,
  };
}

/** Fetch, then evaluate. The whole watchdog in one call. */
async function runWatchdog() {
  const startedAt = Date.now();
  const sources = await gatherSources();
  const { probes, summary } = evaluate(sources);
  return {
    checked_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    site: SITE_URL,
    summary,
    probes,
  };
}

// ── Recording (best-effort, never load-bearing) ──────────────────────────────
// One row per probe in `health_checks`, the table health-check.js already uses.
// Probe names are prefixed so a watchdog run can be told apart from an uptime
// probe in the same table.
//
// ⚠️ A logging outage must never turn a healthy store red, nor a broken one
// green — so this is swallowed, reported alongside the result, and never
// consulted by any probe.
const PROBE_PREFIX = 'watchdog.';

// 🚨 `trigger` is not bookkeeping — it is what keeps lastRunAt() honest.
// get-watchdog.js records its runs into the same table, so without this an
// admin opening the dashboard would refresh the "last run" clock and a schedule
// that stopped firing weeks ago would still read as healthy. The check on the
// checker would then be checking the wrong thing.
async function recordRun(result, trigger) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return { logged: false, reason: 'supabase env not set' };
  if (trigger !== 'scheduled' && trigger !== 'admin') {
    return { logged: false, reason: `refusing to record an untagged run (trigger was ${JSON.stringify(trigger)})` };
  }
  try {
    const rows = result.probes.map((p) => ({
      probe: PROBE_PREFIX + p.probe,
      ok: p.ok,
      latency_ms: null,
      detail: {
        trigger,
        family: p.family,
        severity: p.severity,
        answered: p.answered,
        unanswered_reason: p.unanswered_reason,
        findings: p.findings,
        note: p.note,
      },
    }));
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/health_checks`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(rows),
    }, 3000);
    return res.ok ? { logged: true, rows: rows.length } : { logged: false, reason: `supabase ${res.status}` };
  } catch (err) {
    return { logged: false, reason: err.name === 'AbortError' ? 'supabase timed out' : err.message };
  }
}

/**
 * When the SCHEDULED run last reported.
 *
 * 🚨 This is the check on the checker, and it is the whole reason the admin
 * banner runs the probes live instead of reading the last stored run. The
 * account hit a Netlify credit cap on 2026-08-18. If the schedule stops firing,
 * a banner reading yesterday's stored result would show a confident green over
 * a store nobody has looked at in a week — silence dressed up as good news,
 * which is the exact failure this whole feature was written to avoid.
 */
async function lastRunAt() {
  const r = await sb(`health_checks?select=checked_at&probe=like.${PROBE_PREFIX}*`
    + `&detail->>trigger=eq.scheduled&order=checked_at.desc&limit=1`);
  if (!r.ok) return { known: false, reason: r.error };
  if (!r.rows.length) return { known: true, at: null, age_hours: null };
  const at = r.rows[0].checked_at;
  return { known: true, at, age_hours: Math.round((Date.now() - Date.parse(at)) / 36e5) };
}

module.exports = {
  runWatchdog, gatherSources, evaluate, summarize, recordRun, lastRunAt,
  siteIdFor, sellableWithStock,
  probeReachable, probeNegativeStock, probeUnpinnedVariant, probeDuplicateSiteId,
  probeUnmappedSoldLine, probeSellableNoCost, probeSoldOutWithStock, probeNoLiveAnswer,
  probeBlockedTooLong, probeQuietOrderFeed, probePaidNoTender, probeStockMovedNoMoney,
  probePriceDrift,
  QUIET_DAYS, BLOCKED_DAYS, PROBE_PREFIX,
};
