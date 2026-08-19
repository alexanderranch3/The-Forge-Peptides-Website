// ─────────────────────────────────────────────────────────────────────────────
// Netlify Function: record-payment.js
// Added 2026-08-19 — pay off a house account.
//
//   POST { party_id, amount_cents, method?, reference?, note? }
//
// The other half of deferring a payment. A sale charged to someone's tab already
// counted as revenue when it was rung up — this records the cash arriving
// afterwards and brings their balance down.
//
// 🚨 THIS IS NOT REVENUE AND MUST NEVER BE WRITTEN AS A TENDER. The sale it pays
// for already has one; adding a second would count the same money twice.
// record_house_payment writes to house_account_payments, which nothing in the
// revenue path reads. That separation is the whole accounting model.
//
// ⚠️ IT REFUSES TO OVERPAY. record_house_payment rejects an amount larger than
// the outstanding balance, and rejects a customer who owes nothing. An
// overpayment is nearly always a typo or a payment recorded against the wrong
// person, and quietly creating a credit balance hides both.
//
// 🔐 Token-gated like every admin endpoint.
// ─────────────────────────────────────────────────────────────────────────────

const { verifyToken } = require('./_auth-token');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const TIMEOUT_MS = 10000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 🔑 HOUSE_ACCOUNT is absent on purpose — paying a tab with the tab is not a
// payment. The database rejects it too; this is the message a person can read.
const METHODS = ['ZELLE', 'CASH', 'CARD', 'BANK_TRANSFER', 'OTHER'];

async function rpc(fn, args) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      let message = `Supabase ${res.status}`;
      try { message = JSON.parse(text).message || message; } catch { /* not json */ }
      throw Object.assign(new Error(message), { status: res.status < 500 ? 400 : res.status });
    }
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  const SECRET = process.env.ADMIN_TOKEN_SECRET;
  if (!SECRET) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ADMIN_TOKEN_SECRET not configured.' }) };
  }
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  if (!verifyToken(SECRET, authHeader.replace(/^Bearer\s+/i, ''))) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase is not configured.' }) };
  }

  let input = {};
  try { input = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Body is not valid JSON' }) }; }

  const partyId = String(input.party_id || '');
  if (!UUID.test(partyId)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Pick which customer is paying' }) };
  }
  const amount = Number(input.amount_cents);
  if (!Number.isInteger(amount) || amount <= 0) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Enter how much was received' }) };
  }
  // A guard against a slipped decimal point, not a business rule. $50,000 in one
  // payoff on an account whose history tops out in the hundreds is a typo.
  if (amount > 5_000_000) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'That is over $50,000 — check the amount' }) };
  }
  const method = String(input.method || 'ZELLE').toUpperCase();
  if (!METHODS.includes(method)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: `Payment method must be one of ${METHODS.join(', ')}` }) };
  }

  try {
    const result = await rpc('record_house_payment', {
      p: {
        party_id: partyId,
        amount_cents: amount,
        method,
        reference: typeof input.reference === 'string' ? input.reference.slice(0, 120) : null,
        note: typeof input.note === 'string' ? input.note.slice(0, 500) : null,
        created_by: 'dashboard',
      },
    });
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ...result }) };
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    const msg = timedOut ? `Supabase timed out after ${TIMEOUT_MS}ms` : err.message;
    const missing = /record_house_payment|house_account_payments/.test(msg)
      && /does not exist|not find|function/i.test(msg);
    if (!err.status || err.status >= 500) console.error('record-payment error:', msg);
    return {
      statusCode: timedOut ? 504 : (err.status || 500), headers,
      body: JSON.stringify({
        error: missing ? 'House accounts are not set up in the database yet.' : msg,
        hint: missing ? 'Apply replace-square-phase1/fixes/024-house-accounts.sql, then reload.' : undefined,
      }),
    };
  }
};
