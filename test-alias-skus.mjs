// Tests _alias-skus.js — putting a SKU on a packing line by asking the database
// which vial the line resolved to. No network: fetch is stubbed.
// Run with `node test-alias-skus.mjs`.
//
// WHY THIS EXISTS. SKUs already rendered on the Orders table, and on real data
// they resolved for 48 of 136 sold lines. The 88 that printed bare were the
// Square-era names — including the two products that exist at two strengths
// each, which is the entire reason a SKU is on the slip.
//
// THE TWO PROPERTIES THAT MATTER:
//  • 🚨 normName() is an EXACT mirror of the database's norm_name(). Looser and
//    a SKU gets attached to a line the database did NOT resolve, which is worse
//    than a blank because it looks like an answer. Stricter and rows go missing.
//  • ⚠️ Everything fails soft. A picking list that will not draw because a
//    lookup table was unreachable is a worse outcome than a missing SKU.
import { createRequire } from 'module';
import { readFileSync } from 'fs';
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ok = (label, got, want) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${label}${good ? '' : `  got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  good ? pass++ : fail++;
};
const okTrue = (label, cond) => ok(label, !!cond, true);

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

const { fetchAliasLines, packingLineFor, normName } = require('./netlify/functions/_alias-skus.js');
const { packingLine, CATALOG } = require('./netlify/functions/_catalog.js');
const { nameToId } = require('./netlify/functions/_catalog-map.js');

// ── normName mirrors norm_name() ─────────────────────────────────────────────
// The database's definition, which this must reproduce exactly:
//   btrim(regexp_replace(lower(regexp_replace(t,'[^a-zA-Z0-9]+',' ','g')),'\s+',' ','g'))
console.log('\n— 🚨 normName is an exact mirror of the database norm_name() —');
ok('punctuation becomes spaces',
  normName('BPC-157 / TB-500 "WOLVERINE BLEND"'), 'bpc 157 tb 500 wolverine blend');
ok('runs of punctuation collapse to one space',
  normName('CJC-1295 / Ipamorelin (No DAC) 5MG/5MG'), 'cjc 1295 ipamorelin no dac 5mg 5mg');
ok('leading and trailing punctuation is trimmed',
  normName('  "Phoenix Blend".  '), 'phoenix blend');
// btrim matters: without it 'Phoenix Blend' and 'Phoenix Blend.' produce
// different keys and fail to collapse — the database comment says so too.
ok('a trailing full stop collapses',   normName('Phoenix Blend.'), normName('Phoenix Blend'));
ok('the smart-quote variant collapses',
  normName('BPC-157 / TB-500”WOLVERINE BLEND” (5mg/5mg)'), 'bpc 157 tb 500 wolverine blend 5mg 5mg');
ok('a bracket typo collapses too',
  normName('SEMAX / SELANK (5MG/5MG]'), 'semax selank 5mg 5mg');
ok('case is flattened', normName('RETATRUTIDE 24MG'), 'retatrutide 24mg');
ok('null is empty, not a crash', normName(null), '');
ok('undefined too',              normName(undefined), '');
ok('a name of pure punctuation is empty', normName('— / —'), '');

// ── The map ──────────────────────────────────────────────────────────────────
let routes = {};
global.fetch = async (url) => {
  for (const [frag, r] of Object.entries(routes)) {
    if (String(url).includes(frag)) {
      if (r.throw) throw new Error('network down');
      return { ok: r.status < 400, status: r.status, json: async () => r.body };
    }
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const ALIASES = [
  // The Square-era names that used to print bare.
  { alias_norm: 'tesamorelin ipamorelin phoenix blend', variants: { site_catalog_id: null, sku: 'PHX-10-5' } },
  // 🚨 PINNED: bare "Phoenix Blend" is the ORIGINAL 10/5 — Frank settled that on
  // 2026-08-20 (5 vials, 19 Jun – 9 Jul, all $155; both formulas cost $155 so
  // price could not separate them). Retiring the 10/5 must not quietly hand
  // those five lines the New Formula's SKU, so it points at the same retired
  // variant as the other two aliases do.
  { alias_norm: 'phoenix blend',                        variants: { site_catalog_id: null, sku: 'PHX-10-5' } },
  { alias_norm: 'phoenix blend new formula',            variants: { site_catalog_id: 'phoenix-blend-12-2', sku: null } },
  { alias_norm: 'bpc 157 tb 500 wolverine blend',       variants: { site_catalog_id: 'wolverine-stack', sku: null } },
  { alias_norm: 'ghk cu bpc 157 tb 500 glow blend',     variants: { site_catalog_id: 'glow-blend', sku: null } },
  // 🚨 THE MID-DEPLOY STATE, and the reason migration 046 exists. Between the
  // code deploy that drops a product from CATALOG and the migration that clears
  // its site_catalog_id, a row looks like this: a site id that CATALOG no longer
  // knows, plus the SKU armed on the variant. It must fall through to the SKU
  // rather than losing it — 24 historical Phoenix lines depend on that.
  { alias_norm: 'phoenix blend 10mg 5mg',               variants: { site_catalog_id: 'phoenix-blend', sku: 'PHX-10-5' } },
  // Retired: absent from CATALOG on purpose, carrying its SKU on the variant
  // instead (migration 030).
  { alias_norm: 'retatrutide 12mg',                     variants: { site_catalog_id: null, sku: 'RETA-12' } },
  // Not on the site and never given a SKU — nothing to show.
  { alias_norm: 'never skued',                          variants: { site_catalog_id: null, sku: null } },
  // A row with no variant at all.
  { alias_norm: 'orphan',                               variants: null },
];

routes = { 'variant_aliases': { status: 200, body: ALIASES } };
let map = await fetchAliasLines();

console.log('\n— the map only carries what can actually yield a SKU —');
// The old Phoenix is retired now, so this Square-era alias takes the same route
// Retatrutide 12mg does: no catalogue entry, SKU off the variant.
ok('a retired Square-era blend keeps its SKU',
   map.get('tesamorelin ipamorelin phoenix blend'), { sku: 'PHX-10-5', label: null });
ok('🚨 and so does one still carrying a stale site id mid-deploy',
   map.get('phoenix blend 10mg 5mg'), { sku: 'PHX-10-5', label: null });
ok('so does a Wolverine',        map.get('bpc 157 tb 500 wolverine blend').sku, CATALOG['wolverine-stack'].sku);
ok('a retired product uses variants.sku', map.get('retatrutide 12mg'), { sku: 'RETA-12', label: null });
ok('no site id and no sku is dropped',    map.has('never skued'), false);
ok('a row with no variant is dropped',    map.has('orphan'), false);
// Every fixture row that can yield a SKU, and none of the two that cannot.
ok('seven usable entries, and only those',  map.size, 7);

console.log('\n— 🚨 the whole point: the names the parser refuses now carry a SKU —');
// nameToId() is RIGHT to refuse these — "WOLVERINE BLEND" with no strength is
// genuinely ambiguous and a SKU that might be wrong is worse than none. The
// database is not guessing: resolve_variant() matched this same string to
// decide which vial to deduct from stock.
const line = (name) => packingLineFor(map, name);
ok('the parser still refuses to guess', nameToId('BPC-157 / TB-500 "WOLVERINE BLEND"'), null);
ok('but the packing line gets a SKU',   line('BPC-157 / TB-500 "WOLVERINE BLEND"').sku,
  CATALOG['wolverine-stack'].sku);
ok('and the specific label',            line('BPC-157 / TB-500 "WOLVERINE BLEND"').label,
  CATALOG['wolverine-stack'].label);
// 🚨 Phoenix, the 16-line offender — and now RETIRED, so this is the case that
// matters most: the catalogue has nothing to say and the SKU comes from the
// database. If this ever returns null, 24 historical packing lines went blank.
ok('Phoenix, the 16-line offender, retired but still SKU\'d',
  line('TESAMORELIN / IPAMORELIN "PHOENIX BLEND"').sku, 'PHX-10-5');
ok('   and it keeps the name it was sold under',
  line('TESAMORELIN / IPAMORELIN "PHOENIX BLEND"').label, 'TESAMORELIN / IPAMORELIN "PHOENIX BLEND"');
ok('Glow',                              line('GHK-CU / BPC-157 / TB-500 "GLOW BLEND"').sku,
  CATALOG['glow-blend'].sku);

console.log('\n— matching is by normalised name, like the database —');
ok('different punctuation, same line',  line('BPC-157/TB-500 (WOLVERINE BLEND)').sku,
  CATALOG['wolverine-stack'].sku);
ok('different case, same line',         line('bpc-157 / tb-500 "wolverine blend"').sku,
  CATALOG['wolverine-stack'].sku);

console.log('\n— a name the database does not know is still left blank —');
// ⚠️ Unchanged behaviour, and it must stay unchanged: a SKU is only worth
// anything if it is the one you can trust against the vial in your hand.
ok('an unknown line has no SKU', line('Something Nobody Sells').sku, null);
ok('and keeps its stored name',  line('Something Nobody Sells').label, 'Something Nobody Sells');

console.log('\n— 🚨 a RETIRED product gets a SKU without becoming buyable —');
// 33 of the 34 SKU-less lines were Retatrutide 12mg. Adding it to CATALOG would
// have given it a SKU and put it back on sale — being in CATALOG is what makes
// something purchasable. Migration 030 puts the SKU on the variant instead.
ok('it carries its SKU now',        line('Retatrutide 12mg').sku, 'RETA-12');
ok('and keeps the name it sold as', line('Retatrutide 12mg').label, 'Retatrutide 12mg');
okTrue('while staying out of CATALOG', !CATALOG['retatrutide-12mg']);
ok('a variant with neither has no SKU', line('never skued').sku, null);

console.log('\n— names the parser already handled are unchanged —');
ok('a catalog name still resolves', line('Retatrutide 10mg').sku, CATALOG['retatrutide-10mg'].sku);
ok('even with no map at all', packingLineFor(null, 'Retatrutide 10mg').sku, CATALOG['retatrutide-10mg'].sku);

console.log('\n— 🚨 PINNED: bare "Phoenix Blend" is the ORIGINAL 10mg/5mg —');
// 5 vials sold 19 Jun – 9 Jul 2026 as just "Phoenix Blend", all at $155. Both
// Phoenix products cost $155, so the price could not separate them.
// ✅ Frank confirmed 2026-08-20: the original. Pinned here so a future alias
// change breaks a test instead of silently re-labelling five real sales — and
// so nobody has to re-derive the answer from dates again. Migration 030 carries
// the same note.
ok('bare Phoenix Blend', line('Phoenix Blend').sku, 'PHX-10-5');
ok('the Square-era name agrees', line('TESAMORELIN / IPAMORELIN "PHOENIX BLEND"').sku, 'PHX-10-5');
ok('and the new formula stays distinct', line('Phoenix Blend (New Formula)').sku, 'PHX-12-2');

console.log('\n— ⚠️ everything fails soft —');
routes = { 'variant_aliases': { status: 500, body: {} } };
ok('a 500 gives null, not an empty map', await fetchAliasLines(), null);
routes = { 'variant_aliases': { throw: true } };
ok('a thrown request gives null',        await fetchAliasLines(), null);
// 🔑 null is distinguishable from an empty map on purpose: "we could not ask"
// is not "nothing is mapped".
ok('null means the caller just parses',  packingLineFor(null, 'BPC-157 / TB-500 "WOLVERINE BLEND"').sku, null);
ok('and the line still draws',
  packingLineFor(null, 'BPC-157 / TB-500 "WOLVERINE BLEND"').label, 'BPC-157 / TB-500 "WOLVERINE BLEND"');
ok('an empty map is a real answer',      packingLineFor(new Map(), 'anything').sku, null);

console.log('\n— 🚨 the invariant that makes trusting the database safe —');
// Audited across all 57 live aliases on 2026-08-20: 48 agreed with nameToId(),
// 4 were ones it refuses, 5 had no site id — and ZERO disagreed. If a future
// alias ever DID disagree, the SKU on the slip would contradict the vial the
// ledger deducted, and one of the two would be wrong. This pins the shape of
// that check so the reasoning is executable, not just written down.
const AUDIT = [
  ['Retatrutide 10mg', 'retatrutide-10mg'],
  ['Retatrutide 15mg', 'retatrutide-15mg'],
  ['Wolverine Stack', 'wolverine-stack'],
  ['Wolverine Blend 5mg/5mg', 'wolverine-blend-5mg'],
  ['Phoenix Blend (12mg/2mg)', 'phoenix-blend-12-2'],
  ['MOTS-C 10MG', 'mots-c-10mg'],
];
const conflicts = AUDIT.filter(([alias, dbId]) => {
  const parsed = nameToId(alias);
  return parsed !== null && parsed !== dbId;
});
ok('no alias contradicts the name parser', conflicts, []);

console.log('\n— 🚨 a DRAFT order must be reachable —');
// FP-001004 (Leo the Den, $259, 21 May) was the only DRAFT in the system and was
// invisible for three months: v_dashboard_only_orders skips anything with a
// square_id, so Square was the only route in, and get-orders asked Square for
// OPEN and COMPLETED only. The Finance tab flagged it as owing money while the
// Orders tab could not show it, so it could never be marked paid.
const src = readFileSync('./netlify/functions/get-orders.js', 'utf8');
const states = src.match(/state_filter:\s*\{\s*states:\s*\[([^\]]+)\]/);
okTrue('get-orders asks Square for DRAFT too', states && /DRAFT/.test(states[1]));
okTrue('and still for OPEN and COMPLETED',
  states && /OPEN/.test(states[1]) && /COMPLETED/.test(states[1]));
// The window has to reach it as well — 91 days old is past the old 90-day cap.
const page = readFileSync('./admin.html', 'utf8');
okTrue('the orders window reaches past 90 days', /<option value="(180|365)"/.test(page));

console.log('\n— 🚨 and the sync has to reach it too —');
// Marking FP-001004 paid writes the tender to SQUARE; the dashboard only learns
// it on a sync. Two more hides sat behind that: the sync window was hardcoded to
// 60 days (the order was 91 days old), and the only Sync button lived in a band
// shown solely when the dashboard was a day or more behind — so on a day you had
// already sold something there was no way to sync at all.
okTrue('the sync window follows the list, not a hardcoded 60',
  /days:\s*Math\.max\(60,\s*Number\(document\.getElementById\('days-select'\)/.test(page));
okTrue('there is a Sync button outside the staleness band',
  /id="sync-btn-always"/.test(page));
okTrue('and it drives the same runSync', /runSync\('sync-btn-always'\)/.test(page));

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
