// Tests _sms.js and _sms-consent.js. No network, nothing sent.
//
// The centrepiece is "no product name ever reaches a text": the fixture order
// deliberately contains Retatrutide and Tesamorelin -- the two names most likely
// to get a 10DLC campaign rejected as pharmaceutical marketing -- and every
// template output is asserted not to contain them. A rejected campaign cannot be
// resubmitted, so this rule needs a test, not a comment.
import { createRequire } from 'module';
import { readFileSync } from 'fs';
const require = createRequire(import.meta.url);
const { invoiceModel } = require('./netlify/functions/_invoice');
const sms = require('./netlify/functions/_sms');
const consent = require('./netlify/functions/_sms-consent');

let pass = 0, fail = 0;
const ok = (label, got, want) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${label}` +
    (good ? '' : `  got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
  good ? pass++ : fail++;
};
const okTrue = (label, cond) => ok(label, !!cond, true);

// ── fixtures ─────────────────────────────────────────────────────────────────
const order = (over = {}) => ({
  reference_id: 'FP-204519',
  created_at: '2026-08-18T15:00:00Z',
  line_items: [
    { name: 'Retatrutide 10mg', quantity: '2',
      base_price_money: { amount: 16000 }, gross_sales_money: { amount: 32000 } },
    { name: 'Tesamorelin 10mg', quantity: '1',
      base_price_money: { amount: 8900 }, gross_sales_money: { amount: 8900 } },
  ],
  total_money: { amount: 44175 },
  total_tax_money: { amount: 3275 },
  metadata: { forge_order_number: 'FP-204519' },
  ...over,
});
const cust = { name: 'A Buyer', email: 'a@example.com', phone: '+15125550101' };

const GRANTED = consent.consentRecord({ order: true, marketing: false, version: consent.CURRENT_VERSION });
const NONE    = consent.consentRecord({ order: false, marketing: false, version: consent.CURRENT_VERSION });

const model = invoiceModel({ order: order(), customer: cust, address: null });
const s = sms.smsModel(model);

// ── the rule that matters most ───────────────────────────────────────────────
console.log('\n— 🚨 no product name may ever reach a text —');
const BANNED = ['Retatrutide', 'retatrutide', 'Tesamorelin', 'tesamorelin', '10mg'];
const everyMessage = [
  sms.receiptSms(s, { first: true }),
  sms.receiptSms({ ...s, paid: true }, { first: false }),
  sms.paymentNudgeSms(s, {}),
  sms.shippedSms(s, { tracking: '9400100000000000000000', carrier: 'USPS' }),
  sms.shippedSms(s, {}),
  sms.shippedSms({ ...s, isPickup: true }, {}),
];
everyMessage.forEach((text, i) => {
  const hit = BANNED.find((b) => text.includes(b));
  ok(`message ${i + 1} carries no product name`, hit || null, null);
});
okTrue('smsModel exposes no item names at all',
  !JSON.stringify(s).match(/retatrutide|tesamorelin/i));
ok('itemisation replaced by a count', s.itemCount, 3);

// ── totals come from the invoice, not from separate arithmetic ────────────────
console.log('\n— one source of truth for money —');
ok('sms total equals invoice total', s.total, '$441.75');
okTrue('receipt quotes that same total', sms.receiptSms(s, {}).includes('$441.75'));

// ── consent gate ─────────────────────────────────────────────────────────────
console.log('\n— nothing is sendable without a recorded consent —');
ok('refuses with no consent',
  sms.buildMessage('receipt', { model, consent: NONE }).ok, false);
ok('says why', sms.buildMessage('receipt', { model, consent: NONE }).reason,
  'no recorded order consent for this number');
ok('allows with order consent',
  sms.buildMessage('receipt', { model, consent: GRANTED }).ok, true);
ok('unknown template refuses',
  sms.buildMessage('nope', { model, consent: GRANTED }).ok, false);
okTrue('order consent does NOT imply marketing consent',
  consent.mayText(GRANTED, 'order') && !consent.mayText(GRANTED, 'marketing'));

// ── consent record shape ─────────────────────────────────────────────────────
console.log('\n— the consent record is the evidence —');
ok('a refusal stores null, not false', NONE.order, null);
okTrue('a grant freezes the wording shown', GRANTED.order.text_shown.includes('Msg & data rates may apply'));
okTrue('a grant records when', !!Date.parse(GRANTED.order.agreed_at));
ok('a grant records the version', GRANTED.order.version, consent.CURRENT_VERSION);
ok('unknown version falls back to current',
  consent.consentRecord({ order: true, version: 'nope' }).version, consent.CURRENT_VERSION);
okTrue('wording states it is not required to buy',
  consent.consentText('order', consent.CURRENT_VERSION).includes('Not required to buy'));
okTrue('wording carries STOP', consent.consentText('order').includes('STOP'));
okTrue('marketing wording discloses frequency',
  consent.consentText('marketing').includes('month'));
okTrue('consentParts gives label, fine print and a terms link', (() => {
  const p = consent.consentParts('order');
  return p.label && p.fine && p.terms_url;
})());

// ── encoding: one stray character triples the bill ───────────────────────────
console.log('\n— GSM-7 vs UCS-2 —');
ok('plain ASCII is GSM-7', sms.segments('Order FP-1 shipped.').encoding, 'GSM-7');
ok('an em dash forces UCS-2', sms.segments('Order FP-1 — shipped.').encoding, 'UCS-2');
ok('and names the offender', sms.segments('Order FP-1 — shipped.').offenders, ['—']);
ok('a curly quote forces UCS-2', sms.segments("Order FP-1’s update").encoding, 'UCS-2');
ok('160 GSM-7 chars is one segment', sms.segments('a'.repeat(160)).segments, 1);
ok('161 GSM-7 chars is two', sms.segments('a'.repeat(161)).segments, 2);
ok('70 UCS-2 chars is one segment', sms.segments('—' + 'a'.repeat(69)).segments, 1);
ok('71 UCS-2 chars is two', sms.segments('—' + 'a'.repeat(70)).segments, 2);
everyMessage.forEach((text, i) => {
  const seg = sms.segments(text);
  ok(`message ${i + 1} stays GSM-7`, seg.encoding, 'GSM-7');
});

// The happy fixture is not the test that matters. The first-contact receipt is
// the longest message we send, and it once landed on EXACTLY 160 characters --
// one more item ("10 items" vs "3 items") or a four-figure total would have
// silently doubled the bill on the most-sent message. Pin the worst realistic
// case instead: a long order number, a two-digit item count, a big total.
console.log('\n— the longest message we can actually send stays 1 segment —');
const WORST = sms.smsModel({
  number: 'FP-999999', total_cents: 999999, items: [{ qty: 99 }], paid: false, isPickup: false,
});
const worstText = sms.receiptSms(WORST, { first: true });
ok('worst-case first receipt is 1 segment', sms.segments(worstText).segments, 1);
okTrue('and has real headroom left', sms.segments(worstText).length <= 152);

// ── template wording ─────────────────────────────────────────────────────────
console.log('\n— wording per situation —');
okTrue('unpaid receipt gives Zelle instructions', sms.receiptSms(s, {}).includes('Zelle'));
okTrue('unpaid receipt repeats the order no as the memo',
  sms.receiptSms(s, {}).includes('memo FP-204519'));
okTrue('paid receipt does NOT ask for payment',
  !sms.receiptSms({ ...s, paid: true }, {}).includes('Zelle'));
okTrue('first message carries the opt-out', sms.receiptSms(s, { first: true }).includes('STOP'));
okTrue('later messages do not spend characters on it',
  !sms.receiptSms(s, { first: false }).includes('STOP'));
okTrue('every message identifies the brand',
  everyMessage.every((t) => t.startsWith('The Forge Peptides:')));
okTrue('pickup wording says pickup, not shipped',
  sms.shippedSms({ ...s, isPickup: true }, {}).includes('ready for pickup'));
okTrue('tracking is included when known',
  sms.shippedSms(s, { tracking: '94001', carrier: 'USPS' }).includes('94001'));
okTrue('no tracking still sends something useful',
  sms.shippedSms(s, {}).includes('has shipped'));
okTrue('nudge is actionable, not scolding', (() => {
  const t = sms.paymentNudgeSms(s, {});
  return t.includes('awaiting payment') && !/fail|overdue|late/i.test(t);
})());

// ── drift gate ───────────────────────────────────────────────────────────────
// index.html hard-codes the consent version it renders, because a static page
// cannot require this module. That is the same two-copies-of-one-fact setup that
// let nameToId drift, so it gets the same treatment check-prices.js gives money:
// one file is the truth and the other is verified against it. If the wording is
// updated here without updating the page, the record would claim a customer saw
// text they never saw -- so this failing is a real defect, not a chore.
console.log('\n— index.html renders the version it claims —');
const page = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const declared = (page.match(/smsConsentVersion:\s*'([^']+)'/) || [])[1];
ok('index.html declares a consent version', !!declared, true);
ok('and it matches _sms-consent.js', declared, consent.CURRENT_VERSION);
// The visible copy must also match the versioned fine print, or the screenshot a
// 10DLC reviewer sees will not be the text we have on record.
for (const kind of ['order', 'marketing']) {
  const parts = consent.consentParts(kind, consent.CURRENT_VERSION);
  okTrue(`page shows the ${kind} label`, page.includes(parts.label));
  okTrue(`page shows the ${kind} fine print`,
    page.includes(parts.fine.replace(/&/g, '&amp;')));
}
okTrue('both boxes default to unchecked', !/id="forge-sms-(order|marketing)"[^>]*\bchecked\b/.test(page));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
