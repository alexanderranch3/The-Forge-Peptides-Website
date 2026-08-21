// ─────────────────────────────────────────────────────────────────────────────
// admin-sw.js — the service worker behind Forge Admin on the Home Screen.
//
// It exists for ONE job: receive a push when an order is placed and show a
// notification. Frank's ask was "not a text but just a push notification. That
// way, I can check the dashboard when I want to."
//
// 🚨 IT DELIBERATELY DOES NOT CACHE ANYTHING. A dashboard that serves a stale
// order list from cache is worse than one that fails to load — it would show
// yesterday's revenue with no indication it was old, and every number on that
// screen is a number Frank makes decisions on. Offline support is a feature
// nobody asked for; a wrong figure presented confidently is a real cost. Every
// request goes to the network, exactly as the page behaves in a browser tab.
//
// ⚠️ iOS ONLY DELIVERS WEB PUSH TO A PWA ADDED TO THE HOME SCREEN. In a normal
// Safari tab the permission prompt never appears and subscribe() fails. That is
// Apple's rule, not something this file can work around — admin.html says so on
// screen rather than leaving it looking broken.
// ─────────────────────────────────────────────────────────────────────────────

const SCOPE_URL = '/admin.html';

// A new worker should take over immediately. The alternative is a push arriving
// at a version of this file that was replaced days ago.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// ── The push itself ──────────────────────────────────────────────────────────
// The payload is JSON encrypted by _push.js. Everything here is defensive: a
// push that cannot be parsed must still raise SOMETHING, because on iOS a push
// received without showing a notification counts against the app and repeated
// offences get the subscription dropped by the OS.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch { data = { title: 'New order', body: event.data ? event.data.text() : '' }; }

  const title = data.title || 'New order';
  const options = {
    body: data.body || 'Open the dashboard for details.',
    icon: '/assets/admin-icon-192.png',
    badge: '/assets/admin-icon-192.png',
    // Collapses repeats: two orders in a minute replace rather than stack into
    // a wall of notifications. renotify still buzzes for the second one.
    tag: data.tag || 'forge-order',
    renotify: true,
    timestamp: Date.now(),
    data: { url: data.url || SCOPE_URL, orderNumber: data.orderNumber || null },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// ── Tapping it ───────────────────────────────────────────────────────────────
// Focus the dashboard if it is already open rather than opening a second copy.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || SCOPE_URL;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if (client.url.includes('/admin.html') && 'focus' in client) {
        if ('navigate' in client && target !== client.url) { try { await client.navigate(target); } catch { /* focus anyway */ } }
        return client.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});

// ── Re-subscription ──────────────────────────────────────────────────────────
// A push service can rotate a subscription on its own; when it does, the old
// endpoint stops working and nothing tells the user. This fires on that event
// so the new endpoint reaches the server.
//
// ⚠️ Best-effort only: save-push-subscription is token-gated and a service
// worker has no admin token, so this posts to the unauthenticated re-key path
// which only accepts an endpoint the server already knows. If it fails, the
// next time Frank opens the dashboard the page re-subscribes anyway.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const old = event.oldSubscription || null;
      const fresh = event.newSubscription || await self.registration.pushManager.subscribe(
        event.oldSubscription ? event.oldSubscription.options : { userVisibleOnly: true },
      );
      const json = fresh.toJSON();
      await fetch('/.netlify/functions/save-push-subscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rekey: true,
          oldEndpoint: old ? old.endpoint : null,
          subscription: { endpoint: fresh.endpoint, keys: json.keys },
        }),
      });
    } catch (err) {
      // Nothing useful to do here; the page will fix it on next open.
    }
  })());
});
