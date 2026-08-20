// ─────────────────────────────────────────────────────────────────────────────
// Netlify Function: set-house-account.js
// Added 2026-08-20 — decide who may buy on credit, and take it back.
//
//   POST { party_id, enabled, limit_cents? }
//
// Frank, 2026-08-20: "I want to select who I want to give house accounts to and
// take away house accounts also... I don't wanna give a house account to
// everybody." Until now anyone could be charged to a tab, because nothing ever
// checked — the decision existed in his head and nowhere in the system.
//
// 🚨 REVOKING IS NOT FORGIVING. This writes one boolean. It does not touch
// orders, tenders, stock or house_account_payments, and v_house_account_balance
// is built from charges and payments rather than from this flag — so a revoked
// customer's debt stays exactly as visible and as collectable as it was, and can
// still be paid off through record-payment.js. The response carries what they
// owe precisely so the page can say that out loud instead of the number
// vanishing off a screen and looking written off.
//
// 🔑 THE FLAG IS NOT `parties.kind`. kind already carries CUSTOMER vs INTERNAL,
// and Frank's own INTERNAL party holds $145.80 of house-account charges — using
// kind would have forced a choice between "this is me" and "this one has a tab".
// Migration 028 gives the permission its own column and backfills everyone who
// already had an account. See fixes/028-house-account-grants.sql.
//
// ⚠️ THE REAL GATE IS IN create-order.js, not here. This endpoint records the
// decision; that one enforces it. A rule that lives only in the page it is drawn
// on is not a rule.
//
// 🔐 Token-gated like every admin endpoint.
// ─────────────────────────────────────────────────────────────────────────────

const { verifyToken } = require('./_auth-token');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const TIMEOUT_MS = 10000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A tab is credit, and credit has a sane ceiling. $100,000 is not a limit
// anybody would set on purpose — it is a decimal point in the wrong place.
const MAX_LIMIT_CENTS = 10000000;

async function sb(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...options,
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
    const body = await res.text();
    if (!res.ok) {
      const missingColumn = /house_account_enabled/.test(body);
      const err = new Error(missingColumn
        ? 'House-account permissions are not set up in the database yet.'
        : `Supabase returned ${res.status}`);
      err.status = missingColumn ? 503 : 502;
      err.hint = missingColumn
        ? 'Apply replace-square-phase1/fixes/028-house-account-grants.sql, then reload.'
        : undefined;
      err.detail = body.slice(0, 400);
      throw err;
    }
    return body ? JSON.parse(body) : null;
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };
  }

  const SECRET = process.env.ADMIN_TOKEN_SECRET;
  if (!SECRET) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ADMIN_TOKEN_SECRET not configured.' }) };
  }
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  if (!verifyToken(SECRET, authHeader.replace(/^Bearer\s+/i, ''))) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase is not configured.' }) };
  }

  let input;
  try { input = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Bad request body' }) }; }

  const partyId = String(input.party_id || '');
  if (!UUID.test(partyId)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Pick a customer first' }) };
  }
  if (typeof input.enabled !== 'boolean') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Say whether the account is being given or taken away' }) };
  }

  // A limit is optional and clearable. `null` means "no ceiling"; leaving the
  // key out entirely means "do not touch whatever is already set", which are
  // different intents and must not collapse into each other.
  const touchLimit = Object.prototype.hasOwnProperty.call(input, 'limit_cents');
  let limitCents = null;
  if (touchLimit && input.limit_cents !== null && input.limit_cents !== '') {
    limitCents = Math.round(Number(input.limit_cents));
    if (!Number.isFinite(limitCents) || limitCents < 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'That credit limit is not an amount' }) };
    }
    if (limitCents > MAX_LIMIT_CENTS) {
      return { statusCode: 400, headers, body: JSON.stringify({
        error: `A credit limit over $${(MAX_LIMIT_CENTS / 100).toLocaleString('en-US')} is almost certainly a typo` }) };
    }
  }

  try {
    const found = await sb(`parties?select=id,display_name,merged_into_id,house_account_enabled,house_account_limit_cents&id=eq.${partyId}`);
    if (!found.length) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'No such customer' }) };
    }
    const party = found[0];

    // 🔑 A merged-away duplicate is not a person any more — its orders and its
    // tab belong to the survivor. Granting the dead row would grant nobody and
    // look like it worked.
    if (party.merged_into_id) {
      return { statusCode: 409, headers, body: JSON.stringify({
        error: 'That record was merged into another customer — set it on the one that survived.',
        merged_into_id: party.merged_into_id,
      }) };
    }

    const patch = { house_account_enabled: input.enabled, updated_at: new Date().toISOString() };
    if (touchLimit) patch.house_account_limit_cents = limitCents;
    // 🔑 Taking the account away clears the limit too. A ceiling left behind on
    // a revoked account is a number that describes nothing, and would reappear
    // as if it had been agreed the next time credit was granted.
    if (!input.enabled) patch.house_account_limit_cents = null;

    const updated = await sb(`parties?id=eq.${partyId}&select=id,display_name,house_account_enabled,house_account_limit_cents`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    });

    // What they owe, so the page can be honest about a revocation rather than
    // letting the balance disappear off the screen with the account.
    let owedCents = 0;
    try {
      const bal = await sb(`v_house_account_balance?select=balance_cents&party_id=eq.${partyId}`);
      owedCents = bal.length ? Number(bal[0].balance_cents) || 0 : 0;
    } catch { /* the balance view is reporting, not permission — never block on it */ }

    const row = updated[0] || party;
    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        party_id: row.id,
        name: row.display_name,
        enabled: row.house_account_enabled,
        limit_cents: row.house_account_limit_cents,
        owed_cents: owedCents,
        was_enabled: party.house_account_enabled,
      }),
    };
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    if (!err.status || err.status >= 500) console.error('set-house-account error:', err.message);
    return {
      statusCode: timedOut ? 504 : (err.status || 500), headers,
      body: JSON.stringify({
        error: timedOut ? 'Timed out updating the customer.' : err.message,
        hint: err.hint,
      }),
    };
  }
};
