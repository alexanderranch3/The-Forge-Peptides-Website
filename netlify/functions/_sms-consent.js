// Shared helper (NOT an endpoint). The canonical record of what a customer was
// shown when they agreed to be texted, and what they agreed to.
//
// WHY THIS FILE EXISTS, AND WHY IT SHIPS BEFORE ANY PROVIDER IS CHOSEN
// Consent is the part that cannot be added later. A number collected today with
// no consent record is not textable tomorrow -- there is no backfill, because
// what is missing is a moment in time that has passed. Nothing here knows or
// cares whether we end up on Twilio, Telnyx or anyone else.
//
// 🔑 THE EXACT WORDING IS THE EVIDENCE, AND IT LIVES ON THE SERVER. The page
// sends a version string, never the text. If the client sent the wording, a
// forged POST could claim the customer agreed to something they never saw, and
// the record would be worthless precisely when it matters. Old versions are kept
// forever: a consent given under one version must always be readable as that
// version's wording, even after the wording changes.
//
// 🔑 WHY THE WORDING IS SHORT, AND WHY IT IS SAFE TO SHORTEN. The opt-in text is
// read twice: once by the customer, and once by a 10DLC campaign reviewer who may
// ask for a screenshot of it. So it keeps what a reviewer looks for -- purpose,
// rates, STOP, and that it is not required to buy -- and moves the rest to the
// linked SMS Terms and to the messages themselves, where HELP and the full
// disclosure naturally repeat. If a reviewer wants more, add a NEW version: every
// consent already given keeps the text it was actually given under.
//
// 🔑 TRANSACTIONAL AND MARKETING ARE SEPARATE CONSENTS, NEVER ONE CHECKBOX.
// A receipt for something you bought and an advert for something you did not are
// different asks with different legal footing, and bundling them means the weaker
// claim contaminates the stronger one.
//
// 🚨 NEITHER IS EVER A CONDITION OF PURCHASE. Both default to unchecked, the
// order completes identically without them, and the wording says so out loud.
//
// 🚨 COMPLIANCE. Products are research-use-only. Consent wording describes
// MESSAGE TYPES ONLY -- receipts, shipping, payment reminders, offers. It never
// describes a product, a use, or an outcome.

// Bump this when the wording changes. Never edit a released version's text --
// add a new one, or you rewrite history for everyone who already agreed.
const CURRENT_VERSION = '2026-08-18.1';

const SMS_TERMS_URL = 'https://theforgepeptides.com/sms-terms.html';

const VERSIONS = {
  '2026-08-18.1': {
    effective: '2026-08-18',
    terms_url: SMS_TERMS_URL,
    // Transactional: messages about an order the customer actually placed.
    // Frequency is omitted on purpose -- it is driven by their own orders.
    order: {
      label: 'Text me about my order',
      fine: 'Receipts, shipping, and payment reminders. Msg & data rates may apply. '
          + 'Reply STOP to opt out. Not required to buy.',
    },
    // Marketing: anything we send because we want to, not because they bought.
    // Frequency IS disclosed here -- it is recurring and not tied to an order.
    marketing: {
      label: 'Text me deals and new products',
      fine: 'A few messages a month. Msg & data rates may apply. '
          + 'Reply STOP to opt out. Not required to buy.',
    },
  },
};

function version(v) {
  return VERSIONS[v] ? VERSIONS[v] : VERSIONS[CURRENT_VERSION];
}

/** The wording as one string -- what gets frozen into the record. */
function consentText(kind, v) {
  const spec = version(v)[kind];
  return spec ? `${spec.label}. ${spec.fine}` : '';
}

/** The two parts, for rendering the checkbox. */
function consentParts(kind, v) {
  const ver = version(v);
  return { ...(ver[kind] || { label: '', fine: '' }), terms_url: ver.terms_url };
}

/**
 * Build the record to persist alongside the customer.
 *
 * Returns null for a kind that was NOT agreed to, rather than a `false` row:
 * an absent consent and a refused one are the same thing operationally (do not
 * text), and storing a timestamp against a refusal invites misreading it later
 * as "consented at".
 */
function consentRecord({ order, marketing, version: v, at, source }) {
  const ver = VERSIONS[v] ? v : CURRENT_VERSION;
  const when = at || new Date().toISOString();
  const src = source || 'checkout';

  const one = (kind, agreed) => (agreed === true ? {
    kind,
    agreed_at: when,
    version: ver,
    source: src,
    // Stored verbatim so the record is readable without this file, years later.
    text_shown: consentText(kind, ver),
  } : null);

  return {
    version: ver,
    order: one('order', order),
    marketing: one('marketing', marketing),
  };
}

/** Would we be allowed to send this kind of message to this record? */
function mayText(record, kind) {
  return !!(record && record[kind] && record[kind].agreed_at);
}

module.exports = {
  CURRENT_VERSION, SMS_TERMS_URL, VERSIONS,
  consentText, consentParts, consentRecord, mayText,
};
