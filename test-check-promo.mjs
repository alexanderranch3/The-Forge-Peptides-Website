// Tests check-promo.js — what the checkout page is told a code is worth.
// No network. Run with `node test-check-promo.mjs`.
//
// 🚨 WHY IT EXISTS: index.html validated codes against a hardcoded list, which
// cannot hold a PRIVATE code because this repository is public. The owner's own
// code was reported "Invalid" for exactly that reason.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
let pass = 0, fail = 0;
const ok = (l, g, w) => { const good = JSON.stringify(g) === JSON.stringify(w);
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${l}${good ? '' : `  got ${JSON.stringify(g)}, want ${JSON.stringify(w)}`}`);
  good ? pass++ : fail++; };
const okTrue = (l, c) => ok(l, !!c, true);

const fn = require('./netlify/functions/check-promo.js');
const ask = async (code) => JSON.parse((await fn.handler({ httpMethod: 'POST', body: JSON.stringify({ code }) })).body);

console.log('\n— the public codes —');
ok('FORGE10', (await ask('FORGE10')).percent, 10);
ok('LOYAL10', (await ask('LOYAL10')).percent, 10);
ok('lower case still works', (await ask('forge10')).percent, 10);
ok('an unknown code', await ask('NOPE'), { valid: false, percent: 0 });
ok('an empty code',   await ask(''),     { valid: false, percent: 0 });

console.log('\n— 🚨 with no OWNER_PROMO_CODE set, there is no owner code —');
// ⚠️ Fails CLOSED. An unset variable must never mean "anything matches", which
// an empty-string comparison would.
delete process.env.OWNER_PROMO_CODE;
ok('a blank code is not the owner code', (await ask('')).valid, false);
ok('nor is any other string',            (await ask('whatever')).valid, false);

console.log('\n— with one set —');
process.env.OWNER_PROMO_CODE = 'MixedCase9';
ok('exact',            (await ask('MixedCase9')).percent, 100);
// 🚨 The bug this fixes: the checkout box UPPER-CASES what is typed, so a
// mixed-case code never reached the server in its original form.
ok('🚨 upper-cased, as the checkout box sends it', (await ask('MIXEDCASE9')).percent, 100);
ok('lower-cased too',  (await ask('mixedcase9')).percent, 100);
ok('surrounding spaces trimmed', (await ask('  MixedCase9  ')).percent, 100);
ok('one character off is nothing', (await ask('MixedCase')).valid, false);
okTrue('and it says what it is', /100%/.test((await ask('MixedCase9')).label || ''));

console.log('\n— it gives nothing away —');
const miss = await ask('GUESS1');
ok('a miss reveals no codes', Object.keys(miss).sort(), ['percent', 'valid']);

console.log('\n— refusals —');
ok('GET is not allowed', (await fn.handler({ httpMethod: 'GET' })).statusCode, 405);
ok('malformed json is not a crash',
  (await fn.handler({ httpMethod: 'POST', body: '{oops' })).statusCode, 200);
delete process.env.OWNER_PROMO_CODE;

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
