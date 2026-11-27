/* FUORI — client. Nessuna dipendenza esterna. */
"use strict";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const VERSION = "649";
// se arrivi da un link d'invito, il codice resta con te fino all'iscrizione
const inviteFromUrl = (new URLSearchParams(location.search).get("invite") || "").trim();
const LOCALES = { it: "it-IT", en: "en-GB", es: "es-ES", pt: "pt-BR" };
const K = { person: "fuori.person", saved: "fuori.saved", onb: "fuori.onb", consent: "fuori.consent", lang: "fuori.lang", device: "fuori.device", taste: "fuori.taste", seen: "fuori.seen", evitati: "fuori.evitati" };

const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

let person = load(K.person, null);
let savedIds = load(K.saved, []);
// gusti: quello che apri, salvi e a cui ti iscrivi pesa. Più usi l'app, più si affina.
let taste = load(K.taste, { c: {}, a: {}, n: 0 });
let seenIds = load(K.seen, {});
let onlyForYou = false;
const favCache = {};
let lang = localStorage.getItem(K.lang) || guessLang();
let L = {};
let events = [];
let cursor = null;
let cat = "";
let q = "";
let ideaPick = "";
let loading = false;
let taxonomy = null;
let active = null;
let chatTimer = null;
let chatLast = 0;
let onb = load(K.onb, { goals: [], meet: [], outings: [], interests: [], categories: [], step: 0 });
let deferredPrompt = null;

// com'è il telefono e la rete: su quelli modesti si carica meno roba
const RETE = (() => { try { return navigator.connection || {}; } catch { return {}; } })();
const TELEFONO_LENTO =
  Boolean(RETE.saveData) ||
  /(^|-)2g$|^3g$/.test(String(RETE.effectiveType || "")) ||
  (Number(navigator.deviceMemory) || 4) <= 2;

const device = (() => {
  let d = localStorage.getItem(K.device);
  if (!d) { d = crypto.randomUUID(); localStorage.setItem(K.device, d); }
  return d;
})();

function guessLang() {
  const l = (navigator.language || "it").slice(0, 2).toLowerCase();
  return ["it", "en", "es", "pt"].includes(l) ? l : "en";
}

/* ---------- lingua ---------- */
let langLoaded = null;
function loadLang(l) {
  if (langLoaded === l) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = `/lang/${l}.js?v=${VERSION}`;
    s.onload = () => {
      L = window.LANG_DATA || {};
      langLoaded = l;
      // i testi restano sul telefono: alla prossima apertura si vede subito, senza aspettare la rete
      try { localStorage.setItem("fuori.langData." + l, JSON.stringify(L)); } catch {}
      res();
    };
    s.onerror = () => rej(new Error("lang"));
    document.head.appendChild(s);
  });
}

function t(key, vars) {
  let s = (L && L[key]) || key;
  if (vars) for (const k in vars) s = s.replaceAll("{" + k + "}", vars[k]);
  return s;
}

function applyStatic() {
  document.documentElement.lang = lang === "pt" ? "pt-BR" : lang;
  for (const el of $$("[data-i]")) {
    const why = el.querySelector(":scope > .why");
    el.textContent = t(el.dataset.i);
    if (why) el.appendChild(why);
  }
  for (const el of $$("[data-ph]")) el.placeholder = t(el.dataset.ph);
  $("#langLabel").textContent = lang.toUpperCase();
}

async function setLang(l) {
  lang = l;
  localStorage.setItem(K.lang, l);
  await loadLang(l);
  applyStatic();
  renderCats();
  paintWeather();
  paintMood();
  renderList();
  syncMe();
  paintOwner();
  if (active) renderDetail(active);
  if (taxonomy) { renderTaxonomy(); fillActivityOptions(); }
  if (onboardingOpen) renderOnboarding();
  if (chatOpen) renderChat();
  aiHistory = [];
  // renderAi non è mai esistita: qui si rompeva tutto e l'app segnalava un errore
  if (aiOpen) { renderAiMode(); renderVoice(); }
}

/* ---------- api ---------- */
async function api(path, opts = {}) {
  const vai = () =>
    fetch("/api" + path, {
      headers: { "content-type": "application/json" },
      ...opts,
    });
  let res;
  try {
    res = await vai();
  } catch {
    // un intoppo di rete non deve diventare un errore per chi guarda: riprovo una volta
    await new Promise((r) => setTimeout(r, 600));
    res = await vai();
  }
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(data.error || "error");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// l'assistente risponde mentre scrive: le parole compaiono una dopo l'altra
function meteoPerAI() {
  try {
    if (wx && wx.t != null) return { t: Number(wx.t), sky: String(wx.sky || "") };
  } catch {}
  return null;
}

function contestoAI() {
  return { meteo: meteoPerAI(), pos: myPos || null, citta: String(cityTerm || "").slice(0, 40) };
}

async function askStreamed(text, history, onDelta) {
  const res = await fetch("/api/askstream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, lang, device, history: history.slice(-10), ...contestoAI() }),
  });
  if (!res.ok || !res.body) {
    let data = {};
    try { data = await res.json(); } catch {}
    const err = new Error(data.error || "error");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const sse = (res.headers.get("content-type") || "").includes("event-stream");
  let grezzo = "";
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    grezzo += dec.decode(value, { stream: true });
    if (!sse) {
      out = grezzo;
      if (onDelta) onDelta(aggiustaTestoAI(out));
      continue;
    }
    const righe = grezzo.split("\n");
    grezzo = righe.pop() || "";
    for (const riga of righe) {
      const r = riga.trim();
      if (!r.startsWith("data:")) continue;
      const dato = r.slice(5).trim();
      if (!dato || dato === "[DONE]") continue;
      let j = null;
      try { j = JSON.parse(dato); } catch { continue; }
      const pezzo = (j.candidates?.[0]?.content?.parts || []).map((x) => x.text || "").join("");
      if (!pezzo) continue;
      out += pezzo;
      if (onDelta) onDelta(aggiustaTestoAI(out));
    }
  }
  // se si è fermata troppo presto (a volte capita), chiedo la risposta intera
  const testo = out.trim();
  // "completa" vuol dire che finisce come una frase: se è stata tagliata a metà la riprendo intera
  if (testo.length >= 12) return testo;
  try {
    const intera = await api("/ask", {
      method: "POST",
      body: JSON.stringify({ text, lang, device, history: history.slice(-10), ...contestoAI() }),
    });
    if (intera.answer && intera.answer.length > testo.length) {
      if (onDelta) onDelta(intera.answer);
      return intera.answer;
    }
  } catch {}
  return testo;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// un solo cuore per tutta l'app: stessa forma, stessa misura, mai schiacciato
const heartIcon = (pieno) => `<svg class="ic-heart" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 20.6C9.1 18.6 2.8 13.9 2.8 8.9c0-3 2.2-5.1 4.9-5.1 1.8 0 3.5 1 4.3 2.6.8-1.6 2.5-2.6 4.3-2.6 2.7 0 4.9 2.1 4.9 5.1 0 5-6.3 9.7-9.2 11.7z" fill="${pieno ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>`;

function fmtWhen(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return new Intl.DateTimeFormat(LOCALES[lang], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(d);
}

// la data di un evento, scritta come la direbbe una persona
// "Via Etnea 5" da solo non dice dove: negli elenchi si vede sempre anche la città
function luogoDi(ev) {
  if (!ev) return "";
  if (ev.placeHidden) return t("invite.hidden");
  const place = String(ev.place || "").trim();
  const city = String(ev.city || "").trim();
  if (!city) return place;
  if (!place) return city;
  const re = new RegExp(`(^|[^a-zà-ÿ])${city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
  return re.test(place) ? place : `${place}, ${city}`;
}

function quandoTesto(ev) {
  const t0 = Number(ev.startsAt) || 0;
  if (!t0) return "";
  const fmt = (ms, opts) => new Intl.DateTimeFormat(LOCALES[lang], opts).format(new Date(ms));
  const ora = fmt(t0, { hour: "2-digit", minute: "2-digit" });
  const giornoBreve = (ms) => fmt(ms, { day: "numeric", month: "short" });
  if (ev.weeklyDay !== null && ev.weeklyDay !== undefined) {
    const sett = Array.isArray(ev.weekdays) ? ev.weekdays.filter((g) => g && g.d >= 0) : [];
    let base;
    if (sett.length > 1) {
      // più giorni a settimana, ognuno con la sua ora
      base = sett
        .map((g) => fmtProxGiorno(g.d) + (g.t ? " " + g.t : ""))
        .join(" · ");
      base = t("when.ogni2", { g: base });
    } else {
      // la prossima volta vera, non solo il giorno della settimana:
      // così si capisce perché un evento settimanale sta in quel posto della lista
      const prossima = prossimaVolta(ev);
      base = t("when.ogniData", {
        d: fmt(prossima, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }),
      });
    }
    if (ev.repeatUntil) return base + " · " + t("when.fino", { d: giornoBreve(ev.repeatUntil) });
    return base;
  }
  const giorni = Array.isArray(ev.days) ? ev.days.filter((n) => Number(n) > 0) : [];
  const oreUguali = giorni.every((g) => fmt(g, { hour: "2-digit", minute: "2-digit" }) === ora);
  if (giorni.length > 2) {
    if (!oreUguali) return giorni.map((g) => giornoBreve(g) + " " + fmt(g, { hour: "2-digit", minute: "2-digit" })).join(" · ");
    return giorni.map(giornoBreve).join(" · ") + " · " + ora;
  }
  if (giorni.length === 2) {
    if (!oreUguali) return giorni.map((g) => giornoBreve(g) + " " + fmt(g, { hour: "2-digit", minute: "2-digit" })).join(" · ");
    return t("when.dal", { a: giornoBreve(giorni[0]), b: giornoBreve(giorni[1]) }) + " · " + ora;
  }
  if (ev.endsAt && Number(ev.endsAt) > t0 + 3600e3) {
    return t("when.dal", { a: giornoBreve(t0), b: giornoBreve(ev.endsAt) }) + " · " + ora;
  }
  return fmtWhen(t0);
}

// Quando torna davvero un evento: per quelli settimanali non conta la prima
// data salvata, ma la prossima volta che si svolge. Serve per ordinarli bene.
function prossimaVolta(ev) {
  const base = Number(ev?.startsAt) || 0;
  if (!base) return 0;
  const now = Date.now();
  if (ev.weeklyDay !== null && ev.weeklyDay !== undefined) {
    const regole = Array.isArray(ev.weekdays) && ev.weekdays.length
      ? ev.weekdays.filter((g) => g && Number.isInteger(Number(g.d)))
      : [{ d: Number(ev.weeklyDay), t: "" }];
    const dataBase = new Date(base);
    let migliore = Infinity;
    for (const g of regole) {
      const d = Number(g.d);
      if (!Number.isInteger(d) || d < 0 || d > 6) continue;
      const orario = /^(\d{1,2}):(\d{2})$/.exec(String(g.t || ""));
      const hh = orario ? Number(orario[1]) : dataBase.getHours();
      const mm = orario ? Number(orario[2]) : dataBase.getMinutes();
      const cand = new Date(now);
      cand.setHours(hh, mm, 0, 0);
      cand.setDate(cand.getDate() + ((d - cand.getDay() + 7) % 7));
      if (cand.getTime() <= now) cand.setDate(cand.getDate() + 7);
      if (ev.repeatUntil && cand.getTime() > Number(ev.repeatUntil)) continue;
      if (cand.getTime() < migliore) migliore = cand.getTime();
    }
    return Number.isFinite(migliore) ? migliore : base;
  }
  const giorni = Array.isArray(ev.days) ? ev.days.map(Number).filter((n) => n > 0).sort((a, b) => a - b) : [];
  if (giorni.length) {
    // un evento lungo è ancora in corso: resta davanti a quelli che devono iniziare
    if (ev.endsAt && Number(ev.endsAt) >= now && base <= now) return base;
    const prossimo = giorni.find((n) => n >= now - 60 * 60 * 1000);
    if (prossimo) return prossimo;
  }
  return base;
}

// nome breve del giorno della settimana (0 = domenica)
function fmtProxGiorno(d) {
  const base = new Date(2024, 0, 7); // una domenica
  base.setDate(base.getDate() + Number(d));
  return new Intl.DateTimeFormat(LOCALES[lang], { weekday: "short" }).format(base);
}

function until(ms) {
  const diff = ms - Date.now();
  if (diff <= 0) return null;
  const h = diff / 36e5;
  if (h >= 24) return t("unit.d", { n: Math.floor(h / 24) });
  if (h >= 1) return t("unit.h", { n: Math.round(h) });
  return t("unit.m", { n: Math.max(1, Math.round(diff / 6e4)) });
}

function catName(id) {
  const c = taxonomy?.categories.find((x) => x.id === id);
  return c ? c[lang] || c.it : id;
}

function actName(a) { return a[lang] || a.it; }

/* ---------- avvisi ---------- */
// Tutti gli avvisi restano lo stesso tempo. Se ne arrivano due insieme,
// il secondo aspetta il suo turno invece di sparire dopo un istante.
let toastTimer;
let toastDentro = false;
const toastCoda = [];
function toast(msg, kind) {
  if (!msg) return;
  toastCoda.push({ msg, kind });
  if (toastCoda.length > 4) toastCoda.shift();
  if (!toastDentro) mostraToast();
}
function mostraToast() {
  const el = $("#toast");
  if (!el) { toastDentro = false; toastCoda.length = 0; return; }
  const prossimo = toastCoda.shift();
  if (!prossimo) {
    toastDentro = false;
    el.hidden = true;
    el.classList.remove("err");
    el.onclick = null;
    return;
  }
  toastDentro = true;
  const bad = prossimo.kind === "err";
  el.textContent = prossimo.msg;
  el.hidden = false;
  el.classList.toggle("err", bad);
  if (bad) el.setAttribute("role", "alert");
  else el.removeAttribute("role");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(chiudiToast, 3500);
  el.onclick = chiudiToast;
}
function chiudiToast() {
  clearTimeout(toastTimer);
  const el = $("#toast");
  if (el) {
    el.hidden = true;
    el.classList.remove("err");
    el.onclick = null;
  }
  if (toastCoda.length) mostraToast();
  else toastDentro = false;
}

// gli avvisi di errore: rossi, grandi e lunghi
function toastErr(msg) {
  toast(msg, "err");
}

/* ---------- campi: occhio sulla password, altezza che segue il testo ---------- */
function tuneFields(root) {
  const scope = root && root.querySelectorAll ? root : document;
  scope.querySelectorAll('input[type="password"]').forEach((inp) => {
    if (inp.dataset.eye) return;
    inp.dataset.eye = "1";
    const wrap = document.createElement("span");
    wrap.className = "eye-wrap";
    if (inp.parentNode) {
      inp.parentNode.insertBefore(wrap, inp);
      wrap.appendChild(inp);
    } else return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "eye";
    btn.setAttribute("aria-label", t("login.showPass"));
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.2 12S6 5.6 12 5.6 21.8 12 21.8 12 18 18.4 12 18.4 2.2 12 2.2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
    btn.onclick = () => {
      const hidden = inp.type === "password";
      inp.type = hidden ? "text" : "password";
      btn.classList.toggle("on", hidden);
      btn.setAttribute("aria-label", hidden ? t("login.hidePass") : t("login.showPass"));
    };
    wrap.appendChild(btn);
  });
  scope.querySelectorAll("textarea").forEach((ta) => {
    if (ta.dataset.grow) return;
    ta.dataset.grow = "1";
    const fit = () => {
      if (!ta.offsetParent) return;
      ta.style.height = "auto";
      ta.style.height = Math.max(132, Math.min(460, ta.scrollHeight + 4)) + "px";
    };
    ta.addEventListener("input", fit);
    fit();
    setTimeout(fit, 60);
  });
}

/* ---------- pannelli ---------- */
const openSheets = new Set();
// i pannelli aperti, dal più in basso al più in alto: "indietro" chiude sempre l'ultimo
let strati = [];
let segnaleStoria = false;   // nella storia c'è un segnale pronto per il tasto indietro
let ignoraIndietro = 0;      // quando tolgo io il segnale, il ritorno non deve chiudere altro

/* ---------- dove eri rimasto ---------- */
// aggiornare la pagina non deve riportarti alla home né chiudere quello che stavi guardando
const K_STATO = "fuori.stato";
const PANNELLI_RIPRESA = new Set(["detail", "chat", "pastDetail", "profile", "fav"]);
let statoUI = { v: "home", s: [], at: 0 };
try {
  const x = JSON.parse(localStorage.getItem(K_STATO) || "null");
  if (x && typeof x.v === "string" && Array.isArray(x.s)) statoUI = { v: x.v, s: x.s, at: Number(x.at) || 0 };
} catch {}
function salvaStato() {
  statoUI.at = Date.now();
  try { localStorage.setItem(K_STATO, JSON.stringify(statoUI)); } catch {}
}
function ricordaPannello(id, dati) {
  if (!PANNELLI_RIPRESA.has(id)) return;
  statoUI.s = statoUI.s.filter((x) => x.id !== id).concat(Object.assign({ id }, dati || {}));
  salvaStato();
}
function scordaPannello(id) {
  const prima = statoUI.s.length;
  statoUI.s = statoUI.s.filter((x) => x.id !== id);
  if (statoUI.s.length !== prima) salvaStato();
}

// lascio un segnale nella storia solo se c'è qualcosa da chiudere
function assicuraSegnale() {
  if (segnaleStoria) return;
  if (!strati.length && view === "home") return;
  try {
    history.pushState({ fuori: "pannello" }, "");
    segnaleStoria = true;
  } catch {}
}

function show(id) {
  if (id !== "assistant") stopVoce();
  if (id === "register") regOpenedAt = Date.now();
  const el = document.getElementById(id);
  if (!el) return;
  const gia = openSheets.has(id);
  // la finestra appena aperta va davanti alle altre, non dietro
  const casa = el.parentElement || document.body;
  if (casa.lastElementChild !== el) casa.appendChild(el);
  el.hidden = false;
  tuneFields(el);
  sendView(id);
  openSheets.add(id);
  if (!gia) strati = strati.filter((x) => x !== id).concat(id);
  document.body.style.overflow = "hidden";
  document.body.classList.add("has-sheet");
  assicuraSegnale();
  // v639: la mascotte si affaccia sul pannello appena aperto e dice cosa si fa
  mascotteSegui();
  mfHint(id);
  setTimeout(() => mascotteSegui(false), 320);
}
function hide(id, daIndietro) {
  if (id === "assistant" || id === "permFix" || id === "perms") stopVoce();
  if (id === "register" && regOpenedAt && !person) {
    sendFriction("abbandono", "registrazione");
    regOpenedAt = 0;
  }
  const el = document.getElementById(id);
  if (el) el.hidden = true;
  openSheets.delete(id);
  strati = strati.filter((x) => x !== id);
  scordaPannello(id);
  // v639: chiuso il pannello torna al suo posto (o su quello sotto)
  mascotteSegui();
  // chiuso col dito l'ultimo pannello: tolgo anche il segnale, così la storia resta pulita
  if (!strati.length && segnaleStoria && !daIndietro) {
    segnaleStoria = false;
    ignoraIndietro++;
    try { history.back(); } catch { ignoraIndietro--; }
  }
  if (!openSheets.size) {
    document.body.style.overflow = "";
    document.body.classList.remove("has-sheet");
  }
  if (id === "chat") stopChat();
  // chiudo un evento aperto dalla chat: torno alla chat, non alla home
  if (id === "detail" && aiRitorno) {
    aiRitorno = false;
    setTimeout(() => { if (!person || true) openAi(); }, 80);
  }
  if (id === "mapSheet") clearInterval(mapTimer);
  if (id === "assistant") {
    if (dialogOn) stopDialog();
    stopVoice();
    try { if ("speechSynthesis" in window) speechSynthesis.cancel(); } catch {}
  }
  if (id === "detail") active = null;
  if (id === "crop") {
    cropState = null;
    if (person) setTimeout(() => show("profile"), 0);
  }
}

/* ---------- lista ---------- */
function nBadge(n) {
  return n ? ` <b class="cat-n">${n}</b>` : "";
}

// la matrice delle cose da fare: le categorie (macro) con dentro le attività (micro),
// ognuna col suo numero. Tre per fila, più i preferiti.
const NEW_SEEN = "fuori.newSeen";

function segnaVisto(c, a) {
  const seen = load(NEW_SEEN, {}) || {};
  const ora = Date.now();
  if (c) seen["c:" + c] = ora;
  if (c && a) seen["a:" + c + "|" + a] = ora;
  save(NEW_SEEN, seen);
}

function renderCats() {
  if (!taxonomy) return;
  const box = $("#catMatrix");
  if (!box) return;
  if (!conti && !contiChiesti) {
    // quante cose ci sono adesso: arriva dopo, senza far aspettare la lista
    contiChiesti = true;
    dopoAvvio(() => loadConti(), 400);
  }
  const per = (conti && conti.cats) || [];
  const info = (id) => per.find((c) => c.id === id) || { n: 0, newest: 0, atts: [] };
  const salvato = load(NEW_SEEN, null);
  // la prima volta non c'è niente di "già visto": non segno tutto come nuovo
  const primoGiro = !salvato;
  const seen = salvato || {};
  let segnato = false;
  // "New" solo se è arrivato qualcosa dopo l'ultima volta che l'hai guardata
  const tag = (chiave, ultimo) => {
    if (!ultimo) return "";
    if (primoGiro) { seen[chiave] = Number(ultimo) || 0; segnato = true; return ""; }
    // chiave mai vista (una cosa nuova che prima non c'era): è nuova, si vede
    if (seen[chiave] === undefined) { seen[chiave] = 0; segnato = true; return `<span class="mc-new">${esc(t("matrix.new"))}</span>`; }
    return Number(ultimo) > Number(seen[chiave]) ? `<span class="mc-new">${esc(t("matrix.new"))}</span>` : "";
  };
  // ordine: prima i tuoi interessi, poi chi ha piu' eventi, ultimo chi non ha niente
  const mieiInteressi = catsDaInteressi();
  const ordinate = [...taxonomy.categories].sort((a, b) => {
    const ia = mieiInteressi.has(a.id) ? 0 : 1, ib = mieiInteressi.has(b.id) ? 0 : 1;
    if (ia !== ib) return ia - ib;
    const na = info(a.id).n || 0, nb = info(b.id).n || 0;
    if (na !== nb) return nb - na;
    return String(catName(a.id)).localeCompare(String(catName(b.id)), LOCALES[lang] || "it");
  });
  // dentro ogni tessera al massimo tre nomi: se ce ne sono di più si apre la sottofinestra
  const cards = ordinate.map((c, idx) => {
    const d = info(c.id);
    const lista = d.atts || [];
    const atts = lista.slice(0, 3);
    const resto = lista.length - atts.length;
    const dentro = atts.length
      ? `<span class="mc-acts">${atts
          .map(
            (x) =>
              `<span class="mact ${cat === c.id && actFilter === x.a ? "on" : ""}" data-cat="${c.id}" data-act="${esc(x.a)}" role="button" tabindex="0" title="${esc(x.a)}"><span class="mat">${esc(x.a)}</span><span class="mn">${x.n}</span>${tag("a:" + c.id + "|" + x.a, x.newest)}</span>`
          )
          .join("")}${resto > 0 ? `<span class="mc-more">+${resto}</span>` : ""}</span>`
      : `<span class="mc-empty">${d.n ? `${d.n} ${d.n === 1 ? "evento" : "eventi"}` : esc(t("matrix.none"))}</span>`;
    return `<div class="mcat ${cat === c.id ? "on" : ""}" style="--k:${idx % 7}" data-cat="${c.id}" role="button" tabindex="0">
      ${tag("c:" + c.id, d.newest)}
      <span class="mc-head"><span class="mc-emoji" aria-hidden="true">${catIcon(c.id)}</span><span class="mc-n">${d.n || 0}</span></span>
      <span class="mc-name">${esc(catName(c.id))}</span>
      ${dentro}
      <span class="mc-open">${d.n ? esc(t("matrix.open")) : ""}<i aria-hidden="true">›</i></span>
    </div>`;
  });
  // i preferiti: dentro solo quello che hai salvato tu
  cards.push(`<div class="mcat fav ${onlySaved ? "on" : ""}" data-saved="1" role="button" tabindex="0" style="--k:7">
    <span class="mc-head"><span class="mc-emoji" aria-hidden="true">${heartIcon(true)}</span><span class="mc-n">${savedIds.length}</span></span>
    <span class="mc-name">${esc(t("cat.saved"))}</span>
    <span class="mc-favhint">${esc(t("matrix.favHint"))}</span>
    <span class="mc-open">${esc(t("matrix.openFav"))}<i aria-hidden="true">›</i></span>
  </div>`);
  // l'ultimo tassello: qui non c'è quello che cerchi, crealo tu
  cards.push(`<button class="mcat matrix-plus" type="button" data-create="1" style="--k:8" title="${esc(t("matrix.createHint"))}">
    <span class="mc-plus" aria-hidden="true">+</span>
    <span class="mc-name">${esc(t("matrix.create"))}</span>
  </button>`);
  box.innerHTML = cards.join("");
  if (segnato) save(NEW_SEEN, seen);
  // l'elenco completo si costruisce solo quando serve: 393 pulsanti all'avvio
  // rallentavano il telefono senza che nessuno li stesse guardando
  if (actIndexVisto) {
    renderActivityIndex();
    paintActIndex();
  }
}

// l'indice completo: tutte le attività di tutte le categorie.
let actIndexKey = "";
let actIndexVisto = false;
function attivaActIndex() {
  actIndexVisto = true;
  renderActivityIndex();
  paintActIndex();
}

function renderActivityIndex() {
  const box = $("#actIndex");
  if (!box || !taxonomy) return;
  const key = lang + "|" + cat + "|" + (taxonomy.activities || []).length;
  if (key === actIndexKey) return;
  actIndexKey = key;
  box.innerHTML = (taxonomy.categories || [])
    .filter((c) => !cat || c.id === cat)
    .map((c) => {
      const lista = (taxonomy.activities || [])
        .filter((a) => a.cat === c.id)
        .slice()
        .sort((a, b) => String(actName(a)).localeCompare(String(actName(b)), LOCALES[lang] || "it"));
      if (!lista.length) return "";
      return `<div class="act-group">
        <p class="act-cat"><span class="act-ic" aria-hidden="true">${catIcon(c.id)}</span>${esc(catName(c.id))}<span class="act-n">${lista.length}</span></p>
        <div class="act-links">${lista
          .map(
            (a) => `<button class="act-link" type="button" data-cat="${esc(c.id)}" data-act="${esc(a.it)}">${esc(actName(a))}${whyHtml(a.it)}</button>`
          )
          .join("")}</div>
      </div>`;
    })
    .join("");
}

function paintActIndex() {
  const box = $("#actIndex");
  if (!box) return;
  box.querySelectorAll("[data-act]").forEach((b) => {
    b.classList.toggle("on", b.dataset.cat === cat && b.dataset.act === actFilter);
  });
}

// una riga evento: con la foto chi ce l'ha, senza chi non ce l'ha
function eventRow(ev) {
  if (!ev) return "";
  const foto = Array.isArray(ev.photos) && ev.photos.length
    ? `<img src="${esc(ev.photos[0])}" alt="" loading="lazy" decoding="async">`
    : `<span class="ev-emoji" aria-hidden="true">${catIcon(ev.category)}</span>`;
  const genere = [catName(ev.category), ev.activity].filter(Boolean).join(" · ");
  const che = String(ev.description || "").replace(/\s+/g, " ").trim().slice(0, 96) || luogoDi(ev);
  return `<button class="ev-row" type="button" data-ev="${esc(ev.id)}">${foto}
    <span class="ev-txt"><span class="ev-gen">${esc(genere)}</span><b>${esc(ev.title)}</b><span>${esc(che)}</span></span></button>`;
}

// la sottofinestra di una categoria: tutte le attività con il loro numero.
// Si apre sempre, anche quando l'attività è una sola.
function openCatSheet(id) {
  const c = (taxonomy && taxonomy.categories || []).find((x) => x.id === id);
  if (!c) return;
  const d = (conti && conti.cats || []).find((x) => x.id === id) || { n: 0, atts: [] };
  const emoji = $("#csEmoji"), title = $("#csTitle"), sub = $("#csSub"), list = $("#csList");
  if (emoji) emoji.innerHTML = catIcon(id);
  if (title) title.textContent = catName(id);
  if (sub) sub.textContent = t("cat.sheetSub", { n: d.n || 0 });
  const rows = [];
  if (cat === id && !actFilter) {
    rows.push(`<button class="cs-row clear" type="button" data-cs-cat="" data-cs-act=""><span class="cs-name">${esc(t("cat.clear"))}</span><span class="cs-go" aria-hidden="true">✕</span></button>`);
  }
  rows.push(`<button class="cs-row all ${cat === id && !actFilter ? "on" : ""}" type="button" data-cs-cat="${id}" data-cs-act=""><span class="cs-name">${esc(t("cat.all"))}</span><span class="cs-n">${d.n || 0}</span><span class="cs-go" aria-hidden="true">›</span></button>`);
  for (const a of d.atts || []) {
    rows.push(`<button class="cs-row ${cat === id && actFilter === a.a ? "on" : ""}" type="button" data-cs-cat="${id}" data-cs-act="${esc(a.a)}"><span class="cs-name">${esc(a.a)}</span><span class="cs-n">${a.n}</span><span class="cs-go" aria-hidden="true">›</span></button>`);
  }
  if (!(d.atts || []).length) rows.push(`<div class="empty small"><b>${esc(t("cat.empty"))}</b></div>`);
  rows.push(`<button class="cs-row cs-go-list" type="button" data-cs-go="1"><span class="cs-name">${esc(t("cat.see"))}</span><span class="cs-go" aria-hidden="true">↓</span></button>`);
  if (list) {
    list.innerHTML = rows.join("");
    // sotto le attività, gli eventi di questa categoria: foto se ci sono,
    // titolo, che genere è e di cosa si tratta. Toccandone uno si apre.
    const evs = events.filter((e) => e && e.category === id).slice(0, 24);
    if (evs.length) {
      list.insertAdjacentHTML(
        "beforeend",
        `<div class="cs-events">${evs.map(eventRow).join("")}</div>`
      );
    }
    list.onclick = (e) => {
      // un evento della lista: si chiude la finestra e si apre la sua scheda
      const evb = e.target.closest("[data-ev]");
      if (evb) {
        // la categoria resta aperta sotto l'evento: chiudendolo torni qui,
        // dentro la macro con gli altri eventi, non alla home
        openDetail(evb.dataset.ev);
        return;
      }
      // "vedi gli eventi": chiude solo quando lo chiedi tu
      const vai = e.target.closest("[data-cs-go]");
      if (vai) {
        hide("catSheet");
        setTimeout(() => { const l = $("#list"); if (l) l.scrollIntoView({ behavior: "smooth", block: "start" }); }, 80);
        return;
      }
      const b = e.target.closest("[data-cs-cat]");
      if (!b) return;
      const nuovoCat = b.dataset.csCat || "";
      const nuovoAct = b.dataset.csAct || "";
      // premere di nuovo lo stesso filtro lo toglie e ti lascia dov'eri
      const era = cat === nuovoCat && actFilter === nuovoAct;
      cat = era ? "" : nuovoCat;
      actFilter = era ? "" : nuovoAct;
      segnaVisto(cat, actFilter);
      onlySaved = false;
      renderCats();
      renderList();
      loadEvents(true);
      // la sotto-matrice resta aperta: scegli e togli quanto vuoi
      openCatSheet(id);
    };
  }
  // aprirla vuol dire che l'hai vista: il "New" di quella categoria sparisce
  segnaVisto(id);
  renderCats();
  show("catSheet");
}

// i numeri di adesso: eventi per categoria e per attività (dentro il raggio scelto)
let conti = null;
let contiChiesti = false;
let contiAt = 0;
let actFilter = "";
let onlySaved = false;

async function loadConti() {
  contiChiesti = true;
  try {
    const c = radiusKm > 0 ? filterCenter() : null;
    const p = new URLSearchParams({ t: String(Date.now()) });
    if (c) { p.set("lat", String(c.lat)); p.set("lng", String(c.lng)); p.set("r", String(radiusKm)); }
    const d = await api("/counts?" + p.toString());
    if (!d || !Array.isArray(d.cats)) return;
    conti = d;
    contiAt = Date.now();
    renderCats();
  } catch {}
}

/* ---------- gusti e preferiti ---------- */
function bump(map, key, w) {
  if (!key) return;
  const v = Math.round(((map[key] || 0) + w) * 10) / 10;
  if (v > 0) map[key] = v;
  else delete map[key];
}

function learn(ev, w) {
  if (!ev) return;
  bump(taste.c, ev.category, w);
  bump(taste.a, ev.activity, w);
  if (w > 0) taste.n = (taste.n || 0) + 1;
  save(K.taste, taste);
  renderCats();
}

function sawEvent(id) {
  if (!id) return;
  seenIds[id] = Date.now();
  const keys = Object.keys(seenIds);
  if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete seenIds[k];
  save(K.seen, seenIds);
}

function tasteScore(ev) {
  let s = (taste.c[ev.category] || 0) * 1.2 + (taste.a[ev.activity] || 0) * 2;
  const ints = person && Array.isArray(person.interests) ? person.interests : [];
  if (ints.length && ev.activity) {
    const a = String(ev.activity).toLowerCase();
    if (ints.some((i) => String(i).toLowerCase() === a)) s += 6;
  }
  if (savedIds.includes(ev.id)) s += 4;
  const left = ev.startsAt - Date.now();
  if (left > 0 && left < 36 * 3600 * 1000) s += 1.2;
  if (seenIds[ev.id]) s += 0.2;
  return s;
}

function paintFav() {
  const n = savedIds.length;
  const badge = $("#favCount");
  if (badge) {
    badge.textContent = n > 99 ? "99" : String(n);
    badge.hidden = !n;
  }
  const b = $("#favBtn");
  if (b) b.classList.toggle("has", n > 0);
}

let favOrder = localStorage.getItem("fuori.favOrder") || "recenti";
let favCat = "";
let favAll = [];

async function openFav() {
  paintFav();
  const box = $("#favList");
  const chips = $("#favFiltri");
  const ids = savedIds.slice().reverse();
  if (chips) chips.innerHTML = "";
  show("fav");
  ricordaPannello("fav");
  box.onclick = (e) => {
    const b = e.target.closest("[data-id]");
    if (!b) return;
    e.stopPropagation();
    openDetail(b.dataset.id);
  };
  if (!ids.length) {
    $("#favSub").textContent = t("fav.sub");
    box.innerHTML = `<div class="empty"><b>${esc(t("fav.empty"))}</b></div>`;
    return;
  }
  const first = ids.map((id) => favCache[id] || events.find((e) => e.id === id)).filter(Boolean);
  box.innerHTML = first.length ? first.map(card).join("") : `<p class="muted">${esc(t("home.loading"))}</p>`;
  $("#favSub").textContent = t(savedIds.length === 1 ? "fav.one" : "fav.count", { n: savedIds.length });
  const miss = ids.filter((id) => !favCache[id] && !events.some((e) => e.id === id));
  if (miss.length) {
    // quelli non ancora caricati li chiedo al server, in pochi alla volta
    const got = await Promise.all(
      miss.slice(0, 40).map((id) => api(`/events/${id}`).then((d) => d.event).catch(() => null))
    );
    for (const ev of got) if (ev) favCache[ev.id] = ev;
  }
  favAll = ids.map((id) => favCache[id] || events.find((e) => e.id === id)).filter(Boolean);
  if (!favAll.length) {
    box.innerHTML = `<div class="empty"><b>${esc(t("fav.gone"))}</b></div>`;
    return;
  }
  renderFav();
}

// i preferiti si filtrano e si ordinano insieme: categoria + modo
function renderFav() {
  const chips = $("#favFiltri");
  const box = $("#favList");
  if (!chips || !box) return;
  const cats = [...new Set(favAll.map((e) => e.category).filter(Boolean))];
  chips.innerHTML =
    [
      ["recenti", t("fav.ordRecenti")],
      ["presto", t("fav.ordPresto")],
      ["voto", t("fav.ordVoto")],
    ]
      .map(([k, l]) => `<button class="chip ${favOrder === k ? "on" : ""}" type="button" data-fo="${k}">${esc(l)}</button>`)
      .join("") +
    `<button class="chip ${!favCat ? "on" : ""}" type="button" data-fc="">${esc(t("fav.allCats"))}</button>` +
    cats.map((c) => `<button class="chip ${favCat === c ? "on" : ""}" type="button" data-fc="${esc(c)}">${esc(catName(c))}</button>`).join("");
  chips.querySelectorAll("[data-fo]").forEach((b) => {
    b.onclick = () => { favOrder = b.dataset.fo; localStorage.setItem("fuori.favOrder", favOrder); renderFav(); };
  });
  chips.querySelectorAll("[data-fc]").forEach((b) => {
    b.onclick = () => { favCat = b.dataset.fc; renderFav(); };
  });
  let list = favAll.filter((e) => !favCat || e.category === favCat);
  const rank = new Map(savedIds.map((id, i) => [id, i]));
  if (favOrder === "presto") list = list.slice().sort((a, b) => prossimaVolta(a) - prossimaVolta(b));
  else if (favOrder === "voto") list = list.slice().sort((a, b) => (b.media || 0) - (a.media || 0) || (b.stelle || 0) - (a.stelle || 0));
  else list = list.slice().sort((a, b) => (rank.get(b.id) ?? 0) - (rank.get(a.id) ?? 0));
  box.innerHTML = list.length ? list.map(card).join("") : `<div class="empty"><b>${esc(t("fav.filterEmpty"))}</b></div>`;
}

function spotsPill(ev) {
  const left = ev.capacity - ev.joined;
  if (left <= 0) return `<span class="pill done">${esc(t("card.full"))}</span>`;
  if (left === 1) return `<span class="pill hot">${esc(t("card.oneSpot"))}</span>`;
  return `<span class="pill">${esc(t("card.spots", { n: left }))}</span>`;
}

// come si vive un evento: l'energia e quanto porta fuori dalla comfort zone
const EV_VIBE = { calmo: "😌 Calmo", sociale: "🙂 Sociale", vivace: "🔥 Vivace", avventura: "⛰ Avventuroso" };
const EV_COMFORT = { comodo: "🛟 Comodo", medio: "⚖️ Nel mezzo", osa: "🚀 Fuori comfort zone" };

function card(ev) {
  const c = filterCenter();
  const d = c ? distKm(c, eventPos(ev)) : null;
  const km = d !== null && d <= 100 ? `<span class="pill">${esc(t("card.km", { n: d < 1 ? "0,9" : String(Math.round(d)) }))}</span>` : "";
  const close = ev.signupUntil ? until(ev.signupUntil) : null;
  const closed = ev.signupUntil && ev.signupUntil < Date.now();
  const bits = [spotsPill(ev)];
  // il meteo di adesso dove si trova l'evento: piccolo, ma si vede
  if (ev.meteo && ev.meteo.t != null) bits.push(`<span class="pill wx-pill" title="${esc(t("wx.pillTitle"))}">${ev.meteo.emoji || "🌡️"} ${ev.meteo.t}°</span>`);
  if (km) bits.push(km);
  if (ev.pending) bits.push(`<span class="pill req">${esc(t("card.pending", { n: ev.pending }))}</span>`);
  if (ev.ageMin || ev.ageMax) bits.push(`<span class="pill">${esc(ageLabel(ev))}</span>`);
  // chi c'è dentro: dai più piccoli ai più grandi
  if (ev.ageLo || ev.ageHi) {
    const lo = ev.ageLo || ev.ageHi;
    const hi = ev.ageHi || ev.ageLo;
    bits.push(`<span class="pill">${esc(t(lo === hi ? "card.ageOne" : "card.ages", { a: lo, b: hi }))}</span>`);
  }
  if (ev.access && ev.access !== "open") bits.push(`<span class="pill">${esc(t("access." + ev.access))}</span>`);
  // come si vive l'evento: si capisce subito se è nelle tue corde
  if (ev.vibe && EV_VIBE[ev.vibe]) bits.push(`<span class="pill vibe-p">${EV_VIBE[ev.vibe]}</span>`);
  if (ev.comfort && EV_COMFORT[ev.comfort]) bits.push(`<span class="pill vibe-p">${EV_COMFORT[ev.comfort]}</span>`);
  if (closed) bits.push(`<span class="pill done">${esc(t("card.closed"))}</span>`);
  else if (close) bits.push(`<span class="pill">${esc(t("card.closing", { when: close }))}</span>`);
  const newMsgs = Number(unread[ev.id] || 0);
  const unreadTag = newMsgs ? `<span class="unread">${newMsgs > 9 ? "9+" : newMsgs}</span>` : "";
  const fotoCard = Array.isArray(ev.photos) && ev.photos.length
    ? `<div class="ev-photos">${ev.photos.slice(0, 3).map((u) => `<img src="${esc(u)}" alt="${esc(t("detail.photos"))}" loading="lazy" decoding="async">`).join("")}</div>`
    : "";
  return `<button class="event${newMsgs ? " has-unread" : ""}" data-id="${ev.id}">${unreadTag}
    <div class="ev-top"><span class="tag">${esc(catName(ev.category))}${ev.activity ? " · " + esc(ev.activity) : ""}</span><span class="when">${esc(quandoTesto(ev))}</span></div>
    <h3 class="ev-title">${esc(ev.title)}</h3>
    ${fotoCard}
    <p class="ev-place">${esc(luogoDi(ev))}</p>
    <div class="ev-foot">${bits.join("")}</div>
  </button>`;
}

// ordine della lista: per data (predefinito) oppure appena pubblicati
let ordine = (() => {
  const scelto = localStorage.getItem("fuori.ordine");
  return scelto === "nuovi" ? "nuovi" : "prima";
})();

// "ultimo tocco": creato o modificato che sia, l'ultimo lavoro fatto va in cima
function ultimoTocco(ev) {
  return Math.max(Number(ev.createdAt) || 0, Number(ev.updatedAt) || 0);
}

// se hai detto come ti senti, prima gli eventi che hanno a che fare con quello
function moodFit(ev) {
  if (!moodPick || !taxonomy || !ev) return 0;
  const nome = String(ev.activity || "").toLowerCase().trim();
  if (!nome) return 0;
  const a = (taxonomy.activities || []).find((x) => String(x.it || "").toLowerCase() === nome);
  return a && Array.isArray(a.m) && a.m.includes(moodPick) ? 1 : 0;
}

function applicaOrdine(shown) {
  const umore = (a, b) => moodFit(b) - moodFit(a);
  if (ordine === "prima") shown.sort((a, b) => umore(a, b) || prossimaVolta(a) - prossimaVolta(b));
  else if (ordine === "dopo") shown.sort((a, b) => umore(a, b) || prossimaVolta(b) - prossimaVolta(a));
  else shown.sort((a, b) => umore(a, b) || ultimoTocco(b) - ultimoTocco(a) || prossimaVolta(a) - prossimaVolta(b));
  return shown;
}

let ultimaImpronta = "";
function renderList() {
  paintHero();
  try { ultimaImpronta = JSON.stringify(events); } catch { ultimaImpronta = ""; }
  const list = $("#list");
  const term = q.trim().toLowerCase();
  const center = filterCenter();
  const near = Boolean(center);
  let shown = events.filter((ev) => {
    if (cat && ev.category !== cat) return false;
    if (actFilter && String(ev.activity || "") !== actFilter) return false;
    // quello che non ti è piaciuto di una persona non te lo ripropongo
    if (evitati[ev.host + "|" + ev.category]) return false;
    if (near) {
      const d = distKm(center, eventPos(ev));
      if (d === null || d > radiusKm) return false;
    }
    if (!term) return true;
    return (ev.title + " " + ev.place + " " + (ev.description || "") + " " + (ev.activity || "") + " " + catName(ev.category)).toLowerCase().includes(term);
  });
  if (onlySaved) shown = shown.filter((ev) => savedIds.includes(ev.id));
  // l'umore sceglie davvero cosa vedi: se hai chiesto "solo questi", resta solo quello
  if (onlyMood) shown = shown.filter((ev) => moodFit(ev));
  applicaOrdine(shown);
  const note = $("#forYouNote");
  if (note) {
    note.hidden = !onlyForYou;
    note.textContent = onlyForYou ? t("forYou.note") : "";
  }
  if (!shown.length) {
    const cercato = term || ideaPick || "";
    const att = onlySaved || !cercato ? null : cercaAttivita(cercato);
    if (att) {
      // è un'attività vera che conosco: non dico "non c'è", dico "nessuno l'ha ancora proposto"
      list.innerHTML = `<div class="empty"><b>«${esc(att.nome)}»: nessuno l'ha ancora proposto</b>
        <span>L'attività c'è, manca l'evento. Puoi organizzarlo tu, anche stasera.</span>
        <button class="btn primary sm" type="button" data-crea-att="${esc(att.nome)}" data-crea-cat="${esc(att.cat)}">Crea un evento di ${esc(att.nome)}</button></div>`;
      if (!vuoteViste.has("att:" + att.nome)) {
        vuoteViste.add("att:" + att.nome);
        sendFriction("attivita_vuota", att.nome.slice(0, 40));
      }
    } else {
      const msg = onlySaved
        ? t("matrix.favEmpty")
        : near && !term
          ? t("radius.none")
          : cercato
            ? t("home.emptySearch", { a: cercato })
            : t("home.emptyText");
      list.innerHTML = `<div class="empty"><b>${esc(t("home.emptyTitle"))}</b><span>${esc(msg)}</span></div>`;
      if (cercato && !vuoteViste.has(cercato)) {
        vuoteViste.add(cercato);
        sendFriction("ricerca_vuota", cercato.slice(0, 40));
      }
    }
  } else {
    list.innerHTML = shown.map(card).join("");
  }
  $("#moreBtn").hidden = !cursor || Boolean(term);
  paintMoodSay();
}

// "salsa", "laser game": se è un'attività che conosciamo, non è una ricerca a vuoto
function cercaAttivita(testo) {
  const pulisci = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const q2 = pulisci(testo);
  if (!q2 || !taxonomy) return null;
  const trovate = (taxonomy.activities || []).filter((a) => {
    const n = pulisci(actName(a));
    if (!n) return false;
    if (n === q2) return true;
    if (q2.length >= 4 && (n.startsWith(q2) || n.includes(q2))) return true;
    if (n.length >= 4 && q2.startsWith(n)) return true;
    return false;
  });
  if (!trovate.length) return null;
  trovate.sort((a, b) => pulisci(actName(a)).length - pulisci(actName(b)).length);
  const a = trovate[0];
  return { nome: actName(a), cat: a.cat };
}

async function apriCreaCon(nome, cat) {
  await openCreate();
  const pannello = $("#create");
  // se il pannello non si è aperto (manca la verifica o l'accesso) non tocco niente
  if (!pannello || pannello.hidden) return;
  const sel = $("#catSelect");
  if (sel && cat && [...sel.options].some((o) => o.value === cat)) { sel.value = cat; fillActivityOptions(); }
  const form = $("#createForm");
  if (form && form.activity) form.activity.value = nome;
  const title = form && form.title;
  if (title) setTimeout(() => title.focus(), 120);
}

function paintCacheEventi() {
  try {
    const c = load("fuori.eventsCache", null);
    if (!c || !Array.isArray(c.list) || !c.list.length) return;
    if (Date.now() - (c.at || 0) > 6 * 3600 * 1000) return;
    if (events.length) return;
    events = c.list.filter((e) => e && e.startsAt);
    renderList();
  } catch (e) { console.warn("copia locale eventi", e && e.message); }
}

// la home si rinfresca da sola: gli eventi nuovi compaiono senza tirare giù niente.
// Lo faccio solo se sei fermo in cima e non hai finestre aperte, così non ti sposto la pagina.
let listaViva = 0;
function avviaListaViva() {
  clearInterval(listaViva);
  listaViva = setInterval(async () => {
    if (document.hidden) return;
    if (view !== "home") return;
    if (loading) return;
    if (document.querySelector(".sheet:not([hidden])")) return;
    if (window.scrollY > 60) return;
    await loadEvents(true);
  }, 45000);
}

// ogni minuto chiedo se c'è una versione nuova: se c'è, mi aggiorno senza che tu tocchi niente
let versioneVista = 0;
async function controllaVersione(forza) {
  if (document.hidden) return;
  if (!forza && Date.now() - versioneVista < 45000) return;
  versioneVista = Date.now();
  try {
    const r = await fetch("/api/version?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) return;
    const d = await r.json();
    if (!d.v || String(d.v) === VERSION) return;
    const reg = navigator.serviceWorker && navigator.serviceWorker.getRegistration ? await navigator.serviceWorker.getRegistration() : null;
    if (reg) await reg.update().catch(() => {});
    // se stai scrivendo qualcosa non ti interrompo: aggiorno appena chiudi
    const scrive = document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (scrive) return;
    if (sessionStorage.getItem("fuori.aggiornato") === String(d.v)) return;
    sessionStorage.setItem("fuori.aggiornato", String(d.v));
    location.reload();
  } catch {}
}

// eventi già visti in questa sessione: serve per accorgermi di quelli nuovi
const vistiPrima = new Set();
let primoCarico = true;

async function loadEvents(reset) {
  if (loading) return;
  loading = true;
  // la lista vecchia resta a schermo mentre arriva quella nuova: niente salto nel vuoto
  if (reset) {
    cursor = null;
    // i numeri della matrice seguono la stessa lista: si rinfrescano insieme
    if (Date.now() - contiAt > 15000) { contiChiesti = false; loadConti(); }
  }
  try {
    const p = new URLSearchParams({ limit: "20" });
    if (cursor) p.set("cursor", cursor);
    if (cat) p.set("cat", cat);
    // l'ha già chiesta boot.js appena aperta la pagina: non si aspetta due volte
    let data = null;
    if (reset && !cursor && !cat && window.__eventiPronti) {
      data = await window.__eventiPronti;
      window.__eventiPronti = null;
    }
    if (!data || !data.events) data = await api("/events?" + p);
    const arrivati = data.events || [];
    events = reset ? arrivati : events.concat(arrivati);
    cursor = data.next || null;
    // se è identica a quella già a schermo non c'è niente da ridisegnare
    if (reset && JSON.stringify(events) === ultimaImpronta && document.querySelector("#list .event")) {
      // niente da fare: quello che si vede è già giusto
    } else {
      renderList();
    }
    // se l'app è aperta e spunta un evento nuovo, lo dico subito: nessun permesso da chiedere
    const freschi = arrivati.filter((e) => e && e.id && !vistiPrima.has(e.id));
    arrivati.forEach((e) => e && e.id && vistiPrima.add(e.id));
    if (primoCarico) {
      primoCarico = false;
    } else if (freschi.length && !document.hidden && !view?.startsWith?.("chat")) {
      const primo = freschi.find((e) => !e.mine) || freschi[0];
      if (primo) toast(`C'è un evento nuovo: ${primo.title}`);
    }
    if (!cursor) save("fuori.eventsCache", { at: Date.now(), list: events.slice(0, 30) });
    // un evento che ho messo da parte e che sta per cominciare: lo dico appena entro
    remindSalvati();
  } catch {
    // la copia tenuta nel telefono potrebbe essere il motivo: la butto e riprovo al prossimo giro
    try { localStorage.removeItem("fuori.eventsCache"); } catch {}
    if (!events.length) $("#list").innerHTML = `<div class="empty"><b>${esc(t("toast.offline"))}</b></div>`;
    else renderList();
  } finally {
    loading = false;
  }
}

/* ---------- tassonomia ---------- */
async function loadTaxonomy() {
  if (taxonomy) return taxonomy;
  const res = await fetch(`/activities.json?v=${VERSION}`);
  taxonomy = await res.json();
  // due voglie in più, senza riscrivere l'elenco delle attività: chi cerca compagnia
  // trova gli incontri, chi cerca coccole trova le serate e le cose romantiche
  const CON_GENTE = /gruppo|community|squadra|club|circolo|volontariato|raccolta|banco|picnic|speed date|cena tra sconosciuti|brunch|tè|giochi|carte|karaoke|coro|teatro|danza|salsa|tango|padel|calcetto|calcio|pallavolo|basket|trekking|escursion|passeggiat|festa|networking|associazione/i;
  const COCCOLE = /\bspa\b|relax|massagg|cena|tramonto|passeggiat|picnic|vino|degustazione|cinema|teatro|concerto|jazz|weekend|coppia|romantic|ballo|salsa|tango|barca|mare|spiaggia|giardino|museo|mostra|colazione|brunch|dolci|cioccolat|fiori|profumo|stella|cielo/i;
  for (const a of taxonomy.activities || []) {
    const m = Array.isArray(a.m) ? a.m : [];
    const nome = `${a.it || ""} ${a.en || ""}`.toLowerCase();
    if ((a.cat === "sociale" || a.cat === "volontariato" || CON_GENTE.test(nome)) && !m.includes("compagnia")) m.push("compagnia");
    if ((a.cat === "serate" || a.cat === "benessere" || COCCOLE.test(nome)) && !m.includes("romanticismo")) m.push("romanticismo");
    a.m = m;
  }
  // le attività scritte dalle persone arrivano dopo: le categorie non aspettano
  dopoAvvio(() => {
    loadExtras()
      .then((n) => { if (n) fillActivityOptions(); })
      .catch(() => {});
  }, 700);
  return taxonomy;
}

// quello che le persone scrivono creando un evento resta in memoria
async function loadExtras() {
  if (!taxonomy) return 0;
  let added = 0;
  try {
    const x = await api("/extras");
    const known = new Set(taxonomy.activities.map((a) => a.it.toLowerCase()));
    for (const a of x.activities || []) {
      const k = String(a.it || "").toLowerCase();
      if (!k || known.has(k)) continue;
      known.add(k);
      const cat = taxonomy.categories.some((c) => c.id === a.cat) ? a.cat : taxonomy.categories[0].id;
      taxonomy.activities.push({ it: a.it, cat, season: "sempre", out: false, extra: true });
      added++;
    }
  } catch {}
  return added;
}

/* ---------- profilo in alto ---------- */
function syncMe() {
  const btn = $("#meBtn");
  if (!btn) return;
  const loginBtn = $("#loginBtn");
  if (loginBtn) loginBtn.hidden = Boolean(person?.firstName);
  if (person?.firstName) {
    btn.classList.toggle("verified", Boolean(person.photo));
    if (person.photo) btn.innerHTML = `<img src="${esc(person.photo)}" alt="">`;
    else btn.textContent = person.firstName[0].toUpperCase();
    btn.setAttribute("aria-label", person.firstName);
  	} else {
    btn.classList.remove("verified");
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8.5" r="3.6"/><path d="M4.5 20c1.3-3.4 4.2-5 7.5-5s6.2 1.6 7.5 5"/></svg>`;
    btn.setAttribute("aria-label", "Profilo");
  }
  renderFlags();
  const flags = $("#flags");
  if (flags) flags.hidden = Boolean(person?.firstName);
  paintHero();
}

const LANGS = [
  ["it", "Italiano"],
  ["en", "English"],
  ["es", "Español"],
  ["pt", "Português"],
];

function renderFlags() {
  const box = $("#flags");
  if (!box) return;
  box.innerHTML = LANGS.map(
    ([c, n]) => `<button type="button" data-lang="${c}" class="${c === lang ? "on" : ""}">${esc(n)}</button>`
  ).join("");
}

function openLang() {
  const box = $("#langs");
  if (box) {
    box.innerHTML = LANGS.map(
      ([c, n]) => `<button class="lang-row ${c === lang ? "on" : ""}" type="button" data-lang="${c}">
        <span class="lname">${esc(n)}</span><span class="tick">${c === lang ? "✓" : ""}</span>
      </button>`
    ).join("");
  }
  show("lang");
}

async function refreshMe() {
  if (!person?.email) return;
  try {
    const data = await api("/profile?device=" + encodeURIComponent(device));
    person = { ...person, ...data.person, device };
    save(K.person, person);
    promemoriaVerifica();
    syncMe();
  paintOwner();
  } catch (err) {
    if (err.status === 404) { person = null; localStorage.removeItem(K.person); syncMe(); }
  }
}

/* ---------- mappa: io, chi c'è intorno, gli eventi ---------- */
const CAT_EMOJI = {
  sport: "🏃", sociale: "👥", cinema: "🎬", musica: "🎵", serate: "🌙", giochi: "🎲",
  creativita: "🎨", natura: "🌿", benessere: "🧘", lingue: "🗣️", tech: "💻",
  animali: "🐾", volontariato: "🤝", viaggi: "🧭",
};

/* icone di categoria stilizzate: tratto elegante, un gradiente per genere */
const CAT_ICON = {
  sport: { g: ["#ff9a3d", "#ff5d3d"], p: `<path d="M3 12.5h4l2.2-5.2 4 10.4 2.2-5.2H21"/>` },
  sociale: { g: ["#5ac8fa", "#2f7bff"], p: `<circle cx="9" cy="8" r="3.4"/><path d="M3.5 19.5c.8-3.2 2.9-4.8 5.5-4.8s4.7 1.6 5.5 4.8"/><circle cx="16.5" cy="8.5" r="2.7"/><path d="M15.5 14.8c2.5.2 4.2 1.7 5 4.7"/>` },
  cinema: { g: ["#e9b8ff", "#c084fc"], p: `<rect x="2.9" y="4.9" width="18.2" height="14.2" rx="3"/><path d="M7.5 4.9v14.2M16.5 4.9v14.2"/><path d="M11 8.7l4.4 3.3-4.4 3.3Z"/>` },
  musica: { g: ["#ff5da2", "#c9184a"], p: `<path d="M9 18.2V6.5l11-2.3V15"/><circle cx="6.8" cy="18.2" r="2.6"/><circle cx="17.8" cy="15" r="2.6"/>` },
  serate: { g: ["#ffd166", "#ff9e2c"], p: `<path d="M20 14.2A8.6 8.6 0 1 1 9.8 3.8a7.2 7.2 0 0 0 10.2 10.4Z"/><path d="M17.5 3.5v3M16 5h3"/>` },
  giochi: { g: ["#4ade80", "#16a34a"], p: `<rect x="4" y="4" width="16" height="16" rx="4"/><circle cx="8.8" cy="8.8" r="1.25" fill="currentColor" stroke="none"/><circle cx="15.2" cy="8.8" r="1.25" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none"/><circle cx="8.8" cy="15.2" r="1.25" fill="currentColor" stroke="none"/><circle cx="15.2" cy="15.2" r="1.25" fill="currentColor" stroke="none"/>` },
  creativita: { g: ["#ff7ad9", "#a855f7"], p: `<path d="M12 3.2 13.9 8.1l4.9 1.9-4.9 1.9L12 16.8l-1.9-4.9L5.2 10l4.9-1.9Z"/><path d="M18.6 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8Z"/>` },
  natura: { g: ["#bbf7d0", "#4ade80"], p: `<path d="M5 19.5C5 10.8 11 4.8 20 4.2c0 9-6 15.3-14.5 15.3"/><path d="M5 19.5c2.8-6.4 7-10 12.5-12"/><path d="M14 9.5c1.2 1.2 1.2 3 0 4.2"/>` },
  benessere: { g: ["#e0f2fe", "#7dd3fc"], p: `<path d="M12 19c-4.5-1.8-7-5.2-7.5-9.8 4.3.6 6.7 2.4 7.5 5.4.8-3 3.2-4.8 7.5-5.4-.5 4.6-3 8-7.5 9.8Z"/><path d="M12 19v-4.4"/><circle cx="12" cy="5" r="1.2" fill="currentColor" stroke="none"/>` },
  lingue: { g: ["#fbbf24", "#f97316"], p: `<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 2.5 14.4 0 17M12 3.5c-2.5 2.6-2.5 14.4 0 17"/>` },
  tech: { g: ["#67e8f9", "#6366f1"], p: `<path d="M8 6 3.5 12 8 18M16 6l4.5 6L16 18M13.5 4.5l-3 15"/>` },
  animali: { g: ["#fda4af", "#e11d63"], p: `<ellipse cx="12" cy="15.5" rx="4.6" ry="3.8"/><circle cx="5.6" cy="9.5" r="1.9"/><circle cx="9.6" cy="6.8" r="1.9"/><circle cx="14.4" cy="6.8" r="1.9"/><circle cx="18.4" cy="9.5" r="1.9"/>` },
  volontariato: { g: ["#99f6e4", "#2dd4bf"], p: `<circle cx="12" cy="8.1" r="3"/><path d="M7.6 19.6c.4-3.1 2.1-4.7 4.4-4.7s4 1.6 4.4 4.7"/><circle cx="5" cy="11.4" r="2.2"/><path d="M1.9 18.9c.3-2.5 1.5-3.9 3.1-3.9"/><circle cx="19" cy="11.4" r="2.2"/><path d="M22.1 18.9c-.3-2.5-1.5-3.9-3.1-3.9"/>` },
  viaggi: { g: ["#5eead4", "#0d9488"], p: `<circle cx="12" cy="12" r="8.5"/><path d="M15.5 8.5 13 13l-4.5 2.5L11 11Z"/>` },
};

function catIcon(id) {
  const d = CAT_ICON[id] || CAT_ICON.natura;
  const gid = "cg-" + String(id || "x").replace(/[^a-z0-9]/gi, "");
  return `<svg class="cat-ic" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="url(#${gid})" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${d.g[0]}"/><stop offset="1" stop-color="${d.g[1]}"/></linearGradient></defs>${d.p}</svg>`;
}

let lmap = null;
let mapLayer = null;
let mapTimer = null;
let mapRosterId = null;
let mapEvents = [];
let mapShare = localStorage.getItem("fuori.mapShare") === "1";

function mapIcon(cls, html) {
  const size = cls === "mk-me" ? 18 : cls === "mk-event" ? 40 : 22;
  return window.L.divIcon({
    className: "mkraw",
    html: `<div class="mk ${cls}">${html}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function awayText(m) {
  if (!Number.isFinite(m)) return "";
  if (m < 950) return t("map.away", { n: Math.max(20, Math.round(m / 10) * 10) });
  return t("map.awayKm", { n: (m / 1000).toFixed(1).replace(".", ",") });
}

function personPopup(p) {
  const ini = esc((p.name || "?").slice(0, 1).toUpperCase());
  const face = p.photo ? `<img src="${esc(p.photo)}" alt="">` : `<span>${ini}</span>`;
  const meta = [p.age ? String(p.age) : null, p.sex === "f" ? t("reg.sexF") : p.sex === "m" ? t("reg.sexC") : null]
    .filter(Boolean).join(" · ");
  const kw = (p.keywords || []).map((k) => `<span>${esc(typeof k === "string" ? k : k.it || "")}</span>`).join("");
  return `<div class="map-pop">
    <div style="display:flex;gap:9px;align-items:center">
      <div class="mk mk-person" style="position:static;border-radius:50%;overflow:hidden">${face}</div>
      <div><b>${esc(p.name)}</b><div class="mt" style="color:#8a8a8a;font-size:11.5px">${esc(meta)}</div></div>
    </div>
    ${kw ? `<div class="kw">${kw}</div>` : ""}
    ${p.bio ? `<div>${esc(p.bio.slice(0, 110))}</div>` : ""}
    <div style="color:#8a8a8a;font-size:11px;margin-top:6px">${esc(awayText(p.distance))}</div>
  </div>`;
}

function eventPopup(ev) {
  return `<div class="map-pop">
    <div><b>${esc(ev.title)}</b></div>
    <div style="color:#9a9a9a;font-size:11.5px">${esc(fmtWhen(prossimaVolta(ev)))} · ${esc(luogoDi(ev))}</div>
    <div style="color:#9a9a9a;font-size:11.5px;margin-top:2px">${esc(awayText(ev.distance))} · ${esc(t("detail.capacity", { joined: ev.joined || 0, cap: ev.capacity }))}</div>
    <button class="go" data-roster="${esc(ev.id)}">${esc(t("map.who"))} ›</button>
    <button class="go" data-dir="${esc(ev.id)}">${esc(t("dir.btn"))} ↗</button>
  </div>`;
}

let mapFitted = false;
// quali eventi far vedere sulla mappa: tutti, solo i preferiti, o quelli scelti a mano
let mapFiltro = (() => {
  const v = localStorage.getItem("fuori.mapFiltro");
  return ["tutti", "preferiti", "scelti", "interessi"].includes(v) ? v : "tutti";
})();
let mapScelti = (() => {
  try { const v = JSON.parse(localStorage.getItem("fuori.mapScelti") || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
})();
let mapTuttiEv = [];

// cosa gli piace davvero: dal profilo, o da quello che ha scelto durante la registrazione
function mieiGusti() {
  const dalProfilo = person && Array.isArray(person.interests) ? person.interests : [];
  const scelti = Array.isArray(onb?.interests) ? onb.interests : [];
  const lista = (dalProfilo.length ? dalProfilo : scelti).map((x) => String(x).toLowerCase().trim());
  return [...new Set(lista.filter(Boolean))];
}

// un evento "fa per lui" se l'attività è una delle sue, o se la sua passione si legge nel titolo
function eventoNeiGusti(ev, gusti) {
  const att = String(ev.activity || "").toLowerCase().trim();
  if (att && gusti.includes(att)) return true;
  const testo = `${ev.title || ""} ${ev.activity || ""} ${ev.description || ""}`.toLowerCase();
  return gusti.some((g) => g.length > 2 && testo.includes(g));
}

function eventiSullaMappa(tutti) {
  if (mapFiltro === "preferiti") return tutti.filter((ev) => savedIds.includes(ev.id));
  if (mapFiltro === "scelti") return tutti.filter((ev) => mapScelti.includes(ev.id));
  if (mapFiltro === "interessi") {
    const gusti = mieiGusti();
    if (!gusti.length) return tutti;
    return tutti.filter((ev) => eventoNeiGusti(ev, gusti));
  }
  return tutti;
}

function dipingiFiltro() {
  const box = $("#mapFiltro");
  if (box) box.querySelectorAll("[data-mf]").forEach((b) => b.classList.toggle("on", b.dataset.mf === mapFiltro));
  const conta = $("#mapConta");
  if (conta) {
    const n = eventiSullaMappa(mapTuttiEv).length;
    // con uno solo si parla al singolare: "1 evento", non "1 eventi"
    const quanti = (chiave, uno) => (n === 1 ? t(uno) : t(chiave, { n }));
    conta.textContent =
      mapFiltro === "preferiti"
        ? n ? quanti("map.contaPreferiti", "map.contaPreferitiUno") : t("map.contaNoPreferiti")
        : mapFiltro === "scelti"
          ? n ? t("map.contaScelti", { n }) : t("map.contaNoScelti")
          : mapFiltro === "interessi"
            ? !mieiGusti().length
              ? t("map.noInteressi")
              : n ? quanti("map.contaInteressi", "map.contaInteressiUno") : t("map.contaNoInteressi")
            : n ? quanti("map.contaTutti", "map.contaTuttiUno") : t("map.contaNessuno");
  }
}

function cambiaFiltroMappa(nuovo, taci) {
  mapFiltro = nuovo;
  localStorage.setItem("fuori.mapFiltro", mapFiltro);
  if (mapFiltro === "preferiti" && !savedIds.length && !taci) toast(t("map.noPreferiti"));
  if (mapFiltro === "scelti" && !mapScelti.length && !taci) return void apriSceltaMappa();
  // senza sapere cosa gli piace non posso filtrare niente: glielo chiedo subito
  if (mapFiltro === "interessi" && !mieiGusti().length && !taci) {
    toast(t("map.noInteressi"));
    openInterests();
  }
  dipingiFiltro();
  mapFitted = false;
  refreshMap();
}

async function apriSceltaMappa() {
  show("mapScelta");
  const box = $("#mapSceltaList");
  if (!box) return;
  box.innerHTML = `<p class="muted">Un attimo…</p>`;
  if (!mapTuttiEv.length) await refreshMap();
  const lista = mapTuttiEv.slice().sort((a, b) => prossimaVolta(a) - prossimaVolta(b));
  box.innerHTML = lista.length
    ? lista
        .map(
          (ev) => `<label class="map-scelta-riga"><input type="checkbox" value="${esc(ev.id)}"${
            mapScelti.includes(ev.id) ? " checked" : ""
          }><span class="ms-emoji">${catIcon(ev.category)}</span><span class="ms-txt"><b>${esc(
            ev.title
          )}</b><span>${esc(fmtWhen(prossimaVolta(ev)))} · ${esc(luogoDi(ev))}</span></span></label>`
        )
        .join("")
    : `<p class="muted">Nessun evento in programma adesso.</p>`;
}

function drawMap(base, pos, data) {
  if (!lmap) return;
  if (mapLayer) { mapLayer.clearLayers(); } else { mapLayer = window.L.layerGroup().addTo(lmap); }
  const punti = [];
  if (pos) punti.push([pos.lat, pos.lng]);
  if (pos) {
    window.L.marker([pos.lat, pos.lng], { icon: mapIcon("mk-me", ""), keyboard: false })
      .bindPopup(`<div class="map-pop"><b>${esc(t("map.you"))}</b></div>`)
      .addTo(mapLayer);
  }
  for (const p of data.people || []) {
    const ini = esc((p.name || "?").slice(0, 1).toUpperCase());
    const face = p.photo ? `<img src="${esc(p.photo)}" alt="" loading="lazy">` : `<span>${ini}</span>`;
    punti.push([p.lat, p.lng]);
    window.L.marker([p.lat, p.lng], { icon: mapIcon("mk-person", face), keyboard: false })
      .bindPopup(personPopup(p), { maxWidth: 240 })
      .addTo(mapLayer);
  }
  mapTuttiEv = data.events || [];
  const visibili = eventiSullaMappa(mapTuttiEv);
  mapEvents = visibili;
  dipingiFiltro();
  for (const ev of visibili) {
    const emoji = catIcon(ev.category);
    const n = ev.joined || 0;
    punti.push([ev.lat, ev.lng]);
    window.L.marker([ev.lat, ev.lng], { icon: mapIcon("mk-event", `${emoji}${n ? `<span class="n">${n}</span>` : ""}`), keyboard: false })
      .bindPopup(eventPopup(ev), { maxWidth: 250 })
      .addTo(mapLayer);
  }
  aggiornaTemaMappa();
  // la prima volta li faccio stare tutti dentro lo schermo, anche quelli lontani
  if (!mapFitted) {
    mapFitted = true;
    // si apre sulla TUA zona, non sul mondo: centrata su di te, zoom di quartiere
    try {
      if (pos) {
        lmap.setView([pos.lat, pos.lng], 14, { animate: false });
      } else if (visibili.length && lastPos()) {
        // niente GPS ora: ultima zona nota, mai la Sicilia di default
        const lp = lastPos();
        lmap.setView([lp.lat, lp.lng], 13, { animate: false });
      } else {
        lmap.setView([42.8333, 12.8333], 6, { animate: false });
      }
    } catch {}
  }
  paintMapScope();
}

let mapWarned = false;

function lastPos() {
  try {
    const p = JSON.parse(localStorage.getItem("fuori.pos") || "null");
    if (p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Date.now() - Number(p.at || 0) < 7 * 86400e3) return { lat: p.lat, lng: p.lng };
  } catch {}
  return null;
}

async function refreshMap({ pos, warn = false } = {}) {
  if (!lmap) return;
  // la mappa segue dove sei DAVVERO: GPS ora, altrimenti ultima posizione
  // salvata. Mai la Sicilia di default: quella spunta solo se sei in Sicilia.
  const here = pos === undefined ? myPos : pos;
  const base = here || lastPos() || { lat: 42.8333, lng: 12.8333 };
  if (!here && warn && !mapWarned) { mapWarned = true; toast(t("map.needPos")); }
  // senza filtro la mappa copre la Sicilia; col filtro mostra solo il tuo raggio
  const r = radiusKm || 300;
  try {
    const data = await api(`/map?device=${encodeURIComponent(device)}&lat=${base.lat}&lng=${base.lng}&r=${r}`);
    drawMap(base, here, data);
  } catch {
    toastErr(t("map.noLib"));
  }
}

async function applyRadius() {
  const range = $("#radiusRange");
  radiusKm = Number(range?.value) || 0;
  localStorage.setItem("fuori.radius", String(radiusKm));
  if (radiusKm > 0 && !myPos) {
    const p = await locate();
    if (!p) {
      toastErr(t("radius.needPos"));
      radiusKm = 0;
      if (range) range.value = "0";
      localStorage.setItem("fuori.radius", "0");
    } else {
      useMyPosition(p, { force: true });
      startGeoWatch();
    }
  }
  updateRadiusLabel();
  // numeri della matrice e lista guardano lo stesso raggio: la mappa resta d'accordo
  contiChiesti = false;
  loadConti();
  renderList();
  if (lmap) refreshMap();
}

let leafletLoading = null;

// la mappa pesa: la scarichiamo solo quando serve davvero
function loadLeaflet() {
  if (window.L) return Promise.resolve(true);
  if (leafletLoading) return leafletLoading;
  leafletLoading = new Promise((resolve) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = `/vendor/leaflet.css?v=${VERSION}`;
    document.head.appendChild(css);
    const js = document.createElement("script");
    js.src = `/vendor/leaflet.js?v=${VERSION}`;
    js.onload = () => resolve(true);
    js.onerror = () => { leafletLoading = null; resolve(false); };
    document.head.appendChild(js);
  });
  return leafletLoading;
}

async function openMap() {
  mapFitted = false;
  show("mapSheet");
  const box = $("#mapCanvas");
  if (!window.L) {
    if (box) box.innerHTML = `<p class="muted" style="padding:16px">${esc(t("map.loading"))}</p>`;
    await loadLeaflet();
  }
  if (!window.L) {
    if (box) box.innerHTML = `<p class="muted" style="padding:16px">${esc(t("map.noLib"))}</p>`;
    return;
  }
  const chk = $("#mapShare");
  if (chk) chk.checked = mapShare;
  if (!lmap) {
    if (box) box.innerHTML = "";
    lmap = window.L.map(box, { zoomControl: true, attributionControl: true, preferCanvas: false, minZoom: 2, worldCopyJump: true });
    lmap.on("zoomend", () => paintMapScope());
    aggiornaTemaMappa();
    // la mappa appare subito, poi si sposta su di te appena arriva la posizione
    // si parte dalla tua ultima zona nota, mai dalla Sicilia di default
    const lp = lastPos();
    if (lp) lmap.setView([lp.lat, lp.lng], 13);
    else if (myPos) lmap.setView([myPos.lat, myPos.lng], 13);
    else lmap.setView([42.8333, 12.8333], 6);
  }
  setTimeout(() => { try { lmap.invalidateSize(); } catch {} }, 250);
  // prima disegno gli eventi con quello che so già; il GPS lavora dopo
  await refreshMap();
  locate().then(async (pos) => {
    if (!pos) {
      if (!mapWarned) { mapWarned = true; toast(t("map.needPos")); }
      return;
    }
    useMyPosition(pos, { force: true });
    if (mapShare && person) {
      try { await api("/map/ping", { method: "POST", body: JSON.stringify({ device, lat: pos.lat, lng: pos.lng, on: true }) }); } catch {}
    }
    if (!$("#mapSheet")?.hidden) await refreshMap({ pos });
    // DOPO il disegno (che prima inquadrava la zona di default): centro su di te,
    // zoom di quartiere. Prima lo facevo prima e il disegno lo sovrascriveva.
    try { if (!$("#mapSheet")?.hidden) { lmap.setView([pos.lat, pos.lng], 15, { animate: false }); mapFitted = true; paintMapScope(); } } catch {}
  });
  clearInterval(mapTimer);
  mapTimer = setInterval(() => { if (!$("#mapSheet")?.hidden) refreshMap(); }, 60000);
}

async function toggleMapShare(on) {
  mapShare = Boolean(on);
  localStorage.setItem("fuori.mapShare", mapShare ? "1" : "0");
  if (!mapShare) {
    try { await api("/map/ping", { method: "POST", body: JSON.stringify({ device, on: false }) }); } catch {}
    await refreshMap();
    return;
  }
  if (!person) { toast(t("map.needPos")); openRegister(); return; }
  const pos = await locate();
  if (!pos) { toast(t("map.needPos")); $("#mapShare").checked = false; mapShare = false; localStorage.setItem("fuori.mapShare", "0"); return; }
  try {
    await api("/map/ping", { method: "POST", body: JSON.stringify({ device, lat: pos.lat, lng: pos.lng, on: true }) });
  } catch { toast(t("map.noLib")); }
  await refreshMap({ pos });
}

function dirOptions(ev) {
  const hasGeo = Number.isFinite(ev.lat) && Number.isFinite(ev.lng);
  const city = ev.city || "Catania";
  // se il posto contiene già la città non la ripeto
  const addr = new RegExp(city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(ev.place)
    ? ev.place
    : `${ev.place}, ${city}`;
  const q = hasGeo ? `${ev.lat},${ev.lng}` : `${addr}, Italia`;
  const enc = encodeURIComponent(q);
  const encAddr = encodeURIComponent(addr);
  const ua = navigator.userAgent || "";
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const android = /Android/i.test(ua);
  const list = [];

  if (ios) {
    list.push({ ic: "🧭", label: t("dir.apple"), url: `https://maps.apple.com/?daddr=${enc}&dirflg=d` });
  }
  list.push({ ic: "📍", label: t("dir.google"), url: `https://www.google.com/maps/dir/?api=1&destination=${enc}&travelmode=driving` });
  list.push({
    ic: "🚗",
    label: t("dir.waze"),
    url: hasGeo
      ? `https://waze.com/ul?ll=${ev.lat}%2C${ev.lng}&navigate=yes&zoom=17`
      : `https://waze.com/ul?q=${encAddr}&navigate=yes`,
  });
  if (android) {
    // geo: fa scegliere al telefono tra le app di mappe installate
    list.push({
      ic: "🗺️",
      label: t("dir.other"),
      url: hasGeo ? `geo:${ev.lat},${ev.lng}?q=${ev.lat},${ev.lng}(${encodeURIComponent(ev.place)})` : `geo:0,0?q=${encAddr}`,
      geo: true,
    });
  }
  return { list, addr };
}

function openDirections(ev) {
  if (!ev) return;
  const { list, addr } = dirOptions(ev);
  const where = $("#dirWhere");
  if (where) {
    const hasCity = new RegExp(String(ev.city || "Catania").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(ev.place);
    where.textContent = hasCity ? ev.place : `${ev.place}, ${ev.city || "Catania"}`;
  }
  const box = $("#dirList");
  if (!box) return;
  box.innerHTML =
    list
      .map(
        (o) =>
          `<a href="${esc(o.url)}"${o.geo ? "" : ' target="_blank" rel="noopener"'}><span class="ic">${o.ic}</span><span>${esc(o.label)}</span></a>`
      )
      .join("") +
    `<button type="button" data-copy="${esc(addr)}"><span class="ic">📋</span><span>${esc(t("dir.copy"))}<span class="sm">${esc(addr)}</span></span></button>`;
  box.querySelectorAll("[data-copy]").forEach((b) => {
    b.onclick = async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
        toast(t("dir.copied"));
      } catch {
        toast(b.dataset.copy);
      }
    };
  });
  show("directions");
}

let rosterPeople = [];

async function openRoster(id) {
  mapRosterId = id;
  $("#rosterTitle").textContent = t("map.rosterTitle");
  $("#rosterSub").textContent = "";
  $("#rosterBody").innerHTML = `<p class="muted">${esc(t("chat.loading"))}</p>`;
  show("roster");
  try {
    const d = await api(`/events/${encodeURIComponent(id)}?device=${encodeURIComponent(device)}`);
    const ev = d.event;
    $("#rosterTitle").textContent = ev.title;
    $("#rosterSub").textContent = `${t("map.rosterSub", { n: ev.joined || 0, cap: ev.capacity })} · ${fmtWhen(prossimaVolta(ev))}`;
    const people = (d.people || []).filter((p) => p.status !== "pending");
    rosterPeople = people;
    $("#rosterBody").innerHTML = people.length
      ? people.map((p, i) => rosterRow(p, i)).join("")
      : `<p class="muted">${esc(t("map.rosterEmpty"))}</p>`;
    $("#rosterBody").querySelectorAll("[data-roster-person]").forEach((b) => {
      b.onclick = () => openPerson(rosterPeople[Number(b.dataset.rosterPerson)]);
    });
  } catch {
    $("#rosterBody").innerHTML = `<p class="muted">${esc(t("map.rosterEmpty"))}</p>`;
  }
}

function rosterRow(p, i) {
  const ini = esc((p.name || "?").slice(0, 1).toUpperCase());
  const face = p.photo ? `<img src="${esc(p.photo)}" alt="" loading="lazy">` : `<span class="ini">${ini}</span>`;
  const meta = [p.age ? String(p.age) : null, p.sex === "f" ? t("reg.sexF") : p.sex === "m" ? t("reg.sexC") : null]
    .filter(Boolean).join(" · ");
  const kw = (p.interests || []).slice(0, 3).map((k) => `<span>${esc(typeof k === "string" ? k : k.it || "")}</span>`).join("");
  const line = p.bio || p.done || p.lookingFor || "";
  // ogni riga e' un pulsante: si tocca e si apre la sua scheda
  return `<button class="who" type="button" data-roster-person="${i == null ? 0 : i}">
    ${face}
    <div>
      <div class="nm">${esc(p.name)}${meta ? ` <span class="mt">· ${esc(meta)}</span>` : ""}</div>
      ${kw ? `<div class="kw">${kw}</div>` : ""}
      ${line ? `<div class="mt">${esc(String(line).slice(0, 110))}</div>` : ""}
    </div>
  </button>`;
}

/* ---------- installazione ---------- */
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferredPrompt = e; paintInstall(); });

// dentro l'app installata il pulsante "Installa" non serve più: sparisce
function isStandalone() {
  try {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.matchMedia("(display-mode: fullscreen)").matches ||
      navigator.standalone === true
    );
  } catch {
    return false;
  }
}

function paintInstall() {
  const btn = $("#installBtn");
  const hint = $("#installHint");
  if (!btn) return;
  // il tasto resta sempre: se l'app è già aperta come app, non serve
  const inApp = isStandalone();
  btn.hidden = inApp;
  if (hint) {
    hint.hidden = inApp;
  }
  const share = $("#shareBtn");
  if (share) share.className = inApp ? "btn primary" : "btn ghost";
}

window.addEventListener("appinstalled", () => {
  localStorage.setItem("fuori.installed", "1");
  paintInstall();
});

// il link da mandare agli amici: corto e pulito, porta alla pagina di invito
const SHARE_LINK = "https://fuori.fuori-catania.workers.dev/";
let chipsShownNames = new Set();

// due nomi che dicono la stessa cosa: "calcio" e "calcetto" non sono due idee
function ideaRoot(name) {
  const k = String(name || "")
    .toLowerCase()
    .trim()
    .replace(/\s+(a\s*5|a\s*7|a\s*11)$/, "")
    .replace(/calcetto|calcio a 5/g, "calcio")
    .replace(/table tennis/g, "ping pong")
    .replace(/\s+/g, " ");
  return k.split(" ")[0] || k;
}

let shareText = "";
let shareTitle = "FUORI";
let shareLink = "";

// la finestra dove scegli dove mandarlo: WhatsApp, Telegram, Facebook, X, Instagram, email, SMS
function apriCondivisione(testo, titolo, link) {
  shareText = String(testo || t("share.text")).replace(/\s*¶\s*/g, "\n\n");
  shareTitle = titolo || "FUORI";
  shareLink = link || SHARE_LINK;
  const p = $("#sharePreview");
  if (p) p.textContent = shareText.length > 190 ? shareText.slice(0, 190).replace(/\s+\S*$/, "") + "…" : shareText;
  show("share");
}

async function condividiCon(app) {
  const u = encodeURIComponent(shareLink);
  const tx = encodeURIComponent(shareText);
  const insieme = encodeURIComponent(shareText + "\n" + shareLink);
  const apri = (url, stessaScheda) => {
    if (stessaScheda) { location.href = url; return; }
    const w = window.open(url, "_blank", "noopener,noreferrer");
    if (!w) location.href = url;
  };
  if (app === "whatsapp") return apri(`https://wa.me/?text=${insieme}`);
  if (app === "telegram") return apri(`https://t.me/share/url?url=${u}&text=${tx}`);
  if (app === "facebook") return apri(`https://www.facebook.com/sharer/sharer.php?u=${u}`);
  if (app === "x") return apri(`https://twitter.com/intent/tweet?text=${tx}&url=${u}`);
  if (app === "mail") return apri(`mailto:?subject=${encodeURIComponent(shareTitle)}&body=${insieme}`, true);
  if (app === "sms") return apri(`sms:?&body=${insieme}`, true);
  if (app === "copia") {
    try { await navigator.clipboard.writeText(shareText + " " + shareLink); toast(t("share.copied")); }
    catch { toast(shareLink); }
    return;
  }
  // Instagram (e le altre app del telefono): passa dal foglio di sistema
  if (navigator.share) {
    try { await navigator.share({ title: shareTitle, text: shareText, url: shareLink }); }
    catch (err) { if (err && err.name !== "AbortError") condividiCon("copia"); }
    return;
  }
  condividiCon("copia");
}

async function onShare() {
  apriCondivisione(t("share.text"), "FUORI");
}

// i tre tocchi, spiegati uno per uno: servono quando Chrome non ci lascia
// installare da qui (per esempio in navigazione anonima)
function passiInstall() {
  return `<b>${esc(t("install.passiTitolo"))}</b><ol class="passi"><li>${esc(t("install.passo1"))}</li><li>${esc(t("install.passo2"))}</li><li>${esc(t("install.passo3"))}</li></ol>`;
}

async function copiaLink() {
  try {
    await navigator.clipboard.writeText(SHARE_LINK);
    toast(t("install.copiato"));
  } catch {
    toast(SHARE_LINK);
  }
}

function installSheet(android) {
  const ttl = $("#installTitle"), body = $("#installBody"), how = $("#installHow");
  const pwa = $("#installPwa"), apk = $("#installApk"), note = $("#installNote");
  if (ttl) ttl.textContent = t("install.title");
  if (body) body.hidden = true;
  // l'APK aggiornato serve a chi ha già l'app: gli avvisi passano dal canale FUORI,
  // con suono e vibrazione, invece che dal canale silenzioso di Chrome
  if (apk) apk.hidden = true;
  if (!android) {
    if (how) how.textContent = t("install.iosBody");
    if (pwa) pwa.hidden = true;
    if (note) { note.hidden = true; note.textContent = ""; }
    show("install");
    return;
  }
  const pronto = Boolean(deferredPrompt);
  if (apk) {
    apk.hidden = false;
    apk.textContent = t("install.apkdl");
  }
  if (how) {
    if (pronto) how.textContent = t("install.pwaBody");
    else how.innerHTML = passiInstall();
  }
  if (pwa) {
    pwa.hidden = false;
    pwa.textContent = pronto ? t("install.ora") : t("install.copia");
    pwa.dataset.modo = pronto ? "prompt" : "copia";
  }
  if (note) {
    note.hidden = false;
    note.textContent = pronto ? t("install.vecchia") : t("install.anonimo") + " " + t("install.vecchia");
  }
  show("install");
}

// scarica il file dell'app: parte subito, senza passare da nessun negozio
function downloadApk() {
  peek("download_apk", "");
  const url = "/fuori.apk?d=" + encodeURIComponent(device) + "&t=" + Date.now();
  // il file arriva come "allegato": il browser lo scarica e la pagina resta qui
  window.location.href = url;
  const ttl = $("#installTitle"), how = $("#installHow");
  if (ttl) ttl.textContent = t("install.apkTitle");
  if (how) how.textContent = t("install.apkBody");
}

async function onInstall() {
  const android = /Android/i.test(navigator.userAgent || "");
  // dall'Android si può installare senza scaricare niente: è la strada che
  // non si chiude da sola e si aggiorna da sola. Il file APK resta come seconda scelta.
  if (android) {
    // se Chrome ci ha dato il permesso di installare da qui, lo faccio subito (è la strada giusta)
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const res = await deferredPrompt.userChoice;
      if (res.outcome === "accepted") toast(t("install.done"));
      deferredPrompt = null;
      return;
    }
    installSheet(true);
    return;
  }
  if (deferredPrompt) {
    deferredPrompt.prompt();
    const res = await deferredPrompt.userChoice;
    if (res.outcome === "accepted") toast(t("install.done"));
    deferredPrompt = null;
    return;
  }
  installSheet(false);
}

/* ---------- cookie e statistica ---------- */
function initConsent() {
  const choice = localStorage.getItem(K.consent);
  const veil = $("#cookieVeil");
  if (!choice) {
    // prima della registrazione non chiediamo niente: niente avvisi sovrapposti alle domande.
    // Cookie e permessi arrivano alla fine, quando il profilo c'è già (o l'app è installata).
    const wel = $("#welcome");
    const pronto = Boolean(person) || isInstalled();
    if (veil) veil.hidden = !pronto || Boolean(wel && !wel.hidden);
    return;
  }
  if (veil) veil.hidden = true;
  if (choice === "all") track();
}
function chooseConsent(choice) {
  localStorage.setItem(K.consent, choice);
  const veil = $("#cookieVeil");
  if (veil) veil.hidden = true;
  if (choice === "all") track();
}

/* ---------- benvenuto: permessi e cookie spiegati bene, subito ---------- */
function openWelcome(force) {
  const el = $("#welcome");
  if (!el) return;
  if (force) localStorage.removeItem("fuori.welDone");
  if (localStorage.getItem("fuori.welDone")) return;
  // questa schermata chiede tutto: niente avviso separato sulle sole notifiche
  sessionStorage.setItem("fuori.pushAsked", "1");
  const now = $("#welNow");
  if (now) now.hidden = true;
  const all = $("#welAll");
  if (all) { all.disabled = false; all.textContent = t("wel.all"); }
  const cv = $("#cookieVeil");
  if (cv) cv.hidden = true;
  el.hidden = false;
}

function closeWelcome() {
  const el = $("#welcome");
  if (el) el.hidden = true;
  localStorage.setItem("fuori.welDone", "1");
  const veil = $("#cookieVeil");
  if (veil && !localStorage.getItem(K.consent)) veil.hidden = false;
  if (person && !person.photo) setTimeout(() => { if (!document.querySelector(".sheet:not([hidden])")) openProfile(); }, 600);
}

async function welcomeAll() {
  const all = $("#welAll");
  const now = $("#welNow");
  const say = (k) => { if (now) { now.textContent = t(k); now.hidden = false; } };
  if (all) { all.disabled = true; all.textContent = t("wel.busy"); }
  // ogni richiesta ha un tetto di tempo: se il telefono non risponde, si va avanti lo stesso
  const vTimer = (p, ms) => Promise.race([Promise.resolve(p).catch(() => null), new Promise((r) => setTimeout(r, ms))]);
  const askMedia = (kind) =>
    vTimer(
      navigator.mediaDevices
        .getUserMedia({ [kind]: true })
        .then((s) => s.getTracks().forEach((x) => x.stop()))
        .catch(() => null),
      4500
    );
  try {
    if ("Notification" in window && Notification.permission === "default") {
      say("wel.s1");
      await vTimer(Notification.requestPermission(), 4000);
    }
    say("wel.s2");
    await vTimer(locate(), 4500);
    say("wel.s3");
    await askMedia("video");
    say("wel.s4");
    await askMedia("audio");
  } catch {}
  localStorage.setItem("fuori.permsAsked", "1");
  if (now) now.hidden = true;
  if (all) { all.disabled = false; all.textContent = t("wel.all"); }
  chooseConsent("all");
  // se il telefono ha concesso le notifiche, l'iscrizione push parte da qui
  await ensurePush();
  closeWelcome();
  toast(t("wel.ok"));
}

let tracked = false;
function track() {
  if (tracked) return;
  tracked = true;
  lastView = "";
  sendView("home");
  startPresence();
}

/* ---------- cosa guardano e dove si bloccano ---------- */
function consensoOk() {
  return localStorage.getItem(K.consent) === "all";
}

let lastView = "";
let regOpenedAt = 0;
const vuoteViste = new Set();
// i nomi delle schermate, in italiano: così le statistiche si leggono da sole
const SCHERMATE = {
  home: "home", detail: "evento", register: "registrazione", profile: "profilo",
  stats: "statistiche", quick: "tre domande", gloss: "spiegazioni", feedback: "consigli",
  privacy: "privacy", map: "mappa", chat: "chat", settings: "impostazioni",
};

// la fascia d'età, scritta come la direbbe una persona
function ageLabel(ev) {
  const lo = Number(ev?.ageMin) || 0, hi = Number(ev?.ageMax) || 0;
  if (!lo && !hi) return "";
  if (lo && hi) return t("age.range", { a: lo, b: hi });
  if (lo) return t("age.min", { a: lo });
  return t("age.max", { b: hi });
}

// perché un evento ha un limite d'età: spiegato in una riga
function ageWhy(ev) {
  return `Questo evento è per ${ageWho(ev)}. Se l'età scritta nel tuo profilo non rientra, qui non puoi iscriverti: decide chi organizza.`;
}

// come si dice a voce: "chi ha tra i 30 e i 40 anni"
function ageWho(ev) {
  const lo = Number(ev?.ageMin) || 0, hi = Number(ev?.ageMax) || 0;
  if (lo && hi) return t("age.whoRange", { a: lo, b: hi });
  if (lo) return t("age.whoMin", { a: lo });
  if (hi) return t("age.whoMax", { b: hi });
  return t("age.all");
}

const AGE_LO = 18, AGE_HI = 90;

function paintAge() {
  const lo = $("#ageMin"), hi = $("#ageMax"), fill = $("#ageFill"), hint = $("#ageHint");
  if (!lo || !hi) return;
  let a = Number(lo.value), b = Number(hi.value);
  if (a > b - 1) { a = Math.min(a, b - 1); lo.value = String(a); }
  if (b < a + 1) { b = Math.max(b, a + 1); hi.value = String(b); }
  const span = AGE_HI - AGE_LO;
  if (fill) {
    fill.style.left = `${((a - AGE_LO) / span) * 100}%`;
    fill.style.width = `${((b - a) / span) * 100}%`;
  }
  if (hint) {
    const ev = { ageMin: a > AGE_LO ? a : null, ageMax: b < AGE_HI ? b : null };
    // sotto il cursore si leggono sempre i due numeri scelti
    hint.textContent = ev.ageMin || ev.ageMax ? t("age.span", { a, b }) : t("age.all");
  }
}

function resetAge() {
  const lo = $("#ageMin"), hi = $("#ageMax");
  if (!lo || !hi) return;
  lo.value = String(AGE_LO);
  hi.value = String(AGE_HI);
  paintAge();
}

function sendView(name) {
  if (!consensoOk()) return;
  const v = String(SCHERMATE[name] || name || "home").slice(0, 40);
  if (v === lastView) return; // niente doppioni se riapri la stessa cosa
  lastView = v;
  api("/track", {
    method: "POST",
    body: JSON.stringify({
      path: v,
      lang,
      device,
      app: isStandalone() ? 1 : 0,
      // se nell'indirizzo c'è test=1 questa è una mia prova: non entra nei numeri
      prova: new URLSearchParams(location.search).get("test") === "1" ? 1 : 0,
      tz: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; } })(),
    }),
  }).catch(() => {});
}

function sendFriction(kind, detail) {
  if (!consensoOk()) return;
  api("/friction", { method: "POST", body: JSON.stringify({ kind, detail: String(detail || "").slice(0, 60) }) }).catch(() => {});
}

// tre tocchi di fila sullo stesso punto: qualcosa non risponde come uno si aspetta
let rages = { el: null, n: 0, at: 0 };
document.addEventListener(
  "pointerdown",
  (e) => {
    const el = e.target && e.target.closest ? e.target.closest("button,a,[data-act],[data-idea],[data-chip]") : null;
    if (!el) return;
    const now = Date.now();
    if (rages.el === el && now - rages.at < 1200) rages.n += 1;
    else rages = { el, n: 1, at: now };
    rages.at = now;
    if (rages.n === 3) {
      const lab = el.id || el.dataset.act || el.dataset.idea || el.dataset.chip || (el.textContent || "").trim().slice(0, 24) || el.className;
      sendFriction("tocco_furioso", lab);
      rages.n = 0;
    }
  },
  true
);

/* presenza: dice al server "ci sono", così il contatore online è vero */
let presenceTimer = null;
function startPresence() {
  if (!device || presenceTimer) return;
  const ping = () => {
    if (document.hidden) return;
    api("/presence", { method: "POST", body: JSON.stringify({ device }) }).catch(() => {});
  };
  ping();
  presenceTimer = setInterval(ping, 120 * 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) ping(); });
}

/* quanto tempo resti dentro: apertura, un battito al minuto e chiusura vanno al server.
   Così negli insight si legge il tempo di ogni profilo e la media di tutti. */
let sessioneId = "";
let sessioneTimer = 0;
const modoApp = () => (isStandalone() ? "app" : "browser");

function idSessione() {
  try { if (crypto.randomUUID) return crypto.randomUUID(); } catch {}
  return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function mandaSessione(stato, conBeacon) {
  if (!device || !sessioneId) return;
  const prova = new URLSearchParams(location.search).get("test") === "1" ? 1 : 0;
  const body = JSON.stringify({ device, id: sessioneId, stato, modo: modoApp(), test: prova });
  if (conBeacon) {
    try {
      if (navigator.sendBeacon && navigator.sendBeacon("/api/sessione", new Blob([body], { type: "application/json" }))) return;
    } catch {}
  }
  api("/sessione", { method: "POST", body }).catch(() => {});
}
function apriSessione() {
  if (!device) return;
  sessioneId = idSessione();
  mandaSessione("inizio");
  try { clearInterval(sessioneTimer); } catch {}
  sessioneTimer = setInterval(() => { if (!document.hidden) mandaSessione("battito"); }, 60000);
}
function chiudiSessione() {
  mandaSessione("fine", true);
  sessioneId = "";
  try { clearInterval(sessioneTimer); } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (!device) return;
  if (document.hidden) chiudiSessione();
  else if (!sessioneId) apriSessione();
});
window.addEventListener("pagehide", chiudiSessione);

/* ---------- dettaglio ---------- */
// quello che sto scrivendo nella nota della richiesta: non si perde a ogni aggiornamento
let bozzaNota = "";

// gli eventi già aperti: la seconda volta si vedono subito, senza aspettare la rete
const detailCache = new Map();
const detailFirma = new Map();

async function openDetail(id) {
  show("detail");
  ricordaPannello("detail", { ev: id });
  const prima = detailCache.get(id);
  if (prima) {
    active = prima;
    renderDetail(prima);
  } else {
    $("#detailBody").innerHTML = `<p class="muted">${esc(t("home.loading"))}</p>`;
  }
  try {
    const data = await api(`/events/${id}?device=${encodeURIComponent(device)}`);
    const firma = JSON.stringify(data);
    const cambiato = firma !== detailFirma.get(id);
    detailFirma.set(id, firma);
    detailCache.set(id, data);
    if (detailCache.size > 12) {
      const vecchio = detailCache.keys().next().value;
      detailCache.delete(vecchio);
      detailFirma.delete(vecchio);
    }
    active = data;
    peek("evento_aperto", data.event?.title || "");
    if (cambiato || !prima) {
      // se sopra c'è un'altra finestra aperta (chi c'è, invita…) non gliela chiudo sotto
      const sopra = document.querySelectorAll(".sheet:not([hidden])").length > 1;
      if (!(sopra && prima)) {
        renderDetail(data);
        sawEvent(id);
        learn(data.event, 0.5);
        // l'hai aperto: quel "New" non è più nuovo
        if (data.event) { segnaVisto(data.event.category, data.event.activity); renderCats(); }
      }
    }
  } catch {
    if (!prima)
      $("#detailBody").innerHTML = `<h2>${esc(t("cancel.gone"))}</h2>
        <p class="muted">${esc(t("home.emptyTitle"))}</p>
        <button class="btn ghost wide" data-close type="button">${esc(t("common.close"))}</button>`;
  }
}

function personRow(p, i) {
  const status = p.status === "pending" ? `<span class="ps">${esc(t("card.waiting"))}</span>` : "";
  const img = p.photo
    ? `<img src="${esc(p.photo)}" alt="" loading="lazy" decoding="async">`
    : esc((p.name || "?")[0].toUpperCase());
  // due parole su chi è: età, sesso e quello che ha scritto di sé
  const bits = [];
  if (p.age) bits.push(t("people.age", { n: p.age }));
  if (p.sex === "f") bits.push(t("reg.sexF"));
  else if (p.sex === "m") bits.push(t("reg.sexC"));
  const about = String(p.bio || p.lookingFor || "").replace(/\s+/g, " ").trim();
  if (about) bits.push(about.slice(0, 70) + (about.length > 70 ? "…" : ""));
  else if (p.activity) bits.push(String(p.activity));
  if (p.city) bits.push(p.city);
  const gusti = (p.interests || []).slice(0, 3);
  if (gusti.length) bits.push(gusti.join(", ") + ((p.interests || []).length > 3 ? "…" : ""));
  if (!bits.length) bits.push("profilo essenziale");
  const meta = bits.join(" · ");
  const check = p.verified ? '<span class="vcheck" title="Utente verificato">✓</span>' : "";
  // quante cose avete in comune: un invito a parlarsi, mai un voto alle persone
  const aff = p.affinita && p.affinita.testo ? `<span class="aff" title="Quello che avete in comune, calcolato dai vostri interessi">✦ ${esc(p.affinita.testo)}</span>` : "";
  return `<button class="person" data-person="${i}">
    <span class="av">${img}</span>
    <span class="pinfo"><span class="pn">${esc(p.name)}${check}</span>${status}${aff}${meta ? `<span class="pmeta">${esc(meta)}</span>` : ""}</span>
  </button>`;
}

// se sto scrivendo dentro il pannello, ridisegnarlo mi cancellerebbe il testo:
// aspetto che esca dal campo (il prossimo giro, 12 secondi, lo aggiorna comunque)
function stoScrivendoDentro(sel) {
  const el = document.activeElement;
  if (!el || !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || "")) return false;
  const box = $(sel);
  return Boolean(box && box.contains(el));
}

function renderDetail(d) {
  if (stoScrivendoDentro("#detailBody")) return;
  const ev = d.event;
  const closed = ev.signupUntil && ev.signupUntil < Date.now();
  const full = ev.joined >= ev.capacity;
  const left = ev.capacity - ev.joined;
  const isSaved = savedIds.includes(ev.id);
  const when = quandoTesto(ev);
  const close = ev.signupUntil ? until(ev.signupUntil) : null;
  const going = (d.people || []).filter((p) => p.status !== "pending");
  const waiting = (d.people || []).filter((p) => p.status === "pending");
  // senza registrazione i nomi e le facce restano coperti
  const locked = Boolean(d.locked);

  let actions = "";
  if (d.owner) {
    actions = `<button class="btn primary wide" id="editBtn">${esc(t("detail.edit"))}</button>
      ${ev.inviteCode ? `<button class="btn ghost wide" id="inviteBtn">${esc(t("invite.share"))}</button>` : ""}
      <div class="det-actions">
      <button class="btn ghost" id="delBtn">${esc(t("detail.delete"))}</button>
      <button class="btn ghost" id="shareBtn">${esc(t("detail.share"))}</button></div>`;
    // chi amministra l'app ma non ha creato questo evento partecipa come chiunque altro
    if (!d.organizer) {
      if (d.imIn) {
        actions += `<button class="btn ghost wide" id="leaveBtn">${esc(t("detail.cancel"))}</button>`;
      } else if (d.imPending) {
        actions += `<div class="notice">${esc(t("detail.pending"))}</div>
          <button class="btn ghost wide" id="leaveBtn">${esc(t("detail.cancel"))}</button>`;
      } else if (closed) {
        actions += `<div class="notice">${esc(t("detail.closedMsg"))}</div>`;
      } else if (full) {
        actions += `<div class="notice">${esc(t("detail.full"))}</div>`;
      } else if (ev.access === "invite" && !d.inviteOk && !inviteFromUrl) {
        actions += `<div class="notice">${esc(t("invite.onlyInvited"))}</div>`;
      } else {
        actions += `${ev.approval ? `<label class="field" style="margin-top:16px"><textarea id="joinNote" rows="2" maxlength="200" placeholder="${esc(t("detail.note"))}"></textarea></label>` : ""}
          <button class="btn primary wide" id="joinBtn">${esc(ev.approval ? t("detail.join") : t("detail.take"))}</button>`;
      }
    }
  } else if (d.imIn) {
    actions = `<div class="det-actions">
      <button class="btn ghost" id="leaveBtn">${esc(t("detail.cancel"))}</button>
      <button class="btn primary" id="shareBtn">${esc(t("detail.share"))}</button></div>`;
  } else if (d.imPending) {
    actions = `<div class="notice">${esc(t("detail.pending"))}</div>
      <div class="det-actions"><button class="btn ghost" id="leaveBtn">${esc(t("detail.cancel"))}</button>
      <button class="btn primary" id="shareBtn">${esc(t("detail.share"))}</button></div>`;
  } else if (closed) {
    actions = `<div class="notice">${esc(t("detail.closedMsg"))}</div>
      <div class="det-actions"><button class="btn ghost" id="shareBtn">${esc(t("detail.share"))}</button></div>`;
  } else if (full) {
    actions = `<div class="notice">${esc(t("detail.full"))}</div>
      <div class="det-actions"><button class="btn ghost" id="shareBtn">${esc(t("detail.share"))}</button></div>`;
  } else if (ev.access === "invite" && !d.inviteOk && !inviteFromUrl) {
    // evento privato e nessun invito in mano: si può chiedere di entrare
    actions = `<div class="notice">${esc(t("invite.onlyInvited"))}</div>
      ${person ? `<p class="hint">${esc(t("invite.askHint"))}</p>
      <label class="field"><textarea id="joinNote" rows="2" maxlength="200" placeholder="${esc(t("detail.note"))}"></textarea></label>
      <button class="btn primary wide" id="askBtn">${esc(t("invite.ask"))}</button>` : ""}
      <div class="det-actions"><button class="btn ghost" id="shareBtn">${esc(t("detail.share"))}</button></div>`;
  } else {
    const accessNote = ev.access && ev.access !== "open" ? `<p class="hint access-note">${esc(t("access." + ev.access))}</p>` : "";
    actions = `${accessNote}${ev.approval ? `<label class="field" style="margin-top:16px"><textarea id="joinNote" rows="2" maxlength="200" placeholder="${esc(t("detail.note"))}"></textarea></label>` : ""}
      <div class="det-actions">
        <button class="btn primary" id="joinBtn">${esc(ev.approval ? t("detail.join") : t("detail.take"))}</button>
        <button class="iconbtn" id="shareBtn" aria-label="Condividi">↗</button>
        <button class="btn ghost fav-inline" id="saveBtn" type="button">${heartIcon(isSaved)}<span>${esc(isSaved ? t("detail.saved") : t("detail.save"))}</span></button>
      </div>`;
  }

  // le foto della community taggate con questo evento: se l'evento non ha foto
  // sono loro a prenderne il posto, le più care prima
  const com = locked ? [] : Array.isArray(d.community) ? d.community : [];
  const comN = Number(d.communityN || com.length) || 0;
  const fotoEvento = ev.photos && ev.photos.length ? ev.photos : com.map((c) => c.photo).filter(Boolean);
  const daCommunity = fotoEvento !== ev.photos && fotoEvento.length > 0;
  // le foto dell'evento: si scorrono col dito
  const fotoBlocco = fotoEvento.length
    ? `<div class="det-photos${daCommunity ? " det-photos-tag" : ""}">${fotoEvento
        .map((u) => `<img src="${esc(u)}" alt="${esc(t("detail.photos"))}" loading="lazy" decoding="async">`)
        .join("")}</div>`
    : "";
  const possoTag = Boolean(d.imIn || d.owner || d.organizer) && !locked;
  const communityBlocco = (com.length || possoTag) && !locked
    ? `<div class="evcom">
        <div class="evcom-top"><span class="evcom-tag">#${esc(ev.title)}</span>${comN ? `<span class="evcom-n">${esc(t("com.n", { n: comN }))}</span>` : ""}</div>
        ${!daCommunity && com.length ? `<div class="evcom-grid">${com.map((c) => `<img class="evcom-ph" src="${esc(c.photo)}" alt="${esc(c.caption || c.name || ev.title)}" loading="lazy" decoding="async">`).join("")}</div>` : ""}
        ${possoTag ? `<button class="evcom-add" id="comAdd" type="button"><span aria-hidden="true">+</span>${esc(t("com.add"))}</button>` : ""}
        ${com.length ? "" : `<p class="evcom-sub">${esc(t("com.none"))}</p>`}
      </div>`
    : "";
  const chatBar = (d.imIn || d.owner)
    ? `<button class="chatbar" id="chatBtn"><span><b>${esc(t("detail.chat"))}</b><br><span>${esc(t("chat.members", { n: going.length }))}</span></span><span>${unread[ev.id] ? `<span class="unread">${unread[ev.id] > 9 ? "9+" : unread[ev.id]}</span>` : ""}›</span></button>`
    : `<div class="chatbar" style="opacity:.55"><span><b>${esc(t("detail.chat"))}</b><br><span>${esc(t("detail.chatLocked"))}</span></span></div>`;

  const requests = waiting.length
    ? `<p class="sec">${esc(t("detail.requests"))} · ${waiting.length}</p>` + waiting.map((p, i) => {
        const idx = (d.people || []).indexOf(p);
        // il badge dice se la persona ha verificato l'email
        return `<div class="req"><div class="vhead" style="margin:0"><b>${esc(p.name)}</b><span class="badge ${p.photo ? "ok" : "todo"}">${esc(p.photo ? t("prof.withPhoto") : t("prof.noPhoto"))}</span></div>
          ${p.message ? `<p class="rmsg">“${esc(p.message)}”</p>` : ""}
          <div class="req-actions"><button class="btn ghost sm" data-decide="decline" data-target="${esc(p.device || "")}">${esc(t("detail.decline"))}</button>
          ${p.photo
            ? `<button class="btn primary sm" data-decide="accept" data-target="${esc(p.device || "")}">${esc(t("detail.accept"))}</button>`
            : `<span class="tiny" style="opacity:.7;align-self:center">Senza foto non può entrare: può solo essere rifiutata.</span>`}</div>
          <button class="tiny" data-person="${idx}">${esc(t("prof.title"))} ›</button></div>`;
      }).join("")
    : "";

  $("#detailBody").innerHTML = `
    <button class="x" data-close type="button" aria-label="Chiudi">×</button>
    <div class="det-tags"><span class="tag">${esc(catName(ev.category))}</span><span class="when">${esc(when)}</span></div>
    <h2 class="det-title">${esc(ev.title)}</h2>
    ${(ev.vibe || ev.comfort) ? `        <div class="vibe-row">${ev.vibe ? `<span class="vibe ${esc(ev.vibe)}">${EV_VIBE[ev.vibe] || esc(ev.vibe)}</span>` : ""}${ev.comfort ? `<span class="vibe ${esc(ev.comfort)}">${EV_COMFORT[ev.comfort] || esc(ev.comfort)}</span>` : ""}</div>` : ""}
    ${fotoBlocco}
    ${communityBlocco}
    <p class="det-sub">${esc(luogoDi(ev))} · <details class="det-q inline"><summary>${esc(t("detail.capacity", { joined: ev.joined, cap: ev.capacity }))}</summary><p class="hint">I posti sono ${esc(String(ev.capacity))} in tutto e ne restano ${esc(String(Math.max(0, ev.capacity - ev.joined)))}. Chi organizza può decidere chi entra.</p></details></p>
    ${ageLabel(ev) ? `<details class="det-q"><summary class="det-age">◗ ${esc(ageLabel(ev))}</summary><p class="hint">${esc(ageWhy(ev))}</p></details>` : ""}
    ${ev.activity ? `<p class="hint">${esc(ev.activity)}</p>` : ""}
    ${ev.placeHidden
      ? `<p class="hint">L'indirizzo è nascosto perché l'evento è privato: non ci sono indicazioni da aprire. Il posto lo ricevi da chi organizza, insieme all'invito.</p>`
      : `<button class="btn primary det-go" id="dirTop" type="button">📍 ${esc(t("dir.big"))}</button>`}
    ${close ? `<details class="det-q"><summary class="deadline">◗ ${esc(t("card.closing", { when: close }))}</summary><p class="hint">Le iscrizioni chiudono ${esc(close)} prima dell'inizio: dopo non si entra più. Puoi comunque chiedere a chi organizza.</p></details>` : ""}
    ${d.organizer ? `<p class="hint">${esc(t("detail.owner"))}</p>` : ""}
    ${ev.description ? `<p class="sec">${esc(t("detail.about"))}</p><p class="about">${esc(ev.description)}</p>` : ""}
    ${actions}
    ${chatBar}
    ${!locked && d.organizzatore ? `<p class="sec">${esc(t("detail.organizer"))}</p><div class="people">${personRow(d.organizzatore, -1)}</div>` : ""}
    <p class="sec">${esc(t("detail.people"))} · ${ev.joined}/${ev.capacity}</p>
    ${locked
      ? `<div class="locked">
          <div class="lk-row">${Array.from({ length: Math.max(3, Math.min(ev.joined || 3, 6)) }).map(() => `<span class="lk-av"></span>`).join("")}</div>
          <p class="lk-t">${esc(t("lock.title"))}</p>
          <p class="muted">${esc(t(ev.joined === 1 ? "lock.sub1" : "lock.sub", { n: ev.joined }))}</p>
          <button class="btn primary wide" id="unlockBtn" type="button">${esc(t("lock.btn"))}</button>
        </div>`
      : `<div class="people">${going.length ? going.map((p) => personRow(p, (d.people || []).indexOf(p))).join("") : `<p class="muted">${esc(t("detail.peopleEmpty"))}</p>`}</div>
        ${requests}`}
    ${actions.includes('id="saveBtn"') ? "" : `<p class="hint" style="margin-top:20px"><button class="tiny" id="saveBtn">${heartIcon(isSaved)}<span>${esc(isSaved ? t("detail.saved") : t("detail.save"))}</span></button></p>`}
    `;

  $("#detailBody").style.paddingTop = "4px";

  const shareBtn = $("#shareBtn");
  if (shareBtn) shareBtn.onclick = () => shareEvent(ev);
  const invBtn = $("#inviteBtn");
  if (invBtn) invBtn.onclick = () => copyInvite(ev);
  const joinBtn = $("#joinBtn");
  if (joinBtn) joinBtn.onclick = () => joinActive();
  const askBtn = $("#askBtn");
  if (askBtn) askBtn.onclick = () => joinActive(true);
  const nota = $("#joinNote");
  if (nota) {
    if (bozzaNota) nota.value = bozzaNota;
    nota.addEventListener("input", () => { bozzaNota = nota.value; });
  }
  const leaveBtn = $("#leaveBtn");
  if (leaveBtn) leaveBtn.onclick = leaveActive;
  const delBtn = $("#delBtn");
  if (delBtn) delBtn.onclick = deleteActive;
  const editBtn = $("#editBtn");
  if (editBtn) editBtn.onclick = () => openEdit(ev);
  const chatBtn = $("#chatBtn");
  if (chatBtn) chatBtn.onclick = () => openChat(ev.id, ev.title);
  const unlockB = $("#unlockBtn");
  if (unlockB) unlockB.onclick = () => { hide("detail"); openRegister(); };
  const dirB = $("#dirBtn");
  if (dirB) dirB.onclick = () => openDirections(ev);
  const dirTop = $("#dirTop");
  if (dirTop) dirTop.onclick = () => openDirections(ev);
  const comAdd = $("#comAdd");
  if (comAdd) comAdd.onclick = () => openPostTag(ev.id, ev.title);
  $("#saveBtn").onclick = () => {
    const had = savedIds.includes(ev.id);
    savedIds = had ? savedIds.filter((x) => x !== ev.id) : savedIds.concat(ev.id);
    save(K.saved, savedIds);
    syncSaved();
    learn(ev, had ? -2 : 3);
    paintFav();
    toast(t(had ? "fav.removed" : "fav.added"));
    renderDetail(active);
  };
  $$("[data-decide]", $("#detailBody")).forEach((b) => {
    b.onclick = () => decide(b.dataset.target, b.dataset.decide);
  });
  $$("[data-person]", $("#detailBody")).forEach((b) => {
    b.onclick = () => {
      const i = Number(b.dataset.person);
      if (i < 0) return openPerson(active.organizzatore);
      openPerson(active.people[i]);
    };
  });
}

async function joinActive(richiesta = false) {
  if (!person) { hide("detail"); openRegister(); return; }
  if (!possoFareEventi()) return;
  const lo = Number(active.event.ageMin) || 0, hi = Number(active.event.ageMax) || 0;
  const age = Number(person.age) || 0;
  if (age && (lo || hi) && ((lo && age < lo) || (hi && age > hi))) {
    toastErr(t("age.blocked", { who: ageWho(active.event), age }));
    return;
  }
  const note = $("#joinNote")?.value.trim() || "";
  const btn = $("#joinBtn");
  if (btn) { btn.disabled = true; setBtnText(btn, t("common.sending")); }
  try {
    const r = await api(`/events/${active.event.id}/join`, {
      method: "POST",
      body: JSON.stringify({ name: person.firstName, device, message: note, invite: inviteFromUrl || "", request: richiesta ? true : undefined }),
    });
    sendView("iscrizione");
    learn(active.event, 4);
    peek("iscrizione", (active && active.event ? active.event.title : "") + (r.status === "pending" ? " (in attesa)" : ""));
    toast(r.status === "pending" ? t("detail.pending") : t("toast.joined"));
    bozzaNota = "";
    await openDetail(active.event.id);
    loadEvents(true);
  } catch (err) {
    if (err.data?.needRegister) { hide("detail"); openRegister(); return; }
    if (err.data?.needPhoto) {
      hide("detail");
      avvisoLungo("Prima la foto profilo", err.data.error, { label: "Carica la foto", run: () => openProfile() });
      return;
    }
    if (err.data?.needVerify) {
      hide("detail");
      avvisoLungo("Manca la verifica del viso", err.data.error, { label: "Fai la verifica", run: () => openVerify() });
      return;
    }
    toastErr(err.data?.error || t("toast.error"));
    if (btn) { btn.disabled = false; setBtnText(btn, t("detail.take")); }
  }
}

async function leaveActive() {
  try {
    await api(`/events/${active.event.id}/leave`, { method: "POST", body: JSON.stringify({ device }) });
    peek("ritirato", active.event?.title || "");
    toast(t("toast.left"));
    await openDetail(active.event.id);
    loadEvents(true);
  } catch { toast(t("toast.error")); }
}

async function decide(target, action) {
  try {
    await api(`/events/${active.event.id}/decide`, { method: "POST", body: JSON.stringify({ device, target, action }) });
    await openDetail(active.event.id);
    loadEvents(true);
  } catch { toast(t("toast.error")); }
}

// annullare un evento: il motivo e' obbligatorio e arriva a tutti gli iscritti
let cancellaId = "";
function deleteActive() {
  if (!active || !active.event) return;
  cancellaId = active.event.id;
  const why = $("#delWhy"), err = $("#delErr");
  if (why) why.value = "";
  if (err) err.hidden = true;
  show("delEvent");
  setTimeout(() => { try { why.focus(); } catch {} }, 120);
}

async function confermaAnnulla() {
  const why = $("#delWhy"), err = $("#delErr"), ok = $("#delOk");
  const motivo = String(why?.value || "").replace(/\s+/g, " ").trim();
  if (motivo.length < 5) {
    if (err) { err.textContent = "Scrivi perché lo annulli (almeno 5 caratteri): lo leggono tutti gli iscritti."; err.hidden = false; }
    return;
  }
  try {
    if (ok) { ok.disabled = true; ok.textContent = "Annullo…"; }
    await api(`/events/${encodeURIComponent(cancellaId)}`, { method: "DELETE", body: JSON.stringify({ device, motivo }) });
    toast(t("toast.deleted"));
    hide("delEvent");
    hide("detail");
    loadEvents(true);
  } catch {
    toast(t("toast.error"));
  } finally {
    if (ok) { ok.disabled = false; ok.textContent = "Annulla l'evento e avvisa tutti"; }
  }
}

async function shareEvent(ev) {
  peek("condivisione", ev?.title || "");
  const code = ev.mine && ev.inviteCode ? ev.inviteCode : "";
  const url = location.origin + "/?e=" + ev.id + (code ? "&invite=" + code : "");
  const text = `${ev.title} · ${fmtWhen(prossimaVolta(ev))}${ev.place ? " · " + ev.place : ""}`;
  apriCondivisione(text, ev.title, url);
}

// il link da mandare a chi vuoi far entrare
async function copyInvite(ev) {
  const url = location.origin + "/?e=" + ev.id + (ev.inviteCode ? "&invite=" + ev.inviteCode : "");
  peek("invito_copiato", ev?.title || "");
  try {
    await navigator.clipboard.writeText(url);
    toast(t("invite.copied"));
  } catch {
    toast(t("toast.noShare"));
  }
}

/* ---------- persona ---------- */
function openPerson(p) {
  if (!p) return;
  const meta = [p.age ? p.age : null, p.sex === "f" ? t("reg.sexF") : p.sex === "m" ? t("reg.sexC") : null].filter(Boolean).join(" · ");
  $("#personBody").innerHTML = `
    <div class="prof-top">
      <span class="avatar">${p.photo ? `<img src="${esc(p.photo)}" alt="" loading="lazy">` : esc((p.name || "?")[0].toUpperCase())}</span>
      <div class="prof-id"><p class="prof-name">${esc(p.name)}${p.verified ? '<span class="vcheck" title="Utente verificato">✓</span>' : ""}</p><p class="hint">${esc(meta)}</p></div>
    </div>
    ${p.bio ? `<p class="sec">${esc(t("prof.bio"))}</p><p class="about">${esc(p.bio)}</p>` : ""}
    ${p.lookingFor ? `<p class="sec">${esc(t("prof.looking"))}</p><p class="about">${esc(p.lookingFor)}</p>` : ""}
    ${p.done ? `<p class="sec">${esc(t("prof.done"))}</p><p class="about">${esc(p.done)}</p>` : ""}`;
  // città, verifiche e numeri subito sotto il nome
  $("#personBody").insertAdjacentHTML("afterbegin", `
    ${p.city ? `<p class="hint">${esc(p.city)}</p>` : ""}
    <div class="det-actions" style="margin:12px 0 0">
      <span class="badge ${p.photo ? "ok" : "todo"}">${p.photo ? "foto ✓" : "senza foto"}</span>
      <span class="badge ${p.faceVerified ? "ok" : "todo"}">${p.faceVerified ? "viso verificato" : "viso non verificato"}</span>
    </div>`);
  // interessi, cosa cerca, i suoi eventi
  const più = [];
  const muto = !p.bio && !p.lookingFor && !p.done && !(p.interests || []).length && !(p.goals || []).length;
  if (muto) più.push(`<p class="hint">Non ha ancora scritto niente di sé. Se vuoi sapere qualcosa, chiedilo nella chat dell'evento.</p>`);
  if ((p.interests || []).length) più.push(`<p class="sec">Gli piace</p><p class="about">${esc(p.interests.join(", "))}</p>`);
  if ((p.goals || []).length) più.push(`<p class="sec">Cerca</p><p class="about">${esc(p.goals.join(", "))}</p>`);
  if ((p.outings || []).length) più.push(`<p class="sec">Uscite</p><p class="about">${esc(p.outings.join(", "))}</p>`);
  const num = [
    p.organizza ? p.organizza + (p.organizza === 1 ? " evento creato" : " eventi creati") : "nessun evento creato",
    p.dentro ? p.dentro + (p.dentro === 1 ? " partecipazione" : " partecipazioni") : "nessuna partecipazione",
    p.since && p.since > 946684800000 ? "su FUORI dal " + new Date(p.since).toLocaleDateString("it-IT", { day: "numeric", month: "long", year: "numeric" }) : "",
  ].filter(Boolean);
  più.push(`<p class="hint">${esc(num.join(" · "))}</p>`);
  if ((p.titoli || []).length) più.push(`<p class="sec">I suoi eventi</p><p class="about">${esc(p.titoli.join(" · "))}</p>`);
  $("#personBody").insertAdjacentHTML("beforeend", più.join(""));
  show("person");
  caricaEventiPassati(p);
}

// gli eventi passati di una persona: quelli che ha creato e quelli a cui ha partecipato
async function caricaEventiPassati(p) {
  if (!p || !p.device) return;
  let lista = [];
  try {
    const r = await api("/person/past?device=" + encodeURIComponent(p.device));
    lista = r.events || [];
  } catch {
    return;
  }
  const box = $("#personBody");
  if (!lista.length || !box) return;
  const giorno = (ms) =>
    new Intl.DateTimeFormat(LOCALES[lang], { day: "numeric", month: "short", year: "numeric" }).format(new Date(ms));
  const html =
    `<p class="sec">Eventi passati</p>` +
    lista
      .map(
        (e) => `<div class="ppast">
          <b>${esc(e.title)}</b>
          <span>${esc(giorno(e.starts_at))}${e.place ? " · " + esc(luogoDi({ place: e.place, city: e.city })) : ""} · ${
            e.role === "host" ? "l'ha creato" : "ha partecipato"
          }</span>
        </div>`
      )
      .join("");
  box.insertAdjacentHTML("beforeend", html);
}

/* ---------- chat ---------- */
let chatOpen = false;
let chatId = null;
let unread = {}; // quanti messaggi nuovi, evento per evento
let msgReacts = {}; // reaction per messaggio
const STICKER_PACK = [
  { id: "love", emoji: "❤️" }, { id: "party", emoji: "🎉" }, { id: "fire", emoji: "🔥" }, { id: "lol", emoji: "😂" },
  { id: "wow", emoji: "😮" }, { id: "cry", emoji: "😢" }, { id: "clap", emoji: "👏" }, { id: "dance", emoji: "💃" },
  { id: "star", emoji: "⭐" }, { id: "think", emoji: "🤔" }, { id: "cool", emoji: "😎" }, { id: "hug", emoji: "🤗" },
  { id: "cake", emoji: "🎂" }, { id: "coffee", emoji: "☕" }, { id: "pizza", emoji: "🍕" }, { id: "wave", emoji: "👋" },
];
const REACT_EMOJI = ["❤️", "😂", "👍", "😮", "😢", "🔥"];
let unreadTimer = null;
let chatBusy = false; // una sola richiesta di chat per volta
let typingSentAt = 0; // per non tempestare il server a ogni tasto


/* ---------- preferiti: promemoria quando l'evento si avvicina ---------- */
// il server sa quali eventi hai messo da parte: così può mandarti l'avviso
// anche quando l'app è chiusa, e non solo quando la apri
async function syncSaved() {
  try {
    await api("/saved", {
      method: "POST",
      body: JSON.stringify({ device, ids: savedIds.slice(0, 200) }),
    });
  } catch {}
}

function remindSalvati() {
  if (!events || !events.length) return;
  let visto = {};
  try {
    visto = JSON.parse(localStorage.getItem("fuori.rimS") || "{}") || {};
  } catch {
    visto = {};
  }
  const oggi = new Date().toISOString().slice(0, 10);
  const adesso = Date.now();
  const vicini = events
    .filter((e) => savedIds.includes(e.id) && e.startsAt > adesso && e.startsAt - adesso < 3 * 864e5)
    .sort((x, y) => x.startsAt - y.startsAt);
  for (const e of vicini) {
    const chiave = e.id + ":" + oggi;
    if (visto[e.id] === oggi) continue;
    const ore = (e.startsAt - adesso) / 36e5;
    const quando =
      ore <= 12
        ? t("fav.remindOggi", { o: fmtOra(e.startsAt) })
        : ore <= 36
          ? t("fav.remindDomani", { o: fmtOra(e.startsAt) })
          : t("fav.remindTra", { n: Math.max(2, Math.round(ore / 24)) });
    toast(t("fav.remindTitolo", { t: e.title }) + " · " + quando);
    visto[e.id] = oggi;
    try {
      localStorage.setItem("fuori.rimS", JSON.stringify(visto));
    } catch {}
    break;
  }
}

/* ---------- notifiche dei gruppi: accese o silenziate ---------- */
let mutes = { all: null, groups: {} };
let muteTarget = null; // 'all' oppure l'id dell'evento

const mutedAll = () => mutes.all !== null && mutes.all !== undefined;
const mutedGroup = (id) => Boolean(id) && Object.prototype.hasOwnProperty.call(mutes.groups, id);

// la campanella dice a colpo d'occhio se questo gruppo è silenziato
function paintMute() {
  const btn = $("#muteBtn");
  if (!btn) return;
  const off = mutedAll() || mutedGroup(chatId);
  btn.textContent = off ? "🔕" : "🔔";
  btn.classList.toggle("muted", off);
}

async function loadMutes() {
  try {
    const d = await api("/mutes?device=" + encodeURIComponent(device));
    mutes = { all: d.all ?? null, groups: d.groups || {} };
  } catch {}
  paintMute();
}

function paintMuteSheet() {
  const off = muteTarget === "all" ? mutedAll() : mutedGroup(muteTarget);
  const state = $("#muteState");
  if (state) state.textContent = t(off ? "mute.stateOff" : "mute.stateOn");
  const back = $('[data-mute="off"]');
  if (back) back.hidden = !off;
}

function openMute(scope) {
  muteTarget = scope || "all";
  const all = muteTarget === "all";
  const ttl = $("#muteTitle"), sub = $("#muteSub");
  if (ttl) ttl.textContent = t(all ? "mute.titleAll" : "mute.titleGroup");
  if (sub) sub.textContent = t(all ? "mute.subAll" : "mute.subGroup");
  paintMuteSheet();
  show("mute");
}

async function saveMute(kind) {
  if (!muteTarget) return;
  const body = { device };
  if (muteTarget === "all") body.scope = "all";
  else body.eventId = muteTarget;
  if (kind === "off") body.off = true;
  else body.days = Number(kind);
  try {
    const d = await api("/mutes", { method: "POST", body: JSON.stringify(body) });
    mutes = { all: d.all ?? null, groups: d.groups || {} };
  } catch (err) {
    toastErr(err.data?.error || t("toast.error"));
    return;
  }
  paintMute();
  hide("mute");
  toast(t(kind === "off" ? "mute.onToast" : "mute.okToast"));
}

let unreadKey = "";

async function loadUnread() {
  try {
    const d = await api("/unread?device=" + encodeURIComponent(device));
    unread = d.events || {};
  } catch {
    return;
  }
  // arrivato qualcosa di nuovo mentre guardi: un colpo di vibrazione, niente popup
  const chiave = JSON.stringify(unread);
  // niente di nuovo: non ridisegno la lista (era il motivo per cui scattava ogni 12 secondi)
  if (chiave === unreadKey) return;
  if (unreadKey && chiave !== unreadKey && !chatOpen) {
    try { navigator.vibrate?.([60, 40, 60]); } catch {}
  }
  unreadKey = chiave;
  renderList();
  if (active) renderDetail(active);
}

function startUnread() {
  loadUnread();
  clearInterval(unreadTimer);
  // con tanta gente dentro, ogni telefonata si paga: 45 secondi bastano e avanzano
  unreadTimer = setInterval(() => {
    if (chatOpen || document.hidden || navigator.onLine === false) return;
    loadUnread();
  }, 45000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !chatOpen) loadUnread();
    // tornando sull'app: se gli avvisi sono permessi ma l'iscrizione è caduta, la rifaccio
    if (!document.hidden) ensurePush();
  });
}

async function openChat(id, title) {
  peek("chat_aperta", title || "");
  chatOpen = true;
  chatId = id;
  chatLast = 0;
  msgReacts = {};
  $("#chatTitle").textContent = title || t("detail.chat");
  $("#chatList").innerHTML = `<p class="muted">${esc(t("home.loading"))}</p>`;
  show("chat");
  ricordaPannello("chat", { ev: id, t: title || "" });
  paintMute();
  loadMutes();
  chatNeedRead = true;
  await loadChat(true);
  clearInterval(chatTimer);
  chatTimer = setInterval(() => {
    // chat chiusa o schermo spento: nessuna richiesta inutile
    if (document.hidden || navigator.onLine === false) return;
    loadChat(false);
  }, 2500);
}

let chatFirma = "";
let chatNeedRead = true;

function stopChat() {
  chatOpen = false;
  chatFirma = "";
  clearInterval(chatTimer);
  chatTimer = null;
  paintTyping([]);
  loadUnread();
}

// "Luca sta scrivendo…": la riga sparisce da sola quando smette
function paintTyping(names) {
  const el = $("#chatTyping");
  if (!el) return;
  const list = (names || []).filter(Boolean);
  if (!list.length) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  // con più di due: "Bruno, Anna e Luca"
  const shown = list.length > 3 ? list.slice(0, 3).concat("…") : list;
  const label =
    shown.length === 1
      ? shown[0]
      : shown.length === 2
        ? `${shown[0]} e ${shown[1]}`
        : `${shown.slice(0, -1).join(", ")} e ${shown[shown.length - 1]}`;
  const scritto = t(list.length === 1 ? "chat.typingOne" : "chat.typingMany", { n: label });
  if (el.textContent !== scritto) el.textContent = scritto;
}

// dico agli altri che sto scrivendo, al massimo ogni due secondi
function pingTyping() {
  if (!chatOpen || !chatId) return;
  const input = $("#chatInput");
  if (!input || !input.value.trim()) return;
  const now = Date.now();
  if (now - typingSentAt < 2000) return;
  typingSentAt = now;
  api(`/events/${chatId}/typing`, {
    method: "POST",
    body: JSON.stringify({ device, name: person?.firstName || "" }),
  }).catch(() => {});
}

function msgHtml(m) {
  const at = new Intl.DateTimeFormat(LOCALES[lang], { hour: "2-digit", minute: "2-digit" }).format(new Date(m.at));
  let body = esc(m.text);
  if (m.kind === "sticker") {
    const s = STICKER_PACK.find((x) => x.id === m.text) || STICKER_PACK[0];
    body = `<span class="sticker">${s.emoji}</span>`;
  }
  return `<div class="msg ${m.mine ? "mine" : ""}" data-id="${m.id}">${m.mine ? "" : `<span class="who">${esc(m.name)}</span>`}${body}<span class="at">${esc(at)}</span></div>`;
}

// disegna i pallini delle reaction sotto ai messaggi
function paintReacts() {
  const box = $("#chatList");
  if (!box) return;
  box.querySelectorAll(".msg").forEach((el) => {
    const list = msgReacts[el.dataset.id] || [];
    let holder = el.querySelector(".reacts");
    if (!list.length) {
      if (holder) holder.remove();
      return;
    }
    if (!holder) {
      holder = document.createElement("div");
      holder.className = "reacts";
      el.appendChild(holder);
    }
    holder.innerHTML = list
      .map((r) => `<button type="button" class="react-chip${r.mine ? " mine" : ""}" data-msg="${esc(el.dataset.id)}" data-emoji="${r.e}">${r.e}${r.n > 1 ? `<b>${r.n}</b>` : ""}</button>`)
      .join("");
  });
}

function closePicker() {
  document.querySelectorAll("#chatList .react-pick").forEach((el) => el.remove());
}

function openPicker(msgEl) {
  closePicker();
  const pick = document.createElement("div");
  pick.className = "react-pick";
  pick.innerHTML = REACT_EMOJI.map((e) => `<button type="button" data-emoji="${e}">${e}</button>`).join("");
  msgEl.insertAdjacentElement("afterend", pick);
}

async function sendReact(msgId, emoji) {
  try {
    const d = await api(`/events/${chatId}/messages/${msgId}/react`, {
      method: "POST",
      body: JSON.stringify({ device, emoji }),
    });
    msgReacts[msgId] = d.reactions || [];
  } catch (err) {
    toastErr(err.data?.error || t("toast.error"));
  }
  closePicker();
  paintReacts();
}

// figurine e GIF
function buildStickers() {
  const grid = $("#stickerGrid");
  if (!grid) return;
  grid.innerHTML = STICKER_PACK.map((s) => `<button type="button" data-sticker="${s.id}" aria-label="${s.id}">${s.emoji}</button>`).join("");
}

async function sendMedia(kind, extra) {
  try {
    await api(`/events/${chatId}/messages`, {
      method: "POST",
      body: JSON.stringify({ device, name: person?.firstName || "", kind, ...extra }),
    });
    $("#stickerPad") && ($("#stickerPad").hidden = true);
    await loadChat(false);
  } catch (err) {
    toastErr(err.data?.error || t("chat.err"));
  }
}



async function loadChat(first) {
  if (!chatId || chatBusy) return;
  chatBusy = true;
  try {
    const leggi = chatNeedRead ? "&read=1" : "";
    const data = await api(`/events/${chatId}/messages?device=${encodeURIComponent(device)}&since=${chatLast}${leggi}`);
    chatNeedRead = false;
    unread[chatId] = 0;
    // il pallino sulla barra sparisce appena la chat è davanti agli occhi
    document.querySelectorAll("#chatBtn .unread").forEach((el) => el.remove());
    $("#chatMembers").textContent = t("chat.members", { n: data.members || 0 });
    paintTyping(data.typing || []);
    const box = $("#chatList");
    // scarto quello che è già nello schermo: così non compare due volte
    const fresh = data.messages.filter((m) => !box.querySelector(`.msg[data-id="${m.id}"]`));
    if (first && !fresh.length) {
      box.innerHTML = data.messages.length ? "" : `<p class="muted">${esc(t("chat.empty"))}</p>`;
    }
    if (data.reactions) {
      msgReacts = {};
      for (const r of data.reactions) {
        (msgReacts[r.m] = msgReacts[r.m] || []).push({ e: r.e, n: r.n, mine: r.mine });
      }
    }
    if (fresh.length) {
      // ci sono messaggi nuovi: al prossimo giro segno che li hai visti
      chatNeedRead = true;
      if (box.querySelector(".muted")) box.innerHTML = "";
      box.insertAdjacentHTML("beforeend", fresh.map(msgHtml).join(""));
      chatLast = Math.max(chatLast, fresh[fresh.length - 1].id);
      box.scrollTop = box.scrollHeight;
    }
    paintReacts();
  } catch (err) {
    if (first) $("#chatList").innerHTML = `<p class="muted">${esc(err.data?.error || t("chat.locked"))}</p>`;
  }
  chatBusy = false;
}

async function sendChat(e) {
  e.preventDefault();
  const input = $("#chatInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  try {
    await api(`/events/${chatId}/messages`, { method: "POST", body: JSON.stringify({ text, device, name: person?.firstName || "" }) });
    peek("messaggio", (active && active.event ? active.event.title : "") + " · " + text.slice(0, 50));
    typingSentAt = 0;
    paintTyping([]);
    await loadChat(false);
  } catch (err) {
    toastErr(err.data?.error || t("chat.err"));
    input.value = text;
  }
}

function renderChat() {
  chatLast = 0;
  chatNeedRead = true;
  loadChat(true);
}

/* ---------- creazione ---------- */
let placeGeo = null;
// il paese del suggerimento scelto: cosi l'evento salva la citta giusta
let placeCity = "";
let editingId = null; // se stai modificando un evento che esiste già
let placeTimer = null;

function fillActivityOptions() {
  const list = $("#activityList");
  const sel = $("#catSelect");
  if (!list || !sel || !taxonomy) return;
  const items = rankActivities(taxonomy.activities.filter((a) => !sel.value || a.cat === sel.value));
  list.innerHTML = items.map((a) => `<option value="${esc(actName(a))}"></option>`).join("");
}

// il pannello serve sia per creare sia per modificare: cambia solo il testo
function setBtnText(btn, testo) {
  if (!btn) return;
  const why = btn.querySelector(":scope > .why");
  btn.textContent = testo;
  if (why) btn.appendChild(why);
}

function paintCreateMode() {
  const ttl = $("#createTitle"), sub = $("#createSub"), btn = $("#publishBtn");
  const edit = Boolean(editingId);
  if (ttl) ttl.textContent = t(edit ? t("edit.title") : t("create.title"));
  if (sub) sub.textContent = t(edit ? t("edit.sub") : t("create.sub"));
  if (btn) setBtnText(btn, t(edit ? t("edit.save") : t("create.publish")));
}

// apre lo stesso pannello con dentro i dati dell'evento
async function openEdit(ev) {
  if (!person) { openRegister(); return; }
  await openCreate();
  editingId = ev.id;
  const form = $("#createForm");
  form.title.value = ev.title || "";
  form.category.value = ev.category || "Altro";
  form.activity.value = ev.activity || "";
  form.place.value = ev.place || "";
  form.capacity.value = ev.capacity || 12;
  form.host.value = ev.host || person.firstName || "";
  form.description.value = ev.description || "";
  // "solo chi ha una foto" non esiste più: gli eventi vecchi restano leggibili
  form.access.value = ["verified", "invite"].includes(ev.access) ? ev.access : "verified";
  form.approval.value = ev.approval ? "1" : "0";
  // com'era impostata la ripetizione
  const mode = ev.weeklyDay !== null && ev.weeklyDay !== undefined ? "weekly"
    : Array.isArray(ev.days) && ev.days.length ? "days"
    : ev.endsAt ? "range" : "single";
  const aLocale = (ms, taglio) => {
    const d = new Date(Number(ms) - new Date(Number(ms)).getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, taglio);
  };
  if (form.mode) form.mode.value = mode;
  if (form.endWhen) form.endWhen.value = ev.endsAt ? aLocale(ev.endsAt, 16) : "";
  if (form.weekday && ev.weeklyDay !== null && ev.weeklyDay !== undefined) form.weekday.value = String(ev.weeklyDay);
  if (form.repeatUntil) form.repeatUntil.value = ev.repeatUntil ? aLocale(ev.repeatUntil, 10) : "";
  dayList = Array.isArray(ev.days) ? ev.days.filter((n) => n !== ev.startsAt) : [];
  weekdaysList = Array.isArray(ev.weekdays) ? ev.weekdays.slice() : [];
  paintRipetizione();
  paintGiorniScelti();
  // la data nel formato del modulo, nel fuso del telefono
  const d = new Date(Number(ev.startsAt) || Date.now());
  const pad = (n) => String(n).padStart(2, "0");
  form.when.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const lo = $("#ageMin"), hi = $("#ageMax");
  if (lo) lo.value = ev.ageMin || AGE_LO;
  if (hi) hi.value = ev.ageMax || AGE_HI;
  paintAge();
  // se l'evento chiudeva le iscrizioni N ore prima, lo stesso N resta scelto
  if (form.signupHours) {
    const hrs = ev.signupUntil ? Math.round((Number(ev.startsAt) - Number(ev.signupUntil)) / 3600000) : 0;
    form.signupHours.value = ["0", "2", "12", "24"].includes(String(hrs)) ? String(hrs) : "0";
  }
  impostaChip("vibePick", ev.vibe || "");
  impostaChip("comfortPick", ev.comfort || "");
  placeGeo = ev.lat && ev.lng ? { lat: ev.lat, lng: ev.lng } : null;
  fotoEvento = (ev.photos || []).map((u) => String(u).split("/").pop()).filter(Boolean).slice(0, 3);
  disegnaFotoEvento();
  paintCreateMode();
  show("create");
}


// le scelte a chip del modulo: una sola scelta per riga, si tocca di nuovo e si toglie
function scegliChip(boxId, valore) {
  const box = $("#" + boxId);
  if (!box) return;
  box.querySelectorAll("[data-vibe],[data-comfort]").forEach((b) => {
    const suo = b.dataset.vibe || b.dataset.comfort;
    b.classList.toggle("on", Boolean(valore) && suo === valore);
  });
}

function impostaChip(boxId, valore) {
  const box = $("#" + boxId);
  if (!box) return;
  box.querySelectorAll("[data-vibe],[data-comfort]").forEach((b) => {
    b.onclick = () => {
      const suo = b.dataset.vibe || b.dataset.comfort;
      const campo = b.dataset.vibe ? $("#vibeValue") : $("#comfortValue");
      const gia = campo && campo.value === suo;
      if (campo) campo.value = gia ? "" : suo;
      scegliChip(boxId, gia ? "" : suo);
    };
  });
  scegliChip(boxId, valore || "");
}

async function openCreate() {
  if (!possoFareEventi()) return;
  if (!person) { openRegister(); toast(t("create.errLogin")); return; }
  editingId = null; // "nuovo evento" parte sempre da zero
  paintCreateMode();
  const tax = await loadTaxonomy().catch(() => null);
  const sel = $("#catSelect");
  if (tax && !sel.options.length) {
    sel.innerHTML = tax.categories.map((c) => `<option value="${c.id}">${esc(catName(c.id))}</option>`).join("");
  }
  fillActivityOptions();
  const form = $("#createForm");
  // il modulo riparte davvero vuoto: niente testi, date o luoghi rimasti da prima
  form.reset();
  placeGeo = null;
  dayList = [];
  weekdaysList = [];
  fotoEvento = [];
  disegnaFotoEvento();
  impostaChip("vibePick", "");
  impostaChip("comfortPick", "");
  if (form.mode) form.mode.value = "single";
  if (form.endWhen) form.endWhen.value = "";
  if (form.repeatUntil) form.repeatUntil.value = "";
  if ($("#repVaryTimes")) $("#repVaryTimes").checked = false;
  paintRipetizione();
  paintGiorniScelti();
  if (!form.host.value) form.host.value = person.firstName || "";
  $("#formError").hidden = true;
  paintAge();
  show("create");
}

// le foto dell'evento scelte nel modulo (chiavi delle immagini sul server)
let fotoEvento = [];

function disegnaFotoEvento() {
  const box = $("#evPhotos");
  const add = $("#evPhotoAdd");
  const inp = $("#evPhotoInput");
  if (!box) return;
  box.innerHTML = fotoEvento
    .map(
      (k, i) =>
        `<div class="ph"><img src="/api/photo/${esc(k)}" alt="" loading="lazy" decoding="async"><span class="ph-n">${i + 1}</span><button type="button" data-nophoto="${i}" aria-label="${esc(t("create.photoRemove"))}">×</button></div>`
    )
    .join("");
  if (add) {
    add.hidden = fotoEvento.length >= 3;
    // il riquadro dice sempre cosa fare e quante ne hai messe
    add.innerHTML = `<span class="pp-plus" aria-hidden="true">+</span>
      <span class="pp-t"><b>${esc(t(fotoEvento.length ? "create.photoMore" : "create.photoAdd2"))}</b>
      <i>${esc(t("create.photoSub", { n: fotoEvento.length }))}</i></span>`;
  }
  box.querySelectorAll("[data-nophoto]").forEach((b) => {
    b.onclick = () => {
      fotoEvento.splice(Number(b.dataset.nophoto), 1);
      disegnaFotoEvento();
    };
  });
  if (add && !add.dataset.on) {
    add.dataset.on = "1";
    add.onclick = () => { if (fotoEvento.length >= 3) return toast(t("create.photoMax")); apriSceltaFoto("event"); };
  }
  if (inp && !inp.dataset.on) {
    inp.dataset.on = "1";
    inp.onchange = async () => {
      const files = [...(inp.files || [])];
      inp.value = "";
      for (const f of files) {
        if (fotoEvento.length >= 3) { toast(t("create.photoMax")); break; }
        await aggiungiFotoEvento(f);
      }
    };
  }
}

// una foto del telefono rimpicciolita: pesa poco e si carica in un attimo
function riduciFoto(file, lato = 1600, qualita = 0.82) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scala = Math.min(1, lato / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.width * scala));
        c.height = Math.max(1, Math.round(img.height * scala));
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        res(c.toDataURL("image/jpeg", qualita));
      } catch (e) { URL.revokeObjectURL(url); rej(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("foto")); };
    try { img.src = url; } catch (e) { rej(e); }
  });
}

async function aggiungiFotoEvento(file) {
  const box = $("#evPhotos");
  let segnaposto = null;
  if (box) {
    segnaposto = document.createElement("div");
    segnaposto.className = "ph loading";
    segnaposto.textContent = "…";
    box.appendChild(segnaposto);
  }
  try {
    let data = await riduciFoto(file);
    for (let i = 0; i < 2 && data.length > 380 * 1024; i++) data = await riduciFoto(file, 1100 - i * 300, 0.7);
    const r = await api("/event/photo", { method: "POST", body: JSON.stringify({ device, data }) });
    if (!r || !r.key) throw new Error((r && r.error) || "foto");
    fotoEvento.push(r.key);
  } catch (e) {
    toast(String((e && e.message) || "").slice(0, 120) || t("create.photoMax"));
  } finally {
    if (segnaposto) segnaposto.remove();
    disegnaFotoEvento();
  }
}

// i giorni scelti a mano per un evento "a saltare", ognuno con la sua ora
let dayList = [];
// i giorni della settimana per l'evento che si ripete, ognuno con la sua ora
let weekdaysList = [];

function fmtDayMonth(ms) {
  return new Intl.DateTimeFormat(LOCALES[lang], { day: "numeric", month: "short" }).format(new Date(ms));
}

function paintRipetizione() {
  const mode = $("#repMode")?.value || "single";
  const end = $("#repEndWrap"), days = $("#repDaysWrap"), week = $("#repWeekWrap");
  if (end) end.hidden = mode !== "range";
  if (days) days.hidden = mode !== "days";
  if (week) week.hidden = mode !== "weekly";
  paintOrariDiversi();
}

// "più giorni di fila": se gli orari cambiano, si sceglie l'ora di ogni giorno
function paintOrariDiversi() {
  const box = $("#repRangeRows");
  const acceso = $("#repVaryTimes");
  if (!box) return;
  const mode = $("#repMode")?.value || "single";
  if (mode !== "range" || !acceso || !acceso.checked) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  const form = $("#createForm");
  const inizio = new Date(form.when.value);
  const fine = new Date(form.endWhen.value);
  if (!Number.isFinite(inizio.getTime()) || !Number.isFinite(fine.getTime()) || fine <= inizio) {
    box.hidden = true;
    box.innerHTML = `<p class="hint">Metti prima il primo e l'ultimo giorno.</p>`;
    return;
  }
  const ore = (d) => String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  const righe = [];
  const d = new Date(inizio.getTime());
  d.setHours(12, 0, 0, 0);
  const ultimo = new Date(fine.getTime());
  ultimo.setHours(23, 59, 59, 999);
  let guardia = 0;
  while (d.getTime() <= ultimo.getTime() && guardia < 62) {
    d.setHours(inizio.getHours(), inizio.getMinutes(), 0, 0);
    righe.push({ giorno: d.getTime(), ora: ore(d) });
    d.setDate(d.getDate() + 1);
    guardia += 1;
  }
  box.hidden = false;
  box.innerHTML = righe
    .map((r, i) => `<label class="rr"><span>${esc(fmtDayMonth(r.giorno))}</span><input type="time" data-rr="${i}" value="${r.ora}"></label>`)
    .join("");
}

function fmtOra(ms) {
  return new Intl.DateTimeFormat(LOCALES[lang], { hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}

function paintGiorniScelti() {
  const box = $("#dayChips");
  if (box) {
    box.innerHTML = dayList
      .map((ms, i) => `<button class="chip" type="button" data-togli="${i}">${esc(fmtDayMonth(ms))} ${esc(fmtOra(ms))} ×</button>`)
      .join("");
  }
  const wbox = $("#weekdayChips");
  if (wbox) {
    wbox.innerHTML = weekdaysList
      .map((g, i) => `<button class="chip" type="button" data-toglig="${i}">${esc(fmtProxGiorno(g.d))}${g.t ? " " + esc(g.t) : ""} ×</button>`)
      .join("");
  }
}

// gli altri giorni prendono la stessa ora del primo
function giornoConOra(dateStr, oraScelta) {
  const d = new Date(dateStr + "T00:00:00");
  if (!Number.isFinite(d.getTime())) return null;
  const ora = String(oraScelta || "");
  if (/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(ora)) {
    const [hh, mm] = ora.split(":").map(Number);
    d.setHours(hh, mm, 0, 0);
    return d.getTime();
  }
  // senza ora sua, vale quella dell'evento
  const base = new Date($("#createForm").when.value);
  if (!Number.isFinite(base.getTime())) return null;
  d.setHours(base.getHours(), base.getMinutes(), 0, 0);
  return d.getTime();
}

async function submitCreate(e) {
  e.preventDefault();
  const form = $("#createForm");
  const err = $("#formError");
  const btn = $("#publishBtn");
  err.hidden = true;
  const editId = editingId;
  const when = new Date(form.when.value).getTime();
  if (!Number.isFinite(when) || (!editId && when < Date.now() - 60000)) {
    err.textContent = t("create.errDate");
    err.hidden = false;
    return;
  }
  // senza foto e verifica non si crea: la regola vale prima di chiedere al server
  if (!editId && !possoFareEventi()) {
    hide("create");
    return;
  }
  const payload = {
    title: form.title.value.trim(),
    category: form.category.value,
    activity: form.activity.value.trim(),
    lat: placeGeo ? placeGeo.lat : null,
    lng: placeGeo ? placeGeo.lng : null,
    city: placeCity || "",
    description: form.description.value.trim(),
    startsAt: when,
    place: form.place.value.trim(),
    photos: fotoEvento.slice(0, 3),
    capacity: Number(form.capacity.value) || 12,
    host: form.host.value.trim() || person.firstName,
    approval: form.approval.value === "1",
    access: form.access ? form.access.value : "photo",
    vibe: $("#vibeValue") ? $("#vibeValue").value : "",
    comfort: $("#comfortValue") ? $("#comfortValue").value : "",
    signupHours: Number(form.signupHours.value) || 0,
    ageMin: Number($("#ageMin")?.value) || AGE_LO,
    ageMax: Number($("#ageMax")?.value) || AGE_HI,
    mode: form.mode ? form.mode.value : "single",
    device,
  };
  // eventi lunghi: giorni di fila, giorni scelti o stesso giorno ogni settimana
  if (payload.mode === "range" && !$("#repVaryTimes")?.checked) {
    const fine = new Date(form.endWhen.value).getTime();
    if (!Number.isFinite(fine) || fine <= payload.startsAt) {
      err.textContent = "Scegli l'ultimo giorno: deve venire dopo il primo.";
      err.hidden = false;
      return;
    }
    payload.endWhen = fine;
  } else if (payload.mode === "range") {
    // gli orari cambiano giorno per giorno: diventa un elenco di giorni con la loro ora
    const giorni = [];
    document.querySelectorAll("#repRangeRows [data-rr]").forEach((inp) => {
      const riga = inp.closest(".rr");
      const base = new Date(payload.startsAt);
      const i = Number(inp.dataset.rr);
      const d = new Date(base.getTime());
      d.setDate(d.getDate() + i);
      const [hh, mm] = String(inp.value || "").split(":").map(Number);
      if (Number.isFinite(hh) && Number.isFinite(mm)) d.setHours(hh, mm, 0, 0);
      giorni.push(d.getTime());
      void riga;
    });
    if (giorni.length < 2) {
      err.textContent = "Metti la data di fine, poi gli orari di ogni giorno.";
      err.hidden = false;
      return;
    }
    payload.mode = "days";
    // il primo giorno porta anche la sua ora
    payload.startsAt = giorni[0];
    payload.days = giorni.slice(1);
  } else if (payload.mode === "days") {
    if (!dayList.length) {
      err.textContent = "Aggiungi almeno un altro giorno, oppure scegli un giorno solo.";
      err.hidden = false;
      return;
    }
    payload.days = dayList.slice();
  } else if (payload.mode === "weekly") {
    const until = form.repeatUntil.value ? new Date(form.repeatUntil.value + "T23:59:00").getTime() : null;
    let giorni = weekdaysList.slice();
    if (!giorni.length) {
      const d = Number(form.weekday.value);
      const t = $("#weekdayTime")?.value || "";
      giorni = [{ d, t }];
    }
    if (until && until < payload.startsAt) {
      err.textContent = "L'ultima data deve venire dopo la prima.";
      err.hidden = false;
      return;
    }
    payload.weekday = giorni[0].d;
    payload.weekdays = giorni;
    payload.repeatUntil = until;
  }

  if (!payload.title || !payload.place) {
    err.textContent = t("reg.err");
    err.hidden = false;
    return;
  }
  btn.disabled = true;
  setBtnText(btn, t("create.publishing"));
  try {
    const data = editId
      ? await api(`/events/${editId}`, { method: "PUT", body: JSON.stringify(payload) })
      : await api("/events", { method: "POST", body: JSON.stringify(payload) });
    form.title.value = "";
    form.place.value = "";
    form.activity.value = "";
    placeGeo = null;
    placeCity = "";
    fotoEvento = [];
    disegnaFotoEvento();
    form.description.value = "";
    dayList = [];
    weekdaysList = [];
    if (form.mode) form.mode.value = "single";
    if (form.endWhen) form.endWhen.value = "";
    if (form.repeatUntil) form.repeatUntil.value = "";
    if ($("#repVaryTimes")) $("#repVaryTimes").checked = false;
    if ($("#timePick")) $("#timePick").value = "";
    if ($("#weekdayTime")) $("#weekdayTime").value = "";
    paintRipetizione();
    paintGiorniScelti();
    hide("create");
    resetAge();
    peek(editId ? "evento_modificato" : "evento_creato", $("#titleInput")?.value || "");
    toast(t(editId ? "edit.ok" : "create.ok"));
    if (editId) {
      editingId = null;
      paintCreateMode();
      await loadEvents(true);
      openDetail(editId);
      return;
    }
    // se l'attività era nuova, da adesso è nella lista di tutti
    if (taxonomy && payload.activity) {
      const known = taxonomy.activities.some((a) => a.it.toLowerCase() === payload.activity.toLowerCase());
      if (!known) {
        await loadExtras();
        fillActivityOptions();
        if (taxonomy.activities.some((a) => a.extra && a.it.toLowerCase() === payload.activity.toLowerCase())) {
          toast(t("map.added"));
        }
      }
    }
    // apro subito il nuovo evento e ricarico la lista dietro, senza farlo aspettare
    openDetail(data.id);
    loadEvents(true).catch(() => {});
  } catch (e2) {
    if (e2.data?.needRegister) { hide("create"); openRegister(); return; }
    err.textContent = e2.data?.error || t("toast.error");
    err.hidden = false;
  } finally {
    btn.disabled = false;
    paintCreateMode();
  }
}

/* ---------- registrazione ---------- */
function openRegister() {
  const f = $("#regForm");
  if (person) {
    f.firstName.value = person.firstName || "";
    f.lastName.value = person.lastName || "";
    f.email.value = person.email || "";
    f.phone.value = person.phone || "";
    f.age.value = person.age || "";
  }
  $("#regError").hidden = true;
  show("register");
}

function validEmail(v) { return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(v); }
function validPhone(v) { return /^\+?[0-9\s.\-()]{8,18}$/.test(v); }

async function submitRegister(e) {
  e.preventDefault();
  const f = $("#regForm");
  const err = $("#regError");
  const btn = $("#regBtn");
  const data = {
    firstName: f.firstName.value.trim(),
    lastName: f.lastName.value.trim(),
    email: f.email.value.trim().toLowerCase(),
    phone: f.phone.value.trim(),
    age: Number(f.age.value),
    sex: f.sex.value,
    password: f.password.value,
    city: f.city.value.trim() || "Catania",
    consent: f.consent.checked,
    interests: onb.interests || [],
    categories: onb.categories || [],
    goals: (onb.goals || []).map(label),
    meet: (onb.meet || []).map(label),
    outings: (onb.outings || []).map(label),
    locale: lang,
    device,
  };
  let bad = "";
  if (!data.firstName || !data.lastName) bad = t("reg.err");
  else if (!validEmail(data.email)) bad = t("reg.errEmail");
  else if (!validPhone(data.phone)) bad = t("reg.errPhone");
  else if (!(data.age >= 18 && data.age <= 99)) bad = t("reg.errAge");
  else if (data.password.length < 8) bad = t("reg.errPassword");
  if (bad) {
    err.textContent = bad;
    err.hidden = false;
    sendFriction("errore_campo", bad.slice(0, 50));
    return;
  }
  btn.disabled = true;
  btn.textContent = t("common.sending");
  try {
    const res = await api("/register", { method: "POST", body: JSON.stringify(data) });
    person = res.person ? { ...res.person, device } : { ...data, photo: "", bio: "", lookingFor: "", done: "" };
    regOpenedAt = 0;
    save(K.person, person);
    save(K.onb, onb);
    syncMe();
    paintOwner();
    hide("register");
    toast(t("toast.registered"));
    openWelcome(true);
  } catch (e2) {
    if (e2.data?.emailTaken) { hide("register"); openLogin(data.email); return; }
    err.textContent = e2.data?.error || t("toast.error");
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = t("reg.submit");
  }
}

/* ---------- accesso ---------- */
function openLogin(mail) {
  const f = $("#loginForm");
  if (mail) f.email.value = mail;
  $("#loginError").hidden = true;
  show("login");
}

let resetToken = "";

function openForgot(mail) {
  const f = $("#forgotForm");
  if (!f) return;
  if (mail) f.email.value = mail;
  $("#forgotError").hidden = true;
  $("#forgotDone").hidden = true;
  $("#forgotSubmit").hidden = false;
  show("forgot");
}

async function submitForgot(e) {
  e.preventDefault();
  const f = $("#forgotForm");
  const err = $("#forgotError");
  const btn = $("#forgotSubmit");
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = t("login.working");
  try {
    const r = await api("/forgot", { method: "POST", body: JSON.stringify({ email: f.email.value.trim().toLowerCase() }) });
    btn.hidden = true;
    const done = $("#forgotDone");
    done.hidden = false;
    if (r && r.link) {
      done.innerHTML = `${esc(t("forgot.link"))} <a class="tiny" href="${esc(r.link)}">${esc(t("forgot.open"))}</a>`;
    } else if (r && r.known === false) {
      done.innerHTML = esc(t("forgot.none"));
    } else if (r && r.mail === false) {
      done.innerHTML = `${esc(t("forgot.off"))} <a href="mailto:christianguarrera@gmail.com">christianguarrera@gmail.com</a>`;
    } else {
      done.innerHTML = esc(t("forgot.done"));
    }
  } catch (e2) {
    err.textContent = e2.data?.error || t("toast.error");
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = t("forgot.send");
  }
}

function openReset(token) {
  if (!token) return;
  resetToken = token;
  const err = $("#resetError");
  if (err) err.hidden = true;
  show("reset");
}

async function submitReset(e) {
  e.preventDefault();
  const f = $("#resetForm");
  const err = $("#resetError");
  const btn = $("#resetSubmit");
  err.hidden = true;
  if (f.password.value !== f.password2.value) {
    err.textContent = t("reset.mismatch");
    err.hidden = false;
    return;
  }
  btn.disabled = true;
  btn.textContent = t("login.working");
  try {
    await api("/reset", { method: "POST", body: JSON.stringify({ token: resetToken, password: f.password.value }) });
    hide("reset");
    resetToken = "";
    history.replaceState(null, "", location.pathname);
    toast(t("reset.done"));
    openLogin();
  } catch (e2) {
    err.textContent = e2.data?.error === "Link scaduto o già usato. Chiedine un altro." ? t("reset.bad") : e2.data?.error || t("toast.error");
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = t("reset.send");
  }
}

async function submitLogin(e) {
  e.preventDefault();
  const f = $("#loginForm");
  const err = $("#loginError");
  const btn = $("#loginSubmit");
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = t("login.working");
  try {
    const r = await api("/login", {
      method: "POST",
      body: JSON.stringify({ email: f.email.value.trim().toLowerCase(), password: f.password.value, device }),
    });
    person = { ...r.person, device };
    save(K.person, person);
    if (r.owner) localStorage.setItem(OWNER_TOKEN_KEY, r.owner);
    syncMe();
    try { askPushSoon(); } catch {}
    paintOwner();
    hide("login");
    f.password.value = "";
    toast(t("reg.done"));
    if (!localStorage.getItem("fuori.welDone")) openWelcome();
    loadEvents(true);
  } catch (e2) {
    err.textContent = e2.data?.error || t("login.err");
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = t("login.enter");
  }
}

async function logout() {
  if (!confirm(t("prof.logoutConfirm"))) return;
  try {
    await api("/logout", { method: "POST", body: JSON.stringify({ device }) });
  } catch {}
  person = null;
  localStorage.removeItem(K.person);
  syncMe();
  paintOwner();
  hide("profile");
  toast(t("prof.logout"));
  loadEvents(true);
}

/* ---------- profilo ---------- */
function renderPhotoBad() {
  const box = $("#photoBadBox");
  if (box) box.hidden = !person?.photoBad;
}

function renderProfileBadges() {
  renderPhotoBad();
  const box = $("#profileBadges");
  if (!box) return;
  box.innerHTML =
    `<span class="badge ${person?.photo ? "ok" : "todo"}">${esc(person?.photo ? t("prof.withPhoto") : t("prof.noPhoto"))}</span>` +
    (person?.verified
      ? `<span class="badge ok">${esc(t("badge.verified"))}</span>`
      : person?.facePending
      ? `<span class="badge todo">${esc(t("verify.pending"))}</span>`
      : "");
}

// il nome si adatta alla sua lunghezza: la spunta resta sempre sulla stessa riga
function fitProfileName() {
  const el = $("#profileName");
  if (!el) return;
  const txt = el.querySelector(".pn-text");
  el.style.fontSize = "20px";
  if (!txt) return;
  let size = 20;
  // scende mezzo punto per volta finché nome e spunta stanno insieme
  while (size > 13.5 && txt.scrollWidth > txt.clientWidth + 1) {
    size -= 0.5;
    el.style.fontSize = size + "px";
  }
}

function openProfile() {
  if (!person) { openRegister(); return; }
  const set = (sel, v) => { const el = $(sel); if (el) el.value = v || ""; };
  $("#profileName").innerHTML =
    `<span class="pn-text">${esc([person.firstName, person.lastName].filter(Boolean).join(" ") || t("prof.title"))}</span>` +
    (person.verified ? '<span class="vcheck" title="Utente verificato">✓</span>' : "");
  set("#profileBio", person.bio);
  set("#profileLooking", person.lookingFor);
  set("#profileDone", person.done);
  set("#profileAge", person.age);
  $("#profileSex").value = person.sex || "n";
  const img = $("#profilePhoto");
  if (person.photo) { img.src = person.photo; img.style.display = "block"; } else { img.removeAttribute("src"); img.style.display = "none"; }
  renderProfileBadges();
  show("profile");
  // il pannello deve essere visibile per misurare il nome
  requestAnimationFrame(() => fitProfileName());
  ricordaPannello("profile");
}

async function saveProfile() {
  if (!person) return;
  const body = {
    email: person.email,
    bio: $("#profileBio").value.trim(),
    lookingFor: $("#profileLooking").value.trim(),
    done: $("#profileDone").value.trim(),
    age: Number($("#profileAge").value) || null,
    sex: $("#profileSex").value,
    device,
  };
  try {
    await api("/profile", { method: "POST", body: JSON.stringify(body) });
    person = { ...person, ...body };
    save(K.person, person);
    toast(t("prof.saved"));
    hide("profile");
    if (active) openDetail(active.event.id);
  } catch (err) {
    toastErr(err.data?.error || t("toast.error"));
  }
}

let cropState = null;

function openCrop(file) {
  if (!person) return;
  const fr = new FileReader();
  fr.onerror = () => toast(t("prof.photoErr"));
  fr.onload = () => {
    const img = new Image();
    img.onerror = () => toast(t("prof.photoErr"));
    img.onload = async () => {
      cropState = { img, z: 1, ox: 0, oy: 0 };
      const zoom = $("#cropZoom");
      if (zoom) zoom.value = "1";
      hide("profile");
      show("crop");
      requestAnimationFrame(() => drawCrop());
      // se il telefono sa trovarmi la faccia, la metto al centro e la ingrandisco io:
      // così nella foto profilo si vede la faccia, non una figura intera a caso
      try {
        if ("FaceDetector" in window) {
          const fd = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 1 });
          const volti = await fd.detect(img);
          const bb = volti && volti[0] && volti[0].boundingBox;
          const c = $("#cropCanvas");
          if (bb && c && bb.height > 8) {
            const base = Math.max(c.width / img.width, c.height / img.height);
            // la faccia deve occupare circa metà del riquadro
            const s = (c.width * 0.5) / bb.height;
            const z = Math.min(3, Math.max(1, s / base));
            cropState.z = Math.round(z * 100) / 100;
            const k = base * cropState.z;
            cropState.ox = c.width / 2 - (bb.x + bb.width / 2) * k;
            cropState.oy = c.height / 2 - (bb.y + bb.height / 2) * k;
            if (zoom) zoom.value = String(cropState.z);
            drawCrop();
          }
        }
      } catch {}
    };
    img.src = fr.result;
  };
  fr.readAsDataURL(file);
}

function cropGeom() {
  const c = $("#cropCanvas");
  const W = c.width;
  const H = c.height;
  const { img, z } = cropState;
  const base = Math.max(W / img.width, H / img.height);
  const s = base * z;
  const w = img.width * s;
  const h = img.height * s;
  const mx = Math.max(0, (w - W) / 2);
  const my = Math.max(0, (h - H) / 2);
  cropState.ox = Math.min(mx, Math.max(-mx, cropState.ox || 0));
  cropState.oy = Math.min(my, Math.max(-my, cropState.oy || 0));
  return { W, H, w, h, x: (W - w) / 2 + cropState.ox, y: (H - h) / 2 + cropState.oy };
}

function drawCrop() {
  if (!cropState) return;
  const c = $("#cropCanvas");
  const ctx = c.getContext("2d");
  const g = cropGeom();
  ctx.fillStyle = "#0d0d0d";
  ctx.fillRect(0, 0, g.W, g.H);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(cropState.img, g.x, g.y, g.w, g.h);
}

async function confirmCrop() {
  if (!cropState) return;
  const btn = $("#cropOk");
  btn.disabled = true;
  btn.textContent = t("crop.working");
  try {
    const OUT = 720;
    const g = cropGeom();
    const k = OUT / g.W;
    const out = document.createElement("canvas");
    out.width = OUT;
    out.height = OUT;
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#0d0d0d";
    ctx.fillRect(0, 0, OUT, OUT);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(cropState.img, g.x * k, g.y * k, g.w * k, g.h * k);
    const dataUrl = out.toDataURL("image/jpeg", 0.92);
    cropState = null;
    hide("crop");
    await sendPhoto(dataUrl);
  } catch (err) {
    toastErr(err.data?.error || t("prof.photoErr"));
  } finally {
    btn.disabled = false;
    btn.textContent = t("crop.ok");
  }
}

// dice a voce alta che la foto si sta caricando, così non sembra che non sia successo niente
function photoState(testo) {
  let el = document.getElementById("photoState");
  if (!el) {
    el = document.createElement("p");
    el.id = "photoState";
    el.className = "hint";
    const img = $("#profilePhoto");
    const dove = img && img.parentElement ? img.parentElement : document.querySelector("#profile .sheet-in");
    if (dove) dove.appendChild(el);
  }
  el.textContent = testo;
  el.hidden = false;
  return el;
}

async function sendPhoto(dataUrl) {
  const stato = photoState("Sto caricando la foto…");
  try {
    const r = await api("/profile/photo", { method: "POST", body: JSON.stringify({ email: person.email, data: dataUrl, device }) });
    person.photo = r.photo;
    person.photoBad = false;
    // foto nuova = la verifica va rifatta su questa foto
    person.verified = false;
    person.facePending = false;
    save(K.person, person);
    const img = $("#profilePhoto");
    img.src = person.photo;
    img.style.display = "block";
    vShotData = "";
    const vImg = $("#vShot");
    if (vImg) vImg.hidden = true;
    syncMe();
    paintOwner();
    renderProfileBadges();
    paintVerify();
    if (stato) stato.textContent = "Foto caricata. Ora verifica il viso: due minuti e sei a posto.";
    toast(t("prof.photoVerify"));
    avvisoLungo(
      "Foto caricata, manca la verifica",
      "Adesso fai la verifica del viso: è un selfie veloce. Senza la verifica non puoi creare eventi né partecipare.",
      { label: "Fai la verifica", run: () => openVerify() }
    );
    refreshMe();
  } catch (err) {
    if (stato) stato.textContent = err.data?.error || "Non sono riuscito a caricarla: riprova.";
    if (err.status === 400 && /persona vera/i.test(String(err.data?.error || ""))) {
      person.photoBad = true;
      save(K.person, person);
      renderProfileBadges();
    }
    toastErr(err.data?.error || t("prof.photoErr"));
  }
}

function shrink(file, max, quality) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = reject;
    fr.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL("image/jpeg", quality));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

/* ---------- errori: l'app se ne accorge e li manda al padrone ---------- */
const erroriMandati = new Set();

function mandaErrore(msg, where) {
  try {
    const testo = String(msg || "").slice(0, 280);
    if (testo.length < 4) return;
    const firma = testo.slice(0, 100) + "|" + String(where || "");
    if (erroriMandati.has(firma)) return;
    erroriMandati.add(firma);
    fetch("/api/error", {
      method: "POST",
      headers: { "content-type": "application/json" },
      keepalive: true,
      body: JSON.stringify({
        msg: testo,
        where: String(where || ""),
        path: location.pathname + location.hash,
        version: VERSION,
        device,
        email: person?.email || "",
      }),
    }).catch(() => {});
  } catch {}
}

window.addEventListener("error", (e) => {
  if (!e || !e.message) return;
  const dove = e.filename ? String(e.filename).split("/").pop() + ":" + (e.lineno || 0) : "";
  mandaErrore(e.message, dove);
});
window.addEventListener("unhandledrejection", (e) => {
  const r = e && e.reason;
  mandaErrore(r && (r.message || r), "promise");
});

/* ---------- pareri ---------- */
async function submitFeedback(e) {
  e.preventDefault();
  const text = $("#fbText").value.trim();
  const err = $("#fbError");
  err.hidden = true;
  if (text.length < 3) { err.textContent = t("fb.err"); err.hidden = false; return; }
  const btn = $("#fbBtn");
  btn.disabled = true;
  try {
    await api("/feedback", {
      method: "POST",
      body: JSON.stringify({
        text,
        email: $("#fbEmail").value.trim(),
        kind: $("#fbKind").value,
        path: location.pathname + location.hash,
        device,
      }),
    });
    $("#fbText").value = "";
    hide("feedback");
    toast(t("fb.ok"));
  } catch {
    err.textContent = t("toast.error");
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

/* ---------- glossario: cosa vuol dire quella parola ---------- */
let glossario = {};

async function loadGlossario() {
  if (Object.keys(glossario).length) return glossario;
  try {
    const cached = localStorage.getItem("fuori.gloss");
    if (cached) {
      const preso = JSON.parse(cached);
      // vale solo se è della versione attuale: le spiegazioni nuove devono arrivare
      if (preso && preso.v === VERSION && preso.g) glossario = preso.g || {};
      else localStorage.removeItem("fuori.gloss");
    }
    if (Object.keys(glossario).length) return glossario;
  } catch {}
  try {
    const r = await fetch(`/glossario.json?v=${VERSION}`, { cache: "force-cache" });
    if (r.ok) {
      glossario = await r.json();
      localStorage.setItem("fuori.gloss", JSON.stringify({ v: VERSION, g: glossario }));
    }
  } catch {}
  return glossario;
}

function helpOf(name) {
  const k = HELP_ALIAS[name] || name;
  return HELP[k] || null;
}

function glossOf(name) {
  const h = helpOf(name);
  return h ? h.s : (glossario[name] || "");
}

function whyHtml(name) {
  return glossOf(name)
    ? `<span class="why" data-why="${esc(name)}" role="button" tabindex="0" aria-label="Come funziona">?</span>`
    : "";
}

function openGloss(name) {
  const h = helpOf(name);
  const g = glossOf(name);
  if (!g) return;
  $("#glossTitle").textContent = h ? h.t : name;
  $("#glossText").textContent = g;
  const link = $("#glossGuida");
  if (link) {
    link.hidden = !h;
    if (h) link.dataset.guida = h.g;
  }
  show("gloss");
}

/* ---------- ogni funzione ha la sua spiegazione, presa dalla guida ---------- */
const HELP = {
  home: { t: "🏠 Home", g: "home", s: "È il punto di partenza per esplorare le attività. Da qui puoi creare un evento, partecipare a uno esistente, scegliere come ti senti, esplorare le categorie, aprire la mappa o chiedere qualche idea. Puoi filtrare gli eventi per distanza, categoria e preferenze oppure esplorarli tutti." },
  "home.crea": { t: "Crea un evento", g: "home", s: "Organizza qualcosa di nuovo e invita altre persone. Premi il pulsante + al centro per scegliere titolo, fotografie, categoria, date, luogo e descrizione." },
  "home.partecipa": { t: "Partecipa a un evento", g: "home", s: "Scopri le attività disponibili e unisciti a quelle che preferisci." },
  "home.umore": { t: "Come ti senti oggi", g: "home", s: "Scegli il tuo stato d'animo e ricevi suggerimenti di attività già pronti." },
  "home.categorie": { t: "Categorie", g: "home", s: "Esplora eventi per argomento, dalle attività sportive alla musica, dai viaggi alla cultura." },
  "home.mappa": { t: "Mappa", g: "home", s: "Visualizza gli eventi in base alla loro posizione." },
  "home.idee": { t: "Vuoi qualche idea?", g: "home", s: "Consulta tante proposte per trovare ispirazione." },
  "home.filtri": { t: "Filtri", g: "home", s: "Puoi filtrare gli eventi per distanza, categoria e preferenze oppure esplorarli tutti." },

  crea: { t: "➕ Crea un evento", g: "crea", s: "Premi il pulsante + al centro per organizzare la tua attività. Scegli titolo, fotografie, categoria, date, luogo e descrizione. Puoi anche stabilire il numero di partecipanti, i requisiti di accesso, le modalità di approvazione e la scadenza delle iscrizioni." },
  "crea.titolo": { t: "Titolo", g: "crea", s: "Scegli il titolo del tuo evento: è la prima cosa che gli altri leggono." },
  "crea.foto": { t: "Fotografie", g: "crea", s: "Scegli le fotografie del tuo evento. Puoi anche stabilire titolo, categoria, date, luogo e descrizione." },
  "crea.categoria": { t: "Categoria", g: "crea", s: "Scegli la categoria giusta: aiuta gli altri a trovare il tuo evento tra le attività sportive, la musica, i viaggi e la cultura." },
  "crea.date": { t: "Date", g: "crea", s: "Scegli le date dell'evento. Puoi anche stabilire titolo, fotografie, categoria, luogo e descrizione." },
  "crea.luogo": { t: "Luogo", g: "crea", s: "Scegli il luogo dell'evento. Con Portami lì chi partecipa può aprire direttamente il navigatore e raggiungerlo." },
  "crea.descrizione": { t: "Descrizione", g: "crea", s: "Scrivi una breve descrizione: cosa farete, cosa portare e quello che serve per stare bene insieme." },
  "crea.partecipanti": { t: "Numero di partecipanti", g: "crea", s: "Puoi stabilire il numero di partecipanti. Una volta pubblicato, gli altri utenti potranno scoprirlo e partecipare secondo le condizioni che hai stabilito." },
  "crea.accesso": { t: "Requisiti di accesso", g: "crea", s: "Puoi stabilire i requisiti di accesso all'evento. Gli altri potranno partecipare secondo le condizioni che hai scelto." },
  "crea.approvazione": { t: "Modalità di approvazione", g: "crea", s: "Puoi decidere le modalità di approvazione delle richieste di partecipazione." },
  "crea.scadenza": { t: "Scadenza delle iscrizioni", g: "crea", s: "Puoi stabilire la scadenza delle iscrizioni: dopo quel momento non si entra più, secondo le condizioni che hai scelto." },
  "crea.pubblica": { t: "Pubblica l'evento", g: "crea", s: "Una volta pubblicato, gli altri utenti potranno scoprirlo e partecipare secondo le condizioni che hai stabilito." },

  partecipa: { t: "📅 Partecipa a un evento", g: "partecipa", s: "Apri un evento per conoscere tutti i dettagli e richiedere la partecipazione, quando necessario. Una volta ammesso, potrai accedere alla chat di gruppo, conoscere gli altri partecipanti e organizzarti prima dell'incontro." },
  "partecipa.chat": { t: "Chat di gruppo", g: "partecipa", s: "Una volta ammesso, potrai accedere alla chat di gruppo, conoscere gli altri partecipanti e organizzarti prima dell'incontro." },
  "partecipa.naviga": { t: "Portami lì", g: "partecipa", s: "Con Portami lì puoi aprire direttamente il navigatore e raggiungere il luogo dell'evento." },
  "partecipa.richiesta": { t: "Richiesta di partecipazione", g: "partecipa", s: "Apri un evento per conoscere tutti i dettagli e richiedere la partecipazione, quando necessario." },

  community: { t: "👥 Community", g: "community", s: "Condividi fotografie dei tuoi eventi, scopri quelle pubblicate dagli altri utenti, commenta e rivivi insieme i momenti più belli." },
  "community.pubblica": { t: "Pubblica", g: "community", s: "Condividi fotografie dei tuoi eventi e racconta quello che avete fatto. Quello che pubblichi lo vedono gli altri utenti." },
  "community.commenta": { t: "Commenta", g: "community", s: "Commenta le fotografie e scopri quelle pubblicate dagli altri utenti. Così rivivete insieme i momenti più belli." },
  "community.cuore": { t: "Cuore", g: "community", s: "Metti il cuore alle fotografie che ti piacciono e scopri quelle pubblicate dagli altri utenti." },

  ricordi: { t: "🕒 Ricordi", g: "ricordi", s: "Qui trovi gli eventi conclusi, puoi vedere chi ha partecipato e lasciare una valutazione. I tuoi giudizi aiutano gli altri a scegliere le esperienze e gli organizzatori." },
  "ricordi.voto": { t: "Valutazione", g: "ricordi", s: "Lascia una valutazione sugli eventi conclusi: i tuoi giudizi aiutano gli altri a scegliere le esperienze e gli organizzatori." },
  "ricordi.filtri": { t: "Filtri dei Ricordi", g: "ricordi", s: "Sono disponibili filtri per trovare facilmente ciò che cerchi tra gli eventi conclusi." },
  "ricordi.chi": { t: "Chi ha partecipato", g: "ricordi", s: "Qui trovi gli eventi conclusi e puoi vedere chi ha partecipato." },

  preferiti: { t: "♡ Preferiti", g: "preferiti", s: "Ritrova tutti gli eventi che hai salvato per consultarli o partecipare in un secondo momento." },

  profilo: { t: "👤 Profilo", g: "profilo", s: "Completa il tuo profilo con una fotografia personale, età, genere e una breve descrizione di te, delle tue passioni e dei tuoi interessi. La verifica tramite selfie conferma che la fotografia del profilo ti rappresenta." },
  "profilo.foto": { t: "Fotografia personale", g: "profilo", s: "Completa il tuo profilo con una fotografia personale. La verifica tramite selfie conferma che la fotografia del profilo ti rappresenta." },
  "profilo.eta": { t: "Età", g: "profilo", s: "Completa il tuo profilo con la tua età, insieme a fotografia, genere e una breve descrizione di te." },
  "profilo.genere": { t: "Genere", g: "profilo", s: "Completa il tuo profilo con il tuo genere, insieme a fotografia, età e una breve descrizione di te." },
  "profilo.descrizione": { t: "Descrizione di te", g: "profilo", s: "Scrivi una breve descrizione di te, delle tue passioni e dei tuoi interessi." },
  "profilo.selfie": { t: "Verifica tramite selfie", g: "profilo", s: "La verifica tramite selfie conferma che la fotografia del profilo ti rappresenta. È richiesta per partecipare e organizzare eventi e contribuisce a rendere gli incontri più trasparenti." },
  "profilo.interessi": { t: "I tuoi interessi", g: "profilo", s: "Dalle impostazioni puoi aggiornare i tuoi interessi e gestire le preferenze dell'app." },
  "profilo.impostazioni": { t: "Impostazioni", g: "profilo", s: "Dalle impostazioni puoi aggiornare i tuoi interessi e gestire le preferenze dell'app." },
  "profilo.registrazione": { t: "Il tuo profilo", g: "profilo", s: "Per partecipare e organizzare eventi serve un profilo completo: fotografia personale, età, genere, una breve descrizione di te e la verifica tramite selfie." },

  ai: { t: "✨ Assistente AI", g: "ai", s: "Hai bisogno di un'idea? Chiedi all'assistente! Puoi ricevere suggerimenti su eventi, attività, luoghi, sport, esperienze, organizzazione e preparazione delle tue iniziative. Puoi chiedere consigli, esplorare nuove possibilità e trovare ispirazione." },
  "ai.voce": { t: "Voce e microfono", g: "ai", s: "Puoi chiedere consigli all'assistente anche con la voce. Il microfono serve per utilizzare le funzioni vocali dell'assistente." },
  "ai.idee": { t: "Suggerimenti", g: "ai", s: "Puoi ricevere suggerimenti su eventi, attività, luoghi, sport, esperienze, organizzazione e preparazione delle tue iniziative." },

  privacy: { t: "🔒 Privacy e autorizzazioni", g: "privacy", s: "Puoi consultare le condizioni di utilizzo, l'informativa sulla privacy e gestire le autorizzazioni dalle impostazioni. Ogni autorizzazione viene richiesta quando serve alla relativa funzionalità." },
  "privacy.posizione": { t: "Posizione", g: "privacy", s: "La posizione serve per trovare eventi vicino a te." },
  "privacy.fotocamera": { t: "Fotocamera", g: "privacy", s: "La fotocamera serve per scattare foto e verificare il profilo." },
  "privacy.galleria": { t: "Galleria", g: "privacy", s: "La galleria serve per caricare le tue fotografie." },
  "privacy.microfono": { t: "Microfono", g: "privacy", s: "Il microfono serve per utilizzare le funzioni vocali dell'assistente." },
  "privacy.notifiche": { t: "Notifiche", g: "privacy", s: "Le notifiche servono per ricevere aggiornamenti su eventi, messaggi e partecipazioni." },
  "privacy.autorizzazioni": { t: "Autorizzazioni", g: "privacy", s: "Ogni autorizzazione viene richiesta quando serve alla relativa funzionalità. Puoi gestirla anche dalle impostazioni del telefono." },
  "privacy.condizioni": { t: "Condizioni di utilizzo", g: "privacy", s: "Puoi consultare le condizioni di utilizzo dalle impostazioni." },
  "privacy.informativa": { t: "Informativa sulla privacy", g: "privacy", s: "Puoi consultare l'informativa sulla privacy dalle impostazioni. I tuoi dati vengono trattati secondo l'informativa e i consensi prestati." },
  "privacy.dati": { t: "I tuoi dati", g: "privacy", s: "I tuoi dati vengono trattati secondo l'informativa sulla privacy e i consensi prestati." },
};

const HELP_ALIAS = {
  "Posti": "crea.partecipanti",
  "Età minima e massima": "crea.accesso",
  "Come si entra": "crea.accesso",
  "Richieste da approvare": "crea.approvazione",
  "Scadenza iscrizioni": "crea.scadenza",
  "Ripetizione": "crea.date",
  "Posizione": "privacy.posizione",
  "Fotocamera": "privacy.fotocamera",
  "Galleria": "privacy.galleria",
  "Microfono": "privacy.microfono",
  "Notifiche": "privacy.notifiche",
};

/* ---------- un "?" in ogni zona e accanto a ogni funzione ---------- */
const AIUTO_ZONA = {
  profile: "profilo",
  register: "profilo.registrazione",
  login: "profilo.registrazione",
  chat: "partecipa.chat",
  passati: "ricordi",
  pastDetail: "ricordi",
  pastEdit: "ricordi",
  fav: "preferiti",
  assistant: "ai",
  person: "profilo",
  verify: "profilo.selfie",
  perms: "privacy.autorizzazioni",
  permFix: "privacy.autorizzazioni",
  privacy: "privacy",
  quick: "profilo.interessi",
  onboarding: "profilo.interessi",
};

function agganciaAiuti() {
  for (const id in AIUTO_ZONA) {
    const el = document.getElementById(id);
    if (!el) continue;
    const host = el.classList.contains("sheet") ? el.querySelector(".sheet-in") : el;
    if (!host || host.querySelector(":scope > .q-aiuto")) continue;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "q-aiuto";
    b.dataset.why = AIUTO_ZONA[id];
    b.setAttribute("aria-label", "Come funziona questa parte");
    b.textContent = "?";
    host.appendChild(b);
  }
}

function apriGuida(zona) {
  hide("gloss");
  show("help");
  const el = document.getElementById("guida-" + (zona || "home"));
  if (el) setTimeout(() => el.scrollIntoView({ block: "start", behavior: "smooth" }), 80);
}

document.addEventListener(
  "click",
  (e) => {
    const q = e.target && e.target.closest ? e.target.closest("[data-guida]") : null;
    if (!q) return;
    e.preventDefault();
    e.stopPropagation();
    apriGuida(q.dataset.guida);
  },
  true
);

// un solo ascoltatore per tutti i "?": non serve riagganciarli a ogni disegno
document.addEventListener(
  "click",
  (e) => {
    const w = e.target && e.target.closest ? e.target.closest("[data-why]") : null;
    if (!w) return;
    e.preventDefault();
    e.stopPropagation();
    openGloss(w.dataset.why);
  },
  true
);

/* ---------- tre domande e il profilo è fatto ---------- */
let quickStep = 0;
let quickAns = [[], [], []];
const QUICK = [
  {
    t: "Cosa ti piace fare nel tempo libero?",
    s: "Scegli quello che ti va, quante ne vuoi: serve a capire che eventi farti vedere.",
    chips: [
      { l: "Sport e movimento", v: "sport" },
      { l: "Musica", v: "musica" },
      { l: "Mangiare e bere bene", v: "cibo" },
      { l: "Aria aperta", v: "natura" },
      { l: "Giochi e sfide", v: "giochi" },
      { l: "Mostre e spettacoli", v: "cinema" },
      { l: "Serate fuori", v: "serate" },
      { l: "Creare con le mani", v: "creativita" },
    ],
  },
  {
    t: "Com'è la tua serata ideale?",
    s: "Puoi sceglierne più di una: così ti propongo serate che ti somigliano davvero.",
    chips: [
      { l: "Tranquilla, a chiacchierare", v: "calma" },
      { l: "Movimentata, fino a tardi", v: "divertimento" },
      { l: "Sportiva, per sfogarmi", v: "energia" },
      { l: "Scoprire posti e storie nuove", v: "scoperta" },
      { l: "Mangiare bene, con calma", v: "gusto" },
    ],
  },
  {
    t: "C'è qualcosa che proprio non ti va?",
    s: "Lo tengo fuori dai suggerimenti. Se ti va bene tutto, salta pure.",
    chips: [
      { l: "Discoteca", v: "-discoteca" },
      { l: "Palestra", v: "-palestra" },
      { l: "Feste affollate", v: "-festa" },
      { l: "Va bene tutto", v: "tutto" },
    ],
  },
];

function startQuick() {
  quickStep = 0;
  quickAns = [[], [], []];
  const next = $("#quickNext");
  if (next) next.onclick = quickNext;
  const skip = $("#quickSkip");
  if (skip) skip.onclick = () => { quickDone(); };
  show("quick");
  renderQuick();
}

function renderQuick() {
  const q = QUICK[quickStep];
  $("#quickTitle").textContent = q.t;
  $("#quickSub").textContent = q.s;
  $("#quickBar").style.width = ((quickStep + 1) / QUICK.length) * 100 + "%";
  $("#quickNext").textContent = quickStep === QUICK.length - 1 ? "Fatto" : t("common.next");
  $("#quickSkip").hidden = quickStep === QUICK.length - 1;
  const body = $("#quickBody");
  body.innerHTML = q.chips
    .map(
      (c, i) =>
        `<button class="qchip ${quickAns[quickStep].includes(c.v) ? "on" : ""}" type="button" data-q="${i}">${esc(c.l)}</button>`
    )
    .join("");
  body.querySelectorAll("[data-q]").forEach((b) => {
    b.onclick = () => {
      const v = q.chips[Number(b.dataset.q)].v;
      const cur = quickAns[quickStep];
      if (v === "tutto") {
        // sceglie lei o lui: si accende e cancella le esclusioni
        quickAns[quickStep] = cur.includes("tutto") ? [] : ["tutto"];
      } else {
        const base = cur.filter((x) => x !== "tutto");
        quickAns[quickStep] = base.includes(v) ? base.filter((x) => x !== v) : [...base, v];
      }
      renderQuick();
    };
  });
}

// sceglie le attività giuste per te, in un lampo
function quickPick() {
  const all = (taxonomy && taxonomy.activities) || [];
  const cats = new Set(quickAns[0] || []);
  const moods = new Set((quickAns[1] || []).filter((v) => v && !v.startsWith("-")));
  const no = (quickAns[2] || []).filter((v) => v && v.startsWith("-")).map((v) => v.slice(1).toLowerCase());
  const scored = all
    .map((a) => {
      let score = 0;
      if (cats.has(a.cat)) score += 4;
      if (cats.has("cibo") && /cucin|cena|food|pizza|brunch|vino|birra|aperitivo|pasticcer|street food|sagra|pane/i.test(a.it)) score += 5;
      if (cats.has("natura") && (a.out || /trekking|mare|montagna|bosco|picnic|giardinaggio|orto|birdwatching|stelle|grotte|fiume/i.test(a.it))) score += 4;
      if ((a.m || []).some((m) => moods.has(m))) score += 3;
      if (seasonScore(a) === 2) score += 2;
      score += (a.pop || 0) * 0.4;
      if (no.some((w) => a.it.toLowerCase().includes(w))) score -= 20;
      return { a, score };
    })
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score);
  // massimo due per "famiglia": così non ti riempio il profilo di cene
  const fam = (a) =>
    /cena|cucin|food|pizza|vino|birra|brunch|aperitivo|sagra|pasticcer|pane|mercat|gelato|caff/i.test(a.it) ? "cibo" : a.cat;
  const picks = [];
  const perFam = {};
  for (const { a } of scored) {
    const f = fam(a);
    const n = perFam[f] || 0;
    if (n >= 2) continue;
    perFam[f] = n + 1;
    picks.push(a.it);
    if (picks.length >= 8) break;
  }
  return picks;
}

function quickNext() {
  if (quickStep < QUICK.length - 1) {
    quickStep += 1;
    renderQuick();
    return;
  }
  const picks = quickPick();
  onb = onb && typeof onb === "object" ? onb : { goals: [], meet: [], outings: [], interests: [], categories: [] };
  onb.interests = picks.length ? picks : onb.interests || [];
  save(K.onb, onb);
  $("#quickTitle").textContent = picks.length ? "Ecco cosa ti metto da parte" : "Non ho capito bene";
  $("#quickSub").textContent = picks.length
    ? "Parto da queste. Se qualcosa non ti va, toccala per toglierla."
    : "Rifacciamo le domande, oppure scegli a mano quello che ti interessa.";
  $("#quickBar").style.width = "100%";
  $("#quickSkip").hidden = true;
  $("#quickNext").textContent = "Va bene";
  const body = $("#quickBody");
  body.innerHTML = `<div class="qpicks">${(onb.interests || [])
    .map((n) => `<button class="qchip on" type="button" data-drop="${esc(n)}">${esc(n)}</button>`)
    .join("")}</div><button class="tiny left" type="button" id="quickManual">${esc("Preferisco scegliere a mano")}</button>`;
  body.querySelectorAll("[data-drop]").forEach((b) => {
    b.onclick = () => {
      onb.interests = (onb.interests || []).filter((x) => x !== b.dataset.drop);
      save(K.onb, onb);
      b.remove();
    };
  });
  const manual = $("#quickManual");
  if (manual) manual.onclick = quickManual;
  $("#quickNext").onclick = quickDone;
}

function quickDone() {
  localStorage.setItem("fuori.onbDone", "1");
  onb.categories = taxonomy
    ? taxonomy.categories
        .filter((c) => (onb.interests || []).some((i) => taxonomy.activities.find((a) => a.it === i && a.cat === c.id)))
        .map((c) => c.id)
    : onb.categories;
  save(K.onb, onb);
  hide("quick");
  $("#quickNext").onclick = quickNext;
  if (person) openInterests();
  else openRegister();
}

async function quickManual() {
  hide("quick");
  $("#quickNext").onclick = quickNext;
  await loadTaxonomy();
  startOnboarding(3);
}

/* ---------- onboarding ---------- */
let onboardingOpen = false;
let onbStep = 0;
let onbEdit = false;
// le domande del quarto passo: prima le categorie, poi le cose precise dentro
let onbCatStep = false;
let onbCats = new Set();
const ONB = [
  { title: "onb.title1", sub: "onb.sub1", field: "goals", keys: ["onb.g1", "onb.g2", "onb.g3", "onb.g4", "onb.g5", "onb.g6"] },
  { title: "onb.title2", sub: "onb.sub2", field: "meet", keys: ["onb.m1", "onb.m2", "onb.m3", "onb.m4", "onb.m5", "onb.m6", "onb.m7", "onb.m8"] },
  { title: "onb.title3", sub: "onb.sub3", field: "outings", keys: ["onb.o1", "onb.o2", "onb.o3", "onb.o4", "onb.o5", "onb.o6", "onb.o7", "onb.o8"] },
  { title: "onb.title4", sub: "onb.sub4", field: "interests" },
];

function startOnboarding(step) {
  onboardingOpen = true;
  onbCatStep = false;
  onbCats = new Set();
  onb = onb && typeof onb === "object" ? onb : { goals: [], meet: [], outings: [], interests: [], categories: [] };
  onbStep = Number.isInteger(step) ? step : 0;
  show("onboarding");
  renderOnboarding();
}

let onbTerm = "";
let onbOpen = new Set();
function renderOnboarding() {
  if (!onboardingOpen) return;
  const step = ONB[onbStep];
  const edit = onbEdit;
  const sceltaCategorie = onbStep === 3 && !onbCatStep;
  if (sceltaCategorie) {
    $("#onbTitle").textContent = t("onb.catTitle");
    $("#onbSub").textContent = t("onb.catSub");
  } else if (onbStep === 3) {
    $("#onbTitle").textContent = edit ? t("prof.interests") : t("onb.specificTitle");
    $("#onbSub").textContent = edit ? t("onb.allHint") : t("onb.specificSub");
  } else {
    $("#onbTitle").textContent = edit ? t("prof.interests") : t(step.title);
    $("#onbSub").textContent = edit ? t("onb.allHint") : t(step.sub);
  }
  $("#onbBar").style.width = edit ? "100%" : ((onbStep + 1) / 4) * 100 + "%";
  $("#onbBack").hidden = edit;
  $("#onbBack").disabled = onbStep === 0;
  $("#onbSkip").hidden = edit;
  $("#onbNext").textContent = sceltaCategorie
    ? t("onb.catNext")
    : edit
      ? t("onb.saveInterests")
      : onbStep === 3
        ? t("onb.done")
        : t("common.next");
  $("#onbErr").hidden = true;

  if (sceltaCategorie) {
    renderOnbCats();
    return;
  }

  if (onbStep < 3) {
    $("#onbBody").innerHTML = step.keys
      .map((k) => `<button class="chip ${(onb[step.field] || []).includes(k) ? "on" : ""}" data-chip="${k}">${esc(t(k))}</button>`)
      .join("");
  } else {
    $("#onbBody").innerHTML = `<input id="onbSearch" class="onb-search" placeholder="${esc(t("onb.search"))}" value="${esc(onbTerm)}">
      <p class="tiny" id="onbCount">${esc(t("onb.counter", { n: (onb.interests || []).length }))}</p><div id="onbGroups"></div>`;
    renderTaxonomy();
    $("#onbSearch").oninput = (e) => { onbTerm = e.target.value; renderTaxonomy(); };
  }
}

// le categorie a cui appartengono le cose già scelte
function catsDaInteressi() {
  const s = new Set();
  if (!taxonomy) return s;
  for (const i of onb.interests || []) {
    const a = taxonomy.activities.find((x) => x.it === i);
    if (a) s.add(a.cat);
  }
  return s;
}

// la griglia delle categorie: tutte e quattordici, nessuna nascosta
async function renderOnbCats() {
  const box = $("#onbBody");
  if (!box) return;
  if (!taxonomy) {
    box.innerHTML = `<p class="muted">${esc(t("home.loading"))}</p>`;
    try { await loadTaxonomy(); } catch { return; }
  }
  if (!taxonomy) return;
  // se ha già delle scelte, parto dalle categorie che ha già toccato
  if (!onbCats.size) onbCats = catsDaInteressi();
  const conta = (id) => taxonomy.activities.filter((a) => a.cat === id).length;
  box.innerHTML =
    `<div class="onb-cats">` +
    taxonomy.categories
      .map((c) => {
        const on = onbCats.has(c.id);
        return `<button type="button" class="cat-chip${on ? " on" : ""}" data-cat="${c.id}">
          <span class="cat-emoji">${catIcon(c.id)}</span>
          <span class="cat-nome">${esc(catName(c.id))}</span>
          <span class="cat-n">${conta(c.id)}</span>
        </button>`;
      })
      .join("") +
    `</div><p class="tiny" id="onbCatCount">${esc(t("onb.catCount", { n: onbCats.size }))}</p>`;
}

function renderTaxonomy() {
  if (!taxonomy || onbStep !== 3) return;
  const box = $("#onbGroups");
  if (!box) return;
  if (!onbCats.size) onbCats = catsDaInteressi();
  const term = onbTerm.trim().toLowerCase();
  const chosen = onb.interests || [];
  const openGroups = onbOpen;
  const parts = [];
  for (const c of taxonomy.categories) {
    if (!onbCats.has(c.id)) continue;
    let list = taxonomy.activities.filter((a) => a.cat === c.id && (!term || (a.it + " " + (a.en || "") + " " + (a.es || "") + " " + (a.pt || "")).toLowerCase().includes(term)));
    if (!list.length) continue;
    list = rankActivities(list);
    const expanded = !term && openGroups.has(c.id);
    // le prime 24: dentro c'è di tutto, non solo le solite tre cose
    const head = list.filter((a) => seasonScore(a) === 2);
    const tail = list.filter((a) => seasonScore(a) !== 2);
    const short = [...head.slice(0, 12), ...tail.slice(0, 12)];
    const shownList = term || expanded || list.length <= 24 ? list : short.slice(0, 24);
    const rest = list.length - shownList.length;
    const seen = new Set();
    const sceltiQui = list.filter((a) => chosen.includes(a.it)).length;
    parts.push(`<div class="group"><h3>${esc(catName(c.id))} · ${list.length}${sceltiQui ? ` · ${sceltiQui} ✓` : ""}</h3>${shownList.map((a) => {
      let name = actName(a);
      if (seen.has(name)) name = a.it;
      seen.add(name);
      return `<span class="act"><button class="chip ${chosen.includes(a.it) ? "on" : ""}" data-act="${esc(a.it)}">${esc(name)}</button>${whyHtml(a.it)}</span>`;
    }).join("")}${rest > 0 ? `<button class="chip more" data-more="${c.id}">${esc(t("onb.more", { n: rest }))}</button>` : ""}${!term && expanded && list.length > 9 ? `<button class="chip more" data-more="${c.id}">${esc(t("onb.less"))}</button>` : ""}</div>`);
  }
  box.innerHTML =
    `<button class="chip more" type="button" data-cats="1">${esc(t("onb.changeCats"))}</button>` +
    (term ? "" : `<p class="season-note">${esc(t("onb.seasonNote"))}</p>`) +
    (parts.join("") || `<p class="muted">${esc(t("ai.none"))}</p>`);
  const count = $("#onbCount");
  if (count) count.textContent = t("onb.counter", { n: chosen.length });
}

function toggleOnb(value, field) {
  const arr = onb[field] || [];
  onb[field] = arr.includes(value) ? arr.filter((x) => x !== value) : arr.concat(value);
  if (onbStep < 3) { renderOnboarding(); return; }
  const chip = document.querySelector(`[data-act="${CSS.escape(value)}"]`);
  if (!chip) { renderTaxonomy(); return; }
  chip.classList.toggle("on", (onb.interests || []).includes(value));
  const count = $("#onbCount");
  if (count) count.textContent = t("onb.counter", { n: (onb.interests || []).length });
}

function openInterests() {
  if (!person) { openRegister(); return; }
  onbEdit = true;
  onboardingOpen = true;
  onb = { ...onb, interests: [...(person.interests || [])] };
  onbStep = 3;
  onbCatStep = true;
  onbCats = catsDaInteressi();
  onbTerm = "";
  show("onboarding");
  renderOnboarding();
}

async function saveInterests() {
  // anche qui niente minimo: si salva con quante cose si vogliono
  const btn = $("#onbNext");
  btn.disabled = true;
  try {
    await api("/profile", {
      method: "POST",
      body: JSON.stringify({
        email: person.email,
        bio: person.bio || "",
        lookingFor: person.lookingFor || "",
        done: person.done || "",
        age: person.age || null,
        sex: person.sex || "n",
        interests: onb.interests,
        device,
      }),
    });
    person.interests = [...onb.interests];
    save(K.person, person);
    onbEdit = false;
    onboardingOpen = false;
    hide("onboarding");
    toast(t("prof.interestsSaved"));
  } catch (err) {
    $("#onbErr").textContent = err.data?.error || t("toast.error");
    $("#onbErr").hidden = false;
  } finally {
    btn.disabled = false;
  }
}

function finishOnboarding() {
  onbEdit = false;
  onboardingOpen = false;
  localStorage.setItem("fuori.onbDone", "1");
  onb.categories = taxonomy ? taxonomy.categories.filter((c) => (onb.interests || []).some((i) => taxonomy.activities.find((a) => a.it === i && a.cat === c.id))).map((c) => c.id) : onb.categories;
  save(K.onb, onb);
  hide("onboarding");
  openRegister();
}

/* ---------- assistente ---------- */
let aiOpen = false;
let aiStarted = false;
let aiMode = "scrivi";
let aiRitorno = false;

function renderAiMode() {
  document.querySelectorAll("#aiModes button").forEach((b) => b.classList.toggle("on", b.dataset.m === aiMode));
  const f = $("#aiForm"), rec = $("#aiRec"), conv = $("#aiConv");
  if (f) f.hidden = aiMode !== "scrivi";
  if (rec) rec.hidden = aiMode !== "registra";
  if (conv) conv.hidden = aiMode !== "conversa";
  if (aiMode !== "conversa" && dialogOn) stopDialog();
  if (aiMode !== "registra" && recording) stopVoice();
  const rs = $("#aiRecState");
  if (rs) rs.textContent = recording ? t("ai.recording") : "Tocca il microfono e parla. Tocca ancora per fermarti.";
  const cs = $("#aiConvState");
  if (cs) cs.textContent = dialogOn ? (dialogAscolto ? t("ai.convListening") : t("ai.convTurn")) : t("ai.convStart");
  const cb = $("#aiConvBtn");
  if (cb) {
    cb.classList.toggle("conv", dialogOn);
    cb.classList.toggle("on", dialogAscolto);
  }
  const rb = $("#aiRecBtn");
  if (rb) rb.classList.toggle("on", recording);
}

function setAiMode(m) {
  // due modi soltanto: scrivi, oppure parli e ti rispondo a voce
  const nuovo = m === "conversa" || m === "registra" ? "conversa" : "scrivi";
  if (nuovo !== aiMode) {
    // cambio di modalità: zittisco subito quello che stava dicendo o ascoltando
    try { stopVoce(); } catch {}
    try { if (dialogOn) stopDialog(); } catch {}
  }
  aiMode = nuovo;
  renderAiMode();
}

function openAi() {
  aiOpen = true;
  show("assistant");
  if (!aiStarted) {
    aiStarted = true;
    aiBubble(t("ai.greeting"), "bot");
  }
  renderSuggest();
  renderVoice();
  renderAiMode();
}

function aiBubble(text, who, events_) {
  const box = $("#aiList");
  const mine = who === "me";
  const el = document.createElement("div");
  el.className = "msg " + (mine ? "mine" : "");
  el.textContent = text;
  box.appendChild(el);
  if (events_ && events_.length) {
    const wrap = document.createElement("div");
    wrap.className = "msg";
    wrap.style.maxWidth = "100%";
    wrap.innerHTML = events_.slice(0, 5).map((ev) => `<button class="person" data-open="${ev.id}" style="border:0">
      <span class="av">${esc((ev.title || "?")[0])}</span>
      <span><span class="pn">${esc(ev.title)}</span><span class="ps">${esc(fmtWhen(ev.startsAt))} · ${esc(luogoDi(ev))}</span></span></button>`).join("");
    box.appendChild(wrap);
    wrap.querySelectorAll("[data-open]").forEach((b) => {
      b.onclick = () => {
        aiRitorno = true;
        hide("assistant");
        openDetail(b.dataset.open);
      };
    });
  }
  box.scrollTop = box.scrollHeight;
  return el;
}

// L'assistente risponde il modello: qui resta solo quello che non deve mai uscire dal telefono.
// Prima c'erano risposte pronte "a parole chiave" e beccavano quasi tutto: a "che ore sono?"
// rispondevano "resto qui, raccontami com'è andata", a "consigliami un film" mostravano un evento
// a caso. Era quella la sensazione di risposte senza senso: adesso quelle risposte non ci sono più
// e ogni domanda vera la prende il modello, che sa di cosa si sta parlando.
// per i saluti secchi rispondo subito, come farebbe una persona: niente attesa
// e niente tono da sportello. Tutto il resto lo prende il modello.
let ultimoSaluto = "";
function rispostaSaluto(raw) {
  const s = String(raw || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "'")
    .replace(/[.!?,;]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s || s.length > 50) return "";
  const giusto = /^(?:(?:ciao|ehi|hey|hola|ola)\s+)?(?:come\s+(?:va|stai|state|ti\s+senti|te\s+la\s+passi)(?:\s+(?:oggi|stasera|la\s+vita|la\s+giornata|tutto))?|tutto\s+(?:bene|ok|a\s+posto)|che\s+si\s+dice|come\s+butta|novita|how\s+are\s+you(?:\s+doing)?|how\s+is\s+it\s+going|how'?s\s+it\s+going|como\s+estas|como\s+vai|tudo\s+bem|como\s+voce\s+esta)$/i;
  if (!giusto.test(s)) return "";
  const risposte = {
    it: ["Alla grande, grazie! E tu come stai?", "Alla grande! E tu?", "Tutto bene, dai! E tu come stai?"],
    en: ["Great, thanks! How about you?", "All good here! How are you?", "Pretty great, thanks! How about you?"],
    es: ["Muy bien, ¡gracias! ¿Y tú cómo estás?", "Todo bien, ¡gracias! ¿Y tú?", "Genial, ¡gracias! ¿Cómo estás?"],
    pt: ["Tudo ótimo por aqui! E você como está?", "Tudo bem, sim! E você?", "Muito bem! Como você está?"],
  };
  const scelte = risposte[lang] || risposte.it;
  let scelta = scelte[Math.floor(Math.random() * scelte.length)];
  // due volte di fila la stessa frase sembra un disco rotto
  if (scelte.length > 1 && scelta === ultimoSaluto) scelta = scelte[(scelte.indexOf(scelta) + 1) % scelte.length];
  ultimoSaluto = scelta;
  return scelta;
}

function aiAnswer(raw) {
  const saluto = rispostaSaluto(raw);
  if (saluto) return { text: saluto };
  const text = String(raw || "").toLowerCase();
  if (
    /quanti\s+(iscritti|utenti|persone|siamo)|chi\s+(sono|è)\s+(gli\s+|le\s+)?(iscritti|utenti|persone)|elenco\s+(degli|delle)?\s*(iscritti|utenti|persone)|lista\s+(degli|delle)?\s*(iscritti|utenti|persone)|statistiche|database|how many (people|users|members)|cu[aá]nt[oa]s (personas|usuarios)|quantas (pessoas|usu[aá]rios)/.test(text)
  ) return { text: t("ai.private"), private: true };
  return {};
}

// La posizione non si eredita dalla volta prima: all'avvio si chiede sempre al telefono.
// Così non resta "Trecastagni" solo perché era l'ultimo posto salvato.
let myPos = null;
let myPosAcc = 0;
let myPosAt = 0;
let myFixAt = 0; // quando il telefono ha davvero rilevato il punto (non quando l'ho ricevuto)
let geoWatch = null;
let geoRetry = null;
let geoRetryN = 0;
let lastGeoPaint = 0;
let geoWarned = false;
let radiusKm = Number(localStorage.getItem("fuori.radius") || 0) || 0;
let cityTerm = "";
let cityCenter = null;

function filterCenter() {
  return radiusKm > 0 ? myPos : null;
}

function radiusText() {
  if (!radiusKm) return "";
  return `${t("radius.upto", { n: radiusKm })} ${t("radius.fromYou")}`;
}

// A zero km non c'è nessun filtro: la scritta deve dire dove sto cercando
// davvero, non "Sicilia" per abitudine. Se il GPS dice Milano, niente isola.
const BOX_SICILIA = { s: 36.5, n: 38.4, w: 12.3, e: 15.8 };
const BOX_ITALIA = { s: 35.4, n: 47.2, w: 6.5, e: 18.7 };

function dentroBox(p, b) {
  return !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && p.lat >= b.s && p.lat <= b.n && p.lng >= b.w && p.lng <= b.e;
}

function radiusAllLabel() {
  const p = myPos || lastPos();
  if (dentroBox(p, BOX_SICILIA)) return t("radius.all");
  if (dentroBox(p, BOX_ITALIA)) return t("radius.allIt");
  return t("radius.any");
}

function updateRadiusLabel() {
  const n = $("#radiusNote");
  if (n) n.textContent = radiusText();
  const v = $("#radiusVal");
  if (v) v.textContent = radiusKm > 0 ? radiusKm + " km" : radiusAllLabel();
  const r = $("#radiusRange");
  if (r) {
    const max = Number(r.max) || 300;
    r.style.setProperty("--fill", Math.round((Number(r.value) / max) * 100) + "%");
  }
}

async function findCityCenter() {
  const q = cityTerm.trim();
  if (q.length < 3) return null;
  try {
    const r = await api("/geo?q=" + encodeURIComponent(q));
    const p = (r.results || [])[0];
    if (p && Number.isFinite(p.lat) && Number.isFinite(p.lng)) cityCenter = { lat: p.lat, lng: p.lng };
  } catch {}
  return cityCenter;
}

function locate() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    const ask = (high, timeout) =>
      new Promise((done) => {
        navigator.geolocation.getCurrentPosition(
          (pos) => done({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            // timestamp = momento del rilevamento: serve a non far vincere un punto vecchio
            at: Number(pos.timestamp) || Date.now(),
            accuracy: Number(pos.coords.accuracy) || 0,
          }),
          () => done(null),
          // maximumAge: 0 = non usare una posizione vecchia, nemmeno di pochi minuti
          { enableHighAccuracy: high, timeout, maximumAge: 0 }
        );
      });
    // prima il GPS preciso, e se e' impreciso ne chiedo un altro: mai accontentarsi
    // di una lettura veloce che puo' sbagliare di chilometri (es. Brera per Lambrate)
    ask(true, 10000).then(async (p) => {
      if (p && Number(p.accuracy) <= 250) return p;
      const p2 = await ask(true, 10000);
      const best = [p, p2].filter(Boolean).sort((a, b) => (a.accuracy || 1e9) - (b.accuracy || 1e9))[0];
      if (best && Number(best.accuracy) <= 500) return best;
      return best || ask(false, 8000);
    }).then(resolve);
  });
}

// Una posizione nuova entra in un punto solo: qui. Così hero, meteo, idee e lista
// vedono tutti lo stesso dato appena arriva.
function useMyPosition(p, { force = false } = {}) {
  if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return false;
  const now = Date.now();
  const rawAt = Number(p.at);
  // Alcuni provider Android mandano un timestamp che non è l'ora epoch:
  // in quel caso non posso capire l'età del punto e uso l'arrivo come ora.
  const fixAt = rawAt > 1e12 ? rawAt : now;
  // Un punto vecchio non deve mai diventare "la mia posizione": se il telefono
  // restituisce ancora il fix di ieri (Trecastagni), lo scarto e aspetto il GPS.
  if (now - fixAt > 120000) return false;
  if (myPos && fixAt + 120000 < myFixAt) return false;
  // precisione estrema: un fix peggiore di 500 m non sostituisce uno buono,
  // altrimenti la mappa ti mette nel quartiere sbagliato
  if (myPos && Number(myPosAcc) > 0 && Number(p.accuracy) > Number(myPosAcc) + 200 && Number(p.accuracy) > 300) return false;
  const moved = myPos ? distKm(myPos, p) : Infinity;
  if (Number(p.accuracy) > 1200 && !geoWarned) {
    geoWarned = true;
    toastErr("Posizione imprecisa: attiva la posizione precisa del telefono.");
  }
  if (Number(p.accuracy) > 0 && Number(p.accuracy) <= 1200) geoWarned = false;
  myPos = { lat: p.lat, lng: p.lng };
  myPosAcc = Number(p.accuracy) || 0;
  myPosAt = now;
  myFixAt = Math.max(myFixAt, fixAt);
  geoRetryN = 0;
  try { localStorage.setItem("fuori.pos", JSON.stringify({ lat: p.lat, lng: p.lng, acc: myPosAcc, at: now })); } catch {}
  // il GPS può mandare micro-spostamenti: ridisegno solo se mi sono mosso davvero
  const changed = force || moved === Infinity || moved === null || moved > 0.03 || now - lastGeoPaint > 60000;
  if (!changed) return true;
  lastGeoPaint = now;
  updateRadiusLabel();
  aggiornaPaese();
  paintHero();
  paintMood();
  paintWeather();
  if (radiusKm > 0) renderList();
  if (force || !wx || now - (wx.at || 0) > 10 * 60 * 1000) loadWeather();
  return true;
}

function startGeoWatch() {
  if (!navigator.geolocation || geoWatch !== null) return;
  try {
    geoWatch = navigator.geolocation.watchPosition(
      (pos) => useMyPosition({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        at: Number(pos.timestamp) || Date.now(),
        accuracy: Number(pos.coords.accuracy) || 0,
      }),
      (err) => {
        // se il GPS si addormenta, non lascio per sempre l'ultima posizione:
        // fermo il watch e riprovo tra poco (tranne quando il permesso è negato)
        if (err && err.code === 1) return;
        stopGeoWatch();
        scheduleGeoRetry();
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
    );
  } catch {}
}

function stopGeoWatch() {
  if (geoWatch === null || !navigator.geolocation) return;
  try { navigator.geolocation.clearWatch(geoWatch); } catch {}
  geoWatch = null;
}

function scheduleGeoRetry() {
  if (geoRetry || geoRetryN >= 3) return;
  geoRetryN++;
  geoRetry = setTimeout(() => {
    geoRetry = null;
    if (!document.hidden) refreshPosition({ force: true });
  }, 5000);
}

async function refreshPosition({ force = false } = {}) {
  // "prompt" non vuol dire no: all'avvio (force) chiedo comunque, così il
  // telefono mostra la sua posizione attuale invece di tenere quella di ieri.
  let allowed = Boolean(myPos) || force;
  try {
    const st = await navigator.permissions.query({ name: "geolocation" });
    if (st.state === "denied") return false;
    allowed = st.state === "granted" || allowed;
  } catch {}
  if (!allowed) return false;
  const p = await locate();
  if (!p) {
    scheduleGeoRetry();
    return false;
  }
  const accepted = useMyPosition(p, { force });
  if (!accepted) {
    scheduleGeoRetry();
    return false;
  }
  startGeoWatch();
  return true;
}

// Quando torni sull'app (o la riapri) la posizione si rilegge subito.
// Mentre è aperta, il GPS continua a controllare e ogni tanto faccio una verifica in più.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { stopGeoWatch(); return; }
  refreshPosition({ force: true });
});
window.addEventListener("pageshow", (e) => {
  if (e.persisted && !document.hidden) refreshPosition({ force: true });
});
window.addEventListener("focus", () => {
  if (!document.hidden) refreshPosition();
});
window.addEventListener("online", () => {
  if (!document.hidden) refreshPosition({ force: true });
});
setInterval(() => {
  if (!document.hidden) refreshPosition();
}, 60000);

// le idee dell'umore cambiano ogni 15 minuti, anche con la pagina ferma
let slotVivo = Math.floor(Date.now() / (15 * 60 * 1000));
setInterval(() => {
  const ora = Math.floor(Date.now() / SLOT_MS);
  if (ora === slotVivo) return;
  slotVivo = ora;
  if (moodPick && !document.hidden) buildIdeas();
}, 30000);

function distKm(a, b) {
  if (!a || !b) return null;
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

let wx = null;

// la stagione "vera" la decide anche il meteo: a novembre con 26° si sta
// ancora all'aperto, a giugno con 15° no.
function seasonNow() {
  const m = new Date().getMonth() + 1;
  const tmax = wx && typeof wx.tmax === "number" ? wx.tmax : null;
  // giugno-agosto: estate, ma solo se il termometro è d'accordo
  if (m >= 6 && m <= 8) return tmax != null && tmax < 20 ? "mezza" : "estate";
  // settembre: ancora estate solo se fa davvero caldo
  if (m === 9) return tmax != null && tmax >= 28 ? "estate" : "mezza";
  // dicembre-febbraio: inverno, con qualche giornata mite
  if (m === 12 || m === 1 || m === 2) return tmax != null && tmax >= 22 ? "mezza" : "neve";
  // marzo, aprile, maggio, ottobre, novembre: mai estate, anche se c'è il sole
  if (tmax != null && tmax <= 8) return "neve";
  return "mezza";
}

function seasonScore(a) {
  const s = a.season || "sempre";
  if (s === "sempre") return 1;
  const now = seasonNow();
  if (s === now) return 2;
  if (now === "mezza") return s === "neve" ? 0 : 1;
  return 0;
}

function weatherScore(a) {
  if (!wx || !wx.mood) return 0;
  const bad = wx.mood === "pioggia" || wx.mood === "temporale" || wx.mood === "freddo";
  if (bad) return a.out ? -1 : 1;
  return a.out ? 1 : 0;
}

async function loadWeather() {
  // niente posizione, niente numero: meglio il silenzio di un grado sbagliato
  if (!myPos) {
    wx = null;
    paintWeather();
    buildIdeas();
    return;
  }
  const q = `?lat=${myPos.lat.toFixed(4)}&lng=${myPos.lng.toFixed(4)}`;
  try {
    const data = await api("/weather" + q);
    wx = data ? { ...data, at: Date.now() } : null;
  } catch { wx = null; }
  paintWeather();
  buildIdeas();
}

async function bootWeather() {
  // Ogni apertura = una posizione nuova. Non uso quella salvata: chiedo al
  // telefono dove sono adesso, anche quando il permesso è ancora da confermare.
  const ok = await refreshPosition({ force: true });
  if (!ok && !myPos) {
    wx = null;
    paintWeather();
  }
}

function setFreshPosition(p) {
  useMyPosition(p, { force: true });
  startGeoWatch();
}

/* ---------- come ti senti: idee vicine, meteo e voglia ---------- */
const MOODS = [
  { id: "calma", emoji: "😌" },
  { id: "energia", emoji: "⚡" },
  { id: "divertimento", emoji: "🎉" },
  { id: "scoperta", emoji: "🧭" },
  { id: "gusto", emoji: "🍝" },
  { id: "compagnia", emoji: "👥" },
  { id: "romanticismo", emoji: "💞" },
];
let moodPick = localStorage.getItem("fuori.mood") || "";
let zones = null;

async function loadZones() {
  if (zones) return zones;
  try {
    const r = await fetch("/zones.json?v=" + VERSION, { cache: "no-cache" });
    zones = await r.json();
  } catch {
    zones = [];
  }
  return zones;
}

function zoneNear(pos) {
  if (!pos || !zones || !zones.length) return null;
  let best = null;
  let bd = Infinity;
  for (const z of zones) {
    const d = distKm(pos, z);
    if (d !== null && d < bd) {
      bd = d;
      best = z;
    }
  }
  // oltre 35 km non è più "qui intorno"
  return best && bd <= 35 ? { ...best, km: Math.round(bd) } : null;
}

// tutte le zone a portata di mezz'ora, dalla più vicina
function zonesAround(pos) {
  if (!pos || !zones || !zones.length) return [];
  return zones
    .map((z) => ({ ...z, km: distKm(pos, z) }))
    .filter((z) => z.km !== null && z.km <= 30)
    .sort((a, b) => a.km - b.km)
    .slice(0, 3);
}

const OWNER_EMAIL = "christianguarrera@gmail.com";

function isOwner() {
  const giusta = Boolean(person && String(person.email || "").toLowerCase() === OWNER_EMAIL);
  if (!giusta) return false;
  try {
    return Boolean(localStorage.getItem("fuori.ownerToken"));
  } catch {
    return false;
  }
}

// la versione e i dati del padrone li vede solo il padrone
function paintOwner() {
  const v = $("#version");
  const dot = $("#verDot");
  const line = $("#ownerLine");
  const own = isOwner();
  if (v) v.hidden = !own;
  if (dot) dot.hidden = !own;
  if (line) line.hidden = !own;
  const st = $("#statsBtn");
  if (st) st.hidden = !own;
  const vb = $("#verifyBtn");
  // chi è già verificato non deve più vedere questo tasto
  if (vb) vb.hidden = !person?.email || Boolean(person?.verified);
}

function placeShort(z) {
  if (!z) return "";
  return String(z.n || "")
    .split(" e ")[0]
    .replace(/ (centro|mare|nord|sud)$/i, "")
    .trim();
}

// la testata della home parla alla persona, non al posto: ciao + cosa può fare oggi
let myTown = "";
let myPlaceShort = "";
let myTownCell = "";

// il nome del paese dove sono davvero (non la zona larga): lo dice il worker
function townNow() {
  // prima la frazione/quartiere esatto con la sigla (es. "Lambrate, MI")
  return myPlaceShort || myTown || placeShort(zoneNear(myPos));
}

async function aggiornaPaese() {
  if (!myPos) return;
  // circa cinquecento metri: appena passi il confine il nome cambia
  const cell = myPos.lat.toFixed(3) + "," + myPos.lng.toFixed(3);
  if (cell === myTownCell) return;
  myTownCell = cell;
  try {
    const r = await api(`/where?lat=${myPos.lat.toFixed(5)}&lng=${myPos.lng.toFixed(5)}`);
    const nome = String((r && r.town) || "").trim();
    const breve = String((r && (r.short || r.town)) || "").trim();
    if ((nome && nome !== myTown) || (breve && breve !== myPlaceShort)) {
      myTown = nome || myTown;
      myPlaceShort = breve || myPlaceShort;
      paintHero();
      paintMood();
    }
  } catch {}
}

function paintHero() {
  const hi = $("#heroHi");
  if (!hi) return;
  const ora = new Date().getHours();
  const saluto = ora >= 5 && ora < 13 ? "hero.morning" : ora >= 13 && ora < 18 ? "hero.afternoon" : ora >= 18 && ora < 23 ? "hero.evening" : "hero.night";
  const nome = String((person && person.firstName) || "").trim();
  hi.textContent = nome ? `${t(saluto)}, ${nome}` : t("hero.hello");
  const zoneEl = $("#heroZone");
  if (zoneEl) {
    const nome = townNow();
    // le zone possono arrivare dopo la posizione: appena ci sono, ridisegno
    // la testata invece di lasciare il posto senza nome
    if (!nome && myPos && !zones) {
      loadZones().then(() => paintHero()).catch(() => {});
    }
    zoneEl.hidden = !nome;
    if (nome) {
      zoneEl.textContent = nome;
      zoneEl.title = t("where.exact", { z: nome });
    }
  }
  const sub = $("#heroSub");
  if (!sub) return;
  const adesso = Date.now();
  const giorno = new Date(adesso).toDateString();
  const futuri = events.filter((e) => e && e.startsAt > adesso);
  const oggi = futuri.filter((e) => new Date(e.startsAt).toDateString() === giorno);
  const settimana = futuri.filter((e) => e.startsAt <= adesso + 7 * 864e5);
  if (oggi.length) {
    sub.textContent = t(oggi.length === 1 ? "hero.today1" : "hero.todayN", { n: oggi.length });
  } else if (settimana.length) {
    sub.textContent = t(settimana.length === 1 ? "hero.week1" : "hero.weekN", { n: settimana.length });
  } else if (futuri.length) {
    sub.textContent = t(futuri.length === 1 ? "hero.later1" : "hero.laterN", { n: Math.min(futuri.length, 99) });
  } else {
    sub.textContent = person ? t("hero.none") : t("hero.noneAnon");
  }
}

function weatherWhy() {
  const m = wx && wx.mood;
  if (m === "pioggia" || m === "temporale") return t("mood.why.pioggia");
  if (m === "freddo") return t("mood.why.freddo");
  if (m === "caldo") return t("mood.why.caldo");
  if (m === "sole") return t("mood.why.sole");
  return t("mood.why.mite");
}

// cose che hanno senso solo d'estate o solo con la neve: fuori stagione non si propongono
const SUMMER_ONLY = /acque libere|\bmare\b|spiaggia|snorkeling|\bsup\b|\bsurf\b|windsurf|kitesurf|sci nautico|wakeboard|\bbarca\b|\bvela\b|beach volley|pallanuoto|\bcanoa\b|\bkayak\b|nuotata|\bnuoto\b|\bisola\b/i;
const SNOW_ONLY = /\bsci\b|snowboard|ciaspole|slittino|pattinaggio su ghiaccio|hockey su ghiaccio/i;

// dove sei conta: il mare ha senso se il mare è a portata, la neve se ci sono i monti
const COAST_ZONE = /mare|riviera|isol|ortigia|mondello|marzamemi|vendicari|spiaggia|lido|costa|eolie|pantelleria|lampedusa|ustica|san vito|zingaro|scala dei turchi|cefalù|taormina|trapani|marsala|sciacca|gela|avola|noto|siracusa|catania|palermo|messina/i;
const SNOW_ZONE = /etna|sapienza|nebrodi|madonie|alcantara|montagna|bronte/i;
let placeCache = { key: "", mare: true, neve: true };

function placeFlags() {
  if (!myPos || !zones || !zones.length) return { mare: true, neve: true };
  const key = myPos.lat.toFixed(2) + "," + myPos.lng.toFixed(2);
  if (placeCache.key === key) return placeCache;
  let bestMare = Infinity;
  let bestNeve = Infinity;
  for (const z of zones) {
    const d = distKm(myPos, z);
    if (d === null) continue;
    if (COAST_ZONE.test(z.n) && d < bestMare) bestMare = d;
    if (SNOW_ZONE.test(z.n) && d < bestNeve) bestNeve = d;
  }
  placeCache = { key, mare: bestMare <= 20, neve: bestNeve <= 45 };
  return placeCache;
}

function seasonFit(a) {
  const now = seasonNow();
  const tmax = wx && typeof wx.tmax === "number" ? wx.tmax : null;
  const where = placeFlags();
  if (SUMMER_ONLY.test(a.it)) {
    // mare, nuoto, sub e barca: solo d'estate, col caldo vero e con il mare vicino
    if (now !== "estate" || (tmax != null && tmax < 23)) return 0;
    if (!where.mare) return 0;
  }
  if (SNOW_ONLY.test(a.it)) {
    if (now === "estate") return 0;
    if (!where.neve) return 0;
  }
  return seasonScore(a) > 0 ? 1 : 0;
}

function weatherFit(a) {
  const m = (wx && wx.mood) || "";
  const wet = /nuoto|mare|snorkeling|sup|barca|spiaggia|term|sauna|spa/i;
  const snow = /sci|ciaspole|slittino|snowboard/i;
  if (m === "pioggia" || m === "temporale") return a.out ? -2 : 3;
  if (m === "freddo") return a.out ? (snow.test(a.it) ? 3 : 0) : 2;
  // col caldo stare fuori a correre non è un regalo: meglio acqua, ombra o fresco
  if (m === "caldo") return wet.test(a.it) ? 3 : a.out ? 0 : 2;
  if (m === "sole") return a.out ? 3 : 1;
  return 1;
}

// a che famiglia appartiene un'attività: salsa e bachata sono la stessa cosa,
// nuoto e surf pure. Serve per non proporre cinque varianti dello stesso giro.
const FAMIGLIE = [
  [/salsa|bachata|tango|merengue|latino|ballo|danz|swing|breakdance|hip hop|flamenco|valzer|liscio|reggaeton/, "ballo"],
  [/yoga|pilates|stretching|ginnastica|functional|crossfit|fitwalking|coaching|meditazion|benessere|spa|sauna|massagg/, "benessere"],
  [/calcio|calcetto|basket|pallavolo|beach volley|rugby|pallamano|pallanuoto|hockey|baseball|football|ultimate/, "squadra"],
  [/tennis|padel|ping pong|tennis tavolo|badminton|squash|racchett/, "racchetta"],
  [/nuoto|mare|snorkel|surf|sup|kayak|canoa|vela|canottaggio|wakeboard|immersion|barca|pesca/, "acqua"],
  [/trekking|escursion|camminat|sentier|montagna|grotte|speleolog|orienteering|boulder|arrampica|palestra di roccia|birdwatch/, "montagna"],
  [/bici|mountain bike|ciclismo|skate|pattin|monopattino|roller/, "ruote"],
  [/corsa|running|marcia/, "corsa"],
  [/cinema|film|cineclub|cineforum|documentar/, "cinema"],
  [/concerto|live|jazz|blues|rock|indie|techno|house|reggae|folk|coro|orchestra|band|opera|dj|vinil|karaoke|podcast|musica/, "musica"],
  [/fatta in casa|farsi|cucin|lievito|pane|forno|pasticcer|ricetta|cooking/, "cucinare"],
  [/colazione|merenda|tè pomeridiano|brunch|gelato|dolci|pasticceria|cioccolat|caffè/, "pausa-dolce"],
  [/mercat|sagra|street food|food truck|bancarell/, "mercato"],
  [/pizza|picnic|aperitivo|afterwork|cena|pranzo|burger|sushi|vino|birra|cocktail|degustazion|vegan|vegetar|food/, "cibo"],
  [/quiz|bingo|bowling|biliardo|freccette|bocce|giochi|laser|escape|tombola|scacchi|puzzle|board game|gdr|trivia/, "giochi"],
  [/museo|mostra|teatro|cabaret|stand up|libro|lettura|book club|poesia|arte|fotografia|murales|convention|fiera/, "cultura"],
  [/volontariato|pulizia|raccolta|aiut|donazion|solidal/, "volontariato"],
  [/cane|gatto|animal|pet/, "animali"],
  [/lingu|scambio linguistico|conversazione/, "lingue"],
  [/parapendio|deltaplano|mongolfiera|bungee|quad|go kart|paracadute|soft air|paintball|rafting|canyoning|adrenalin/, "adrenalina"],
];

function famigliaDi(a) {
  const nome = String((a && a.it) || "").toLowerCase();
  for (const [re, fam] of FAMIGLIE) if (re.test(nome)) return fam;
  return "altro:" + String((a && a.cat) || "");
}

// per un umore tranquillo niente roba spericolata: meglio un'idea che si può fare davvero
function troppoForte(a, mood) {
  const nome = String((a && a.it) || "").toLowerCase();
  if (mood === "calma" || mood === "gusto") {
    if (famigliaDi(a) === "adrenalina") return true;
    if (/techno|rave|big party|discoteca|club|heavy metal|hardcore/.test(nome)) return true;
  }
  return false;
}


// le idee già proposte oggi, divise per umore: così la stessa attività
// non esce per "calma" e poi di nuovo per "divertimento"
// le idee cambiano ogni quarto d'ora: stesso umore, cose diverse
const SLOT_MS = 15 * 60 * 1000;
let moodKick = 0;
function slotKey() {
  return new Date().toISOString().slice(0, 10) + "#" + Math.floor(Date.now() / SLOT_MS);
}
function ideaSeed() {
  return Math.floor(Date.now() / SLOT_MS) + moodKick;
}

function leggiIdee() {
  try {
    const d = JSON.parse(localStorage.getItem("fuori.idee") || "null");
    if (d && d.giorno === slotKey() && d.m) return d;
  } catch {}
  return { giorno: slotKey(), m: {} };
}

function salvaIdee(d) {
  try {
    localStorage.setItem("fuori.idee", JSON.stringify(d));
  } catch {}
}

function buildIdeas() {
  const box = $("#moodIdeas");
  if (!box) return;
  if (!moodPick || !taxonomy) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  const z = zoneNear(myPos);
  const picked = [];
  const seen = new Set();
  const seenRoots = new Set();
  const key = (a) => String(a.it || "").toLowerCase().replace(/\s+(sportiva|agonistica|amatoriale|indoor|outdoor)$/, "").trim();
  const famiglie = new Set();
  const perCategoria = new Map();
  const memorie = leggiIdee();
  const giaAltrove = new Set();
  for (const [umore, ids] of Object.entries(memorie.m || {})) {
    if (umore !== moodPick && Array.isArray(ids)) ids.forEach((id) => giaAltrove.add(id));
  }
  // ogni attività ha un umore suo: si sposta di umore solo per "gusto",
  // che ha poche cose sue e altrimenti resterebbe a secco
  const primarie = (taxonomy.activities || []).filter((x) => (x.m || [])[0] === moodPick).length;
  const soloPrimarie = primarie >= 30;
  const add = (a, why, livello = 1) => {
    if (!a || picked.length >= 5) return false;
    if (seen.has(key(a)) || chipsShownNames.has(key(a)) || !(a.m || []).includes(moodPick)) return false;
    if (seenRoots.has(ideaRoot(a.it))) return false;
    if (troppoForte(a, moodPick)) return false;
    // già proposta per un altro umore oggi: non si ripete
    if (giaAltrove.has(a.it)) return false;
    // l'umore deve essere il suo, non uno di passaggio
    if (soloPrimarie && (a.m || [])[0] !== moodPick) return false;
    // stessa famiglia (salsa e bachata, nuoto e surf) o troppa roba uguale: salto
    const fam = famigliaDi(a);
    if (livello <= 2 && famiglie.has(fam)) return false;
    const cat = String(a.cat || "");
    if (livello === 1 && (perCategoria.get(cat) || 0) >= 2) return false;
    seen.add(key(a));
    seenRoots.add(ideaRoot(a.it));
    famiglie.add(fam);
    perCategoria.set(cat, (perCategoria.get(cat) || 0) + 1);
    picked.push({ a, why });
    return true;
  };

  // tutti i candidati in ordine di senso: prima quello che è tipico qui intorno
  // (la mia zona e quelle a mezz'ora), poi il resto della Sicilia
  const ordine = [];
  let nVicini = 0;
  const gia = new Set();
  const metti = (a) => {
    if (!a || gia.has(a.it)) return;
    gia.add(a.it);
    ordine.push(a);
  };
  for (const zone of zonesAround(myPos)) {
    for (const name of zone.acts) {
      const a = (taxonomy.activities || []).find((x) => x.it === name);
      if (a && weatherFit(a) >= 1 && seasonFit(a)) metti(a);
    }
  }
  // quante sono "di qui": quelle della mia zona e di quelle a mezz'ora
  nVicini = ordine.length;
  (taxonomy.activities || [])
    .filter((a) => (a.m || []).includes(moodPick))
    .map((a) => ({ a, f: weatherFit(a) }))
    .filter((x) => x.f >= 1 && seasonFit(x.a))
    .sort((x, y) => y.f - x.f || (y.a.pop || 0) - (x.a.pop || 0))
    .forEach((x) => metti(x.a));

  // cosa c'entra davvero un'attività con quell'umore: "gruppo di supporto" non è coccole,
  // "networking" non è voglia di mangiare bene
  const MOOD_WORDS = {
    calma: /yoga|medit|pilates|\bspa\b|massagg|relax|lettura|libro|giardino|orto|uncinetto|maglia|pittura|disegno|acquari|birdwatching|passeggiat|camminat|picnic|tè|fotografia|cinema|teatro|museo|mostra|pesca|nuoto|snorkel|forest|barca|tramonto/i,
    energia: /calcio|padel|tennis|basket|pallavolo|volley|running|corsa|fitwalk|palestra|crossfit|arrampicata|bici|mountain bike|nuoto|surf|quad|go kart|kart|paintball|laser|danza|fitness|boxe|arti marziali|karate|judo|skate|parkour|hiking|trekking/i,
    divertimento: /karaoke|festa|party|quiz|giochi|bowling|biliardo|freccette|escape|laser|paintball|comedy|stand up|cabaret|concerto|live|dj|techno|rave|serata|halloween|swing|salsa|bachata|tango|danza|musical|spettacolo|carnevale|maschera/i,
    scoperta: /tour|museo|mostra|conferenza|visita|escursion|trekking|speleolog|astronomia|planetario|scienza|storia|arte|fotografia|birdwatching|documentari|cineforum|teatro|lingua|corso|workshop|mercat|food tour|vulcan|etna/i,
    gusto: /cibo|cucina|pizza|pasta|pane|vino|birra|degustazione|cena|pranzo|colazione|brunch|aperitivo|street food|food|dolci|pasticceria|cake|cioccolat|mercato|sagra|barbecue|grill|sushi|tapas/i,
    compagnia: /gruppo|community|squadra|club|circolo|volontariato|raccolta|banco|picnic|speed date|cena tra sconosciuti|brunch|tè|giochi|carte|karaoke|coro|teatro|danza|salsa|tango|padel|calcetto|calcio|pallavolo|basket|trekking|escursion|passeggiat|festa|networking|associazione/i,
    romanticismo: /\bspa\b|relax|massagg|cena|tramonto|passeggiat|picnic|vino|degustazione|cinema|teatro|concerto|jazz|weekend|coppia|romantic|ballo|salsa|tango|barca|mare|spiaggia|giardino|museo|mostra|colazione|brunch|dolci|cioccolat|fiori|profumo|stella|cielo/i,
  };
  const pertinenza = (a) => {
    const re = MOOD_WORDS[moodPick];
    if (!re || !a) return 0;
    return re.test(`${a.it || ""} ${a.en || ""}`.toLowerCase()) ? 2 : -1;
  };

  // i gusti della persona: quello che ha scritto nel profilo e quello che usa davvero
  // nell'app. Conta prima dei gusti, ma ogni giorno l'ordine cambia lo stesso.
  const miei = new Set(mieiGusti());
  const gustoDi = (a) => {
    const nome = String((a && a.it) || "").toLowerCase();
    let s = 0;
    if (miei.size && [...miei].some((g) => g && (nome.includes(g) || g.includes(nome)))) s += 1;
    s += Math.min(3, Number(taste.a[actName(a)] || 0));
    s += Math.min(2, Number(taste.c[String((a && a.cat) || "")] || 0));
    return s;
  };
  const semeGiorno = ideaSeed();
  const variazione = (a) => {
    let h = semeGiorno % 9973;
    const s = String((a && a.it) || "");
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100003;
    return h % 10;
  };
  // i gusti pesano dieci volte la variazione del giorno: si sentono, ma non si ripete sempre lo stesso elenco
  const perGusti = (elenco) =>
    elenco
      .map((a, i) => ({ a, i, s: (gustoDi(a) + pertinenza(a)) * 10 + variazione(a) }))
      .sort((x, y) => y.s - x.s || x.i - y.i)
      .map((x) => x.a);

  // se oggi ho già scelto per questo umore, quelle restano: cambiare umore e tornare
  // indietro non deve cambiare le carte in tavola
  // se un'attività non c'entra più con questo umore (l'elenco cambia, o è rimasta
  // in memoria da ieri) la lascio fuori invece di riproporla
  const fissate = (Array.isArray((memorie.m || {})[moodPick]) ? memorie.m[moodPick] : []).filter((id) =>
    (taxonomy.activities || []).some((x) => x.it === id && (x.m || []).includes(moodPick))
  );
  if (fissate.length) {
    for (const id of fissate) {
      const a2 = (taxonomy.activities || []).find((x) => x.it === id);
      if (a2) {
        picked.push({ a: a2, why: "" });
        famiglie.add(famigliaDi(a2));
        const cat2 = String(a2.cat || "");
        perCategoria.set(cat2, (perCategoria.get(cat2) || 0) + 1);
      }
    }
  }

  // tre giri: il primo sceglie cose diverse fra loro, il secondo allarga la mano,
  // il terzo riempie fino a cinque. Così le idee ci sono sempre e non si ripetono.
  const scegli = (elenco) => {
    for (const livello of [1, 2, 3]) {
      for (const a of elenco) {
        if (picked.length >= 5) break;
        add(a, "", livello);
      }
      if (picked.length >= 5) break;
    }
  };
  // ogni giorno l'ordine cambia un po': le stesse regole, ma non sempre le solite cinque
  const seme = ideaSeed();
  const mescola = (elenco) => {
    let s = seme * 9301 + 49297;
    const out = elenco.slice();
    for (let i = out.length - 1; i > 0; i--) {
      s = (s * 9301 + 49297) % 233280;
      const j = Math.floor((s / 233280) * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  // prima le cose che si possono fare qui intorno, poi il resto della Sicilia
  if (picked.length < 5) scegli(perGusti(mescola(ordine.slice(0, nVicini))));
  if (picked.length < 5) scegli(perGusti(mescola(ordine.slice(nVicini))));
  // ricordo cosa ho proposto oggi per questo umore
  if (picked.length) {
    memorie.m = memorie.m || {};
    memorie.m[moodPick] = picked.map((x) => x.a.it);
    salvaIdee(memorie);
  }
  if (!picked.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.innerHTML =
    `<div class="ideas2-head"><p class="ideas2-label">${esc(t("mood.ideas"))}</p><p class="ideas2-sub">${esc(t("mood.pick"))}</p></div>` +
    `<div class="ideas2-row">` +
    picked
      .map(
        ({ a, why }) =>
          `<button class="idea2" type="button" data-it="${esc(a.it)}" data-cat="${esc(a.cat)}" data-nome="${esc(actName(a))}"><span class="i2-c"><span class="i2-ic">${catIcon(a.cat)}</span> ${esc(catName(a.cat))}</span><span class="i2-t">${esc(actName(a))}</span>${
            why ? `<span class="i2-w">${esc(why)}</span>` : ""
          }<span class="i2-go" aria-hidden="true">›</span></button>`
      )
      .join("") +
    `</div>`;
  box.querySelectorAll("[data-it]").forEach((b) => {
    b.onclick = () => apriIdeaUmore(b.dataset.it, b.dataset.cat, b.dataset.nome);
  });
}

// scelta un'idea: prima si guarda se c'è già un evento uguale, poi semmai si crea
async function apriIdeaUmore(it, catId, nome) {
  if (!it) return;
  const pulito = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
  const uguale = (a, b) => {
    const x = pulito(a), y = pulito(b);
    return Boolean(x && y && (x === y || x.includes(y) || y.includes(x)));
  };
  const buoni = (lista) =>
    (lista || [])
      .filter((ev) => ev && ev.id && !ev.mine && (Number(ev.endsAt) || 0) >= Date.now() - 3600e3)
      .filter((ev) => !catId || ev.category === catId)
      .filter((ev) => uguale(ev.activity, it))
      .sort((a, b) => Number(a.startsAt) - Number(b.startsAt))
      .slice(0, 4);
  let trovati = buoni(events);
  if (!trovati.length) {
    try {
      const d = await api("/events?limit=30&q=" + encodeURIComponent(it));
      trovati = buoni(d.events);
    } catch {}
  }
  if (!trovati.length) {
    await apriCreaCon(it, catId);
    toast(t("mood.noneLike"));
    return;
  }
  const emoji = $("#msEmoji"), title = $("#msTitle"), sub = $("#msSub"), list = $("#msList"), crea = $("#msCreate");
  if (emoji) emoji.innerHTML = catIcon(catId);
  if (title) title.textContent = nome || it;
  if (sub) sub.textContent = t("mood.interested");
  if (list) {
    list.innerHTML = trovati
      .map((ev) => {
        const posti = ev.capacity - ev.joined;
        const quando = `${quandoTesto(ev)} · ${luogoDi(ev)}`;
        return `<button class="cs-row" type="button" data-ev="${esc(ev.id)}"><span class="cs-name"><b>${esc(ev.title || nome || it)}</b><span class="cs-sub">${esc(quando)}</span></span><span class="cs-n">${posti > 0 ? esc(t("card.spots", { n: posti })) : esc(t("card.full"))}</span><span class="cs-go" aria-hidden="true">›</span></button>`;
      })
      .join("");
    list.onclick = (e) => {
      const b = e.target.closest("[data-ev]");
      if (!b) return;
      hide("moodSheet");
      openDetail(b.dataset.ev);
    };
  }
  if (crea) {
    crea.textContent = t("mood.createOwn");
    crea.onclick = () => {
      hide("moodSheet");
      apriCreaCon(it, catId);
    };
  }
  show("moodSheet");
}

async function askPosition() {
  const p = await locate();
  if (!p) {
    toastErr(t("mood.noPos"));
    return false;
  }
  useMyPosition(p, { force: true });
  startGeoWatch();
  return true;
}

// l'umore si chiede una volta al giorno, in sovraimpressione, appena apri l'app
let moodPerCreare = false;
function moodDayKey() {
  try { return new Date().toISOString().slice(0, 10); } catch { return ""; }
}
function moodDailyPrompt() {
  try { if (localStorage.getItem("fuori.moodDay") === moodDayKey()) return; } catch {}
  if (!person && !localStorage.getItem("fuori.onbDone")) return;
  setTimeout(() => {
    if (document.querySelector(".sheet:not([hidden])")) return;
    openMoodDaily();
  }, 900);
}
function openMoodDaily() {
  paintMood();
  show("moodDaily");
}
// l'umore va anche negli insight: serve a capire cosa cerca la gente
function salvaUmore(m) {
  try { localStorage.setItem("fuori.moodDay", moodDayKey()); } catch {}
  api("/mood", { method: "POST", body: JSON.stringify({ device, mood: m, day: moodDayKey() }) }).catch(() => {});
}

// scelto l'umore si chiude la domanda e la lista si riordina subito
async function scegliUmore(id) {
  if (!id) return;
  const chiudi = moodPick === id;
  if (!taxonomy && !chiudi) { try { await loadTaxonomy(); } catch {} }
  moodPick = chiudi ? "" : id;
  try {
    if (chiudi) localStorage.removeItem("fuori.mood");
    else localStorage.setItem("fuori.mood", id);
  } catch {}
  paintMood();
  if (chiudi) {
    onlyMood = false;
    renderList();
  }
  if (!chiudi) {
    salvaUmore(id);
    hide("moodDaily");
    renderList();
    if (moodPerCreare) {
      moodPerCreare = false;
      if (possoFareEventi()) openCreate();
    }
  }
}

function paintMood() {
  const chips = $("#moodChips");
  if (!chips) return;
  chips.innerHTML = MOODS.map(
    (m) =>
      `<button class="chip mood-chip ${moodPick === m.id ? "on" : ""}" type="button" data-mood="${m.id}"><span aria-hidden="true">${m.emoji}</span> ${esc(t("mood." + m.id))}</button>`
  ).join("");
  // scelto l'umore compaiono le cinque idee di oggi: da lì si vede se l'evento
  // esiste già, oppure si crea
  chips.querySelectorAll("[data-mood]").forEach((b) => {
    b.onclick = () => scegliUmore(b.dataset.mood);
  });
  const ref = $("#moodRefresh");
  if (ref) ref.hidden = !moodPick;
  const rot = $("#moodRotate");
  if (rot) rot.hidden = !moodPick;
  const where = $("#moodWhere");
  if (where) {
    const z = townNow();
    if (z) {
      where.textContent = t("mood.whereZone", { z });
    } else {
      where.innerHTML = `<button class="mood-loc" type="button" id="moodLocBtn">📍 ${esc(t("mood.whereAsk"))}</button>`;
      const b = $("#moodLocBtn");
      if (b) b.onclick = askPosition;
    }
  }
  paintHero();
  buildIdeas();
  paintMoodSay();
}

function paintWeather() {
  const line = $("#wxLine");
  if (line) {
    if (wx && wx.t != null) {
      const zone = zoneNear(myPos);
      if (!zones && myPos) loadZones().then(() => paintWeather()).catch(() => {});
      line.hidden = false;
      line.textContent = t("wx.line", {
        z: zone ? placeShort(zone) : t("wx.here"),
        t: String(wx.t),
        sky: t("wx.sky." + (wx.sky || "sereno")),
      });
    } else {
      line.hidden = true;
    }
  }
  // la fila lunga delle idee non c'è più: adesso le cose da fare stanno nella matrice
  const bar = $("#ideasBar");
  if (!bar) return;
  if (!taxonomy) { bar.hidden = true; return; }
  const skip = new Set(["volontariato", "viaggi"]);
  let base = taxonomy.activities.filter((a) => !skip.has(a.cat) && seasonFit(a));
  // se ho detto come mi sento, le idee sono di quello stato d'animo
  if (moodPick) {
    const only = base.filter((a) => (a.m || []).includes(moodPick));
    if (only.length >= 3) base = only;
  }
  const pool = rankActivities(base);
  // niente doppioni con le idee già suggerite più sotto nella pagina
  const below = new Set(
    [...document.querySelectorAll("#moodIdeas [data-idea]")].map((x) => String(x.dataset.it || "").toLowerCase())
  );
  const belowRoots = new Set([...below].map(ideaRoot));
  const fresh = (list) =>
    list.filter((a) => !below.has(String(a.it).toLowerCase()) && !belowRoots.has(ideaRoot(a.it)));
  const outdoors = fresh(pool.filter((a) => a.out));
  const indoors = fresh(pool.filter((a) => !a.out));
  const first = pool[0] && pool[0].out ? [outdoors, indoors] : [indoors, outdoors];
  const want = moodPick ? 9 : 7;
  const picks = [];
  const names = new Set();
  const roots = new Set();
  const cats = new Set();
  const take = (list, anyCat) => {
    for (const a of list) {
      const k = String(a.it).toLowerCase();
      if (names.has(k)) continue;
      if (roots.has(ideaRoot(a.it))) continue;
      if (!anyCat && cats.has(a.cat)) continue;
      names.add(k);
      roots.add(ideaRoot(a.it));
      cats.add(a.cat);
      picks.push(a);
      return true;
    }
    return false;
  };
  // alterno all'aperto e al chiuso; se le categorie finiscono, va bene anche ripeterle
  let turn = 0;
  let guard = 0;
  while (picks.length < want && guard++ < 80) {
    const order = turn++ % 2 === 0 ? first : [first[1], first[0]];
    if (!take(order[0], false) && !take(order[1], false)) {
      if (!take(order[0], true) && !take(order[1], true)) break;
    }
  }
  chipsShownNames = new Set(picks.map((a) => String(a.it).toLowerCase()));
  if (!picks.length) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.innerHTML = `<span class="ideas-label">${esc(t("home.ideas"))}</span>` +
    picks.map((a) => `<button class="chip" data-idea="${esc(actName(a))}">${esc(actName(a))}</button>`).join("");
}

function rankActivities(list) {
  return list
    .map((a, i) => ({ a, i, sc: seasonScore(a) * 10 + weatherScore(a) }))
    .sort((x, y) => y.sc - x.sc || x.i - y.i)
    .map((x) => x.a);
}

function eventPos(ev) {
  return Number.isFinite(ev.lat) && Number.isFinite(ev.lng) ? { lat: ev.lat, lng: ev.lng } : null;
}

let aiHistory = [];
const aiCache = new Map();

/* ---------- voce ---------- */
const LANG_TAG = { it: "it-IT", en: "en-GB", es: "es-ES", pt: "pt-BR" };
let recog = null;
let recording = false;
let mediaRec = null;
let recChunks = [];
let recStopTimer = null;
let lastWasVoice = false;
let voiceOn = localStorage.getItem("fuori.voice") === "1";

function micUi(on) {
  const mic = $("#aiMic");
  if (mic) {
    mic.classList.toggle("rec", Boolean(on));
    mic.setAttribute("aria-label", t(on ? "ai.recording" : "ai.rec"));
  }
  const big = $("#aiRecBtn");
  if (big) big.classList.toggle("on", Boolean(on));
  const rs = $("#aiRecState");
  if (rs) rs.textContent = on ? t("ai.recording") : "Tocca il microfono e parla. Tocca ancora per fermarti.";
}

function stopVoice() {
  clearTimeout(recStopTimer);
  try { recog?.stop(); } catch {}
  try { if (mediaRec && mediaRec.state !== "inactive") mediaRec.stop(); } catch {}
  recording = false;
  micUi(false);
}

function srSupported() {
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

// la voce: registro sempre l'audio e lo faccio trascrivere dal server, che sente
// anche le parole dette piano. Il riconoscimento del telefono resta solo per farti
// vedere le parole mentre parli: se il server non risponde uso quello.
let srDettato = "";
let haRegistratore = false;

async function startVoice() {
  if (recording) { stopVoice(); return; }
  if (!navigator.mediaDevices?.getUserMedia) { toast(t("ai.micNo")); return; }
  lastWasVoice = true;
  recording = true;
  srDettato = "";
  haRegistratore = false;
  micUi(true);
  const input = $("#aiInput");
  input.value = "";
  input.placeholder = t("ai.recording");

  // 1) registro l'audio vero: è questo che poi diventa testo
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // se nel frattempo hai già fermato, non lascio il microfono acceso
    if (!recording) { stream.getTracks().forEach((tr) => tr.stop()); return; }
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
    const mime = candidates.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || "";
    mediaRec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recChunks = [];
    haRegistratore = true;
    mediaRec.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
    mediaRec.onstop = () => {
      stream.getTracks().forEach((tr) => tr.stop());
      const blob = new Blob(recChunks, { type: mediaRec.mimeType || "audio/webm" });
      // niente audio (troppo silenzio o permesso negato): uso quello che ha sentito il telefono
      if (blob.size < 1200) {
        if (srDettato) { input.value = srDettato; askAi(); }
        else toast(t("ai.micHeard"));
        return;
      }
      transcribe(blob, srDettato);
    };
    mediaRec.start();
  } catch {
    mediaRec = null;
    haRegistratore = false;
  }

  // 2) intanto il telefono mi mostra le parole mentre le dici
  if (srSupported()) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    recog = new SR();
    recog.lang = LANG_TAG[lang] || "it-IT";
    recog.interimResults = true;
    recog.continuous = true;
    recog.maxAlternatives = 3;
    let finalText = "";
    recog.onresult = (ev) => {
      let tmp = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const part = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) finalText += part;
        else tmp += part;
      }
      srDettato = normalizzaDettato(finalText + tmp).slice(0, 300);
      input.value = srDettato;
      clearTimeout(recStopTimer);
      // silenzio lungo: chiudo io, ma lascio il tempo di pensare a una frase
      recStopTimer = setTimeout(() => { if (recording) stopVoice(); }, 25000);
    };
    recog.onerror = (ev) => {
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        toast(t("ai.micDenied"));
        if (!haRegistratore) { recording = false; micUi(false); input.placeholder = t("ai.ph"); }
      }
      // no-speech, network, aborted: non fermo la registrazione, riparte da sola
    };
    recog.onend = () => {
      // il telefono chiude da solo dopo una pausa: riparto subito, senza perdere il resto
      if (recording) {
        setTimeout(() => { if (recording) { try { recog.start(); } catch {} } }, 120);
        return;
      }
      micUi(false);
      input.placeholder = t("ai.ph");
      if (!haRegistratore) {
        const text = normalizzaDettato(input.value);
        if (text) { input.value = text; askAi(); }
        else toast(t("ai.micHeard"));
      }
    };
    try {
      recog.start();
    } catch {}
  }

  if (!haRegistratore && !srSupported()) {
    recording = false;
    micUi(false);
    input.placeholder = t("ai.ph");
    toastErr(t("ai.micDenied"));
    return;
  }
  recStopTimer = setTimeout(() => stopVoice(), 45000);
}

// il dettato arriva tutto maiuscolo o con maiuscole a caso: lo rimetto normale.
// La maiuscola resta solo a inizio frase, così si legge come si parla.
function normalizzaDettato(t) {
  let s = String(t || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  s = s.toLowerCase();
  s = s.replace(/(^|[.!?]\s+)([a-zà-öø-ÿ])/g, (m, pre, c) => pre + c.toUpperCase());
  return s;
}

function blobToB64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = reject;
    fr.onload = () => resolve(String(fr.result).split(",")[1] || "");
    fr.readAsDataURL(blob);
  });
}

// Il telefono registra in webm/opus, che il trascrittore del server non legge:
// la trascrizione falliva e restavano le parole sbagliate del telefono.
// Qui porto l'audio a 16 kHz mono e lo impacchetto in WAV, che si trascrive sempre.
function wavDaCampioni(campioni, rate) {
  const n = campioni.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const scrivi = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  scrivi(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  scrivi(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  scrivi(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const c = Math.max(-1, Math.min(1, campioni[i]));
    v.setInt16(44 + i * 2, c < 0 ? c * 0x8000 : c * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

async function audioInWav(blob) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  const ctx = new AC();
  try {
    const originale = await ctx.decodeAudioData(await blob.arrayBuffer());
    const rate = 16000;
    const Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    let dati = originale;
    if (Off) {
      const off = new Off(1, Math.max(1, Math.ceil(originale.duration * rate)), rate);
      const src = off.createBufferSource();
      src.buffer = originale;
      src.connect(off.destination);
      src.start();
      dati = await off.startRendering();
    }
    // un canale solo: due tracce raddoppiano il peso senza aiutare la trascrizione
    const canali = dati.numberOfChannels;
    const lunghi = dati.length;
    const mono = new Float32Array(lunghi);
    for (let c = 0; c < canali; c++) {
      const traccia = dati.getChannelData(c);
      for (let i = 0; i < lunghi; i++) mono[i] += traccia[i] / canali;
    }
    return wavDaCampioni(mono, dati.sampleRate);
  } catch {
    return null;
  } finally {
    try { ctx.close(); } catch {}
  }
}

async function transcribe(blob, ripiego) {
  const mic = $("#aiMic");
  const input = $("#aiInput");
  if (mic) mic.classList.add("busy");
  input.placeholder = t("ai.transcribing");
  // le parole del telefono sono meno precise: le lascio scritte nel campo,
  // così le controlli e correggi prima di mandarle (prima partivano da sole
  // e l'AI rispondeva a una frase che non era quella detta)
  const usaRipiego = () => {
    if (ripiego) {
      input.value = ripiego;
      input.focus();
      toast("Ho scritto quello che ho capito: controlla e premi invio.");
    } else toast(t("ai.micHeard"));
  };
  try {
    const wav = await audioInWav(blob);
    const invio = wav || blob;
    const b64 = await blobToB64(invio);
    const r = await Promise.race([
      api("/stt", { method: "POST", body: JSON.stringify({ audio: b64, mime: invio.type.split(";")[0], lang, device }) }),
      new Promise((_, no) => setTimeout(() => no(new Error("timeout")), 25000)),
    ]);
    const text = normalizzaDettato(String(r.text || "")).slice(0, 300);
    if (!text) return usaRipiego();
    input.value = text;
    askAi();
  } catch (err) {
    // il server non ha capito o ci ha messo troppo: meglio le parole del telefono che niente
    usaRipiego();
  } finally {
    if (mic) mic.classList.remove("busy");
    input.placeholder = t("ai.ph");
  }
}

// voci femminili, per lingua: le prime che si trovano nel telefono
const FEMALE_NAMES = {
  it: ["alice", "elsa", "isabella", "federica", "silvia", "vittoria", "paola", "google italiano"],
  en: ["sonia", "libby", "hazel", "samantha", "karen", "moira", "tessa", "google uk english female", "google us english"],
  es: ["monica", "mónica", "paulina", "sabina", "helena", "laura", "google español"],
  pt: ["luciana", "joana", "fernanda", "ines", "inês", "maria", "google português do brasil"],
};
const MALE_NAMES = ["diego", "cosimo", "marco", "luca", "paolo", "giorgio", "roberto", "alessandro",
  "mauro", "daniel", "alex", "fred", "rishi", "oliver", "arthur", "george", "james", "jorge", "juan",
  "pablo", "enrique", "carlos", "felipe", "ricardo", "joaquim", "thiago"];

/* la voce: frasi corte, piccole pause, ritmo che cambia — è questo che la fa sembrare viva */
const FRASI_STORTE = [
  [/\bun albebero\b/gi, "un albero"],
  [/\balbebero\b/gi, "albero"],
  [/\balberbero\b/gi, "albero"],
  [/\bmetti comodo\b/gi, "mettiti comodo"],
  [/\bmetti tranquill([oa])\b/gi, "mettiti tranquill$1"],
  [/\bmetti a posto\b/gi, "mettiti a posto"],
  [/\bmetti seduto\b/gi, "mettiti seduto"],
  [/\b(niente|nulla|qualcosa) di in programma\b/gi, "$1 in programma"],
];

// una domanda senza "?" la voce la legge come un'affermazione
// una frase è una domanda solo se COMINCIA come una domanda: prima
// bastava la parola "vuoi" o "possiamo" dentro la frase e trasformavo
// anche le affermazioni ("se vuoi possiamo andare al mare" -> "?")
const APERTURE_DOMANDA = /^(cosa|che cosa|come mai|come faccio|quando|dove|chi|perché|perche|quale|quali|quanto|quanta|quanti|quante|ti va|ti piacerebbe|ti andrebbe|vuoi|preferisci|hai voglia|hai bisogno|hai tempo|sei (?:stanco|stanca|sicuro|pronto)|puoi|sai|andiamo|facciamo|ci stai|che ne dici|dimmi|mi consigli|mi dici|secondo te)\b/i;
const NON_DOMANDA = /^(come sempre|come al solito|come sai|come dicevo|quando ero|quando posso|dove possibile|chi vivrà|per quanto mi riguarda)\b/i;

function domandeGiuste(t) {
  const testo = String(t || "");
  if (!testo) return testo;
  const pezzi = testo.split(/([.!?]+\s+)/);
  for (let i = 0; i < pezzi.length; i += 2) {
    const frase = pezzi[i];
    if (!frase) continue;
    const pulita = frase.trim();
    if (!pulita || /[?!:]$/.test(pulita)) continue;
    if (NON_DOMANDA.test(pulita)) continue;
    if (!APERTURE_DOMANDA.test(pulita)) continue;
    const senzaPunto = pulita.replace(/\.+$/, "");
    const spazio = frase.length - frase.replace(/\s+$/, "").length;
    pezzi[i] = senzaPunto + "?" + (spazio ? " " : "");
    // il punto che c'era prima va tolto, se no resta "?."
    if (pezzi[i + 1]) pezzi[i + 1] = pezzi[i + 1].replace(/[.!?]+/g, "") || " ";
  }
  return pezzi.join("");
}

// solo i refusi visti davvero: niente regole larghe che rovinano parole giuste
function paroleGiuste(t) {
  let s = String(t || "");
  for (const [cerca, metti] of FRASI_STORTE) s = s.replace(cerca, metti);
  return s;
}

// "alle20:00" capita anche nel testo scritto: lo sistemo mentre arriva
function aggiustaTestoAI(t) {
  return String(t || "").replace(/([a-zà-ù])(\d{1,2}[:.]\d{2})/gi, "$1 $2");
}

function testoPerVoce(raw) {
  let s = domandeGiuste(paroleGiuste(String(raw || "").replace(/\r/g, "")));
  s = s.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1"); // [testo](link) -> testo
  s = s.replace(/https?:\/\/\S+/g, " ");
  s = s.replace(/^\s*[-*•·]\s+/gm, "");                  // elenchi puntati
  // un a capo è una fine di frase: se prima non c'è punteggiatura metto il punto,
  // così la voce fa la pausa giusta invece di attaccare tutto con una virgola
  s = s.replace(/\n+/g, (m, off, str) => {
    const prima = str.slice(0, off).trim().slice(-1);
    return /[.!?…:;,]/.test(prima) ? " " : ". ";
  });
  s = s.replace(/[*_#`>|]/g, "");
  s = s.replace(/[→➜➡–—]/g, ",");
  s = s.replace(/[•●·]/g, ",");
  s = s.replace(/…+|(\.\s*){2,}/g, ",");
  s = s.replace(/\bkm\b/g, "chilometri");
  // a volte il modello attacca l'ora alla parola ("alle20:00"): la voce la stacca
  s = s.replace(/([a-zà-ù])(\d{1,2}[:.]\d{2})/gi, "$1 $2");
  try { s = s.replace(/[\p{Extended_Pictographic}\uFE0F]/gu, " "); } catch {}
  s = s.replace(/\s+/g, " ");
  s = s.replace(/\s+([,.;:!?])/g, "$1");   // " ," -> ","
  s = s.replace(/([,;])(?=\S)/g, "$1 ");   // virgola attaccata alla parola dopo (i due punti no: 18:30)
  s = s.replace(/([.!?])(\s*[.!?])+/g, "$1");
  s = s.replace(/\s+/g, " ").trim();
  if (s && !/[.!?…]$/.test(s)) s += ".";
  return s.slice(0, 1170);
}

function frasiDi(testo) {
  const pezzi = testo.match(/[^.!?…]+[.!?…]*/g) || [testo];
  const out = [];
  for (let p of pezzi) {
    p = p.replace(/^[\s,;:.!?]+/, "").trim();
    if (!p) continue;
    while (p.length > 170) {
      const virgola = p.lastIndexOf(",", 170);
      const taglio = virgola > 70 ? virgola + 1 : 170;
      out.push(p.slice(0, taglio).trim());
      // il pezzo appena messo va tolto: prima restava lì e la voce ricominciava da capo
      p = p.slice(taglio).replace(/^[\s,;:.!?]+/, "").trim();
    }
    if (p) out.push(p);
  }
  // pezzi cortissimi ("Peccato.") fanno la voce a scatti: si attaccano al vicino
  const fusi = [];
  for (const pezzo of out) {
    const prima = fusi[fusi.length - 1];
    if (prima && (prima.length < 28 || pezzo.length < 22) && prima.length + pezzo.length <= 180) {
      fusi[fusi.length - 1] = prima + " " + pezzo;
    } else {
      fusi.push(pezzo);
    }
  }
  return fusi.slice(0, 16);
}

let voceToken = 0;

// come deve suonare la voce: femminile (la voce naturale di Google) o maschile
// una voce sola, sempre la stessa: quella di Google Traduttore in italiano, naturale e
// senza quota. Se un giorno non risponde più, il server ripiega da solo su un'altra voce
// (sempre femminile o maschile, mai robotica). Niente più scelta: era solo un dubbio in più.
const voceSesso = "f";
const voceTimbro = new Map();   // url dell'audio -> "robot" se va abbassata di tono
const voceByte = new Map();     // url -> i byte veri dell'audio, per poterlo rielaborare
const voceGrave = new Map();    // url -> audio già abbassato di tono
let audioCtx = null;

function ctxAudio() {
  const C = window.AudioContext || window.webkitAudioContext;
  if (!C) return null;
  if (!audioCtx) audioCtx = new C();
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  return audioCtx;
}

function paintSesso() {
  for (const b of document.querySelectorAll("#aiSesso button")) b.classList.toggle("on", b.dataset.s === voceSesso);
}

// abbassa il tono senza rallentare: allungo i campioni e poi li riaccorcio.
// Il ritmo resta quello di prima, il timbro diventa maschile.
function abbassaTono(campioni, rate, quanto) {
  const grana = Math.max(64, Math.floor(rate * 0.04));
  const passoDentro = Math.floor(grana / 2);
  const passoFuori = Math.max(1, Math.round(passoDentro / quanto));
  const lunga = Math.ceil(campioni.length / quanto) + grana;
  const out = new Float32Array(lunga);
  const pesi = new Float32Array(lunga);
  const fin = new Float32Array(grana);
  for (let i = 0; i < grana; i++) fin[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (grana - 1));
  for (let s = 0, o = 0; s + grana < campioni.length; s += passoDentro, o += passoFuori) {
    for (let i = 0; i < grana; i++) {
      out[o + i] += campioni[s + i] * fin[i];
      pesi[o + i] += fin[i];
    }
  }
  for (let i = 0; i < lunga; i++) if (pesi[i] > 0.0001) out[i] /= pesi[i];
  return out;
}

async function audioMaschile(url) {
  if (voceGrave.has(url)) return voceGrave.get(url);
  const ctx = ctxAudio();
  if (!ctx) return null;
  const byte = voceByte.get(url);
  if (!byte) return null;
  const buf = await ctx.decodeAudioData(byte.slice().buffer);
  const quanto = 0.84;                       // circa tre semitoni più in basso
  const allungato = abbassaTono(buf.getChannelData(0), buf.sampleRate, quanto);
  const finale = ctx.createBuffer(1, Math.floor(allungato.length * quanto), buf.sampleRate);
  const dst = finale.getChannelData(0);
  for (let j = 0; j < dst.length; j++) {
    const pos = j / quanto;
    const i = Math.floor(pos);
    const f = pos - i;
    dst[j] = (allungato[i] || 0) * (1 - f) + (allungato[i + 1] || 0) * f;
  }
  if (voceGrave.size > 24) voceGrave.clear();
  voceGrave.set(url, finale);
  return finale;
}

// la voce buona arriva dal server; se non c'è, si usa quella del telefono
const voceCache = new Map();
let voceAudio = null;
// dopo "ferma la voce" (o con la voce spenta) non deve più uscire un suono,
// nemmeno la risposta che stava arrivando in quel momento: si torna a parlare
// solo quando arriva una domanda nuova.
let voceZitta = false;
// tutte le sorgenti audio che possono parlare: se ne accendo una, spengo le altre
const voceFonti = new Set();

function zittisciTutto() {
  if (voceAudio) {
    try { voceAudio.pause(); } catch {}
    try { voceAudio.currentTime = 0; } catch {}
    voceAudio = null;
  }
  for (const f of voceFonti) {
    try { f.onended = null; f.stop(); } catch {}
  }
  voceFonti.clear();
  voceFine = 0;
  try { speechSynthesis.cancel(); } catch {}
}

function fermaVoce() {
  voceToken++;
  voceZitta = true;
  zittisciTutto();
}

// ferma subito quello che sta dicendo
function stopVoce() {
  voceToken++;
  voceZitta = true;
  zittisciTutto();
  if (voceSess) voceSess.fine = true;
  const b = $("#aiStop");
  if (b) b.hidden = true;
}

function spezzaPerVoce(pulito, max = 380) {
  const frasi = frasiDi(pulito);
  const pezzi = [];
  let cur = "";
  for (const f of frasi) {
    if (cur && (cur + " " + f).length > max) { pezzi.push(cur); cur = f; }
    else cur = cur ? cur + " " + f : f;
  }
  if (cur) pezzi.push(cur);
  return pezzi.slice(0, 12);
}

// la voce si accoda nel tempo: il pezzo dopo parte esattamente quando finisce quello prima
let voceFine = 0;
const bufferVoce = new Map();

async function bufferDi(url, ctx) {
  const preso = bufferVoce.get(url);
  if (preso) return preso;
  try {
    const r = await fetch(url);
    const ab = await r.arrayBuffer();
    const buf = await ctx.decodeAudioData(ab);
    if (bufferVoce.size > 30) bufferVoce.clear();
    bufferVoce.set(url, buf);
    return buf;
  } catch {
    return null;
  }
}

function playVoceElemento(url, token, velocita = 1.08) {
  return new Promise((res) => {
    let chiuso = false;
    let guardia = 0;
    const finisci = () => { if (chiuso) return; chiuso = true; clearInterval(guardia); res(); };
    const audio = new Audio(url);
    voceAudio = audio;
    const robot = voceTimbro.get(url) === "robot" && voceSesso === "m";
    try { audio.playbackRate = robot ? Math.pow(2, -250 / 1200) : velocita; } catch {}
    if (robot) {
      try { audio.preservesPitch = false; audio.mozPreservesPitch = false; audio.webkitPreservesPitch = false; } catch {}
    }

    audio.onended = finisci;
    audio.onerror = finisci;
    audio.onpause = finisci;
    // se il telefono blocca l'avvio (capita appena acceso lo schermo) la voce non parte e
    // l'attesa resterebbe appesa per sempre: la sblocco io dopo sei secondi di silenzio
    let ultimo = Date.now();
    audio.ontimeupdate = () => { ultimo = Date.now(); };
    guardia = setInterval(() => { if (Date.now() - ultimo > 6000) finisci(); }, 1500);
    audio.play().catch(finisci);
  });
}

// mette in coda il pezzo e torna subito: la voce scorre mentre il pezzo dopo si scarica
async function playVoce(url, token) {
  if (token !== voceToken) return;
  const stopBtn = $("#aiStop");
  if (stopBtn) stopBtn.hidden = false;
  // una velocità sola, svelta ma non affannata
  const velocita = voceSesso === "m" ? 1.11 : 1.16;
  const ctx = ctxAudio();
  if (ctx) {
    try { if (ctx.state !== "running") await ctx.resume(); } catch {}
    const grezzo = ctx.state === "running" ? await bufferDi(url, ctx) : null;
    const buf = grezzo ? senzaSilenzi(grezzo, ctx) : null;
    if (buf && token === voceToken && !voceZitta) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      // se la voce è quella di Google e serve maschile, abbasso il tono con il detune:
      // è come rallentare il nastro, quindi il timbro resta naturale (niente ronzio)
      const robot = voceTimbro.get(url) === "robot" && voceSesso === "m";
      const fattore = robot ? Math.pow(2, -250 / 1200) : velocita;
      if (robot) {
        src.playbackRate.value = 1;
        try { src.detune.value = -250; } catch {}
      } else {
        src.playbackRate.value = velocita;
      }
      src.connect(ctx.destination);
      // parte esattamente quando finisce il pezzo prima: nessun buco, nessun salto
      // se il pezzo prima è già finito (rete lenta) non lo faccio partire a metà
    const quando = voceFine && voceFine > ctx.currentTime ? voceFine + 0.05 : ctx.currentTime + 0.03;
    const inizio = quando;
      voceFine = inizio + (buf.duration || 0) / fattore;
      voceFonti.add(src);
      src.onended = () => voceFonti.delete(src);
      voceAudio = { pause: () => { try { src.onended = null; src.stop(); } catch {} } };
      src.start(inizio);
      return;
    }
  }
  await playVoceElemento(url, token, velocita);
}

// ogni pezzo arriva con un pezzetto di silenzio in testa e in coda: incollati
// facevano degli scalini fastidiosi. Lo taglio e lascio solo un respiro breve.
const vocePulita = new Map();

function senzaSilenzi(buf, ctx) {
  if (!buf || vocePulita.has(buf)) return vocePulita.get(buf) || buf;
  try {
    const canali = [];
    for (let c = 0; c < buf.numberOfChannels; c++) canali.push(buf.getChannelData(c));
    const soglia = 0.012;
    const forte = (i) => canali.some((ch) => Math.abs(ch[i] || 0) > soglia);
    let primo = 0;
    while (primo < canali[0].length && !forte(primo)) primo += 2;
    let ultimo = canali[0].length - 1;
    while (ultimo > 0 && !forte(ultimo)) ultimo -= 2;
    // lascio un filo di respiro ai due bordi: tagliando troppo vicino alla
    // prima consonante la parola sembrava mozzata
    const inizio = Math.max(0, primo - buf.sampleRate * 0.03);
    const fine = Math.min(canali[0].length, ultimo + buf.sampleRate * 0.06);
    if (fine - inizio < buf.sampleRate * 0.06) {
      vocePulita.set(buf, buf);
      return buf;
    }
    const out = ctx.createBuffer(buf.numberOfChannels, Math.floor(fine - inizio), buf.sampleRate);
    for (let c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(canali[c].subarray(Math.floor(inizio), Math.floor(fine)), c);
    // 8 millesimi di dissolvenza ai due bordi: senza, al taglio si sente un tic
    const sfuma = Math.min(Math.floor(buf.sampleRate * 0.014), Math.floor(out.length / 8));
    for (let c = 0; c < out.numberOfChannels; c++) {
      const dati = out.getChannelData(c);
      for (let i = 0; i < sfuma; i++) {
        const k = i / sfuma;
        dati[i] *= k;
        dati[dati.length - 1 - i] *= k;
      }
    }
    if (vocePulita.size > 40) vocePulita.clear();
    vocePulita.set(buf, out);
    return out;
  } catch {
    return buf;
  }
}

// aspetta che la coda finisca davvero (serve per nascondere "ferma" al momento giusto)
async function attesaVoceFine(token) {
  const ctx = audioCtx;
  if (!ctx) return;
  const scadenza = Date.now() + 90000;
  while (token === voceToken && !voceZitta && ctx.currentTime < (voceFine || 0) - 0.05 && Date.now() < scadenza) {
    await attesa(120);
  }
}

// ---------- la voce: una sola sessione, poche richieste, niente voce del telefono ----------
// la voce gratuita di Google regge circa tre richieste al minuto per modello:
// quindi una risposta si legge in DUE richieste (prima frase, poi il resto), mai frase per frase.
let voceSess = null;

const attesa = (ms) => new Promise((r) => setTimeout(r, ms));

async function prendiVoce(testo, prima) {
  const chiave = lang + "|" + voceSesso + "|" + testo;
  const preso = voceCache.get(chiave);
  if (preso) return preso;
  for (let tentativo = 0; tentativo < 2; tentativo++) {
    try {
      const r2 = await api("/speak", { method: "POST", body: JSON.stringify({ text: testo, lang, device, quota: prima, voice: voceSesso }) });
      if (r2.audio) {
        const bytes = Uint8Array.from(atob(r2.audio), (c) => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: r2.mime || "audio/wav" }));
        if (voceCache.size > 40) voceCache.clear();
        voceCache.set(chiave, url);
        voceTimbro.set(url, r2.timbro || "");
        voceByte.set(url, bytes);
        return url;
      }
    } catch (e) {
      // quota finita: insistere non serve, meglio stare zitti che far parlare il telefono
      if (e && e.status === 429) return null;
    }
    await attesa(tentativo === 0 ? 250 : 600);
    if (testo && voceToken === (voceSess && voceSess.token)) { /* riprovo sulla stessa sessione */ }
  }
  return null;
}

// quando un pezzo non arriva in tempo, la voce del telefono prende il posto
// di quello che manca: meglio un timbro diverso che un silenzio in mezzo alla frase
function parlaConTelefono(testo) {
  return new Promise((res) => {
    try {
      if (!("speechSynthesis" in window)) return res();
      const u = new SpeechSynthesisUtterance(String(testo || ""));
      u.lang = lang === "en" ? "en-GB" : lang === "es" ? "es-ES" : lang === "pt" ? "pt-PT" : "it-IT";
      u.rate = 1.0;
      u.pitch = 1.0;
      const voci = speechSynthesis.getVoices() || [];
      const fem = voci.find((v) => (FEMALE_NAMES[lang] || FEMALE_NAMES.it).some((n) => String(v.name).toLowerCase().includes(n)));
      if (fem) u.voice = fem;
      let finito = false;
      const chiudi = () => { if (!finito) { finito = true; clearTimeout(guardia); res(); } };
      const guardia = setTimeout(chiudi, 20000);
      u.onend = chiudi;
      u.onerror = chiudi;
      speechSynthesis.speak(u);
    } catch {
      res();
    }
  });
}

function voceNuova(onEnd) {
  stopVoceSilenzioso();
  voceToken++;
  const s = { token: voceToken, pezzi: [], letti: 0, pronti: 0, fine: false, onEnd, pompa: null, aria: false };
  voceSess = s;
  return s;
}

function voceAccoda(s, testo, prima) {
  const pulito = testoPerVoce(testo);
  if (!pulito) return;
  const ultimo = s.pezzi.length ? s.pezzi[s.pezzi.length - 1].testo : "";
  if (ultimo && (ultimo === pulito || ultimo.endsWith(pulito))) return;
  // pezzi da un paio di frasi: ognuno è pronto mentre il precedente suona,
  // così la voce non si ferma ad aspettare (e il server unisce comunque le parti lunghe)
  // il primo pezzo breve (la voce parte subito), quelli dopo lunghi: meno viaggi,
  // meno attese in mezzo alle frasi. Il server unisce comunque le parti.
  const frasi = frasiDi(pulito);
  let cur = "";
  const chiudi = () => {
    if (cur) { s.pezzi.push({ testo: cur, url: null }); cur = ""; }
  };
  for (const f of frasi) {
    const primo = s.pezzi.length === 0;
    // ogni pezzo resta sotto i 195 caratteri che Google legge in una volta:
    // così non taglia mai una frase a metà e la punteggiatura resta intera
    const limite = primo ? 200 : 190;
    if (cur && (cur + " " + f).length > limite) { chiudi(); cur = f; }
    else cur = cur ? cur + " " + f : f;
    // la prima frase parte da sola appena è completa: la voce comincia prima
    // e la domanda si sente come domanda, non spezzata in parole
    if (primo) chiudi();
  }
  chiudi();
}

function voceAvvia(s) {
  if (s.token !== voceToken) return Promise.resolve();
  if (!s.pompa) s.pompa = pompaVoce(s);
  return s.pompa;
}

async function pompaVoce(s) {
  const scarica = (i) => {
    const p = s.pezzi[i];
    if (!p) return Promise.resolve(null);
    if (!p.url) p.url = prendiVoce(p.testo, i === 0).catch(() => null);
    return p.url;
  };
  while (s.token === voceToken && !voceZitta) {
    // tengo già pronta la frase dopo: quando finisce una, la successiva parte subito
    for (let k = s.pronti; k < s.pezzi.length && k < s.letti + 2; k++) {
      scarica(k)
        .then((u) => {
          if (!u) return;
          const c = ctxAudio();
          if (c) bufferDi(u, c).catch(() => {});
        })
        .catch(() => {});
    }
    s.pronti = Math.min(s.pezzi.length, s.letti + 2);
    if (s.letti < s.pezzi.length) {
      const url = await scarica(s.letti);
      if (s.token !== voceToken) return;
      if (url) await playVoce(url, s.token);
      else if (s.token === voceToken && !voceZitta) {
        // la voce del telefono parla fuori dalla coda: azzero il conto,
        // se no il pezzo dopo le partiva sopra (ed era quello l'impappinamento)
        voceFine = 0;
        await parlaConTelefono(s.pezzi[s.letti].testo);
        voceFine = 0;
      }
      s.letti++;
      continue;
    }
    if (s.fine) break;
    await attesa(90);
  }
  if (s.token !== voceToken) return;
  await attesaVoceFine(s.token);
  if (s.token !== voceToken) return;
  const b = $("#aiStop");
  if (b) b.hidden = true;
  if (typeof s.onEnd === "function") s.onEnd();
}

function stopVoceSilenzioso() {
  zittisciTutto();
}

// legge un testo già completo (risposte dalla memoria, risposte locali)
function parlaTesto(testo, onEnd) {
  if (!voiceOn || voceZitta) {
    if (typeof onEnd === "function") onEnd();
    return Promise.resolve();
  }
  const s = voceNuova(onEnd);
  voceAccoda(s, String(testo || ""), true);
  s.fine = true;
  return voceAvvia(s);
}

// prende il testo che arriva mentre scrive: prima frase corta subito, poi pezzi grandi
function voceInDiretta() {
  if (!voiceOn || voceZitta) {
    const muta = () => {};
    return { mangia: muta, chiudi: () => Promise.resolve(), sessione: null };
  }
  const s = voceNuova();
  let parlato = "";
  let aperta = false;
  const mangia = (parziale) => {
    const nuovo = parziale.slice(parlato.length);
    if (!nuovo) return;
    let pezzo = "";
    if (!aperta) {
      // la prima frase: appena arriva il PRIMO punto la voce parte (frase corta = voce prima)
      // la prima frase parte appena c'è un punto o una virgola: la voce buona arriva prima
      // soglie basse di proposito: la prima frase parte appena c'è qualcosa da dire,
      // così la voce comincia mentre il testo sta ancora arrivando
      // la prima frase si chiude quando c'è davvero una fine frase, non dopo
      // due parole: così la voce non parte a metà pensiero
      const punto = nuovo.search(/[.!?…](?=\s|$)/);
      if (punto >= 20) pezzo = nuovo.slice(0, punto + 1);
      else if (nuovo.length >= 70) {
        const virgola = nuovo.lastIndexOf(", ", 90);
        if (virgola >= 45) pezzo = nuovo.slice(0, virgola + 1);
      }
      if (!pezzo && nuovo.length >= 100) {
        const spazio = nuovo.lastIndexOf(" ", 110);
        if (spazio > 0) pezzo = nuovo.slice(0, spazio);
      }
    } else if (nuovo.length > 150) {
      // taglio dove la voce può fermarsi bene: prima un punto, poi una virgola,
      // dentro i 195 caratteri che Google legge in una volta. Mai a metà frase.
      const punto = nuovo.lastIndexOf(". ", 190);
      if (punto > 40) pezzo = nuovo.slice(0, punto + 1);
      else if (nuovo.length > 190) {
        const virgola = nuovo.lastIndexOf(", ", 190);
        if (virgola > 110) pezzo = nuovo.slice(0, virgola + 1);
        else {
          const spazio = nuovo.lastIndexOf(" ", 190);
          if (spazio > 0) pezzo = nuovo.slice(0, spazio);
        }
      }
    }
    if (!pezzo.trim()) return;
    parlato += pezzo;
    aperta = true;
    voceAccoda(s, pezzo, !s.pezzi.length);
    voceAvvia(s);
  };
  const chiudi = (finale) => {
    const testo = String(finale || "");
    let i = 0;
    while (i < parlato.length && i < testo.length && parlato[i] === testo[i]) i++;
    // se il taglio cade dentro una parola, salto la parola: meglio perderla che dirla due volte
    while (i > 0 && i < testo.length && !/\s/.test(testo[i - 1])) i++;
    const resto = testo.slice(i).trim();
    if (resto) voceAccoda(s, resto, !s.pezzi.length);
    else if (!aperta) voceAccoda(s, testo, true);
    s.fine = true;
    voceAvvia(s);
    return s.pompa || Promise.resolve();
  };
  return { mangia, chiudi, sessione: s };
}



/* ---------- modalità dialogo: botta e risposta a voce ---------- */
let dialogOn = false;
let dialogBusy = false;
let dialogAscolto = false;   // vero quando il pulsante è rosso e sta parlando lui
let dialogRecog = null;
let dialogTimer = null;
let dialogBuf = "";

function srSupported() {
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function dialogUi(state) {
  const b = $("#aiConvBtn");
  const st = $("#aiConvState");
  if (b) {
    b.classList.toggle("conv", dialogOn);
    // rosso = sta parlando lui, verde = la parola è della voce
    b.classList.toggle("on", dialogAscolto);
    b.setAttribute("aria-pressed", dialogAscolto ? "true" : "false");
    b.setAttribute("aria-label", dialogAscolto ? t("ai.convListening") : t("ai.convTurn"));
  }
  if (st) {
    st.textContent =
      state || (dialogOn ? (dialogAscolto ? t("ai.convListening") : t("ai.convTurn")) : t("ai.convStart"));
  }
}

function stopDialog() {
  dialogOn = false;
  dialogBusy = false;
  dialogAscolto = false;
  clearTimeout(dialogTimer);
  dialogTimer = null;
  try { dialogRecog?.abort?.(); } catch {}
  dialogRecog = null;
  try { speechSynthesis.cancel(); } catch {}
  const input = $("#aiInput");
  if (input) { input.placeholder = t("ai.ph"); input.value = ""; }
  dialogUi();
}

function startDialog() {
  if (!srSupported()) {
    // niente riconoscimento continuo: passo al modo "registra", che funziona lo stesso
    toast(t("ai.dialogNoSr"));
    setAiMode("registra");
    return;
  }
  dialogOn = true;
  dialogBusy = false;
  if (!voiceOn) {
    voiceOn = true;
    localStorage.setItem("fuori.voice", "1");
    renderVoice();
  }
  dialogUi(t("ai.dialogListen"));
  listenTurn();
}

function listenTurn() {
  if (!dialogOn || dialogBusy) return;
  voceZitta = false;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  try { dialogRecog?.abort?.(); } catch {}
  const r = new SR();
  dialogRecog = r;
  r.lang = LANG_TAG[lang] || "it-IT";
  r.interimResults = true;
  r.continuous = true;
  dialogBuf = "";
  dialogAscolto = true;
  const input = $("#aiInput");
  if (input) { input.value = ""; input.placeholder = t("ai.recording"); }
  dialogUi(t("ai.convListening"));

  r.onresult = (ev) => {
    let interim = "";
    let final = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const part = ev.results[i][0].transcript;
      if (ev.results[i].isFinal) final += part;
      else interim += part;
    }
    if (final) dialogBuf += final + " ";
    if (input) input.value = (dialogBuf + interim).trim().slice(0, 200);
    // aspetto una pausa vera prima di passare la parola: così non perdo la fine della frase
    clearTimeout(dialogTimer);
    dialogTimer = setTimeout(() => {
      if (dialogOn && dialogAscolto && !dialogBusy) finishTurn();
    }, 1200);
  };
  r.onerror = (ev) => {
    if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
      toastErr(t("ai.micDenied"));
      stopDialog();
    }
  };
  r.onend = () => {
    if (!dialogOn || dialogBusy || !dialogAscolto) return;
    // il telefono chiude il microfono dopo una pausa: riparto, non chiudo il turno
    setTimeout(() => {
      if (!dialogOn || dialogBusy || !dialogAscolto) return;
      try { r.start(); } catch { finishTurn(); }
    }, 150);
  };
  try { r.start(); } catch {}
}

// tocca il pulsante mentre è rosso: chiudo l'ascolto e passo la parola alla voce
function fermaTurno() {
  if (!dialogOn || dialogBusy) return;
  try { dialogRecog?.abort?.(); } catch {}
  dialogRecog = null;
  dialogAscolto = false;
  clearTimeout(dialogTimer);
  finishTurn();
}

async function finishTurn() {
  if (!dialogOn || dialogBusy) return;
  const text = (dialogBuf || $("#aiInput")?.value || "").trim();
  clearTimeout(dialogTimer);
  dialogTimer = null;
  dialogAscolto = false;
  if (!text) {
    dialogUi(t("ai.convTurn"));
    return;
  }
  if (/^(basta|stop|fine|chiudi|esci)(\s+(dialogo|conversazione))?$/i.test(text.replace(/[.!?]/g, "").trim())) {
    toast(t("ai.dialogStop"));
    stopDialog();
    return;
  }
  dialogBusy = true;
  dialogBuf = "";
  try { dialogRecog?.abort?.(); } catch {}
  dialogRecog = null;
  const input = $("#aiInput");
  if (input) { input.value = ""; input.placeholder = t("ai.ph"); }
  dialogUi(t("ai.dialogThink"));
  const esito = await dialogReply(text);
  if (!dialogOn) { dialogBusy = false; return; }
  dialogUi(t("ai.dialogSpeak"));
  esito.voce.then(() => {
    dialogBusy = false;
    if (!dialogOn) return;
    // ho finito di parlare: la parola torna a lui, che tocca il pulsante quando vuole
    dialogUi(t("ai.convTurn"));
  });
}

async function dialogReply(text) {
  aiBubble(text, "me");
  const local = aiAnswer(text);
  // i dati privati non escono dal telefono
  if (local.private) {
    aiBubble(local.text, "bot");
    return { testo: local.text, voce: Promise.resolve() };
  }
  if (local.text) {
    aiBubble(local.text, "bot");
    return { testo: local.text, voce: parlaTesto(local.text) };
  }
  const key = lang + "|" + text.toLowerCase();
  if (aiCache.has(key)) {
    const hit = aiCache.get(key);
    aiBubble(hit, "bot");
    return { testo: hit, voce: parlaTesto(hit) };
  }
  const bubble = aiBubble(t("ai.thinking"), "bot");
  bubble.classList.add("typing");
  const voce = voceInDiretta();
  try {
    const risposta = await askStreamed(text, aiHistory, (parziale) => {
      if (!parziale) return;
      bubble.classList.remove("typing");
      bubble.textContent = parziale;
      voce.mangia(parziale);
    });
    bubble.classList.remove("typing");
    if (risposta) {
      aiCache.set(key, risposta);
      if (aiCache.size > 80) aiCache.clear();
      bubble.textContent = risposta;
      aiHistory.push({ role: "user", text });
      aiHistory.push({ role: "bot", text: risposta });
      if (aiHistory.length > 20) aiHistory = aiHistory.slice(-20);
      return { testo: risposta, voce: voce.chiudi(risposta) };
    }
  } catch {
    /* qualcosa è andato storto: uso quello che so senza inventare */
  }
  bubble.classList.remove("typing");
  bubble.textContent = local.text || t("ai.busy");
  return { testo: bubble.textContent, voce: Promise.resolve() };
}

function renderVoice() {
  const b = $("#aiVoice");
  if (!b) return;
  b.classList.toggle("on", voiceOn);
  const label = $("#aiVoiceLabel");
  if (label) label.textContent = voiceOn ? t("ai.voiceOn") : t("ai.voice");
}

// le righe-istruzione (AZIONE=, NAVIGA=) non si leggono e non si dicono:
// sono ordini per l'app, non frasi da mostrare alla persona.
function senzaAzione(t) {
  let s = String(t || "");
  // via la riga con il JSON, anche se lo streaming l'ha tagliata a metà
  s = s.replace(/(?:^|\n)\s*(?:AZIONE|NAVIGA)\s*[=:]?\s*\{[\s\S]*$/gi, "\n");
  // via il resto del JSON rimasto appeso
  s = s.replace(/\{\s*"(?:tipo|evento)"[\s\S]*$/i, "");
  // via la parola da sola, se il modello la scrive senza JSON
  s = s.replace(/\b(?:AZIONE|NAVIGA)\b\s*[=:]?/gi, "");
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{2,}/g, "\n").trim();
}

function leggiAzione(t) {
  const m = /(?:AZIONE|NAVIGA)\s*[=:]\s*(\{[\s\S]*\})\s*$/im.exec(String(t || ""));
  if (!m) return null;
  try {
    const a = JSON.parse(m[1]);
    if (!a || typeof a !== "object") return null;
    if (String(a.tipo || "").toLowerCase() === "iscrivi") return null;
    if (!a.tipo && a.evento) return { tipo: "naviga", evento: a.evento };
    return a.tipo ? a : null;
  } catch {
    return null;
  }
}

// l'app esegue quello che l'assistente ha deciso di fare, poi mostra la conferma
async function eseguiAzione(azione) {
  const riga = aiBubble(t("ai.thinking"), "bot");
  riga.classList.add("typing");
  try {
    const r = await api("/azione", {
      method: "POST",
      body: JSON.stringify({ azione, device }),
    });
    riga.classList.remove("typing");
    // se l'azione non è riuscita, la persona deve sapere che tocca a lei
    riga.textContent = r.fatto || r.error || t("ai.busy");
    if (voiceOn) parlaTesto(riga.textContent);
    // navigatore: apro la scelta di mappe con il percorso verso l'evento
    if (r.percorso) openDirections(r.percorso);
  } catch (e) {
    riga.classList.remove("typing");
    riga.textContent = e?.data?.error || t("ai.busy");
  }
}

async function askAi(e) {
  if (e) e.preventDefault();
  voceZitta = false;
  const input = $("#aiInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  aiBubble(text, "me");

  const wasVoice = lastWasVoice;
  lastWasVoice = false;
  const tell = voiceOn || wasVoice;

  // per i saluti, le liste salvate e i dati privati rispondo subito, senza rete
  const local = aiAnswer(text);
  if (local.text) {
    aiBubble(local.text, "bot");
    if (tell) parlaTesto(local.text);
    return;
  }
  if (local.private) {
    aiBubble(local.text, "bot");
    return;
  }

  const key = lang + "|" + text.toLowerCase();
  if (aiCache.has(key)) {
    const gia = senzaAzione(aiCache.get(key));
    aiBubble(gia, "bot");
    if (tell) parlaTesto(gia);
    return;
  }
  const localSolo = Boolean(local.events && local.events.length);
  if (localSolo) {
    aiBubble(local.text, "bot", local.events);
    if (tell) parlaTesto(local.text);
    return;
  }

  const bubble = aiBubble(t("ai.thinking"), "bot");
  bubble.classList.add("typing");
  const voce = voceInDiretta();
  try {
    const risposta = await askStreamed(text, aiHistory, (parziale) => {
      if (!parziale) return;
      const visibile = paroleGiuste(senzaAzione(parziale));
      bubble.classList.remove("typing");
      if (visibile) bubble.textContent = visibile;
      if (tell) voce.mangia(visibile);
    });
    bubble.classList.remove("typing");
    if (risposta) {
      const pulita = domandeGiuste(paroleGiuste(senzaAzione(risposta))) || bubble.textContent;
      const azione = leggiAzione(risposta);
      aiCache.set(key, pulita);
      if (aiCache.size > 80) aiCache.clear();
      bubble.textContent = pulita;
      if (tell) voce.chiudi(pulita);
      aiHistory.push({ role: "user", text });
      aiHistory.push({ role: "bot", text: pulita });
      if (aiHistory.length > 20) aiHistory = aiHistory.slice(-20);
      if (azione) eseguiAzione(azione);
    }
  } catch (err) {
    bubble.classList.remove("typing");
    if (!bubble.textContent || bubble.textContent === t("ai.thinking")) bubble.textContent = local.text || t("ai.busy");
    if (err.status === 429) toast(err.data?.error || t("ai.busy"));
    if (tell) parlaTesto(bubble.textContent);
  }
}

function renderSuggest() {
  const box = $("#aiSuggest");
  if (!box) return;
  const items = ["ai.tonight", "ai.tomorrow", "ai.weekend"];
  box.innerHTML = items.map((k) => `<button data-suggest="${esc(t(k))}">${esc(t(k))}</button>`).join("");
  box.querySelectorAll("[data-suggest]").forEach((b) => {
    b.onclick = () => { $("#aiInput").value = b.dataset.suggest; askAi(); };
  });
}

/* ---------- notifiche ---------- */
function askPushSoon(force) {
  if (!("Notification" in window) || !("serviceWorker" in navigator)) return;
  // solo dopo la registrazione o dentro l'app installata: prima non chiediamo niente
  if (!person && !isInstalled()) return;
  if (Notification.permission !== "default") return;
  if (!force && sessionStorage.getItem("fuori.pushAsked")) return;
  sessionStorage.setItem("fuori.pushAsked", "1");
  setTimeout(showPushCard, force ? 600 : 3000);
}

function showPushCard() {
  if (Notification.permission !== "default" || document.getElementById("pushCard")) return;
  const el = document.createElement("div");
  el.className = "veil";
  el.id = "pushCard";
  el.innerHTML = `<div class="vcard"><h3>${esc(t("push.title"))}</h3><p>${esc(t("push.sub"))}</p>
    <div class="cookie-actions"><button class="btn ghost sm" data-no>${esc(t("push.no"))}</button>
    <button class="btn primary sm" data-yes>${esc(t("push.yes"))}</button></div></div>`;
  document.body.appendChild(el);
  el.querySelector("[data-no]").onclick = () => el.remove();
  el.querySelector("[data-yes]").onclick = async () => { el.remove(); await enablePush(); };
}

function urlB64(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

// se il telefono ha già dato il permesso, l'avviso si attiva da solo
// dentro l'app-guscio le notifiche le firma Chrome: spiego come averle a nome FUORI
function inTwa() {
  try {
    return String(document.referrer || "").startsWith("android-app://");
  } catch {
    return false;
  }
}

function paintTwaBar() {
  const bar = $("#twaBar");
  if (!bar) return;
  const off = localStorage.getItem("fuori.twaBarOff") === "1";
  bar.hidden = !inTwa() || off;
  const no = $("#twaBarNo");
  if (no)
    no.onclick = () => {
      localStorage.setItem("fuori.twaBarOff", "1");
      bar.hidden = true;
    };
  const btn = $("#twaBarBtn");
  if (btn) btn.onclick = () => show("howInstall");
  const go = $("#twaOpen");
  if (go) go.onclick = () => { window.open("https://fuori.fuori-catania.workers.dev/", "_blank"); };
}

async function ensurePush() {
  if (!("Notification" in window) || !("serviceWorker" in navigator)) return;
  if (Notification.permission !== "granted") return;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    // l'iscrizione scaduta o col permesso tolto non riceve piu': la rifaccio
    if (sub && sub.expirationTime && sub.expirationTime < Date.now()) {
      try { await sub.unsubscribe(); } catch {}
      sub = null;
    }
    if (!sub) {
      const { key } = await api("/push/key");
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(key) });
    }
    await api("/push/subscribe", { method: "POST", body: JSON.stringify({ subscription: sub, device, email: person?.email || "" }) });
    paintPushBar();
  } catch {}
}

// la barra che ricorda di accendere gli avvisi, finché non sono accesi
async function paintPushBar() {
  const bar = $("#pushAsk");
  if (!bar) return;
  if (!("Notification" in window) || !("serviceWorker" in navigator)) {
    bar.hidden = true;
    return;
  }
  if (sessionStorage.getItem("fuori.pushBarOff") === "1") {
    bar.hidden = true;
    return;
  }
  let needs = Notification.permission !== "granted";
  if (!needs) {
    try {
      const reg = await navigator.serviceWorker.ready;
      needs = !(await reg.pushManager.getSubscription());
    } catch {
      needs = true;
    }
  }
  bar.hidden = !needs;
}

function apriPushHelp() {
  const box = $("#pushHelpState");
  if (box) {
    box.innerHTML = `<ol class="passi"><li>${esc(t("pushHelp.step1"))}</li><li>${esc(t("pushHelp.step2"))}</li><li>${esc(t("pushHelp.step3"))}</li></ol>
      <p class="muted">${esc(t("pushHelp.anonimo"))}</p>
      <p class="muted" id="pushServer"></p>`;
  }
  show("pushHelp");
  // lo stato del server: così si capisce se il problema è qui o sul telefono
  (async () => {
    const el = $("#pushServer");
    if (!el) return;
    try {
      const s = await api(`/push/state?device=${encodeURIComponent(device)}${person?.email ? "&email=" + encodeURIComponent(person.email) : ""}`);
      el.textContent = s.subs
        ? `Sul server risultano ${s.subs} avvisi attivi per te${s.stato?.fail ? ", l'ultimo invio non è andato a buon fine" : s.stato?.ok ? ", l'ultimo invio è stato accettato" : ""}.`
        : "Sul server non c'è ancora nessun avviso attivo per questo telefono: tocca Accendi.";
    } catch {}
  })();
}

// riprova dopo che ha toccato le impostazioni: se ora è concesso, iscrivo subito
async function riprovaPush() {
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "denied") { toast(t("pushHelp.ancora")); return; }
  hide("pushHelp");
  enablePush();
}

async function enablePush() {
  if (!("serviceWorker" in navigator) || typeof Notification === "undefined") { toast(t("push.blocked")); return; }
  if (Notification.permission === "denied") { apriPushHelp(); return; }
  const perm = await Notification.requestPermission();
  if (perm === "denied") { apriPushHelp(); return; }
  if (perm !== "granted") return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const { key } = await api("/push/key");
    let existing = await reg.pushManager.getSubscription();
    if (existing && existing.expirationTime && existing.expirationTime < Date.now()) {
      try { await existing.unsubscribe(); } catch {}
      existing = null;
    }
    const sub = existing || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(key) }));
    await api("/push/subscribe", { method: "POST", body: JSON.stringify({ subscription: sub, device, email: person?.email || "" }) });
    toast(t("push.ok"));
    paintPushBar();
  } catch {
    toastErr(t("push.blocked"));
  }
}

/* ---------- suggerimenti mentre scrivi ---------- */
let suggItems = [];
let suggIdx = -1;
let suggTimer = null;

function hideSugg() {
  const box = $("#citySugg");
  if (box) {
    box.hidden = true;
    box.innerHTML = "";
  }
  suggItems = [];
  suggIdx = -1;
  const inp = $("#cityInput");
  if (inp) inp.setAttribute("aria-expanded", "false");
}

async function citySuggest(term) {
  const box = $("#citySugg");
  if (!box) return;
  const q = term.trim();
  if (q.length < 2) return hideSugg();
  try {
    const near = myPos ? `&near=${myPos.lat},${myPos.lng}` : "";
    const r = await api("/geo?q=" + encodeURIComponent(q) + near);
    const seenName = new Set();
    const list = (r.results || [])
      .filter((x) => {
        const k = String(x.name || "").toLowerCase();
        if (!k || seenName.has(k)) return false;
        seenName.add(k);
        return true;
      })
      .slice(0, 6);
    if (!list.length || !q) return hideSugg();
    suggItems = list;
    suggIdx = -1;
    box.innerHTML = list
      .map(
        (x, i) =>
          `<button type="button" class="sugg-i" role="option" data-i="${i}"><b>${esc(x.name)}</b><span>${esc(x.full || "")}</span></button>`
      )
      .join("");
    box.hidden = false;
    box.querySelectorAll(".sugg-i").forEach((b) => {
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.onclick = () => pickSugg(Number(b.dataset.i));
    });
    const inp = $("#cityInput");
    if (inp) inp.setAttribute("aria-expanded", "true");
  } catch {
    hideSugg();
  }
}

function pickSugg(i) {
  const x = suggItems[i];
  if (!x) return;
  // nel campo resta il nome secco del paese, non tutta la filastrocca
  const name = String(x.name || "").split(",")[0].trim().slice(0, 40) || String(x.name || "").slice(0, 40);
  const inp = $("#cityInput");
  if (inp) inp.value = name;
  cityTerm = name;
  localStorage.setItem("fuori.city", cityTerm);
  cityCenter = { lat: x.lat, lng: x.lng };
  hideSugg();
  updateRadiusLabel();
  renderList();
}

function moveSugg(step) {
  const box = $("#citySugg");
  if (!box || box.hidden || !suggItems.length) return;
  suggIdx = (suggIdx + step + suggItems.length) % suggItems.length;
  box.querySelectorAll(".sugg-i").forEach((b, i) => b.classList.toggle("on", i === suggIdx));
  const cur = box.querySelectorAll(".sugg-i")[suggIdx];
  if (cur) cur.scrollIntoView({ block: "nearest" });
}

/* ---------- verifica del viso ---------- */
let vStream = null;
let vShotData = "";

function openVerify() {
  if (!person?.email) {
    toastErr(t("verify.needLogin"));
    return;
  }
  show("verify");
  paintVerify();
}

function paintVerify() {
  const st = $("#vState");
  const open = $("#vOpen");
  const send = $("#vDone");
  if (!st || !open || !send) return;
  if (person?.verified) {
    st.textContent = t("verify.already");
    open.hidden = true;
    send.hidden = true;
    return;
  }
  open.hidden = false;
  st.textContent = person?.facePending ? t("verify.pending") : t("verify.hint");
  if (!vShotData) {
    open.textContent = t("verify.open");
    send.hidden = true;
  }
}

async function vStart() {
  const open = $("#vOpen");
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toastErr(t("verify.noCamFound"));
    hide("verify");
    show("perms");
    return false;
  }
  if (open) open.disabled = true;
  let stream = null;
  let err = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 720 } }, audio: false });
  } catch (e1) {
    // alcuni telefoni rifiutano "facingMode": riprovo senza vincoli
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    } catch (e2) {
      err = e2 || e1;
    }
  }
  if (open) open.disabled = false;
  if (!stream) {
    const name = (err && err.name) || "";
    const blocked = name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError";
    // per la verifica serve un selfie scattato adesso: la galleria non vale
    const st = $("#vState");
    if (st)
      st.textContent = blocked
        ? "La fotocamera è bloccata dal telefono. Per la verifica serve un selfie scattato adesso: riaprila qui sotto e riprova."
        : "Questo telefono non mi dà la fotocamera, e senza selfie dal vivo non posso verificarti.";
    if (blocked) openPermFix("cam");
    return false;
  }
  vStream = stream;
  const video = $("#vVideo");
  const img = $("#vShot");
  if (!video) return;
  img.hidden = true;
  video.hidden = false;
  video.muted = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("autoplay", "");
  video.srcObject = vStream;
  video.play().catch(() => {});
  if (open) {
    open.textContent = t("verify.take");
    open.onclick = vCapture;
  }
  return true;
}

function vStopCam() {
  if (vStream) vStream.getTracks().forEach((tr) => tr.stop());
  vStream = null;
  const video = $("#vVideo");
  if (video) video.hidden = true;
}

function vCapture() {
  const video = $("#vVideo");
  if (!video || !video.videoWidth) return;
  const w = Math.min(560, video.videoWidth);
  const h = Math.round((video.videoHeight / video.videoWidth) * w);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(video, 0, 0, w, h);
  vShotData = canvas.toDataURL("image/jpeg", 0.82);
  vStopCam();
  const img = $("#vShot");
  img.src = vShotData;
  img.hidden = false;
  const open = $("#vOpen");
  open.textContent = t("verify.again");
  open.onclick = vStart;
  $("#vDone").hidden = false;
}

async function vSend() {
  if (!vShotData || !person?.email) return;
  const btn = $("#vDone");
  btn.disabled = true;
  btn.textContent = t("verify.sending");
  try {
    const r = await api("/verify/face", { method: "POST", body: JSON.stringify({ email: person.email, data: vShotData, device }) });
    vShotData = "";
    if (r && r.verified) {
      person.verified = true;
      person.facePending = false;
      save(K.person, person);
      vStopCam();
      hide("verify");
      paintOwner();
      renderProfileBadges();
      toast(t("verify.already"));
    } else {
      person.facePending = true;
      save(K.person, person);
      toast(t("verify.sent"));
    }
    await refreshMe();
    paintVerify();
    renderProfileBadges();
  } catch (e) {
    const msg = e?.data?.error || t("toast.error");
    // niente vicolo cieco: il messaggio resta scritto e si può rifare subito
    vShotData = "";
    vStopCam();
    const shot = $("#vShot");
    if (shot) shot.hidden = true;
    const st = $("#vState");
    if (st) st.textContent = msg;
    const openBtn = $("#vOpen");
    if (openBtn) {
      openBtn.textContent = t("verify.open");
      openBtn.onclick = vStart;
    }
    const sendBtn = $("#vDone");
    if (sendBtn) sendBtn.hidden = true;
    toastErr(msg);
    await refreshMe();
    paintVerify();
  } finally {
    btn.disabled = false;
    btn.textContent = t("verify.send");
  }
}

async function vFromFile(file) {
  const st = $("#vState");
  try {
    if (st) st.textContent = t("verify.reading");
    vShotData = await shrink(file, 900, 0.85);
    const img = $("#vShot");
    if (img) { img.src = vShotData; img.hidden = false; }
    const open = $("#vOpen");
    if (open) { open.textContent = t("verify.open"); open.onclick = vStart; }
    const send = $("#vDone");
    if (send) send.hidden = false;
    if (st) st.textContent = t("verify.check");
  } catch {
    if (st) st.textContent = t("verify.hint");
    toastErr(t("prof.photoErr"));
  }
}

/* ---------- i numeri (solo padrone) ---------- */
const OWNER_TOKEN_KEY = "fuori.ownerToken";

function statBar(label, n, max) {
  const w = max > 0 ? Math.max(2, Math.round((n / max) * 100)) : 0;
  return `<div class="stat-bar"><span>${esc(label)}</span><i style="width:${w}%"></i><b>${n}</b></div>`;
}

function statBlock(title, rows) {
  const list = (rows || []).filter((r) => r && r.n > 0);
  if (!list.length) return "";
  const max = Math.max(...list.map((r) => r.n));
  return `<div class="stat-block"><h3>${esc(title)}</h3>${list.map((r) => statBar(r.k, r.n, max)).join("")}</div>`;
}

let fotoRows = null;

async function loadFotoDaVerificare() {
  const btn = $("#fotoDaVerificare");
  if (!btn) return;
  try {
    const token = localStorage.getItem(OWNER_TOKEN_KEY) || "";
    const res = await fetch("/api/owner/photos?token=" + encodeURIComponent(token), { cache: "no-store" });
    if (!res.ok) throw new Error("no");
    const data = await res.json();
    fotoRows = data.photos || [];
  } catch {
    fotoRows = null;
    return;
  }
  if (!fotoRows.length) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  btn.textContent = `Foto da verificare (${fotoRows.length})`;
}

// "iscritto adesso", "iscritto da 3 ore", "iscritto da 5 giorni"
function iscrittoDa(ts) {
  const m = Math.floor((Date.now() - Number(ts || 0)) / 60000);
  if (m < 60) return "iscritto adesso";
  const ore = Math.floor(m / 60);
  if (ore < 24) return `iscritto da ${ore} ${ore === 1 ? "ora" : "ore"}`;
  const g = Math.floor(ore / 24);
  return `iscritto da ${g} ${g === 1 ? "giorno" : "giorni"}`;
}

function renderFoto() {
  const box = $("#fotoList");
  if (!box) return;
  if (!fotoRows || !fotoRows.length) {
    box.innerHTML = `<p class="muted">Niente da verificare: sono tutte a posto.</p>`;
    return;
  }
  box.innerHTML = fotoRows
    .map(
      (f) => `<figure class="foto-item">
        <img src="${esc(f.fotoUrl)}" alt="${esc(f.nome)}" loading="lazy" decoding="async">
        <figcaption><b>${esc(f.nome)}</b><span>${esc(f.statoTesto)}</span>${
          f.da ? `<span class="foto-da">${esc(iscrittoDa(f.da))}</span>` : ""
        }</figcaption>
        ${f.selfieUrl ? `<a class="foto-selfie" href="${esc(f.selfieUrl)}" target="_blank" rel="noopener">vedi il selfie</a>` : ""}
      </figure>`
    )
    .join("");
}

function openFoto() {
  renderFoto();
  // non chiudo i numeri: il pannello foto si apre sopra, e "indietro" torna ai numeri
  show("foto");
}

function renderStats(d) {
  const p = d.periodo || {}, o = d.oggi || {}, t = d.totali || {}, com = d.community || {};
  const own = $("#statsOwn");
  if (own) own.textContent = "";
  const nf = (n) => (Number(n) || 0).toLocaleString("it-IT");
  const pc = (n) => (Number(n) || 0) + "%";
  const dec = (n) => String(Number(n) || 0).replace(".", ",");

  // ---- adesso: cinque numeri che si muovono mentre guardi
  const ad = com.adesso || {};
  const boxAdesso = $("#statsAdesso");
  if (boxAdesso) {
    const vivo = Number(ad.online) > 0;
    const cella = (label, v, sub, caldo) =>
      `<div class="now${caldo ? " caldo" : ""}"><b>${nf(v)}</b><span>${esc(label)}</span><i>${esc(sub)}</i></div>`;
    boxAdesso.innerHTML =
      `<div class="now-lab"><span class="pulse${vivo ? "" : " spento"}" aria-hidden="true"></span>${vivo ? "Adesso, nella community" : "Nessuno dentro in questo momento"}</div>` +
      `<div class="now-grid">` +
      cella("online", ad.online, "persone nell'app", vivo) +
      cella("eventi in corso", ad.inCorso, "iniziati da poco") +
      cella("prossime 24 ore", ad.prossime24, "eventi in programma") +
      cella("nuovi oggi", ad.oggiNuovi, "persone iscritte") +
      cella("messaggi nell'ora", ad.msgOra, "nelle chat dei gruppi") +
      `</div>`;
  }

  // ---- le frasi che leggono i numeri al posto tuo: solo sulla community
  const let_ = $("#statsLetture");
  if (let_) {
    const ins = [];
    const cat = (com.categorie || []).slice().sort((a, b) => b.n - a.n)[0];
    const citta = (com.citta || []).slice().sort((a, b) => b.n - a.n)[0];
    const giorno = (com.giorni || []).slice().sort((a, b) => b.n - a.n)[0];
    const fascia = (com.fasce || []).slice().sort((a, b) => b.n - a.n)[0];
    const c = com.crescita || {};
    if (cat && cat.n) ins.push({ v: pc(cat.perc), t: `degli eventi è ${cat.k}`, s: `${nf(cat.n)} ${Number(cat.n) === 1 ? "evento" : "eventi"} su ${nf(com.eventi)}` });
    if (citta && citta.n) ins.push({ v: pc(citta.perc), t: `degli eventi è a ${citta.k}`, s: `la zona più attiva` });
    if (giorno && giorno.n) ins.push({ v: giorno.k, t: `è il giorno con più eventi`, s: `${pc(giorno.perc)} del totale` });
    if (fascia && fascia.n) ins.push({ v: fascia.k, t: `è la fascia preferita`, s: `${pc(fascia.perc)} degli eventi` });
    if (Number(com.riempimento) > 0) ins.push({ v: pc(com.riempimento), t: `dei posti è occupato`, s: `sugli eventi in programma` });
    if (Number(com.ritornoPersone) > 0) ins.push({ v: pc(com.ritornoPersone), t: `torna a un secondo evento`, s: `persone che non si fermano alla prima volta` });
    if (Number(com.etaMedia) > 0) ins.push({ v: com.etaMedia, t: `anni è l'età media`, s: `di chi ha un profilo` });
    if (c.eventi && Number(c.eventi.ora) > 0) ins.push({ v: (c.eventi.perc > 0 ? "+" : "") + pc(c.eventi.perc), t: `eventi questa settimana`, s: `${nf(c.eventi.ora)} contro ${nf(c.eventi.prima)} la settimana prima` });
    if (let_) {
      let_.innerHTML = ins.length
        ? `<div class="stat-block"><h3>Cosa dicono i numeri</h3><div class="insight-grid">${ins
            .slice(0, 6)
            .map((x) => `<div class="insight"><b>${esc(String(x.v))}</b><span>${esc(x.t)}</span><i>${esc(x.s)}</i></div>`)
            .join("")}</div></div>`
        : `<div class="stat-block"><h3>Cosa dicono i numeri</h3><p class="muted">Appena ci saranno eventi e persone, qui trovi le frasi che leggono i numeri.</p></div>`;
    }
  }

  // ---- i numeri, compatti
  const nums = $("#statsNums");
  if (nums) {
    const n = (label, v, sub) =>
      `<div class="num"><b>${v}</b><span>${esc(label)}</span>${sub ? `<i>${esc(sub)}</i>` : ""}</div>`;
    const c = com.crescita || {};
    nums.innerHTML = [
      n("persone nella community", nf(com.persone), "profili veri, senza di te"),
      n("eventi creati in tutto", nf(com.eventi)),
      n("eventi in programma", nf(com.inProgramma)),
      n("partecipazioni", nf(com.partecipazioni)),
      n("persone per evento", dec(com.mediaPartecipanti), "media"),
      n("persone che tornano", pc(com.ritornoPersone), "a più di un evento"),
      n("posti occupati", pc(com.riempimento), "sugli eventi in arrivo"),
      n("ricordi", nf(com.ricordi && com.ricordi.tot), `${nf(com.ricordi && com.ricordi.conFoto)} con foto`),
      n("messaggi nelle chat", nf(com.chat && com.chat.messaggi), `${nf(com.chat && com.chat.eventi)} eventi con chat`),
      n("nuovi questa settimana", nf(c.nuovi && c.nuovi.ora), c.nuovi && c.nuovi.ora ? `${c.nuovi.perc > 0 ? "+" : ""}${pc(c.nuovi.perc)} sulla precedente` : ""),
      n("voto medio dei ricordi", com.ricordi && com.ricordi.votoMedio ? dec(com.ricordi.votoMedio) + " / 5" : "–", com.ricordi && com.ricordi.tot ? `${nf(com.ricordi.tot)} ricordi` : ""),
      n("età media", com.etaMedia ? nf(com.etaMedia) + " anni" : "–"),
    ].join("");
  }

  // ---- per voce, con la percentuale sul totale
  const bloccoPerc = (titolo, righe, nota) => {
    const tot = (righe || []).reduce((a, r) => a + (Number(r.n) || 0), 0);
    if (!righe || !righe.length) return `<div class="stat-block"><h3>${esc(titolo)}</h3><p class="muted">Ancora niente da contare.</p></div>`;
    return `<div class="stat-block"><h3>${esc(titolo)}</h3>${righe
      .map((r) => {
        const perc = Number.isFinite(Number(r.perc)) ? Number(r.perc) : tot ? Math.round(((Number(r.n) || 0) / tot) * 100) : 0;
        return `<div class="stat-riga"><span class="sr-k">${esc(r.k)}</span><span class="sr-n">${r.n} · ${perc}%</span><i style="width:${perc > 0 ? Math.max(2, perc) : 0}%"></i></div>`;
      })
      .join("")}${nota ? `<p class="muted">${esc(nota)}</p>` : ""}</div>`;
  };

  // ---- il grafico giorno per giorno
  const serie = $("#statsSerie");
  if (serie) {
    const rows = d.serie || [];
    const max = Math.max(1, ...rows.map((r) => r.unici));
    const bars = rows
      .map((r) => `<i style="height:${Math.max(3, Math.round((r.unici / max) * 100))}%" title="${r.d}: ${r.unici} persone"></i>`)
      .join("");
    const first = rows[0]?.d ? rows[0].d.slice(5).split("-").reverse().join("/") : "";
    const last = rows.length ? rows[rows.length - 1].d.slice(5).split("-").reverse().join("/") : "";
    serie.innerHTML = `<div class="stat-block"><h3>Persone diverse, giorno per giorno</h3><div class="spark">${bars}</div><div class="spark-x"><span>${first}</span><span>${last}</span></div></div>`;
  }

  // ---- andamento nel tempo
  const trend = $("#statsTrend");
  if (trend) {
    const a = d.andamento || {};
    const nomeMese = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];
    const blocchi = [
      { t: "Settimana", punti: a.settimana || [], etichetta: (k) => `${k.slice(8, 10)}/${k.slice(5, 7)}`, nota: "ultimi 7 giorni" },
      { t: "Mesi", punti: a.mesi || [], etichetta: (k) => `${nomeMese[Number(k.slice(5, 7)) - 1] || k} ${k.slice(2, 4)}`, nota: "ultimi 12 mesi" },
      { t: "Anni", punti: a.anni || [], etichetta: (k) => k, nota: "dal primo anno a oggi" },
    ];
    const disegni = blocchi.map((b) => {
      const vals = b.punti.map((x) => Number(x.n) || 0);
      if (!vals.length) return "";
      const disegno = vals.length > 1 ? vals : [vals[0], vals[0]];
      const W = 100, H = 30;
      const max = Math.max(1, ...disegno), min = Math.min(...disegno);
      const scala = Math.max(1, max - min);
      const px = (i) => (i / (disegno.length - 1)) * W;
      const py = (v) => H - ((v - min) / scala) * (H - 4) - 2;
      const linea = disegno.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(" ");
      const ultimo = vals[vals.length - 1];
      const prima = vals.length > 1 ? vals[vals.length - 2] : null;
      const perc = prima ? Math.round(((ultimo - prima) / prima) * 100) : null;
      const segno = perc === null ? "" : perc > 0 ? `+${perc}%` : `${perc}%`;
      const classe = perc === null || perc === 0 ? "pari" : perc > 0 ? "su" : "giu";
      return `<div class="trend"><div class="trend-top"><b>${b.t}</b><span class="trend-n">${ultimo} ${ultimo === 1 ? "persona" : "persone"}${segno ? `<i class="trend-d ${classe}">${segno}</i>` : ""}</span></div>
        <svg class="trend-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="${esc(b.t)}: ${esc(b.nota)}"><polygon class="trend-area" points="0,${H} ${linea} ${W},${H}"/><polyline class="trend-line" points="${linea}"/></svg>
        <div class="trend-x"><span>${esc(b.etichetta(b.punti[0].k))}</span><span>${esc(b.nota)}</span><span>${esc(b.etichetta(b.punti[b.punti.length - 1].k))}</span></div></div>`;
    }).join("");
    trend.innerHTML = disegni
      ? `<div class="stat-block"><h3>Come va nel tempo</h3>${disegni}<p class="muted" style="font-size:11px;margin:6px 0 0">Le percentuali confrontano l'ultimo periodo con quello prima.</p></div>`
      : "";
  }

  // ---- gli eventi che stanno riempiendo adesso
  const top = $("#statsTop");
  if (top) {
    const righe = com.top || [];
    top.innerHTML = righe.length
      ? `<h3>Gli eventi che stanno riempiendo</h3>${righe
          .map(
            (e) => `<div class="top-ev"><div class="te-t"><b>${esc(e.title || "Senza titolo")}</b><span>${esc(e.city || "")}</span></div>
              <div class="te-n">${e.going}/${e.capacity || "–"}</div>
              <div class="te-b"><i style="width:${Math.min(100, Math.max(2, e.perc))}%"></i></div></div>`
          )
          .join("")}`
      : `<h3>Gli eventi che stanno riempiendo</h3><p class="muted">Nessun evento in programma con posti prenotati.</p>`;
  }

  const sesso = (d.sesso || []).map((r) => ({
    k: r.k === "f" ? "donne" : r.k === "m" ? "uomini" : r.k === "n" ? "altro" : "non detto",
    n: r.n,
  }));
  const charts = $("#statsCharts");
  if (charts) {
    charts.innerHTML = [
      bloccoPerc("Eventi per categoria", com.categorie, "Percentuale sul totale degli eventi creati."),
      bloccoPerc("Eventi per città", com.citta, "Percentuale sul totale degli eventi creati."),
      bloccoPerc("Come si entra", com.accesso, "Foto, viso verificato o invito: come sono impostati gli eventi."),
      bloccoPerc("Giorni della settimana", com.giorni, "Quando si esce, sugli eventi degli ultimi 3 mesi."),
      bloccoPerc("Fasce della giornata", com.fasce, "Mattina, pomeriggio, sera, notte."),
      bloccoPerc("Donne e uomini", sesso),
      bloccoPerc("Età", d.eta),
      bloccoPerc("Interessi più scelti", d.interessi),
      bloccoPerc("Lingue", d.lingue),
    ].join("");
  }
}


let statsDays = 7;
let statsDataTimer = 0;

async function caricaCodaViso() {
  const token = localStorage.getItem(OWNER_TOKEN_KEY) || "";
  const res = await fetch("/api/owner/face?token=" + encodeURIComponent(token), { cache: "no-store" });
  if (!res.ok) throw new Error("no");
  return res.json();
}

async function loadOwnerFaces() {
  const box = $("#faceBox");
  if (!box) return;
  try {
    const d = await caricaCodaViso();
    const c = d.conteggi || {};
    const attesa = Number(c.attesa) || 0;
    const rifiutate = Number(c.rifiutate) || 0;
    const verificate = Number(c.verificate) || 0;
    const daFare = attesa + rifiutate;
    box.innerHTML =
      `<div class="stat-block"><h3>Verifiche del viso</h3>` +
      `<p class="muted">${daFare ? `${attesa} ${t("revisione.attesa")}, ${rifiutate} ${t("revisione.rifiutata")}` : "Nessuno da guardare adesso."}${verificate ? ` · ${t("revisione.verificato").toLowerCase()}: ${verificate}` : ""}</p>` +
      `<button class="btn primary wide" type="button" id="revisioneApri">${esc(t("revisione.apri"))}${
        daFare ? `<span class="btn-num" aria-label="${daFare} da rivedere">${daFare > 99 ? "99+" : daFare}</span>` : ""
      }</button>` +
      (verificate
        ? `<button class="btn ghost wide" type="button" id="verificateApri">${esc(t("revisione.verificateApri", { n: verificate }))}</button>`
        : "") +
      `</div>`;
    const b = $("#revisioneApri");
    if (b) b.onclick = () => apriRevisione("coda");
    const v = $("#verificateApri");
    if (v) v.onclick = () => apriRevisione("ok");
  } catch {
    box.innerHTML = "";
  }
}

// la scheda di una persona da rivedere: foto profilo, selfie, e due pulsanti
function cardRevisione(p) {
  const stato = p.verified ? "verificato" : p.pending ? "attesa" : "rifiutata";
  const contatti = [p.email, p.phone, p.city].filter(Boolean).join(" · ");
  const quando =
    p.verified && p.at ? `<span class="muted">${esc(t("revisione.il", { d: dayShort(p.at) }))}</span>` : "";
  const badge = p.verified
    ? `<span class="rev-badge attesa">${esc(t("revisione.verificato"))}</span>`
    : `<span class="rev-badge ${stato}">${esc(t(stato === "attesa" ? "revisione.attesa" : "revisione.rifiutata"))}</span>`;
  const auto =
    p.score === null || p.score === undefined ? "" : `<span class="muted">${esc(t("revisione.auto", { a: p.score }))}</span>`;
  return `<div class="rev-card${p.verified ? " verificata" : ""}" data-email="${esc(p.email)}">
    <div class="rev-imgs">${p.photo ? `<img src="${esc(p.photo)}" alt="">` : ""}${p.selfie ? `<img src="${esc(p.selfie)}" alt="">` : ""}</div>
    <div class="rev-txt"><b>${esc(p.name)}</b><span class="muted">${esc(contatti)}</span>${badge}${auto}${quando}</div>
    <div class="rev-btns">
      ${p.verified ? "" : `<button class="btn primary sm" type="button" data-ok="1">${esc(t("revisione.verificato"))}</button>`}
      <button class="btn ghost sm" type="button" data-ok="0">${esc(t(p.verified ? "revisione.togli" : "revisione.no"))}</button>
    </div>
  </div>`;
}

let revisioneFiltro = "coda";

async function apriRevisione(filtro) {
  revisioneFiltro = filtro === "ok" ? "ok" : "coda";
  show("revisione");
  const box = $("#revisioneList");
  if (!box) return;
  box.innerHTML = `<p class="muted">Un attimo…</p>`;
  let d = null;
  try {
    d = await caricaCodaViso();
  } catch {
    box.innerHTML = `<p class="muted">Adesso non riesco a leggere la coda: riprova tra poco.</p>`;
    return;
  }
  const tutte = d.people || [];
  const daFare = tutte.filter((p) => p.pending || p.rifiutata);
  const fatte = tutte.filter((p) => p.verified);
  // le due linguette: quello che c'è da guardare, e chi è già stato verificato
  const seg = $("#revisioneFiltro");
  if (seg) {
    seg.hidden = false;
    seg.innerHTML =
      `<button type="button" data-r="coda" class="${revisioneFiltro === "coda" ? "on" : ""}">${esc(t("revisione.coda", { n: daFare.length }))}</button>` +
      `<button type="button" data-r="ok" class="${revisioneFiltro === "ok" ? "on" : ""}">${esc(t("revisione.ok", { n: fatte.length }))}</button>`;
    seg.querySelectorAll("[data-r]").forEach((b) => {
      b.onclick = () => {
        if (b.dataset.r === revisioneFiltro) return;
        if (seg) seg.hidden = true;
        apriRevisione(b.dataset.r);
      };
    });
  }
  const lista = revisioneFiltro === "ok" ? fatte : daFare;
  box.innerHTML = lista.length
    ? lista.map(cardRevisione).join("")
    : `<p class="muted">${esc(t(revisioneFiltro === "ok" ? "revisione.nessunaVerificata" : "revisione.vuota"))}</p>`;
  box.querySelectorAll(".rev-card").forEach((el) => {
    el.querySelectorAll("[data-ok]").forEach((b) => {
      b.onclick = async () => {
        if (b.disabled) return;
        b.disabled = true;
        const token = localStorage.getItem(OWNER_TOKEN_KEY) || "";
        try {
          await fetch("/api/owner/face?token=" + encodeURIComponent(token), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: el.dataset.email, ok: b.dataset.ok === "1" }),
          });
          // la persona passa da una lista all'altra: ridisegno tutto, numeri compresi
          await apriRevisione(revisioneFiltro);
          loadOwnerFaces();
        } catch {
          b.disabled = false;
        }
      };
    });
  });
}

/* ---------- cosa succede adesso (solo per il padrone) ---------- */
let liveTimer = null;
const LIVE_LABEL = {
  signup: "Nuova iscrizione",
  photo: "Foto profilo cambiata",
  verify_ok: "Verifica riuscita",
  verify_pending: "Verifica da guardare",
  verify_fail: "Verifica non riuscita",
  join: "Si è iscritto a un evento",
  request: "Chiede di entrare",
  accept: "Richiesta accettata",
  decline: "Richiesta rifiutata",
  event: "Nuovo evento",
  chat: "Messaggio nel gruppo",
  download: "Ha scaricato l'app",
  open: "App aperta",
  close: "App chiusa",
};

function agoShort(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "adesso";
  if (s < 3600) return Math.round(s / 60) + " min";
  if (s < 86400) return Math.round(s / 3600) + " h";
  return Math.round(s / 86400) + " g";
}

// come si sentono le persone: l'umore scelto una volta al giorno finisce qui
async function loadMoodStats() {
  const box = $("#statsMood");
  if (!box) return;
  try {
    const d = await api(`/moods?days=${statsDays}&device=${encodeURIComponent(device)}`);
    const list = (d.moods || []).filter((x) => x && x.n);
    const tot = list.reduce((s, x) => s + Number(x.n || 0), 0);
    if (!tot) {
      box.innerHTML = `<h3 class="stat-block-t">Come ti sentono</h3><p class="muted">Ancora nessuna risposta: l'umore lo si sceglie una volta al giorno.</p>`;
      return;
    }
    const emo = {};
    for (const m of MOODS) emo[m.id] = m.emoji;
    box.innerHTML = `<h3 class="stat-block-t">Come si sentono</h3>
      <p class="muted">${tot} risposte negli ultimi ${statsDays} giorni · oggi ${Number(d.today) || 0}</p>
      ${list.map((x) => {
        const pc = Math.round((Number(x.n) / tot) * 100);
        return `<div class="mood-bar"><b>${emo[x.mood] || ""} ${esc(t("mood." + x.mood))}</b>
          <span class="mb-track"><i style="width:${pc}%"></i></span>
          <span class="mb-n">${x.n} · ${pc}%</span></div>`;
      }).join("")}`;
  } catch {
    box.innerHTML = "";
  }
}

async function loadLive() {
  const box = $("#statsLive");
  if (!box) return;
  try {
    const res = await fetch(`/api/owner/live?device=${encodeURIComponent(device)}&since=0`, { cache: "no-store" });
    if (!res.ok) {
      box.innerHTML = "";
      return;
    }
    const d = await res.json();
    const items = d.items || [];
    const ops = d.ops || [];
    const tempi = d.tempi || [];
    const pending = Number(d.pendingVerify) || 0;

    // una riga sola per tutto: quello che succede e i tocchi dentro l'app (aprire, guardare, scrivere)
    const eventi = [
      ...items.map((x) => ({
        t: Number(x.at) || 0,
        chi: x.who || "",
        testo: (LIVE_LABEL[x.kind] || x.kind) + (x.detail ? " · " + x.detail : ""),
      })),
      ...ops.map((x) => ({
        t: Number(x.at) || 0,
        chi: x.chi || "Ospite",
        testo: peekText({ cosa: x.k, su: x.d }),
      })),
    ]
      .sort((a, b) => b.t - a.t)
      .slice(0, 10);

    const head = `<h3 style="margin:18px 0 6px">Cosa stanno facendo adesso</h3>`;
    const wait = pending
      ? `<button class="live-wait" id="liveWait" type="button">${pending} ${pending === 1 ? "verifica da guardare" : "verifiche da guardare"} ›</button>`
      : "";
    const list = eventi.length
      ? eventi
          .map(
            (x) => `<div class="live-row"><span class="live-k">${esc(x.testo)}</span>
              <span class="live-w">${esc(x.chi)}</span>
              <span class="live-t">${esc(agoShort(x.t || Date.now()))}</span></div>`
          )
          .join("")
      : `<p class="muted">Ancora niente. Appena qualcuno apre l'app o tocca qualcosa, lo vedi qui.</p>`;

    // quanto tempo sta ognuno dentro l'app, e la media di tutti
    const minuti = (s) => {
      const m = Math.round(Number(s || 0) / 60);
      return m < 1 ? "meno di 1 min" : m + " min";
    };
    const tempoHead = `<h3 style="margin:18px 0 6px">Tempo nell'app <span class="muted" style="font-weight:400">· ultime 24 ore</span></h3>`;
    const tempoIntro = tempi.length
      ? `<p class="muted">In media ${minuti(d.media)} a persona, su ${tempi.length} ${tempi.length === 1 ? "profilo" : "profili"}.</p>`
      : "";
    const tempoList = tempi.length
      ? tempi
          .filter((p) => !p.tu)
          .slice(0, 6)
          .map(
            (p) => `<div class="live-row"><span class="live-k">${esc(p.chi)}${p.tu ? " (tu)" : ""}</span>
              <span class="live-t">${esc(minuti(p.sec))}</span>
              <span class="live-w">${p.aperture} ${p.aperture === 1 ? "apertura" : "aperture"}${p.dentro ? " · dentro adesso" : ""}</span></div>`
          )
          .join("")
      : `<p class="muted">Nessun tempo registrato nelle ultime 24 ore.</p>`;

    box.innerHTML = head + wait + list + tempoHead + tempoIntro + tempoList;
    const apri = $("#liveWait");
    if (apri) apri.onclick = () => apriRevisione("todo");

    // ---- chi è online adesso, con il nome (tu resti fuori)
    const online = d.online || [];
    const boxOn = $("#statsOnline");
    if (boxOn) {
      boxOn.innerHTML = online.length
        ? online
            .map(
              (p) => `<div class="live-row"><span class="live-dot" aria-hidden="true"></span>
                <span class="live-k">${esc(p.chi)}</span>
                <span class="live-w">${p.modo === "app" ? "dall'app" : "dal browser"}</span>
                <span class="live-t">${esc(agoShort(p.at || Date.now()))}</span></div>`
            )
            .join("")
        : `<p class="muted">Nessun altro dentro in questo momento: solo tu.</p>`;
    }
    const onN = $("#statsOnlineN");
    if (onN) onN.textContent = online.length ? String(online.length) : "";

    // ---- chi ha votato cosa: nomi, stelle e pollici
    const voti = d.voti || [];
    const boxVoti = $("#statsVoti");
    if (boxVoti) {
      boxVoti.innerHTML = voti.length
        ? voti
            .map((v) => {
              const segno = v.stelle ? `★ ${v.stelle}/5` : v.pollice === 1 ? "👍" : v.pollice === -1 ? "👎" : "voto";
              return `<div class="live-row"><span class="live-k">${esc(v.chi)}</span>
                <span class="live-w">${esc(segno)}${v.titolo ? " · " + esc(v.titolo) : ""}</span>
                <span class="live-t">${esc(agoShort(v.at || Date.now()))}</span></div>`;
            })
            .join("")
        : `<p class="muted">Nessun voto ancora. Quando qualcuno vota un ricordo, compare qui con il nome.</p>`;
    }
    const vN = $("#statsVotiN");
    if (vN) vN.textContent = voti.length ? String(voti.length) : "";
    const lN = $("#statsLiveN");
    if (lN) lN.textContent = String(items.length + ops.length) || "";
  } catch {
    box.innerHTML = "";
  }
}

/* ---------- una foto in grande, quando la vuoi guardare bene ---------- */
// se le foto sono più di una si scorrono lì dentro, senza chiudere e riaprire
let fotoLista = [];
let fotoIndice = 0;
let fotoToccoX = 0;
let fotoToccoY = 0;
let fotoScorsa = false;

// le foto dello stesso gruppo: la scheda in home, il dettaglio, la griglia delle verifiche
function fotoDelGruppo(img) {
  try {
    const gruppo = img && img.closest && img.closest(".det-photos, .ev-photos, .foto-grid");
    if (gruppo) {
      const imgs = [...gruppo.querySelectorAll("img")].filter((i) => i.getAttribute("src"));
      if (imgs.length > 1) return imgs;
    }
  } catch {}
  return img ? [img] : [];
}

function mostraFoto(i) {
  const box = $("#fotoBig");
  if (!box || !fotoLista.length) return;
  const n = fotoLista.length;
  fotoIndice = ((Number(i) || 0) % n + n) % n;
  const img = box.querySelector("img");
  const foto = fotoLista[fotoIndice];
  const url = foto.currentSrc || foto.src || "";
  if (img && url) {
    img.src = url;
    img.alt = foto.alt || "";
  }
  const num = box.querySelector(".fb-n");
  if (num) num.textContent = n > 1 ? `${fotoIndice + 1} / ${n}` : "";
  box.classList.toggle("fb-multi", n > 1);
}

function vediFoto(url, alt, img) {
  const box = $("#fotoBig");
  if (!box || !url) return;
  fotoLista = fotoDelGruppo(img);
  if (!fotoLista.length) fotoLista = [{ src: url, alt: alt || "" }];
  const i = fotoLista.findIndex((f) => (f.currentSrc || f.src || "") === url);
  fotoIndice = i > 0 ? i : 0;
  mostraFoto(fotoIndice);
  box.hidden = false;
  document.body.style.overflow = "hidden";
}

function chiudiFoto() {
  const box = $("#fotoBig");
  if (!box) return;
  box.hidden = true;
  box.classList.remove("fb-multi");
  fotoLista = [];
  fotoIndice = 0;
  const img = box.querySelector("img");
  if (img) img.removeAttribute("src");
  if (!openSheets.size) document.body.style.overflow = "";
}

/* ---------- avvisi importanti: niente lampi, si leggono con calma ---------- */
let avvisoTimer = null;
function avvisoLungo(titolo, testo, azione) {
  let box = $("#avviso");
  if (!box) {
    box = document.createElement("div");
    box.id = "avviso";
    document.body.appendChild(box);
  }
  box.innerHTML = `<div class="av-in">
    <p class="av-t">${esc(titolo)}</p>
    <p class="av-s">${esc(testo)}</p>
    ${azione ? `<button class="btn primary sm" id="avBtn" type="button">${esc(azione.label)}</button>` : ""}
    <button class="av-x" id="avClose" type="button" aria-label="Chiudi">×</button>
  </div>`;
  box.classList.add("on");
  const chiudi = () => box.classList.remove("on");
  const x = $("#avClose");
  if (x) x.onclick = chiudi;
  const b = $("#avBtn");
  if (b && azione) b.onclick = () => { chiudi(); if (azione.run) azione.run(); };
  clearTimeout(avvisoTimer);
  avvisoTimer = setTimeout(chiudi, 9000);
}

// per creare e per partecipare servono tutte e due: foto e verifica del viso
function possoFareEventi() {
  if (!person) {
    openRegister();
    return false;
  }
  if (person.photoBad) {
    avvisoLungo(
      "La foto non va bene",
      "Quella che hai messo non è una foto vera: disegni, anime e avatar non valgono. Serve una foto del tuo viso, scattata a te, con la verifica. Poi puoi creare e partecipare agli eventi.",
      { label: "Metti una foto vera", run: () => openProfile() }
    );
    return false;
  }
  if (!person.photo) {
    avvisoLungo(
      "Prima la foto profilo",
      "Per creare un evento o partecipare servono due cose: la foto e la verifica del viso. Partiamo dalla foto: si carica dal profilo in dieci secondi.",
      { label: "Carica la foto", run: () => openProfile() }
    );
    return false;
  }
  if (!person.verified) {
    avvisoLungo(
      "Adesso verifica il viso",
      "La foto c'è. Manca la verifica del viso: è un selfie veloce dal profilo. Finché non la fai non puoi creare eventi né partecipare.",
      { label: "Fai la verifica", run: () => openVerify() }
    );
    return false;
  }
  return true;
}

function promemoriaVerifica() {
  if (!person?.email || !person.photo || person.verified) return;
  const oggi = new Date().toISOString().slice(0, 10);
  if (localStorage.getItem("fuori.verificaRicordata") === oggi) return;
  localStorage.setItem("fuori.verificaRicordata", oggi);
  setTimeout(() => {
    if (!person?.photo || person.verified) return;
    avvisoLungo(
      "Manca solo la verifica del viso",
      "La foto c'è, la verifica no. Con la verifica puoi creare eventi e partecipare: è un selfie veloce, due minuti.",
      { label: "Fai la verifica", run: () => openVerify() }
    );
  }, 2500);
}

/* ---------- una persona per una ---------- */
let peopleRows = null;
const PEEK_IT = {
  schermata: "guarda",
  evento_aperto: "apre l'evento",
  evento_creato: "crea l'evento",
  evento_modificato: "modifica l'evento",
  iscrizione: "si iscrive a",
  ritirato: "si ritira da",
  condivisione: "condivide",
  invito_copiato: "copia l'invito di",
  chat_aperta: "entra nella chat",
  messaggio: "scrive",
  ricordo_modificato: "sistema il ricordo",
  numeri_aperti: "guarda i numeri",
  download_apk: "scarica l'app",
};

function peekText(x) {
  const cosa = PEEK_IT[x.cosa] || x.cosa;
  return cosa + (x.su ? " · " + x.su : "");
}

function dayShort(ts) {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleDateString("it-IT", { day: "numeric", month: "short" });
  } catch {
    return "—";
  }
}

function oraShort(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

// dove è stato: una riga per posto, con il link alla mappa
function mappaLink(lat, lng) {
  return `https://www.google.com/maps?q=${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`;
}

function righePosizioni(p) {
  const lista = Array.isArray(p.posizioni) ? p.posizioni : [];
  if (!lista.length) return { riga: "", log: "" };
  const prima = lista[0];
  const riga = `<div class="pcard-line">Posizione: ${dayShort(prima.at)} ${oraShort(prima.at)} · <a href="${mappaLink(prima.lat, prima.lng)}" target="_blank" rel="noopener">apri mappa</a></div>`;
  const log = `<b>Log posizioni (${lista.length})</b><ul>${lista
    .map(
      (x) =>
        `<li>${dayShort(x.at)} ${oraShort(x.at)} <span class="muted">· ${Number(x.lat).toFixed(3)}, ${Number(x.lng).toFixed(3)}</span> · <a href="${mappaLink(x.lat, x.lng)}" target="_blank" rel="noopener">mappa</a></li>`
    )
    .join("")}</ul>`;
  return { riga, log };
}

/* ---------- segnalazioni: quello che le persone dicono che non va ---------- */
const TIPO_SEG = { auto: "errore automatico", bug: "non funziona", idea: "idea", altro: "altro" };

let segTab = "nuova";       // da risolvere / in sospeso / risolti
let segDati = null;

// come stanno gli avvisi sul telefono: chi è iscritto e se l'ultimo invio è arrivato davvero
async function loadPushStato() {
  const box = $("#pushBox");
  if (!box) return;
  try {
    const token = localStorage.getItem(OWNER_TOKEN_KEY) || "";
    const d = await api("/owner/push?token=" + encodeURIComponent(token));
    const lista = d.avvisi || [];
    const c = d.conteggi || {};
    if (!lista.length) {
      box.innerHTML = `<div class="stat-block"><h3>Avvisi sul telefono</h3><p class="muted">Nessun telefono iscritto: così gli avvisi non possono arrivare a nessuno.</p></div>`;
      return;
    }
    const righe = lista
      .slice(0, 6)
      .map((r) => {
        const quando = r.ok ? `ultimo arrivato: ${dayShort(r.ok)} ${oraShort(r.ok)}` : "nessun invio riuscito";
        const rotto = r.ko && (!r.ok || r.ko > r.ok) ? ` <span class="push-ko">invio fallito (${r.stato || "?"})</span>` : "";
        return `<div class="push-riga"><b>${esc(r.chi)}</b><span>${esc(quando)}${rotto}</span></div>`;
      })
      .join("");
    box.innerHTML =
      `<div class="stat-block"><h3>Avvisi sul telefono</h3>` +
      `<p class="muted">${c.iscritti} ${c.iscritti === 1 ? "telefono iscritto" : "telefoni iscritti"}${
        c.ultimo ? ` · ultimo invio accettato ${dayShort(c.ultimo)} ${oraShort(c.ultimo)}` : ""
      }</p>` +
      righe +
      `<button class="btn ghost wide" type="button" id="pushProva">Manda un avviso di prova</button>` +
      `<p class="tiny">Se qui dice "ultimo arrivato" ma sul telefono non vedi niente, gli avvisi sono spenti nelle impostazioni di Android per Chrome o per FUORI.</p></div>`;
    const b = $("#pushProva");
    if (b)
      b.onclick = async () => {
        if (!person?.email) {
          toast("Prima entra col tuo account: l'avviso va legato a una mail.", "err");
          return;
        }
        try {
          const r = await api("/push/test", { method: "POST", body: JSON.stringify({ email: person.email, device }) });
          toast(r.sent ? `Mandato a ${r.sent} ${r.sent === 1 ? "telefono" : "telefoni"}.` : "Nessun telefono da avvisare.");
          loadPushStato();
        } catch (err) {
          toast(err.data?.error || "Non sono riuscita a mandarlo.", "err");
        }
      };
  } catch {
    box.innerHTML = "";
  }
}

async function loadSegnalazioni() {
  const box = $("#segnalazioniBox");
  if (!box) return;
  try {
    const token = localStorage.getItem(OWNER_TOKEN_KEY) || "";
    const d = await api("/owner/feedback?token=" + encodeURIComponent(token));
    segDati = d;
    const c = d.conteggi || {};
    const nuove = Number(c.nuove) || 0;
    const sospese = Number(c.sospese) || 0;
    const risolte = Number(c.risolte) || 0;
    const mie = Number(c.mie) || 0;
    const totali = Number(c.totali) || 0;
    if (!totali) {
      box.innerHTML = `<div class="stat-block"><h3>Segnalazioni</h3><p class="muted">Nessuna segnalazione, per ora. Se qualcosa non va, lo vedi qui.</p></div>`;
      return;
    }
    const righe = [];
    if (nuove) righe.push(`${nuove} da risolvere`);
    if (sospese) righe.push(`${sospese} in sospeso`);
    if (risolte) righe.push(`${risolte} risolte`);
    box.innerHTML =
      `<div class="stat-block"><h3>Segnalazioni</h3>` +
      `<p class="muted">${esc(righe.join(" · ") || "tutto sistemato")}${
        mie ? (mie === 1 ? " · 1 aspetta una mia mossa" : ` · ${mie} aspettano una mia mossa`) : ""
      }</p>` +
      `<button class="btn primary wide" type="button" id="segApri">${esc(t("seg.apri"))}${
        nuove ? ` (${nuove})` : ""
      }</button></div>`;
    const b = $("#segApri");
    if (b) b.onclick = () => apriSegnalazioni();
  } catch {
    box.innerHTML = "";
  }
}

// cosa ha chiesto lui su quella segnalazione (o se l'ho sistemata da sola)
function richiestaSeg(s) {
  if (!s.azione) return "";
  const cosa =
    s.azione === "auto"
      ? "Sistemata da sola"
      : s.azione === "indietro"
        ? "Hai chiesto: torna come prima"
        : s.azione === "approva"
          ? "Hai chiesto: prima chiedi a me e aspetta l'ok"
          : "Hai chiesto: modifica";
  return `<div class="seg-richiesta">${cosa}${s.risposta ? ` — «${esc(s.risposta)}»` : ""}</div>`;
}

function segBlocco(etichetta, testo, classe) {
  if (!testo) return "";
  return `<div class="seg-riga ${classe || ""}"><span class="seg-lbl">${esc(etichetta)}</span>${esc(testo)}</div>`;
}

function cardSegnalazione(s) {
  const tipo = TIPO_SEG[s.tipo] || "altro";
  const stato = s.stato || "nuova";
  const chi = s.foto
    ? `<img class="seg-av" src="${esc(s.foto)}" alt="" loading="lazy">`
    : `<span class="seg-av seg-av-vuota">${esc((s.chi || "?")[0].toUpperCase())}</span>`;
  const etichettaStato =
    stato === "risolta"
      ? `<span class="seg-stato ok">risolta</span>`
      : stato === "sospesa"
        ? `<span class="seg-stato sospesa">in sospeso</span>`
        : "";
  const auto = s.soluzione === "auto";
  const riquadro = stato === "risolta" ? "" : auto
    ? `<span class="seg-badge auto">posso sistemarlo io</span>`
    : `<span class="seg-badge scelta">prima ti chiedo</span>`;

  // cosa succede, perché e come si risolve: quando la diagnosi c'è la mostro, altrimenti
  // resta la segnalazione scritta dalla persona
  const cosa = s.cosa || s.testo;
  const corpo =
    segBlocco("Cosa succede", cosa, "detto") +
    segBlocco("Perché", s.perche, "") +
    segBlocco("Come si risolve", s.come, "") +
    (s.cosa && s.testo !== s.cosa ? segBlocco("La segnalazione", s.testo, "piccola") : "");

  const richiesta = richiestaSeg(s);

  const pulsanti = [];
  if (stato === "risolta") {
    pulsanti.push(`<button class="btn ghost sm" type="button" data-azione="indietro">Torna come prima</button>`);
    pulsanti.push(`<button class="btn ghost sm" type="button" data-stato="nuova">${esc(t("seg.riapri"))}</button>`);
  } else if (stato === "sospesa") {
    pulsanti.push(`<button class="btn primary sm" type="button" data-azione="approva">Approvo, fallo</button>`);
    pulsanti.push(`<button class="btn ghost sm" type="button" data-azione="indietro">Torna come prima</button>`);
    pulsanti.push(`<button class="btn ghost sm" type="button" data-scrivi="1">Modifica</button>`);
    pulsanti.push(`<button class="btn ghost sm" type="button" data-azione="scarta">Scarta</button>`);
  } else {
    pulsanti.push(`<button class="btn primary sm" type="button" data-stato="risolta">${esc(t("seg.risolta"))}</button>`);
    if (!auto) pulsanti.push(`<button class="btn ghost sm" type="button" data-azione="approva">Chiedi prima a me</button>`);
    pulsanti.push(`<button class="btn ghost sm" type="button" data-scrivi="1">Dimmi tu come</button>`);
  }

  return `<div class="seg-card${stato === "risolta" ? " chiusa" : ""}" data-seg="${s.id}">
    <div class="seg-top">${chi}<b>${esc(s.chi)}</b>${etichettaStato}<span class="seg-tipo ${esc(s.tipo)}">${esc(tipo)}</span></div>
    <div class="seg-quando">${dayShort(s.quando)} ${oraShort(s.quando)}${s.dove ? ` · ${esc(s.dove)}` : ""}${
      s.email && s.email !== s.chi ? ` · ${esc(s.email)}` : ""
    }</div>
    <div class="seg-corpo">${riquadro}${corpo}</div>
    ${richiesta}
    <div class="seg-azioni">${pulsanti.join("")}</div>
    <div class="seg-scrivi" hidden>
      <textarea rows="2" placeholder="Scrivi come lo vuoi tu: lo leggo appena mi scrivi in chat"></textarea>
      <button class="btn primary sm" type="button" data-invia="1">Manda</button>
    </div>
  </div>`;
}

let segTimer = 0;
let statTimer = 0;

async function apriSegnalazioni() {
  show("segnalazioni");
  await disegnaSegnalazioni();
  // nuova segnalazione, o una che si è chiusa da sola: la lista si aggiorna senza toccare niente
  clearInterval(segTimer);
  segTimer = setInterval(() => {
    const el = $("#segnalazioni");
    if (!el || el.hidden) {
      clearInterval(segTimer);
      segTimer = 0;
      return;
    }
    if (!document.hidden) disegnaSegnalazioni(true);
  }, 15000);
}

async function disegnaSegnalazioni(zitta) {
  const box = $("#segnalazioniList");
  if (!box) return;
  // quando si aggiorna da sola non rimetto "Un attimo…": la lista resta quella di prima
  const scorrimento = box.closest(".sheet-body, .sheet")?.scrollTop ?? 0;
  if (!zitta) box.innerHTML = `<p class="muted">Un attimo…</p>`;
  const token = localStorage.getItem(OWNER_TOKEN_KEY) || "";
  let d = null;
  try {
    d = await api("/owner/feedback?token=" + encodeURIComponent(token));
  } catch {
    box.innerHTML = `<p class="muted">Adesso non riesco a leggerle: riprova tra poco.</p>`;
    return;
  }
  segDati = d;
  const tutte = d.segnalazioni || [];
  const c = d.conteggi || {};
  const tabs = [
    ["nuova", "Da risolvere", Number(c.nuove) || 0],
    ["sospesa", "In sospeso", Number(c.sospese) || 0],
    ["risolta", "Risolti", Number(c.risolte) || 0],
  ];
  if (!tutte.length) {
    box.innerHTML = `<p class="muted">${esc(t("seg.vuoto"))}</p>`;
    return;
  }
  const lista = tutte.filter((s) => (s.stato || "nuova") === segTab);
  const mie = tutte.filter((s) => s.azione && s.stato !== "risolta");
  box.innerHTML =
    (mie.length
      ? `<button class="btn ghost wide" type="button" id="segCopia">Copia le mie richieste (${mie.length})</button>`
      : "") +
    `<div class="seg-tabs">${tabs
      .map(
        ([k, label, n]) =>
          `<button type="button" data-tab="${k}" class="${segTab === k ? "on" : ""}">${esc(label)}${
            n ? ` (${n})` : ""
          }</button>`
      )
      .join("")}</div>` +
    (lista.length ? lista.map(cardSegnalazione).join("") : `<p class="muted">Niente da fare qui.</p>`);

  box.closest(".sheet-body, .sheet")?.scrollTo?.(0, scorrimento);

  const manda = async (id, corpo) => {
    try {
      await api("/owner/feedback?token=" + encodeURIComponent(token), { method: "POST", body: JSON.stringify({ id, ...corpo }) });
      toast("Ricevuto. Lo leggo io e lo sistemo.");
      await disegnaSegnalazioni();
      loadSegnalazioni();
    } catch {
      toast("Non sono riuscita a salvare: riprova.", "err");
    }
  };

  const copia = $("#segCopia");
  if (copia) {
    copia.onclick = async () => {
      // il testo da incollarmi in chat: così non si perde niente e io so cosa fare
      const righe = mie.map((s) => {
        const cosa =
          s.azione === "indietro"
            ? "torna come prima"
            : s.azione === "approva"
              ? "approvato, fallo"
              : "modifica";
        return `#${s.id} — ${cosa}${s.risposta ? `: «${s.risposta}»` : ""} — ${(s.cosa || s.testo).slice(0, 120)}`;
      });
      const testo = "Le mie richieste sulle segnalazioni:\n" + righe.join("\n");
      try {
        await navigator.clipboard.writeText(testo);
        toast("Copiato. Incollamelo qui in chat e lo faccio.");
      } catch {
        toast("Non riesco a copiare: dimmi a voce il numero della segnalazione.", "err");
      }
    };
  }
  box.querySelectorAll("[data-tab]").forEach((b) => {
    b.onclick = () => {
      segTab = b.dataset.tab;
      disegnaSegnalazioni();
    };
  });
  box.querySelectorAll(".seg-card").forEach((el) => {
    const id = Number(el.dataset.seg);
    el.querySelectorAll("[data-stato]").forEach((b) => {
      b.onclick = () => manda(id, { stato: b.dataset.stato });
    });
    el.querySelectorAll("[data-azione]").forEach((b) => {
      b.onclick = () => {
        if (b.dataset.azione === "approva") {
          segTab = "sospesa";
          return manda(id, { azione: "approva" });
        }
        return manda(id, { azione: b.dataset.azione });
      };
    });
    const scrivi = el.querySelector("[data-scrivi]");
    const riquadro = el.querySelector(".seg-scrivi");
    if (scrivi && riquadro) {
      scrivi.onclick = () => {
        riquadro.hidden = !riquadro.hidden;
        const ta = riquadro.querySelector("textarea");
        if (ta && !riquadro.hidden) ta.focus();
      };
    }
    const invia = el.querySelector("[data-invia]");
    if (invia && riquadro) {
      invia.onclick = () => {
        const ta = riquadro.querySelector("textarea");
        const testo = (ta?.value || "").trim();
        if (testo.length < 3) {
          toast("Scrivi almeno due parole, così capisco.", "err");
          return;
        }
        manda(id, { azione: "modifica", risposta: testo });
      };
    }
  });
}

// le schede che ho aperto: restano aperte anche quando i numeri si aggiornano
const schedeAperte = new Set();
let peopleFirma = "";

let personeOrdina = "nuovi";
let personeFiltro = "tutti";

async function loadPeople() {
  const box = $("#statsPeople");
  if (!box) return;
  try {
    const token = localStorage.getItem(OWNER_TOKEN_KEY) || "";
    const res = await fetch("/api/owner/people?token=" + encodeURIComponent(token), { cache: "no-store" });
    if (!res.ok) throw new Error("no");
    const data = await res.json();
    peopleRows = data.people || [];
    // nei numeri resta solo un pulsante: dentro c'è tutto
    box.innerHTML = `<button class="btn primary wide" type="button" id="personeApri">${esc(t("persone.apri"))} (${peopleRows.length})</button>`;
    const b = $("#personeApri");
    if (b) b.onclick = () => apriPersone();
    // se non è cambiato niente non ridisegno: così la scheda aperta non si richiude da sola
    const firma = JSON.stringify(peopleRows);
    if (firma === peopleFirma) return;
    peopleFirma = firma;
    const pannello = $("#persone");
    if (pannello && !pannello.hidden) renderPeople();
  } catch {
    if (!peopleRows) box.innerHTML = `<p class="muted">Non riesco a leggere le persone.</p>`;
  }
}

// tutte le persone, con l'ordine e il filtro che scegli tu
function personeScelte() {
  const lista = (peopleRows || []).filter((p) => {
    const v = p.verifiche || {};
    if (personeFiltro === "foto") return Boolean(p.fotoUrl);
    if (personeFiltro === "senzafoto") return !p.fotoUrl;
    if (personeFiltro === "viso") return Boolean(v.viso);
    if (personeFiltro === "visono") return !v.viso;
    if (personeFiltro === "posizione") return Array.isArray(p.posizioni) && p.posizioni.length > 0;
    if (personeFiltro === "senzaposizione") return !(Array.isArray(p.posizioni) && p.posizioni.length);
    return true;
  });
  // il worker manda "age": prima leggevo "eta", che non esisteva, quindi l'ordine per età
  // restava sempre identico (tutti a zero). Chi non ha scritto l'età va in fondo.
  const eta = (p) => { const v = Number(p.age ?? p.eta); return Number.isFinite(v) && v > 0 ? v : null; };
  const quando = (p) => Number(p.iscritto) || 0;
  const out = lista.slice();
  if (personeOrdina === "nuovi") out.sort((a, b) => quando(b) - quando(a));
  else if (personeOrdina === "vecchi") out.sort((a, b) => quando(a) - quando(b));
  else if (personeOrdina === "giovani") out.sort((a, b) => (eta(a) ?? 1e6) - (eta(b) ?? 1e6));
  else if (personeOrdina === "grandi") out.sort((a, b) => (eta(b) ?? -1) - (eta(a) ?? -1));
  return out;
}

function apriPersone() {
  renderPeople();
  show("persone");
}

function renderPeople() {
  const box = $("#personeList");
  if (!box || !peopleRows) return;
  const scelte = personeScelte();
  const sub = $("#personeSub");
  if (sub) sub.textContent = scelte.length === 1 ? t("persone.contaUno") : t("persone.conta", { n: scelte.length });
  if (!peopleRows.length) {
    box.innerHTML = `<p class="muted">Ancora nessuno: appena qualcuno entra lo vedi qui.</p>`;
    return;
  }
  if (!scelte.length) {
    box.innerHTML = `<p class="muted">${esc(t("persone.vuoto"))}</p>`;
    return;
  }
  box.innerHTML = scelte
    .map((p) => {
      const chi = [
        p.age ? p.age + " anni" : "",
        p.sex === "f" ? "donna" : p.sex === "m" ? "uomo" : "",
        p.city,
        p.locale,
      ]
        .filter(Boolean)
        .join(" · ");
      const ver = [
        p.verifiche.email && "mail ✓",
        p.verifiche.telefono && "telefono ✓",
        p.verifiche.viso && "viso ✓",
        p.verifiche.visoInAttesa && "viso in attesa",
        p.verifiche.foto && "foto",
        !p.verifiche.consenso && "consenso negato",
      ]
        .filter(Boolean)
        .join(" · ");
      const nums = [
        p.numeri.creati + (p.numeri.creati === 1 ? " evento creato" : " eventi creati"),
        p.numeri.dentro + (p.numeri.dentro === 1 ? " partecipazione" : " partecipazioni"),
        p.numeri.attesa ? p.numeri.attesa + " in attesa" : "",
        p.numeri.messaggi + (p.numeri.messaggi === 1 ? " messaggio" : " messaggi"),
        p.numeri.reazioni ? p.numeri.reazioni + (p.numeri.reazioni === 1 ? " reazione" : " reazioni") : "",
        p.numeri.download ? p.numeri.download + " download" : "",
        p.numeri.visite + (p.numeri.visite === 1 ? " visita" : " visite"),
      ]
        .filter(Boolean)
        .join(" · ");
      const gusti = [
        p.gusti.interessi.length ? "interessi: " + p.gusti.interessi.join(", ") : "",
        p.gusti.obiettivi.length ? "vuole: " + p.gusti.obiettivi.join(", ") : "",
        p.gusti.conoscere.length ? "conoscere: " + p.gusti.conoscere.join(", ") : "",
        p.gusti.uscite.length ? "uscite: " + p.gusti.uscite.join(", ") : "",
      ]
        .filter(Boolean)
        .join(" · ");
      const tocchi = p.tocchi
        .slice(0, 10)
        .map((x) => `<li>${esc(peekText(x))} <span class="muted">(${agoShort(x.quando)} fa)</span></li>`)
        .join("");
      const eventi = p.eventi.length
        ? `<b>I suoi eventi</b><ul>${p.eventi
            .map(
              (e) =>
                `<li>${esc(e.titolo || "evento cancellato")} <span class="muted">(${
                  e.stato === "pending" ? "in attesa" : e.stato || ""
                }${e.quando ? " · " + dayShort(e.quando) : ""})</span></li>`
            )
            .join("")}</ul>`
        : "";
      const msg = p.ultimoMessaggio
        ? `<b>Ultimo messaggio${p.ultimoMessaggio.evento ? " in " + esc(p.ultimoMessaggio.evento) : ""}</b>
           <div>“${esc(p.ultimoMessaggio.testo)}” <span class="muted">${agoShort(p.ultimoMessaggio.quando)} fa</span></div>`
        : "";
      const testo = [
        p.testo.bio ? `<b>Si racconta</b><div>${esc(p.testo.bio)}</div>` : "",
        p.testo.cerca ? `<b>Cerca</b><div>${esc(p.testo.cerca)}</div>` : "",
        p.testo.fatto ? `<b>Ha fatto</b><div>${esc(p.testo.fatto)}</div>` : "",
      ].join("");
      const pos = righePosizioni(p);
      const faccia = p.fotoUrl
        ? `<img class="pcard-av" src="${esc(p.fotoUrl)}" alt="" loading="lazy" decoding="async">`
        : `<span class="pcard-av pcard-av-vuota">${esc((p.nome || "?")[0].toUpperCase())}</span>`;
      return `<div class="pcard${schedeAperte.has(p.email) ? " open" : ""}" data-people="${esc(p.email || "")}">
        <div class="pcard-top">${faccia}<b>${esc(p.nome)}</b>${p.padrone ? '<span class="pcard-you">tu</span>' : ""}</div>
        ${chi ? `<div class="pcard-sub">${esc(chi)}</div>` : ""}
        <div class="pcard-contatti">
          ${p.email ? `<a href="mailto:${esc(p.email)}">✉ ${esc(p.email)}</a>` : ""}
          ${p.telefono ? `<a href="tel:${esc(p.telefono)}">📞 ${esc(p.telefono)}</a>` : ""}
          ${p.citta ? `<span>📍 ${esc(p.citta)}</span>` : ""}
        </div>
        <div class="pcard-time">iscritta/o il ${dayShort(p.iscritto)} · ultimo accesso ${
          p.ultimo ? agoShort(p.ultimo) + " fa" : "mai"
        }${p.modo ? " · " + esc(p.modo) : ""}${p.aperto ? " · aperta " + agoShort(p.aperto) + " fa" : ""}</div>
        ${pos.riga}
        <div class="pcard-line">${ver ? esc(ver) : "nessuna verifica"}</div>
        <div class="pcard-line">${esc(nums)}</div>
        ${p.schermate.length ? `<div class="pcard-line">Dove va: ${esc(p.schermate.slice(-6).join(", "))}</div>` : ""}
        <div class="pcard-line">${
          p.tocchi.length
            ? "Ultimo tocco: " + esc(peekText(p.tocchi[0])) + " · " + agoShort(p.tocchi[0].quando) + " fa"
            : "nessun tocco registrato"
        }</div>
        <div class="pcard-more">
          ${gusti ? `<b>Gli piace</b><div>${esc(gusti)}</div>` : ""}
          ${testo}
          ${eventi}
          ${msg}
          ${pos.log}
          ${tocchi ? `<b>Cosa tocca</b><ul>${tocchi}</ul>` : ""}
        </div>
      </div>`;
    })
    .join("");
  box.querySelectorAll(".pcard").forEach((card) => {
    card.onclick = (e) => {
      if (e.target.closest("a")) return;
      const aperta = card.classList.toggle("open");
      const chi = card.dataset.people || "";
      if (chi) {
        if (aperta) schedeAperte.add(chi);
        else schedeAperte.delete(chi);
      }
    };
  });
}

async function openStats() {
  show("stats");
  peek("numeri_aperti", "");
  loadOwnerFaces();
  loadFotoDaVerificare();
  loadLive();
  loadPeople();
  loadPushStato();
  loadSegnalazioni();
  loadMoodStats();
  loadSecurity();
  // mentre guardi i numeri, avvisi e segnalazioni si rinfrescano da soli
  clearInterval(statTimer);
  statTimer = setInterval(() => {
    const el = $("#stats");
    if (!el || el.hidden) {
      clearInterval(statTimer);
      statTimer = 0;
      return;
    }
    if (document.hidden) return;
    loadPushStato();
    loadSegnalazioni();
  }, 20000);
  clearInterval(liveTimer);
  // si aggiorna da solo mentre guardi
  liveTimer = setInterval(() => {
    if (!$("#stats").hidden) {
      loadLive();
      loadPeople();
    }
    else {
      clearInterval(liveTimer);
      liveTimer = null;
    }
  }, 5000);
  const nums = $("#statsNums"), charts = $("#statsCharts");
  if (nums) nums.innerHTML = `<p class="muted">Un attimo…</p>`;
  if (charts) charts.innerHTML = "";
  const range = $("#statsRange");
  if (range) {
    range.querySelectorAll("[data-d]").forEach((b) => {
      b.classList.toggle("on", Number(b.dataset.d) === statsDays);
      b.onclick = () => {
        statsDays = Number(b.dataset.d) || 7;
        openStats();
      };
    });
  }
  // il permesso dei numeri scade: invece di chiedere di rientrare, lo rinnovo da solo
  const leggiNumeri = async () => {
    const token = localStorage.getItem(OWNER_TOKEN_KEY) || "";
    const res = await fetch(`/api/owner/stats?days=${statsDays}&device=${encodeURIComponent(device)}&t=${Date.now()}&token=` + encodeURIComponent(token), {
      headers: { "content-type": "application/json" },
      cache: "no-store",
    });
    if (!res.ok) throw new Error("no");
    return res.json();
  };
  try {
    let dati;
    try {
      dati = await leggiNumeri();
    } catch {
      // permesso scaduto: lo chiedo di nuovo, senza far rifare il login
      try {
        const r = await api("/owner/token", {
          method: "POST",
          body: JSON.stringify({ token: localStorage.getItem(OWNER_TOKEN_KEY) || "" }),
        });
        if (r && r.token) localStorage.setItem(OWNER_TOKEN_KEY, r.token);
      } catch {}
      dati = await leggiNumeri();
    }
    renderStats(dati);
    // mentre guardi, i numeri si aggiornano da soli: la community è viva
    clearInterval(statsDataTimer);
    statsDataTimer = setInterval(async () => {
      if (document.hidden || !$("#stats") || $("#stats").hidden) return;
      try {
        renderStats(await leggiNumeri());
      } catch {}
    }, 30000);
  } catch {
    if (nums) nums.innerHTML = "";
    if (charts)
      charts.innerHTML = `<p class="muted">Non riesco a leggere i numeri adesso. Riprova tra poco: se resta così, rientra con la tua mail.</p>`;
  }
}

/* ---------- autorizzazioni ---------- */
const PERM_LABEL = { granted: "perm.yes", denied: "perm.no", prompt: "perm.ask", na: "perm.na" };

const permProved = {}; // esito della prova vera, fatta in questa sessione

function permSaved(kind) {
  try { return localStorage.getItem("fuori.perm." + kind) || ""; } catch { return ""; }
}
function permRemember(kind, st) {
  permProved[kind] = st;
  try { localStorage.setItem("fuori.perm." + kind, st); } catch {}
}

async function permState(kind) {
  try {
    if (kind === "gallery") return "gallery";
    if (kind === "push") return "Notification" in window ? Notification.permission : "na";
    if (kind === "geo") {
      if (navigator.permissions?.query) {
        try {
          const st = (await navigator.permissions.query({ name: "geolocation" })).state;
          if (st === "granted" || st === "denied") return st;
        } catch {}
      }
      return myPos ? "granted" : "prompt";
    }
    if (kind === "mic" || kind === "cam") {
      // Chrome spesso risponde "denied" per fotocamera e microfono anche quando vanno:
      // vale solo una prova vera o quello che abbiamo già verificato.
      if (permProved[kind]) return permProved[kind];
      const salvato = permSaved(kind);
      if (salvato) return salvato;
      if (navigator.permissions?.query) {
        try {
          const q = await navigator.permissions.query({ name: kind === "cam" ? "camera" : "microphone" });
          if (q.state === "granted") return "granted";
        } catch {}
      }
      return "prompt";
    }
  } catch {}
  return "prompt";
}

async function paintPerms() {
  let blocked = false;
  for (const kind of ["geo", "mic", "cam", "gallery", "push"]) {
    const st = await permState(kind);
    if (st === "denied") blocked = true;
    const chip = $("#perm-" + kind + "-state");
    if (chip) {
      const prova = (kind === "cam" || kind === "mic") && st === "prompt";
      chip.textContent = st === "gallery" ? t("perm.galleryHint") : prova ? "Da provare" : t(PERM_LABEL[st] || "perm.ask");
      chip.className = "perm-state " + st;
    }
    const btn = $("#perm-" + kind + "-btn");
    if (btn) {
      const etichette = {
        geo: { granted: "Controlla", prompt: t("perm.on"), denied: "Come si fa" },
        mic: { granted: "Prova", prompt: "Prova", denied: "Come si fa" },
        cam: { granted: "Prova", prompt: "Prova", denied: "Come si fa" },
        push: { granted: "Controlla", prompt: t("perm.on"), denied: "Come si fa" },
        gallery: { gallery: t("perm.galleryBtn") },
      }[kind] || {};
      btn.textContent = etichette[st] || t("perm.on");
      btn.disabled = false;
      btn.onclick = () => permGo(kind, st);
    }
  }
  const hint = $("#permHint");
  if (hint) hint.hidden = !blocked;

  paintTestPush();}

async function askPerm(kind) {
  if (kind === "geo") {
    const ok = await askPosition();
    if (!ok) toast(t("perm.geoNo"));
  } else if (kind === "mic" || kind === "cam") {
    const vincoli = kind === "mic" ? { audio: true } : { video: { facingMode: "user" } };
    try {
      const stream = await navigator.mediaDevices.getUserMedia(vincoli);
      stream.getTracks().forEach((tr) => tr.stop());
      permRemember(kind, "granted");
      toast(t(kind === "mic" ? "perm.micOk" : "perm.camOk"));
    } catch (e) {
      const nome = (e && e.name) || "";
      if (nome === "NotFoundError" || nome === "DevicesNotFoundError" || nome === "OverconstrainedError") {
        permRemember(kind, "na");
        toastErr(t("verify.noCamFound"));
      } else if (nome === "NotAllowedError" || nome === "SecurityError") {
        permRemember(kind, "denied");
        openPermFix(kind);
      } else {
        toastErr(t("perm.blockedHint"));
        openPermFix(kind);
      }
    }
  } else if (kind === "gallery") {
    // il selettore vero dell'app, così la foto si vede subito
    const inp = $("#permGalPick") || $("#photoInput");
    if (inp) {
      inp.onchange = () => toast(t("perm.galleryOk"));
      inp.click();
    }
  } else if (kind === "push") {
    await enablePush();
  }
  await paintPerms();
}

// i pulsanti della schermata autorizzazioni: prima non facevano niente
const PERM_FIX = {
  cam: {
    titolo: "La fotocamera è bloccata",
    sotto: "Si riapre dal telefono, una volta sola. Poi funziona per sempre.",
    passi: [
      "Su Android apri Chrome e vai sul sito di FUORI.",
      "Tocca il lucchetto o l'icona delle impostazioni accanto all'indirizzo.",
      "Tocca Autorizzazioni (o Impostazioni sito), poi Fotocamera, poi Consenti.",
      "Torna qui e tocca «Ho riattivato, riprova».",
      "Se non trovi la voce: Impostazioni del telefono → App → Chrome → Autorizzazioni → Fotocamera → Consenti. Nelle versioni nuove: Chrome → ⋮ → Impostazioni → Impostazioni sito → Fotocamera.",
    ],
  },
  mic: {
    titolo: "Il microfono è bloccato",
    sotto: "Senza microfono non posso ascoltarti, ma puoi sempre scrivere.",
    passi: [
      "Chrome → lucchetto accanto all'indirizzo → Autorizzazioni → Microfono → Consenti.",
      "Oppure Impostazioni del telefono → App → Chrome → Autorizzazioni → Microfono.",
      "Torna qui e tocca «Ho riattivato, riprova».",
    ],
  },
  geo: {
    titolo: "La posizione è bloccata",
    sotto: "Serve solo a mostrarti cosa c'è vicino a te.",
    passi: [
      "Chrome → lucchetto accanto all'indirizzo → Autorizzazioni → Posizione → Consenti.",
      "Controlla anche che il GPS del telefono sia acceso.",
      "Torna qui e tocca «Ho riattivato, riprova».",
    ],
  },
  push: {
    titolo: "Le notifiche sono bloccate",
    sotto: "Si riattivano dalle impostazioni del telefono, non dall'app.",
    passi: [
      "Impostazioni del telefono → App → Chrome → Notifiche → attiva.",
      "Nella stessa schermata controlla che il canale dei siti non sia silenziato.",
      "Chrome → lucchetto accanto all'indirizzo → Autorizzazioni → Notifiche → Consenti.",
      "Torna qui e tocca «Ho riattivato, riprova».",
    ],
  },
  gallery: {
    titolo: "Scegliere una foto",
    sotto: "Puoi prendere una foto dalla galleria anche senza fotocamera.",
    passi: ["Tocca «Scegli una foto» qui sotto e indica l'immagine."],
  },
};

function openPermFix(kind) {
  const info = PERM_FIX[kind] || PERM_FIX.cam;
  const titolo = $("#permFixTitle");
  const sotto = $("#permFixSub");
  const passi = $("#permFixSteps");
  if (titolo) titolo.textContent = info.titolo;
  if (sotto) sotto.textContent = info.sotto;
  if (passi) passi.innerHTML = info.passi.map((p) => `<li>${esc(p)}</li>`).join("");
  const retry = $("#permFixRetry");
  if (retry) {
    retry.hidden = kind === "gallery";
    retry.textContent = kind === "gallery" ? "" : "Ho riattivato, riprova";
    retry.onclick = async () => {
      retry.disabled = true;
      try {
        await askPerm(kind);
        const st = await permState(kind);
        if (st === "granted") {
          hide("permFix");
          toast(t("perm.fixed"));
        } else {
          toastErr(t("perm.deniedNow"));
        }
      } finally {
        retry.disabled = false;
      }
    };
  }
  const gal = $("#permFixGallery");
  if (gal) {
    gal.hidden = kind !== "cam" && kind !== "gallery";
    gal.onclick = () => {
      hide("permFix");
      const inp = $("#permGalPick") || $("#photoInput");
      if (inp) inp.click();
    };
  }
  const chiudi = $("#permFixClose");
  if (chiudi) chiudi.onclick = () => hide("permFix");
  show("permFix");
}

async function permGo(kind, st) {
  if (st === "denied") {
    openPermFix(kind);
    return;
  }
  // un solo posto fa il lavoro vero: chiede, prova, ricorda l'esito e ridisegna
  await askPerm(kind);
}

function openPerms() {
  permProved.cam = permProved.cam || "";
  show("perms");
  paintPerms();
}

// "prova una notifica": serve a capire subito se gli avvisi arrivano
function paintTestPush() {
  const btn = $("#permTestBtn");
  if (!btn) return;
  // sempre visibile: se il permesso manca lo dice, invece di nascondere il tasto
  btn.hidden = false;
  const can = true;
  btn.onclick = async () => {
    if (!("Notification" in window) || Notification.permission !== "granted") {
      toastErr("Prima accendi gli avvisi qui sopra: senza permesso il telefono non mostra niente, anche se il server manda.");
      return;
    }
    if (!person?.email) {
      toastErr("Prima entra col tuo account: l'avviso va legato a una mail.");
      return;
    }
    try {
      await ensurePush();
      const d = await api("/push/test", { method: "POST", body: JSON.stringify({ email: person.email, device }) });
      if (d.sent) {
        const ok = (d.statuses || []).every((x) => x >= 200 && x < 300);
        toast(ok ? t("perm.testSent") + " Se l'app è aperta la vedi anche qui sopra." : t("perm.testRetry"));
      } else toastErr(t("perm.testOff"));
    } catch (err) {
      toastErr(err.data?.error || t("perm.testOff"));
    }
  };
}

function isInstalled() {
  return window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator.standalone === true;
}

/* etichette stabili per i dati che finiscono nel database */
const ONB_IT = {
  "onb.g1": "Sto solo guardando", "onb.g2": "Voglio conoscere gente", "onb.g3": "Compagni per un hobby",
  "onb.g4": "Muovermi di più", "onb.g5": "Trovare la mia community", "onb.g6": "Un appuntamento",
  "onb.m1": "Persone della mia età", "onb.m2": "Nessuna preferenza", "onb.m3": "Persone affini", "onb.m4": "Professionisti",
  "onb.m5": "Studenti", "onb.m6": "Neoarrivati in città", "onb.m7": "Genitori", "onb.m8": "Appassionati di sport",
  "onb.o1": "Tranquilla", "onb.o2": "Movimentata", "onb.o3": "All'aperto", "onb.o4": "Culturale",
  "onb.o5": "Sportiva", "onb.o6": "Buon cibo", "onb.o7": "Musica dal vivo", "onb.o8": "Conoscersi piano",
};
const label = (k) => ONB_IT[k] || k;

/* ---------- collegamenti ---------- */
function bind() {
  document.addEventListener("click", (e) => {
    const close = e.target.closest("[data-close]");
    if (close) { const sheet = close.closest(".sheet"); if (sheet) hide(sheet.id); }
  });

  $("#installBtn").onclick = onInstall;
  const vaiA = (el) => {
    if (!el) return;
    // mi fermo con il titolo appena sotto la testata, non dietro
    const bar = document.querySelector("header.bar");
    const off = (bar ? bar.getBoundingClientRect().height : 0) + 14;
    window.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top + window.scrollY - off), behavior: "smooth" });
  };
  const heroFind = $("#heroFind");
  if (heroFind) heroFind.onclick = () => vaiA(document.querySelector(".matrix-wrap"));
  const heroCreate = $("#heroCreate");
  if (heroCreate) heroCreate.onclick = () => {
    // prima come si sente, una volta al giorno: poi il modulo
    if (moodPick) { if (possoFareEventi()) openCreate(); return; }
    moodPerCreare = true;
    openMoodDaily();
  };
  const moodSkip = $("#moodSkip");
  if (moodSkip) moodSkip.onclick = () => {
    try { localStorage.setItem("fuori.moodDay", moodDayKey()); } catch {}
    moodPerCreare = false;
    hide("moodDaily");
  };
  const moodCreate = $("#moodCreate");
  if (moodCreate) moodCreate.onclick = () => { if (possoFareEventi()) openCreate(); };
  const moodRefresh = $("#moodRefresh");
  if (moodRefresh) moodRefresh.onclick = () => {
    // altre cinque, subito: non aspetto il quarto d'ora
    moodKick = Math.floor(Math.random() * 900) + 1;
    try {
      const m = leggiIdee();
      if (m.m) delete m.m[moodPick];
      salvaIdee(m);
    } catch {}
    buildIdeas();
    const box = $("#moodIdeas");
    if (box) box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };
  const moodOther = $("#moodOther");
  if (moodOther) moodOther.onclick = () => {
    // nessun umore va bene: tolgo la scelta e porto direttamente alle attività
    moodPick = "";
    try { localStorage.removeItem("fuori.mood"); } catch {}
    paintMood();
    vaiA(document.querySelector(".matrix-wrap"));
  };
  const matrixCreate = $("#matrixCreate");
  if (matrixCreate) matrixCreate.onclick = () => { if (possoFareEventi()) openCreate(); };
  const actJump = $("#actJump");
  if (actJump) actJump.onclick = () => {
    const wrap = $("#actIndexWrap");
    if (wrap) wrap.hidden = false;
    attivaActIndex();
    vaiA(wrap);
  };
  // l'elenco completo resta chiuso in fondo: non si costruisce né si apre
  // scorrendo la home. Si apre solo dal pulsante "Vuoi qualche idea?".
  const actWrap = $("#actIndexWrap");
  if (actWrap) actWrap.hidden = true;
  const actIndex = $("#actIndex");
  if (actIndex) actIndex.onclick = (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    // non filtro gli eventi: apro subito la creazione con questa attività già scelta
    apriCreaCon(b.dataset.act, b.dataset.cat);
  };
  document.querySelectorAll("#share [data-share]").forEach((b) => {
    b.onclick = () => condividiCon(b.dataset.share);
  });
  const heroShare = $("#heroShareBtn");
  if (heroShare) heroShare.onclick = onShare;
  const shareBtnHome = $("#shareHomeBtn");
  if (shareBtnHome) shareBtnHome.onclick = onShare;
  paintInstall();
  try {
    window.matchMedia("(display-mode: standalone)").addEventListener("change", paintInstall);
  } catch {}
  $("#feedbackBtn").onclick = () => show("feedback");
  $("#privacyBtn").onclick = () => show("privacy");
  $("#privacyFeedback").onclick = () => { hide("privacy"); show("feedback"); };
  $("#privacyFromReg").onclick = () => show("privacy");
  $("#meBtn").onclick = () => (person ? openProfile() : openRegister());
  // toccare una foto la apre grande: vale per tutte le foto dell'app
  document.addEventListener(
    "click",
    (e) => {
      const img = e.target.closest && e.target.closest("img");
      if (!img || img.closest("#fotoBig")) return;
      // le foto di scena (le mani della home) non si aprono: non sono contenuti
      if (img.hasAttribute("data-nozoom")) return;
      const url = img.currentSrc || img.src;
      if (!url) return;
      e.preventDefault();
      e.stopPropagation();
      vediFoto(url, img.alt || "", img);
    },
    true
  );
  const fotoBox = $("#fotoBig");
  if (fotoBox) {
    // toccare fuori chiude, le frecce e il dito invece cambiano foto
    fotoBox.addEventListener("click", (e) => {
      e.stopPropagation();
      if (e.target.closest(".fb-nav")) return;
      if (fotoScorsa) return;
      chiudiFoto();
    });
    const fotoPrima = fotoBox.querySelector(".fb-prev");
    const fotoDopo = fotoBox.querySelector(".fb-next");
    if (fotoPrima) fotoPrima.addEventListener("click", (e) => { e.stopPropagation(); mostraFoto(fotoIndice - 1); });
    if (fotoDopo) fotoDopo.addEventListener("click", (e) => { e.stopPropagation(); mostraFoto(fotoIndice + 1); });
    fotoBox.addEventListener(
      "touchstart",
      (e) => {
        const t = e.touches[0];
        if (!t) return;
        fotoToccoX = t.clientX;
        fotoToccoY = t.clientY;
        fotoScorsa = false;
      },
      { passive: true }
    );
    fotoBox.addEventListener(
      "touchmove",
      (e) => {
        const t = e.touches[0];
        if (!t || fotoLista.length < 2) return;
        const dx = t.clientX - fotoToccoX;
        const dy = t.clientY - fotoToccoY;
        if (Math.abs(dx) < 44 || Math.abs(dx) < Math.abs(dy) * 1.3) return;
        mostraFoto(fotoIndice + (dx < 0 ? 1 : -1));
        fotoToccoX = t.clientX;
        fotoToccoY = t.clientY;
        fotoScorsa = true;
        setTimeout(() => { fotoScorsa = false; }, 400);
      },
      { passive: true }
    );
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") return chiudiFoto();
      if (fotoBox.hidden || fotoLista.length < 2) return;
      if (e.key === "ArrowRight") mostraFoto(fotoIndice + 1);
      if (e.key === "ArrowLeft") mostraFoto(fotoIndice - 1);
    });
  }
  $("#createBtn").onclick = () => { if (possoFareEventi()) openCreate(); };
  // sotto gli eventi: il modo per crearne uno, scritto in chiaro
  const creaCta = $("#creaCta");
  if (creaCta) creaCta.onclick = () => { if (possoFareEventi()) openCreate(); };
  // v639: toccarla non la mette a tacere per sempre, apre solo la chat
  $("#aiBtn").onclick = () => { chiudiBolla(); openAi(); };
  const mascotX = $("#mascotClose");
  if (mascotX) mascotX.onclick = (e) => { e.stopPropagation(); nascondiMascotte(true); };
  const mascotB = $("#mascotBubble");
  // v631b: Sì apre la chat e le mostra gli eventi vicini; No chiude e basta
  const mascotSi = $("#mascotSi");
  if (mascotSi) mascotSi.onclick = (e) => { e.stopPropagation(); mascotteRispondi(true); };
  const mascotNo = $("#mascotNo");
  if (mascotNo) mascotNo.onclick = (e) => { e.stopPropagation(); mascotteRispondi(false); };
  const delOk = $("#delOk");
  if (delOk) delOk.onclick = confermaAnnulla;
  mascotteAvvia();
  mascotteUmore("");
  // v639: la mascotte viaggia per l'app e dietro le pillole scorre la pioggia di caratteri
  mfAvvia();
  pioggiaPillole();
  $("#favBtn").onclick = openFav;
  wireNav();
  $("#moreBtn").onclick = () => loadEvents(false);
  const pickLang = (e) => {
    const b = e.target.closest("[data-lang]");
    if (!b) return;
    const code = b.dataset.lang;
    hide("lang");
    if (code !== lang) setLang(code);
  };
  $("#langBtn").onclick = openLang;
  $("#langs").onclick = pickLang;
  const fl = $("#flags");
  if (fl) fl.onclick = pickLang;
  $("#helpBtn").onclick = () => show("help");
  $("#helpLang").onclick = () => { hide("help"); openLang(); };
  $("#helpAccount").onclick = () => { hide("help"); person ? openProfile() : openLogin(); };

  let searchTimer;
  // i due campi hanno il loro ritardo: scrivere in uno non ferma l'altro
  let sugTimer;
  let sugTimerPassati;
  const ordineSel = $("#ordineSel");
  if (ordineSel) {
    ordineSel.value = ordine;
    ordineSel.onchange = () => {
      ordine = ["nuovi", "prima"].includes(ordineSel.value) ? ordineSel.value : "prima";
      localStorage.setItem("fuori.ordine", ordine);
      renderList();
    };
  }

  // la ricerca della home: filtra la lista e intanto suggerisce gli eventi per nome
  const searchEl = $("#search");
  const searchSug = $("#searchSug");
  const searchX = $("#searchX");
  if (searchEl) {
    const aggiorna = () => {
      q = searchEl.value;
      ideaPick = "";
      if (searchX) searchX.hidden = !searchEl.value;
      renderList();
    };
    searchEl.oninput = () => {
      aggiorna();
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { if (!q.trim()) loadEvents(true); }, 400);
      clearTimeout(sugTimer);
      sugTimer = setTimeout(() => cercaSuggerimenti(searchEl.value, searchSug, searchEl, (x) => apriSuggerimento(x, false)), 180);
    };
    searchEl.onkeydown = (e) => sugTasti(e, searchSug, searchEl, (x) => apriSuggerimento(x, false));
    searchEl.onfocus = () => {
      if (searchEl.value.trim().length >= 2 && (!searchSug || searchSug.hidden))
        cercaSuggerimenti(searchEl.value, searchSug, searchEl, (x) => apriSuggerimento(x, false));
    };
    if (searchX) {
      searchX.onmousedown = (e) => e.preventDefault();
      searchX.onclick = () => {
        searchEl.value = "";
        aggiorna();
        chiudiSug(searchSug, searchEl);
        loadEvents(true);
        searchEl.focus();
      };
    }
  }

  // la stessa ricerca dentro i ricordi: il campo assottiglia la lista e suggerisce
  const pastIn = $("#pastSearchIn");
  const pastSug = $("#pastSug");
  const pastX = $("#pastSearchX");
  if (pastIn) {
    pastIn.oninput = () => {
      passatiQ = pastIn.value;
      if (pastX) pastX.hidden = !passatiQ;
      renderPassati();
      clearTimeout(sugTimerPassati);
      sugTimerPassati = setTimeout(() => cercaSuggerimenti(pastIn.value, pastSug, pastIn, (x) => apriSuggerimento(x, true)), 180);
    };
    pastIn.onkeydown = (e) => sugTasti(e, pastSug, pastIn, (x) => apriSuggerimento(x, true));
    pastIn.onfocus = () => {
      if (pastIn.value.trim().length >= 2 && (!pastSug || pastSug.hidden))
        cercaSuggerimenti(pastIn.value, pastSug, pastIn, (x) => apriSuggerimento(x, true));
    };
    if (pastX) {
      pastX.onmousedown = (e) => e.preventDefault();
      pastX.onclick = () => {
        pastIn.value = "";
        passatiQ = "";
        pastX.hidden = true;
        chiudiSug(pastSug, pastIn);
        renderPassati();
        pastIn.focus();
      };
    }
  }

  // toccare fuori dal campo chiude i suggerimenti
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#homeSearch")) chiudiSug(searchSug, searchEl);
    if (!e.target.closest("#pastSearch")) chiudiSug(pastSug, pastIn);
  });

  // la matrice: macro = categoria, micro = attività dentro. Si tocca per filtrare,
  // si tocca di nuovo per togliere. I preferiti sono una tessera come le altre.
  const matrix = $("#catMatrix");
  if (matrix) {
    const apri = (c, a) => {
      const nuovoCat = c || "";
      const nuovoAct = a || "";
      // lo stesso filtro toccato di nuovo si toglie, come gli umori
      const era = cat === nuovoCat && actFilter === nuovoAct;
      cat = era ? "" : nuovoCat;
      actFilter = era ? "" : nuovoAct;
      segnaVisto(cat, actFilter);
      renderCats();
      renderList();
      loadEvents(true);
    };
    matrix.onclick = (e) => {
      const crea = e.target.closest("[data-create]");
      if (crea) { if (possoFareEventi()) openCreate(); return; }
      const act = e.target.closest("[data-act]");
      if (act) { apri(act.dataset.cat, act.dataset.act); return; }
      const fav = e.target.closest("[data-saved]");
      if (fav) { openFav(); return; }
      const macro = e.target.closest("[data-cat]");
      if (!macro) return;
      segnaVisto(macro.dataset.cat);
      renderCats();
      openCatSheet(macro.dataset.cat);
    };
  }

  $("#list").onclick = (e) => {
    const crea = e.target.closest("[data-crea-att]");
    if (crea) { apriCreaCon(crea.dataset.creaAtt, crea.dataset.creaCat); return; }
    const b = e.target.closest("[data-id]");
    if (b) openDetail(b.dataset.id);
  };

  $("#loginBtn").onclick = () => (person ? openProfile() : openLogin());
  $("#loginForm").onsubmit = submitLogin;
  $("#toForgot").onclick = () => {
    const mail = $("#loginForm").email.value.trim();
    hide("login");
    openForgot(mail);
  };
  $("#forgotForm").onsubmit = submitForgot;
  $("#resetForm").onsubmit = submitReset;
  $("#toRegister").onclick = () => { hide("login"); openRegister(); };
  $("#toLogin").onclick = () => { hide("register"); openLogin($("#regForm").email.value); };
  $("#logoutBtn").onclick = logout;
  $("#interestsBtn").onclick = () => { hide("profile"); openInterests(); };
  if ($("#permsBtn")) $("#permsBtn").onclick = () => { hide("profile"); openPerms(); };
  if ($("#verifyBtn")) $("#verifyBtn").onclick = () => { hide("profile"); openVerify(); };
  if ($("#vOpen")) $("#vOpen").onclick = () => vStart();
  if ($("#vDone")) $("#vDone").onclick = () => vSend();
  if ($("#vPick"))
    $("#vPick").onchange = (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (f) vFromFile(f);
    };
  if ($("#statsBtn")) $("#statsBtn").onclick = () => { hide("profile"); openStats(); };
  // il tasto "aggiorna" rifaceva tutto il pannello a ogni tocco, senza dire
  // niente: si toccava tre volte perché sembrava non rispondere
  const ric = $("#statsRefresh");
  if (ric)
    ric.onclick = () => {
      if (ric.dataset.busy === "1") return;
      ric.dataset.busy = "1";
      ric.classList.add("busy");
      Promise.all([loadLive(), loadPeople(), loadSegnalazioni(), loadPushStato()])
        .catch(() => {})
        .finally(() => {
          ric.dataset.busy = "";
          ric.classList.remove("busy");
          toast("Aggiornato");
        });
    };
  if ($("#fotoDaVerificare")) $("#fotoDaVerificare").onclick = openFoto;
  for (const kind of ["geo", "mic", "cam", "gallery", "push"]) {
    const b = $("#perm-" + kind + "-btn");
    if (b) b.onclick = () => askPerm(kind);
  }
  if ($("#permsDone")) $("#permsDone").onclick = () => hide("perms");
  document.querySelectorAll("#verify [data-close]").forEach((b) => b.addEventListener("click", vStopCam));
  $("#createForm").onsubmit = submitCreate;
  const repMode = $("#repMode");
  if (repMode) repMode.onchange = paintRipetizione;
  const vary = $("#repVaryTimes");
  if (vary) vary.onchange = paintOrariDiversi;
  const formCrea = $("#createForm");
  if (formCrea) {
    formCrea.when.addEventListener("change", paintOrariDiversi);
    if (formCrea.endWhen) formCrea.endWhen.addEventListener("change", paintOrariDiversi);
  }
  const weekdayAdd = $("#weekdayAdd");
  if (weekdayAdd) {
    weekdayAdd.onclick = () => {
      const d = Number($("#weekdaySel").value);
      const t = $("#weekdayTime").value || "";
      if (weekdaysList.some((g) => g.d === d)) {
        toastErr("Quel giorno c'è già: toglilo dalle pastiglie se vuoi cambiarlo.");
        return;
      }
      weekdaysList = weekdaysList.concat({ d, t }).sort((a, b) => ((a.d || 7) - (b.d || 7)));
      $("#weekdayTime").value = "";
      paintGiorniScelti();
    };
  }
  const weekdayChips = $("#weekdayChips");
  if (weekdayChips) {
    weekdayChips.onclick = (e) => {
      const b = e.target.closest("[data-toglig]");
      if (!b) return;
      weekdaysList = weekdaysList.filter((_, i) => i !== Number(b.dataset.toglig));
      paintGiorniScelti();
    };
  }
  const dayAdd = $("#dayAdd");
  if (dayAdd) {
    dayAdd.onclick = () => {
      const pick = $("#dayPick");
      const oraScelta = $("#timePick")?.value || "";
      const quando = giornoConOra(pick ? pick.value : "", oraScelta);
      if (!quando) {
        toastErr("Scegli prima la data e l'ora dell'evento, poi aggiungi gli altri giorni.");
        return;
      }
      if (!dayList.includes(quando)) dayList = dayList.concat(quando).sort((a, b) => a - b);
      if (pick) pick.value = "";
      paintGiorniScelti();
    };
  }
  const dayChips = $("#dayChips");
  if (dayChips) {
    dayChips.onclick = (e) => {
      const b = e.target.closest("[data-togli]");
      if (!b) return;
      dayList = dayList.filter((_, i) => i !== Number(b.dataset.togli));
      paintGiorniScelti();
    };
  }
  const ageLoEl = $("#ageMin"), ageHiEl = $("#ageMax");
  if (ageLoEl && ageHiEl) {
    ageLoEl.oninput = paintAge;
    ageHiEl.oninput = paintAge;
    paintAge();
  }
  $("#regForm").onsubmit = submitRegister;
  $("#fbForm").onsubmit = submitFeedback;
  const pushBtn = $("#pushAskBtn");
  if (pushBtn) pushBtn.onclick = () => enablePush();
  const pushNo = $("#pushAskNo");
  if (pushNo)
    pushNo.onclick = () => {
      sessionStorage.setItem("fuori.pushBarOff", "1");
      const bar = $("#pushAsk");
      if (bar) bar.hidden = true;
    };

  $("#chatForm").onsubmit = sendChat;
  buildStickers();
  const stickerBtn = $("#stickerBtn");
  if (stickerBtn)
    stickerBtn.onclick = () => {
      const pad = $("#stickerPad");
      if (!pad) return;
      pad.hidden = !pad.hidden;
      if (!pad.hidden) pad.scrollIntoView({ block: "nearest" });
    };
  const stickerGrid = $("#stickerGrid");
  if (stickerGrid)
    stickerGrid.onclick = (ev) => {
      const b = ev.target.closest("[data-sticker]");
      if (b) sendMedia("sticker", { sticker: b.dataset.sticker });
    };
  // tocco su un messaggio: si apre la fila di emoji per la reaction
  const chatListEl = $("#chatList");
  if (chatListEl)
    chatListEl.onclick = (ev) => {
      const chip = ev.target.closest(".react-chip");
      if (chip) {
        ev.stopPropagation();
        sendReact(chip.dataset.msg, chip.dataset.emoji);
        return;
      }
      const pickBtn = ev.target.closest(".react-pick button");
      if (pickBtn) {
        const holder = pickBtn.closest(".react-pick");
        const msgEl = holder?.previousElementSibling;
        if (msgEl?.dataset.id) sendReact(msgEl.dataset.id, pickBtn.dataset.emoji);
        return;
      }
      const msgEl = ev.target.closest(".msg");
      if (!msgEl) return;
      if (msgEl.nextElementSibling?.classList?.contains("react-pick")) {
        closePicker();
        return;
      }
      openPicker(msgEl);
    };
  const bellBtn = $("#muteBtn");
  if (bellBtn) bellBtn.onclick = () => openMute(chatId || "all");

  $$("[data-mute]").forEach((b) => {
    b.onclick = () => saveMute(b.dataset.mute);
  });
  const chatIn = $("#chatInput");
  if (chatIn) chatIn.addEventListener("input", pingTyping);
  $("#aiForm").onsubmit = askAi;
  $("#mapBtn").onclick = openMap;
  $("#mapShare").onchange = (e) => toggleMapShare(e.target.checked);

  // quali eventi sulla mappa: tutti, i preferiti, o quelli scelti a mano
  const mf = $("#mapFiltro");
  if (mf) {
    mf.onclick = (e) => {
      const b = e.target.closest("[data-mf]");
      if (!b) return;
      if (b.dataset.mf === "scelti") return void apriSceltaMappa();
      // toccare il filtro già scelto lo toglie: si torna a "tutti"
      cambiaFiltroMappa(b.dataset.mf === mapFiltro ? "tutti" : b.dataset.mf);
    };
  }
  const mscelta = $("#mapSceltaOk");
  if (mscelta) {
    mscelta.onclick = () => {
      const ids = [...document.querySelectorAll("#mapSceltaList input:checked")].map((x) => x.value);
      mapScelti = ids;
      localStorage.setItem("fuori.mapScelti", JSON.stringify(mapScelti));
      hide("mapScelta");
      if (!ids.length) {
        toast(t("map.noScelti"));
        return cambiaFiltroMappa("tutti", true);
      }
      cambiaFiltroMappa("scelti", true);
    };
  }
  $("#rosterOpen").onclick = () => {
    const id = mapRosterId;
    hide("roster");
    if (id) openDetail(id);
  };
  $("#mapCanvas").addEventListener("click", (e) => {
    const dir = e.target.closest("[data-dir]");
    if (dir) {
      const ev = mapEvents.find((x) => x.id === dir.dataset.dir);
      if (ev) openDirections(ev);
      return;
    }
    const b = e.target.closest("[data-roster]");
    if (!b) return;
    openRoster(b.dataset.roster);
  });

  if ($("#aiMic")) $("#aiMic").onclick = startVoice;
  $("#aiModes").onclick = (e) => {
    const b = e.target.closest("[data-m]");
    if (b) setAiMode(b.dataset.m);
  };
  if ($("#aiRecBtn")) $("#aiRecBtn").onclick = startVoice;
  if ($("#aiConvBtn")) {
    $("#aiConvBtn").onclick = () => {
      if (!dialogOn) return startDialog();        // primo tocco: comincia la conversazione
      if (dialogAscolto) return fermaTurno();      // rosso: mi fermo e rispondo io
      listenTurn();                                // verde: torna a parlare lui
    };
  }
  $("#aiVoice").onclick = () => {
    voiceOn = !voiceOn;
    localStorage.setItem("fuori.voice", voiceOn ? "1" : "0");
    renderVoice();
    if (!voiceOn) {
      try { fermaVoce(); } catch {}
      try { if (dialogOn) stopDialog(); } catch {}
    }
  };



  $("#profileSave").onclick = saveProfile;
  $("#profileBadges").onclick = () => $("#photoInput").click();
  // se ruoti o cambi schermo, il nome si riproporziona (un solo ascoltatore)
  if (!window.__fuoriNomeFit) {
    window.__fuoriNomeFit = true;
    window.addEventListener("resize", () => { const p = $("#profile"); if (p && !p.hidden) fitProfileName(); });
  }
  $("#photoInput").onchange = (e) => { const f = e.target.files?.[0]; if (f) openCrop(f); e.target.value = ""; };
  $("#cropOk").onclick = confirmCrop;
  $("#cropCancel").onclick = () => hide("crop");
  $("#cropZoom").oninput = (e) => { if (!cropState) return; cropState.z = Number(e.target.value); drawCrop(); };

  $("#catSelect").onchange = () => fillActivityOptions();

  // città in registrazione: suggerimenti mentre scrivi
  const regCity = $("#regCity");
  if (regCity) {
    let rt = null;
    regCity.addEventListener("input", () => {
      const box = $("#regCitySugg");
      const q = regCity.value.trim();
      clearTimeout(rt);
      if (!box) return;
      if (q.length < 2) {
        box.hidden = true;
        return;
      }
      rt = setTimeout(async () => {
        try {
          const r = await api("/geo?q=" + encodeURIComponent(q));
          const rows = (r.results || []).slice(0, 5);
          if (!rows.length) {
            box.hidden = true;
            return;
          }
          box.innerHTML = rows
            .map(
              (p, i) =>
                `<button type="button" class="sugg-i" data-g="${i}"><b>${esc(String(p.name).split(",")[0])}</b><span>${esc(p.full || "")}</span></button>`
            )
            .join("");
          box.hidden = false;
          box.querySelectorAll("[data-g]").forEach((b) => {
            b.onclick = () => {
              regCity.value = String(rows[Number(b.dataset.g)].name).split(",")[0].trim();
              box.hidden = true;
            };
          });
        } catch {
          box.hidden = true;
        }
      }, 250);
    });
    regCity.addEventListener("blur", () => setTimeout(() => { const b = $("#regCitySugg"); if (b) b.hidden = true; }, 150));
  }

  $("#placeInput").oninput = (e) => {
    const q = e.target.value.trim();
    placeGeo = null;
    placeCity = "";
    clearTimeout(placeTimer);
    const box = $("#placeSugg");
    if (q.length < 3) { box.hidden = true; return; }
    placeTimer = setTimeout(async () => {
      box.hidden = false;
      box.innerHTML = `<div class="none">${esc(t("place.searching"))}</div>`;
      try {
        const r = await api("/geo?q=" + encodeURIComponent(q));
        const rows = r.results || [];
        if (!rows.length) {
          box.innerHTML = `<div class="none">${esc(t("place.none"))}</div>`;
          return;
        }
        box.innerHTML = rows
          .map((p, i) => `<button type="button" data-ix="${i}">${esc(p.name)}<br><span class="tiny">${esc(p.full)}</span></button>`)
          .join("");
        box.querySelectorAll("[data-ix]").forEach((b) => {
          b.onclick = () => {
            const p2 = rows[Number(b.dataset.ix)];
            // se la persona ha scritto un civico, non lo perdiamo scegliendo il suggerimento
            let nome = p2.name || "";
            const scritto = $("#placeInput").value.trim();
            const civico = (scritto.match(/(\d{1,4})\s*([a-zA-Z])?\s*$/) || [])[0];
            if (civico && !/\d/.test(nome)) nome = `${nome}, ${civico.replace(/\s+/g, "")}`;
            // la città nel posto scelto: senza, "Via Roma 5" non dice dove
            const citta = String(p2.city || "").trim();
            if (citta && !nome.toLowerCase().includes(citta.toLowerCase())) nome = `${nome}, ${citta}`;
            $("#placeInput").value = nome;
            placeGeo = { lat: p2.lat, lng: p2.lng };
            placeCity = citta || "";
            box.hidden = true;
          };
        });
      } catch {
        box.innerHTML = `<div class="none">${esc(t("place.none"))}</div>`;
      }
    }, 350);
  };

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".pos")) { const b = $("#placeSugg"); if (b) b.hidden = true; }
  });

  $("#createNearBtn").onclick = async () => {
    const p = await locate();
    if (!p) { toast(t("place.nearErr")); return; }
    placeGeo = p;
    useMyPosition(p, { force: true });
    startGeoWatch();
    toast(t("place.nearOk"));
    if (!$("#placeInput").value.trim()) $("#placeInput").focus();
  };

  const range = $("#radiusRange");
  if (range) {
    range.value = String(radiusKm || 0);
    // mentre trascini vedi già i km, senza aspettare che lasci il dito
    range.oninput = () => {
      radiusKm = Number(range.value) || 0;
      updateRadiusLabel();
    };
    range.onchange = applyRadius;
    updateRadiusLabel();
  }

  const cityInp = $("#cityInput");
  if (cityInp) {
    cityInp.value = cityTerm;
    let cityTimer = null;
    cityInp.oninput = (e) => {
      cityTerm = e.target.value.slice(0, 40);
      localStorage.setItem("fuori.city", cityTerm);
      cityCenter = null;
      updateRadiusLabel();
      renderList();
      clearTimeout(cityTimer);
      // suggerimenti mentre scrivi
      clearTimeout(suggTimer);
      const typed = cityTerm;
      suggTimer = setTimeout(() => citySuggest(typed), 220);
      if (cityTerm.trim().length < 3 || radiusKm <= 0) return;
      cityTimer = setTimeout(async () => {
        await findCityCenter();
        updateRadiusLabel();
        renderList();
      }, 450);
    };
    cityInp.onkeydown = (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); moveSugg(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); moveSugg(-1); }
      else if (e.key === "Escape") hideSugg();
      else if (e.key === "Enter" && suggIdx >= 0) { e.preventDefault(); pickSugg(suggIdx); }
    };
    cityInp.onblur = () => setTimeout(hideSugg, 120);
  }

  const cropBox = $("#cropBox");
  let cropDrag = null;
  cropBox.onpointerdown = (e) => {
    if (!cropState) return;
    cropDrag = { x: e.clientX, y: e.clientY, ox: cropState.ox || 0, oy: cropState.oy || 0 };
    cropBox.setPointerCapture?.(e.pointerId);
    cropBox.style.cursor = "grabbing";
  };
  cropBox.onpointermove = (e) => {
    if (!cropDrag || !cropState) return;
    const c = $("#cropCanvas");
    const k = c.width / (cropBox.clientWidth || 1);
    cropState.ox = cropDrag.ox + (e.clientX - cropDrag.x) * k;
    cropState.oy = cropDrag.oy + (e.clientY - cropDrag.y) * k;
    drawCrop();
  };
  const endCropDrag = () => { cropDrag = null; if (cropBox) cropBox.style.cursor = "grab"; };
  cropBox.onpointerup = endCropDrag;
  cropBox.onpointercancel = endCropDrag;

  $("#cookieOnly").onclick = () => chooseConsent("only");
  $("#cookieAll").onclick = () => chooseConsent("all");
  if ($("#welAll")) $("#welAll").onclick = () => welcomeAll();

  $("#onbNext").onclick = () => {
    // primo pezzo del quarto passo: le categorie
    if (onbStep === 3 && !onbCatStep) {
      // nessun minimo: ognuno sceglie quello che gli pare, anche niente
      onbCatStep = true;
      onbTerm = "";
      renderOnboarding();
      return;
    }
    if (onbEdit) { saveInterests(); return; }
    if (onbStep === 3) {
      // nemmeno qui: si va avanti con quante cose si vogliono
      finishOnboarding();
      return;
    }
    onbStep++;
    renderOnboarding();
  };
  $("#onbBack").onclick = () => {
    if (onbEdit) return;
    // dal dettaglio si torna alle categorie
    if (onbStep === 3 && onbCatStep) { onbCatStep = false; renderOnboarding(); return; }
    if (onbStep > 0) { onbStep--; renderOnboarding(); }
  };
  $("#onbSkip").onclick = () => {
    if (onbEdit) { onbEdit = false; onboardingOpen = false; hide("onboarding"); return; }
    onboardingOpen = false;
    localStorage.setItem("fuori.onbDone", "1");
    hide("onboarding");
    openRegister();
  };

  $("#onbBody").onclick = (e) => {
    const cat = e.target.closest("[data-cat]");
    if (cat) {
      const id = cat.dataset.cat;
      if (onbCats.has(id)) onbCats.delete(id); else onbCats.add(id);
      renderOnbCats();
      return;
    }
    const cats = e.target.closest("[data-cats]");
    if (cats) { onbCatStep = false; renderOnboarding(); return; }
    const more = e.target.closest("[data-more]");
    if (more) {
      const id = more.dataset.more;
      if (onbOpen.has(id)) onbOpen.delete(id); else onbOpen.add(id);
      renderTaxonomy();
      return;
    }
    const chip = e.target.closest("[data-chip]");
    if (chip) { toggleOnb(chip.dataset.chip, ONB[onbStep].field); return; }
    const act = e.target.closest("[data-act]");
    if (act) { toggleOnb(act.dataset.act, "interests"); }
  };

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && (!wx || Date.now() - (wx.at || 0) > 30 * 60 * 1000)) loadWeather();
  });

  window.addEventListener("online", () => loadEvents(true));
  window.addEventListener("offline", () => toast(t("toast.offline")));
}

/* ---------- service worker ---------- */
async function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  // la versione nuova entra in servizio senza ricaricare la pagina sotto le mani:
  // chiudendo e riaprendo l'app si vede già aggiornata
  try {
    const reg = await navigator.serviceWorker.register("/sw.js");
    reg.update().catch(() => {});
    reg.addEventListener("updatefound", () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener("statechange", () => {
        if (nw.state === "installed" && navigator.serviceWorker.controller) {
          reg.waiting?.postMessage({ type: "skip" });
        }
      });
    });
    setInterval(() => reg.update().catch(() => {}), 15 * 60 * 1000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") reg.update().catch(() => {});
    });
  } catch {}
}

/* ---------- avvio ---------- */
// le cose che non servono per vedere la prima schermata partono dopo:
// così il codice e la lista non se la giocano la banda con meteo e avvisi
function dopoAvvio(fn, ms = 1200) {
  const run = () => { try { fn(); } catch (e) { console.warn("dopoAvvio", e); } };
  if ("requestIdleCallback" in window) requestIdleCallback(run, { timeout: ms + 2500 });
  else setTimeout(run, ms);
}

async function init() {
  // prima di tutto: l'app è viva. Così l'avvio non sembra mai bloccato.
  window.__fuoriBoot = true;
  // i testi salvati sul telefono: la prima schermata non aspetta la rete
  try { L = load("fuori.langData." + lang, null) || {}; } catch {}
  const caricaLingua = loadLang(lang).catch(async () => { lang = "it"; await loadLang("it").catch(() => {}); });
  // se i testi sono già sul telefono si dipinge subito: la prima schermata non aspetta la rete
  if (Object.keys(L).length > 2) applyStatic();
  await Promise.race([caricaLingua, new Promise((r) => setTimeout(r, 1200))]);
  applyStatic();
  syncMe();
  paintOwner();
  // un pulsante mancante non deve più far cadere tutta l'app
  try { bind(); } catch (e) { console.warn("bind", e); }
  initConsent();
  $("#version").textContent = "v" + VERSION;
  paintOwner();
  paintFav();
  // tutto quello che non dipende dal resto parte insieme: la prima schermata arriva prima
  paintCacheEventi();
  loadEvents(true);
  // su un telefono modesto prima la lista, poi categorie e zone
  if (TELEFONO_LENTO) {
    document.documentElement.classList.add("risparmio");
    dopoAvvio(() => {
      loadTaxonomy().then(() => { renderCats(); paintWeather(); }).catch(() => {});
      loadZones().then(() => paintMood()).catch(() => {});
    }, 400);
  } else {
    loadTaxonomy().then(() => { renderCats(); paintWeather(); }).catch(() => {});
    loadZones().then(() => paintMood()).catch(() => {});
  }
  refreshMe();
  // meteo e avvisi non servono per leggere la prima schermata
  dopoAvvio(() => bootWeather(), TELEFONO_LENTO ? 4000 : 900);
  dopoAvvio(() => startUnread(), TELEFONO_LENTO ? 5000 : 1500);
  dopoAvvio(() => startNotif(), TELEFONO_LENTO ? 6000 : 2000);
  // dice al server "sono aperta": serve a capire se l'app parte davvero
  dopoAvvio(() => api("/open", {
    method: "POST",
    body: JSON.stringify({
      device,
      mode: isStandalone() ? "app" : "browser",
      ua: navigator.userAgent,
      v: VERSION,
      // con test=1 nell'indirizzo sono io che sto provando: non finisce nei numeri
      test: new URLSearchParams(location.search).get("test") === "1" ? 1 : 0,
    }),
  }).catch(() => {}), 1600);
  // il tempo dentro l'app si conta da subito, anche se poi la si chiude
  dopoAvvio(apriSessione, 1200);
  if ("requestIdleCallback" in window) requestIdleCallback(() => registerSW());
  else setTimeout(registerSW, 800);
  // la lista si aggiorna da sola e l'app si accorge quando c'è una versione nuova
  avviaListaViva();
  dopoAvvio(() => controllaVersione(), 2200);
  dopoAvvio(() => moodDailyPrompt(), 700);
  // la Community si prepara in sottofondo: quando la apri ricordi e post sono già lì
  dopoAvvio(() => { if (localStorage.getItem("fuori.onbDone")) loadPast(); }, 1500);
  dopoAvvio(() => { if (localStorage.getItem("fuori.onbDone")) loadFeed(false, true); }, 2100);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    controllaVersione(true);
    if (view === "home" && !document.querySelector(".sheet:not([hidden])")) loadEvents(true);
  });

  // avvisi: se il telefono ha già detto sì, si attivano da soli; se sono spenti lo ricordo.
  // Ognuna di queste cose è un extra: se una fallisce l'app deve comunque partire.
  try { paintPushBar(); } catch {}
  try { ensurePush(); } catch {}
  try { askPushSoon(); } catch {}
  try { syncSaved(); } catch {}
  try { paintTwaBar(); } catch {}
  // un "?" in ogni zona, che apre la guida sulla parte giusta
  try { agganciaAiuti(); } catch {}
  // le spiegazioni dei "?" servono dalla prima schermata: le carico e poi ridisegno le idee
  // le spiegazioni servono solo quando apri un "?": si caricano senza ridisegnare la home
  loadGlossario().catch(() => {});
  const deep = new URLSearchParams(location.search).get("e");
  if (deep) openDetail(deep);
  if (new URLSearchParams(location.search).get("verify")) setTimeout(() => openVerify(), 900);
  if (new URLSearchParams(location.search).get("segnalazioni")) setTimeout(() => openStats(), 700);
  if (new URLSearchParams(location.search).get("sicurezza")) setTimeout(() => openStats(), 700);
  const rt = new URLSearchParams(location.search).get("reset");
  if (rt) openReset(rt);
  else if (!person && !deep && !localStorage.getItem("fuori.onbDone"))
    setTimeout(async () => {
      await loadGlossario();
      await loadTaxonomy();
      startQuick();
    }, 600);

  // aggiornare la pagina non ti riporta alla home: riapro la schermata e i pannelli di prima
  const q = new URLSearchParams(location.search);
  if (!deep && !q.get("verify") && !q.get("reset") && (person || localStorage.getItem("fuori.onbDone"))) {
    if (statoUI.s.length) setTimeout(() => riprendiDoveEri(), 800);
  }

  // la prima volta che apri l'app installata: chiediamo i tre permessi, poi basta
  if (!localStorage.getItem("fuori.permsAsked") && (isInstalled() || location.search.includes("perms"))) {
    setTimeout(() => {
      if ($(".sheet:not([hidden])")) return;
      localStorage.setItem("fuori.permsAsked", "1");
      openPerms();
    }, 2600);
  }
}

// se qualcosa va storto all'avvio non ti lascio con una pagina bianca
function crashMio(perche) {
  try {
    if (document.getElementById("crashBox")) return;
    const box = document.createElement("div");
    box.id = "crashBox";
    box.style.cssText =
      "position:fixed;inset:0;z-index:99999;background:#0a0a0a;color:#fff;display:grid;place-items:center;padding:24px;text-align:center;font:16px system-ui,-apple-system,sans-serif";
    box.innerHTML =
      '<div><p style="font-size:20px;font-weight:700;margin:0 0 10px">Un attimo</p>' +
      '<p style="opacity:.72;margin:0 0 20px;line-height:1.5">Qualcosa non è partito. Tocca Ricarica: sistemo tutto da solo.</p>' +
      '<button id="crashRetry" style="background:#d7ff3e;color:#0a0a0a;border:0;border-radius:999px;padding:14px 26px;font-weight:800;font-size:16px">Ricarica</button>' +
      (perche ? '<p style="opacity:.35;margin:18px 0 0;font-size:12px">' + String(perche).slice(0, 120) + "</p>" : "") +
      "</div>";
    document.body.appendChild(box);
    box.querySelector("#crashRetry").onclick = () => {
      const pulisci = [];
      try { pulisci.push(caches.keys().then((k) => Promise.all(k.map((n) => caches.delete(n))))); } catch {}
      try {
        pulisci.push(navigator.serviceWorker.getRegistrations().then((rs) => Promise.all(rs.map((r) => r.unregister()))));
      } catch {}
      Promise.all(pulisci).finally(() => location.replace(location.pathname + "?fresh=" + Date.now()));
    };
  } catch {}
}

window.addEventListener("error", (e) => {
  if (!window.__fuoriBoot) crashMio(e && e.message ? e.message : "");
});
window.addEventListener("unhandledrejection", () => {
  if (!window.__fuoriBoot) crashMio("");
});

function avvia() {
  try {
    const r = init();
    if (r && typeof r.catch === "function") r.catch((e) => crashMio(e && e.message));
  } catch (e) {
    crashMio(e && e.message);
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", avvia);
else avvia();


/* ---------- tre pagine: home, community, profilo ---------- */

let view = "home";
let feedPosts = [];
let feedNext = null;
let feedBusy = false;
let cmPostId = "";
let postData = "";

function meEmail() {
  return person && person.email ? String(person.email).toLowerCase() : "";
}

function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  return (((parts[0] || "?")[0] || "?") + ((parts[1] || "")[0] || "")).toUpperCase();
}

function agoTime(ts) {
  const d = Date.now() - Number(ts || 0);
  if (d < 60000) return t("feed.now");
  const m = Math.floor(d / 60000);
  if (m < 60) return t("feed.min", { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t("feed.hour", { n: h });
  const g = Math.floor(h / 24);
  if (g < 7) return t("feed.day", { n: g });
  return fmtWhen(ts);
}

function pushStep(tag) {
  try {
    history.pushState({ fuori: tag }, "");
  } catch {}
}

function paintNav() {
  document.querySelectorAll(".tab[data-view]").forEach((b) => {
    b.classList.toggle("on", b.dataset.view === view);
  });
}

/* ---------- cosa toccano: serve al padrone ---------- */
let peekQueue = [];
let peekTimer = null;
function peek(cosa, su) {
  try {
    if (!device) return;
    peekQueue.push({ k: String(cosa).slice(0, 24), d: String(su == null ? "" : su).slice(0, 80) });
    if (peekQueue.length >= 12) flushPeek();
    else if (!peekTimer) peekTimer = setTimeout(flushPeek, 6000);
  } catch {}
}
function flushPeek() {
  try { clearTimeout(peekTimer); } catch {}
  peekTimer = null;
  const items = peekQueue.splice(0, 12);
  if (!items.length) return;
  const body = JSON.stringify({ device, items });
  try {
    const blob = new Blob([body], { type: "application/json" });
    if (navigator.sendBeacon && navigator.sendBeacon("/api/peek", blob)) return;
  } catch {}
  api("/peek", { method: "POST", body }).catch(() => {});
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) flushPeek();
});

// quanti giorni fa: "oggi", "ieri", "3 giorni fa"
function quandoFa(ts) {
  const g = Math.floor((Date.now() - Number(ts || 0)) / 864e5);
  if (g <= 0) return t("past.oggi");
  if (g === 1) return t("past.ieri");
  return t("past.giorni", { n: g });
}

let pastCaricati = 0;
let pastLetto = false;
let passatiVoti = [];
let pastPadrone = false;
let pastInCorso = null;

// i generi che non mi piacciono di una persona: "chi organizza|categoria"
let evitati = load(K.evitati, {}) || {};

function bumpEvitato(p, on) {
  const chi = String((p && p.host) || "").trim();
  if (!chi) return;
  const k = chi + "|" + String(p.cat || "");
  if (on) {
    evitati[k] = Date.now();
    toast(t("voti.meno"));
  } else {
    delete evitati[k];
  }
  save(K.evitati, evitati);
  renderList();
}

function stelleHtml(n, id) {
  const piene = Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
  const stelle = [1, 2, 3, 4, 5]
    .map((i) =>
      id
        ? `<button class="st ${i <= piene ? "on" : ""}" type="button" data-stelle="${i}" data-ev="${esc(id)}" aria-label="${i}">★</button>`
        : `<span class="st ${i <= piene ? "on" : ""}" aria-hidden="true">★</span>`
    )
    .join("");
  return `<span class="sts">${stelle}</span>`;
}

function giornoBreve(ms) {
  try { return new Intl.DateTimeFormat(LOCALES[lang], { day: "numeric", month: "short" }).format(new Date(ms)); } catch { return ""; }
}

// la categoria di un ricordo anche quando non è salvata: la ricavo dal nome
const CAT_REGOLE = [
  [/yoga|meditazion|spa|sauna|massagg|benessere|respiraz|pilates|stretch/, "benessere"],
  [/corsa|calcio|padel|tennis|palestra|bici|nuoto|trekking|escursion|sport|arrampic/, "sport"],
  [/musica|concerto|live|jazz|dj|karaoke|coro|band/, "musica"],
  [/cinema|film|teatro|museo|mostra|libro|arte|fotografia|cultura/, "cinema"],
  [/cena|pranzo|aperitivo|pizza|vino|birra|cucin|food|brunch|caffè|gelato/, "serate"],
  [/gioco|giochi|quiz|biliardo|bowling|scacchi|escape|laser/, "giochi"],
  [/pittura|disegno|ceramica|fotografia creativa|creativ|scrittura|musica/, "creativita"],
  [/mare|montagna|parco|natura|orto|giardin|picnic|campeggio/, "natura"],
  [/cane|gatto|animal|pet/, "animali"],
  [/volontariato|pulizia|raccolta|aiuto|donazion/, "volontariato"],
  [/lingua|inglese|spagnolo|conversazione/, "lingue"],
  [/viaggio|gita|tour|visita/, "viaggi"],
  [/code|tech|computer|robot|coding/, "tech"],
  [/conoscere|incontro|amici|gruppo|community/, "sociale"],
];
function catDaTesto(txt) {
  const s = String(txt || "").toLowerCase();
  for (const [re, id] of CAT_REGOLE) if (re.test(s)) return id;
  return "creativita";
}

// emoji per l'evento specifico: prima le cose precise (Natale, Etna), poi il genere
const EMO_EVENTO = [
  [/natale|albero|presepe|babbo/, "🎄"],
  [/autunno/, "🍂"],
  [/etna|vulcan|crater|lava/, "🌋"],
  [/tramonto|alba\b/, "🌅"],
  [/festa|party|compleanno|festegg/, "🥳"],
  [/fontana|grafica|linguagg/, "🎨"],
  [/schiena|trek|escursion|sentiero|camminat|passeggi|montagna|trail/, "🥾"],
  [/mare|spiaggia|snorkel|bagno|bagni/, "🏖️"],
  [/barca|vela|kayak|\bsup\b/, "⛵"],
  [/pizza/, "🍕"],
  [/aperitivo|vino|birra|cocktail|drink/, "🍷"],
  [/gelato/, "🍦"],
  [/caff[eè]|colazion|brunch/, "☕"],
  [/cena|pranzo|ristor|cucin|food|pasta/, "🍽️"],
  [/karaoke/, "🎤"],
  [/concerto|live|jazz|band|\bdj\b/, "🎸"],
  [/musica|coro/, "🎶"],
  [/cinema|film|cineforum/, "🎬"],
  [/teatro|cabaret|stand ?up|spettacol/, "🎭"],
  [/comics|fumett|libro|lettura|book|poesia/, "📚"],
  [/museo|mostra|arte|galleria/, "🖼️"],
  [/foto/, "📸"],
  [/pittura|ceramica|disegno|creativ|scrittura|murales/, "✏️"],
  [/calcio/, "⚽"],
  [/padel|tennis/, "🎾"],
  [/basket/, "🏀"],
  [/corsa|running|maratona/, "🏃"],
  [/bici|ciclo/, "🚴"],
  [/nuoto|piscina/, "🏊"],
  [/arrampic|boulder/, "🧗"],
  [/yoga|pilates|medit|palestra|benessere/, "🧘"],
  [/gioc|quiz|biliardo|bowling|scacchi|escape|laser/, "🎲"],
  [/cane|gatto|animal|pet/, "🐾"],
  [/volontari|pulizia|raccolta|donazion/, "🌱"],
  [/lingu|inglese|spagnolo|conversazione/, "🗣️"],
  [/viaggi|gita|tour|visita/, "🧳"],
  [/code|tech|computer|robot|coding/, "💻"],
  [/picnic|parco|giardin|orto/, "🧺"],
  [/bosco|campeggio|natura|montagn/, "🌲"],
  [/incontr|amici|conoscere|community|gruppo|sociale/, "🤝"],
];
const EMO_CATEGORIA = {
  sport: "🏅", musica: "🎶", cinema: "🎬", natura: "🌲", benessere: "🧘", serate: "🍸",
  sociale: "🤝", viaggi: "🧳", animali: "🐾", creativita: "🎨", giochi: "🎲",
  volontariato: "🌱", lingue: "🗣️", tech: "💻",
};
function emojiRicordo(p, cat) {
  const txt = `${p.titolo || ""} ${p.att || ""}`.toLowerCase();
  for (const [re, e] of EMO_EVENTO) if (re.test(txt)) return e;
  return EMO_CATEGORIA[cat] || "✨";
}

// la copertina di un ricordo senza foto: gradiente + emoji dell'evento, mai vuota
function copertinaRicordo(p, grande) {
  const cat = p.cat || catDaTesto((p.att || "") + " " + (p.titolo || ""));
  return `<span class="past-cover${grande ? " past-cover--big" : ""}" data-cat="${esc(cat)}" aria-hidden="true">
    <span class="pc-emo">${emojiRicordo(p, cat)}</span><i>${esc(catName(cat) !== cat ? catName(cat) : "")}</i></span>`;
}

// una riga di ricordo: si tocca e si apre tutto (foto, voti, com'è andata)
function pastCard(p) {
  const v = p.voti || { media: 0, stelle: 0, like: 0, dislike: 0, mio: 0, mie: 0 };
  const dove = [p.luogo, p.citta].filter(Boolean).join(", ");
  return `<button class="pcard pcard--mini" type="button" data-past="${esc(p.id)}">
    ${p.foto
      ? `<img class="pcard-foto" src="${esc(p.foto)}" alt="" loading="lazy" decoding="async">`
      : copertinaRicordo(p)}
    <span class="pcard-t">
      <b>${esc(p.titolo || t("past.generico"))}</b>
      <span class="pcard-sub">${p.privato && !p.luogo ? `<span class="pcard-priv">🔒 ${esc(t("past.privato"))}</span> · ` : `${esc(dove)}${dove ? " · " : ""}`}${esc(giornoBreve(p.quando))}${p.persone ? ` · ${esc(t("past.persone", { n: p.persone }))}` : ""}</span>
      <span class="pcard-voto">${v.mie ? `<span class="pv-mine">★ ${v.mie}/5</span> · ` : ""}${v.stelle ? `${v.stelle} ${v.stelle === 1 ? "voto" : "voti"}` : esc(t("voti.nessuno"))}</span>
    </span>
    <span class="pcard-go" aria-hidden="true">›</span>
  </button>`;
}

// ---- la ricerca mentre si scrive --------------------------------------------
// un solo motore per la home e per i ricordi: scrivi, e sotto arrivano i nomi
function piega(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function dataSug(ms) {
  const n = Number(ms) || 0;
  if (!n) return "";
  return new Date(n).toLocaleDateString("it-IT", { day: "numeric", month: "short" });
}

let sugSeq = 0;
const sugStato = new WeakMap();

function chiudiSug(out, input) {
  if (!out) return;
  out.classList.remove("up");
  out.hidden = true;
  out.innerHTML = "";
  if (input) input.setAttribute("aria-expanded", "false");
  sugStato.delete(out);
}

async function cercaSuggerimenti(testo, out, input, scegli) {
  const scritto = String(testo || "").trim();
  if (!out) return;
  if (scritto.length < 2) return chiudiSug(out, input);
  const mio = ++sugSeq;
  out.hidden = false;
  if (input) input.setAttribute("aria-expanded", "true");
  // se sotto il campo c'è poco spazio i suggerimenti salgono sopra: si vedono lo stesso
  if (input) {
    const r = input.getBoundingClientRect();
    const sotto = window.innerHeight - r.bottom;
    out.classList.toggle("up", sotto < 260 && r.top > sotto);
  }
  out.innerHTML = `<p class="sg-wait">${esc(t("search.wait"))}</p>`;
  let r;
  try {
    r = await api("/search?q=" + encodeURIComponent(scritto) + "&device=" + encodeURIComponent(device));
  } catch {
    if (mio === sugSeq) out.innerHTML = `<p class="sg-wait">${esc(t("toast.error"))}</p>`;
    return;
  }
  if (mio !== sugSeq) return;
  const voci = [
    ...(r.events || []).map((x) => ({ ...x, tipo: "ev" })),
    ...(r.past || []).map((x) => ({ ...x, tipo: "past" })),
  ];
  if (!voci.length) {
    out.innerHTML = `<p class="sg-wait">${esc(t("search.none", { q: scritto }))}</p>`;
    sugStato.delete(out);
    return;
  }
  const riga = (x, i) => {
    const sotto = [dataSug(x.when), x.place || "", x.joined ? t("search.people", { n: x.joined }) : ""]
      .filter(Boolean)
      .join(" · ");
    return `<button class="sg-i" type="button" role="option" data-sg="${i}">
      <span class="sg-main"><b>${esc(x.title || "—")}</b>${sotto ? `<i>${esc(sotto)}</i>` : ""}</span>
      <span class="sg-go" aria-hidden="true">›</span>
    </button>`;
  };
  const gruppo = (titolo, lista) =>
    lista.length ? `<p class="sg-sec">${esc(t(titolo))}</p>${lista.map((x) => riga(x, voci.indexOf(x))).join("")}` : "";
  out.innerHTML =
    gruppo("search.soon", voci.filter((x) => x.tipo === "ev")) +
    gruppo("search.past", voci.filter((x) => x.tipo === "past"));
  sugStato.set(out, { voci, scelto: -1, scegli });
  out.querySelectorAll("[data-sg]").forEach((b) => {
    // senza questo il campo perderebbe il fuoco prima del tocco
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = () => {
      const x = voci[Number(b.dataset.sg)];
      if (!x) return;
      chiudiSug(out, input);
      scegli(x);
    };
  });
}

function sugTasti(e, out, input, scegli) {
  const st = out ? sugStato.get(out) : null;
  if (!st || !st.voci.length) return;
  const n = st.voci.length;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (st.scelto < 0) st.scelto = e.key === "ArrowDown" ? 0 : n - 1;
    else st.scelto = (st.scelto + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
    out.querySelectorAll("[data-sg]").forEach((b) => b.classList.toggle("on", Number(b.dataset.sg) === st.scelto));
    const att = out.querySelector("[data-sg].on");
    if (att) att.scrollIntoView({ block: "nearest" });
    return;
  }
  if (e.key === "Escape") return chiudiSug(out, input);
  if (e.key === "Enter" && st.scelto >= 0) {
    e.preventDefault();
    const x = st.voci[st.scelto];
    chiudiSug(out, input);
    scegli(x);
  }
}

// un suggerimento scelto: l'evento si apre, il ricordo pure (caricandolo se serve)
function apriSuggerimento(x, daiRicordi) {
  if (!x) return;
  if (x.tipo !== "past") {
    if (daiRicordi) hide("passati");
    openDetail(x.id);
    return;
  }
  const vai = () => {
    if (daiRicordi) hide("passati");
    openPast(x.id);
  };
  if (passatiVoti.some((p) => p.id === x.id)) return vai();
  loadPast()
    .then(() => {
      if (passatiVoti.some((p) => p.id === x.id)) vai();
      else toastErr(t("toast.error"));
    })
    .catch(() => toastErr(t("toast.error")));
}

// dentro la community i ricordi stanno in una cartella: gli ultimi tre e "vedi tutti"
let passatiAperti = false;

function paintPastFolder() {
  const box = $("#pastBox");
  if (!box) return;
  if (!passatiVoti.length) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.innerHTML = `<div class="past-folder">
    <div class="past-folder-top">
      <span class="pf-ico" aria-hidden="true">🗂</span>
      <span class="pf-txt"><b>${esc(t("past.folder"))}</b><i>${esc(t("past.folderSub"))}</i></span>
      <span class="pf-n">${passatiVoti.length}</span>
    </div>
    <div class="pcards pcards--h">${passatiVoti.slice(0, 8).map(pastCard).join("")}</div>
    <button class="past-go" type="button" data-past-all="1">${esc(t("past.vediTutti"))} <span class="past-go-n">${passatiVoti.length}</span> ›</button>
  </div>`;
  box.hidden = false;
  box.querySelectorAll("[data-past]").forEach((b) => { b.onclick = () => openPast(b.dataset.past); });
  const all = box.querySelector("[data-past-all]");
  if (all) all.onclick = openPassati;
}

async function loadPast() {
  const box = $("#pastBox");
  if (!box) return;
  if (pastLetto && Date.now() - pastCaricati < 60000) return paintPastFolder();
  // se la richiesta è già partita (prefetch o ingresso in Community) aspetto quella
  if (pastInCorso) return pastInCorso;
  pastCaricati = Date.now();
  pastInCorso = (async () => {
    try {
      const qs = new URLSearchParams({ full: "1", limit: "200", device });
      if (meEmail()) qs.set("email", meEmail());
      const d = await api("/past?" + qs.toString());
      passatiVoti = d.passati || [];
      pastLetto = true;
      pastPadrone = Boolean(d.padrone);
      paintPastFolder();
      if (passatiAperti) renderPassati();
    } catch {
      box.hidden = true;
    } finally {
      pastInCorso = null;
    }
  })();
  return pastInCorso;
}

let passatiFiltro = "recenti";
let passatiQ = "";

function openPassati() {
  passatiAperti = true;
  // ogni volta si riparte dal campo vuoto: i ricordi sono tutti lì
  const inp = $("#pastSearchIn");
  if (inp) inp.value = "";
  passatiQ = "";
  const x = $("#pastSearchX");
  if (x) x.hidden = true;
  chiudiSug($("#pastSug"), inp);
  renderPassati();
  show("passati");
}

function passatiScelti() {
  let list = passatiVoti.slice();
  const f = passatiFiltro;
  // quello che scrivi vale anche qui: i ricordi si assottigliano mentre digiti
  const teso = piega(passatiQ).trim();
  if (teso)
    list = list.filter((p) =>
      piega([p.titolo, p.att, p.luogo, p.citta, catName(p.cat)].join(" ")).includes(teso)
    );
  if (f === "preferiti") list = list.filter((p) => savedIds.includes(p.id));
  else if (f === "passioni") {
    const gusti = new Set(
      [
        ...((person && person.interests) || []),
        ...Object.keys(taste.a || {}),
        ...Object.keys(taste.c || {}),
      ].map((x) => String(x).toLowerCase())
    );
    list = list.filter(
      (p) => gusti.has(String(p.att || "").toLowerCase()) || gusti.has(String(catName(p.cat) || "").toLowerCase())
    );
  } else if (f.indexOf("cat:") === 0) {
    const id = f.slice(4);
    list = list.filter((p) => p.cat === id);
  }
  if (f === "voto") list.sort((a, b) => ((b.voti && b.voti.media) || 0) - ((a.voti && a.voti.media) || 0) || (b.quando || 0) - (a.quando || 0));
  else list.sort((a, b) => (b.quando || 0) - (a.quando || 0));
  return list;
}

function renderPassati() {
  const filtri = $("#passatiFiltri");
  const box = $("#passatiList");
  if (!filtri || !box) return;
  const cats = [...new Set(passatiVoti.map((p) => p.cat).filter(Boolean))];
  const chips = [
    ["recenti", t("past.filtroRecenti")],
    ["voto", t("past.filtroVoto")],
    ["preferiti", t("past.filtroFav")],
    ["passioni", t("past.filtroPassioni")],
    ...cats.map((c) => ["cat:" + c, catName(c)]),
  ];
  filtri.innerHTML = chips
    .map(([k, label]) => `<button class="chip ${passatiFiltro === k ? "on" : ""}" type="button" data-pf="${esc(k)}">${k === "preferiti" ? heartIcon(true) : ""}${esc(label)}</button>`)
    .join("");
  filtri.querySelectorAll("[data-pf]").forEach((b) => {
    // ritoccare il filtro attivo lo toglie: si torna ai più recenti
    b.onclick = () => { passatiFiltro = passatiFiltro === b.dataset.pf && b.dataset.pf !== "recenti" ? "recenti" : b.dataset.pf; renderPassati(); };
  });
  const list = passatiScelti();
  const vuoto = passatiQ.trim()
    ? t("search.none", { q: passatiQ.trim() })
    : passatiFiltro === "preferiti"
      ? t("past.favEmpty")
      : t("past.passEmpty");
  box.innerHTML = list.length ? list.map(pastCard).join("") : `<div class="empty"><b>${esc(vuoto)}</b></div>`;
  box.querySelectorAll("[data-past]").forEach((b) => { b.onclick = () => openPast(b.dataset.past); });
}

// l'evento passato si apre per intero: le foto, chi c'era, e sotto le recensioni
function openPast(id) {
  const p = passatiVoti.find((x) => x.id === id);
  if (!p) return;
  const box = $("#pastDetailBody");
  if (!box) return;
  const v = p.voti || { media: 0, stelle: 0, like: 0, dislike: 0, mio: 0, mie: 0 };
  const dove = [p.luogo, p.citta].filter(Boolean).join(", ");
  // se il ricordo non ha foto sue, mostro quelle che la community ha taggato con lui
  const com = Array.isArray(p.communityFotos) ? p.communityFotos : [];
  const comN = Number(p.communityN || com.length) || 0;
  const sue = Array.isArray(p.fotos) && p.fotos.length;
  const daCommunity = !sue && com.length > 0;
  const foto = sue
    ? `<div class="det-photos">${p.fotos.map((u) => `<img src="${esc(u)}" alt="${esc(t("detail.photos"))}" loading="lazy" decoding="async">`).join("")}</div>`
    : com.length
      ? `<div class="det-photos det-photos-tag">${com.map((u) => `<img src="${esc(u)}" alt="${esc(t("detail.photos"))}" loading="lazy" decoding="async">`).join("")}</div>`
      : copertinaRicordo(p, true);
  // il tag del ricordo: la sua raccolta di foto, e per chi c'era il modo di aggiungerne
  const possoTag = Boolean(p.elenco && p.elenco.some((x) => x.io));
  const communityBlocco = comN || possoTag
    ? `<div class="evcom">
        <div class="evcom-top"><span class="evcom-tag">#${esc(p.titolo || t("past.generico"))}</span>${comN ? `<span class="evcom-n">${esc(t("com.n", { n: comN }))}</span>` : ""}</div>
        ${!daCommunity && com.length ? `<div class="evcom-grid">${com.map((u) => `<img class="evcom-ph" src="${esc(u)}" alt="" loading="lazy" decoding="async">`).join("")}</div>` : ""}
        ${possoTag ? `<button class="evcom-add" id="pastComAdd" type="button"><span aria-hidden="true">+</span>${esc(t("com.add"))}</button>` : ""}
        ${comN ? "" : `<p class="evcom-sub">${esc(t("com.none"))}</p>`}
      </div>`
    : "";
  box.innerHTML = `
    <button class="x" data-close type="button" aria-label="Chiudi">×</button>
    <div class="det-tags"><span class="tag">${esc(catName(p.cat))}</span><span class="when">${esc(giornoBreve(p.quando))} · ${esc(t("past.eventoPassato"))}</span></div>
    <h2 class="det-title">${esc(p.titolo || t("past.generico"))}</h2>
    ${(p.modificabile || pastPadrone) ? `<button class="btn ghost wide" id="pastEditBtn" type="button">Modifica il ricordo</button>` : ""}
    ${foto}
    ${communityBlocco}
    <p class="det-sub">${esc(dove)}${p.persone ? `${dove ? " · " : ""}${esc(t("past.persone", { n: p.persone }))}` : ""}</p>
    ${p.att ? `<p class="hint">${esc(p.att)}</p>` : ""}
    ${p.privato && !p.luogo ? `<p class="hint priv-note">🔒 ${esc(t("past.privatoNota"))}</p>` : ""}
    ${p.descrizione ? `<div class="det-desc"><p class="sec">${esc(t("past.descrizione"))}</p><p class="body">${esc(p.descrizione)}</p></div>` : ""}
    ${Array.isArray(p.elenco) && p.elenco.length
      ? `<div class="det-desc"><p class="sec">Chi c'era</p><div class="chi-cera">${p.elenco
          .map((q) => `<span class="chi${q.io ? " io" : ""}">${esc(q.nome)}${q.io ? " (tu)" : ""}</span>`)
          .join("")}</div></div>`
      : p.posso
        ? `<p class="hint">Nessun nome registrato per questo ricordo.</p>`
        : `<p class="hint">🔒 L'elenco di chi c'era lo vedono solo le persone che hanno partecipato.</p>`}
    <p class="sec">${esc(t("past.recensioni"))}</p>
    <div class="rec-box">
      <div class="rec-media">${v.stelle ? `<b>${esc(String(v.media))}</b><span>${esc(t("voti.su5", { n: v.stelle }))}</span>` : `<b>–</b><span>${esc(t("voti.nessuno"))}</span>`}</div>
      <div class="rec-stelle">${stelleHtml(v.mie || 0, p.posso ? p.id : "")}<span class="why" data-why="ricordi.voto" aria-hidden="true">?</span></div>
      ${v.stelle ? `<span class="rec-voti">${v.stelle} ${v.stelle === 1 ? "voto" : "voti"}${v.media ? ` · media ${v.media}` : ""}${v.mie ? ` · il tuo: ${v.mie}/5` : ""}</span>` : ""}
      ${p.posso
        ? `<div class="pcard-voti rec-pollice">
            <button class="pv up ${v.mio === 1 ? "on" : ""}" type="button" data-pvoto="1" data-ev="${esc(p.id)}">👍 ${esc(t("voti.like"))}</button>
            <button class="pv down ${v.mio === -1 ? "on" : ""}" type="button" data-pvoto="-1" data-ev="${esc(p.id)}">👎 ${esc(t("voti.dislike"))}</button>
          </div>`
        : `<p class="hint">${esc(t("past.soloChi"))}</p>`}
      <p class="hint">${esc(t("past.recensioniNota"))}</p>
    </div>`;
  box.querySelectorAll("[data-close]").forEach((b) => { b.onclick = () => hide("pastDetail"); });
  // due tocchi sulla stessa stella (o sullo stesso pollice) annullano il voto
  box.querySelectorAll("[data-stelle]").forEach((b) => {
    b.onclick = () => {
      const s = Number(b.dataset.stelle);
      votaPassato(b.dataset.ev, v.mio || 0, s === (v.mie || 0) ? 0 : s);
    };
  });
  box.querySelectorAll("[data-pvoto]").forEach((b) => {
    b.onclick = () => {
      const pv = Number(b.dataset.pvoto);
      votaPassato(b.dataset.ev, pv === v.mio ? 0 : pv, v.mie || 0);
    };
  });
  const changeBtn = box.querySelector("#pastEditBtn");
  if (changeBtn) changeBtn.onclick = () => openPastEdit(p);
  const addTag = box.querySelector("#pastComAdd");
  if (addTag) addTag.onclick = () => openPostTag(p.id, p.titolo);
  show("pastDetail");
  ricordaPannello("pastDetail", { ev: id });
}

// le foto di un ricordo: si vedono subito e si possono aggiungere o togliere
// anche quando l'evento passato non ne aveva nessuna
let fotoRicordo = [];
// quante foto si stanno ancora caricando: il ricordo non si salva a metà
let fotoInCorso = 0;

function disegnaFotoRicordo() {
  const box = $("#pastPhotos");
  const add = $("#pastPhotoAdd");
  const inp = $("#pastPhotoInput");
  if (!box) return;
  box.innerHTML = fotoRicordo
    .map(
      (k, i) =>
        `<div class="ph"><img src="/api/photo/${esc(k)}" alt="" loading="lazy" decoding="async"><span class="ph-n">${i + 1}</span><button type="button" data-nophoto-ricordo="${i}" aria-label="${esc(t("create.photoRemove"))}">×</button></div>`
    )
    .join("");
  if (add) {
    add.hidden = fotoRicordo.length >= 3;
    add.innerHTML = `<span class="pp-plus" aria-hidden="true">+</span>
      <span class="pp-t"><b>${esc(t(fotoRicordo.length ? "create.photoMore" : "create.photoAdd2"))}</b>
      <i>${esc(t("create.photoSub", { n: fotoRicordo.length }))}</i></span>`;
    add.onclick = () => {
      if (fotoRicordo.length >= 3) return toast(t("create.photoMax"));
      apriSceltaFoto("past");
    };
  }
  box.querySelectorAll("[data-nophoto-ricordo]").forEach((b) => {
    b.onclick = () => {
      fotoRicordo.splice(Number(b.dataset.nophotoRicordo), 1);
      disegnaFotoRicordo();
    };
  });
  if (inp) {
    inp.onchange = async () => {
      const files = [...(inp.files || [])];
      inp.value = "";
      for (const f of files) {
        if (fotoRicordo.length >= 3) { toast(t("create.photoMax")); break; }
        await aggiungiFotoRicordo(f);
      }
    };
  }
}

async function aggiungiFotoRicordo(file) {
  fotoInCorso += 1;
  const box = $("#pastPhotos");
  let segnaposto = null;
  if (box) {
    segnaposto = document.createElement("div");
    segnaposto.className = "ph loading";
    segnaposto.textContent = "…";
    box.appendChild(segnaposto);
  }
  try {
    let data = await riduciFoto(file);
    for (let i = 0; i < 2 && data.length > 380 * 1024; i++) data = await riduciFoto(file, 1100 - i * 300, 0.7);
    const r = await api("/event/photo", { method: "POST", body: JSON.stringify({ device, data }) });
    if (!r || !r.key) throw new Error((r && r.error) || "foto");
    fotoRicordo.push(r.key);
  } catch (e) {
    toast(String((e && e.message) || "").slice(0, 120) || t("create.photoMax"));
  } finally {
    fotoInCorso = Math.max(0, fotoInCorso - 1);
    if (segnaposto) segnaposto.remove();
    disegnaFotoRicordo();
  }
}

// chi ha creato il ricordo o il padrone sistema tutto: quello che scrive resta nei ricordi
function openPastEdit(p) {
  if (!p) return;
  const f = $("#pastEditForm");
  if (!f) return;
  fotoRicordo = (Array.isArray(p.fotos) && p.fotos.length ? p.fotos : (p.foto ? [p.foto] : []))
    .map((u) => String(u).split("/").pop())
    .filter(Boolean)
    .slice(0, 3);
  disegnaFotoRicordo();
  const pad = (n) => String(n).padStart(2, "0");
  const d = new Date(Number(p.quando) || Date.now());
  f.title.value = p.titolo || "";
  f.description.value = p.descrizione || "";
  f.place.value = p.posto || p.luogo || "";
  f.city.value = p.citta || "";
  f.activity.value = p.att || "";
  f.host.value = p.host || "";
  f.when.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const cats = (taxonomy && taxonomy.categories) || [];
  const scelte = cats.length ? cats : [{ id: p.cat }];
  f.category.innerHTML = scelte.map((c) => `<option value="${esc(c.id)}">${esc(catName(c.id))}</option>`).join("");
  f.category.value = p.cat || (scelte[0] && scelte[0].id) || "";
  const err = $("#pastEditErr");
  if (err) err.hidden = true;
  f.onsubmit = async (e) => {
    e.preventDefault();
    const quando = f.when.value ? new Date(f.when.value).getTime() : Number(p.quando) || 0;
    const btn = f.querySelector('button[type="submit"]');
    const err0 = $("#pastEditErr");
    // la foto deve essere arrivata al server prima di salvare, sennò il ricordo
    // si scrive senza e la foto sembra sparita
    if (fotoInCorso > 0) {
      if (err0) {
        err0.textContent = "La foto si sta ancora caricando: aspetta un attimo e poi salva.";
        err0.hidden = false;
      }
      return;
    }
    if (btn) btn.disabled = true;
    try {
      await api(`/past/${p.id}`, {
        method: "POST",
        body: JSON.stringify({
          device,
          title: f.title.value.trim(),
          description: f.description.value.trim(),
          place: f.place.value.trim(),
          city: f.city.value.trim(),
          activity: f.activity.value.trim(),
          host: f.host.value.trim(),
          category: f.category.value,
          startsAt: quando,
          photos: fotoRicordo.slice(0, 3),
        }),
      });
      peek("ricordo_modificato", f.title.value.trim());
      hide("pastEdit");
      toast("Salvato");
      pastCaricati = 0;
      await loadPast();
      openPast(p.id);
    } catch (e2) {
      if (err) {
        err.textContent = (e2 && e2.data && e2.data.error) || t("toast.error");
        err.hidden = false;
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  };
  show("pastEdit");
}

// il voto si può cambiare quando vuoi: conta l'ultimo
async function votaPassato(evId, vote, stars) {
  if (!evId) return;
  try {
    const body = { device, eventId: evId, vote, stars };
    if (meEmail()) body.email = meEmail();
    const r = await api("/rate", { method: "POST", body: JSON.stringify(body) });
    const p = passatiVoti.find((x) => x.id === evId);
    if (p && r && r.numeri) p.voti = r.numeri;
    if (!vote && !stars) toast(t("voti.annullato"));
    // il dislike dice che quel genere, con quella persona, non fa per me
    if (p) bumpEvitato(p, vote === -1);
    paintPastFolder();
    if (passatiAperti) renderPassati();
    if (!$("#pastDetail").hidden) openPast(evId);
  } catch (e) {
    toastErr(e && e.data && e.data.error ? e.data.error : t("toast.error"));
  }
}

function setView(name, push) {
  if (name === "profile") {
    openProfile();
    return;
  }
  if (name !== "home" && name !== "feed") name = "home";
  view = name;
  statoUI.v = name;
  salvaStato();
  peek("schermata", name);
  const home = $("#homeView");
  const feed = $("#feedView");
  if (home) home.hidden = name !== "home";
  if (feed) feed.hidden = name !== "feed";
  paintNav();
  if (push) assicuraSegnale();
  window.scrollTo(0, 0);
  try {
    sendView(name);
  } catch {}
  mascotteSegui();
  if (name === "feed") {
    loadPast();
    loadFeed(false);
  }
}

// riapro la schermata e i pannelli di prima: dopo un aggiornamento resti dove eri
async function riprendiDoveEri() {
  if (Date.now() - (statoUI.at || 0) > 3 * 3600 * 1000) {
    statoUI.s = [];
    salvaStato();
    return;
  }
  const pannelli = statoUI.s.filter((x) => x && PANNELLI_RIPRESA.has(x.id)).slice(-3);
  for (const p of pannelli) {
    try {
      if (p.id === "detail" && p.ev) await openDetail(p.ev);
      else if (p.id === "chat" && p.ev) await openChat(p.ev, p.t || "");
      else if (p.id === "pastDetail" && p.ev) { await loadPast(); openPast(p.ev); }
      else if (p.id === "profile") { if (person) openProfile(); else scordaPannello("profile"); }
      else if (p.id === "fav") openFav();
      else scordaPannello(p.id);
    } catch { scordaPannello(p.id); }
  }
}

function viewOpened() {
  return view !== "home";
}

function wireBack() {
  // il gesto "indietro" del telefono chiude UNA finestra alla volta: prima l'ultima aperta,
  // poi quella sotto, e solo alla fine si esce
  window.addEventListener("popstate", () => {
    if (ignoraIndietro > 0) {
      ignoraIndietro--;
      // ho tolto io il segnale chiudendo col dito: se sotto c'è ancora roba, lo rimetto
      if (strati.length || view !== "home") assicuraSegnale();
      return;
    }
    segnaleStoria = false;
    if (strati.length) {
      hide(strati[strati.length - 1], true);
      // sotto c'è ancora qualcosa (o sei in Community): il prossimo indietro deve
      // chiudere un solo livello alla volta, non uscire dall'app
      if (strati.length || view !== "home") assicuraSegnale();
      return;
    }
    if (view !== "home") { setView("home", false); return; }
  });
  // toccare lo spazio vuoto attorno a una scheda la chiude
  document.querySelectorAll(".sheet").forEach((sh) => {
    sh.addEventListener("click", (e) => {
      if (e.target === sh) hide(sh.id);
    });
  });
}

/* ---------- community ---------- */

function normalizePost(p) {
  return {
    id: String(p.id || ""),
    name: p.name || "FUORI",
    caption: p.caption || "",
    photo: p.photo || "",
    createdAt: Number(p.createdAt || 0),
    verified: Boolean(p.verified),
    mine: Boolean(p.mine),
    likes: Number(p.likes || 0),
    comments: Number(p.comments || 0),
    liked: Boolean(p.liked),
    eventId: String(p.eventId || ""),
    eventTitle: String(p.eventTitle || ""),
  };
}

let feedCaricati = 0;
let feedInCorso = null;

async function loadFeed(more, silenzioso) {
  // la Community si apre già piena: se ho appena letto (anche zero post) non richiedo
  if (!more && feedCaricati && Date.now() - feedCaricati < 60000) return renderFeed();
  if (feedBusy) return feedInCorso;
  feedBusy = true;
  const btn = $("#feedMore");
  if (btn) btn.disabled = true;
  feedInCorso = (async () => {
    try {
      const q = new URLSearchParams({ device });
      if (meEmail()) q.set("email", meEmail());
      if (more && feedNext) q.set("before", String(feedNext));
      const r = await api("/feed?" + q.toString());
      const list = (r.posts || []).map(normalizePost);
      feedPosts = more ? feedPosts.concat(list) : list;
      feedNext = r.next || null;
      feedCaricati = Date.now();
      renderFeed();
    } catch (e) {
      if (!silenzioso) toastErr(e && e.data && e.data.error ? e.data.error : t("toast.error"));
    } finally {
      feedBusy = false;
      feedInCorso = null;
      if (btn) btn.disabled = false;
    }
  })();
  return feedInCorso;
}

// quando correggo il testo di un post (mio o di chiunque, se sono il padrone)
let postEditing = "";

function renderFeed() {
  const box = $("#feedList");
  const empty = $("#feedEmpty");
  const more = $("#feedMore");
  if (!box) return;
  if (!feedPosts.length) {
    box.innerHTML = "";
    if (empty) empty.hidden = false;
    if (more) more.hidden = true;
    return;
  }
  if (empty) empty.hidden = true;
  if (more) more.hidden = !feedNext;
  box.innerHTML = feedPosts
    .map(
      (p) => `
    <article class="fcard" data-post="${esc(p.id)}">
      <div class="fcard-top">
        <span class="favatar">${esc(initials(p.name))}</span>
        <div>
          <p class="fname">${esc(p.name)}${p.verified ? '<span class="vcheck" title="Utente verificato">✓</span>' : ""}</p>
          <p class="ftime">${esc(agoTime(p.createdAt))}</p>
        </div>
      </div>
      ${p.eventTitle ? `<p class="ftag"><span aria-hidden="true">#</span>${esc(p.eventTitle)}</p>` : ""}
      ${p.photo ? `<img class="fphoto" src="${esc(p.photo)}" alt="" loading="lazy" decoding="async">` : ""}
      ${postEditing === p.id
        ? `<div class="fedit"><textarea id="feditBox" rows="3" maxlength="400">${esc(p.caption || "")}</textarea>
             <div class="det-actions"><button class="btn primary sm" data-act="save" type="button">${esc(t("feed.save"))}</button>
             <button class="btn ghost sm" data-act="cancel" type="button">Annulla</button></div></div>`
        : (p.caption ? `<p class="fcap">${esc(p.caption)}</p>` : "")}
      <div class="facts">
        <button class="fact like${p.liked ? " liked" : ""}" data-act="like" type="button" aria-label="${esc(t("feed.like"))}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 1 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          <span>${p.likes}</span>
        </button>
        <button class="fact" data-act="comments" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a8.4 8.4 0 0 1-8.5 8.3 9 9 0 0 1-3.3-.6L4 21l1.4-4.2A8 8 0 0 1 4 12a8.4 8.4 0 0 1 8.5-8.3A8.4 8.4 0 0 1 21 12Z"/></svg>
          <span>${p.comments}</span>
        </button>
        ${p.mine || p.padrone ? `<button class="fact del" data-act="delete" type="button">${esc(t("feed.delete"))}</button>` : ""}
        ${p.padrone ? `<button class="fact" data-act="edit" type="button">${esc(t("feed.edit"))}</button>` : ""}
      </div>
    </article>`
    )
    .join("");
}

async function toggleLikePost(id) {
  const p = feedPosts.find((x) => x.id === id);
  if (!p) return;
  try {
    const r = await api("/post/like", {
      method: "POST",
      body: JSON.stringify({ id, device, email: meEmail() }),
    });
    p.liked = Boolean(r.liked);
    p.likes = Number(r.likes || 0);
    renderFeed();
  } catch (e) {
    toastErr(e && e.data && e.data.error ? e.data.error : t("toast.error"));
  }
}

async function salvaPostCorretto(id) {
  const box = $("#feditBox");
  const caption = box ? box.value.trim() : "";
  try {
    await api("/post/edit", {
      method: "POST",
      body: JSON.stringify({ id, caption, device, email: meEmail() }),
    });
    const p = feedPosts.find((x) => x.id === id);
    if (p) p.caption = caption;
    postEditing = "";
    renderFeed();
    toast(t("prof.saved"));
  } catch (e) {
    toastErr(e && e.data && e.data.error ? e.data.error : t("toast.error"));
  }
}

async function deleteMyPost(id) {
  if (!meEmail()) return;
  try {
    await api(
      "/post?id=" + encodeURIComponent(id) + "&email=" + encodeURIComponent(meEmail()) +
        "&device=" + encodeURIComponent(device),
      { method: "DELETE" }
    );
    feedPosts = feedPosts.filter((p) => p.id !== id);
    if (postEditing === id) postEditing = "";
    renderFeed();
    toast(t("feed.deleted"));
  } catch (e) {
    toastErr(e && e.data && e.data.error ? e.data.error : t("toast.error"));
  }
}

async function loadComments() {
  const box = $("#cmList");
  if (!box || !cmPostId) return;
  try {
    const r = await api("/post/comments?id=" + encodeURIComponent(cmPostId));
    const list = r.comments || [];
    box.innerHTML = list.length
      ? list
          .map(
            (c) =>
              `<p class="cm-item"><span class="cm-who">${esc(c.name)}${c.verified ? " ✓" : ""}</span>${esc(c.text)}</p>`
          )
          .join("")
      : `<p class="muted">${esc(t("cm.none"))}</p>`;
    box.scrollTop = box.scrollHeight;
  } catch {
    box.innerHTML = `<p class="muted">${esc(t("toast.error"))}</p>`;
  }
}

function openComments(id) {
  cmPostId = id;
  const err = $("#cmError");
  if (err) err.hidden = true;
  const box = $("#cmList");
  if (box) box.innerHTML = `<p class="muted">${esc(t("cm.loading"))}</p>`;
  show("pcomments");
  loadComments();
}

async function sendComment(e) {
  if (e) e.preventDefault();
  const input = $("#cmText");
  const err = $("#cmError");
  const text = String((input && input.value) || "").trim();
  if (!text) return;
  if (!meEmail()) {
    toastErr(t("feed.needLogin"));
    return;
  }
  try {
    await api("/post/comments", {
      method: "POST",
      body: JSON.stringify({ id: cmPostId, email: meEmail(), text, device }),
    });
    if (input) input.value = "";
    if (err) err.hidden = true;
    const p = feedPosts.find((x) => x.id === cmPostId);
    if (p) p.comments += 1;
    renderFeed();
    await loadComments();
  } catch (e2) {
    if (err) {
      err.textContent = (e2 && e2.data && e2.data.error) || t("toast.error");
      err.hidden = false;
    }
  }
}

let photoTarget = "post";
function apriSceltaFoto(target) {
  photoTarget = target === "event" ? "event" : target === "past" ? "past" : "post";
  show("photoSheet");
}
function scegliOrigineFoto(daFotocamera) {
  const evento = photoTarget === "event";
  const ricordo = photoTarget === "past";
  const inp = ricordo
    ? (daFotocamera ? $("#pastPhotoCamInput") : $("#pastPhotoInput"))
    : evento
      ? (daFotocamera ? $("#evPhotoCamInput") : $("#evPhotoInput"))
      : (daFotocamera ? $("#postCamInput") : $("#postInput"));
  hide("photoSheet");
  if (inp) setTimeout(() => inp.click(), 90);
}

// pubblicare una foto già agganciata a un evento: il tag si sceglie da sé
let postPreset = null;
function openPostTag(eventId, eventTitle) {
  postPreset = eventId ? { id: String(eventId), title: String(eventTitle || "") } : null;
  openPost();
}

function openPost() {
  if (!meEmail()) {
    openRegister();
    return;
  }
  postData = "";
  $("#postPick")?.classList.remove("has-photo");
  const img = $("#postPreview");
  if (img) {
    img.hidden = true;
    img.removeAttribute("src");
  }
  const cap = $("#postCaption");
  if (cap) cap.value = "";
  const err = $("#postError");
  if (err) err.hidden = true;
  const sel = $("#postEvent");
  if (sel) sel.value = "";
  show("post");
  fillPostEvents();
}

// gli eventi a cui ho partecipato: sono gli unici che posso raccontare
async function fillPostEvents() {
  const wrap = $("#postEventWrap"), sel = $("#postEvent");
  if (!wrap || !sel) return;
  sel.innerHTML = `<option value="">${esc(t("post.eventNone"))}</option>`;
  wrap.hidden = true;
  try {
    const r = await api("/my-events?device=" + encodeURIComponent(device));
    const list = (r.events || []).filter((e) => e && e.title);
    // l'evento da cui sono partito c'è anche se non è tra i miei (un ricordo, per esempio)
    if (postPreset && postPreset.id && !list.some((e) => String(e.id) === postPreset.id)) {
      list.unshift({ id: postPreset.id, title: postPreset.title || t("post.eventLabel") });
    }
    if (!list.length) return;
    sel.innerHTML += list
      .map((e) => `<option value="${esc(e.id)}">${esc(String(e.title).slice(0, 70))}</option>`)
      .join("");
    if (postPreset && postPreset.id) sel.value = postPreset.id;
    wrap.hidden = false;
  } catch {}
}

async function pickPostPhoto(file) {
  const img = $("#postPreview");
  const err = $("#postError");
  try {
    postData = await shrink(file, 1200, 0.86);
    if (img) {
      img.src = postData;
      img.hidden = false;
      $("#postPick")?.classList.add("has-photo");
    }
    if (err) err.hidden = true;
  } catch {
    if (img) img.hidden = true;
  }
}

async function sendPost() {
  const btn = $("#postSend");
  const err = $("#postError");
  if (!meEmail()) {
    hide("post");
    openRegister();
    return;
  }
  if (!postData) {
    if (err) {
      err.textContent = t("post.needPhoto");
      err.hidden = false;
    }
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = t("post.sending");
  }
  try {
    await api("/post", {
      method: "POST",
      body: JSON.stringify({
        email: meEmail(),
        data: postData,
        caption: ($("#postCaption") && $("#postCaption").value) || "",
        eventId: ($("#postEvent") && $("#postEvent").value) || "",
        device,
      }),
    });
    hide("post");
    postData = "";
    postPreset = null;
    feedNext = null;
    feedCaricati = 0;
    await loadFeed(false);
    setView("feed", false);
    toast(t("post.done"));
  } catch (e) {
    if (err) {
      err.textContent = (e && e.data && e.data.error) || t("toast.error");
      err.hidden = false;
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = t("post.send");
    }
  }
}

function wireNav() {
  paintNav();
  document.querySelectorAll(".tab[data-view]").forEach((b) => {
    b.onclick = () => {
      const v = b.dataset.view;
      if (v === "profile") {
        openProfile();
        return;
      }
      setView(v, true);
    };
  });
  const nb = $("#newPostBtn");
  if (nb) nb.onclick = openPost;
  const fm = $("#feedMore");
  if (fm) fm.onclick = () => loadFeed(true);
  const galInput = $("#postInput"), camInput = $("#postCamInput");
  for (const inp of [galInput, camInput]) {
    if (!inp) continue;
    inp.onchange = () => {
      const f = inp.files && inp.files[0];
      inp.value = "";
      if (f) pickPostPhoto(f);
    };
  }
  const pwaBtn = $("#installPwa"), apkBtn = $("#installApk");
  if (pwaBtn) {
    pwaBtn.onclick = async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        const res = await deferredPrompt.userChoice;
        if (res.outcome === "accepted") toast(t("install.done"));
        deferredPrompt = null;
        hide("install");
        return;
      }
      if (pwaBtn.dataset.modo === "copia") { copiaLink(); return; }
      // se Chrome non ci dà il permesso di installare da qui, mostro i passi (sempre utili)
      const how = $("#installHow");
      if (how) how.innerHTML = passiInstall();
    };
  }
  if (apkBtn) apkBtn.onclick = () => downloadApk();
  const pushRetry = $("#pushHelpRetry");
  if (pushRetry) pushRetry.onclick = () => riprovaPush();

  // ferma subito la voce dell'assistente
  const aiStop = $("#aiStop");
  if (aiStop) {
    aiStop.onclick = () => {
      stopVoce();
      aiStop.hidden = true;
    };
  }

  // dentro "chi c'è": ordine e filtri
  const ordina = $("#personeOrdina");
  if (ordina) {
    ordina.onclick = (e) => {
      const b = e.target.closest("[data-o]");
      if (!b) return;
      personeOrdina = b.dataset.o;
      ordina.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      renderPeople();
    };
  }
  const filtro = $("#personeFiltro");
  if (filtro) {
    filtro.onclick = (e) => {
      const b = e.target.closest("[data-f]");
      if (!b) return;
      personeFiltro = b.dataset.f;
      filtro.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      renderPeople();
    };
  }

  const postPick = $("#postPick");
  if (postPick) postPick.onclick = () => apriSceltaFoto("post");
  const photoCam = $("#photoCam"), photoLib = $("#photoLib");
  if (photoCam) photoCam.onclick = () => scegliOrigineFoto(true);
  if (photoLib) photoLib.onclick = () => scegliOrigineFoto(false);
  const evCam = $("#evPhotoCamInput");
  if (evCam) {
    evCam.onchange = async () => {
      const f = evCam.files && evCam.files[0];
      evCam.value = "";
      if (!f) return;
      if (fotoEvento.length >= 3) return toast(t("create.photoMax"));
      await aggiungiFotoEvento(f);
    };
  }
  const pastCam = $("#pastPhotoCamInput");
  if (pastCam) {
    pastCam.onchange = async () => {
      const f = pastCam.files && pastCam.files[0];
      pastCam.value = "";
      if (!f) return;
      if (fotoRicordo.length >= 3) return toast(t("create.photoMax"));
      await aggiungiFotoRicordo(f);
    };
  }
  const ps = $("#postSend");
  if (ps) ps.onclick = sendPost;
  const cf = $("#cmForm");
  if (cf) cf.onsubmit = sendComment;
  const fl = $("#feedList");
  if (fl) {
    fl.onclick = (e) => {
      const card = e.target.closest("[data-post]");
      const act = e.target.closest("[data-act]");
      if (!card || !act) return;
      const id = card.dataset.post;
      const what = act.dataset.act;
      if (what === "like") toggleLikePost(id);
      else if (what === "comments") openComments(id);
      else if (what === "delete") deleteMyPost(id);
      else if (what === "edit") {
        postEditing = id;
        renderFeed();
        const box = $("#feditBox");
        if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
      } else if (what === "save") salvaPostCorretto(id);
      else if (what === "cancel") { postEditing = ""; renderFeed(); }
    };
  }
  wireBack();
  // all'avvio torno dove eri: la home solo se non c'era altro
  setView(statoUI.v === "feed" ? "feed" : "home", false);
}

/* ---------- v594: l'umore che cambia davvero la home ---------- */
let onlyMood = false;

function moodName(id) {
  const m = MOODS.find((x) => x.id === id);
  return m ? t("mood." + m.id).toLowerCase() : "";
}

// l'umore non resta un dato buttato: dice quanti eventi gli somigliano
// e ti lascia vedere solo quelli. Se non c'e' niente, lo dice chiaro.
function paintMoodSay() {
  const box = $("#moodSay");
  if (!box) return;
  if (!moodPick) { box.hidden = true; onlyMood = false; return; }
  const m = MOODS.find((x) => x.id === moodPick);
  const n = events.filter((ev) => moodFit(ev)).length;
  const em = $("#moodSayEmoji");
  const tx = $("#moodSayTxt");
  const btn = $("#moodSayBtn");
  if (em) em.textContent = m ? m.emoji : "✨";
  if (tx) {
    const etichetta = moodPick ? t("mood." + moodPick) : "";
    // il numero resta sempre attaccato alla sua parola (spazio indistruttibile):
    // cosi' non va mai a capo da solo lasciando "1" sopra e la frase sotto
    const conta = `${n}\u00A0${n === 1 ? "evento" : "eventi"}`;
    tx.textContent = n
      ? `Oggi: ${etichetta}. ${conta}\u00A0${n === 1 ? "ha" : "hanno"} a che fare con questo.`
      : `Oggi: ${etichetta}. In questo momento non c'è niente che ci somigli: puoi crearlo tu.`;
  }
  if (btn) {
    btn.hidden = !n;
    btn.textContent = onlyMood ? "Mostra tutto" : "Solo questi";
    btn.onclick = () => {
      onlyMood = !onlyMood;
      renderList();
      paintMoodSay();
    };
  }
  box.hidden = false;
}

/* ---------- v594: la mascotte al posto della scritta AI ---------- */
const MASCOT_LINES = [
  "Dimmi cosa ti va di fare: ti trovo qualcosa vicino a te.",
  "Hai voglia di uscire? Ti mostro gli eventi di oggi.",
  "C'è qualcosa che fa per te, vicino a te: vuoi che te lo mostri?",
  "Cerchi compagnia per stasera? Posso cercarti qualcosa.",
  "Dimmi che tipo di giornata vuoi: ti propongo io qualcosa.",
  "Vuoi provare qualcosa di nuovo o rimettere qualcosa che ti piaceva?",
];

function mascotteOra() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return "Buongiorno: oggi che tipo di giornata vuoi?";
  if (h >= 12 && h < 18) return "Buon pomeriggio: ti va di fare qualcosa oggi?";
  if (h >= 18 && h < 23) return "Stasera hai voglia di uscire o di stare tranquillo?";
  return "Ancora sveglio: domani ti va di fare qualcosa?";
}

let mascotTimer = 0;
let mascotChiusaOra = false;

/* ---------- v638: le espressioni della mascotte ----------
   Ogni posa sceglie occhi, bocca, mani e decoro: il disegno li mostra
   insieme, quindi la faccia e le mani sono sempre d'accordo. Per aggiungere
   un'espressione basta una riga qui dentro. */
const MASCOT_EXPR = [
  { n: "sorriso", e: "open", m: "smile", h: "rest", x: "", ms: 2600 },
  { n: "risata", e: "happy", m: "laugh", h: "cheer", x: "", ms: 2200 },
  { n: "cuore", e: "heart", m: "kiss", h: "heart", x: "hearts", ms: 2600 },
  { n: "occhiolino", e: "wink", m: "smile", h: "wave", x: "", ms: 2200 },
  { n: "sorpresa", e: "big", m: "ooh", h: "up", x: "", ms: 1900 },
  { n: "pensa", e: "look", m: "flat", h: "think", x: "dots", ms: 2500 },
  { n: "triste", e: "closed", m: "sad", h: "down", x: "", ms: 2400 },
  { n: "sonno", e: "closed", m: "yawn", h: "mouth", x: "zzz", ms: 2800 },
  { n: "festa", e: "star", m: "laugh", h: "party", x: "confetti", ms: 2300 },
  { n: "bacio", e: "happy", m: "kiss", h: "cheek", x: "hearts", ms: 2400 },
  { n: "linguaccia", e: "open", m: "tongue", h: "wave", x: "", ms: 2200 },
  { n: "timido", e: "happy", m: "small", h: "shy", x: "", ms: 2500 },
  { n: "ok", e: "wink", m: "grin", h: "thumbs", x: "", ms: 2400 },
  { n: "saluta", e: "happy", m: "smile", h: "wave", x: "", ms: 2400 },
  { n: "dubbio", e: "look", m: "wavy", h: "shrug", x: "qmark", ms: 2500 },
];

let mascotExprIdx = -1;
let mascotExprBag = [];
let mascotExprTimer = 0;

function mascotPosa(posa) {
  const faccia = $("#aiBtn .mascot-face");
  if (!faccia || !posa) return;
  faccia.dataset.eyes = posa.e;
  faccia.dataset.mouth = posa.m;
  faccia.dataset.hands = posa.h;
  faccia.dataset.extra = posa.x || "";
  faccia.dataset.posa = posa.n || "";
}

// giro mescolato: passano tutte, mai la stessa due volte di fila
function mascotProssima() {
  if (!mascotExprBag.length) {
    const ordine = MASCOT_EXPR.map((_, i) => i);
    for (let i = ordine.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = ordine[i]; ordine[i] = ordine[j]; ordine[j] = t;
    }
    if (ordine[ordine.length - 1] === mascotExprIdx) {
      const t = ordine[0]; ordine[0] = ordine[ordine.length - 1]; ordine[ordine.length - 1] = t;
    }
    mascotExprBag = ordine;
  }
  mascotExprIdx = mascotExprBag.pop();
  return MASCOT_EXPR[mascotExprIdx];
}

function mascotCiclo(attivo) {
  if (mascotExprTimer) { clearTimeout(mascotExprTimer); mascotExprTimer = 0; }
  if (!attivo) return;
  const passo = () => {
    const posa = mascotProssima();
    mascotPosa(posa);
    // v644: le espressioni restano piu' a lungo, cosi' si leggono
    mascotExprTimer = setTimeout(passo, Math.round(posa.ms * 2.6) + Math.floor(Math.random() * 1200));
  };
  passo();
}

// v636/v638: la mascotte cambia posa e guance secondo quello che sta facendo
// ("chat" = parla e saluta, "pensa" = si tiene il mento, "" = giro di emozioni)
function mascotteUmore(nome) {
  const btn = $("#aiBtn");
  if (!btn) return;
  btn.classList.toggle("mf-chat", nome === "chat");
  btn.classList.toggle("mf-pensa", nome === "pensa");
  if (nome === "chat") {
    mascotCiclo(false);
    mascotPosa({ n: "chat", e: "happy", m: "smile", h: "wave", x: "" });
    return;
  }
  if (nome === "pensa") {
    mascotCiclo(false);
    mascotPosa({ n: "pensa", e: "look", m: "flat", h: "think", x: "dots" });
    return;
  }
  mascotCiclo(true);
}

function nascondiMascotte() {
  const b = $("#mascotBubble");
  if (b) b.hidden = true;
  mascotteUmore("");
  // la X la nasconde per questa apertura, non per tutto il giorno:
  // prima restava via fino a domani, ed e' per questo che sembrava "dopo 1 anno"
  mascotChiusaOra = true;
  if (mascotTimer) { clearTimeout(mascotTimer); mascotTimer = 0; }
}

function mascotConteggio() {
  try {
    const salvato = localStorage.getItem("fuori.mascotCount") || "";
    return salvato.startsWith(moodDayKey() + ":") ? Number(salvato.split(":")[1]) || 0 : 0;
  } catch { return 0; }
}

function mascotteMostra(b) {
  // 3 secondi e si mostra: prima aspettava che si chiudesse un pannello
  // (e se l'app ne riapriva uno all'avvio, non arrivava mai)
  if (mascotChiusaOra) return;
  if (mascotConteggio() >= 3) return;
  // un solo avviso per apertura dell'app: il refresh della pagina non ne manda un altro
  try { if (sessionStorage.getItem("fuori.mascotShown")) return; sessionStorage.setItem("fuori.mascotShown", "1"); } catch {}
  try { localStorage.setItem("fuori.mascotCount", moodDayKey() + ":" + (mascotConteggio() + 1)); } catch {}
  mascotteUmore("chat");
  b.hidden = false;
  mfBollaDove();
}

// v631b: la mascotte prima guarda cosa c'è vicino a te, poi parla: niente frasi a caso
let mascotEventiVicini = [];

function mascotteRispondi(si) {
  nascondiMascotte();
  if (!si) return;
  openAi();
  if (mascotEventiVicini.length) {
    const n = mascotEventiVicini.length;
    aiBubble(n === 1 ? "Ecco l'evento vicino a te:" : `Ecco i ${n} eventi vicino a te:`, "bot", mascotEventiVicini);
  } else {
    aiBubble("Qui intorno non c'è niente. Scrivimi dove vuoi andare (una città o una zona) e ti cerco qualcosa.", "bot");
  }
}

async function mascotteCerca() {
  mascotteUmore("pensa");
  mascotEventiVicini = [];
  const pos = myPos || lastPos();
  if (!pos) return null;
  try {
    const data = await api(`/map?device=${encodeURIComponent(device)}&lat=${pos.lat}&lng=${pos.lng}&r=10`);
    mascotEventiVicini = (data.events || []).filter((e) => e.distance <= 10000);
    return mascotEventiVicini.length;
  } catch {
    return null;
  }
}

function mascotteFrase(n) {
  if (n === null) return mascotteOra();
  if (n > 0) return `Ci sono ${n === 1 ? "un evento interessante" : n + " eventi interessanti"} vicino a te. Vuoi che te li mostri?`;
  return "Qui intorno non c'è niente in programma. Vuoi che ti cerchi qualcosa in un'altra zona?";
}

async function mascotteAvvia() {
  const b = $("#mascotBubble");
  if (!b || mascotTimer) return;
  if (mascotConteggio() >= 3) return;
  if (sessionStorage.getItem("fuori.mascotShown")) return;
  const n = await mascotteCerca();
  const tx = $("#mascotTxt");
  if (tx) tx.textContent = mascotteFrase(n);
  b.dataset.esito = n === null ? "" : n > 0 ? "vicini" : "nulla";
  // 3 secondi dopo l'apertura, non subito e non dopo un anno
  mascotTimer = setTimeout(() => { mascotTimer = 0; mascotteMostra(b); }, 3000);
}

/* ---------- v639: la mascotte gira per l'app ----------
   Prima stava inchiodata in basso a destra e spariva dietro i pannelli.
   Adesso il JS le dice dove andare (--mx/--my): si affaccia sul bordo del
   pannello che apri, torna sopra la barra quando lo chiudi, si scansa se
   tocchi altrove e, se resti fermo, ogni tanto ti dice qualcosa. */
let mfX = 0;
let mfY = 0;
let mfLatoSu = true;
let mfUltimoSalto = 0;
let mfBollaT = 0;
let mfPosaT = 0;
let mfIdleT = 0;
let mfIdleGiri = 0;
let mfPronto = false;
const mfHintVisti = new Set();

// una frase di contesto per i pannelli che si aprono davvero spesso
const MF_HINT = {
  create: "Qui decidi tu: nome, giorno e posto. Ci vuole un minuto.",
  assistant: "Scrivimi che serata ti va e ti cerco qualcosa io.",
  mapSheet: "Sposta la mappa: gli eventi vicini si accendono da soli.",
  fav: "Qui resta quello che hai messo da parte, senza fretta.",
  register: "Bastano due dati e sei dentro: poi crei anche i tuoi eventi.",
};

const MF_IDLE = [
  "Se resti fermo ti racconto un segreto: c'è sempre qualcosa da fare, basta scegliere.",
  "Ancora qui? Dimmi che serata ti va e ti trovo qualcosa.",
  "Se non sai cosa scegliere, scegli di uscire: al resto penso io.",
  "Ti va un evento qui vicino? Basta chiedere.",
  "Se ti annoi, tocca Crea e inventati la serata.",
];

function mfLato() {
  const b = $("#aiBtn");
  return (b && b.offsetWidth) || 54;
}

function mfVai(x, y) {
  const b = $("#aiBtn");
  if (!b) return;
  const lato = mfLato();
  const vw = window.innerWidth || 360;
  const vh = window.innerHeight || 640;
  mfX = Math.max(2, Math.min(vw - lato - 2, Math.round(x)));
  mfY = Math.max(2, Math.min(vh - lato - 2, Math.round(y)));
  b.classList.add("mf-mobile");
  // la prima volta la mettiamo li' senza farla sfrecciare da un angolo all'altro
  if (!mfPronto) {
    mfPronto = true;
    b.style.transition = "none";
    setTimeout(() => { b.style.transition = ""; }, 160);
  }
  b.style.setProperty("--mx", mfX + "px");
  b.style.setProperty("--my", mfY + "px");
  mfBollaDove();
}

// la bolla sta sopra la mascotte, o sotto se sopra non c'è spazio
function mfBollaDove() {
  const b = $("#mascotBubble");
  const btn = $("#aiBtn");
  if (!b || !btn || b.hidden) return;
  const r = btn.getBoundingClientRect();
  if (!r.width && !r.height) return;
  const vw = window.innerWidth || 360;
  const vh = window.innerHeight || 640;
  const larg = Math.min(280, Math.round(vw * 0.72));
  b.classList.add("mb-mobile");
  b.style.maxWidth = larg + "px";
  const alt = b.offsetHeight || 74;
  let bx = r.right - larg;
  let by = r.top - alt - 8;
  if (by < 8) by = r.bottom + 8;
  bx = Math.max(8, Math.min(vw - larg - 8, bx));
  by = Math.max(8, Math.min(vh - alt - 8, by));
  b.style.setProperty("--bx", Math.round(bx) + "px");
  b.style.setProperty("--by", Math.round(by) + "px");
}

function chiudiBolla() {
  const b = $("#mascotBubble");
  if (b) b.hidden = true;
  if (mfBollaT) { clearTimeout(mfBollaT); mfBollaT = 0; }
  if (mfPosaT) { clearTimeout(mfPosaT); mfPosaT = 0; }
  mascotteUmore("");
}

// parla in bolla; con "tieniPosa" non le cambia l'espressione (sollievo, ecc.)
function mfDici(testo, ms, tipo, tieniPosa) {
  const b = $("#mascotBubble");
  const tx = $("#mascotTxt");
  if (!b || !tx || !testo) return;
  tx.textContent = testo;
  b.dataset.esito = "";
  b.classList.toggle("mb-info", tipo === "info");
  b.hidden = false;
  mfBollaDove();
  if (!tieniPosa) mascotteUmore("chat");
  if (mfBollaT) clearTimeout(mfBollaT);
  mfBollaT = setTimeout(() => { mfBollaT = 0; chiudiBolla(); }, ms || 5200);
}

// il sospiro: occhi chiusi, sorriso, guance e la goccia
function mfSollievo() {
  if (mfPosaT) clearTimeout(mfPosaT);
  mascotCiclo(false);
  mascotPosa({ n: "sollievo", e: "closed", m: "smile", h: "cheek", x: "sweat" });
  mfPosaT = setTimeout(() => { mfPosaT = 0; mascotteUmore(""); }, 2400);
}

function mfDentro(id) {
  const el = document.getElementById(id);
  if (!el || el.hidden) return null;
  const box = el.querySelector(".sheet-in") || el;
  const r = box.getBoundingClientRect();
  if (!r || (!r.width && !r.height)) return null;
  return r;
}

function mfBaseBasso() {
  const vh = window.innerHeight || 640;
  const dock = document.getElementById("dock") || document.querySelector(".dock");
  const dr = dock ? dock.getBoundingClientRect() : null;
  return dr && dr.top > 0 && dr.top < vh ? dr.top : vh - 96;
}

// cambia lato a ogni giro, cosi' il movimento si vede
function mfLatoProssimo(vw, lato) {
  mfLatoSu = !mfLatoSu;
  return mfLatoSu ? vw - lato - 10 : 10;
}

function mascotteSegui(cambiaLato) {
  const btn = $("#aiBtn");
  if (!btn) return;
  btn.classList.add("mf-mobile");
  const lato = mfLato();
  const vw = window.innerWidth || 360;
  const r = strati.length ? mfDentro(strati[strati.length - 1]) : null;
  const x = cambiaLato === false && mfX ? mfX : mfLatoProssimo(vw, lato);
  // con un pannello aperto si mette sul suo bordo alto, senza coprire i comandi
  const y = r ? Math.max(6, r.top - lato - 8) : Math.max(6, mfBaseBasso() - lato - 12);
  mfVai(x, y);
}

// toccare altrove la fa scattare via, con la faccia del "fiu"
function mfScansa(e) {
  const lato = mfLato();
  const vw = window.innerWidth || 360;
  const vh = window.innerHeight || 640;
  const px = e && e.clientX ? e.clientX : vw / 2;
  const py = e && e.clientY ? e.clientY : vh / 2;
  const r = strati.length ? mfDentro(strati[strati.length - 1]) : null;
  const cand = [];
  if (r) {
    const alto = Math.max(6, r.top - lato - 8);
    const basso = Math.min(vh - lato - 6, r.bottom + 8);
    cand.push({ x: 10, y: alto }, { x: vw - lato - 10, y: alto }, { x: 10, y: basso }, { x: vw - lato - 10, y: basso });
  } else {
    const basso = Math.max(6, mfBaseBasso() - lato - 12);
    cand.push(
      { x: 10, y: basso },
      { x: vw - lato - 10, y: basso },
      { x: Math.round(vw / 2 - lato / 2), y: basso },
      { x: 10, y: Math.round(vh * 0.46) },
      { x: vw - lato - 10, y: Math.round(vh * 0.46) },
    );
  }
  const vicino = Math.min(vw, vh) * 0.24;
  let scelta = null;
  let punti = -1;
  for (const c of cand) {
    const dTap = Math.hypot(c.x + lato / 2 - px, c.y + lato / 2 - py);
    const dOra = Math.hypot(c.x - mfX, c.y - mfY);
    if (dTap < vicino && dOra < vicino) continue;
    const p = dTap + dOra * 0.75;
    if (p > punti) { punti = p; scelta = c; }
  }
  if (!scelta) scelta = cand[0];
  mfVai(scelta.x, scelta.y);
  mfSollievo();
  mfDici("Fiu… per poco ti ho evitato.", 2600, "info", true);
}

function mfTocco(e) {
  const t = e.target;
  if (!t || !t.closest) return;
  if (t.closest("#aiBtn") || t.closest("#mascotBubble")) return;
  const ora = Date.now();
  if (ora - mfUltimoSalto < 900) return;
  mfUltimoSalto = ora;
  mfScansa(e);
}

function mfRidimensiona() {
  const lato = mfLato();
  const vw = window.innerWidth || 360;
  const r = strati.length ? mfDentro(strati[strati.length - 1]) : null;
  const y = r ? Math.max(6, r.top - lato - 8) : Math.max(6, mfBaseBasso() - lato - 12);
  mfVai(mfX || vw - lato - 10, y);
}

// se resti fermo dentro l'app, ogni tanto butta li' una frase
function mfSveglia() {
  if (mfIdleT) clearTimeout(mfIdleT);
  mfIdleT = setTimeout(mfIdle, 30000);
}

function mfIdle() {
  mfIdleT = 0;
  mfSveglia();
  if (mascotChiusaOra || mfIdleGiri >= 3) return;
  if (document.hidden) return;
  const b = $("#mascotBubble");
  if (b && !b.hidden) return;
  const a = document.activeElement;
  if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || a.isContentEditable)) return;
  if (strati.indexOf("assistant") >= 0) return;
  mfIdleGiri++;
  mfDici(MF_IDLE[Math.floor(Math.random() * MF_IDLE.length)], 8000, "info");
}

function mfHint(id) {
  const testo = MF_HINT[id];
  if (!testo || mfHintVisti.has(id) || mascotChiusaOra) return;
  mfHintVisti.add(id);
  setTimeout(() => {
    if (mascotChiusaOra || document.hidden) return;
    const b = $("#mascotBubble");
    // il primo avviso (quello con Sì/No) ha la precedenza
    if (b && !b.hidden && !b.classList.contains("mb-info")) return;
    mfDici(testo, 6500, "info");
  }, 900);
}

function mfAvvia() {
  mascotteSegui();
  document.addEventListener("pointerdown", mfTocco, { passive: true });
  document.addEventListener("pointerdown", mfSveglia, { passive: true });
  document.addEventListener("keydown", mfSveglia);
  document.addEventListener("wheel", mfSveglia, { passive: true });
  window.addEventListener("resize", mfRidimensiona);
  window.addEventListener("orientationchange", mfRidimensiona);
  mfSveglia();
}

/* ---------- v639: pioggia di caratteri dietro le due pillole ---------- */
function pioggiaPillole() {
  const cv = document.getElementById("pillsRain");
  const fila = document.querySelector(".pills-hero");
  const hero = cv && cv.parentElement;
  if (!cv || !fila || !hero || !cv.getContext) return;
  let calmo = false;
  try { calmo = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch {}
  const rete = navigator.connection && /(^|-)2g$/.test(navigator.connection.effectiveType || "");
  if (calmo || rete) { cv.hidden = true; return; }
  const ctx = cv.getContext("2d");
  if (!ctx) { cv.hidden = true; return; }
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const CAR = "0123456789ABCDEF<>/[]{}*+=#%$01";
  const px = 18;
  const py = 26;
  let W = 0;
  let H = 0;
  let passo = 17;
  let colonne = [];
  let vivo = false;
  let timer = 0;

  function misura() {
    const hr = hero.getBoundingClientRect();
    const fr = fila.getBoundingClientRect();
    if (!fr.width || !fr.height) return;
    W = Math.round(fr.width + px * 2);
    H = Math.round(fr.height + py * 2);
    passo = W < 380 ? 14 : 17;
    cv.style.left = Math.round(fr.left - hr.left - px) + "px";
    cv.style.top = Math.round(fr.top - hr.top - py) + "px";
    cv.style.width = W + "px";
    cv.style.height = H + "px";
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const n = Math.max(1, Math.ceil(W / passo));
    colonne = [];
    for (let i = 0; i < n; i++) {
      colonne.push({ x: i * passo + 3, y: Math.random() * -H * 1.4, v: 0.6 + Math.random() * 1.7 });
    }
    vivo = true;
  }

  function disegna() {
    if (!vivo) return;
    // spento quando la home non si vede: niente lavoro inutile
    if (document.hidden || hero.offsetParent === null) return;
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "rgba(0,0,0,.17)";
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "source-over";
    ctx.font = "600 " + (passo - 4) + "px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
    ctx.textBaseline = "top";
    const meta = W / 2;
    for (const c of colonne) {
      const d = Math.abs(c.x - meta) / Math.max(1, meta);
      const alfa = 0.08 + 0.7 * d;
      ctx.fillStyle = c.x < meta ? "rgba(255,112,92," + alfa + ")" : "rgba(122,206,255," + alfa + ")";
      ctx.fillText(CAR[Math.floor(Math.random() * CAR.length)], c.x, c.y);
      c.y += c.v;
      if (c.y > H + 20) {
        c.y = -20 - Math.random() * H * 0.5;
        c.v = 0.6 + Math.random() * 1.7;
      }
    }
  }

  misura();
  if (!vivo) return;
  window.addEventListener("resize", misura);
  window.addEventListener("orientationchange", misura);
  setTimeout(misura, 900);
  timer = setInterval(disegna, 85);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { clearInterval(timer); timer = 0; } else if (!timer) timer = setInterval(disegna, 85);
  });
}

/* ---------- v594: sicurezza, tentativi di reset sotto gli occhi del padrone ---------- */
async function loadSecurity() {
  const box = $("#statsSecurity");
  if (!box) return;
  try {
    const d = await api(`/owner/alerts?device=${encodeURIComponent(device)}&t=${Date.now()}`);
    const list = d.alerts || [];
    if (!list.length) {
      box.innerHTML = `<h3 class="stat-block-t">Sicurezza</h3><p class="muted">Nessun tentativo strano: il tuo profilo si apre solo dal tuo telefono.</p>`;
      return;
    }
    box.innerHTML = `<h3 class="stat-block-t">Sicurezza</h3>
      <p class="muted">Tentativi di entrare nel tuo account da altri telefoni. Restano qui finché non li guardi tu.</p>
      ${list
        .map((a) => {
          const quando = new Date(Number(a.at) || Date.now()).toLocaleString("it-IT", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
          // i tentativi appena arrivati restano 30 secondi "in valutazione":
          // il tempo di capire se è la persona giusta o no, poi l'esito
          const eta = Date.now() - (Number(a.at) || 0);
          const resto = Math.ceil((30000 - eta) / 1000);
          const inValutazione = eta >= 0 && eta < 30000;
          const esito = inValutazione
            ? `<span class="sa-wait">valuto… ${resto}s</span>`
            : a.esito === "bloccato"
              ? `<span class="sa-done">bloccato</span>`
              : a.esito === "mio"
                ? `<span class="sa-done">eri tu</span>`
                : `<span class="sa-wait">lo decidi tu</span>`;
          return `<div class="sec-alert"><b>${esc(a.che || "Tentativo")}</b> · ${esito}
            <span class="sa-time">${esc(quando)}${a.dove ? " · " + esc(a.dove) : ""}${a.nota ? " · " + esc(a.nota) : ""}</span></div>`;
        })
        .join("")}`;
    // finché c'è un tentativo in valutazione, il riquadro si aggiorna da solo
    if (list.some((a) => Date.now() - (Number(a.at) || 0) < 30000) && !$("#stats").hidden) {
      clearTimeout(window.__secT);
      window.__secT = setTimeout(() => { if (!$("#stats").hidden) loadSecurity(); }, 1500);
    }
  } catch {
    box.innerHTML = "";
  }
}

/* ---------- v594: la mappa dice dove sei davvero e quanto e' larga ---------- */
let mapPlace = "";
let mapScopeKey = "";
let mapPaese = "";
let mapPaeseCode = "";
let mapConteggi = {};
let mapMondo = 0;

/* tema mappa: di giorno luminosa chiara, di notte scura.
   Notte dalle 18 in inverno, dalle 20 in estate (ora legale EU). */
function eNotte() {
  const now = new Date();
  const h = now.getHours();
  // ora legale: ultima domenica di marzo -> ultima domenica di ottobre
  const mk = (m, d) => new Date(now.getFullYear(), m, d).getTime();
  const dom = (m) => { const d = new Date(now.getFullYear(), m + 1, 0); return d.getDate() - ((d.getDay() + 1) % 7); };
  const estate = now.getTime() >= mk(2, dom(2)) && now.getTime() < mk(9, dom(9));
  const da = estate ? 20 : 18;
  return h >= da || h < 6;
}
let mapTiles = null;
function aggiornaTemaMappa() {
  if (!lmap || !window.L) return;
  const notte = eNotte();
  if (mapTiles) { try { lmap.removeLayer(mapTiles); } catch {} }
  lmap.getContainer().classList.toggle("map-night", notte);
  mapTiles = window.L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(lmap);
}

async function paintMapScope() {
  const el = $("#mapScope");
  if (!el) return;
  // il paese esatto (frazione compresa): lo chiede il server una volta per punto
  if (myPos) {
    const key = myPos.lat.toFixed(3) + "," + myPos.lng.toFixed(3);
    if (key !== mapScopeKey) {
      mapScopeKey = key;
      try {
        const d = await api(`/where?lat=${myPos.lat}&lng=${myPos.lng}`);
        mapPlace = String(d.label || d.town || "").trim();
        mapPaese = String(d.paese || "").trim();
        mapPaeseCode = String(d.paeseCode || "").toLowerCase();
        mapConteggi = d.perPaese || {};
        mapMondo = Number(d.mondo) || 0;
      } catch {}
    }
  }
  const r = radiusKm || 300;
  const dentro = (e) => {
    if (!myPos || !Number.isFinite(e.lat)) return false;
    const d = distKm(myPos, e);
    return d !== null && d <= r;
  };
  const vicini = mapTuttiEv.filter(dentro).length;
  const tot = mapTuttiEv.length;
  const nelPaese = Object.keys(mapConteggi || {}).length ? (mapConteggi[mapPaeseCode] || 0) : tot;
  const nelMondo = mapMondo || tot;
  const parti = [];
  if (mapPlace) parti.push(`Sei a ${mapPlace}${myPosAcc ? ` (±${Math.round(myPosAcc)} m)` : ""}`);
  else if (myPos) parti.push("Sei qui");
  if (myPos) {
    parti.push(`${vicini} ${vicini === 1 ? "evento" : "eventi"} entro ${r} km`);
    // per paese e per mondo: niente "3 in tutto" che non dice niente
    parti.push(nelPaese ? `in ${mapPaese || "questo paese"}: ${nelPaese}` : `in ${mapPaese || "questo paese"}: nessun evento`);
    parti.push(`nel mondo: ${nelMondo}`);
  } else {
    parti.push(`${tot} ${tot === 1 ? "evento" : "eventi"} sulla mappa`);
    parti.push("attiva la posizione per vedere cosa c'è intorno a te");
  }
  el.textContent = parti.join(" · ");
}

/* ---------- v601: avvisi in-app (quelli che arrivano mentre guardi) ---------- */
// il server li tiene gia' pronti (/appnotif): qui li chiedo, li conto sulla
// campanella e li mostro appena arrivano. Senza questo giro, dentro l'app
// non arrivava niente.
let notifItems = [];
let notifSeen = new Set();
let notifTimer = null;
let ianUrl = "/";

function notifIcon(n) {
  const s = String(n.id || "");
  if (s.startsWith("msg:")) return "💬";
  if (s.startsWith("m:")) return "🕐";
  if (s.startsWith("e:")) return "🔔";
  return "✨";
}

function paintBell() {
  const c = $("#bellCount");
  if (!c) return;
  const n = notifItems.filter((x) => !notifSeen.has(x.id)).length + Object.values(unread || {}).reduce((a, b) => a + (Number(b) || 0), 0);
  c.hidden = !n;
  c.textContent = n > 9 ? "9+" : String(n);
}

function mostraInApp(titolo, corpo, url) {
  const box = $("#inAppNotif");
  if (!box) return;
  const t = $("#ianTitle"), b = $("#ianBody");
  if (t) t.textContent = String(titolo || "FUORI").slice(0, 80);
  if (b) b.textContent = String(corpo || "").slice(0, 140);
  ianUrl = String(url || "/");
  box.hidden = false;
  clearTimeout(window.__ianT);
  window.__ianT = setTimeout(() => { box.hidden = true; }, 9000);
}

function nascondiInApp() {
  const box = $("#inAppNotif");
  if (box) box.hidden = true;
}

async function loadNotif(annuncia) {
  try {
    const q = person && person.email ? `email=${encodeURIComponent(person.email)}&d=${encodeURIComponent(device)}` : `d=${encodeURIComponent(device)}`;
    const d = await api(`/appnotif?${q}&t=${Date.now()}`);
    const items = Array.isArray(d.items) ? d.items : [];
    const nuovi = items.filter((x) => x && x.id && !notifSeen.has(x.id));
    notifItems = items;
    if (annuncia && nuovi.length) {
      const n = nuovi[0];
      mostraInApp(n.title, n.body, "/");
      try { navigator.vibrate?.([60, 40, 60]); } catch {}
    }
    paintBell();
    paintNotifList();
  } catch {}
}

function paintNotifList() {
  const box = $("#notifList");
  if (!box || $("#notif").hidden) return;
  if (!notifItems.length) {
    box.innerHTML = `<div class="notif-empty">Niente di nuovo per ora. Quando succede qualcosa — un messaggio nel gruppo, una richiesta, un evento che sta per cominciare — lo trovi qui.</div>`;
    return;
  }
  box.innerHTML = notifItems
    .map((n) => `<button class="notif-item" type="button" data-notif="${esc(n.id)}"><span class="ni-ico" aria-hidden="true">${notifIcon(n)}</span><span class="ni-t"><b>${esc(n.title || "FUORI")}</b><span>${esc(n.body || "")}</span></span></button>`)
    .join("");
  box.querySelectorAll("[data-notif]").forEach((b) => {
    b.onclick = () => {
      notifSeen.add(b.dataset.notif);
      paintBell();
      hide("notif");
    };
  });
}

function openNotif() {
  notifItems.forEach((x) => notifSeen.add(x.id));
  paintBell();
  paintNotifList();
  show("notif");
  loadNotif(false);
}

function startNotif() {
  loadNotif(true);
  clearInterval(notifTimer);
  notifTimer = setInterval(() => {
    if (document.hidden || navigator.onLine === false) return;
    loadNotif(true);
  }, 60000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) loadNotif(true);
  });
  // la push che arriva mentre l'app e' aperta: il service worker me la passa qui
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (e) => {
      const m = e.data || {};
      if (m.type === "fuori-push") {
        mostraInApp(m.title, m.body, m.url || "/");
        loadNotif(false);
      }
    });
  }
  const bell = $("#bellBtn");
  if (bell) bell.onclick = openNotif;
  const ianX = $("#ianClose");
  if (ianX) ianX.onclick = nascondiInApp;
  const ianO = $("#ianOpen");
  if (ianO) ianO.onclick = () => { nascondiInApp(); try { location.href = ianUrl || "/"; } catch {} };
  const test = $("#notifTestBtn");
  if (test) test.onclick = async () => {
    const out = $("#notifTestOut");
    try {
      const d = await api("/push/test", { method: "POST", body: JSON.stringify({ email: person?.email || "", device }) });
      if (out) out.textContent = d.ok ? `Prova inviata: il server l'ha accettata (${(d.statuses || []).join(", ") || "ok"}). Se hai il telefono in mano la vedi sopra; se non arriva, il blocco e' nelle impostazioni del telefono (Impostazioni > App > Chrome > Notifiche), non nell'app.` : (d.error || "Non riesco a mandarla.");
    } catch (e) {
      if (out) out.textContent = "Non riesco a mandarla: controlla la connessione e riprova.";
    }
  };
}
