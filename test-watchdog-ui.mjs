// Tests the watchdog banner's collapse and dismiss controls, by running the
// real checkWatchdog/renderWatchdogList out of admin.html.
//
// Added 2026-08-19: Frank could not see the Orders table past a banner that
// lists every finding at once. Collapse and dismiss are the fix — and a dismiss
// button on a MONITOR is the easiest possible way to reintroduce the exact
// failure the live-probe design exists to prevent. So the properties asserted
// here are mostly about what dismissing must NOT be able to do.
//
// 🔑 No jsdom, no package.json, no install — same as every other test in here.
// The shim below is the smallest thing the banner code actually touches, and
// assertions read innerHTML rather than querying nodes, so nothing needs a
// real HTML parser.
import { readFileSync } from 'fs';

let pass = 0, fail = 0;
const ok = (l, c, d = '') => { c ? (pass++, console.log(`  PASS  ${l}`)) : (fail++, console.log(`  FAIL  ${l}${d ? '  — ' + d : ''}`)); };

// ── the shim ────────────────────────────────────────────────────────────────
const mkClassList = (el) => ({
  contains: (c) => el.className.split(/\s+/).includes(c),
  toggle: (c, on) => {
    const has = el.className.split(/\s+/).includes(c);
    const want = on === undefined ? !has : on;
    if (want && !has) el.className = (el.className + ' ' + c).trim();
    if (!want && has) el.className = el.className.split(/\s+/).filter((x) => x !== c).join(' ');
  },
});
const nodes = {};
const el = (id) => {
  if (!nodes[id]) {
    const n = { id, textContent: '', innerHTML: '', className: '', style: {}, disabled: false };
    n.classList = mkClassList(n);
    nodes[id] = n;
  }
  return nodes[id];
};
const store = {};
const localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};

const html = readFileSync(new URL('./admin.html', import.meta.url), 'utf8');
const src = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');

// Only the watchdog half of admin.html is under test; the rest of the file
// expects a browser. Pulling out just these functions keeps the shim honest
// about what it is standing in for.
const WANT = ['WATCH_MAX_ITEMS', 'WATCH_DISMISS_HOURS', 'WD_DISMISS_KEY', 'WD_COLLAPSE_KEY', 'WD_SEEN_KEY',
              'wdRows', 'wdAllRows', 'wdBaseClass', 'wdTitleText', 'wdPrint', 'wdReadMap', 'wdMark',
              'renderWatchdogList', 'toggleWatchdog', 'dismissWatchdogItem', 'dismissAllWatchdog',
              'restoreWatchdog', 'checkWatchdog'];

let WD = null;
// esc() lives elsewhere in admin.html, outside the slice — supplied here rather
// than dragged in, since escaping is not what this test is about.
const ctx = new Function('document', 'localStorage', 'fetch', 'showToast', 'getWD', 'esc', `
  ${src.slice(src.indexOf('const WATCH_MAX_ITEMS'), src.indexOf('// ── Dashboard freshness'))}
  return { ${WANT.join(', ')} };
`)(
  { getElementById: el },
  localStorage,
  async () => ({ ok: true, status: 200, json: async () => WD }),
  () => {},
  () => WD,
  (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
);

const band = () => el('watch-band');
const liCount = () => (el('watch-list').innerHTML.match(/<li(?![^>]*class="dim")/g) || []).length;

const probes = (n, sev = 'critical') => ({
  checked_at: new Date().toISOString(),
  summary: { findings: n, worst_severity: sev },
  scheduled_run: { known: true, at: new Date().toISOString(), age_hours: 1 },
  probes: [{ probe: 'sells_what_we_lack', family: 'sells', ok: false, answered: true,
             findings: Array.from({ length: n }, (_, i) => ({ product: `Peptide ${i}`, what: `oversold by ${i + 1}`, fix: 'recount' })) }],
});

// ── the tests ───────────────────────────────────────────────────────────────
console.log('\n1. findings render, each with a way out');
WD = probes(3);
await ctx.checkWatchdog();
ok('three findings listed', liCount() === 3, `${liCount()}`);
ok('each has a dismiss control', (el('watch-list').innerHTML.match(/wd-x/g) || []).length === 3);
ok('band starts expanded', !band().classList.contains('wd-collapsed'));

console.log('\n2. collapsing keeps the headline');
ctx.toggleWatchdog();
ok('collapsed', band().classList.contains('wd-collapsed'));
ok('🔑 the title survives collapse — a folded band still names the worst thing',
   el('watch-title').textContent.length > 0);
ok('and the choice persists', localStorage.getItem('forge_wd_collapsed') === '1');

console.log('\n3. dismissing one hides it and says so');
ctx.toggleWatchdog();
ctx.dismissWatchdogItem(0);
ok('one fewer listed', liCount() === 2, `${liCount()}`);
ok('🔑 the hidden count stays on screen', /1 finding hidden/.test(el('watch-restore').innerHTML));
ok('and it can be undone', /show it now/.test(el('watch-restore').innerHTML));
ctx.restoreWatchdog();
ok('restoring brings it back', liCount() === 3);

console.log('\n4. dismissing everything leaves a line, not silence');
ctx.dismissAllWatchdog();
ok('🔑 the band did NOT vanish', band().style.display !== 'none');
ok('muted and folded to one line', band().classList.contains('wd-muted') && band().classList.contains('wd-collapsed'));
ok('🔑 and the count is in the title itself', /3 watchdog findings hidden/.test(el('watch-title').textContent));

console.log('\n5. 🔑 a NEW finding overrides a remembered collapse');
localStorage.setItem('forge_wd_collapsed', '1');
WD = probes(1);
WD.probes[0].findings = [{ product: 'BRAND NEW', what: 'never seen before', fix: null }];
await ctx.checkWatchdog();
ok('force-expanded despite the saved preference', !band().classList.contains('wd-collapsed'));
ok('and the new finding is visible', /BRAND NEW/.test(el('watch-list').innerHTML));

console.log('\n6. 🔑 a dismissal expires — there is no permanent silence');
WD = probes(2);
await ctx.checkWatchdog();
ctx.dismissAllWatchdog();
ok('hidden now', liCount() === 0);
const stale = JSON.parse(localStorage.getItem('forge_wd_dismissed'));
for (const k of Object.keys(stale)) stale[k] = Date.now() - 25 * 3600 * 1000;
localStorage.setItem('forge_wd_dismissed', JSON.stringify(stale));
await ctx.checkWatchdog();
ok('back after 24h with no action taken', liCount() === 2, `${liCount()}`);

console.log('\n7. a genuinely clean store still shows nothing');
WD = { checked_at: new Date().toISOString(), summary: { findings: 0, worst_severity: 'info' },
       scheduled_run: { known: true, at: new Date().toISOString(), age_hours: 1 }, probes: [] };
await ctx.checkWatchdog();
ok('band hidden when nothing is wrong', band().style.display === 'none');

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
