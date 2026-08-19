// Tests house accounts: charging a sale to someone's tab (create-order.js),
// reading what they owe (get-customer.js), and paying it off (record-payment.js).
//
// The property that matters most here is that a payoff is NEVER written as a
// tender. The sale it settles already has one, and the whole accounting model
// rests on those being two different records — so this asserts on the calls the
// endpoints make, not just on what they return.
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
const AUTH = { authorization: `Bearer ${signToken(process.env.ADMIN_TOKEN_SECRET)}` };
const PARTY = '11111111-2222-3333-4444-555555555555';
const VARIANT = '99999999-8888-7777-6666-555555555555';

let calls = [];
const fresh = (m) => { const p = `./netlify/functions/${m}.js`; delete require.cache[require.resolve(p)]; return require(p); };
const json = (res) => JSON.parse(res.body);

function stub(routes) {
  calls = [];
  global.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ url: String(url), method, body: opts.body ? JSON.parse(opts.body) : null });
    for (const [frag, handler] of Object.entries(routes)) {
      if (String(url).includes(frag)) {
        const r = typeof handler === 'function' ? handler(opts) : handler;
        return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body ?? '') };
      }
    }
    return { ok: true, status: 200, text: async () => '[]' };
  };
}

console.log('\n1. charging a sale to a tab');
{
  const base = {
    purpose: 'SALE', channel: 'POS', client_uid: 'u1', party_id: PARTY,
    lines: [{ variant_id: VARIANT, quantity: 1, unit_price_cents: 27500, name: 'Retatrutide 30mg' }],
  };
  const post = (over) => fresh('create-order').handler({
    httpMethod: 'POST', headers: AUTH, body: JSON.stringify({ ...base, ...over }),
  });

  stub({ 'rpc/create_manual_order': { status: 200, body: { order_id: 'o1', order_no: 'FP-000500', total_cents: 27500 } } });
  await post({ tender_type: 'HOUSE_ACCOUNT' });
  const sent = calls.find(c => c.url.includes('create_manual_order')).body.p;
  ok('the tender type reaches the database', sent.tender_type, 'HOUSE_ACCOUNT');
  // 🔑 Reads oddly, and is the point: a tab charge is a settled sale. Left
  // AWAITING_PAYMENT, create_manual_order writes no tender at all — and a tab
  // with no charge on it is a debt nobody can see.
  ok('🔑 and the order is marked PAID so a charge actually exists', sent.payment_state, 'PAID');

  stub({ 'rpc/create_manual_order': { status: 200, body: { order_id: 'o1', order_no: 'FP-000501' } } });
  await post({ tender_type: 'ZELLE', payment_state: 'AWAITING_PAYMENT' });
  const normal = calls.find(c => c.url.includes('create_manual_order')).body.p;
  ok('a normal sale is untouched', normal.payment_state, 'AWAITING_PAYMENT');
  ok('and defaults are preserved', normal.tender_type, 'ZELLE');

  // Frank's own vials and give-aways are not owed to anybody.
  stub({});
  let res = await post({ tender_type: 'HOUSE_ACCOUNT', purpose: 'INTERNAL' });
  ok('own-use cannot go on a tab', res.statusCode, 400);
  okTrue('and says why', /not owed to anyone/i.test(json(res).error));
  res = await post({ tender_type: 'HOUSE_ACCOUNT', purpose: 'COMP' });
  ok('nor can a give-away', res.statusCode, 400);

  // A tab has to belong to somebody who can later be asked for the money.
  stub({});
  res = await fresh('create-order').handler({ httpMethod: 'POST', headers: AUTH, body: JSON.stringify({
    ...base, party_id: undefined, customer: { name: '' }, tender_type: 'HOUSE_ACCOUNT' }) });
  ok('an unnamed walk-in cannot open a tab', res.statusCode, 400);
  okTrue('and is told to name them', /name the customer/i.test(json(res).error));
  ok('🚨 and nothing was written', calls.filter(c => c.method === 'POST').length, 0);

  // A new customer is fine — migration 024's trigger attaches the charge to
  // whichever party create_manual_order ends up creating.
  stub({ 'rpc/create_manual_order': { status: 200, body: { order_id: 'o2', order_no: 'FP-000502' } } });
  res = await fresh('create-order').handler({ httpMethod: 'POST', headers: AUTH, body: JSON.stringify({
    ...base, party_id: undefined, customer: { name: 'A New Friend' }, tender_type: 'HOUSE_ACCOUNT' }) });
  ok('a newly named customer can', res.statusCode, 200);

  stub({});
  res = await post({ tender_type: 'BITCOIN' });
  ok('an unknown method is refused', res.statusCode, 400);
}

console.log('\n2. paying a tab off');
{
  const body = (over = {}) => JSON.stringify({ party_id: PARTY, amount_cents: 27500, ...over });
  const post = (over) => fresh('record-payment').handler({ httpMethod: 'POST', headers: AUTH, body: body(over) });

  stub({ 'rpc/record_house_payment': { status: 200, body: { payment_id: 'p1', customer: 'Mike', amount_cents: 27500, balance_cents: 0, settled: true } } });
  let res = await post();
  ok('it records', res.statusCode, 200);
  ok('and reports the new balance', json(res).balance_cents, 0);
  ok('and that the tab is clear', json(res).settled, true);

  const rpcCall = calls.find(c => c.url.includes('rpc/'));
  okTrue('🚨 it goes to record_house_payment', rpcCall.url.includes('record_house_payment'));
  // The single most important assertion in this file. A payoff written as a
  // tender would count the same money twice — once as the sale, once as the
  // payment — and inflate revenue by every deferred sale ever settled.
  ok('🚨 and NOTHING is written to tenders', calls.filter(c => /\/tenders/.test(c.url)).length, 0);
  ok('nor to orders', calls.filter(c => /\/orders/.test(c.url)).length, 0);

  stub({});
  ok('no customer is refused', (await fresh('record-payment').handler({
    httpMethod: 'POST', headers: AUTH, body: JSON.stringify({ amount_cents: 100 }) })).statusCode, 400);
  ok('zero is refused', (await post({ amount_cents: 0 })).statusCode, 400);
  ok('a negative is refused', (await post({ amount_cents: -500 })).statusCode, 400);
  ok('fractional cents are refused', (await post({ amount_cents: 12.5 })).statusCode, 400);
  // A slipped decimal point, not a business rule.
  res = await post({ amount_cents: 9_000_000 });
  ok('an absurd amount is refused', res.statusCode, 400);
  okTrue('naming the threshold', /\$50,000/.test(json(res).error));
  // 🔑 Paying a tab with the tab is not a payment.
  res = await post({ method: 'HOUSE_ACCOUNT' });
  ok('🔑 a tab cannot pay for itself', res.statusCode, 400);
  ok('and no money moved on any refusal', calls.filter(c => c.method === 'POST' && c.url.includes('rpc/')).length, 0);

  ok('GET is not a way to record money', (await fresh('record-payment').handler({
    httpMethod: 'GET', headers: AUTH, body: '{}' })).statusCode, 405);
  ok('no token is refused', (await fresh('record-payment').handler({
    httpMethod: 'POST', headers: {}, body: body() })).statusCode, 401);

  // The database is the authority on overpaying; the endpoint must relay it.
  stub({ 'rpc/record_house_payment': { status: 400, body: { message: 'that is more than Mike owes (5000 cents outstanding)' } } });
  res = await post({ amount_cents: 999999 });
  ok('an overpayment is refused', res.statusCode, 400);
  okTrue('in the database\'s own words', /more than Mike owes/.test(json(res).error));
}

console.log('\n3. the profile');
{
  const PROFILE = { party_id: PARTY, display_name: 'Mike', email: 'm@example.com', phone: '555',
    order_count: 3, lifetime_cents: 82500, house_balance_cents: 27500, days_since_last_order: 12 };
  stub({
    'v_customer_profile': { status: 200, body: [PROFILE] },
    '/orders?': { status: 200, body: [
      { id: 'o1', order_no: 'FP-1', placed_at: '2026-08-18T10:00:00Z', state: 'OPEN', payment_state: 'PAID',
        purpose: 'SALE', channel: 'POS', total_cents: 27500,
        tenders: [{ type: 'HOUSE_ACCOUNT', amount_cents: 27500 }],
        order_line_items: [{ name_at_sale: 'Retatrutide 30mg', quantity: 1, kind: 'PRODUCT' },
                           { name_at_sale: 'Shipping', quantity: 1, kind: 'SHIPPING' }] },
      { id: 'o2', order_no: 'FP-2', placed_at: '2026-08-10T10:00:00Z', state: 'CANCELED', payment_state: 'PAID',
        purpose: 'SALE', channel: 'POS', total_cents: 16000, tenders: [], order_line_items: [] },
    ] },
    '/tenders?': { status: 200, body: [
      { amount_cents: 27500, received_at: '2026-08-18T10:00:00Z', note: null, orders: { order_no: 'FP-1', state: 'OPEN' } },
      { amount_cents: 16000, received_at: '2026-08-10T10:00:00Z', note: null, orders: { order_no: 'FP-2', state: 'CANCELED' } },
    ] },
    'house_account_payments': { status: 200, body: [{ id: 'p1', amount_cents: 5000, method: 'ZELLE', received_at: '2026-08-19T10:00:00Z' }] },
  });
  const res = await fresh('get-customer').handler({ httpMethod: 'GET', headers: AUTH, queryStringParameters: { party_id: PARTY } });
  const d = json(res);
  ok('it loads', res.statusCode, 200);
  ok('with the balance from the view, not re-summed here', d.profile.house_balance_cents, 27500);
  ok('orders come back', d.orders.length, 2);
  ok('a tab order is marked as one', d.orders[0].on_house_account, true);
  ok('only product lines are listed', d.orders[0].items, [{ name: 'Retatrutide 30mg', qty: 1 }]);
  // A voided order stays in the history, labelled. Hiding it invites "where did
  // that sale go?" with no way to answer.
  ok('a voided order is kept and flagged', d.orders[1].voided, true);
  // 🔑 The charge on it is excluded from the balance by the view, so the ledger
  // must show it struck through or the two will not add up.
  ok('and its charge is flagged in the ledger', d.house_charges[1].voided, true);
  ok('a live charge is not', d.house_charges[0].voided, false);
  ok('payments come back', d.house_payments.length, 1);

  stub({});
  ok('a bad id is refused', (await fresh('get-customer').handler({
    httpMethod: 'GET', headers: AUTH, queryStringParameters: { party_id: 'nope' } })).statusCode, 400);
  ok('no token is refused', (await fresh('get-customer').handler({
    httpMethod: 'GET', headers: {}, queryStringParameters: { party_id: PARTY } })).statusCode, 401);

  stub({ 'v_customer_profile': { status: 200, body: [] } });
  ok('an unknown customer is a 404', (await fresh('get-customer').handler({
    httpMethod: 'GET', headers: AUTH, queryStringParameters: { party_id: PARTY } })).statusCode, 404);
}

console.log('\n4. before migration 024 is applied, it says so');
{
  // Otherwise the page shows a raw PostgREST error about a missing relation,
  // which tells Frank nothing he can act on.
  stub({ 'v_customer_profile': { status: 404, body: { message: 'relation "public.v_customer_profile" does not exist' } } });
  let d = json(await fresh('get-customer').handler({ httpMethod: 'GET', headers: AUTH, queryStringParameters: { party_id: PARTY } }));
  okTrue('the profile explains it in plain words', /not set up in the database yet/i.test(d.error));
  okTrue('and names the file to apply', /024-house-accounts\.sql/.test(d.hint));

  stub({ 'rpc/record_house_payment': { status: 404, body: { message: 'function record_house_payment does not exist' } } });
  d = json(await fresh('record-payment').handler({ httpMethod: 'POST', headers: AUTH,
    body: JSON.stringify({ party_id: PARTY, amount_cents: 100 }) }));
  okTrue('and so does the payoff', /not set up in the database yet/i.test(d.error));
  okTrue('with the same instruction', /024-house-accounts\.sql/.test(d.hint));
}

console.log(`\n${fail ? `${fail} FAILED, ` : ''}${pass} passed.`);
process.exit(fail ? 1 : 0);
