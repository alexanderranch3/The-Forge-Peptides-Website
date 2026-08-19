// ─────────────────────────────────────────────────────────────────────────────
// Netlify SCHEDULED Function: watchdog.js
// Added 2026-08-19. Schedule lives in netlify.toml, not here.
//
// Runs the store probes in _watchdog.js every six hours and records the result.
// The probes and their reasoning are all in that file; this is only the wiring.
//
// 🚨 WHY IT RUNS HERE AND NOWHERE ELSE
// Not the Minisforum scheduler: `_agentic-os/logs/` has had no write since
// 2026-08-04, so that layer is confirmed dead rather than merely unverified, and
// a monitor built on a dead scheduler produces silence — which is
// indistinguishable from good news. Not a Claude scheduled task either: those
// only fire while the Claude app is open. This runs where the site runs. If the
// site is up the monitor is up, and if the site is down, that is the alert.
//
// ⚠️ THE SCHEDULE IS NOT THE ALERT PATH. Alerts land as a banner on
// /admin.html, and that banner calls get-watchdog.js, which runs the probes
// LIVE. This scheduled run exists to build a history in `health_checks`, to give
// Netlify's own function log a failure trail, and to be the hook SMS attaches to
// once 10DLC clears. If this schedule silently stops — the account hit a credit
// cap as recently as 2026-08-18 — the banner still tells the truth, and says how
// long it has been since a scheduled run reported.
//
// Contract: 200 with the full result when every probe passed, 500 when any probe
// failed or could not answer. Netlify records a non-2xx invocation as a failure,
// which is the trail a .bat file could never give us.
// ─────────────────────────────────────────────────────────────────────────────

const { runWatchdog, recordRun } = require('./_watchdog');

exports.handler = async () => {
  const result = await runWatchdog();
  const persistence = await recordRun(result, 'scheduled');

  // Console output is the Netlify function log. Keep the one-line verdict
  // greppable and put the detail underneath it.
  console.log(`watchdog: ${result.summary.ok ? 'clean' : 'FINDINGS'} — `
    + `${result.summary.findings} finding(s), `
    + `failing: [${result.summary.failing.join(', ')}], `
    + `unanswered: [${result.summary.unanswered.join(', ')}]`);
  if (!result.summary.ok) {
    console.error('watchdog detail:', JSON.stringify(result.probes.filter((p) => !p.ok), null, 2));
  }

  return {
    statusCode: result.summary.ok ? 200 : 500,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({ ...result, persistence }, null, 2),
  };
};
