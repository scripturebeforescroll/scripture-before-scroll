// Scripture Before Scroll — Service Worker
// Handles: offline caching, local notification scheduling, push events

const CACHE = 'sbs-v3';
const SHELL = ['./app.html'];

// ── Install: cache app shell ───────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL))
  );
  self.skipWaiting();
});

// ── Activate: clear old caches ─────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch: cache-first for app shell, network-first for everything else ───
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Only intercept same-origin requests
  if (url.origin !== location.origin) return;

  // App shell: cache-first
  if (url.pathname.endsWith('app.html') || url.pathname === '/') {
    e.respondWith(
      caches.match(e.request).then(cached => {
        const fresh = fetch(e.request).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        });
        return cached || fresh;
      })
    );
    return;
  }

  // Other same-origin assets: network-first with cache fallback
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// ── Periodic Background Sync: send daily reminder ─────────────────────────
// Supported on Android Chrome; silently ignored elsewhere.
self.addEventListener('periodicsync', e => {
  if (e.tag === 'sbs-daily-reminder') {
    e.waitUntil(maybeSendReminder());
  }
});

async function maybeSendReminder() {
  // Read saved prefs from IndexedDB (written by the page)
  const prefs = await getPrefs();
  if (!prefs) return;

  const now = new Date();
  const todayKey = now.toDateString();

  // Don't nudge if habit already done today
  if (prefs.lastCompletedDate === todayKey) return;

  // Only nudge at or after the user's chosen reminder time
  const [remHour, remMin] = prefs.reminderTime.split(':').map(Number);
  const remMinutes = remHour * 60 + remMin;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  if (nowMinutes < remMinutes) return;

  // Don't nudge more than once per day
  if (prefs.lastNudgeDate === todayKey) return;

  await self.registration.showNotification('Scripture Before Scroll', {
    body: 'Your daily scripture is waiting. Take a moment before you scroll. 🙏',
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: 'sbs-daily',
    renotify: false,
    data: { url: './app.html' }
  });

  await setLastNudgeDate(todayKey);
}

// ── Push: handle server-sent push (future use) ────────────────────────────
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  e.waitUntil(
    self.registration.showNotification(data.title || 'Scripture Before Scroll', {
      body: data.body || 'Your scripture habit is waiting. 🙏',
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: 'sbs-push',
      data: { url: './app.html' }
    })
  );
});

// ── Notification click: open / focus the app ──────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes('app.html') && 'focus' in c) return c.focus();
      }
      return clients.openWindow('./app.html');
    })
  );
});

// ── Message: page can tell SW to show a scheduled notification ────────────
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SCHEDULE_REMINDER') {
    // The page passes delayMs so SW fires the notification at the right time.
    // This fires while SW is kept alive; for background delivery on Android
    // PeriodicBackgroundSync is the primary mechanism.
    const { delayMs, body } = e.data;
    if (delayMs >= 0) {
      setTimeout(() => {
        self.registration.showNotification('Scripture Before Scroll', {
          body: body || 'Your scripture habit is waiting. 🙏',
          icon: './icon-192.png',
          badge: './icon-192.png',
          tag: 'sbs-scheduled',
          renotify: false,
          data: { url: './app.html' }
        });
      }, delayMs);
    }
  }
});

// ── IndexedDB helpers (store/read notification prefs) ─────────────────────
function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('sbs-prefs', 1);
    req.onupgradeneeded = ev => {
      ev.target.result.createObjectStore('prefs');
    };
    req.onsuccess = ev => res(ev.target.result);
    req.onerror   = ev => rej(ev.target.error);
  });
}

async function getPrefs() {
  try {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction('prefs', 'readonly');
      const req = tx.objectStore('prefs').get('data');
      req.onsuccess = () => res(req.result || null);
      req.onerror   = () => rej(req.error);
    });
  } catch { return null; }
}

async function setLastNudgeDate(date) {
  try {
    const db = await openDB();
    const prefs = await getPrefs() || {};
    prefs.lastNudgeDate = date;
    return new Promise((res, rej) => {
      const tx = db.transaction('prefs', 'readwrite');
      tx.objectStore('prefs').put(prefs, 'data');
      tx.oncomplete = res;
      tx.onerror    = () => rej(tx.error);
    });
  } catch {}
}
