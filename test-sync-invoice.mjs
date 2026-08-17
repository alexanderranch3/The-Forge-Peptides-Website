// Tests for _order-sync.js, sync-orders.js, _invoice.js and send-invoice.js.
// No network: fetch is stubbed. Run with `node test-sync-invoice.mjs`.
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
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.SQUARE_ACCESS_TOKEN = 'sq-token';
process.env.SQUARE_LOCATION_ID = 'LOC1';
process.env.RESEND_API_KEY = 'resend-key';

function makeToken(secret, { expiresInSec = 3600 } = {}) {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expiresInSec })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
const auth = (t = makeToken(SECRET)) => ({ authorization: `Bearer ${t}` });

let routes = {}, calls = [];
global.fetch = async (url, opts = {}) => {
  calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
  for (const [frag, handler] of Object.entries(routes)) {
    if (url.includes(frag)) {
      const r = typeof handler === 'function' ? await handler(opts) : handler;
      return {
        ok: r.status < 400, status: r.status,
        text: async () => JSON.stringify(r.body),
        json: async () => r.body,
      };
    }
  }
  const miss = { message: 'no route' };
  return { ok: false, status: 404, text: async () => JSON.stringify(miss), json: async () => miss };
};

const sync = require('./netlify/functions/_order-sync.js');
const invoice = require('./netlify/functions/_invoice.js');
const syncOrders = require('./netlify/functions/sync-orders.js');
const sendInvoice = require('./netlify/functions/send-invoice.js');

const body = (res) => JSON.parse(res.body);

// A Square order shaped the way Square actually returns one.
const SQ_ORDER = {
  id: 'sq-order-1',
  reference_id: 'FP-123456',
  customer_id: 'cust-1',
  created_at: '2026-08-16T15:00:00Z',
  state: 'OPEN',
  metadata: { forge_order_number: 'FP-123456', payment_status: 'AWAITING_ZELLE', fulfillment_type: 'SHIP' },
  line_items: [
    { uid: 'l1', name: 'Retatrutide 10mg', quantity: '2', catalog_object_id: 'VAR-RETA10',
      base_price_money: { amount: 16000 }, gross_sales_money: { amount: 32000 },
      total_tax_money: { amount: 2240 }, total_money: { amount: 34240 } },
    { uid: 'l2', name: 'Shipping — USPS Priority', quantity: '1',
      base_price_money: { amount: 2500 }, gross_sales_money: { amount: 2500 },
      total_money: { amount: 2500 } },
  ],
  total_discount_money: { amount: 0 },
  total_tax_money: { amount: 2240 },
  total_money: { amount: 36740 },
};

console.log('\n1. mapping a Square order into the database shape');
{
  const p = sync.buildSyncPayload(SQ_ORDER, { square_id: 'cust-1', name: 'Jane Doe', email: 'jane@example.com' });
  ok('keyed on the Square order id', p.square_id, 'sq-order-1');
  ok('our order number carried through', p.order_no, 'FP-123456');
  ok('recognised as a website order', p.channel, 'WEBSITE');
  ok('shipping split out of the subtotal', p.subtotal_cents, 32000);
  ok('shipping captured separately', p.shipping_cents, 2500);
  ok('tax from the order, not re-derived', p.tax_cents, 2240);
  ok('total from the order', p.total_cents, 36740);
  ok('product line kind', p.lines[0].kind, 'PRODUCT');
  ok('shipping line kind', p.lines[1].kind, 'SHIPPING');
  ok('variation id kept for exact matching', p.lines[0].square_variation_id, 'VAR-RETA10');
  ok('shipping line carries no variation', p.lines[1].square_variation_id, null);
  // 🔑 The 2026-08-14 bug: gross_sales_money is pre-tax, total_money is not.
  ok('line amount is PRE-tax', p.lines[0].gross_cents, 32000);
  ok('customer attached', p.customer.email, 'jane@example.com');
}

console.log('\n2. payment state is asserted two ways');
{
  ok('metadata flag', sync.paymentState({ metadata: { payment_status: 'PAID' } }), 'PAID');
  ok('a tender counts even without the flag', sync.paymentState({ tenders: [{ id: 't' }] }), 'PAID');
  ok('otherwise awaiting', sync.paymentState({ metadata: {} }), 'AWAITING_PAYMENT');
}

console.log('\n3. line kinds');
{
  ok('shipping', sync.lineKind('Shipping — USPS'), 'SHIPPING');
  ok('balance due is not product revenue', sync.lineKind('Balance Due'), 'BALANCE_DUE');
  ok('anything else is product', sync.lineKind('Glow Blend'), 'PRODUCT');
}

console.log('\n4. sync-orders endpoint');
{
  const run = (event) => syncOrders.handler({ headers: {}, httpMethod: 'GET', ...event });
  ok('401 without a token', (await run({})).statusCode, 401);

  routes = {
    'v_sync_status': { status: 200, body: [{ last_order_at: '2026-08-13T00:00:00Z', days_since_last_order: '4', orders_total: '141', orders_30d: '20' }] },
  };
  const st = await run({ headers: auth() });
  ok('GET reports staleness', body(st).status.days_since_last_order, 4);
  ok('and totals', body(st).status.orders_total, 141);
  okTrue('GET writes nothing', !calls.some(c => c.url.includes('rpc/sync_square_order')));

  routes['orders/search'] = { status: 200, body: { orders: [SQ_ORDER] } };
  routes['customers/cust-1'] = { status: 200, body: { customer: { id: 'cust-1', given_name: 'Jane', family_name: 'Doe', email_address: 'jane@example.com' } } };
  routes['rpc/sync_square_order'] = { status: 200, body: { order_id: 'x', created: true, lines: 2, stock_rows: 1, unmatched: 0 } };

  calls = [];
  const res = await run({ httpMethod: 'POST', headers: auth(), body: JSON.stringify({ days: 30 }) });
  const d = body(res);
  ok('POST syncs', res.statusCode, 200);
  ok('scanned', d.scanned, 1);
  ok('created', d.created, 1);
  ok('stock rows reported', d.stock_rows, 1);
  okTrue('the customer was looked up, not invented',
    calls.some(c => c.url.includes('customers/cust-1')));

  // An already-known order must report as updated and move no stock.
  routes['rpc/sync_square_order'] = { status: 200, body: { order_id: 'x', created: false, lines: 0, stock_rows: 0, unmatched: 0 } };
  const again = body(await run({ httpMethod: 'POST', headers: auth(), body: JSON.stringify({ days: 30 }) }));
  ok('re-run creates nothing', again.created, 0);
  ok('re-run updates instead', again.updated, 1);
  ok('and moves no stock', again.stock_rows, 0);

  // One bad order must not abandon the rest.
  routes['orders/search'] = { status: 200, body: { orders: [SQ_ORDER, { ...SQ_ORDER, id: 'sq-order-2' }] } };
  routes['rpc/sync_square_order'] = (opts) =>
    JSON.parse(opts.body).p.square_id === 'sq-order-2'
      ? { status: 400, body: { message: 'boom' } }
      : { status: 200, body: { created: true, lines: 1, stock_rows: 1, unmatched: 0 } };
  const partial = body(await run({ httpMethod: 'POST', headers: auth(), body: JSON.stringify({ days: 30 }) }));
  ok('the good order still synced', partial.created, 1);
  ok('and the bad one is reported', partial.failed.length, 1);

  // The window is clamped rather than trusted.
  routes['orders/search'] = { status: 200, body: { orders: [] } };
  ok('absurd window clamped', body(await run({ httpMethod: 'POST', headers: auth(), body: JSON.stringify({ days: 99999 }) })).window.days, 400);
  ok('zero window clamped up', body(await run({ httpMethod: 'POST', headers: auth(), body: JSON.stringify({ days: 0 }) })).window.days, 30);
}

console.log('\n5. the invoice document');
{
  const m = invoice.invoiceModel({
    order: SQ_ORDER,
    customer: { name: 'Jane Doe', email: 'jane@example.com', phone: '305-555-0100' },
    address: { street: '1 Test St', city: 'Miami', state: 'FL', zip: '33101' },
  });
  ok('invoice number', m.number, 'FP-123456');
  ok('subtotal is the sum of PRE-tax line amounts', m.subtotal_cents, 34500);
  ok('total comes from Square', m.total_cents, 36740);
  ok('unpaid by default', m.paid, false);

  const html = invoice.invoiceHtml(m);
  okTrue('carries the logo', html.includes('theforgepeptides.com/assets/logo.png'));
  okTrue('names the order number', html.includes('FP-123456'));
  okTrue('shows the Zelle instructions while unpaid', html.includes('@forgepeptides'));
  okTrue('states the total', html.includes('$367.40'));
  // 🚨 Compliance is part of the template, not an optional footer.
  okTrue('carries the research-use-only notice', /research use only and are not for human consumption/i.test(html));
  okTrue('states the age gate', /21 or older/i.test(html));
  okTrue('makes no dosing or medical claim',
    !/(dose|dosage|dosing|mg per|inject|protocol|treat|cure|therapy)/i.test(html.replace(/\d+mg/gi, '')));
  okTrue('escapes hostile input',
    invoice.invoiceHtml({ ...m, customerName: '<script>bad()</script>' }).includes('&lt;script&gt;'));

  const paid = invoice.invoiceHtml({ ...m, paid: true });
  okTrue('a paid invoice says PAID', paid.includes('PAID'));
  okTrue('and drops the payment instructions', !paid.includes('HOW TO PAY'));
}

console.log('\n6. send-invoice endpoint');
{
  const run = (event) => sendInvoice.handler({ headers: {}, httpMethod: 'GET', ...event });
  ok('401 without a token', (await run({})).statusCode, 401);

  routes = {
    'orders/sq-order-1': { status: 200, body: { order: SQ_ORDER } },
    'customers/cust-1': { status: 200, body: { customer: { id: 'cust-1', given_name: 'Jane', family_name: 'Doe', email_address: 'jane@example.com' } } },
    'api.resend.com': { status: 200, body: { id: 'email-1' } },
  };

  calls = [];
  const prev = await run({ headers: auth(), queryStringParameters: { order_id: 'sq-order-1' } });
  ok('preview returns the document', prev.statusCode, 200);
  okTrue('with html', body(prev).html.includes('INVOICE'));
  ok('and the recipient', body(prev).to, 'jane@example.com');
  // 🚨 A preview must never send.
  okTrue('GET sends no email', !calls.some(c => c.url.includes('resend')));

  ok('preview needs an order id', (await run({ headers: auth(), queryStringParameters: {} })).statusCode, 400);

  calls = [];
  const sent = await run({ httpMethod: 'POST', headers: auth(), body: JSON.stringify({ order_id: 'sq-order-1' }) });
  ok('POST sends', sent.statusCode, 200);
  ok('to the customer', body(sent).sent_to, 'jane@example.com');
  const mails = calls.filter(c => c.url.includes('resend'));
  ok('customer copy and owner copy', mails.length, 2);
  ok('customer first', mails[0].body.to[0], 'jane@example.com');
  okTrue('subject names the invoice', /Invoice FP-123456/.test(mails[0].body.subject));

  // A failed owner copy must not report the customer send as failed.
  let n = 0;
  routes['api.resend.com'] = () => (++n === 1 ? { status: 200, body: { id: 'e' } } : { status: 500, body: { message: 'down' } });
  const partial = await run({ httpMethod: 'POST', headers: auth(), body: JSON.stringify({ order_id: 'sq-order-1' }) });
  ok('still a success for the customer', partial.statusCode, 200);
  ok('but the owner copy is reported as failed', body(partial).owner_notified, false);

  routes['api.resend.com'] = { status: 200, body: { id: 'e' } };
  ok('rejects a bad override address',
    (await run({ httpMethod: 'POST', headers: auth(), body: JSON.stringify({ order_id: 'sq-order-1', to: 'not-an-email' }) })).statusCode, 400);

  routes['orders/sq-order-1'] = { status: 200, body: {} };
  ok('404 when Square has no such order',
    (await run({ headers: auth(), queryStringParameters: { order_id: 'sq-order-1' } })).statusCode, 404);
}

console.log(`\n${fail ? `${fail} FAILED, ` : ''}${pass} passed.`);
process.exit(fail ? 1 : 0);
