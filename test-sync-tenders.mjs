// Tests that a synced Square order carries its PAYMENT across, not just the
// fact that it was paid.
//
// 2026-08-20: buildSyncPayload read order.tenders only to decide payment_state,
// then dropped it. The payload had no `tenders` key, so sync_square_order()
// could not have stored one. Orders landed PAID with no tender row, and
// v_product_sales tests for a tender — so every website sale after the Square
// cutover was silently missing from revenue. $1,501.44 across 6 orders before
// the watchdog's paid_no_tender probe surfaced it.
//
// 🔑 The property that matters: payment_state === 'PAID' must never be the ONLY
// evidence that money arrived. If a payload says paid, it must also say how.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ok = (l, c, d = '') => { c ? (pass++, console.log(`  PASS  ${l}`)) : (fail++, console.log(`  FAIL  ${l}${d ? '  — ' + d : ''}`)); };

const { buildSyncPayload, paymentState } = require('./netlify/functions/_order-sync.js');

const order = (over = {}) => ({
  id: 'SQ-ORDER-1',
  created_at: '2026-08-18T14:00:00Z',
  state: 'COMPLETED',
  total_money: { amount: 20865 },
  line_items: [{ uid: 'li1', name: 'Retatrutide 10mg', quantity: '1',
                 base_price_money: { amount: 16000 }, total_money: { amount: 16000 } }],
  metadata: { forge_order_number: 'FP-714638' },
  ...over,
});

console.log('\n1. a card payment travels with the order');
let p = buildSyncPayload(order({
  tenders: [{ id: 'SQ-TENDER-1', type: 'CARD', amount_money: { amount: 20865 },
              created_at: '2026-08-18T14:00:05Z' }],
}), null);
ok('the payload has a tenders array', Array.isArray(p.tenders));
ok('with the payment in it', p.tenders.length === 1);
ok('🔑 carrying Square\'s tender id, which is what makes a re-sync safe',
   p.tenders[0].square_id === 'SQ-TENDER-1');
ok('the type', p.tenders[0].type === 'CARD');
ok('and the amount to the cent', p.tenders[0].amount_cents === 20865);
ok('and when it arrived', p.tenders[0].received_at === '2026-08-18T14:00:05Z');

console.log('\n2. 🔑 "paid" is never the only evidence money arrived');
ok('this order reads PAID', paymentState(order({ tenders: [{ id: 'T', type: 'CARD', amount_money: { amount: 1 } }] })) === 'PAID');
ok('and it says how', p.tenders.length > 0);
// The regression itself, stated directly: a paid order with an empty tender
// list is the exact shape that was reaching the database for a week.
const paid = buildSyncPayload(order({ tenders: [{ id: 'T1', type: 'CARD', amount_money: { amount: 20865 } }] }), null);
ok('🔑 a PAID payload is never sent with zero tenders',
   !(paid.payment_state === 'PAID' && paid.tenders.length === 0));

console.log('\n3. cash keeps its drawer figures');
p = buildSyncPayload(order({
  tenders: [{ id: 'T2', type: 'CASH', amount_money: { amount: 5000 },
              cash_details: { buyer_tendered_money: { amount: 6000 }, change_back_money: { amount: 1000 } } }],
}), null);
ok('tendered', p.tenders[0].tendered_cents === 6000);
ok('change', p.tenders[0].change_cents === 1000);
ok('and they reconcile against the amount',
   p.tenders[0].tendered_cents - p.tenders[0].amount_cents === p.tenders[0].change_cents);

console.log('\n4. a card payment has no drawer figures, and that is fine');
p = buildSyncPayload(order({ tenders: [{ id: 'T3', type: 'CARD', amount_money: { amount: 100 } }] }), null);
ok('tendered is null, not zero', p.tenders[0].tendered_cents === null);
ok('change is null, not zero', p.tenders[0].change_cents === null);

console.log('\n5. an unpaid order carries no payment');
p = buildSyncPayload(order({ tenders: [], metadata: {} }), null);
ok('empty list, not undefined', Array.isArray(p.tenders) && p.tenders.length === 0);
ok('and it does not claim to be paid', p.payment_state !== 'PAID');

console.log('\n6. several payments on one order all come across');
p = buildSyncPayload(order({
  tenders: [{ id: 'A', type: 'CASH', amount_money: { amount: 5000 } },
            { id: 'B', type: 'CARD', amount_money: { amount: 15865 } }],
}), null);
ok('both are present', p.tenders.length === 2);
ok('and together they equal the order total',
   p.tenders.reduce((t, x) => t + x.amount_cents, 0) === 20865);

console.log('\n7. a missing tender id is passed through for the DB to refuse');
p = buildSyncPayload(order({ tenders: [{ type: 'CARD', amount_money: { amount: 100 } }] }), null);
ok('square_id is null rather than invented', p.tenders[0].square_id === null);

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
