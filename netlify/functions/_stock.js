// Shared helper (NOT an endpoint). Answers "how many of this can I actually
// sell right now" from the DASHBOARD, which is replacing Square as the system
// of record for stock.
//
// ── The cutover is deliberate and reversible ─────────────────────────────────
// STOCK_SOURCE controls which system the storefront believes:
//   'square'    (default) — Square's sold_out flag, the behaviour that has always
//                           shipped. Nothing changes until it is switched.
//   'dashboard'           — real counts from Supabase.
//
// 🚨 DO NOT SWITCH THIS UNTIL DASHBOARD STOCK IS TRUE. As of 2026-08-17 the
// dashboard has Retatrutide 10mg at 0 while 20 vials sit unreceived on Direct
// Peptides #3946 — flipping today would mark the best seller sold out and turn
// customers away. Receive the outstanding purchase orders and get the sales sync
// deployed first, then flip. That is the entire reason this is an env var and
// not a code change.
//
// 🔑 IT FAILS OPEN, ALWAYS. If Supabase is slow, unreachable, or does not know a
// product, this reports "unknown" and every caller falls back to the old
// behaviour. An outage in a reporting database must never invent a sold-out sign
// on a product you actually have — a false "sold out" is a lost sale that nobody
// ever finds out about.

const { nameToId } = require('./_catalog-map');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

// Short on purpose: this sits in the path of a page load and a checkout.
const TIMEOUT_MS = 4000;

function stockSource() {
  return String(process.env.STOCK_SOURCE || 'square').toLowerCase() === 'dashboard'
    ? 'dashboard' : 'square';
}

/**
 * The name a dashboard row is matched under.
 *
 * 🔑 Extracted 2026-08-19 so the watchdog can ask "would this row name-match?"
 * using the SAME string checkout builds. Re-deriving it there would be the
 * _catalog-map.js mistake again: two copies that agree today and disagree the
 * moment either changes, with the divergence invisible until a product sells
 * as the wrong thing.
 */
function variantDisplayName(r) {
  return [r.product_name, r.variant_name].filter(Boolean).join(' ');
}

/**
 * Map every dashboard variant onto a site catalog id.
 *
 * `site_catalog_id` wins outright — that is the explicit, editable pin, and when
 * it is set no guessing happens at all. Name matching is only the fallback for
 * products nobody has pinned yet. Two variants can legitimately land on one site
 * id (the storefront sells one "Retatrutide 10mg" whatever the catalog history),
 * so quantities are summed.
 */
function indexBySiteId(rows) {
  const bySite = {};
  for (const r of rows || []) {
    const name = variantDisplayName(r);
    const id = r.site_catalog_id || nameToId(name);
    if (!id) continue;
    if (!bySite[id]) bySite[id] = { on_hand: 0, variants: [] };
    bySite[id].on_hand += Number(r.on_hand || 0);
    bySite[id].variants.push(r.variant_id);
  }
  return bySite;
}

/**
 * Current sellable stock per site catalog id.
 * Returns null — never an empty map — when the dashboard cannot answer, so a
 * caller can tell "nothing in stock" apart from "I don't know".
 */
async function fetchStock() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/v_inventory_dashboard?select=variant_id,product_name,variant_name,site_catalog_id,on_hand`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      },
    );
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return indexBySiteId(rows);
  } catch {
    // Deliberately swallowed. Every caller treats null as "carry on as before".
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check a basket against real stock.
 *
 * Returns { ok: true } when the dashboard is not the source, cannot answer, or
 * has enough of everything. Returns { ok: false, shortages: [...] } only when it
 * positively knows there is not enough — the one case worth refusing a sale over.
 *
 * A product the dashboard has never heard of is NOT a shortage. It is a gap in
 * the mapping, and refusing a sale over our own bookkeeping would be the worst
 * possible way to find out about it.
 */
async function checkAvailability(items) {
  if (stockSource() !== 'dashboard') return { ok: true, checked: false, reason: 'source is square' };

  const stock = await fetchStock();
  if (!stock) return { ok: true, checked: false, reason: 'dashboard unavailable' };

  const shortages = [];
  for (const item of items || []) {
    const entry = stock[item.id];
    if (!entry) continue;                       // unknown product — never block
    if (entry.on_hand < item.qty) {
      shortages.push({ id: item.id, name: item.name, wanted: item.qty, available: Math.max(0, entry.on_hand) });
    }
  }
  return shortages.length
    ? { ok: false, checked: true, shortages }
    : { ok: true, checked: true };
}

// Human-readable, and specific enough to act on. "Out of stock" with no number
// makes a customer email to ask; "only 2 left" lets them just change the box.
function shortageMessage(shortages) {
  return shortages.map((s) => (s.available === 0
    ? `${s.name} is out of stock`
    : `Only ${s.available} of ${s.name} ${s.available === 1 ? 'is' : 'are'} left — you asked for ${s.wanted}`))
    .join('. ') + '.';
}

/**
 * Products we hold stock of but cannot ship — today, no labels for BPC-157 10mg
 * or MOTS-C 10mg.
 *
 * 🚨 THIS IS NOT GATED ON STOCK_SOURCE, and that is the whole point. The stock
 * gate above is inert until the cutover, but an unlabelled vial cannot ship
 * regardless of which system we believe about quantities. Selling it would mean
 * taking money for something that physically cannot go out.
 *
 * 🔑 It also cannot be expressed with is_hidden — and the reason is stronger
 * than this comment used to claim. It said "v_inventory_dashboard FILTERS hidden
 * variants, so a hidden product reaches the stock map as unknown, and unknown
 * fails OPEN". CHECKED 2026-08-20 AND THAT FILTER DOES NOT EXIST: all 11 hidden
 * variants are in the view, including Retatrutide 10mg with 36 vials on hand and
 * 15 sold. is_hidden is INERT Square-era import residue that nothing reads, so
 * hiding a product would not have stopped it selling at all. MOTS-C was already
 * hidden and would indeed have sold anyway — for that reason, not this one.
 * v_unfulfillable ignores is_hidden deliberately, and migration 029's
 * archived_at is likewise about PURCHASING only, never about sellability.
 */
async function fetchBlocked() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/v_unfulfillable?select=site_catalog_id,reason&site_catalog_id=not.is.null`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      },
    );
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows)) return null;
    // An EMPTY list is a real answer here — "nothing is blocked" — unlike the
    // stock map, where empty means the query went wrong.
    return Object.fromEntries(rows.map((r) => [r.site_catalog_id, r.reason || 'not available']));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Refuse a basket containing anything we cannot ship.
 *
 * ⚠️ Fails OPEN if the list cannot be fetched, consistent with the rest of this
 * file: a reporting outage must not take the whole shop down. That is a
 * deliberate, narrow risk — the belt-and-braces is to also mark the product sold
 * out in Square while it is unshippable.
 */
async function checkFulfillable(items) {
  const blocked = await fetchBlocked();
  if (!blocked) return { ok: true, checked: false, reason: 'blocklist unavailable' };
  const hits = (items || [])
    .filter((i) => blocked[i.id])
    .map((i) => ({ id: i.id, name: i.name, reason: blocked[i.id] }));
  return hits.length ? { ok: false, checked: true, blocked: hits } : { ok: true, checked: true };
}

function blockedMessage(hits) {
  return hits.map((h) => `${h.name} is temporarily unavailable`).join('. ') + '.';
}

module.exports = {
  stockSource, fetchStock, indexBySiteId, variantDisplayName, checkAvailability, shortageMessage,
  fetchBlocked, checkFulfillable, blockedMessage,
};
