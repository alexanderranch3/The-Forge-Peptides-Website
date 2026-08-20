// ─────────────────────────────────────────────────────────────────────────────
// _finance.js — every figure the Finance tab shows, as pure functions of a
// fetched-once bundle. No network in here; get-finance.js does the fetching.
// Same shape as _watchdog.js, and for the same reason: the maths is testable
// without a database, so a wrong total can be caught before it is deployed.
//
// 🔑 THE ONE RULE THIS FILE EXISTS TO KEEP: revenue, COGS and profit are READ
// from v_product_sales, never recomputed. This file only ever ADDS UP figures
// the view already decided. Two surfaces that each work out margin from prices
// and costs will disagree eventually, and then nobody knows which is the books.
//
// 🚨 WHAT "REVENUE" MEANS HERE, because it is not the same as cash:
//   revenue_cents  = product lines, after line discounts, BEFORE sales tax.
//   Cash collected = that, plus tax, plus shipping and balance-due lines, minus
//                    any order-level discount that was never pushed down to the
//                    lines (FP-001159 is the one such order today: $160 of lines
//                    on a $144 order). The Cash section shows the bridge between
//                    the two rather than picking one and hoping.
//
// 🚨 v_product_sales SILENTLY EXCLUDES an order with no tender — that is how a
// paid-but-untendered order once went missing from revenue entirely (fixed by
// migration 026). So `awaiting` counts and totals those orders explicitly:
// money not in revenue is stated, never just absent.
//
// ⚠️ Do NOT reach for v_tender_summary for cash. It joins orders without
// filtering state, so it counts tenders on CANCELED orders — $16,328.50 against
// a real $15,313.24 on 2026-08-20. Cash here is built from the same order set
// the revenue figures come from, which is what makes the bridge add up.
// ─────────────────────────────────────────────────────────────────────────────

// Postgres sends bigint/numeric as strings over PostgREST. Coerce at every
// boundary so nothing here ever concatenates two amounts by accident.
const int = (v) => (v === null || v === undefined ? null : Math.round(Number(v)));
const num = (v) => (v === null || v === undefined ? 0 : Number(v));

// ── Dates ────────────────────────────────────────────────────────────────────
// Everything buckets by the LOCAL date in America/New_York, matching
// _invoice.js. A counter sale rung up at 8pm on the 31st is that month's sale;
// bucketing the raw UTC timestamp would file it in the next one.
const NY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});

function nyDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return NY.format(d);            // 'YYYY-MM-DD'
}

// 'YYYY-MM-DD' arithmetic done as UTC midnight. Safe because the result is only
// ever compared against other local-date strings — it is never converted back
// into a moment, so no daylight-saving hour can shift it.
function shiftDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  const p = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((p(to) - p(from)) / 86400000);
}

const MONTH_LABEL = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (key) => `${MONTH_LABEL[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;

const PERIODS = {
  '30':  { label: 'Last 30 days',  days: 30 },
  '90':  { label: 'Last 90 days',  days: 90 },
  '365': { label: 'Last 12 months', days: 365 },
  ytd:   { label: 'This year' },
  all:   { label: 'All time' },
};

// Resolves a period name into an inclusive local-date window, plus the equal
// length window immediately before it. The comparison window is what answers
// "are sales moving", so it is derived here rather than in the page.
function resolvePeriod(period, now = new Date()) {
  const today = nyDate(now.toISOString());
  const spec = PERIODS[period] || PERIODS.all;

  if (period === 'all' || !PERIODS[period]) {
    return { period: 'all', label: PERIODS.all.label, from: null, to: today, previous: null };
  }

  const from = period === 'ytd'
    ? `${today.slice(0, 4)}-01-01`
    : shiftDays(today, -(spec.days - 1));

  const length = daysBetween(from, today) + 1;
  const prevTo = shiftDays(from, -1);
  const prevFrom = shiftDays(prevTo, -(length - 1));

  return {
    period, label: spec.label, from, to: today,
    days: length,
    previous: { from: prevFrom, to: prevTo, days: length },
  };
}

const inWindow = (date, from, to) => date !== null && (from === null || date >= from) && (to === null || date <= to);

// ── Buckets ──────────────────────────────────────────────────────────────────
function blank() {
  return {
    orderIds: new Set(), lines: 0, units: 0,
    revenue_cents: 0, cogs_cents: 0, profit_cents: 0, tax_cents: 0,
    lines_missing_cost: 0, last_sold: null,
  };
}

// 🔑 A line with no recorded cost contributes REVENUE but not cost or profit —
// the view reports profit as NULL there, and adding the revenue while skipping
// the cost would quietly overstate profit. The count is carried alongside so
// the figure can be marked incomplete instead of looking merely low.
function add(b, r) {
  b.orderIds.add(r.order_id);
  b.lines += 1;
  b.units += num(r.quantity);
  b.revenue_cents += int(r.revenue_cents) || 0;
  b.tax_cents += int(r.sales_tax_cents) || 0;
  if (r.cogs_cents === null || r.cogs_cents === undefined || r.profit_cents === null || r.profit_cents === undefined) {
    b.lines_missing_cost += 1;
  } else {
    b.cogs_cents += int(r.cogs_cents);
    b.profit_cents += int(r.profit_cents);
  }
  const d = nyDate(r.placed_at);
  if (d && (!b.last_sold || d > b.last_sold)) b.last_sold = d;
}

// Matches v_product_margin exactly: margin is blank, not zero and not a guess,
// wherever any sold unit has no recorded cost.
function seal(b) {
  const orders = b.orderIds.size;
  return {
    orders,
    lines: b.lines,
    units: Math.round(b.units * 1000) / 1000,
    revenue_cents: b.revenue_cents,
    cogs_cents: b.cogs_cents,
    profit_cents: b.profit_cents,
    tax_cents: b.tax_cents,
    lines_missing_cost: b.lines_missing_cost,
    margin_pct: (b.lines_missing_cost === 0 && b.revenue_cents > 0)
      ? Math.round((1000 * b.profit_cents) / b.revenue_cents) / 10
      : null,
    avg_order_cents: orders ? Math.round(b.revenue_cents / orders) : 0,
    last_sold: b.last_sold,
  };
}

function bucketBy(rows, keyOf) {
  const map = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (k === null || k === undefined) continue;
    if (!map.has(k)) map.set(k, blank());
    add(map.get(k), r);
  }
  return map;
}

// Percent change, guarding the case that makes naive code print Infinity%:
// growing from nothing. Null means "no baseline to compare against".
function change(now, before) {
  if (before === null || before === undefined || before === 0) return null;
  return Math.round((1000 * (now - before)) / Math.abs(before)) / 10;
}

// ── The bundle → the page's payload ──────────────────────────────────────────
//
// sources = {
//   sales:    v_product_sales rows (one per sold PRODUCT line)
//   orders:   orders rows, purpose SALE, every state
//   tenders:  tenders rows for those orders
//   variants: variants rows (id, name, product_id)
//   products: products rows (id, name)
//   house:    v_house_account_balance rows
// }
function summarise(sources, { period = 'all', now = new Date() } = {}) {
  const win = resolvePeriod(period, now);

  const productName = new Map((sources.products || []).map((p) => [p.id, p.name]));
  // 🔑 Names come from variants/products, NOT v_inventory_dashboard — that view
  // filters hidden variants, so a hidden product's sales would arrive nameless
  // and split across whatever the till happened to type that day.
  const variantName = new Map((sources.variants || []).map((v) => [v.id, {
    product: productName.get(v.product_id) || null,
    variant: v.name || null,
  }]));

  const sales = (sources.sales || []).map((r) => ({ ...r, _date: nyDate(r.placed_at) }));
  const scoped = sales.filter((r) => inWindow(r._date, win.from, win.to));
  const before = win.previous
    ? sales.filter((r) => inWindow(r._date, win.previous.from, win.previous.to))
    : null;

  // Headline
  const totalsBucket = blank();
  scoped.forEach((r) => add(totalsBucket, r));
  const totals = seal(totalsBucket);

  // The earliest sale on record. Everything before it is not a quiet period —
  // it is a period in which the business did not exist.
  const firstSale = sales.reduce((m, r) => (r._date && (!m || r._date < m) ? r._date : m), null);

  let comparison = null;
  if (before) {
    const b = blank();
    before.forEach((r) => add(b, r));
    const prev = seal(b);

    // 🚨 A COMPARISON AGAINST A WINDOW THAT PREDATES THE FIRST SALE IS NOT
    // GROWTH. The 90-day view once reported "+850% revenue, +1150% orders"
    // against the fortnight of trading that happened to fall inside its
    // baseline — arithmetically true and completely meaningless. The page says
    // there is no like-for-like baseline rather than printing a number that
    // flatters the business by the accident of when it opened.
    const partialBaseline = Boolean(firstSale && win.previous.from < firstSale);

    comparison = {
      from: win.previous.from, to: win.previous.to,
      revenue_cents: prev.revenue_cents,
      profit_cents: prev.profit_cents,
      orders: prev.orders,
      units: prev.units,
      partial_baseline: partialBaseline,
      first_sale: firstSale,
      revenue_change_pct: partialBaseline ? null : change(totals.revenue_cents, prev.revenue_cents),
      profit_change_pct: partialBaseline ? null : change(totals.profit_cents, prev.profit_cents),
      orders_change_pct: partialBaseline ? null : change(totals.orders, prev.orders),
    };
  }

  // Months — always the FULL history, whatever the period is set to. The trend
  // is the answer to "how are sales moving", and a trend cropped to the window
  // cannot show the shape it is being asked about.
  //
  // 🔑 The months are deliberately NOT filtered or highlighted by the window.
  // A 30-day window starting on the 22nd covers part of July, so highlighting
  // "the months in the window" would invite reading the headline as the sum of
  // the lit bars when it is nothing of the sort. The one flag that IS carried
  // is `partial`: the current month is not over, and a short final bar read as
  // a downturn is the single most likely misreading of this chart.
  const thisMonth = win.to.slice(0, 7);
  const months = [...bucketBy(sales, (r) => (r._date ? r._date.slice(0, 7) : null))]
    .map(([key, b]) => ({
      month: key,
      label: monthLabel(key),
      partial: key === thisMonth,
      ...seal(b),
    }))
    .sort((a, b) => a.month.localeCompare(b.month));

  // Products, biggest profit first — the ordering Frank buys stock from.
  const products = [...bucketBy(scoped, (r) => r.variant_id)]
    .map(([variantId, b]) => {
      const named = variantName.get(variantId);
      const sealed = seal(b);
      return {
        variant_id: variantId,
        // Falls back to whatever the sale was booked as, so an unnamed variant
        // still appears with its money rather than vanishing from the table.
        product: (named && named.product) || null,
        variant: named ? named.variant : null,
        ...sealed,
      };
    })
    .sort((a, b) => b.profit_cents - a.profit_cents || b.revenue_cents - a.revenue_cents);

  const channels = [...bucketBy(scoped, (r) => r.channel)]
    .map(([channel, b]) => ({ channel, ...seal(b) }))
    .sort((a, b) => b.revenue_cents - a.revenue_cents);

  // ── Cash ───────────────────────────────────────────────────────────────────
  const tendersByOrder = new Map();
  for (const t of sources.tenders || []) {
    if (!tendersByOrder.has(t.order_id)) tendersByOrder.set(t.order_id, []);
    tendersByOrder.get(t.order_id).push(t);
  }

  const saleOrders = (sources.orders || [])
    .filter((o) => o.purpose === 'SALE')
    .map((o) => ({ ...o, _date: nyDate(o.placed_at) }))
    .filter((o) => inWindow(o._date, win.from, win.to));

  const live = saleOrders.filter((o) => o.state !== 'CANCELED');
  const tendered = live.filter((o) => (tendersByOrder.get(o.id) || []).length > 0);
  const untendered = live.filter((o) => (tendersByOrder.get(o.id) || []).length === 0);
  const voided = saleOrders.filter((o) => o.state === 'CANCELED');

  const orderTotal = tendered.reduce((n, o) => n + (int(o.total_cents) || 0), 0);

  const byType = new Map();
  let tenderTotal = 0;
  for (const o of tendered) {
    for (const t of tendersByOrder.get(o.id)) {
      const amt = int(t.amount_cents) || 0;
      tenderTotal += amt;
      const row = byType.get(t.type) || { type: t.type, count: 0, amount_cents: 0 };
      row.count += 1;
      row.amount_cents += amt;
      byType.set(t.type, row);
    }
  }
  const tenderRows = [...byType.values()].sort((a, b) => b.amount_cents - a.amount_cents);

  // 🚨 A HOUSE ACCOUNT CHARGE IS A TENDER BUT IT IS NOT CASH. It closes the
  // order and it counts as revenue when charged (Frank's decision), but nobody
  // has been paid yet — so it is separated here rather than added to the money
  // actually in hand.
  const houseCharged = tenderRows.filter((r) => r.type === 'HOUSE_ACCOUNT')
    .reduce((n, r) => n + r.amount_cents, 0);
  const settled = tenderTotal - houseCharged;

  const cash = {
    tendered_orders: tendered.length,
    order_total_cents: orderTotal,
    // The bridge from product revenue to what the orders actually totalled:
    // sales tax, plus shipping / balance-due / custom lines, less any
    // order-level discount that never reached the lines.
    other_lines_cents: orderTotal - totals.revenue_cents - totals.tax_cents,
    tenders: tenderRows,
    tender_total_cents: tenderTotal,
    settled_cents: settled,
    house_charged_cents: houseCharged,
    // Must be zero. It is published rather than asserted so that the day it
    // stops being zero, the page says so instead of quietly rounding.
    unreconciled_cents: tenderTotal - orderTotal,
    awaiting: {
      orders: untendered.length,
      amount_cents: untendered.reduce((n, o) => n + (int(o.total_cents) || 0), 0),
      order_nos: untendered.map((o) => o.order_no).filter(Boolean).slice(0, 12),
    },
    voided: {
      orders: voided.length,
      amount_cents: voided.reduce((n, o) => n + (int(o.total_cents) || 0), 0),
    },
  };

  // ── House accounts (a running balance, not a period figure) ────────────────
  const houseRows = (sources.house || [])
    .map((h) => ({
      party_id: h.party_id,
      name: h.display_name,
      charged_cents: int(h.charged_cents) || 0,
      paid_cents: int(h.paid_cents) || 0,
      balance_cents: int(h.balance_cents) || 0,
      last_charge_at: h.last_charge_at,
      payment_count: int(h.payment_count) || 0,
    }))
    .filter((h) => h.balance_cents !== 0)
    .sort((a, b) => b.balance_cents - a.balance_cents);

  const houseAccounts = {
    owed_cents: houseRows.reduce((n, h) => n + h.balance_cents, 0),
    people: houseRows.length,
    payments_recorded: houseRows.reduce((n, h) => n + h.payment_count, 0),
    rows: houseRows,
  };

  return {
    window: {
      period: win.period, label: win.label,
      from: win.from, to: win.to,
      previous: win.previous,
    },
    totals,
    comparison,
    months,
    products,
    channels,
    cash,
    house_accounts: houseAccounts,
  };
}

module.exports = {
  summarise, resolvePeriod, nyDate, shiftDays, daysBetween, change, monthLabel, PERIODS,
};
