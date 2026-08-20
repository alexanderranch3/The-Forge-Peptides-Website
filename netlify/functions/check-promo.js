// ─────────────────────────────────────────────────────────────────────────────
// Netlify Function: check-promo.js
// Added 2026-08-20 — tells the checkout page what a promo code is worth.
//
//   POST { code } → { valid, percent, label }
//
// 🚨 WHY THIS HAS TO EXIST. index.html validated codes in the browser against a
// hardcoded list, which is fine for a public 10%-off code and impossible for a
// private one: THIS REPOSITORY IS PUBLIC, so putting the owner's 100%-off code
// in the page would publish it to the world. The page now asks the server, and
// the code itself never leaves Netlify's environment.
//
// 🔑 IT IS NOT THE AUTHORITY ON WHAT IS CHARGED. create-invoice.js re-decides
// the discount server-side when the order is placed, and always did. This exists
// so the total a customer READS matches the total they are CHARGED — a page that
// promises a discount the server then refuses is worse than one that never
// promised it.
//
// ⚠️ It reveals only "is this a code, and for how much" — never the list of
// codes, and never whether a first-order condition is met (create-invoice
// decides that at checkout, against the customer's actual history). Guessing an
// unknown code is the only attack, and an 8-character private code is not worth
// brute-forcing through a rate-limited function for one discounted order.
//
// 🔑 Public by design: the checkout page is public and has no admin token.
// ─────────────────────────────────────────────────────────────────────────────

// Kept in step with create-invoice.js. Two files knowing the percentages is one
// too many, but the alternative — the storefront importing a server module — is
// worse, so the check-promo test asserts they agree.
const PUBLIC_PERCENT = { LOYAL10: 10, FORGE10: 10 };

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };
  }

  let input = {};
  try { input = JSON.parse(event.body || '{}'); } catch { /* handled below */ }

  const raw = String(input.code || '').trim();
  if (!raw) return { statusCode: 200, headers, body: JSON.stringify({ valid: false, percent: 0 }) };

  // ── The owner's code ───────────────────────────────────────────────────────
  // 🔑 Compared case-INSENSITIVELY, because the checkout box upper-cases what is
  // typed, so a mixed-case code arrives upper-cased and a case-sensitive match
  // would reject the owner's own code — which is exactly what happened.
  // ⚠️ NEVER write the actual code in a comment. This repository is public.
  //
  // ⚠️ If OWNER_PROMO_CODE is unset the branch cannot match anything: an empty
  // configured value would otherwise make every code the owner's code.
  const ownerCode = (process.env.OWNER_PROMO_CODE || '').trim();
  if (ownerCode && raw.toLowerCase() === ownerCode.toLowerCase()) {
    return {
      statusCode: 200, headers,
      body: JSON.stringify({ valid: true, percent: 100, label: 'Owner order — 100% off' }),
    };
  }

  const upper = raw.toUpperCase();
  const percent = PUBLIC_PERCENT[upper] || 0;
  return {
    statusCode: 200, headers,
    body: JSON.stringify(percent
      ? { valid: true, percent, label: `${upper} — ${percent}% off` }
      : { valid: false, percent: 0 }),
  };
};
