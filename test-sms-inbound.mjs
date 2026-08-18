// Tests sms-inbound.js — the STOP/HELP webhook. No network: rpc is stubbed.
//
// Mostly attacks and edge cases, because the failure modes are asymmetric: a
// missed STOP is an unlawful text, and a forged request could revoke or grant
// consent for any number.
import { createRequire } from 'module';
import crypto from 'crypto';
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ok = (label, got, want) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${label}` + (good ? '' : `  got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
  good ? pass++ : fail++;
};
const okTrue = (l, c) => ok(l, !!c, true);

const TOKEN = 'test-auth-token';
process.env.TWILIO_AUTH_TOKEN = TOKEN;
process.env.CUSTOMER_SESSION_SECRET = 'x'.repeat(48);

// Capture what would have been sent to the database.
let calls = [];
const syncPath = require.resolve('./netlify/functions/_order-sync');
require.cache[syncPath] = { id: syncPath, filename: syncPath, loaded: true,
  exports: { rpc: async (fn, args) => { calls.push({ fn, args }); return 1; } } };

const fresh = () => {
  delete require.cache[require.resolve('./netlify/functions/sms-inbound')];
  return require('./netlify/functions/sms-inbound');
};
let h = fresh().handler;

const URL_ = 'https://theforgepeptides.com/.netlify/functions/sms-inbound';
function sign(params) {
  const payload = Object.keys(params).sort().reduce((a, k) => a + k + params[k], URL_);
  return crypto.createHmac('sha1', TOKEN).update(Buffer.from(payload, 'utf8')).digest('base64');
}
async function post(params, { signature, token } = {}) {
  calls = [];
  const body = new URLSearchParams(params).toString();
  return h({
    httpMethod: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      host: 'theforgepeptides.com',
      'x-forwarded-proto': 'https',
      'x-twilio-signature': signature !== undefined ? signature : sign(params),
    },
    path: '/.netlify/functions/sms-inbound',
    rawUrl: URL_,
    body,
  });
}

console.log('\n— 🚨 an unsigned or forged caller cannot touch consent —');
let r = await post({ From: '+15125550100', Body: 'STOP' }, { signature: 'not-the-signature' });
ok('a bad signature is refused', r.statusCode, 403);
ok('and nothing was written', calls.length, 0);
r = await post({ From: '+15125550100', Body: 'STOP' }, { signature: '' });
ok('a missing signature is refused', r.statusCode, 403);
ok('still nothing written', calls.length, 0);
// Tampering with the body after signing must invalidate it.
const good = sign({ From: '+15125550100', Body: 'STOP' });
r = await post({ From: '+15125559999', Body: 'STOP' }, { signature: good });
ok('🚨 swapping the phone number after signing is refused', r.statusCode, 403);

console.log('\n— GET and misconfiguration —');
ok('GET is rejected', (await h({ httpMethod: 'GET', headers: {} })).statusCode, 405);
delete process.env.TWILIO_AUTH_TOKEN;
h = fresh().handler;
r = await post({ From: '+1', Body: 'STOP' }, { signature: 'anything' });
ok('🚨 with no auth token it fails CLOSED, not open', r.statusCode, 503);
process.env.TWILIO_AUTH_TOKEN = TOKEN;
h = fresh().handler;

console.log('\n— STOP is read leniently —');
for (const body of ['STOP', 'stop', 'Stop.', 'STOP!', 'stop please', 'Please STOP', 'UNSUBSCRIBE', 'cancel', 'QUIT', 'End', 'OPTOUT']) {
  r = await post({ From: '+15125550100', Body: body });
  const call = calls.find((c) => c.fn === 'revoke_sms_consent');
  ok(`"${body}" opts out`, !!call && r.statusCode === 200, true);
}
r = await post({ From: '+15125550100', Body: 'STOP' });
ok('revoke covers BOTH kinds (p_kind null)', calls[0].args.p_kind, null);
ok('and is attributed to the reply', calls[0].args.p_source, 'stop_reply');

console.log('\n— but not when negated, and not inside another word —');
for (const body of ['do not stop', "don't stop sending", 'never cancel this']) {
  r = await post({ From: '+15125550100', Body: body });
  ok(`"${body}" does NOT opt out`, calls.some((c) => c.fn === 'revoke_sms_consent'), false);
}
r = await post({ From: '+15125550100', Body: 'nonstop shipping question' });
ok('"nonstop" is not a keyword', calls.some((c) => c.fn === 'revoke_sms_consent'), false);

console.log('\n— START is read strictly —');
r = await post({ From: '+15125550100', Body: 'START' });
ok('a bare START re-subscribes', calls.some((c) => c.fn === 'record_sms_consent'), true);
okTrue('and records the message as the evidence',
  calls[0].args.p_order_text.includes('START'));
ok('re-subscribe grants ORDER only, never marketing', calls[0].args.p_marketing, false);
for (const body of ['yes please start sending', 'I want to start again']) {
  r = await post({ From: '+15125550100', Body: body });
  ok(`"${body}" does NOT grant consent`, calls.some((c) => c.fn === 'record_sms_consent'), false);
}

console.log('\n— HELP —');
r = await post({ From: '+15125550100', Body: 'HELP' });
ok('HELP is acknowledged', r.statusCode, 200);
ok('and writes no consent change', calls.length, 0);
okTrue('stays silent unless explicitly configured to reply', !r.body.includes('<Message>'));
process.env.SMS_SEND_HELP_REPLY = '1';
h = fresh().handler;
r = await post({ From: '+15125550100', Body: 'HELP' });
okTrue('when configured, the reply carries STOP and rates',
  r.body.includes('STOP') && r.body.includes('data rates'));
delete process.env.SMS_SEND_HELP_REPLY;
h = fresh().handler;

console.log('\n— 🚨 a database failure must never 500 a STOP —');
require.cache[syncPath].exports = { rpc: async () => { throw new Error('db down'); } };
h = fresh().handler;
r = await post({ From: '+15125550100', Body: 'STOP' });
ok('still acknowledges the provider', r.statusCode, 200);
okTrue('with a valid empty TwiML body', r.body.includes('<Response>'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
