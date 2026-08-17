// ─────────────────────────────────────────────────────────────────────────────
// Netlify Function: health-check.js
// Added 2026-08-17 — Phase 1 item 3 of replacing Square.
//
// WHY THIS EXISTS
// On 2026-08-13 the storefront was UP for three hours while checkout was dead.
// Every uptime ping showed green because GET / returned 200 the whole time —
// only a POST with a valid order body 500'd. 17 orders were lost. A ping check
// would not have caught it, and neither would anything that only asks "does the
// site respond". This endpoint exercises the real Square path a customer's
// order takes, without creating anything.
//
// WHAT IT PROBES
//   env      — SQUARE_ACCESS_TOKEN + SQUARE_LOCATION_ID are actually present
//   catalog  — a real authenticated read against Square's catalog
//   checkout — POST orders/calculate with a full, realistic order body
//
// 🔑 orders/calculate VALIDATES A FULL ORDER BODY AND CREATES NOTHING.
// Re-proven 2026-08-17: the probe body below was sent against the live account
// and orders/search for the same window returned no such order. The response
// carries no order id. It is safe to run this every minute forever.
//
// 🚨 THE FINDING THAT SHAPES THIS FILE — HTTP 200 IS NOT A HEALTH SIGNAL.
// While proving the probe, a deliberately broken body (a line item whose
// applied_taxes pointed at a tax_uid that did not exist) came back **HTTP 200
// with the tax silently dropped** — total_tax_money: 0, no error, no warning.
// That is precisely the false-green this endpoint was built to end. So the
// checkout probe does NOT trust the status code: it asserts on the computed
// money. If tax, discount or line math silently stops working, the totals move
// and the probe goes red even though Square said 200.
//
// Contract for Checkmate: 200 = every probe passed. 500 = at least one failed.
// The JSON body carries a per-probe breakdown either way, so the `site-health`
// skill can name the failing call instead of just knowing something is wrong.
// ─────────────────────────────────────────────────────────────────────────────

const SQUARE_API  = 'https://connect.squareup.com/v2';
const TOKEN       = process.env.SQUARE_ACCESS_TOKEN;
const LOCATION_ID = process.env.SQUARE_LOCATION_ID;

// Optional. If set, callers must present ?token= or an x-health-token header.
// Leave unset and the endpoint is public — it exposes no customer data.
const HEALTH_TOKEN = process.env.HEALTH_CHECK_TOKEN;

// Optional Supabase logging. Absent = the probe still runs and still reports;
// it just doesn't persist. Logging must NEVER be able to fail the health check.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

// Per-probe network timeout. Netlify's default function limit is 10s and we run
// probes sequentially, so keep the worst case comfortably under it. A hung
// Square must surface as a failed probe, not as a function timeout — a timeout
// produces an opaque 502 that tells the site-health skill nothing.
const PROBE_TIMEOUT_MS = 4000;

function squareHeaders() {
  return {
    'Authorization':  `Bearer ${TOKEN}`,
    'Content-Type':   'application/json',
    'Square-Version': '2024-01-18',
  };
}

async function fetchWithTimeout(url, options = {}, ms = PROBE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── The probe order ──────────────────────────────────────────────────────────
// This mirrors the richest real path create-invoice.js builds: a shipped order
// to a Florida address, so it carries a taxed product line, an untaxed shipping
// line, an order-scope percentage discount, a SHIPMENT fulfillment with a full
// recipient address, a reference_id and the metadata block. Every one of those
// is a thing that has broken or could break in checkout.
//
// ⚠️ Prices here are DELIBERATELY frozen constants, not reads from CATALOG.
// The probe is asking "does Square still compute this order the way it did when
// we proved it", so its inputs must not move when a price changes. If you
// change the body, recompute EXPECTED_* below and re-prove against live Square.
const PROBE_ITEM_CENTS     = 16000; // Retatrutide 10mg, the highest-volume SKU
const PROBE_SHIPPING_CENTS = 2500;
const FL_TAX_UID           = 'fl-sales-tax';
const FL_TAX_RATE          = '7.0';  // FL state 6% + Miami-Dade surtax 1%

// Verified against the live account 2026-08-17:
//   product 160.00 − 16.00 discount            = 144.00
//   tax 7% of 144.00                           =  10.08
//   shipping 25.00 − 2.50 discount             =  22.50
//                                        total = 176.58
const EXPECTED_TOTAL_CENTS    = 17658;
const EXPECTED_TAX_CENTS      = 1008;
const EXPECTED_DISCOUNT_CENTS = 1850;

function probeOrderBody() {
  return {
    order: {
      location_id:  LOCATION_ID,
      reference_id: 'HC-PROBE',
      line_items: [
        {
          name: 'Retatrutide 10mg',
          quantity: '1',
          base_price_money: { amount: PROBE_ITEM_CENTS, currency: 'USD' },
          applied_taxes: [{ tax_uid: FL_TAX_UID }],
        },
        {
          // Shipping is not taxable in Florida — no applied_taxes here, same as
          // create-invoice.js. If that ever changes, EXPECTED_TAX_CENTS moves.
          name: 'Shipping — Health Check',
          quantity: '1',
          base_price_money: { amount: PROBE_SHIPPING_CENTS, currency: 'USD' },
        },
      ],
      taxes: [{
        uid: FL_TAX_UID,
        name: 'Florida Sales Tax (7%)',
        percentage: FL_TAX_RATE,
        scope: 'LINE_ITEM',
      }],
      discounts: [{
        name: 'FORGE10 — 10% New Customer Discount',
        percentage: '10',
        scope: 'ORDER',
      }],
      fulfillments: [{
        type: 'SHIPMENT',
        shipment_details: {
          recipient: {
            display_name:  'Health Check Probe',
            email_address: 'healthcheck@theforgepeptides.com',
            address: {
              address_line_1: '341 SW 136th Ave',
              locality:       'Miami',
              administrative_district_level_1: 'FL',
              postal_code:    '33184',
              country:        'US',
            },
          },
        },
      }],
      metadata: {
        forge_order_number: 'HC-PROBE',
        payment_status:     'AWAITING_ZELLE',
        payment_method:     'ZELLE',
        fulfillment_type:   'SHIP',
      },
    },
  };
}

// ── Probes ───────────────────────────────────────────────────────────────────
// Each returns { probe, ok, latency_ms, detail }. A probe never throws — a
// thrown probe would take the whole endpoint down and cost us the breakdown
// that makes this useful.

function probeEnv() {
  const started = Date.now();
  const missing = [];
  if (!TOKEN)       missing.push('SQUARE_ACCESS_TOKEN');
  if (!LOCATION_ID) missing.push('SQUARE_LOCATION_ID');
  return {
    probe: 'env',
    ok: missing.length === 0,
    latency_ms: Date.now() - started,
    detail: missing.length
      ? { missing, hint: 'Set these in Netlify → Site settings → Environment variables, then redeploy.' }
      : { present: ['SQUARE_ACCESS_TOKEN', 'SQUARE_LOCATION_ID'] },
  };
}

async function probeCatalog() {
  const started = Date.now();
  try {
    const res  = await fetchWithTimeout(`${SQUARE_API}/catalog/list?types=ITEM`, {
      headers: squareHeaders(),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      return {
        probe: 'catalog', ok: false, latency_ms: Date.now() - started,
        detail: { status: res.status, errors: data.errors || null },
      };
    }
    // An authenticated 200 with an empty catalog is not health — it's what a
    // wiped or wrong-account token looks like. Treat it as a failure.
    const count = (data.objects || []).filter(o => o.type === 'ITEM').length;
    return {
      probe: 'catalog',
      ok: count > 0,
      latency_ms: Date.now() - started,
      detail: count > 0 ? { items: count } : { items: 0, note: 'Authenticated but the catalog is empty.' },
    };
  } catch (err) {
    return {
      probe: 'catalog', ok: false, latency_ms: Date.now() - started,
      detail: { error: err.name === 'AbortError' ? `timed out after ${PROBE_TIMEOUT_MS}ms` : err.message },
    };
  }
}

async function probeCheckout() {
  const started = Date.now();
  try {
    const res  = await fetchWithTimeout(`${SQUARE_API}/orders/calculate`, {
      method: 'POST',
      headers: squareHeaders(),
      body: JSON.stringify(probeOrderBody()),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.order) {
      return {
        probe: 'checkout', ok: false, latency_ms: Date.now() - started,
        detail: { status: res.status, errors: data.errors || null,
                  note: 'Square rejected a full, valid order body. This is the 2026-08-13 failure.' },
      };
    }

    // 🚨 The status code is not the test. See the header comment: a dangling
    // tax reference returns 200 with the tax silently dropped. Assert on money.
    const o = data.order;
    const actual = {
      total:    o.total_money?.amount ?? null,
      tax:      o.total_tax_money?.amount ?? null,
      discount: o.total_discount_money?.amount ?? null,
    };
    const mismatches = [];
    if (actual.total    !== EXPECTED_TOTAL_CENTS)    mismatches.push({ field: 'total_money',          expected: EXPECTED_TOTAL_CENTS,    actual: actual.total });
    if (actual.tax      !== EXPECTED_TAX_CENTS)      mismatches.push({ field: 'total_tax_money',      expected: EXPECTED_TAX_CENTS,      actual: actual.tax });
    if (actual.discount !== EXPECTED_DISCOUNT_CENTS) mismatches.push({ field: 'total_discount_money', expected: EXPECTED_DISCOUNT_CENTS, actual: actual.discount });

    // Belt and braces: calculate must never mint an order. If a Square change
    // ever made it do so, we want to know immediately rather than accumulate
    // a phantom order every minute.
    const created = Boolean(o.id);

    return {
      probe: 'checkout',
      ok: mismatches.length === 0 && !created,
      latency_ms: Date.now() - started,
      detail: created
        ? { created_order_id: o.id, note: 'STOP — orders/calculate returned an order id. It is no longer non-destructive. Disable this endpoint.' }
        : mismatches.length
          ? { mismatches, note: 'Square returned 200 but computed different money than when this probe was proven. Checkout math has drifted.' }
          : { computed: actual },
    };
  } catch (err) {
    return {
      probe: 'checkout', ok: false, latency_ms: Date.now() - started,
      detail: { error: err.name === 'AbortError' ? `timed out after ${PROBE_TIMEOUT_MS}ms` : err.message },
    };
  }
}

// ── Persistence (best-effort, never load-bearing) ─────────────────────────────
// Writes one row per probe into the health_checks table from phase1-schema.sql:
//   (probe text, ok boolean, latency_ms integer, detail jsonb, checked_at timestamptz)
// Uses PostgREST directly rather than @supabase/supabase-js so this function
// stays dependency-free and esbuild has nothing to bundle.
async function recordProbes(results) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return { logged: false, reason: 'supabase env not set' };
  try {
    const rows = results.map(r => ({
      probe:      r.probe,
      ok:         r.ok,
      latency_ms: r.latency_ms,
      detail:     r.detail,
    }));
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/health_checks`, {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=minimal',
      },
      body: JSON.stringify(rows),
    }, 2000);
    return res.ok ? { logged: true, rows: rows.length }
                  : { logged: false, reason: `supabase ${res.status}` };
  } catch (err) {
    // Swallow deliberately. A logging outage must not turn a healthy site red.
    return { logged: false, reason: err.name === 'AbortError' ? 'supabase timed out' : err.message };
  }
}

// ── Handler ──────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const startedAt = Date.now();

  if (HEALTH_TOKEN) {
    const supplied = event.queryStringParameters?.token
                  || event.headers?.['x-health-token'];
    if (supplied !== HEALTH_TOKEN) {
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({ ok: false, error: 'Unauthorized' }),
      };
    }
  }

  const results = [];
  const env = probeEnv();
  results.push(env);

  // No credentials means the Square probes can only produce noise. Report the
  // real cause once instead of three cascading auth failures.
  if (env.ok) {
    results.push(await probeCatalog());
    results.push(await probeCheckout());
  } else {
    for (const probe of ['catalog', 'checkout']) {
      results.push({ probe, ok: false, latency_ms: 0,
                     detail: { skipped: 'Square env vars missing — see the env probe.' } });
    }
  }

  const ok = results.every(r => r.ok);
  const persistence = await recordProbes(results);

  return {
    statusCode: ok ? 200 : 500,
    headers: {
      'Content-Type':  'application/json',
      // Never let a CDN or monitor cache a health verdict.
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
    body: JSON.stringify({
      ok,
      checked_at:  new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      failing:     results.filter(r => !r.ok).map(r => r.probe),
      probes:      results,
      persistence,
    }, null, 2),
  };
};
