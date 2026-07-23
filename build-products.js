#!/usr/bin/env node
/*
 * build-products.js — local authoring tool (NOT a Netlify build step).
 *
 * Reads products.json + product-template.html, injects structured fields, and
 * writes static pages to /products/<slug>.html. Netlify still deploys with
 * publish="." and command="" — this script is run by hand before committing.
 *
 * Compliance gate: after rendering each page, the output is scanned for banned
 * phrases. If any are found the script FAILS LOUDLY (non-zero exit) and names
 * the page + phrase, so a non-compliant page can never be silently written.
 *
 * Usage:  node build-products.js
 */

'use strict';
const fs   = require('fs');
const path = require('path');

const ROOT      = __dirname;
const DATA      = path.join(ROOT, 'products.json');
const TEMPLATE  = path.join(ROOT, 'product-template.html');
const OUT_DIR   = path.join(ROOT, 'products');

// ── Compliance gate ───────────────────────────────────────────────────────────
// Banned phrases (research-use-only rule). Regex so we can match "take 10" etc.
// Applied case-insensitively to the FINAL rendered HTML of every page.
const BANNED = [
  /\bdose\b/i, /\bdosage\b/i, /\bdosing\b/i,
  /\binject\b/i, /\binjection\b/i,
  /\bhow much\b/i,
  /\btake\s+\d/i,
  /\badminister\b/i, /\badministration\b/i,
  /\bresults\b/i,
  /\bhelped\b/i, /\bhelps you\b/i,
  /\bmy recovery\b/i,
  /\bweight loss\b/i,
  /\byour body\b/i,
];

function complianceScan(slug, html) {
  const hits = [];
  for (const re of BANNED) {
    const m = html.match(re);
    if (m) {
      // Capture a little context to make the failure actionable.
      const idx = html.toLowerCase().indexOf(m[0].toLowerCase());
      const ctx = html.slice(Math.max(0, idx - 40), idx + m[0].length + 40).replace(/\s+/g, ' ').trim();
      hits.push({ phrase: m[0], context: ctx });
    }
  }
  return hits;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function money(n) { return '$' + (Number.isInteger(n) ? n : n.toFixed(2)); }

function buildSizeSelector(sizes) {
  return sizes.map((s, i) =>
    `<button class="lp-size${i === 0 ? ' active' : ''}" data-price="${s.price}">${esc(s.label)}<span>${money(s.price)}</span></button>`
  ).join('');
}

function buildSummary(paras) {
  return paras.map(p => `<p>${esc(p)}</p>`).join('\n      ');
}

function buildSpecs(specs) {
  return specs.map(r =>
    `<tr><td class="spec-k">${esc(r.k)}</td><td class="spec-v">${esc(r.v)}</td></tr>`
  ).join('');
}

function buildFaqItems(faq) {
  return faq.map(f =>
    `<details class="faq-item"><summary>${esc(f.q)}</summary><div class="faq-a">${esc(f.a)}</div></details>`
  ).join('\n    ');
}

// ── Schema builders ─────────────────────────────────────────────────────────────
function buildOffers(p, canonical) {
  const currency = 'USD';
  if (p.sizes.length === 1) {
    return {
      '@type': 'Offer',
      url: canonical,
      priceCurrency: currency,
      price: p.sizes[0].price.toFixed(2),
      availability: 'https://schema.org/InStock',
    };
  }
  const prices = p.sizes.map(s => s.price);
  return {
    '@type': 'AggregateOffer',
    url: canonical,
    priceCurrency: currency,
    lowPrice: Math.min(...prices).toFixed(2),
    highPrice: Math.max(...prices).toFixed(2),
    offerCount: String(p.sizes.length),
    availability: 'https://schema.org/InStock',
    offers: p.sizes.map(s => ({
      '@type': 'Offer',
      name: `${p.name} ${s.label}`.trim(),
      priceCurrency: currency,
      price: s.price.toFixed(2),
      availability: 'https://schema.org/InStock',
    })),
  };
}

function buildProductSchema(p, canonical, imageAbs) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    '@id': canonical + '#product',
    name: p.name,
    alternateName: p.alternateName,
    description: p.schemaDescription,
    image: imageAbs,
    brand: { '@type': 'Brand', name: 'The Forge Peptides' },
    category: p.schemaCategory,
    url: canonical,
    offers: buildOffers(p, canonical),
  };
}

function buildBreadcrumbSchema(p, base, canonical) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: base + '/' },
      { '@type': 'ListItem', position: 2, name: 'Catalog', item: base + '/#catalog' },
      { '@type': 'ListItem', position: 3, name: p.name, item: canonical },
    ],
  };
}

function buildFaqSchema(p) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: p.faq.map(f => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };
}

// ── Main ────────────────────────────────────────────────────────────────────────
function main() {
  const cfg = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  let template = fs.readFileSync(TEMPLATE, 'utf8');
  // Strip the template's authoring comment so it never ships into public pages.
  template = template.replace(/<!DOCTYPE html>\s*<!--[\s\S]*?-->\s*/, '<!DOCTYPE html>\n');
  const base = cfg.site.base.replace(/\/$/, '');

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const written = [];
  const allHits = [];

  for (const p of cfg.products) {
    const canonical = `${base}/products/${p.slug}.html`;
    const imageAbs  = `${base}/${p.image}`;
    const priceFrom = money(p.sizes[0].price);
    const priceLabel = p.sizes.length > 1 ? 'From' : 'Price';

    const productSchema    = JSON.stringify(buildProductSchema(p, canonical, imageAbs), null, 2);
    const breadcrumbSchema = JSON.stringify(buildBreadcrumbSchema(p, base, canonical), null, 2);
    const faqSchema        = JSON.stringify(buildFaqSchema(p), null, 2);

    const repl = {
      TITLE: esc(p.title),
      META_DESC: esc(p.metaDescription),
      CANONICAL: canonical,
      OG_IMAGE: imageAbs,
      NAME: esc(p.name),
      ALIAS: esc(p.alias),
      CATEGORY_LABEL: esc(p.categoryLabel),
      IMAGE: p.image,
      PRICE_FROM: priceFrom,
      PRICE_LABEL: priceLabel,
      SIZE_SELECTOR: buildSizeSelector(p.sizes),
      SUMMARY_HTML: buildSummary(p.summary),
      SPECS_ROWS: buildSpecs(p.specs),
      FAQ_ITEMS: buildFaqItems(p.faq),
      PRODUCT_SCHEMA: productSchema,
      BREADCRUMB_SCHEMA: breadcrumbSchema,
      FAQ_SCHEMA: faqSchema,
    };

    let html = template.replace(/\{\{(\w+)\}\}/g, (m, key) =>
      Object.prototype.hasOwnProperty.call(repl, key) ? repl[key] : m
    );

    // Fail loudly if any placeholder survived.
    const leftover = html.match(/\{\{\w+\}\}/g);
    if (leftover) {
      console.error(`\n✗ ${p.slug}: unresolved placeholder(s): ${[...new Set(leftover)].join(', ')}`);
      process.exitCode = 1;
      continue;
    }

    // Compliance gate — scan the FINAL rendered page.
    const hits = complianceScan(p.slug, html);
    if (hits.length) {
      allHits.push({ slug: p.slug, hits });
      continue; // do not write a non-compliant page
    }

    fs.writeFileSync(path.join(OUT_DIR, `${p.slug}.html`), html);
    written.push(`${p.slug}.html`);
    console.log(`✓ ${p.slug}.html  (${p.sizes.length} size${p.sizes.length > 1 ? 's' : ''})`);
  }

  if (allHits.length) {
    console.error('\n════════════════════════════════════════════');
    console.error(' COMPLIANCE CHECK FAILED — pages NOT written:');
    console.error('════════════════════════════════════════════');
    for (const { slug, hits } of allHits) {
      for (const h of hits) {
        console.error(`  ✗ ${slug}: banned phrase "${h.phrase}"`);
        console.error(`      …${h.context}…`);
      }
    }
    console.error('\nFix the copy in products.json and re-run. No page above was written.\n');
    process.exit(1);
  }

  console.log(`\n${written.length} page(s) written to /products/. Compliance gate passed.`);

  // Cross-source price parity: run check-prices.js so regenerating pages also
  // verifies index.html / products.json / create-invoice.js still agree. Pages
  // are already written; a failure here exits non-zero so drift can't be missed.
  console.log('\n— Running price parity check —');
  try {
    require('child_process').execFileSync('node', [path.join(ROOT, 'check-prices.js')], { stdio: 'inherit' });
  } catch (e) {
    console.error('\n⚠  Price parity check FAILED (see above). Fix the drift before deploying.');
    process.exitCode = 1;
  }
}

main();
