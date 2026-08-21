// ─────────────────────────────────────────────────────────────────────────────
// Netlify Function: webauthn.js — Face ID login for /admin.html
// Added 2026-08-21.
//
//   GET  ?action=options&mode=login       → challenge + allowCredentials  [open]
//   GET  ?action=options&mode=register    → challenge + user/rp           [token]
//   GET  ?action=list                     → registered devices            [token]
//   POST { action:'register', ... }       → store a new passkey           [token]
//   POST { action:'login', ... }          → verify, return an admin token [open]
//   POST { action:'remove', id }          → forget a device               [token]
//
// 🔑 THE PASSWORD IS NOT REPLACED, only skipped on a device that has already
// proved it once: registering a passkey REQUIRES a valid admin token. Losing
// the phone means deleting a row, and the password still works everywhere.
//
// 🚨 THE LOGIN PATH IS UNAUTHENTICATED BY NECESSITY — it is what issues the
// token — so every check has to happen here rather than upstream:
//   1. the challenge is one WE issued, and DELETE...returning proves we are the
//      only request to spend it (single-use enforced by the database, not by a
//      code path someone must remember)
//   2. the credential id is one we registered
//   3. origin and RP ID match this site
//   4. the user was VERIFIED, not merely present — Face ID, not a tap
//   5. the signature verifies against the stored public key
// Any one failing returns the same flat 401.
// ─────────────────────────────────────────────────────────────────────────────

const { verifyToken, signToken } = require('./_auth-token');
const wa = require('./_webauthn');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const TIMEOUT_MS = 10000;
const CHALLENGE_TTL_MS = 3 * 60 * 1000;

async function sb(path, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json', ...(init.headers || {}),
      },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`Supabase ${res.status}: ${text.slice(0, 200)}`), { status: res.status });
    return text ? JSON.parse(text) : null;
  } finally { clearTimeout(timer); }
}

const q = (v) => encodeURIComponent(v);
const authed = (event) => {
  const secret = process.env.ADMIN_TOKEN_SECRET;
  if (!secret) return false;
  const h = event.headers?.authorization || event.headers?.Authorization || '';
  return verifyToken(secret, h.replace(/^Bearer\s+/i, ''));
};

async function issueChallenge(purpose) {
  // Sweep first so the table cannot grow without bound; it is one indexed
  // delete on a table that holds seconds' worth of rows.
  await sb(`webauthn_challenges?expires_at=lt.${q(new Date().toISOString())}`, { method: 'DELETE' })
    .catch(() => { /* a failed sweep must not block a login */ });
  const challenge = wa.newChallenge();
  await sb('webauthn_challenges', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ challenge, purpose, expires_at: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString() }),
  });
  return challenge;
}

/**
 * 🚨 Spend a challenge. DELETE ... returning representation is what makes this
 * single-use: whichever request deletes the row gets it back, and any concurrent
 * or replayed attempt gets an empty array. Checking "does it exist" and then
 * deleting would leave a race between the two.
 */
async function spendChallenge(challenge, purpose) {
  const rows = await sb(
    `webauthn_challenges?challenge=eq.${q(challenge)}&purpose=eq.${q(purpose)}&expires_at=gt.${q(new Date().toISOString())}`,
    { method: 'DELETE', headers: { Prefer: 'return=representation' } },
  );
  return Array.isArray(rows) && rows.length === 1;
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const fail401 = { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase is not configured.' }) };
  }
  if (!process.env.ADMIN_TOKEN_SECRET) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ADMIN_TOKEN_SECRET not configured.' }) };
  }

  try {
    // ── Options ─────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
      const action = event.queryStringParameters?.action || 'options';

      if (action === 'list') {
        if (!authed(event)) return fail401;
        const rows = await sb('webauthn_credentials?select=id,label,created_at,last_used_at&order=created_at.asc');
        return { statusCode: 200, headers, body: JSON.stringify({ devices: rows || [] }) };
      }

      const mode = event.queryStringParameters?.mode === 'register' ? 'register' : 'login';
      if (mode === 'register' && !authed(event)) return fail401;

      const creds = await sb('webauthn_credentials?select=credential_id');
      if (mode === 'login' && (!creds || !creds.length)) {
        // Nothing enrolled — say so plainly so the page can stay on the
        // password form instead of prompting for a Face ID that cannot work.
        return { statusCode: 200, headers, body: JSON.stringify({ available: false }) };
      }

      const challenge = await issueChallenge(mode);
      const body = mode === 'register'
        ? {
            available: true, challenge,
            rp: { id: wa.RP_ID, name: wa.RP_NAME },
            user: { id: wa.b64url(Buffer.from('forge-admin')), name: 'Forge Admin', displayName: 'Forge Admin' },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
            // Platform + required means the key stays in this device's secure
            // hardware and Face ID must actually pass.
            authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
            // Stops the same device enrolling twice as two credentials.
            excludeCredentials: (creds || []).map((c) => ({ type: 'public-key', id: c.credential_id })),
            timeout: 60000, attestation: 'none',
          }
        : {
            available: true, challenge, rpId: wa.RP_ID,
            allowCredentials: (creds || []).map((c) => ({ type: 'public-key', id: c.credential_id })),
            userVerification: 'required', timeout: 60000,
          };
      return { statusCode: 200, headers, body: JSON.stringify(body) };
    }

    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    let input = {};
    try { input = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Body is not valid JSON' }) }; }

    // ── Register ────────────────────────────────────────────────────────────
    if (input.action === 'register') {
      if (!authed(event)) return fail401;
      const { credentialId, publicKey, algorithm, clientDataJSON, authenticatorData, label } = input;
      if (!credentialId || !publicKey || !clientDataJSON || !authenticatorData) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'incomplete registration' }) };
      }
      const alg = Number(algorithm);
      if (alg !== -7 && alg !== -257) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'unsupported key algorithm' }) };
      }

      let clientData;
      try { clientData = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8')); }
      catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'bad clientDataJSON' }) }; }
      if (!await spendChallenge(String(clientData.challenge || ''), 'register')) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'challenge expired — try again' }) };
      }

      try {
        wa.verifyRegistration({ clientDataJSON, authenticatorData, expectedChallenge: clientData.challenge });
      } catch (err) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: err.message }) };
      }

      await sb('webauthn_credentials', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          credential_id: String(credentialId),
          public_key: String(publicKey),
          algorithm: alg,
          label: typeof label === 'string' ? label.slice(0, 80) : null,
        }),
      });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, registered: true }) };
    }

    // ── Login ───────────────────────────────────────────────────────────────
    if (input.action === 'login') {
      const { credentialId, clientDataJSON, authenticatorData, signature } = input;
      if (!credentialId || !clientDataJSON || !authenticatorData || !signature) return fail401;

      let clientData;
      try { clientData = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8')); }
      catch { return fail401; }

      // Spent BEFORE any verification work, so a replayed assertion is dead on
      // arrival no matter what else it carries.
      if (!await spendChallenge(String(clientData.challenge || ''), 'login')) return fail401;

      const rows = await sb(`webauthn_credentials?select=*&credential_id=eq.${q(String(credentialId))}`);
      if (!rows || !rows.length) return fail401;
      const credential = rows[0];

      let result;
      try {
        result = wa.verifyAssertion({
          credential, clientDataJSON, authenticatorData, signature,
          expectedChallenge: clientData.challenge,
        });
      } catch (err) {
        // Logged for us, flat 401 for the caller — a verification failure must
        // not tell an attacker WHICH check it failed.
        console.warn('webauthn login rejected:', err.message);
        return fail401;
      }

      // ⚠️ Recorded, never enforced. Apple's iCloud passkeys are synced and
      // report 0 every time; treating a non-increasing counter as a clone
      // would lock Frank out on his second login.
      await sb(`webauthn_credentials?id=eq.${q(credential.id)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ last_used_at: new Date().toISOString(), sign_count: result.signCount }),
      }).catch(() => { /* bookkeeping must not fail a good login */ });

      return {
        statusCode: 200, headers,
        body: JSON.stringify({ token: signToken(process.env.ADMIN_TOKEN_SECRET) }),
      };
    }

    // ── Remove ──────────────────────────────────────────────────────────────
    if (input.action === 'remove') {
      if (!authed(event)) return fail401;
      if (!input.id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id is required' }) };
      await sb(`webauthn_credentials?id=eq.${q(String(input.id))}`, { method: 'DELETE' });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, removed: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'unknown action' }) };
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    const msg = timedOut ? `Supabase timed out after ${TIMEOUT_MS}ms` : err.message;
    console.error('webauthn:', msg);
    return { statusCode: timedOut ? 504 : (err.status || 500), headers, body: JSON.stringify({ error: msg }) };
  }
};
