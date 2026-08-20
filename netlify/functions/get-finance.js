// ─────────────────────────────────────────────────────────────────────────────
// Netlify Function: get-finance.js
// Added 2026-08-20 — reads everything the Finance tab needs in one call.
//
// 🔑 It fetches; _finance.js decides. Every figure on the page comes out of
// summarise(), which is a pure function of the bundle below and is covered by
// test-finance.mjs. Nothing here does arithmetic on money.
//
// 🔑 Revenue, COGS and profit come from v_product_sales — the same view the
// Inventory tab's margins come from. This endpoint never derives them from
// prices and costs of its own, because two surfaces working out margin
// independently is how the books end up with two answers.
//
// 🔐 Token-gated. This is the whole shape of the business — takings, cost of
// goods, margins, and who owes money. Never make it public.
//
// ⚠️ Reads Supabase with the SERVICE ROLE key, which bypasses row-level
// security. Safe only because this runs server-side and behind the token above.
// ─────────────────────────────────────────────────────────────────────────────

const { verifyToken } = require('./_auth-token');
const { summarise, PERIODS } = require('./_finance');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

const TIMEOUT_MS = 8000;
const PAGE = 1000;          // PostgREST caps a single response; paging is not optional
const MAX_PAGES = 20;       // 20k rows of anything here means something is wrong

async function fetchWithTimeout(url, options = {}, ms = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function sbPage(path, offset) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${SUPABASE_URL}/rest/v1/${path}${sep}limit=${PAGE}&offset=${offset}`;
  const res = await fetchWithTimeout(url, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Accept: 'application/json',
    },
  });
  const body = await res.text();
  if (!res.ok) {
    const err = new Error(res.status === 404
      ? `A view the Finance tab reads is missing (${path.split('?')[0]}).`
      : `Supabase returned ${res.status}`);
    err.status = 502;
    err.detail = body.slice(0, 400);
    throw err;
  }
  return JSON.parse(body);
}

// 🚨 Pages until a short page comes back. A silently truncated first page is
// the failure that matters here: every total on the tab would simply be too
// small, with nothing on screen looking wrong. Hitting MAX_PAGES throws rather
// than returning a partial answer.
async function sbAll(path) {
  const out = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await sbPage(path, page * PAGE);
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
  const err = new Error(`Refusing to report on a partial read of ${path.split('?')[0]} (over ${MAX_PAGES * PAGE} rows).`);
  err.status = 500;
  throw err;
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  const SECRET = process.env.ADMIN_TOKEN_SECRET;
  if (!SECRET) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ADMIN_TOKEN_SECRET not configured.' }) };
  }
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  if (!verifyToken(SECRET, authHeader.replace(/^Bearer\s+/i, ''))) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return {
      statusCode: 500, headers,
      body: JSON.stringify({
        error: 'Supabase is not configured.',
        detail: 'Set SUPABASE_URL and SUPABASE_SERVICE_KEY in Netlify → Site settings → Environment variables, then redeploy.',
      }),
    };
  }

  const asked = (event.queryStringParameters && event.queryStringParameters.period) || 'all';
  const period = Object.prototype.hasOwnProperty.call(PERIODS, asked) ? asked : 'all';

  try {
    const [sales, orders, tenders, variants, products, house] = await Promise.all([
      // The books. One row per sold PRODUCT line, already carrying revenue,
      // COGS and profit — and already excluding cancelled and untendered orders.
      sbAll('v_product_sales?select=order_id,order_no,placed_at,channel,variant_id,name_at_sale,quantity,revenue_cents,gross_collected_cents,sales_tax_cents,cogs_cents,profit_cents&order=placed_at.asc'),
      // Every SALE order, INCLUDING cancelled ones — the tab reports what was
      // voided, and an order that is simply absent cannot be reported on.
      sbAll('orders?select=id,order_no,placed_at,state,purpose,payment_state,total_cents&purpose=eq.SALE&order=placed_at.asc'),
      sbAll('tenders?select=order_id,type,amount_cents,received_at'),
      // 🔑 Names come from the tables, not v_inventory_dashboard: that view
      // filters hidden variants, and a hidden product still has sales history.
      sbAll('variants?select=id,name,product_id'),
      sbAll('products?select=id,name'),
      sbAll('v_house_account_balance?select=party_id,display_name,charged_cents,paid_cents,balance_cents,payment_count,last_charge_at'),
    ]);

    const payload = summarise({ sales, orders, tenders, variants, products, house }, { period });

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        as_of: new Date().toISOString(),
        periods: Object.entries(PERIODS).map(([k, v]) => ({ key: k, label: v.label })),
        ...payload,
      }),
    };
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    const msg = timedOut ? `Supabase timed out after ${TIMEOUT_MS}ms` : err.message;
    console.error('get-finance error:', msg);
    return {
      statusCode: err.status || 500, headers,
      body: JSON.stringify({ error: msg, detail: err.detail }),
    };
  }
};
