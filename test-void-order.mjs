// Tests void-order.js — undoing an order that should not exist.
//
// This endpoint writes to stock_ledger, which is APPEND-ONLY and guarded by a
// trigger: a wrong row cannot be deleted, only compensated. So the properties
// that matter most here are not "does it work" but "can it ever put back more
// than left" and "what happens when it is run twice". No network: fetch is
// stubbed and every call it makes is inspected.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ok = (label, got, want) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${label}${good ? '' : `  got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  good ? pass++ : fail++;
};
const okTrue = (label, cond) => ok(label, !!cond, true);

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'key';
process.env.ADMIN_TOKEN_SECRET = 'test-secret-value-long-enough';

const { signToken } = require('./netlify/functions/_auth-token.js');
const TOKEN = signToken(process.env.ADMIN_TOKEN_SECRET);
const AUTH = { authorization: `Bearer ${TOKEN}` };

const ORDER_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SQUARE_ID  = 'bjaCrgWA5MLBhvDA1wr9qbAkqAZZY';

// A plain order: two Retatrutide, both deducted from stock.
const baseOrder = (over = {}) => ({
  id: ORDER_UUID, order_no: 'FP-000123', square_id: SQUARE_ID,
  state: 'OPEN', purpose: 'SALE', payment_state: 'PAID',
  total_cents: 32000, note: null, placed_at: '2026-08-18T10:00:00Z',
  tenders: [],
  order_line_items: [{ id: 'li-1', kind: 'PRODUCT', variant_id: 'v-reta', name_at_sale: 'Retatrutide 10mg', quantity: 2 }],
  ...over,
});

let calls = [];
function stub({ order, ledger = [], patchRows = null }) {
  calls = [];
  global.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ url, method, body: opts.body ? JSON.parse(opts.body) : null });
    const reply = (status, body) => ({
      ok: status < 400, status,
      text: async () => (body === undefined ? '' : JSON.stringify(body)),
    });
    if (url.includes('/orders?') && method === 'GET')   return reply(200, order ? [order] : []);
    if (url.includes('/orders?') && method === 'PATCH') return reply(200, patchRows ?? [{ id: ORDER_UUID }]);
    if (url.includes('/stock_ledger') && method === 'GET')  return reply(200, ledger);
    if (url.includes('/stock_ledger') && method === 'POST') return reply(201);
    return reply(404, { message: 'unstubbed ' + url });
  };
}

const fresh = () => { const p = './netlify/functions/void-order.js'; delete require.cache[require.resolve(p)]; return require(p); };
const call = async (body, headers = AUTH) =>
  fresh().handler({ httpMethod: 'POST', headers, body: JSON.stringify(body) });
const json = (res) => JSON.parse(res.body);
const ledgerPosts = () => calls.filter(c => c.url.includes('/stock_ledger') && c.method === 'POST');

console.log('\n1. the door is locked');
{
  stub({ order: baseOrder() });
  ok('no token is refused', (await call({ orderId: ORDER_UUID }, {})).statusCode, 401);
  ok('a junk token is refused', (await call({ orderId: ORDER_UUID }, { authorization: 'Bearer nope' })).statusCode, 401);
  const res = await fresh().handler({ httpMethod: 'GET', headers: AUTH, body: '{}' });
  ok('GET is not a way to void things', res.statusCode, 405);
  ok('an order must be named', (await call({})).statusCode, 400);
}

console.log('\n2. an order the dashboard has never seen');
{
  stub({ order: null });
  const res = await call({ orderId: ORDER_UUID });
  ok('is a 404', res.statusCode, 404);
  okTrue('and says to sync first rather than just failing', /Sync from Square/i.test(json(res).hint));
  ok('🚨 and nothing was written', ledgerPosts().length, 0);
}

console.log('\n3. 🚨 stock comes back from the LEDGER, never from the order quantity');
{
  // The order says 2. The ledger says 2 left. Both agree — return 2.
  stub({ order: baseOrder(), ledger: [{ order_line_item_id: 'li-1', variant_id: 'v-reta', delta: -2, created_by: 'pos' }] });
  let d = json(await call({ orderId: ORDER_UUID }));
  ok('two units go back', d.unitsReturned, 2);
  ok('as one ledger row', ledgerPosts()[0].body.length, 1);
  ok('positive, so it adds', ledgerPosts()[0].body[0].delta, 2);
  ok('against the same line item', ledgerPosts()[0].body[0].order_line_item_id, 'li-1');
  ok('recorded as a RETURN', ledgerPosts()[0].body[0].reason, 'RETURN');
  ok('and tagged so a later void can recognise it', ledgerPosts()[0].body[0].created_by, 'void');

  // 🚨 THE CASE THAT MATTERS. The order says 2; the ledger says nothing ever
  // left. This is the shape of the 19 orders migration 021 cancelled. Adding
  // back "what the order says" would invent two vials that are already on the
  // shelf.
  stub({ order: baseOrder(), ledger: [] });
  d = json(await call({ orderId: ORDER_UUID }));
  ok('an order that never moved stock returns nothing', d.unitsReturned, 0);
  ok('🚨 and writes NO ledger row at all', ledgerPosts().length, 0);
  ok('but it is still voided', d.cancelled, true);

  // Partially returned already: give back only what is still out.
  stub({ order: baseOrder(), ledger: [
    { order_line_item_id: 'li-1', variant_id: 'v-reta', delta: -2, created_by: 'pos' },
    { order_line_item_id: 'li-1', variant_id: 'v-reta', delta: 1, created_by: 'admin' },
  ] });
  d = json(await call({ orderId: ORDER_UUID }));
  ok('only the remainder comes back', d.unitsReturned, 1);
}

console.log('\n4. 🚨 running it twice cannot double-restock');
{
  // The state after a successful void: the reversal row is in the ledger, so
  // the line item nets to zero. stock_ledger is append-only — if this is wrong
  // the extra units can never be removed, only compensated.
  stub({ order: baseOrder({ state: 'CANCELED' }), ledger: [
    { order_line_item_id: 'li-1', variant_id: 'v-reta', delta: -2, created_by: 'pos' },
    { order_line_item_id: 'li-1', variant_id: 'v-reta', delta: 2, created_by: 'void' },
  ] });
  const d = json(await call({ orderId: ORDER_UUID }));
  ok('the second run returns nothing', d.unitsReturned, 0);
  ok('🚨 and writes nothing', ledgerPosts().length, 0);
  ok('and says it was already voided', d.alreadyVoided, true);

  // A void that restocked and then failed to cancel must be completable.
  stub({ order: baseOrder({ state: 'OPEN' }), ledger: [
    { order_line_item_id: 'li-1', variant_id: 'v-reta', delta: -2, created_by: 'pos' },
    { order_line_item_id: 'li-1', variant_id: 'v-reta', delta: 2, created_by: 'void' },
  ] });
  const heal = json(await call({ orderId: ORDER_UUID }));
  ok('a half-finished void still gets cancelled', heal.cancelled, true);
  ok('without restocking again', ledgerPosts().length, 0);
}

console.log('\n5. 🚨 the 19 orders migration 021 cancelled stay untouched');
{
  // Already CANCELED, and no reversal row: cancelled by the migration, whose
  // whole point was that the physical count had already accounted for the stock.
  stub({ order: baseOrder({ state: 'CANCELED' }), ledger: [
    { order_line_item_id: 'li-1', variant_id: 'v-reta', delta: -2, created_by: 'order-sync' },
  ] });
  const res = await call({ orderId: ORDER_UUID });
  ok('it is refused', res.statusCode, 409);
  ok('🚨 and no stock is invented', ledgerPosts().length, 0);
  okTrue('explaining it would count twice', /twice/i.test(json(res).hint));
  okTrue('and pointing at Adjust stock instead', /Adjust stock/i.test(json(res).hint));
}

console.log('\n6. money gets its own question');
{
  const paid = baseOrder({ tenders: [{ id: 't-1', amount_cents: 32000 }] });
  stub({ order: paid, ledger: [{ order_line_item_id: 'li-1', variant_id: 'v-reta', delta: -2, created_by: 'pos' }] });
  const res = await call({ orderId: ORDER_UUID });
  ok('a paid order is not voided on the first ask', res.statusCode, 409);
  ok('it flags that it needs acknowledging', json(res).needsAcknowledgement, true);
  ok('and names the amount', json(res).tenderCents, 32000);
  okTrue('in dollars, in the message', /\$320\.00/.test(json(res).hint));
  okTrue('and is honest that nothing is refunded', /does not refund/i.test(json(res).hint));
  ok('🚨 nothing was written while asking', ledgerPosts().length, 0);

  stub({ order: paid, ledger: [{ order_line_item_id: 'li-1', variant_id: 'v-reta', delta: -2, created_by: 'pos' }] });
  const done = json(await call({ orderId: ORDER_UUID, acknowledgePayment: true }));
  ok('acknowledged, it goes through', done.cancelled, true);
  ok('stock comes back', done.unitsReturned, 2);
  ok('and the payment is reported, not hidden', done.tenderCents, 32000);
}

console.log('\n7. the order of operations, and the compare-and-swap');
{
  stub({ order: baseOrder(), ledger: [{ order_line_item_id: 'li-1', variant_id: 'v-reta', delta: -2, created_by: 'pos' }] });
  await call({ orderId: ORDER_UUID, reason: 'duplicate of FP-000122' });

  const iPost  = calls.findIndex(c => c.url.includes('/stock_ledger') && c.method === 'POST');
  const iPatch = calls.findIndex(c => c.method === 'PATCH');
  // 🔑 Restock first. Cancelling first and then failing the restock would leave
  // stock silently missing behind a closed order, and a retry would refuse it.
  okTrue('stock is restored BEFORE the order is cancelled', iPost > -1 && iPatch > -1 && iPost < iPatch);

  const patch = calls[iPatch];
  okTrue('🔑 the cancel is a compare-and-swap', patch.url.includes('state=neq.CANCELED'));
  ok('it sets CANCELED', patch.body.state, 'CANCELED');
  okTrue('the reason is written onto the order', patch.body.note.includes('duplicate of FP-000122'));
  okTrue('and it is dated', /\[voided \d{4}-\d{2}-\d{2}\]/.test(patch.body.note));
}
{
  // An existing note must survive — it may be the customer's own.
  stub({ order: baseOrder({ note: 'Customer asked for signature on delivery' }) });
  await call({ orderId: ORDER_UUID, reason: 'test order' });
  const patch = calls.find(c => c.method === 'PATCH');
  okTrue('an existing note is kept, not clobbered', patch.body.note.startsWith('Customer asked for signature'));
  okTrue('with the void appended', patch.body.note.includes('test order'));
}
{
  // Losing the compare-and-swap means someone else voided it first.
  stub({ order: baseOrder(), ledger: [], patchRows: [] });
  const d = json(await call({ orderId: ORDER_UUID }));
  ok('a lost race is not reported as a fresh cancel', d.cancelled, false);
  ok('it reads as already voided', d.alreadyVoided, true);
}

console.log('\n8. only real product lines can return stock');
{
  stub({ order: baseOrder({ order_line_items: [
    { id: 'li-1', kind: 'PRODUCT', variant_id: null, name_at_sale: 'Something typed at the till', quantity: 1 },
    { id: 'li-2', kind: 'SHIPPING', variant_id: null, name_at_sale: 'Shipping', quantity: 1 },
  ] }) });
  const d = json(await call({ orderId: ORDER_UUID }));
  // A line that never resolved to a product never moved stock, so there is
  // nothing to give back and nothing to guess at.
  ok('an unresolved product line returns nothing', d.unitsReturned, 0);
  ok('and the ledger is never even read for it', calls.filter(c => c.url.includes('/stock_ledger')).length, 0);
  ok('the order is still voided', d.cancelled, true);
}

console.log('\n9. both kinds of order can be found');
{
  stub({ order: baseOrder() });
  await call({ orderId: ORDER_UUID });
  okTrue('a counter sale is looked up by its uuid', calls[0].url.includes(`id=eq.${ORDER_UUID}`));

  stub({ order: baseOrder() });
  await call({ orderId: SQUARE_ID });
  okTrue('a Square order is looked up by its Square id', calls[0].url.includes('square_id=eq.'));
  okTrue('and not mistaken for a uuid', !calls[0].url.includes(`&id=eq.`));

  stub({ order: baseOrder() });
  await call({ orderNumber: 'FP-000123' });
  okTrue('an order number works too', calls[0].url.includes('order_no=eq.FP-000123'));
}

console.log('\n10. the Orders tab has to agree that it is voided');
{
  // get-orders reads SQUARE, and Square is deactivated — it will keep returning
  // a voided order as OPEN forever. The dashboard's CANCELED has to win, or the
  // order Frank just voided is still sitting there tomorrow.
  process.env.SQUARE_ACCESS_TOKEN = 'sq';
  process.env.SQUARE_LOCATION_ID  = 'LOC1';

  const squareOrder = (id) => ({
    id, created_at: '2026-08-18T10:00:00Z', state: 'OPEN',
    metadata: { forge_order_number: 'FP-000123', payment_status: 'PAID' },
    line_items: [{ name: 'Retatrutide 10mg', quantity: '1', base_price_money: { amount: 16000 },
                   total_money: { amount: 16000 } }],
    total_money: { amount: 16000 }, net_amounts: {},
  });

  const load = (cancelledRows, dashRows) => {
    global.fetch = async (url, opts = {}) => {
      const reply = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body });
      if (url.includes('orders/search'))  return reply({ orders: [squareOrder(SQUARE_ID), squareOrder('LIVE-ONE')] });
      if (url.includes('/customers'))     return reply({ customer: null });
      if (url.includes('v_order_fulfillment'))     return reply([]);
      if (url.includes('v_dashboard_only_orders')) return reply(dashRows);
      if (url.includes('/rest/v1/orders?select=square_id')) return reply(cancelledRows);
      return reply({});
    };
    const path = './netlify/functions/get-orders.js';
    delete require.cache[require.resolve(path)];
    return require(path);
  };

  let mod = load([{ square_id: SQUARE_ID }], []);
  let res = await mod.handler({ httpMethod: 'GET', headers: AUTH, queryStringParameters: { days: '30' } });
  let out = JSON.parse(res.body).orders;
  ok('the voided Square order reads CANCELED', out.find(o => o.orderId === SQUARE_ID).status, 'CANCELED');
  ok('🚨 and the untouched one is left alone', out.find(o => o.orderId === 'LIVE-ONE').status, 'PAID');

  // A voided counter sale must not come back labelled by what it was paid.
  mod = load([], [{
    order_id: 'dash-1', order_number: 'FP-000999', payment_state: 'PAID', order_state: 'CANCELED',
    created_at: '2026-08-18T10:00:00Z', customer_name: 'X', total: 275, items: [],
  }]);
  res = await mod.handler({ httpMethod: 'GET', headers: AUTH, queryStringParameters: { days: '30' } });
  out = JSON.parse(res.body).orders;
  ok('a voided counter sale reads CANCELED, not PAID', out.find(o => o.orderId === 'dash-1').status, 'CANCELED');

  // ⚠️ Fails open: an unreachable dashboard must not take the order list down.
  global.fetch = async (url) => {
    const reply = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body });
    if (url.includes('orders/search')) return reply({ orders: [squareOrder(SQUARE_ID)] });
    if (url.includes('/customers'))    return reply({ customer: null });
    if (url.includes('/rest/v1/'))     return { ok: false, status: 503, text: async () => '', json: async () => ({}) };
    return reply({});
  };
  const path = './netlify/functions/get-orders.js';
  delete require.cache[require.resolve(path)];
  res = await require(path).handler({ httpMethod: 'GET', headers: AUTH, queryStringParameters: { days: '30' } });
  ok('a dashboard outage still returns the list', res.statusCode, 200);
  okTrue('rather than hiding every order', JSON.parse(res.body).orders.length > 0);
}

console.log(`\n${fail ? `${fail} FAILED, ` : ''}${pass} passed.`);
process.exit(fail ? 1 : 0);
