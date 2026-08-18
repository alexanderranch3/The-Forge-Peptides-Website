// Shared helper (NOT an endpoint). The single mapping from a product's NAME to
// the site catalog id used in the storefront, the checkout and the dashboard.
//
// WHY THIS FILE EXISTS
// This function was copy-pasted into create-invoice.js and get-inventory.js, and
// the two copies had already drifted: one tested "ipamorelin" before the
// Retatrutide sizes and the other after. Same answer today, different answer the
// moment either list changes — and the divergence would be invisible until a
// product priced or decremented as the wrong item.
//
// 🔑 The order of these tests IS the logic. Blends are matched before their
// component peptides, because "TESAMORELIN / IPAMORELIN" must become the Phoenix
// Blend and not Ipamorelin. Never reorder without reading the whole list.
//
// 🔑 Returning null is a real answer. A name that does not clearly identify a
// product must NOT be guessed at — a wrong match decrements the wrong stock and
// costs the wrong money. That is not hypothetical: a wildcard match on
// "BPC-157 (10mg)" once resolved to the Wolverine 10/10 BLEND.

function nameToId(name) {
  const n = name.toLowerCase();

  // ── Blends first ─────────────────────────────────────────────────────────
  if (n.includes('klow'))                                                              return 'klow-blend';
  if (n.includes('glow'))                                                              return 'glow-blend';
  if (n.includes('phoenix') && (n.includes('12') || n.includes('new')))               return 'phoenix-blend-12-2';
  if (n.includes('phoenix'))                                                           return 'phoenix-blend';
  if (n.includes('tesamorelin') && n.includes('ipamorelin') && n.includes('12'))      return 'phoenix-blend-12-2';
  if (n.includes('tesamorelin') && n.includes('ipamorelin'))                          return 'phoenix-blend';
  // One Square item ("WOLVERINE BLEND") holds BOTH the 10/10 Stack and the 5/5
  // Blend as separate variations. Map by the size in the item+variation name, not
  // the item name (which always contains "blend") — otherwise the 10/10 variation's
  // price gets tagged onto the 5/5 site id. See the per-variation loop below.
  if (n.includes('wolverine')) {
    if (n.includes('10mg/10mg') || n.includes('10/10') || n.includes('(10mg'))        return 'wolverine-stack';
    if (n.includes('5mg/5mg')   || n.includes('5/5')   || n.includes('(5mg'))         return 'wolverine-blend-5mg';
    return null; // size not present in the name — don't guess
  }
  if (n.includes('cjc'))                                                               return 'cjc1295-ipamorelin';

  // ── Retatrutide — all sizes ───────────────────────────────────────────────
  if (n.includes('retatrutide') && n.includes('24'))                                  return 'retatrutide-24mg';
  if (n.includes('retatrutide') && n.includes('15'))                                  return 'retatrutide-15mg';
  if (n.includes('retatrutide') && n.includes('10'))                                  return 'retatrutide-10mg';
  if (n.includes('retatrutide'))                                                       return null;

  // ── Ipamorelin (standalone) ───────────────────────────────────────────────
  if (n.includes('ipamorelin'))                                                        return 'ipamorelin-10mg';

  // ── Individual peptides ───────────────────────────────────────────────────
  if (n.includes('tesamorelin'))                                                       return 'tesamorelin-10mg';
  if (n.includes('sermorelin'))                                                        return 'sermorelin-10mg';
  if (n.includes('mots-c') || n.includes('mots c'))                                   return 'mots-c-10mg';
  if ((n.includes('ghk-cu') || n.includes('ghk cu')) && n.includes('50'))             return 'ghk-cu-50mg';
  if (n.includes('ghk-cu') || n.includes('ghk cu'))                                   return 'ghk-cu-100mg';
  if (n.includes('ss-31') || n.includes('ss31') || n.includes('elamipretide'))        return 'ss-31-10mg';
  if (n.includes('semax'))                                                             return 'semax-10mg';
  if (n.includes('selank'))                                                            return 'selank-10mg';
  if (n.includes('dsip'))                                                              return 'dsip-5mg';
  if (n.includes('nad') && n.includes('1000'))                                        return 'nad-1000mg';
  if (n.includes('nad') && n.includes('100'))                                         return 'nad-100mg';
  if (n.includes('nad'))                                                               return 'nad-500mg';
  if (n.includes('melanotan'))                                                         return 'melanotan-ii-10mg';
  if (n.includes('bacteriostatic') || n.includes('bac water') || n.includes('reconstitution')) return 'reconstitution-liquid-30ml';

  return null;
}

module.exports = { nameToId };
