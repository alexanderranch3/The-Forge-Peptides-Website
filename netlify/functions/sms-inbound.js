// Netlify Function: sms-inbound.js
// The webhook a provider calls when a customer texts us. Its entire job is to
// make STOP mean something.
//
// WHY IT MUST EXIST
// Carriers require STOP and HELP handling, and a 10DLC reviewer checks for it.
// Providers usually send the customer-facing STOP confirmation themselves at the
// network level — but that does NOT tell OUR database anything. Without this, a
// customer texts STOP, the carrier stops delivering, and we carry on believing we
// have consent and queuing messages forever. The record has to move too.
//
// 🚨 UNAUTHENTICATED CALLERS ARE REFUSED. This endpoint changes consent, so an
// open version would let anyone revoke (or worse, re-grant) any number by POSTing
// a phone number. It verifies the provider's request signature and fails CLOSED
// when no verification secret is configured — better mute than forged.
//
// 🔑 OPT-OUT MATCHING IS DELIBERATELY LENIENT, OPT-IN IS STRICT. "STOP", "stop.",
// "Stop please" all stop the messages, because the cost of over-reading an opt-out
// is one missed receipt while the cost of under-reading one is an unlawful text.
// Re-subscribing requires an exact START/UNSTOP, since accidentally reading consent
// into a passing message is the error that actually hurts.
//
// PROVIDER NOTE: the signature check below is Twilio's scheme (HMAC-SHA1 over the
// URL plus sorted params). Another provider means another verifier — replace
// verifySignature() and nothing else changes.

const crypto = require('crypto');
const { rpc } = require('./_order-sync');
const { safeEqual } = require('./_customer-auth');

const AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN || '';
const SUPPORT     = process.env.ORDER_FROM_EMAIL || 'orders@theforgepeptides.com';
const HELP_REPLY  = `The Forge Peptides: help at ${String(SUPPORT).replace(/^.*<|>.*$/g, '')} `
                  + `or theforgepeptides.com. Reply STOP to opt out. Msg & data rates may apply.`;

// Standard carrier keywords. Kept as whole words — a token match, never substring,
// so "nonstop" is not an opt-out.
const STOP_WORDS  = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT']);
const HELP_WORDS  = new Set(['HELP', 'INFO']);
const START_WORDS = new Set(['START', 'UNSTOP', 'YES', 'OPTIN']);

/** Twilio: base64(HMAC-SHA1(authToken, url + each sorted key immediately followed by its value)). */
function verifySignature(url, params, signature) {
  if (!AUTH_TOKEN || !signature) return false;
  const payload = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  const expected = crypto.createHmac('sha1', AUTH_TOKEN).update(Buffer.from(payload, 'utf8')).digest('base64');
  return safeEqual(signature, expected);
}

/** Providers post form-encoded; some post JSON. Accept both, prefer neither. */
function parseBody(event) {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || '');
  const ctype = String(event.headers['content-type'] || event.headers['Content-Type'] || '');
  if (ctype.includes('application/json')) {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function classify(text) {
  // Letters only, so "STOP!" and "stop," land on the same token. Apostrophes are
  // stripped FIRST and not treated as separators: splitting on them turns "don't"
  // into DON + T, which silently defeats the negation guard below and reads
  // "don't stop sending" as an opt-out.
  const tokens = String(text || '').toUpperCase()
    .replace(/['’ʼ]/g, '')
    .replace(/[^A-Z]+/g, ' ')
    .trim().split(' ').filter(Boolean);
  if (!tokens.length) return 'none';
  // Lenient: any STOP keyword anywhere opts out. Guarded against negation so
  // "do not stop" is not read as an opt-out.
  const negated = tokens.some((t, i) => STOP_WORDS.has(t) && i > 0 && ['NOT', 'DONT', 'NO', 'NEVER'].includes(tokens[i - 1]));
  if (!negated && tokens.some((t) => STOP_WORDS.has(t))) return 'stop';
  // Strict: consent is only read from a message that is exactly the keyword.
  if (tokens.length === 1 && START_WORDS.has(tokens[0])) return 'start';
  if (tokens.some((t) => HELP_WORDS.has(t))) return 'help';
  return 'none';
}

// An empty TwiML document: acknowledged, no reply from us. Providers send their
// own STOP/HELP confirmation at the network level, and answering as well would
// text the customer twice — including one message after they asked us to stop.
const NO_REPLY = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
const reply = (body) => ({
  statusCode: 200,
  headers: { 'Content-Type': 'text/xml', 'Cache-Control': 'no-store' },
  body,
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  if (!AUTH_TOKEN) {
    console.error('sms-inbound: TWILIO_AUTH_TOKEN not set — refusing to trust any caller');
    return { statusCode: 503, body: 'Not configured' };
  }

  const params = parseBody(event);
  const proto = event.headers['x-forwarded-proto'] || 'https';
  const host  = event.headers['x-forwarded-host'] || event.headers.host;
  const url   = `${proto}://${host}${event.rawUrl ? new URL(event.rawUrl).pathname : event.path}`;
  const sig   = event.headers['x-twilio-signature'] || event.headers['X-Twilio-Signature'];

  if (!verifySignature(url, params, sig)) {
    // Deliberately terse: an attacker learns nothing about why.
    console.error('sms-inbound: signature verification failed');
    return { statusCode: 403, body: 'Forbidden' };
  }

  const from = String(params.From || params.from || '').trim();
  const kind = classify(params.Body || params.body);
  if (!from) return reply(NO_REPLY);

  try {
    if (kind === 'stop') {
      // Revokes BOTH kinds — someone texting STOP is not making a fine-grained
      // request, and the safe reading of an ambiguous opt-out is the broadest one.
      const n = await rpc('revoke_sms_consent', {
        p_phone: from, p_kind: null, p_source: 'stop_reply',
        p_note: String(params.Body || '').slice(0, 200),
      });
      console.log(`sms-inbound: STOP from ${from.slice(-4).padStart(from.length, '*')} — ${n} consent(s) revoked`);
      return reply(NO_REPLY);
    }

    if (kind === 'start') {
      // Texting START is express consent, and the message itself is the evidence,
      // so it is stored verbatim as the wording.
      await rpc('record_sms_consent', {
        p_phone: from, p_order: true, p_marketing: false,
        p_version: 'inbound-start',
        p_order_text: `Customer texted "${String(params.Body || '').trim().slice(0, 60)}" to re-subscribe.`,
        p_mkt_text: null, p_source: 'inbound_start',
      });
      return reply(NO_REPLY);
    }

    if (kind === 'help') {
      // Answered here only if the provider is not configured to auto-reply.
      return reply(process.env.SMS_SEND_HELP_REPLY === '1'
        ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${HELP_REPLY}</Message></Response>`
        : NO_REPLY);
    }

    return reply(NO_REPLY);
  } catch (err) {
    // 🚨 Never 500 a STOP. A provider that gets an error may retry or, worse, treat
    // the opt-out as unhandled — and the customer keeps getting messages. Log loudly,
    // acknowledge, and fix it from the log.
    console.error(`sms-inbound: FAILED to record "${kind}" from ${from}:`, err.message);
    return reply(NO_REPLY);
  }
};
