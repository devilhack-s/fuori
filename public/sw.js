/* FUORI — service worker */
const CACHE = "fuori-v560";
const SHELL = [
  "/",
  "/app.min.js?v=560",
  "/styles.css?v=560",
  "/boot.js?v=560",
];

// se il telefono ha in cache una pagina rotta, questa la sostituisce e ricarica pulito
const EMERGENCY = `<!doctype html><html lang="it"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FUORI</title><body style="background:#0a0a0a;color:#fff;font:16px system-ui,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;text-align:center"><div><p style="font-size:20px;font-weight:700;margin:0 0 10px">Un attimo</p><p style="opacity:.72;margin:0 0 20px;line-height:1.5">Non riesco a caricare FUORI. Controlla la connessione e tocca Ricarica.</p><a href="/?fresh=1" style="display:inline-block;text-decoration:none;background:#d7ff3e;color:#0a0a0a;border-radius:999px;padding:14px 26px;font-weight:800;font-size:16px">Ricarica</a></div></body></html>`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "skip") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  // il file dell'app: sempre dalla rete, così non si condivide una versione vecchia
  if (url.pathname === "/fuori.apk") return;

  // la pagina: prima la rete, così non si apre per giorni una versione vecchia.
  // Se la rete non c'è, si usa la copia sul telefono e l'app resta usabile.
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const res = await fetch(req, { cache: "no-cache" });
          if (res && res.ok) cache.put("/", res.clone()).catch(() => {});
          return res;
        } catch {
          const salvata = await cache.match("/");
          return salvata || new Response(EMERGENCY, { headers: { "content-type": "text/html; charset=utf-8" } });
        }
      })()
    );
    return;
  }

  // icone e manifest: sempre dalla rete, così un logo nuovo non resta vecchio
  if (url.pathname === "/manifest.webmanifest" || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || Response.error()))
    );
    return;
  }

  // codice e testi dell'app: la versione è nell'indirizzo, quindi la rete è
  // la fonte giusta. La copia locale resta solo come riserva per l'offline.
  if (
    url.pathname.startsWith("/lang/") ||
    url.pathname === "/app.min.js" ||
    url.pathname === "/styles.css" ||
    url.pathname === "/boot.js"
  ) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const res = await fetch(req, { cache: "no-cache" });
          if (res.ok && res.type === "basic") cache.put(req, res.clone()).catch(() => {});
          return res;
        } catch {
          const hit = await cache.match(req);
          return hit || Response.error();
        }
      })()
    );
    return;
  }

  if (url.pathname === "/sw.js") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || Response.error()))
    );
    return;
  }

  // il resto (foto, file statici): cache prima, rete se manca
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      });
    })
  );
});

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let data = {
        title: "C'è qualcosa per te",
        body: "Guarda cosa è spuntato a Catania: magari è la serata giusta.",
        url: "/",
      };
      // il testo arriva già dentro la notifica: nessun passaggio in più, niente da aspettare
      let dalPush = false;
      try {
        const extra = event.data && event.data.json();
        if (extra && (extra.title || extra.body)) {
          data = { ...data, ...extra };
          dalPush = true;
        }
      } catch {}
      // solo se il messaggio è vuoto lo chiedo al server, con un limite di tempo
      if (!dalPush) {
        try {
          const sub = await self.registration.pushManager.getSubscription();
          if (sub && sub.endpoint) {
            const ctl = new AbortController();
            const timer = setTimeout(() => ctl.abort(), 3500);
            const res = await fetch("/api/latest?s=" + encodeURIComponent(sub.endpoint), {
              cache: "no-store",
              signal: ctl.signal,
            });
            clearTimeout(timer);
            if (res.ok) data = { ...data, ...(await res.json()) };
          }
        } catch {}
      }
      try {
      await self.registration.showNotification(data.title || "FUORI", {
        body: data.body || "",
        icon: "/icons/icon-192.png",
        badge: "/icons/badge-96.png",
        // una notifica non deve mai sostituire quella prima: ognuna ha il suo tag
        tag: "fuori-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
        renotify: true,
        silent: false,
        requireInteraction: false,
        timestamp: Date.now(),
        data: { url: data.url || "/" },
        vibrate: [80, 40, 80],
      });
      } catch (e) {
        // il telefono ha rifiutato di mostrarla: lo dico al server, così compare nelle segnalazioni
        try {
          await fetch("/api/error", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ msg: "notifica non mostrata: " + String(e), where: "service worker", path: "/" }),
          });
        } catch {}
      }
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes(location.origin)) { c.navigate(target); return c.focus(); }
      }
      return clients.openWindow(target);
    })
  );
});
