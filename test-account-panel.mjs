// Tests the customer account panel by running the real functions out of
// index.html — the same trick test-watchdog-ui.mjs uses on admin.html.
//
// Added 2026-08-20. loadAccount() had always fetched the customer's orders and
// saved details and thrown both away; renderAccountNav() used only the email.
// This is the code that finally shows them, and what it shows is a customer's
// own money, so the properties below are mostly about not lying to them:
// never call an unpaid order paid, never report a failed save as saved, and
// never let a product name become markup.
//
// 🔑 No jsdom, no package.json, no install — the shim is the smallest thing the
// panel actually touches, and assertions read innerHTML rather than querying
// nodes, so nothing needs a real HTML parser.
import { readFileSync } from 'fs';

let pass = 0, fail = 0;
const ok = (l, c, d = '') => { c ? (pass++, console.log(`  PASS  ${l}`)) : (fail++, console.log(`  FAIL  ${l}${d ? '  — ' + d : ''}`)); };

// ── the shim ────────────────────────────────────────────────────────────────
const nodes = {};
const el = (id) => {
  if (!nodes[id]) nodes[id] = { id, textContent: '', innerHTML: '', value: '', style: {}, disabled: false };
  return nodes[id];
};

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const src = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
const slice = src.slice(src.indexOf('// ── The account panel'), src.indexOf('// Esc closes the panel'));
if (!slice) { console.error('Could not find the account panel in index.html'); process.exit(1); }

let fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true }) });
const WANT = ['escAcct', 'acctMoney', 'acctDate', 'acctQty', 'openAccount', 'closeAccount',
              'fillAccountForm', 'renderAccountOrders', 'accountOrderCard', 'saveAccountDetails'];
let openedSignIn = 0;
const ctx = new Function('document', 'fetch', 'openSignIn', `
  let forgeAccount = null;
  ${slice}
  return { ${WANT.join(', ')},
           setAccount: (a) => { forgeAccount = a; },
           getAccount: () => forgeAccount };
`)(
  { getElementById: el, addEventListener: () => {} },
  (...a) => fetchImpl(...a),
  () => { openedSignIn++; },
);

const ordersHtml = () => el('account-orders').innerHTML;
const order = (o = {}) => ({
  order_no: 'FP-000001', placed_at: '2026-08-10T15:00:00Z', state: 'COMPLETED',
  payment_state: 'PAID', item_count: '1.000', total_cents: 16650, tracking_number: null,
  items: [{ kind: 'PRODUCT', name: 'Retatrutide 10mg', qty: 2 }], ...o,
});

// ── 1. money and quantities read the way a receipt reads ────────────────────
console.log('\n1. the numbers');
ok('cents become dollars',          ctx.acctMoney(16650) === '$166.50', ctx.acctMoney(16650));
ok('thousands get a comma',         ctx.acctMoney(1431705) === '$14,317.05', ctx.acctMoney(1431705));
ok('zero is a real amount, not blank', ctx.acctMoney(0) === '$0.00', ctx.acctMoney(0));
ok('a missing total does not print NaN', ctx.acctMoney(undefined) === '$0.00', ctx.acctMoney(undefined));
ok('"2.000" from the database shows as 2', ctx.acctQty('2.000') === '2', ctx.acctQty('2.000'));
ok('a date renders',                /2026/.test(ctx.acctDate('2026-08-10T15:00:00Z')));
ok('a broken date renders as nothing, not "Invalid Date"',
   ctx.acctDate('not a date') === '', JSON.stringify(ctx.acctDate('not a date')));

// ── 2. a product name can never become markup ───────────────────────────────
console.log('\n2. a name is text, never markup');
ctx.setAccount({ signedIn: true, email: 'a@b.com', orders: [
  order({ items: [{ kind: 'PRODUCT', name: '<img src=x onerror=alert(1)>', qty: 1 }] }),
] });
ctx.renderAccountOrders();
ok('🚨 an injected tag is escaped', !/<img/.test(ordersHtml()), ordersHtml().slice(0, 160));
ok('   and its text still shows',   /&lt;img/.test(ordersHtml()));

// ── 3. what the customer bought is what is shown ────────────────────────────
console.log('\n3. the lines are the point of the panel');
ctx.setAccount({ signedIn: true, email: 'a@b.com', orders: [order()] });
ctx.renderAccountOrders();
ok('the product is named',            /Retatrutide 10mg/.test(ordersHtml()));
ok('the quantity is shown',           /&times;2/.test(ordersHtml()));
ok('the order number is shown',       /FP-000001/.test(ordersHtml()));
ok('the total is shown',              /\$166\.50/.test(ordersHtml()));
ok('no tracking line when there is no tracking', !/Tracking/.test(ordersHtml()));

// ── 4. an order is never shown with a total and no lines ────────────────────
console.log('\n4. nothing is silently blank');
ctx.setAccount({ signedIn: true, email: 'a@b.com', orders: [order({ items: [], item_count: '3.000' })] });
ctx.renderAccountOrders();
ok('🚨 an order with no lines falls back to the count', /3 item\(s\)/.test(ordersHtml()), ordersHtml());
ctx.setAccount({ signedIn: true, email: 'a@b.com', orders: [] });
ctx.renderAccountOrders();
ok('no orders says so in words',      /No orders on this account yet/.test(ordersHtml()));
ok('   and is not an empty box',      ordersHtml().trim().length > 0);

// ── 5. a non-product line still appears, without a quantity ─────────────────
console.log('\n5. shipping and balance-due lines');
ctx.setAccount({ signedIn: true, email: 'a@b.com', orders: [order({
  items: [{ kind: 'PRODUCT', name: 'Glow Blend', qty: 1 },
          { kind: 'SHIPPING', name: 'Shipping', qty: 1 },
          { kind: 'BALANCE_DUE', name: 'Balance Due', qty: 1 }] })] });
ctx.renderAccountOrders();
ok('the shipping line shows',     /Shipping/.test(ordersHtml()));
ok('the balance-due line shows',  /Balance Due/.test(ordersHtml()));
// Exactly one × in the card: the product got one, the two charge lines did not.
// A "Shipping ×1" line reads as a quantity of shipments.
ok('only the product line carries a × quantity',
   (ordersHtml().match(/&times;/g) || []).length === 1,
   `${(ordersHtml().match(/&times;/g) || []).length} found`);

// ── 6. the status is the one the books hold ─────────────────────────────────
console.log('\n6. an unpaid order is never called paid');
ctx.setAccount({ signedIn: true, email: 'a@b.com', orders: [order({ payment_state: 'AWAITING_PAYMENT' })] });
ctx.renderAccountOrders();
ok('🚨 AWAITING_PAYMENT says awaiting payment', /Awaiting payment/.test(ordersHtml()));
ok('🚨 and does NOT say paid',                  !/>Paid</.test(ordersHtml()), ordersHtml());
ctx.setAccount({ signedIn: true, email: 'a@b.com', orders: [order({ payment_state: 'PAID' })] });
ctx.renderAccountOrders();
ok('PAID says paid',                            />Paid</.test(ordersHtml()));

// ── 7. tracking, when there is some ─────────────────────────────────────────
console.log('\n7. tracking');
ctx.setAccount({ signedIn: true, email: 'a@b.com', orders: [order({ tracking_number: '9400111899223' })] });
ctx.renderAccountOrders();
ok('the tracking number is shown', /9400111899223/.test(ordersHtml()));

// ── 8. the form is filled from the account, and saved back ──────────────────
console.log('\n8. details in, details out');
ctx.setAccount({ signedIn: true, email: 'a@b.com', orders: [],
  details: { fullName: 'Frank Alexander', phone: '305-555-0100', line1: '341 SW 136 Ave',
             line2: '', city: 'Miami', state: 'FL', postal: '33184' } });
ctx.fillAccountForm();
ok('the name is filled',   el('acct-name').value === 'Frank Alexander', el('acct-name').value);
ok('the address is filled', el('acct-line1').value === '341 SW 136 Ave');
ok('a blank field is blank, not "undefined"', el('acct-line2').value === '',
   JSON.stringify(el('acct-line2').value));

let sent = null;
fetchImpl = async (_url, opts) => { sent = JSON.parse(opts.body); return { ok: true, json: async () => ({ ok: true }) }; };
el('acct-state').value = 'fl';
el('acct-zip').value = ' 33184 ';
await ctx.saveAccountDetails();
ok('the state is upper-cased',  sent.state === 'FL', sent && sent.state);
ok('whitespace is trimmed',     sent.postal === '33184', sent && JSON.stringify(sent.postal));
ok('it reports success',        /Saved/.test(el('acct-save-note').textContent), el('acct-save-note').textContent);
ok('the button is usable again', el('acct-save').disabled === false);

// ── 9. a failed save must never look like a saved one ───────────────────────
console.log('\n9. a save that did not save');
fetchImpl = async () => ({ ok: false, json: async () => ({ error: 'nope' }) });
await ctx.saveAccountDetails();
ok('🚨 a server error is reported as a failure', /didn't save/.test(el('acct-save-note').textContent),
   el('acct-save-note').textContent);
ok('🚨 and never as saved',                      !/Saved/.test(el('acct-save-note').textContent));

fetchImpl = async () => { throw new Error('offline'); };
await ctx.saveAccountDetails();
ok('🚨 a dropped connection is reported too', /didn't save/.test(el('acct-save-note').textContent));
ok('   and the button is not left disabled',  el('acct-save').disabled === false);

// A 200 that says ok:false is still a failure — save_customer_details returns
// false when it writes nothing.
fetchImpl = async () => ({ ok: true, json: async () => ({ ok: false }) });
await ctx.saveAccountDetails();
ok('🚨 a 200 carrying ok:false is a failure', /didn't save/.test(el('acct-save-note').textContent),
   el('acct-save-note').textContent);

// ── 10. signed out, the panel never opens ───────────────────────────────────
console.log('\n10. signed out');
ctx.setAccount(null);
openedSignIn = 0;
ctx.openAccount();
ok('🚨 the panel does not open',        el('forge-account-modal').style.display !== 'flex',
   String(el('forge-account-modal').style.display));
ok('   it offers sign-in instead',      openedSignIn === 1);
ctx.setAccount({ signedIn: true, email: 'a@b.com', orders: [order()], details: {} });
ctx.openAccount();
ok('signed in, it opens',               el('forge-account-modal').style.display === 'flex');
ok('   and shows whose account it is',  el('account-email').textContent === 'a@b.com');
ctx.closeAccount();
ok('and it closes',                     el('forge-account-modal').style.display === 'none');

// ── 11. the page still wires itself up ──────────────────────────────────────
console.log('\n11. the page is wired to all this');
ok('the nav opens the account when signed in', /link\.onclick = openAccount/.test(src));
ok('the nav still offers sign-in when not',    /link\.onclick = openSignIn/.test(src));
ok('signing out closes the panel',             /closeAccount\(\);\s*\n\s*renderAccountNav\(\)/.test(src));
ok('Esc closes it',                            /if \(e\.key !== 'Escape'\) return;/.test(src));
ok('the backdrop closes it',                   /if\(event\.target===this\)closeAccount\(\)/.test(html));
ok('🚨 the panel width is clamped in vw',      /width:min\(620px,94vw\)/.test(html));
ok('every field the form writes exists in the markup',
   ['acct-name','acct-phone','acct-line1','acct-line2','acct-city','acct-state','acct-zip','acct-save','acct-save-note']
     .every((id) => html.includes(`id="${id}"`)));


// ── 12. the signup popup must not land on top of any of this ────────────────
// Found by opening the panel: the "10% off your FIRST order" popup fires on a
// 5s timer at z-index 9998 — above the account panel AND above the checkout
// modal (9995). Its timing cannot be raced in a real browser, so the real IIFE
// is run here against a clock this test controls.
console.log('\n12. the signup popup waits its turn');
const popupSrc = src.slice(src.indexOf('// Email signup popup logic'),
                           src.indexOf('function closeSignupPopup'));
if (!popupSrc) { console.error('Could not find the signup popup logic'); process.exit(1); }

function mkPopup({ seen = false } = {}) {
  const own = {};
  const own_el = (id) => (own[id] ||= { id, style: { display: 'none' } });
  const store = seen ? { forge_popup_seen: '1' } : {};
  const timers = [];
  const ctxP = new Function('document', 'localStorage', 'setTimeout', `
    let forgeAccount = null;
    ${popupSrc}
    return { setAccount: (a) => { forgeAccount = a; } };
  `)(
    { getElementById: own_el },
    { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  );
  return {
    ...ctxP,
    el: own_el,
    timers,
    shown: () => own_el('signup-popup').style.display === 'flex',
    fireNext() { const t = timers.shift(); if (!t) return false; t.fn(); return true; },
  };
}

// A. a signed-in customer is not a new customer
let pop = mkPopup();
pop.setAccount({ signedIn: true, email: 'a@b.com' });
ok('a timer is armed on load', pop.timers.length === 1);
pop.fireNext();
ok('🚨 signed in, the new-customer offer never shows', !pop.shown());
ok('   and it does not keep re-arming forever', pop.timers.length === 0);

// B. a modal is open — defer, never cancel
pop = mkPopup();
pop.el('forge-account-modal').style.display = 'flex';
pop.fireNext();
ok('🚨 it does not open over the account panel', !pop.shown());
ok('   it re-arms instead of giving up',        pop.timers.length === 1);
pop.el('forge-account-modal').style.display = 'none';
pop.fireNext();
ok('and shows once the panel is closed',        pop.shown());

// C. the checkout form is the one that costs money
pop = mkPopup();
pop.el('forge-order-modal').style.display = 'flex';
pop.fireNext();
ok('🚨 it does not open over a half-filled checkout', !pop.shown());

// D. nothing in the way — it still does its job
pop = mkPopup();
pop.fireNext();
ok('with nothing open it shows, as before', pop.shown());

// E. already dismissed — no timer at all
pop = mkPopup({ seen: true });
ok('once dismissed it never arms again', pop.timers.length === 0 && !pop.shown());

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exitCode = fail === 0 ? 0 : 1;
