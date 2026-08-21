// ─────────────────────────────────────────────────────────────────────────────
// Netlify Function: save-push-subscription.js
// Added 2026-08-21 — remembers where to send a new-order notification.
//
//   POST { subscription: { endpoint, keys: { p256dh, auth } }, label? }   [token]
//   POST { rekey: true, oldEndpoint, subscription: {...} }                [no token]
//   DELETE / POST { unsubscribe: true, endpoint }                         [token]
//   GET  → { configured, publicKey, devices }                             [token]
//
// 🔑 THE ENDPOINT IS THE IDENTITY, so this upserts on it (migration 050). A
// device that re-subscribes every time the dashboard opens must refresh its row,
// not add another — otherwise one phone becomes forty rows and every order
// sends forty pushes to the same handset.
//
// 🚨 THE REKEY PATH IS THE ONE UNAUTHENTICATED ENTRY, and it is deliberately
// narrow. A service worker handling `pushsubscriptionchange` has no admin token
// — it runs with no page and no sessionStorage — so it cannot present one. It
// is allowed to do exactly one thing: REPLACE an endpoint the server already
// knows with a new one. It cannot create a subscription from nothing, so an
// attacker who guesses the URL gains no ability to register their own device;
// they would have to already know a live endpoint, which is itself the secret.
// If oldEndpoint is not on file, the request is refused.
// ─────────────────────────────────────────────────────────────────────────────

const { verifyToken } = require('./_auth-token');
const push = require('./_push');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const TIMEOUT_MS = 10000;

async function sb(path, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`Supabase ${res.status}: ${text.slice(0, 200)}`), { status: res.status });
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
  }
}

const q = (v) => encodeURIComponent(v);

// A subscription is only usable if all three parts are present and the endpoint
// is really a push service URL. Storing a malformed one means a send that fails
// later with no clue why.
function readSubscription(input) {
  const s = input && input.subscription;
  if (!s || typeof s !== 'object') return { error: 'subscription is required' };
  const endpoint = typeof s.endpoint === 'string' ? s.endpoint.trim() : '';
  const keys = s.keys || {};
  const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh.trim() : '';
  const auth = typeof keys.auth === 'string' ? keys.auth.trim() : '';
  if (!/^https:\/\//i.test(endpoint)) return { error: 'endpoint must be an https URL' };
  if (endpoint.length > 2000) return { error: 'endpoint is implausibly long' };
  if (!p256dh || !auth) return { error: 'subscription is missing its keys' };
  // 65-byte P-256 point and 16-byte auth secret, base64url. Checking here beats
  // discovering it inside the crypto at send time.
  if (push.unb64url(p256dh).length !== 65) return { error: 'p256dh is not a P-256 public key' };
  if (push.unb64url(auth).length !== 16) return { error: 'auth secret is not 16 bytes' };
  return { endpoint, p256dh, auth };
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase is not configured.' }) };
  }

  let input = {};
  if (event.body) {
    try { input = JSON.parse(event.body); }
    catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Body is not valid JSON' }) }; }
  }

  // ── The service worker's re-key, before the token check ────────────────────
  const isRekey = input.rekey === true;
  if (!isRekey) {
    const SECRET = process.env.ADMIN_TOKEN_SECRET;
    if (!SECRET) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'ADMIN_TOKEN_SECRET not configured.' }) };
    }
    const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
    if (!verifyToken(SECRET, authHeader.replace(/^Bearer\s+/i, ''))) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
    }
  }

  try {
    // ── What the page needs to subscribe, and what is already registered ─────
    if (event.httpMethod === 'GET') {
      const rows = await sb('push_subscriptions?select=id,label,user_agent,created_at,last_seen_at,last_sent_at,last_error,failures&order=created_at.asc');
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          configured: push.configured(),
          // Safe to publish — it is the public half, and the page needs it to
          // call pushManager.subscribe().
          publicKey: push.publicKey() || null,
          devices: rows || [],
        }),
      };
    }

    if (event.httpMethod !== 'POST' && event.httpMethod !== 'DELETE') {
      return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    // ── Remove a device ──────────────────────────────────────────────────────
    if (input.unsubscribe === true || event.httpMethod === 'DELETE') {
      const endpoint = typeof input.endpoint === 'string' ? input.endpoint.trim() : '';
      if (!endpoint) return { statusCode: 400, headers, body: JSON.stringify({ error: 'endpoint is required' }) };
      await sb(`push_subscriptions?endpoint=eq.${q(endpoint)}`, { method: 'DELETE' });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, removed: true }) };
    }

    const parsed = readSubscription(input);
    if (parsed.error) return { statusCode: 400, headers, body: JSON.stringify({ error: parsed.error }) };

    // ── Re-key: only ever REPLACES a known endpoint ──────────────────────────
    if (isRekey) {
      const oldEndpoint = typeof input.oldEndpoint === 'string' ? input.oldEndpoint.trim() : '';
      if (!oldEndpoint) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'oldEndpoint is required to re-key' }) };
      }
      const existing = await sb(`push_subscriptions?select=id,label&endpoint=eq.${q(oldEndpoint)}`);
      if (!existing || !existing.length) {
        // 🚨 The gate. Without a row to replace, this is an unauthenticated
        // attempt to register a device, which is exactly what must not work.
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'unknown subscription' }) };
      }
      await sb(`push_subscriptions?id=eq.${q(existing[0].id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          endpoint: parsed.endpoint, p256dh: parsed.p256dh, auth: parsed.auth,
          last_seen_at: new Date().toISOString(), failures: 0, last_error: null,
        }),
      });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, rekeyed: true }) };
    }

    // ── Normal subscribe / refresh ───────────────────────────────────────────
    const label = typeof input.label === 'string' && input.label.trim()
      ? input.label.trim().slice(0, 80) : null;
    const ua = typeof input.userAgent === 'string' ? input.userAgent.slice(0, 300) : null;

    await sb('push_subscriptions?on_conflict=endpoint', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        endpoint: parsed.endpoint,
        p256dh: parsed.p256dh,
        auth: parsed.auth,
        label,
        user_agent: ua,
        last_seen_at: new Date().toISOString(),
        // A device that just re-subscribed is healthy by definition; clearing
        // this stops an old failure making a working phone look broken.
        failures: 0,
        last_error: null,
      }),
    });

    // A confirmation push, so "it's on" is something Frank SEES rather than a
    // green label that might be lying. This is the whole point of the setup
    // step — a notification system you cannot verify is one you cannot trust.
    let testSent = false, testError = null;
    if (input.sendTest !== false && push.configured()) {
      const r = await push.sendPush(
        { endpoint: parsed.endpoint, p256dh: parsed.p256dh, auth: parsed.auth },
        { title: 'Forge Admin notifications are on', body: 'This is what a new order will look like.', tag: 'forge-test' },
      );
      testSent = r.ok;
      if (!r.ok) testError = r.error || `push service ${r.status}`;
    }

    return {
      statusCode: 200, headers,
      body: JSON.stringify({ ok: true, saved: true, configured: push.configured(), testSent, testError }),
    };
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    const msg = timedOut ? `Supabase timed out after ${TIMEOUT_MS}ms` : err.message;
    console.error('save-push-subscription:', msg);
    return { statusCode: timedOut ? 504 : (err.status || 500), headers, body: JSON.stringify({ error: msg }) };
  }
};
