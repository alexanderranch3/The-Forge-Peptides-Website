// ─────────────────────────────────────────────────────────────────────────────
// Netlify Function: get-watchdog.js
// Added 2026-08-19. What the /admin.html banner reads.
//
// 🔑 IT RUNS THE PROBES LIVE rather than serving the last scheduled result, and
// that is the most important decision in this feature. A banner reading a stored
// run would show a confident green whenever the schedule stopped firing — and
// the account hit a Netlify credit cap on 2026-08-18, so that is not a
// hypothetical. Stale good news is the failure this whole watchdog exists to
// prevent; it must not be built into the one surface Frank actually looks at.
//
// It also reports how long ago the SCHEDULED run last reported, so the banner
// can say when the background watch itself has gone quiet.
//
// 🔐 Behind the same admin token as get-stock.js. The findings name products,
// order numbers, quantities and costs — the commercially sensitive shape of the
// business. Unlike get-inventory.js this must never be public.
//
// ⚠️ Netlify scheduled functions are not reachable over HTTP in production, so
// this endpoint exists separately from watchdog.js rather than being one file
// with two entry points. Both are thin wrappers over _watchdog.js, which holds
// every probe, so the banner and the schedule can never test different things.
// ─────────────────────────────────────────────────────────────────────────────

const { verifyToken } = require('./_auth-token');
const { runWatchdog, recordRun, lastRunAt } = require('./_watchdog');

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  const SECRET = process.env.ADMIN_TOKEN_SECRET;
  if (!SECRET) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ADMIN_TOKEN_SECRET not configured.' }) };
  }
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  if (!verifyToken(SECRET, authHeader.replace(/^Bearer\s+/i, ''))) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    // The scheduled-run age is read first and separately: it must still be
    // reported even if the probes themselves fall over.
    const [scheduled, result] = await Promise.all([lastRunAt(), runWatchdog()]);

    // 🔑 Recorded like any other run. Opening the dashboard is a real
    // observation of the store and belongs in the history; and it means a
    // manual look also refreshes the "last run" clock honestly.
    const persistence = await recordRun(result, 'admin');

    return {
      statusCode: 200,   // 200 = the watchdog answered. The verdict is in the body.
      headers,
      body: JSON.stringify({ ...result, scheduled_run: scheduled, persistence }),
    };
  } catch (err) {
    console.error('get-watchdog error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
