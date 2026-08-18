// Tests _catalog-map.js — the single NAME → site-catalog-id mapping used by the
// storefront, the checkout and the stock gate. No network.
//
// WHY THIS FILE EXISTS: this module had no coverage at all, and it is the one
// place where a wrong answer costs real money — a mismatched id decrements the
// wrong stock and charges the wrong price. The BPC-157 cases below are the
// regression: a wildcard 'bpc' match once resolved standalone "BPC-157 (10mg)"
// onto the Wolverine 10/10 BLEND ($10.52 cost onto a $56.25 product).
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { nameToId } = require('./netlify/functions/_catalog-map');

let pass = 0, fail = 0;
const ok = (name, want) => {
  const got = nameToId(name);
  const good = got === want;
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${JSON.stringify(name)} → ${got}${good ? '' : `  (want ${want})`}`);
  good ? pass++ : fail++;
};

console.log('\n— BPC-157 standalone (added 2026-08-18) —');
// _stock.js joins product_name + variant_name, so the doubled size is real input.
ok('BPC-157 10mg 10mg', 'bpc-157-10mg');
ok('BPC-157 (10mg)',    'bpc-157-10mg');   // Direct Peptides #3946 wording
ok('BPC-157 10mg',      'bpc-157-10mg');

console.log('\n— 🚨 BPC-157 blends must NEVER reach the standalone id —');
ok('Wolverine Blend (BPC-157/TB-500) 5mg/5mg',                      'wolverine-blend-5mg');
ok('Wolverine Stack BPC-157/TB-500 (10mg/10mg)',                    'wolverine-stack');
ok('WOLVERINE BLEND (10mg/10mg)',                                   'wolverine-stack');
ok('Glow Blend — GHK-Cu 50mg / BPC-157 10mg / TB-500 10mg',         'glow-blend');
ok('KLOW Blend — GHK-Cu 50mg / BPC-157 10mg / TB-500 10mg / KPV 10mg','klow-blend');

console.log('\n— refusing to guess is the correct answer —');
ok('BPC-157 / TB-500 Blend', null);   // a blend nobody named "wolverine"
ok('BPC-157 5mg',            null);   // size we do not sell
ok('BPC-157',                null);   // no size at all
ok('Retatrutide',            null);
ok('WOLVERINE BLEND',        null);   // size absent — the pre-existing rule

console.log('\n— Retatrutide 30mg (added 2026-08-18) —');
ok('Retatrutide 30mg 30mg', 'retatrutide-30mg');
ok('Retatrutide 30mg',      'retatrutide-30mg');

console.log('\n— retired sizes map to null, not to an id no page sells —');
// 12mg (retired 2026-07-31) and 24mg (retired 2026-08-18, sourcing consolidated
// on Direct Peptides) still exist as dashboard variants with sales history. They
// must resolve to null so stock reporting excludes them, rather than to a site id
// the storefront no longer carries.
ok('Retatrutide 24mg', null);
ok('Retatrutide 12mg', null);

console.log('\n— regressions: nothing else moved —');
for (const [n, want] of [
  ['Retatrutide 10mg','retatrutide-10mg'], ['Retatrutide 15mg','retatrutide-15mg'],
  ['Tesamorelin 10mg','tesamorelin-10mg'],
  ['Ipamorelin 10mg','ipamorelin-10mg'],   ['Sermorelin 10mg','sermorelin-10mg'],
  ['TESAMORELIN/IPAMORELIN PHOENIX BLEND','phoenix-blend'],
  ['Phoenix Blend (New Formula)','phoenix-blend-12-2'],
  ['CJC-1295 / Ipamorelin (No DAC)','cjc1295-ipamorelin'],
  ['GHK-Cu 50mg','ghk-cu-50mg'],  ['GHK-Cu 100mg','ghk-cu-100mg'],
  ['NAD+ 100mg','nad-100mg'],     ['NAD+ 500mg','nad-500mg'], ['NAD+ 1000mg','nad-1000mg'],
  ['SS-31 10mg','ss-31-10mg'],    ['MOTS-C 10mg','mots-c-10mg'],
  ['Semax 10mg','semax-10mg'],    ['Selank 10mg','selank-10mg'], ['DSIP 5mg','dsip-5mg'],
  ['Melanotan II 10mg','melanotan-ii-10mg'],
  ['Bacteriostatic Water 30ml','reconstitution-liquid-30ml'],
]) ok(n, want);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
