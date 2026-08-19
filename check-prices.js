#!/usr/bin/env node
/*
 * check-prices.js — price-drift gate (local + CI).
 *
 * Prices currently live in THREE places that must agree:
 *   1. netlify/functions/_catalog.js        — CATALOG  (server-side source of truth:
 *                                              this is what the customer is actually charged)
 *   2. index.html                            — product cards, variant selectors, price list
 *   3. products.json                         — landing-page data (subset: 8 hero families)
 *
 * This script treats CATALOG as the reference and verifies every price shown anywhere
 * else matches it. On ANY mismatch or unknown id it prints a clear report and exits
 * non-zero, so a stale price can never ship silently ("customer sees $155, invoice
 * says $160"). Zero dependencies. Run:  node check-prices.js
 *
 * NOTE: until the sources are unified (a later refactor), this gate is how they stay
 * honest. Run it before every deploy that touches pricing.
 */

'use strict';
const fs   = require('fs');
const path = require('path');
const ROOT = __dirname;

function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

// ── 1. Reference: CATALOG in create-invoice.js ────────────────────────────────
//
// ⚠️ Parsed by regex rather than required, so this stays a zero-dependency
// script that cannot execute the function it is checking. That makes it
// sensitive to the shape of the literal: when `sku` was added on 2026-08-19 the
// old two-field pattern silently matched NOTHING and the gate reported "could
// not parse" — which at least failed loudly. Field order is not assumed here;
// each entry's body is captured and its fields read individually.
function loadEntries() {
  const src = read('netlify/functions/_catalog.js');
  const start = src.indexOf('const CATALOG = {');
  if (start < 0) return {};
  const body = src.slice(start, src.indexOf('\n};', start));
  const entries = {};
  const re = /'([a-z0-9-]+)':\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const fields = m[2];
    const price = /price:\s*(\d+(?:\.\d+)?)/.exec(fields);
    const sku   = /sku:\s*'([^']+)'/.exec(fields);
    const name  = /name:\s*'([^']*)'/.exec(fields);
    if (!price) continue;
    entries[m[1]] = { price: Number(price[1]), sku: sku ? sku[1] : null, name: name ? name[1] : null };
  }
  return entries;
}

function loadCatalog() {
  const map = {};
  for (const [id, e] of Object.entries(loadEntries())) map[id] = e.price;
  return map;
}

// ── SKUs: present, unique, and not confusable with an order number ───────────
// 🔑 A SKU exists to be read off a vial and checked against the packing list, so
// two products sharing one is worse than none at all — it would confirm the
// wrong vial. FP- is refused because that is the order-number series.
function checkSkus() {
  const entries = loadEntries();
  const problems = [];
  const seen = new Map();
  for (const [id, e] of Object.entries(entries)) {
    if (!e.sku) { problems.push(`${id} has no sku`); continue; }
    if (!/^[A-Z0-9][A-Z0-9-]*$/.test(e.sku)) problems.push(`${id}: sku "${e.sku}" should be upper-case letters, digits and hyphens`);
    if (/^FP-/i.test(e.sku)) problems.push(`${id}: sku "${e.sku}" starts with FP-, which is the order-number series`);
    if (seen.has(e.sku)) problems.push(`sku "${e.sku}" is on both ${seen.get(e.sku)} and ${id}`);
    seen.set(e.sku, id);
  }
  return { count: Object.keys(entries).length, problems };
}

// ── 2. Displayed prices in index.html (three patterns) ────────────────────────
function loadIndexPrices() {
  const src = read('index.html');
  const found = [];
  const push = (id, price, where) => found.push({ id, price: Number(price), where });

  // a) Add-to-Order buttons: data-item-id … data-item-price
  let re = /data-item-id="([^"]+)"[\s\S]{0,260}?data-item-price="([^"]+)"/g, m;
  while ((m = re.exec(src)) !== null) push(m[1], m[2], 'index.html card button');

  // b) Variant selector chips: data-id … data-price
  re = /data-id="([^"]+)"[\s\S]{0,160}?data-price="([^"]+)"/g;
  while ((m = re.exec(src)) !== null) push(m[1], m[2], 'index.html variant chip');

  // c) Reference price list: data-price-id … <span class="price-amt">$N
  re = /data-price-id="([^"]+)"[\s\S]{0,240}?class="price-amt">\$(\d+(?:\.\d+)?)/g;
  while ((m = re.exec(src)) !== null) push(m[1], m[2], 'index.html price list');

  return found;
}

// ── 3. Displayed prices in products.json ──────────────────────────────────────
function loadProductsJson() {
  const data = JSON.parse(read('products.json'));
  const found = [];
  for (const p of data.products || []) {
    for (const s of p.sizes || []) {
      found.push({ id: s.id, price: Number(s.price), where: `products.json (${p.slug})` });
    }
  }
  return found;
}

// ── Compare ───────────────────────────────────────────────────────────────────
function main() {
  const catalog = loadCatalog();
  const catalogIds = Object.keys(catalog);
  if (catalogIds.length === 0) {
    console.error('✗ Could not parse CATALOG from _catalog.js — check the regex/format.');
    process.exit(2);
  }

  const displayed = [...loadIndexPrices(), ...loadProductsJson()];

  const mismatches = [];
  const unknowns   = [];
  for (const d of displayed) {
    if (!(d.id in catalog)) { unknowns.push(d); continue; }
    if (catalog[d.id] !== d.price) mismatches.push({ ...d, expected: catalog[d.id] });
  }

  // Coverage: catalog ids never shown anywhere (informational, not a failure).
  const shownIds = new Set(displayed.map(d => d.id));
  const unshown  = catalogIds.filter(id => !shownIds.has(id));

  console.log(`Reference: _catalog.js CATALOG (${catalogIds.length} ids)`);
  console.log(`Checked:   ${displayed.length} displayed price(s) across index.html + products.json\n`);

  const skus = checkSkus();

  if (mismatches.length === 0 && unknowns.length === 0 && skus.problems.length === 0) {
    console.log('✓ All displayed prices match the CATALOG. No drift.');
    console.log(`✓ ${skus.count} SKUs, all present and unique.`);
    if (unshown.length) console.log(`  (info) CATALOG ids not shown on any page: ${unshown.join(', ')}`);
    process.exit(0);
  }

  if (skus.problems.length) {
    console.error('────────────────────────────────────────────');
    console.error(` SKU PROBLEM — ${skus.problems.length}:`);
    console.error('────────────────────────────────────────────');
    for (const p of skus.problems) console.error(`  ✗ ${p}`);
    console.error('');
  }

  if (mismatches.length) {
    console.error('════════════════════════════════════════════');
    console.error(` PRICE MISMATCH — ${mismatches.length} price(s) disagree with CATALOG:`);
    console.error('════════════════════════════════════════════');
    for (const m of mismatches) {
      console.error(`  ✗ ${m.id}: shows $${m.price} in ${m.where}, but CATALOG says $${m.expected}`);
    }
    console.error('');
  }

  if (unknowns.length) {
    console.error('────────────────────────────────────────────');
    console.error(` UNKNOWN ID — ${unknowns.length} displayed id(s) not in CATALOG:`);
    console.error('────────────────────────────────────────────');
    for (const u of unknowns) {
      console.error(`  ✗ ${u.id}: appears in ${u.where} but has no CATALOG entry`);
    }
    console.error('');
  }

  console.error('Fix so all three sources agree, then re-run. (_catalog.js is the source of truth.)');
  process.exit(1);
}

main();
