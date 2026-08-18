// Tests _customer-auth.js — session signing, tamper resistance, cookie flags.
// No network, no database.
//
// This is the file that decides who a request belongs to, so the cases below are
// mostly attacks: a forged MAC, a swapped payload, an expired session, a missing
// secret. A pass here is "the forgery was rejected", not "the happy path worked".
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ok = (label, got, want) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${label}` +
    (good ? '' : `  got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
  good ? pass++ : fail++;
};
const okTrue = (l, c) => ok(l, !!c, true);

const fresh = () => {
  delete require.cache[require.resolve('./netlify/functions/_customer-auth')];
  return require('./netlify/functions/_customer-auth');
};

// ── fails closed with no secret ──────────────────────────────────────────────
console.log('\n— 🚨 no secret means no sessions, not weak sessions —');
delete process.env.CUSTOMER_SESSION_SECRET;
let a = fresh();
ok('configured() is false', a.configured(), false);
ok('signSession refuses to mint', a.signSession({ accountId: 'x', email: 'a@b.c' }), null);
ok('verifySession trusts nothing', a.verifySession('anything.atall'), null);

console.log('\n— a too-short secret is also refused —');
process.env.CUSTOMER_SESSION_SECRET = 'short';
a = fresh();
ok('configured() is false for <32 chars', a.configured(), false);

// ── the happy path, then attacks on it ───────────────────────────────────────
process.env.CUSTOMER_SESSION_SECRET = 'x'.repeat(48);
a = fresh();
const ACC = '11111111-2222-3333-4444-555555555555';
const token = a.signSession({ accountId: ACC, email: 'Buyer@Example.COM' });

console.log('\n— a genuine session —');
okTrue('a token is produced', typeof token === 'string' && token.includes('.'));
ok('it verifies', a.verifySession(token).accountId, ACC);
ok('email is normalised to lowercase', a.verifySession(token).email, 'buyer@example.com');

console.log('\n— 🚨 forgery —');
const [body, mac] = token.split('.');
ok('a flipped MAC is rejected', a.verifySession(`${body}.${mac.slice(0, -1)}A`), null);
ok('an empty MAC is rejected', a.verifySession(`${body}.`), null);
ok('no MAC at all is rejected', a.verifySession(body), null);
ok('extra segments are rejected', a.verifySession(`${body}.${mac}.${mac}`), null);
// The payload is readable by design; changing it must invalidate the signature.
const swapped = Buffer.from(JSON.stringify({
  a: '99999999-9999-9999-9999-999999999999', e: 'attacker@evil.com', x: Date.now() + 9e6,
})).toString('base64url');
ok('🚨 swapping the account id is rejected', a.verifySession(`${swapped}.${mac}`), null);
ok('a self-signed payload with no key is rejected', a.verifySession(`${swapped}.${'A'.repeat(43)}`), null);
ok('garbage is rejected', a.verifySession('....'), null);
ok('null/undefined are rejected', [a.verifySession(null), a.verifySession(undefined)], [null, null]);

console.log('\n— a session signed with a DIFFERENT secret must not verify —');
const other = (() => { process.env.CUSTOMER_SESSION_SECRET = 'y'.repeat(48); const b = fresh();
  return b.signSession({ accountId: ACC, email: 'a@b.c' }); })();
process.env.CUSTOMER_SESSION_SECRET = 'x'.repeat(48);
a = fresh();
ok('🚨 cross-secret token rejected', a.verifySession(other), null);

console.log('\n— expiry —');
ok('an already-expired session is rejected',
  a.verifySession(a.signSession({ accountId: ACC, email: 'a@b.c', days: -1 })), null);
okTrue('a fresh one is accepted',
  a.verifySession(a.signSession({ accountId: ACC, email: 'a@b.c', days: 1 })));

console.log('\n— reading the cookie off a request —');
ok('finds our cookie among others',
  a.readSession({ cookie: `other=1; ${a.COOKIE}=${token}; another=2` }).accountId, ACC);
ok('handles the capitalised header', a.readSession({ Cookie: `${a.COOKIE}=${token}` }).accountId, ACC);
ok('no cookie means no session', a.readSession({}), null);
ok('an unrelated cookie means no session', a.readSession({ cookie: 'foo=bar' }), null);
ok('a tampered cookie means no session',
  a.readSession({ cookie: `${a.COOKIE}=${body}.AAAA` }), null);

console.log('\n— 🔑 cookie flags are load-bearing —');
const ck = a.sessionCookie(token);
for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) {
  okTrue(`sets ${flag}`, ck.includes(flag));
}
okTrue('sign-out expires the cookie immediately', a.clearCookie().includes('Max-Age=0'));
okTrue('sign-out keeps HttpOnly + Secure', /HttpOnly/.test(a.clearCookie()) && /Secure/.test(a.clearCookie()));

console.log('\n— login tokens —');
const t1 = a.newLoginToken(), t2 = a.newLoginToken();
okTrue('the raw token is long enough to be unguessable', t1.raw.length >= 40);
okTrue('two tokens differ', t1.raw !== t2.raw);
ok('the hash matches the raw value', a.hashToken(t1.raw), t1.hash);
okTrue('the hash is sha256 hex', /^[0-9a-f]{64}$/.test(t1.hash));
okTrue('🚨 the raw token is NOT recoverable from the hash', !t1.hash.includes(t1.raw));
ok('a different token hashes differently', a.hashToken(t2.raw) === t1.hash, false);

console.log('\n— constant-time compare —');
ok('equal strings match', a.safeEqual('abc', 'abc'), true);
ok('different strings do not', a.safeEqual('abc', 'abd'), false);
ok('different LENGTHS do not throw', a.safeEqual('abc', 'abcdef'), false);
ok('empty vs non-empty', a.safeEqual('', 'a'), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
