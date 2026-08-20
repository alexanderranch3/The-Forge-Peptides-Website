// Shared helper (NOT an endpoint). THE product catalog: what the storefront
// sells, what it is called, what it costs and its SKU.
//
// WHY THIS IS ITS OWN FILE
// It lived inside create-invoice.js, which already requires _invoice.js — so
// _invoice.js could not require it back to print SKUs without a circular
// import. Node would have resolved that cycle by handing _invoice a
// half-initialised module with CATALOG still undefined, and the SKUs would have
// come out blank on the invoice with nothing to show why. One module, required
// by everything that needs it, and no cycle to reason about.
//
// NEVER trust client-supplied prices or names — a manipulated POST body could
// otherwise generate a valid invoice at any price. Keep in sync with index.html.
//
// 🔑 THE NAME HAS TO IDENTIFY THE VIAL TO BE PACKED, not just the product line.
// Frank, 2026-08-19: "the items were not specific. For example, Wolverine Blend
// came back. I didn't know which one it was or what the amounts were." Two
// Wolverines exist at different strengths and prices, and so do two Phoenixes.
// A name that cannot tell them apart is a mis-pack waiting to happen, and the
// customer is the one who finds out.
//
// 🔑 SKU IS THE THING TO CHECK AGAINST THE VIAL. Short, unique, and carrying the
// strengths, so a packer reads WOLV-10-10 against the label instead of parsing
// "BPC-157 10mg / TB-500 10mg" every time. Deliberately NOT prefixed FP- : that
// is the order-number series and the two must never be confused.
// check-prices.js gates that every entry has one and that no two share it.

const CATALOG = {
  // 🚨 `name` IS THE STRING SQUARE STORES ON THE ORDER LINE, AND IT IS LOAD-BEARING.
  // resolve_variant() matches it EXACTLY against variant_aliases (norm_name
  // equality, never a partial match), so renaming a product here silently stops
  // its sales from deducting stock — the line lands with needs_review and no
  // variant. Do not touch `name` without adding the new spelling to
  // variant_aliases in the same migration.
  //
  // `label` is what a HUMAN reads on the invoice and packs from. It carries the
  // full composition and it is free to change, because nothing resolves on it.
  // `sku` is what gets checked against the vial.
  //
  // id                            sku                        price  name (Square/stock)              label (invoice/packing)
  'retatrutide-10mg':           { sku: 'RETA-10',            price: 160, name: 'Retatrutide 10mg',               label: 'Retatrutide 10mg' },
  'retatrutide-15mg':           { sku: 'RETA-15',            price: 195, name: 'Retatrutide 15mg',               label: 'Retatrutide 15mg' },
  'retatrutide-30mg':           { sku: 'RETA-30',            price: 275, name: 'Retatrutide 30mg',               label: 'Retatrutide 30mg' },
  'tesamorelin-10mg':           { sku: 'TESA-10',            price: 89,  name: 'Tesamorelin 10mg',               label: 'Tesamorelin 10mg' },
  'sermorelin-10mg':            { sku: 'SERM-10',            price: 119, name: 'Sermorelin 10mg',                label: 'Sermorelin 10mg' },
  'ipamorelin-10mg':            { sku: 'IPA-10',             price: 99,  name: 'Ipamorelin 10mg',                label: 'Ipamorelin 10mg' },
  'mots-c-10mg':                { sku: 'MOTS-10',            price: 72,  name: 'MOTS-C 10mg',                    label: 'MOTS-C 10mg' },
  'ghk-cu-50mg':                { sku: 'GHK-50',             price: 75,  name: 'GHK-Cu 50mg',                    label: 'GHK-Cu 50mg' },
  'ghk-cu-100mg':               { sku: 'GHK-100',            price: 85,  name: 'GHK-Cu 100mg',                   label: 'GHK-Cu 100mg' },
  'ss-31-10mg':                 { sku: 'SS31-10',            price: 82,  name: 'SS-31 10mg',                     label: 'SS-31 10mg' },
  'semax-10mg':                 { sku: 'SEMAX-10',           price: 99,  name: 'Semax 10mg',                     label: 'Semax 10mg' },
  'selank-10mg':                { sku: 'SELANK-10',          price: 95,  name: 'Selank 10mg',                    label: 'Selank 10mg' },
  'dsip-5mg':                   { sku: 'DSIP-5',             price: 62,  name: 'DSIP 5mg',                       label: 'DSIP 5mg' },
  'nad-100mg':                  { sku: 'NAD-100',            price: 85,  name: 'NAD+ 100mg',                     label: 'NAD+ 100mg' },
  'nad-500mg':                  { sku: 'NAD-500',            price: 99,  name: 'NAD+ 500mg',                     label: 'NAD+ 500mg' },
  'nad-1000mg':                 { sku: 'NAD-1000',           price: 140, name: 'NAD+ 1000mg',                    label: 'NAD+ 1000mg' },
  'melanotan-ii-10mg':          { sku: 'MTII-10',            price: 65,  name: 'Melanotan II 10mg',              label: 'Melanotan II 10mg' },
  'reconstitution-liquid-30ml': { sku: 'RECON-30ML',         price: 40,  name: 'Reconstitution Liquid 30ml',     label: 'Reconstitution Liquid 30ml' },
  'bpc-157-10mg':               { sku: 'BPC-10',             price: 60,  name: 'BPC-157 10mg',                   label: 'BPC-157 10mg' },
  // 🚨 THE ONES THAT GET MIS-PACKED. "Wolverine Stack" does not say its strength
  // at all, which is what put an unidentifiable line on a real invoice on
  // 2026-08-19. The labels below state the full composition, word for word as
  // the price list on index.html already does — while `name` stays exactly as it
  // was, so every existing variant_alias still matches.
  'wolverine-stack':            { sku: 'WOLV-10-10',         price: 115, name: 'Wolverine Stack',                label: 'Wolverine Stack — BPC-157 10mg / TB-500 10mg' },
  'wolverine-blend-5mg':        { sku: 'WOLV-5-5',           price: 100, name: 'Wolverine Blend 5mg/5mg',        label: 'Wolverine Blend — BPC-157 5mg / TB-500 5mg' },
  'cjc1295-ipamorelin':         { sku: 'CJC-5-5',            price: 99,  name: 'CJC-1295 / Ipamorelin (No DAC)', label: 'CJC-1295 (No DAC) 5mg / Ipamorelin 5mg' },
  // 🗄️ 'phoenix-blend' (the ORIGINAL Tesamorelin 10mg / Ipamorelin 5mg, PHX-10-5)
  // was retired 2026-08-20 at Frank's request and removed from here, which is what
  // takes it off the shop — CATALOG is what decides "sold on the site". Its SKU now
  // lives on variants.sku (migration 046) so the 24 historical order lines that
  // sold it keep printing PHX-10-5 on their packing lists. 24 lines of history, and
  // the 12/2 New Formula below is a DIFFERENT VIAL — do not repoint the old name at
  // it. To bring it back: restore this line and put site_catalog_id back on the
  // variant, then clear variants.sku.
  'phoenix-blend-12-2':         { sku: 'PHX-12-2',           price: 155, name: 'Phoenix Blend (12mg/2mg)',       label: 'Phoenix Blend — Tesamorelin 12mg / Ipamorelin 2mg' },
  'glow-blend':                 { sku: 'GLOW-50-10-10',      price: 165, name: 'Glow Blend',                     label: 'Glow Blend — GHK-Cu 50mg / BPC-157 10mg / TB-500 10mg' },
  'klow-blend':                 { sku: 'KLOW-50-10-10-10',   price: 195, name: 'KLOW Blend',                     label: 'KLOW Blend — GHK-Cu 50mg / BPC-157 10mg / TB-500 10mg / KPV 10mg' },
};

// Everything a packing line needs for one product, or null when the id is not
// something we sell. Callers must handle null rather than assume — an order can
// carry a line that no longer maps to a catalog entry, and inventing a SKU for
// it would be worse than printing none.
function catalogEntry(id) {
  return (id && CATALOG[id]) ? CATALOG[id] : null;
}

// Exact reverse lookup, name -> id, built from CATALOG itself.
//
// 🔑 NOT a guess, and deliberately not nameToId. This matches only strings this
// file itself produced, and CATALOG names are unique, so an exact hit is a
// certainty rather than an inference. It exists because nameToId refuses
// "Wolverine Stack" — correctly, since Square's own naming cannot tell the two
// Wolverines apart from that string. Our catalog can: it is the name we wrote.
//
// Anything not written by us returns null and the caller keeps what it had.
const BY_NAME = new Map(Object.entries(CATALOG).map(([id, e]) => [norm(e.name), id]));

function norm(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function idForName(name) {
  return BY_NAME.get(norm(name)) || null;
}

/**
 * What a packing line should say for a stored line-item name.
 *
 * Returns { sku, label } when the product is identifiable, and { sku: null,
 * label: <the name as stored> } when it is not. ⚠️ Never invents a SKU: a SKU
 * that might be wrong is worse than none, because its whole job is to be the
 * thing you trust when checking a vial.
 */
function packingLine(name, fallbackId = null) {
  const entry = catalogEntry(fallbackId) || catalogEntry(idForName(name));
  return entry
    ? { sku: entry.sku, label: entry.label }
    : { sku: null, label: name };
}

module.exports = { CATALOG, catalogEntry, idForName, packingLine };
