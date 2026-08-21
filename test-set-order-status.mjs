// Tests set-order-status.js — marking an order paid, and making the DASHBOARD
// know about it immediately. No network: fetch is stubbed.
// Run with `node test-set-order-status.mjs`.
//
// WHY THE DASHBOARD PUSH EXISTS. This wrote to Square only, leaving the
// dashboard to find out on a sync. FP-001004 (Leo the Den, $259) proved how that
// fails: marked paid in Square and invisible here for three months, because the
// sync window was hardcoded to 60 days and the order was 91 days old.
//
// 🚨 THE PROPERTY THAT MATTERS MOST. Square's PAYMENT id is not the order's
// TENDER id, and sync_order_tenders() upserts on the tender id. Writing a
// dashboard tender straight from the payment response would carry the wrong key,
// and the next re-sync would add the real tender alongside it — the same money
// counted twice. So the order is RE-READ after the payment and that is what gets
// synced. These tests pin the re-read, because the shortcut is the tempting one.
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ok = (label, got, want) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${label}${good ? '' : `  got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  good ? pass++ : fail++;
};
const okTrue = (label, cond) => ok(label, !!cond, true);

const SECRET = 'test-secret';
process.env.ADMIN_TOKEN_SECRET = SECRET;
process.env.SQUARE_ACCESS_TOKEN = 'sq-token';
process.env.SQUARE_LOCATION_ID  = 'LOC1';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

function makeToken(secret) {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
const TOKEN = makeToken(SECRET);
const auth = { authorization: `Bearer ${TOKEN}` };

const setStatus = require('./netlify/functions/set-order-status.js');

const ORDER_ID = 'BC2x9wqGydlgtSbmV3EFoMbCWDDZY';   // FP-001004's real Square id
const TENDER_ID = 'sq-tender-abc';
const PAYMENT_ID = 'sq-payment-zzz';                 // deliberately NOT the tender id

let calls = [];
let getCount = 0;
let orderHasTender = false;
let paymentSucceeds = true;
let refetchSucceeds = true;
// Square can accept a payment and take a moment to attach it to the order.
// Modelled separately so that lag can actually be exercised.
let attachesImmediately = true;

function baseOrder(withTender) {
  return {
    id: ORDER_ID,
    version: 7,
    location_id: 'LOC1',
    reference_id: 'FP-001004',
    created_at: '2026-05-21T04:00:00Z',
    metadata: { forge_order_number: 'FP-001004' },
    total_money: { amount: 25900, currency: 'USD' },
    net_amount_due_money: { amount: 25900, currency: 'USD' },
    line_items: [
      { name: 'CJC-1295 / IPAMORELIN (5MG/5MG)', quantity: '1',
        base_price_money: { amount: 9900 }, gross_sales_money: { amount: 9900 }, total_money: { amount: 9900 } },
    ],
    tenders: withTender
      ? [{ id: TENDER_ID, type: 'OTHER', amount_money: { amount: 25900 }, created_at: '2026-08-20T16:00:00Z', note: 'Zelle' }]
      : undefined,
  };
}

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = opts.method || 'GET';
  calls.push({ url: u, method, body: opts.body ? JSON.parse(opts.body) : null });

  if (u.includes('/orders/') && method === 'GET') {
    getCount += 1;
    // First read is BEFORE the payment; any later read is the re-read, which is
    // where Square has now attached the tender.
    if (getCount > 1 && !refetchSucceeds) {
      return { ok: false, status: 500, json: async () => ({ errors: [{ detail: 'boom' }] }) };
    }
    const withTender = getCount > 1 ? orderHasTender : false;
    return { ok: true, status: 200, json: async () => ({ order: baseOrder(withTender) }) };
  }
  if (u.includes('/orders/') && method === 'PUT') {
    return { ok: true, status: 200, json: async () => ({ order: { ...baseOrder(false), version: 8 } }) };
  }
  if (u.includes('/payments')) {
    orderHasTender = paymentSucceeds && attachesImmediately;
    return paymentSucceeds
      ? { ok: true, status: 200, json: async () => ({ payment: { id: PAYMENT_ID, status: 'COMPLETED' } }) }
      : { ok: false, status: 400, json: async () => ({ errors: [{ detail: 'declined' }] }) };
  }
  if (u.includes('/rpc/sync_square_order')) {
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }), json: async () => ({ ok: true }) };
  }
  // The dashboard leg — mark_order_paid (migration 048). `rpcResult` stands in
  // for what the function decided, so the branches the page depends on
  // (reclassified / not) can each be exercised.
  if (u.includes('/rpc/mark_order_paid')) {
    rpcCalls.push(JSON.parse(opts.body).p);
    if (rpcResult instanceof Error) {
      return { ok: false, status: 400,
               text: async () => JSON.stringify({ message: rpcResult.message }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(rpcResult) };
  }
  return { ok: false, status: 404, json: async () => ({}), text: async () => '{}' };
};

let rpcCalls = [];
let rpcResult = null;

const reset = () => {
  calls = []; getCount = 0; orderHasTender = false;
  paymentSucceeds = true; refetchSucceeds = true; attachesImmediately = true;
  rpcCalls = []; rpcResult = null;
};
const mark = (status) => setStatus.handler({
  httpMethod: 'POST', headers: auth, body: JSON.stringify({ orderId: ORDER_ID, status }),
});
const syncCall = () => calls.find((c) => c.url.includes('sync_square_order'));

// ── Marking paid ─────────────────────────────────────────────────────────────
console.log('\n— marking an order paid reaches the dashboard immediately —');
reset();
let res = await mark('PAID');
let body = JSON.parse(res.body);
ok('200', res.statusCode, 200);
ok('the tender was recorded in Square', body.tenderRecorded, true);
ok('and the dashboard was updated here and now', body.dashboardSynced, true);
ok('with nothing left to warn about', body.dashboardNote, null);
okTrue('a payment was created', calls.some((c) => c.url.includes('/payments')));
okTrue('and the order was synced', !!syncCall());

console.log('\n— 🚨 the sync carries SQUARE\'S TENDER ID, not the payment id —');
// If this ever regresses to the payment id, sync_order_tenders() upserts on a
// key nothing matches, the next re-sync inserts the real tender alongside it,
// and the same money lands in revenue twice.
const sent = syncCall().body.p;
ok('one tender on the payload', sent.tenders.length, 1);
ok('keyed on the ORDER tender id', sent.tenders[0].square_id, TENDER_ID);
okTrue('and NOT on the payment id', sent.tenders[0].square_id !== PAYMENT_ID);
ok('for the right amount', sent.tenders[0].amount_cents, 25900);
ok('and the order reads as paid', sent.payment_state, 'PAID');

console.log('\n— 🚨 it syncs the RE-READ order, never the stale one —');
// The pre-payment copy carries the new PAID metadata with an EMPTY tenders
// array. Syncing that writes "paid with no tender" — the exact state that hid
// $1,501.44 of revenue until migration 026.
okTrue('the order was read twice: once before, once after', getCount >= 2);
const order
  = calls.map((c) => `${c.method} ${c.url.includes('/payments') ? 'payments' : c.url.includes('sync_square_order') ? 'sync' : 'orders'}`);
okTrue('and the sync came after the payment',
  order.lastIndexOf('POST payments') < order.lastIndexOf('POST sync'));

console.log('\n— if Square rejects the payment, the books are not told a lie —');
reset();
paymentSucceeds = false;
res = await mark('PAID');
body = JSON.parse(res.body);
ok('still a 200 — the flag did get set', res.statusCode, 200);
ok('but it says the tender did not record', body.tenderRecorded, false);
okTrue('and why', /rejected/i.test(body.tenderNote || ''));
// It still syncs: the dashboard matching Square is the invariant, and the
// watchdog's paid_no_tender probe is what surfaces the mismatch.
ok('the dashboard is still made to match Square', body.dashboardSynced, true);
ok('with no tender invented', syncCall().body.p.tenders.length, 0);

console.log('\n— if the re-read fails, the dashboard is left alone —');
// ⚠️ Being briefly behind is recoverable. Writing PAID with no tender is the
// failure that hides money, so it must never be the fallback.
reset();
refetchSucceeds = false;
res = await mark('PAID');
body = JSON.parse(res.body);
ok('still a 200', res.statusCode, 200);
ok('but nothing was synced', body.dashboardSynced, false);
okTrue('and it says a sync will fix it', /next sync/i.test(body.dashboardNote || ''));
okTrue('🚨 nothing was written to the dashboard at all', !syncCall());

console.log('\n— Square lagging behind its own payment is reported, not hidden —');
// Square took the payment but has not yet attached it to the order. The sync
// therefore carries no tender, so the money is not in revenue YET. Saying so
// beats a silent "done" that leaves it out until someone presses Sync.
reset();
attachesImmediately = false;
res = await mark('PAID');
body = JSON.parse(res.body);
ok('the payment did record',        body.tenderRecorded, true);
ok('and the dashboard was synced',  body.dashboardSynced, true);
ok('but with no tender yet',        syncCall().body.p.tenders.length, 0);
okTrue('and it says to press Sync in a moment', /press Sync/i.test(body.dashboardNote || ''));

console.log('\n— un-marking is blocked once real money is recorded —');
reset();
orderHasTender = true;
getCount = 1;            // make the FIRST read already carry a tender
res = await mark('AWAITING_ZELLE');
ok('409', res.statusCode, 409);
okTrue('and it says to void it in Square', /void|refund/i.test(JSON.parse(res.body).error));
okTrue('nothing was synced', !syncCall());

// ── The dashboard path ───────────────────────────────────────────────────────
// 🚨 THE BUG THIS WHOLE SECTION EXISTS FOR. This endpoint used to do a Square
// GET on whatever it was handed, and get-orders hands it `square_id ||
// order_id`. An order rung up here has no square_id, so Square was asked about
// a dashboard uuid and answered 404 "Order not found" — every time. The button
// had never once succeeded on a dashboard-only order.
const DASH_UUID = '4e1d94c0-416e-476c-8716-e44120ef7181';   // FP-001177, the live stuck one
const markDash = (payload) => setStatus.handler({
  httpMethod: 'POST', headers: auth, body: JSON.stringify(payload),
});
const touchedSquare = () => calls.some((c) => c.url.includes('connect.squareup.com'));

console.log('\n— 🚨 an order Square has never heard of no longer 404s —');
reset();
rpcResult = { order_id: DASH_UUID, order_no: 'FP-001177', payment_state: 'PAID',
              purpose: 'COMP', reclassified: true, previous_purpose: 'SALE',
              tender_recorded: false, tender_written: false, total_cents: 0 };
res = await markDash({ orderNumber: 'FP-001177', status: 'PAID' });
body = JSON.parse(res.body);
ok('200, where it used to be 404', res.statusCode, 200);
ok('success', body.success, true);
okTrue('🚨 and SQUARE WAS NEVER CALLED — that call was the bug', !touchedSquare());
ok('the dashboard function was', rpcCalls.length, 1);
ok('addressed by order number', rpcCalls[0].order_no, 'FP-001177');
okTrue('with no id invented for it', rpcCalls[0].order_id === null && rpcCalls[0].square_id === null);
ok('and it is true HERE, by construction', body.dashboardSynced, true);
ok('🚨 while saying plainly it is NOT in Square', body.squareSynced, false);

console.log('\n— 🔑 a free order comes back classified, and says so —');
ok('as a comp', body.purpose, 'COMP');
ok('flagged for the page', body.reclassified, true);
okTrue('in plain English', /comp/i.test(body.dashboardNote || ''));
okTrue('that says why it is off revenue', /off revenue|not a sale/i.test(body.dashboardNote || ''));
// 🚨 A free order gets NO tender and that is CORRECT, not a failure — 037
// settled it: purpose already keeps COMP and INTERNAL out of v_product_sales,
// so a $0 tender would be inventing income. The page's tenderRecorded warning
// is about money that went MISSING, and must not fire here.
ok('🚨 and the page is NOT warned about a missing payment', body.tenderRecorded, true);

console.log('\n— a dashboard uuid routes here too, not to Square —');
reset();
rpcResult = { order_id: DASH_UUID, order_no: 'FP-001177', payment_state: 'PAID',
              purpose: 'SALE', reclassified: false, tender_recorded: true,
              tender_written: true, total_cents: 25000 };
res = await markDash({ orderId: DASH_UUID, status: 'PAID' });
body = JSON.parse(res.body);
ok('200', res.statusCode, 200);
okTrue('🚨 Square untouched', !touchedSquare());
ok('matched on the uuid', rpcCalls[0].order_id, DASH_UUID);
okTrue('and NOT offered to Square as a square_id', rpcCalls[0].square_id === null);
ok('a real counter sale stays a SALE', body.purpose, 'SALE');
ok('nothing reclassified', body.reclassified, false);
ok('and the $250 is on the books', body.tenderRecorded, true);

console.log('\n— a Square id still goes to Square —');
reset();
res = await mark('PAID');
okTrue('Square was called', touchedSquare());
ok('and the dashboard RPC was not', rpcCalls.length, 0);

console.log('\n— the dashboard function\'s refusals reach the screen —');
reset();
rpcResult = new Error('Order not found');
res = await markDash({ orderNumber: 'FP-999999', status: 'PAID' });
ok('404 for an order that is not there', res.statusCode, 404);
okTrue('and says so', /not found/i.test(JSON.parse(res.body).error));
reset();
rpcResult = new Error('$250.00 is recorded as received on FP-001177. Void or refund it first — a payment cannot be undone from here.');
res = await markDash({ orderNumber: 'FP-001177', status: 'AWAITING_ZELLE' });
okTrue('un-marking is refused once money is recorded', res.statusCode >= 400);
okTrue('naming the amount', /\$250\.00/.test(JSON.parse(res.body).error));

console.log('\n— 🚨 a $0 SQUARE order is classified too, but ONLY at $0 —');
// `due > 0` means a free Square order is marked paid with no tender: as a SALE
// it drops out of v_product_sales while its real COGS still lands — a phantom
// loss. Classifying it is the fix. The $0 gate is load-bearing: at any other
// amount mark_order_paid could write a dashboard tender with no Square id
// while Square's real one is still pending, and the next sync would add that
// one alongside — the same money twice.
reset();
rpcResult = { order_id: 'x', order_no: 'FP-001004', payment_state: 'PAID',
              purpose: 'INTERNAL', reclassified: true, tender_written: false, total_cents: 0 };
res = await mark('PAID');
ok('a $259 Square order is NOT sent to the classifier', rpcCalls.length, 0);
ok('and is not reclassified', JSON.parse(res.body).reclassified, false);

console.log('\n— refusals —');
ok('no token', (await setStatus.handler({ httpMethod: 'POST', headers: {}, body: '{}' })).statusCode, 401);
ok('GET', (await setStatus.handler({ httpMethod: 'GET', headers: auth })).statusCode, 405);
reset();
ok('an unknown status', (await mark('SOMETHING')).statusCode, 400);

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
