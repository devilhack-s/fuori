// FUORI — sorveglianza dell'avvio.
// Due compiti:
//  1. raccontare al server ogni tentativo di apertura (così si capisce perché a volte l'app si chiude da sola)
//  2. non ricaricare MAI la pagina da sola: se è lenta, aspetta e lo dice con calma.
(function () {
  var t0 = performance.now();
  var id = Math.random().toString(36).slice(2, 10);
  var avvisato = false;

  function manda(evento) {
    try {
      var corpo = JSON.stringify({
        id: id,
        event: evento,
        ms: Math.round(performance.now() - t0),
        mode: (function () {
          try { return window.matchMedia("(display-mode: standalone)").matches ? "app" : "browser"; } catch (e) { return ""; }
        })(),
      });
      if (navigator.sendBeacon) {
        navigator.sendBeacon("/api/boot", new Blob([corpo], { type: "application/json" }));
      } else {
        fetch("/api/boot", { method: "POST", headers: { "content-type": "application/json" }, body: corpo, keepalive: true }).catch(function () {});
      }
    } catch (e) {}
  }

  manda("accensione");

  // la lista degli eventi parte subito, mentre il codice dell'app sta ancora
  // scaricando: quando l'app è pronta la trova già lì
  try {
    var dev = "";
    try { dev = localStorage.getItem("fuori.device") || ""; } catch (e) {}
    window.__eventiPronti = fetch(
      "/api/events?limit=20" + (dev ? "&device=" + encodeURIComponent(dev) : ""),
      { headers: { accept: "application/json" } }
    )
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .catch(function () { return null; });
  } catch (e) {}

  function barra(testo, conBottone) {
    if (avvisato) return;
    avvisato = true;
    try {
      var b = document.createElement("div");
      b.id = "bootBar";
      b.style.cssText =
        "position:fixed;left:12px;right:12px;bottom:16px;z-index:99998;background:#151515;color:#fff;" +
        "border:1px solid #2a2a2a;border-radius:18px;padding:14px 16px;display:flex;gap:12px;align-items:center;" +
        "font:15px system-ui,-apple-system,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.45)";
      var p = document.createElement("p");
      p.textContent = testo;
      p.style.cssText = "margin:0;flex:1;line-height:1.35;opacity:.9";
      b.appendChild(p);
      if (conBottone !== false) {
        var bt = document.createElement("button");
        bt.type = "button";
        bt.textContent = "Ricarica";
        bt.style.cssText = "background:#d7ff3e;color:#0a0a0a;border:0;border-radius:999px;padding:10px 18px;font-weight:800;font-size:15px";
        bt.onclick = function () { location.replace(location.pathname + "?fresh=" + Date.now()); };
        b.appendChild(bt);
      }
      document.body.appendChild(b);
    } catch (e) {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { manda("dom"); }, { once: true });
  } else {
    manda("dom");
  }

  // appena l'app dice di essere viva lo segnalo, e tolgo l'avviso se c'era
  var controlli = 0;
  var orologio = setInterval(function () {
    controlli++;
    if (window.__fuoriBoot) {
      clearInterval(orologio);
      manda("pronta");
      var b = document.getElementById("bootBar");
      if (b) b.remove();
      return;
    }
    if (controlli > 100) clearInterval(orologio);
  }, 200);

  window.addEventListener("error", function (e) {
    manda("errore");
    if (window.__fuoriBoot) return;
    barra("Qualcosa non è partito. Tocca Ricarica e riprovo.", true);
  });

  window.addEventListener("unhandledrejection", function () {
    manda("errore");
    if (window.__fuoriBoot) return;
    barra("Qualcosa non è partito. Tocca Ricarica e riprovo.", true);
  });

  // se dopo 12 secondi non è ancora partita: nessuna ricarica, solo un avviso gentile
  setTimeout(function () {
    if (window.__fuoriBoot || avvisato) return;
    manda("lenta");
    barra("Sto caricando, un attimo…", false);
  }, 12000);

  // quando la pagina se ne va (tu chiudi, o Android la chiude) lo segnalo
  window.addEventListener("pagehide", function () { manda("uscita"); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") manda("nascosta");
  });
})();
