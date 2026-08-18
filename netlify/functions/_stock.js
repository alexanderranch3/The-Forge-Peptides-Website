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
    const name = [r.product_name, r.variant_name].filter(Boolean).join(' ');
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

module.exports = { stockSource, fetchStock, indexBySiteId, checkAvailability, shortageMessage };
