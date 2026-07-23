#!/usr/bin/env node
/*
 * check-prices.js — price-drift gate (local + CI).
 *
 * Prices currently live in THREE places that must agree:
 *   1. netlify/functions/create-invoice.js  — CATALOG  (server-side source of truth:
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
function loadCatalog() {
  const src = read('netlify/functions/create-invoice.js');
  const map = {};
  const re = /'([a-z0-9-]+)':\s*\{\s*name:\s*'[^']*',\s*price:\s*(\d+(?:\.\d+)?)\s*\}/g;
  let m;
  while ((m = re.exec(src)) !== null) map[m[1]] = Number(m[2]);
  return map;
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
    console.error('✗ Could not parse CATALOG from create-invoice.js — check the regex/format.');
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

  console.log(`Reference: create-invoice.js CATALOG (${catalogIds.length} ids)`);
  console.log(`Checked:   ${displayed.length} displayed price(s) across index.html + products.json\n`);

  if (mismatches.length === 0 && unknowns.length === 0) {
    console.log('✓ All displayed prices match the CATALOG. No drift.');
    if (unshown.length) console.log(`  (info) CATALOG ids not shown on any page: ${unshown.join(', ')}`);
    process.exit(0);
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

  console.error('Fix so all three sources agree, then re-run. (create-invoice.js is the source of truth.)');
  process.exit(1);
}

main();
