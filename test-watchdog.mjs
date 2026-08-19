// Tests the store watchdog: every probe in netlify/functions/_watchdog.js, and
// the rule that holds the whole thing up — a probe that cannot answer must go
// RED, never quietly green.
//
// No network. Probes are pure functions of a `sources` bundle, so each failure
// mode is fabricated directly. That is the point of the split: a monitor is the
// one piece of code whose bugs are invisible by construction, so its faults
// have to be reachable from a test rather than from production.
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

const W = require('./netlify/functions/_watchdog.js');
const NOW = Date.parse('2026-08-19T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

// A store with nothing wrong with it. Every test starts here and breaks one thing.
const CLEAN = () => ({
  inventory: { ok: true, error: null, rows: [
    { variant_id: 'v-reta10', product_name: 'Retatrutide', variant_name: '10mg', is_hidden: false,
      site_catalog_id: 'retatrutide-10mg', on_hand: 37, price_cents: 16000, unit_cost_cents: 4200, status: 'OK' },
    { variant_id: 'v-dsip',   product_name: 'DSIP 5MG', variant_name: null, is_hidden: false,
      site_catalog_id: 'dsip-5mg', on_hand: 12, price_cents: 6200, unit_cost_cents: 1800, status: 'OK' },
  ] },
  unfulfillable:   { ok: true, error: null, rows: [] },
  blockedVariants: { ok: true, error: null, rows: [] },
  unmappedSales:   { ok: true, error: null, rows: [] },
  orders: { ok: true, error: null, rows: [
    { id: 'o1', order_no: 'FP-000001', purpose: 'SALE', state: 'OPEN', payment_state: 'PAID',
      placed_at: daysAgo(1), total_cents: 16000, tenders: [{ id: 't1' }], order_line_items: [{ id: 'li1', kind: 'PRODUCT' }] },
  ] },
  saleLedger: { ok: true, error: null, rows: [] },
  storefront: { ok: true, error: null, source: 'dashboard', feed: {
    'retatrutide-10mg': { soldOut: false, price: 160, onHand: 37 },
    'dsip-5mg':         { soldOut: false, price: 62,  onHand: 12 },
    _source: 'dashboard',
  } },
  now: NOW,
});

const withRows = (key, rows) => { const s = CLEAN(); s[key] = { ok: true, error: null, rows }; return s; };
const broken   = (key)       => { const s = CLEAN(); s[key] = { ok: false, error: 'Supabase 503: upstream down', rows: null, feed: null }; return s; };

console.log('\n1. a healthy store reports clean');
{
  const { probes, summary } = W.evaluate(CLEAN());
  ok('every probe ran', probes.filter((p) => p.answered).length, probes.length);
  ok('nothing failing', summary.failing, []);
  ok('no findings', summary.findings, 0);
  ok('overall ok', summary.ok, true);
  ok('no severity to report', summary.worst_severity, null);
}

console.log('\n2. 🚨 THE RULE: a probe that cannot answer is a finding, never a pass');
{
  const s = broken('inventory');
  const neg = W.probeNegativeStock(s);
  ok('it does not claim to have answered', neg.answered, false);
  ok('and it is NOT ok', neg.ok, false);
  okTrue('and it says why', /503/.test(neg.unanswered_reason));
  ok('with no findings invented', neg.findings, []);

  const { summary } = W.evaluate(s);
  ok('the whole run goes red', summary.ok, false);
  okTrue('and names what went blind', summary.unanswered.includes('negative_stock'));
  // Blindness must not be softened into a warning — see summarize().
  ok('blindness is critical, not advisory', summary.worst_severity, 'critical');
}
{
  // The storefront being unreachable blinds a different set.
  const { summary } = W.evaluate(broken('storefront'));
  okTrue('a dead storefront blinds sold_out_with_stock', summary.unanswered.includes('sold_out_with_stock'));
  okTrue('and no_live_answer', summary.unanswered.includes('no_live_answer'));
  okTrue('and price_drift', summary.unanswered.includes('price_drift'));
  ok('the run is red', summary.ok, false);
}

console.log('\n3. 🔴 negative stock');
{
  const s = withRows('inventory', [{ variant_id: 'v1', product_name: 'Tesamorelin', variant_name: '10mg',
    site_catalog_id: 'tesamorelin-10mg', on_hand: -3, price_cents: 8900, unit_cost_cents: 2000 }]);
  const r = W.probeNegativeStock(s);
  ok('it fires', r.ok, false);
  ok('naming the product', r.findings[0].product, 'Tesamorelin 10mg');
  ok('and the number', r.findings[0].on_hand, -3);
  ok('zero is not negative', W.probeNegativeStock(withRows('inventory',
    [{ variant_id: 'v1', product_name: 'X', on_hand: 0, site_catalog_id: 'dsip-5mg' }])).ok, true);
}

console.log('\n4. 🔴 the Semax class — an unpinned variant that name-matches anyway');
{
  // The real 2026-08-19 shape, pre-migration-020: the combo unpinned, its name
  // resolving onto standalone Semax, its 3 vials offered as a product with none.
  const s = withRows('inventory', [{ variant_id: 'v-semax', product_name: 'Semax 10mg', variant_name: null,
    site_catalog_id: null, on_hand: 3, price_cents: 9900, unit_cost_cents: 3000 }]);
  const r = W.probeUnpinnedVariant(s);
  ok('it fires', r.ok, false);
  ok('and says what it resolves to', r.findings[0].resolves_to, 'semax-10mg');

  // 🔑 The three left unpinned ON PURPOSE must stay quiet, or the banner is red
  // forever and gets ignored. nameToId returns null for all three by design.
  const deliberate = withRows('inventory', [
    { variant_id: 'a', product_name: 'Retatrutide', variant_name: '12mg', site_catalog_id: null, on_hand: 0 },
    { variant_id: 'b', product_name: 'Retatrutide', variant_name: '24mg', site_catalog_id: null, on_hand: 0 },
    { variant_id: 'c', product_name: 'SEMAX / SELANK (5MG/5MG]', variant_name: null, site_catalog_id: null, on_hand: 3 },
  ]);
  ok('the deliberately-unpinned three stay quiet', W.probeUnpinnedVariant(deliberate).findings, []);
  // And a pinned row is never questioned, whatever its name would have matched.
  ok('a pinned row is not reported', W.probeUnpinnedVariant(withRows('inventory',
    [{ variant_id: 'd', product_name: 'Semax 10mg', site_catalog_id: 'semax-10mg', on_hand: 3 }])).ok, true);
}

console.log('\n5. 🔴 two things sharing one storefront id');
{
  // ⚠️ The legitimate case _stock.js is built around: one storefront product,
  // two catalog rows from history, summed on purpose. Must NOT fire.
  const legit = withRows('inventory', [
    { variant_id: 'v4', product_name: 'DSIP 5MG', variant_name: null, site_catalog_id: 'dsip-5mg', on_hand: 4, price_cents: 6200 },
    { variant_id: 'v5', product_name: 'DSIP 5MG', variant_name: null, site_catalog_id: 'dsip-5mg', on_hand: 3, price_cents: 6200 },
  ]);
  ok('same product, same price, two rows — quiet', W.probeDuplicateSiteId(legit).ok, true);

  const twoProducts = withRows('inventory', [
    { variant_id: 'v1', product_name: 'Retatrutide', variant_name: '10mg', site_catalog_id: 'retatrutide-10mg', on_hand: 5, price_cents: 16000 },
    { variant_id: 'v2', product_name: 'Semax',       variant_name: '10mg', site_catalog_id: 'retatrutide-10mg', on_hand: 3, price_cents: 16000 },
  ]);
  ok('two different products on one id fires', W.probeDuplicateSiteId(twoProducts).ok, false);

  const twoPrices = withRows('inventory', [
    { variant_id: 'v1', product_name: 'Retatrutide', variant_name: '10mg', site_catalog_id: 'retatrutide-10mg', on_hand: 5, price_cents: 16000 },
    { variant_id: 'v2', product_name: 'Retatrutide', variant_name: '15mg', site_catalog_id: 'retatrutide-10mg', on_hand: 5, price_cents: 19500 },
  ]);
  // The oversell that a name check alone would miss: same product, two sizes.
  ok('same product at two prices fires', W.probeDuplicateSiteId(twoPrices).ok, false);
  okTrue('and says the stock is pooled across a price difference',
    /pooled/.test(W.probeDuplicateSiteId(twoPrices).findings[0].what));
}

console.log('\n6. 🔴 a sold line that took money and moved no stock');
{
  const s = withRows('unmappedSales', [{ order_no: 'FP-001158', placed_at: daysAgo(3),
    name_at_sale: 'Retatrutide 30mg', quantity: 1, line_item_id: 'li9', revenue_cents: 27500 }]);
  const r = W.probeUnmappedSoldLine(s);
  ok('it fires', r.ok, false);
  ok('naming the order', r.findings[0].order_no, 'FP-001158');
  ok('and what was sold', r.findings[0].sold_as, 'Retatrutide 30mg');
}

console.log('\n7. 🔴 on sale with no cost');
{
  const s = withRows('inventory', [{ variant_id: 'v1', product_name: 'Glow Blend', variant_name: null,
    site_catalog_id: 'glow-blend', on_hand: 11, price_cents: 16500, unit_cost_cents: null }]);
  ok('it fires', W.probeSellableNoCost(s).ok, false);

  // Nothing on the shelf means nothing is being sold at an unknown margin.
  const empty = withRows('inventory', [{ variant_id: 'v1', product_name: 'Glow Blend',
    site_catalog_id: 'glow-blend', on_hand: 0, price_cents: 16500, unit_cost_cents: null }]);
  ok('zero stock is not a finding', W.probeSellableNoCost(empty).ok, true);

  // Blocked from sale, so its margin is not currently anybody's problem.
  const blocked = withRows('inventory', [{ variant_id: 'v1', product_name: 'BPC-157 10mg',
    site_catalog_id: 'bpc-157-10mg', on_hand: 9, price_cents: 5000, unit_cost_cents: null }]);
  blocked.unfulfillable = { ok: true, error: null, rows: [{ site_catalog_id: 'bpc-157-10mg', reason: 'No labels yet' }] };
  ok('a blocked product is not reported', W.probeSellableNoCost(blocked).ok, true);

  // A dashboard variant the storefront does not sell cannot be sold at any margin.
  const notSold = withRows('inventory', [{ variant_id: 'v1', product_name: 'Retatrutide', variant_name: '24mg',
    site_catalog_id: 'retatrutide-24mg', on_hand: 4, price_cents: 30000, unit_cost_cents: null }]);
  ok('a product the site does not sell is not reported', W.probeSellableNoCost(notSold).ok, true);
}

console.log('\n8. 🟠 the Retatrutide shape — sold out with stock on the shelf');
{
  const s = CLEAN();
  s.storefront.feed['retatrutide-10mg'] = { soldOut: true, price: 160 };
  const r = W.probeSoldOutWithStock(s);
  ok('it fires', r.ok, false);
  ok('naming the product', r.findings[0].product, 'Retatrutide 10mg');
  ok('and the stock being hidden', r.findings[0].on_hand, 37);

  // A deliberately blocked product reading sold out is correct, not a fault.
  const blocked = CLEAN();
  blocked.storefront.feed['dsip-5mg'] = { soldOut: true, price: 62, unavailable: 'No labels yet' };
  blocked.unfulfillable = { ok: true, error: null, rows: [{ site_catalog_id: 'dsip-5mg', reason: 'No labels yet' }] };
  ok('a blocked product reading sold out is fine', W.probeSoldOutWithStock(blocked).ok, true);
}

console.log('\n9. 🟠 the storefront has no live answer at all');
{
  // The real production case found while proving these probes: Retatrutide 30mg
  // is in CATALOG at $275 and holds 10 vials, but get-inventory builds from
  // SQUARE's catalog and never emits a key for it, so its card can never go
  // sold out however low stock falls.
  const s = CLEAN();
  s.inventory.rows.push({ variant_id: 'v-reta30', product_name: 'Retatrutide', variant_name: '30mg',
    site_catalog_id: 'retatrutide-30mg', on_hand: 10, price_cents: 27500, unit_cost_cents: 9000 });
  const r = W.probeNoLiveAnswer(s);
  ok('it fires', r.ok, false);
  ok('naming the product', r.findings[0].site_catalog_id, 'retatrutide-30mg');
  // 🔑 It must be told apart from sold_out_with_stock: not answering and
  // answering wrongly are different faults with different fixes.
  ok('and it is NOT reported as sold-out-with-stock', W.probeSoldOutWithStock(s).ok, true);
}

console.log('\n10. 🟠 blocked long enough to be a dead product');
{
  const fresh = withRows('blockedVariants', [{ id: 'v1', name: 'BPC-157 10mg', site_catalog_id: 'bpc-157-10mg',
    unfulfillable_reason: 'No labels yet', updated_at: daysAgo(1) }]);
  ok('blocked yesterday is fine', W.probeBlockedTooLong(fresh).ok, true);

  const stale = withRows('blockedVariants', [{ id: 'v1', name: 'BPC-157 10mg', site_catalog_id: 'bpc-157-10mg',
    unfulfillable_reason: 'No labels yet', updated_at: daysAgo(30) }]);
  const r = W.probeBlockedTooLong(stale);
  ok('blocked for 30 days fires', r.ok, false);
  ok('and counts the days', r.findings[0].days_blocked, 30);
  ok(`the boundary itself does not fire (${W.BLOCKED_DAYS}d)`, W.probeBlockedTooLong(
    withRows('blockedVariants', [{ id: 'v1', name: 'X', updated_at: daysAgo(W.BLOCKED_DAYS) }])).ok, true);
}

console.log('\n11. 🟡 the till has gone quiet');
{
  ok('a sale yesterday is fine', W.probeQuietOrderFeed(CLEAN()).ok, true);
  const quiet = withRows('orders', [{ id: 'o1', order_no: 'FP-000001', purpose: 'SALE', state: 'OPEN',
    payment_state: 'PAID', placed_at: daysAgo(20), total_cents: 100, tenders: [{ id: 't' }], order_line_items: [] }]);
  const r = W.probeQuietOrderFeed(quiet);
  ok('twenty days of silence fires', r.ok, false);
  ok('and counts them', r.findings[0].days_since_last_order, 20);
  ok('it is advisory, not critical', r.severity, 'advisory');
  ok('no orders at all is a finding too', W.probeQuietOrderFeed(withRows('orders', [])).ok, false);
}

console.log('\n12. 🟡 paid with no tender — the bug migration 018 fixed');
{
  const s = withRows('orders', [{ id: 'o1', order_no: 'FP-000900', purpose: 'SALE', state: 'OPEN',
    payment_state: 'PAID', placed_at: daysAgo(2), total_cents: 27500, tenders: [], order_line_items: [] }]);
  const r = W.probePaidNoTender(s);
  ok('it fires', r.ok, false);
  ok('naming the order', r.findings[0].order_no, 'FP-000900');
  ok('and its missing money', r.findings[0].total_cents, 27500);
  // Not yet paid is not the same fault — that order is simply awaiting Zelle.
  const awaiting = withRows('orders', [{ id: 'o1', order_no: 'FP-000901', purpose: 'SALE', state: 'OPEN',
    payment_state: 'AWAITING_PAYMENT', placed_at: daysAgo(2), total_cents: 100, tenders: [], order_line_items: [] }]);
  ok('awaiting payment is not reported', W.probePaidNoTender(awaiting).ok, true);
}

console.log('\n13. 🟡 stock left the shelf and no money came in');
{
  const s = CLEAN();
  s.orders = { ok: true, error: null, rows: [
    { id: 'o1', order_no: 'FP-000950', purpose: 'SALE', state: 'OPEN', payment_state: 'AWAITING_PAYMENT',
      placed_at: daysAgo(4), total_cents: 16000, tenders: [], order_line_items: [{ id: 'li7', kind: 'PRODUCT' }] },
  ] };
  s.saleLedger = { ok: true, error: null, rows: [{ id: 'sl1', variant_id: 'v-reta10', delta: -2, order_line_item_id: 'li7' }] };
  const r = W.probeStockMovedNoMoney(s);
  ok('it fires', r.ok, false);
  ok('naming the order', r.findings[0].order_no, 'FP-000950');
  ok('and counting the units', r.findings[0].units, 2);

  // 🔑 Frank's own stock, and giveaways, legitimately move stock with no money.
  const internal = { ...s, orders: { ok: true, error: null, rows: [{ ...s.orders.rows[0], purpose: 'INTERNAL' }] } };
  ok('an INTERNAL order is not a finding', W.probeStockMovedNoMoney(internal).ok, true);
  const comped = { ...s, orders: { ok: true, error: null, rows: [{ ...s.orders.rows[0], purpose: 'COMP' }] } };
  ok('a COMP order is not a finding', W.probeStockMovedNoMoney(comped).ok, true);
}

console.log('\n14. 🟡 the page shows one price and checkout charges another');
{
  const s = CLEAN();
  s.storefront.feed['retatrutide-10mg'] = { soldOut: false, price: 155 };
  const r = W.probePriceDrift(s);
  ok('it fires', r.ok, false);
  ok('reporting what is shown', r.findings[0].shown_price, 155);
  ok('and what is charged', r.findings[0].charged_price, 160);

  // 🚨 A product missing from CATALOG cannot be bought at ANY price, whatever
  // the page says — the trap already written into PROJECT-NOTES.
  const ghost = CLEAN();
  ghost.storefront.feed['tirzepatide-10mg'] = { soldOut: false, price: 210 };
  const g = W.probePriceDrift(ghost);
  ok('a product checkout has never heard of fires', g.ok, false);
  okTrue('and says it cannot be bought at any price', /any price/.test(g.findings[0].what));

  // A null price means the card keeps its static one. Not drift.
  const nullPrice = CLEAN();
  nullPrice.storefront.feed['bpc-157-10mg'] = { soldOut: true, price: null, unavailable: 'No labels yet' };
  ok('a null price is not drift', W.probePriceDrift(nullPrice).ok, true);
  ok('and _source is not treated as a product', W.probePriceDrift(CLEAN()).ok, true);
}

console.log('\n15. the summary reports the worst thing, not the first');
{
  const s = CLEAN();
  s.storefront.feed['dsip-5mg'] = { soldOut: true, price: 62 };             // hides → warning
  ok('one warning reads as a warning', W.summarize(W.evaluate(s).probes).worst_severity, 'warning');

  // 🔑 A DIFFERENT product goes negative. Taking the hidden one below zero
  // would silence sold_out_with_stock instead of adding to it — stock you do
  // not have cannot be stock you are hiding.
  s.inventory.rows[0] = { ...s.inventory.rows[0], on_hand: -1 };            // sells → critical
  const worst = W.summarize(W.evaluate(s).probes);
  ok('a critical outranks it', worst.worst_severity, 'critical');
  okTrue('and both are still named', worst.failing.includes('sold_out_with_stock') && worst.failing.includes('negative_stock'));
  okTrue('the count is of findings, not probes', worst.findings >= 2);
}

console.log('\n16. 🚨 who watches the watchman — a manual look must not fake a scheduled run');
{
  // get-watchdog records into the same table as the schedule. If those rows were
  // indistinguishable, opening the dashboard would refresh the "last scheduled
  // run" clock and a schedule that died weeks ago would read as healthy.
  let sent = [], queries = [];
  global.fetch = async (url, opts = {}) => {
    if (opts.method === 'POST') { sent.push(JSON.parse(opts.body)); return { ok: true, status: 201, text: async () => '' }; }
    queries.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify([{ checked_at: '2026-08-19T06:00:00.000Z' }]) };
  };

  const result = { probes: W.evaluate(CLEAN()).probes };
  const r1 = await W.recordRun(result, 'scheduled');
  ok('a scheduled run is recorded', r1.logged, true);
  okTrue('and every row carries the tag', sent[0].every((row) => row.detail.trigger === 'scheduled'));
  okTrue('under a prefix that identifies the watchdog', sent[0].every((row) => row.probe.startsWith(W.PROBE_PREFIX)));

  sent = [];
  ok('an admin run is recorded too', (await W.recordRun(result, 'admin')).logged, true);
  ok('tagged as admin', sent[0][0].detail.trigger, 'admin');

  // Refusing rather than defaulting: an untagged row would silently corrupt the
  // one query that tells us whether the schedule is alive.
  const untagged = await W.recordRun(result);
  ok('an untagged run is refused, not defaulted', untagged.logged, false);
  okTrue('and says why', /untagged/.test(untagged.reason));

  await W.lastRunAt();
  const q = queries[queries.length - 1];
  okTrue('the last-run query asks only for scheduled runs', q.includes('trigger=eq.scheduled'));
  okTrue('and takes the newest one', q.includes('order=checked_at.desc') && q.includes('limit=1'));
}

console.log('\n17. a logging outage changes no verdict');
{
  global.fetch = async () => { throw new Error('network down'); };
  const before = W.evaluate(CLEAN()).summary.ok;
  const rec = await W.recordRun({ probes: W.evaluate(CLEAN()).probes }, 'scheduled');
  ok('recording fails', rec.logged, false);
  ok('but the store is still reported clean', W.evaluate(CLEAN()).summary.ok, before);
  const last = await W.lastRunAt();
  ok('and an unreadable history says so rather than claiming freshness', last.known, false);
}

console.log('\n18. end to end, with the network stubbed');
{
  const rows = {
    v_inventory_dashboard: [
      { variant_id: 'v1', product_name: 'Retatrutide', variant_name: '10mg', is_hidden: false,
        site_catalog_id: 'retatrutide-10mg', on_hand: 37, price_cents: 16000, unit_cost_cents: 4200, status: 'OK' },
    ],
    v_unfulfillable: [],
    variants: [],
    v_product_sales: [],
    orders: [{ id: 'o1', order_no: 'FP-1', purpose: 'SALE', state: 'OPEN', payment_state: 'PAID',
      placed_at: new Date().toISOString(), total_cents: 16000, tenders: [{ id: 't' }], order_line_items: [] }],
  };
  let hitSite = null;
  global.fetch = async (url, opts = {}) => {
    if (opts.method === 'POST') return { ok: true, status: 201, text: async () => '' };
    if (url.includes('/get-inventory')) {
      hitSite = url;
      return { ok: true, status: 200, text: async () => JSON.stringify({
        'retatrutide-10mg': { soldOut: false, price: 160, onHand: 37 }, _source: 'dashboard' }) };
    }
    const table = Object.keys(rows).find((t) => url.includes(`/rest/v1/${t}`));
    return { ok: true, status: 200, text: async () => JSON.stringify(table ? rows[table] : []) };
  };

  const out = await W.runWatchdog();
  ok('a clean store runs clean end to end', out.summary.ok, true);
  ok('every probe reported', out.probes.length, 13);
  okTrue('it probed the real storefront over HTTP', /\/\.netlify\/functions\/get-inventory$/.test(hitSite));
  // 🚨 theforgepeptides.com is the Netlify store. forgedpeptides.com is a
  // different site on Wix — probing it would health-check the wrong thing.
  okTrue('and not the Wix domain', !/forgedpeptides\.com/.test(hitSite));

  // Now break the storefront and confirm the run refuses to call it clean.
  global.fetch = async (url, opts = {}) => {
    if (opts.method === 'POST') return { ok: true, status: 201, text: async () => '' };
    if (url.includes('/get-inventory')) return { ok: false, status: 502, text: async () => 'bad gateway' };
    const table = Object.keys(rows).find((t) => url.includes(`/rest/v1/${t}`));
    return { ok: true, status: 200, text: async () => JSON.stringify(table ? rows[table] : []) };
  };
  const down = await W.runWatchdog();
  ok('a dead storefront is never reported clean', down.summary.ok, false);
  okTrue('and the infra probe names it', down.probes.find((p) => p.probe === 'reachable').findings.length > 0);
}

console.log(`\n${fail ? `${fail} FAILED, ` : ''}${pass} passed.`);
process.exit(fail ? 1 : 0);
