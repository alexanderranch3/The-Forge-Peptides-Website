// Shared helper (NOT an endpoint). Builds every customer-facing text message.
//
// Mirrors _invoice.js on purpose: one module renders a message, and BOTH the
// automatic send and a manual re-send call it, so the wording cannot drift
// between "the text the system sent" and "the text Frank sent". It consumes the
// SAME invoiceModel() output as the invoice, so a text and an invoice can never
// disagree about a total.
//
// 🚨 NO PRODUCT NAMES IN A TEXT. EVER. This is the rule the whole file exists to
// enforce, and it is not squeamishness -- it is what keeps the 10DLC campaign
// alive. Twilio error 30941 rejects "direct-to-consumer pharmaceutical
// promotion", and our catalog includes Tesamorelin (an FDA-approved drug, sold as
// Egrifta) and Retatrutide (an investigational Lilly compound). A reviewer or an
// automated filter that sees those names in carrier traffic can classify this
// whole brand as pharma marketing, and 🚨 A REJECTED CAMPAIGN CANNOT BE
// RESUBMITTED under the same use case. So a receipt says order number, item
// count, total and a link. The itemisation already exists, properly, in the
// invoice at the other end of that link.
//
// This also settles compliance for free: with no product named, there is nothing
// to attach a dose, a protocol, or a therapeutic claim to. Research-use-only is
// satisfied by omission rather than by disclaimer.
//
// 🔑 EVERY MESSAGE IS GATED ON A RECORDED CONSENT. Nothing here sends; callers
// must pass mayText() before handing a message to a provider. A message built
// for a number with no consent record is a compliance incident, not a nudge.
//
// 🔑 ONE STRAY CHARACTER CAN TRIPLE THE COST. GSM-7 gives 160 characters per
// segment; a single character outside it (an em dash, a curly quote, an accent,
// an emoji) switches the WHOLE message to UCS-2 and the limit collapses to 70.
// A 150-character message that reads fine becomes three billed segments because
// someone typed "—". Hence gsmSafe()/segments(), and hence the deliberately
// plain punctuation in every template below.

// ZELLE_TAG comes from _invoice.js rather than being redeclared here: a text and
// an invoice quoting different Zelle handles is exactly the class of bug that two
// copies of nameToId already caused once.
const { money, ZELLE_TAG } = require('./_invoice');
const { mayText } = require('./_sms-consent');

const BRAND = 'The Forge Peptides';

// The GSM-7 basic set plus its extension characters. Anything outside this
// forces UCS-2 encoding for the entire message.
const GSM7 = new Set(
  ('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?'
  + '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'
  + '^{}\\[~]|€').split('')
);

/** Characters in `text` that would force UCS-2. Empty array means GSM-7 safe. */
function nonGsmChars(text) {
  const bad = new Set();
  for (const ch of String(text)) if (!GSM7.has(ch)) bad.add(ch);
  return [...bad];
}

function gsmSafe(text) {
  return nonGsmChars(text).length === 0;
}

/**
 * Billed segments for a message. Concatenated messages carry a 6-byte header,
 * which is why the per-segment budget DROPS once you cross into a second
 * segment (153 not 160, 67 not 70) -- a 161-character message costs two
 * segments and leaves only 145 usable.
 */
function segments(text) {
  const s = String(text);
  const ucs2 = !gsmSafe(s);
  const single = ucs2 ? 70 : 160;
  const multi = ucs2 ? 67 : 153;
  const len = ucs2 ? [...s].length : s.length;
  return {
    encoding: ucs2 ? 'UCS-2' : 'GSM-7',
    length: len,
    segments: len <= single ? 1 : Math.ceil(len / multi),
    offenders: ucs2 ? nonGsmChars(s) : [],
  };
}

// Appended only to the FIRST message we ever send a number. Carriers want the
// brand and an opt-out visible at first contact; repeating it on every message
// afterwards just spends characters. HELP lives in the auto-reply, not here.
const OPT_OUT = ' Reply STOP to opt out.';

/**
 * Normalise what a message is allowed to know. Note what is NOT here: no item
 * names. `itemCount` deliberately replaces the itemisation.
 *
 * 🔑 AND NO INVOICE LINK. There is no hosted invoice page -- invoiceHtml() is
 * only ever delivered as email -- so a link would be dead on arrival. It is also
 * not a quick thing to add: order numbers are guessable (FP- plus a short
 * timestamp slice), so a page keyed on the order number alone would let anyone
 * enumerate other people's names, addresses and purchases. A real one needs an
 * unguessable per-order token or a signed-in account. Until then the text points
 * at the email, which already contains the full itemisation.
 */
function smsModel(m) {
  return {
    number: m.number,
    total: money(m.total_cents),
    itemCount: (m.items || []).reduce((n, i) => n + Number(i.qty || 0), 0),
    paid: !!m.paid,
    isPickup: !!m.isPickup,
  };
}

const vials = (n) => `${n} item${n === 1 ? '' : 's'}`;

/** Order placed. Wording splits on paid vs awaiting-Zelle. */
function receiptSms(s, { first = true } = {}) {
  const body = s.paid
    ? `${BRAND}: order ${s.number} confirmed and paid, ${vials(s.itemCount)}, ${s.total}. `
      + `Full receipt emailed.`
    : `${BRAND}: order ${s.number}, ${vials(s.itemCount)}, ${s.total}. `
      + `Pay by Zelle to ${ZELLE_TAG}, memo ${s.number}. Full receipt emailed.`;
  return body + (first ? OPT_OUT : '');
}

/** Payment still outstanding. Never scolding, always actionable. */
function paymentNudgeSms(s, { first = false } = {}) {
  const body = `${BRAND}: order ${s.number} (${s.total}) is still awaiting payment. `
    + `Zelle ${ZELLE_TAG}, memo ${s.number}.`;
  return body + (first ? OPT_OUT : '');
}

/** Shipped, or ready for pickup. Tracking is optional. */
function shippedSms(s, { tracking = null, carrier = null, first = false } = {}) {
  let body;
  if (s.isPickup) {
    body = `${BRAND}: order ${s.number} is ready for pickup.`;
  } else if (tracking) {
    body = `${BRAND}: order ${s.number} has shipped`
      + (carrier ? ` via ${carrier}` : '') + `. Tracking: ${tracking}`;
  } else {
    body = `${BRAND}: order ${s.number} has shipped.`;
  }
  return body + (first ? OPT_OUT : '');
}

const TEMPLATES = {
  receipt:       { kind: 'order', render: receiptSms },
  payment_nudge: { kind: 'order', render: paymentNudgeSms },
  shipped:       { kind: 'order', render: shippedSms },
};

/**
 * Build a message, or refuse and say why. Returns
 * { ok, text, segments, reason } -- callers must check ok, never send on false.
 *
 * The consent check lives HERE rather than in the sender so that every future
 * surface (a POS button, a scheduled reminder, a bulk tool) inherits it. A gate
 * you have to remember to call is a gate that gets forgotten.
 */
function buildMessage(name, { model, consent, options = {} }) {
  const t = TEMPLATES[name];
  if (!t) return { ok: false, reason: `unknown template: ${name}` };
  if (!mayText(consent, t.kind)) {
    return { ok: false, reason: `no recorded ${t.kind} consent for this number` };
  }
  const text = t.render(smsModel(model), options);
  return { ok: true, text, segments: segments(text) };
}

module.exports = {
  BRAND, ZELLE_TAG, OPT_OUT, TEMPLATES,
  smsModel, receiptSms, paymentNudgeSms, shippedSms,
  buildMessage, segments, gsmSafe, nonGsmChars,
};
