// Tests the product catalog's SKUs and packing labels, and the rule that keeps
// them safe: `name` is what Square stores and what stock resolution matches, so
// it must never move; `label` and `sku` are for humans and are free to change.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ok = (label, got, want) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${label}${good ? '' : `  got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  good ? pass++ : fail++;
};
const okTrue = (label, cond) => ok(label, !!cond, true);

const { CATALOG, catalogEntry, idForName, packingLine } = require('./netlify/functions/_catalog.js');
const { nameToId } = require('./netlify/functions/_catalog-map.js');
const { invoiceModel, invoiceHtml } = require('./netlify/functions/_invoice.js');

console.log('\n1. every product has a SKU that can be trusted');
{
  const ids = Object.keys(CATALOG);
  const skus = ids.map(i => CATALOG[i].sku);
  ok('every entry has one', skus.filter(Boolean).length, ids.length);
  // 🚨 Two products sharing a SKU is worse than none — it would confirm the
  // WRONG vial, which is exactly the mistake it exists to prevent.
  ok('🚨 no two products share one', new Set(skus).size, ids.length);
  okTrue('none can be mistaken for an order number', skus.every(s => !/^FP-/i.test(s)));
  okTrue('all are upper-case and printable', skus.every(s => /^[A-Z0-9][A-Z0-9-]*$/.test(s)));
  okTrue('every entry has a label', ids.every(i => !!CATALOG[i].label));
}

console.log('\n2. 🚨 the stored name is load-bearing and must not have moved');
{
  // resolve_variant() matches li.name EXACTLY against variant_aliases. A rename
  // here silently stops that product deducting stock — the line lands with
  // needs_review and no variant, and nobody finds out until a count disagrees.
  // These are the names as they shipped; they are pinned deliberately.
  const PINNED = {
    'wolverine-stack': 'Wolverine Stack',
    'wolverine-blend-5mg': 'Wolverine Blend 5mg/5mg',
    'cjc1295-ipamorelin': 'CJC-1295 / Ipamorelin (No DAC)',
    'phoenix-blend': 'Phoenix Blend (10mg/5mg)',
    'phoenix-blend-12-2': 'Phoenix Blend (12mg/2mg)',
    'glow-blend': 'Glow Blend',
    'klow-blend': 'KLOW Blend',
    'retatrutide-30mg': 'Retatrutide 30mg',
  };
  for (const [id, name] of Object.entries(PINNED)) {
    ok(`${id} keeps its Square name`, CATALOG[id].name, name);
  }
  // And every name still resolves the way it did before SKUs existed. The one
  // exception is pre-existing: Square's naming genuinely cannot tell the two
  // Wolverines apart from "Wolverine Stack", and nameToId refuses to guess.
  const unresolved = Object.entries(CATALOG).filter(([id, e]) => nameToId(e.name) !== id).map(([id]) => id);
  ok('only the known-ambiguous one fails name matching', unresolved, ['wolverine-stack']);
}

console.log('\n3. the labels say which vial to pack');
{
  ok('the Wolverine that had no strength at all', packingLine('Wolverine Stack'),
     { sku: 'WOLV-10-10', label: 'Wolverine Stack — BPC-157 10mg / TB-500 10mg' });
  ok('and the other one', packingLine('Wolverine Blend 5mg/5mg'),
     { sku: 'WOLV-5-5', label: 'Wolverine Blend — BPC-157 5mg / TB-500 5mg' });
  // 🔑 The pair Frank could not tell apart. Different SKU, different label,
  // different price — nothing about them reads the same any more.
  okTrue('the two Wolverines are now unmistakable',
    packingLine('Wolverine Stack').sku !== packingLine('Wolverine Blend 5mg/5mg').sku);
  okTrue('and so are the two Phoenixes',
    packingLine('Phoenix Blend (10mg/5mg)').sku !== packingLine('Phoenix Blend (12mg/2mg)').sku);
  okTrue('every blend label states its composition',
    ['glow-blend', 'klow-blend', 'wolverine-stack', 'wolverine-blend-5mg', 'phoenix-blend', 'phoenix-blend-12-2']
      .every(id => /\dmg/.test(CATALOG[id].label)));

  // ⚠️ Never invent one. A SKU that might be wrong defeats its only purpose.
  ok('an unknown line gets no SKU', packingLine('Some old thing typed at the till'),
     { sku: null, label: 'Some old thing typed at the till' });
  ok('and shipping does not get one', packingLine('Shipping — USPS').sku, null);
  ok('a known id beats the name', packingLine('anything at all', 'klow-blend').sku, 'KLOW-50-10-10-10');
  ok('an unknown id falls back to the name', packingLine('Glow Blend', 'not-a-product').sku, 'GLOW-50-10-10');

  // The reverse lookup matches only strings this catalog wrote.
  ok('exact catalog names resolve', idForName('KLOW Blend'), 'klow-blend');
  ok('case and spacing do not matter', idForName('  klow   blend '), 'klow-blend');
  ok('anything else does not', idForName('Klow Blend Extra Strength'), null);
  ok('catalogEntry refuses an unknown id', catalogEntry('nope'), null);
}

console.log('\n4. the invoice prints them');
{
  const m = invoiceModel({
    order: {
      line_items: [
        { name: 'Wolverine Stack', quantity: '1', base_price_money: { amount: 11500 } },
        { name: 'Phoenix Blend (12mg/2mg)', quantity: '2', base_price_money: { amount: 15500 } },
        { name: 'Shipping', quantity: '1', base_price_money: { amount: 2500 } },
      ],
      total_money: { amount: 45000 }, created_at: '2026-08-19T10:00:00Z',
      metadata: { forge_order_number: 'FP-000600' },
    },
    customer: { name: 'Mike' }, address: null,
  });
  ok('the ambiguous line is now specific', m.items[0].name, 'Wolverine Stack — BPC-157 10mg / TB-500 10mg');
  ok('and carries its SKU', m.items[0].sku, 'WOLV-10-10');
  ok('the right Phoenix is named', m.items[1].sku, 'PHX-12-2');
  ok('shipping stays plain', m.items[2], { name: 'Shipping', sku: null, qty: 1, unit_cents: 2500, amount_cents: 2500 });
  // Money must be untouched by any of this.
  ok('the line total is unchanged', m.items[1].amount_cents, 31000);

  const html = invoiceHtml(m);
  okTrue('the SKU is on the document', html.includes('WOLV-10-10') && html.includes('PHX-12-2'));
  okTrue('so is the full composition', html.includes('BPC-157 10mg / TB-500 10mg'));
  okTrue('the invoice number still renders', html.includes('FP-000600'));
}

console.log(`\n${fail ? `${fail} FAILED, ` : ''}${pass} passed.`);
process.exit(fail ? 1 : 0);
