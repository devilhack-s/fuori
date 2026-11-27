/* ============================================================
   FUORI — API
   ------------------------------------------------------------
   Un solo worker: file statici + API + notifiche push.
   Database: D1 (binding DB). Foto profilo: R2 (binding FILES).
   Chiavi: ADMIN_KEY, VAPID_PRIVATE. Se un giorno arriva anche
   RESEND_API_KEY, i codici di verifica partono via mail davvero.
   ============================================================ */

// Un telefono di prova (il suo id inizia con "zz") non deve mai finire nei numeri:
// niente visite, niente utilizzo assistente, niente "chi ha aperto l'app".
function telefonoProva(d) {
  return /^zz/i.test(String(d || ""));
}

async function logAsk(env, device, now) {
  if (telefonoProva(device)) return;
  await env.DB.prepare(`INSERT INTO ask_log (device, created_at) VALUES (?, ?)`)
    .bind(device, now)
    .run()
    .catch(() => {});
}

const CITY = "Catania";
const CATEGORIES = [
  "sport", "sociale", "cinema", "musica", "serate", "giochi", "creativita",
  "natura", "benessere", "lingue", "tech", "animali", "volontariato", "viaggi",
];
const MAX_EVENTS_PER_DEVICE_HOUR = 5;
const MAX_FEEDBACK_PER_DEVICE_HOUR = 10;
const CODE_MINUTES = 10;

const VAPID_PUBLIC =
  "BJTUS7OwucJPKzdTqhx1eBQprNZNHeTbtb6eJKSKN3MUzmDFbndsHWA28MRrkj8SbeZ1GpAJTCyFClm4PEOj8MU";

let ready = false;

const SCHEMA_V = 14;

// la versione dell'app: la aggiorna build.sh da sola leggendo src/app.js.
// I telefoni la chiedono ogni minuto e, se è cambiata, si aggiornano da soli.
const CLIENT_V = "654";

async function initDb(env) {
  if (ready) return;

  // se la struttura c'è già e è alla versione giusta, una lettura piccola e via:
  // così la prima richiesta dopo un riavvio non rifà tutta la creazione delle tabelle
  try {
    const v = await env.DB.prepare(`SELECT v FROM meta WHERE k = 'schema'`).first();
    if (v && Number(v.v) >= SCHEMA_V) {
      ready = true;
      return;
    }
  } catch {}

  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        starts_at INTEGER NOT NULL,
        place TEXT NOT NULL,
        capacity INTEGER NOT NULL,
        host TEXT NOT NULL,
        city TEXT NOT NULL,
        device TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS posts (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        caption TEXT NOT NULL DEFAULT '',
        photo TEXT NOT NULL,
        device TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS post_likes (
        post_id TEXT NOT NULL,
        device TEXT NOT NULL,
        email TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        PRIMARY KEY (post_id, device)
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS post_comments (
        id TEXT PRIMARY KEY,
        post_id TEXT NOT NULL,
        email TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`
    ),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS posts_time ON posts (created_at)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS comments_post ON post_comments (post_id)`),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS blobs (
        key TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'image/jpeg',
        b64 TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS participants (
        event_id TEXT NOT NULL,
        device TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (event_id, device)
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS leads (
        email TEXT PRIMARY KEY,
        city TEXT NOT NULL DEFAULT 'Catania',
        device TEXT,
        source TEXT NOT NULL DEFAULT 'app',
        created_at INTEGER NOT NULL
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        email TEXT,
        device TEXT,
        city TEXT,
        mood INTEGER,
        path TEXT,
        kind TEXT NOT NULL DEFAULT '',
        stato TEXT NOT NULL DEFAULT 'nuova',
        created_at INTEGER NOT NULL
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS push_subs (
        endpoint TEXT PRIMARY KEY,
        email TEXT,
        categories TEXT NOT NULL DEFAULT '["ALL"]',
        device TEXT,
        created_at INTEGER NOT NULL
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS codes (
        target TEXT NOT NULL,
        channel TEXT NOT NULL,
        code TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (target, channel)
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        device TEXT NOT NULL,
        name TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS chat_read (
        device TEXT NOT NULL,
        event_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (device, event_id)
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS reactions (
        msg_id INTEGER NOT NULL,
        device TEXT NOT NULL,
        emoji TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (msg_id, device)
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS typing (
        event_id TEXT NOT NULL,
        device TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        at INTEGER NOT NULL,
        PRIMARY KEY (event_id, device)
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        who TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT '',
        event_id TEXT,
        at INTEGER NOT NULL
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS pend_notif (
        sub TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL DEFAULT '/',
        at INTEGER NOT NULL
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS peek (
        device TEXT NOT NULL,
        kind TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        at INTEGER NOT NULL
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS tally (
        key TEXT PRIMARY KEY,
        n INTEGER NOT NULL DEFAULT 0
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS mutes (
        device TEXT NOT NULL,
        scope TEXT NOT NULL,
        until INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (device, scope)
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS opens (
        device TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        mode TEXT NOT NULL DEFAULT '',
        ua TEXT NOT NULL DEFAULT ''
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS presence (
        device TEXT PRIMARY KEY,
        seen_at INTEGER NOT NULL
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS sessioni (
        id TEXT PRIMARY KEY,
        device TEXT NOT NULL,
        chi TEXT NOT NULL DEFAULT '',
        modo TEXT NOT NULL DEFAULT '',
        start_at INTEGER NOT NULL,
        last_at INTEGER NOT NULL,
        end_at INTEGER
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS dl (
        day TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS ask_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS hits (
        day TEXT NOT NULL,
        path TEXT NOT NULL,
        lang TEXT NOT NULL DEFAULT '',
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, path, lang)
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS map_people (
        device TEXT PRIMARY KEY,
        lat REAL NOT NULL,
        lng REAL NOT NULL,
        seen_at INTEGER NOT NULL
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS map_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device TEXT NOT NULL,
        lat REAL NOT NULL,
        lng REAL NOT NULL,
        at INTEGER NOT NULL
      )`
    ),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_map_log_device ON map_log(device, at)`),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS extras (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        cat TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        UNIQUE(kind, value)
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS resets (
        token TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        exp INTEGER NOT NULL,
        used INTEGER NOT NULL DEFAULT 0
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS visits (
        day TEXT NOT NULL,
        who TEXT NOT NULL,
        device TEXT NOT NULL DEFAULT '',
        lang TEXT NOT NULL DEFAULT '',
        first_at INTEGER NOT NULL,
        last_at INTEGER NOT NULL,
        views INTEGER NOT NULL DEFAULT 1,
        screens TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (day, who)
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS people (
        who TEXT PRIMARY KEY,
        first_at INTEGER NOT NULL,
        last_at INTEGER NOT NULL,
        days INTEGER NOT NULL DEFAULT 1,
        visits INTEGER NOT NULL DEFAULT 1,
        is_app INTEGER NOT NULL DEFAULT 0
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS boots (
        day TEXT, boot TEXT, event TEXT, ms INTEGER, mode TEXT, ua TEXT, at INTEGER, PRIMARY KEY (day, boot, event)
      )`
    ),
    // una prepare, una tabella: prima erano attaccate e la seconda non veniva mai creata
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS friction (
        day TEXT NOT NULL,
        kind TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, kind, detail)
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS dlwho (
        day TEXT NOT NULL,
        who TEXT NOT NULL,
        PRIMARY KEY (day, who)
      )`
    ),
    // un dispositivo scarica una volta sola: se riscarica domani non conta di nuovo
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS dl_dev (
        device TEXT PRIMARY KEY,
        at INTEGER NOT NULL
      )`
    ),
    // i miei telefoni e browser: non entrano mai nei numeri
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS owner_dev (
        device TEXT PRIMARY KEY,
        at INTEGER NOT NULL
      )`,

    ),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_visits_day ON visits(day)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_friction_day ON friction(day)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_map_seen ON map_people(seen_at)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_events_starts ON events(starts_at, city)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_participants_device ON participants(device)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_leads_device ON leads(device)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_messages_event ON messages(event_id, id)`),
  ]);

  await addColumns(env, "leads", [
    ["first_name", "TEXT"],
    // impronta della foto profilo: serve a fermare la stessa foto usata da due profili
    ["photo_hash", "TEXT"],
    ["last_name", "TEXT"],
    ["phone", "TEXT"],
    ["interests", "TEXT"],
    ["bio", "TEXT"],
    ["looking_for", "TEXT"],
    ["done", "TEXT"],
    ["photo", "TEXT"],
    ["email_verified", "INTEGER NOT NULL DEFAULT 0"],
    ["phone_verified", "INTEGER NOT NULL DEFAULT 0"],
    ["age", "INTEGER"],
    ["sex", "TEXT"],
    ["locale", "TEXT"],
    ["goals", "TEXT"],
    ["meet", "TEXT"],
    ["outings", "TEXT"],
    ["consent", "INTEGER NOT NULL DEFAULT 1"],
    ["last_seen", "INTEGER"],
    ["password_hash", "TEXT"],
    ["face_selfie", "TEXT"],
    ["verified_face", "INTEGER NOT NULL DEFAULT 0"],
    ["face_pending", "INTEGER NOT NULL DEFAULT 0"],
    ["photo_face", "TEXT"],
    ["password_salt", "TEXT"],
    ["face_no", "INTEGER NOT NULL DEFAULT 0"],
    ["face_score", "REAL"],
    ["face_at", "INTEGER"],
  ]);
  await addColumns(env, "events", [
    ["approval", "INTEGER NOT NULL DEFAULT 0"],
    ["signup_until", "INTEGER"],
    ["activity", "TEXT"],
    ["lat", "REAL"],
    ["lng", "REAL"],
    ["age_min", "INTEGER"],
    ["age_max", "INTEGER"],
    ["access", "TEXT NOT NULL DEFAULT 'open'"],
    // quando è stato modificato l'ultima volta (per rimetterlo in cima alla lista)
    ["updated_at", "INTEGER"],
    // eventi lunghi: ultimo giorno, giorni scelti, e il giorno che si ripete ogni settimana
    ["ends_at", "INTEGER"],
    ["days", "TEXT"],
    ["weekly_day", "INTEGER"],
    ["weekdays", "TEXT"],
    ["repeat_until", "INTEGER"],
    ["invite_code", "TEXT"],
    ["owner_email", "TEXT"],
    // da 1 a 3 foto dell'evento (elenco di chiavi delle immagini)
    ["photos", "TEXT"],
    // come si vive l'evento: energia e quanto porta fuori dalla comfort zone
    ["vibe", "TEXT"],
    ["comfort", "TEXT"],
  ]);
  await addColumns(env, "participants", [
    ["status", "TEXT NOT NULL DEFAULT 'going'"],
    ["message", "TEXT"],
  ]);
  await addColumns(env, "messages", [
    ["kind", "TEXT NOT NULL DEFAULT 'text'"],
    ["media", "TEXT"],
  ]);
  await addColumns(env, "chat_read", [["msg_id", "INTEGER NOT NULL DEFAULT 0"]]);
  await addColumns(env, "push_subs", [
    ["p256dh", "TEXT"],
    ["auth", "TEXT"],
    // com'è andato l'ultimo invio: così si vede dal pannello se il telefono riceve
    ["last_ok", "INTEGER"],
    ["last_fail", "INTEGER"],
    ["last_status", "INTEGER"],
  ]);
  await addColumns(env, "posts", [
    ["event_id", "TEXT"],
    ["event_title", "TEXT"],
  ]);

  await addColumns(env, "feedback", [
    ["kind", "TEXT NOT NULL DEFAULT ''"],
    ["stato", "TEXT NOT NULL DEFAULT 'nuova'"],
    ["diagnosi", "TEXT"],
    ["soluzione", "TEXT"],
    ["risposta", "TEXT"],
    ["azione", "TEXT"],
    ["azione_at", "INTEGER"],
    // a che famiglia appartiene l'errore: serve per chiuderle da sola quando la toppa è dentro
    ["classe", "TEXT"],
  ]);

  // chiudo da sola le segnalazioni delle famiglie già sistemate (e archivio quelle ferme)
  await sistemaSegnalazioni(env).catch(() => 0);

  // indici che hanno bisogno di colonne aggiunte dopo: si creano adesso
  for (const sql of [
    `CREATE INDEX IF NOT EXISTS idx_participants_event ON participants(event_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_participants_device_status ON participants(device, status)`,
    `CREATE INDEX IF NOT EXISTS idx_push_subs_email ON push_subs(email)`,
    `CREATE INDEX IF NOT EXISTS idx_mutes_device_scope ON mutes(device, scope)`,
    `CREATE INDEX IF NOT EXISTS idx_chat_read_device ON chat_read(device)`,
    `CREATE INDEX IF NOT EXISTS idx_reactions_msg ON reactions(msg_id)`,
    `CREATE INDEX IF NOT EXISTS idx_typing_event ON typing(event_id)`,
    `CREATE INDEX IF NOT EXISTS idx_posts_event ON posts(event_id)`,
    `CREATE INDEX IF NOT EXISTS idx_peek_device ON peek(device, at)`,
    // ricerche che girano a ogni apertura: senza indice diventano lente con tanti eventi
    `CREATE INDEX IF NOT EXISTS idx_leads_photo_hash ON leads(photo_hash)`,
    `CREATE INDEX IF NOT EXISTS idx_past_starts ON past_events(starts_at)`,
    `CREATE INDEX IF NOT EXISTS idx_storia_event ON storia(event_id)`,
    `CREATE INDEX IF NOT EXISTS idx_events_device ON events(device)`,
    `CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_sessioni_device ON sessioni(device, start_at)`,
  ]) {
    try { await env.DB.prepare(sql).run(); } catch {}
  }

  // tabelle delle statistiche: le creo una per una, così non si perdono nel lotto grande
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS ignora (device TEXT PRIMARY KEY, at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS person_dev (device TEXT PRIMARY KEY, email TEXT NOT NULL, at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS push_dead (endpoint TEXT PRIMARY KEY, email TEXT, device TEXT, status INTEGER, at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS sessioni (
       id TEXT PRIMARY KEY, device TEXT NOT NULL, chi TEXT NOT NULL DEFAULT '',
       modo TEXT NOT NULL DEFAULT '', start_at INTEGER NOT NULL, last_at INTEGER NOT NULL, end_at INTEGER)`,
    `INSERT OR IGNORE INTO person_dev (device, email, at)
       SELECT device, email, COALESCE(created_at, 0) FROM leads WHERE device IS NOT NULL AND length(device) >= 8`,
  ]) {
    await env.DB.prepare(sql).run().catch(() => {});
  }

  await env.DB.prepare(`INSERT INTO meta (k, v) VALUES ('schema', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`)
    .bind(String(SCHEMA_V))
    .run()
    .catch(() => {});
  ready = true;
}

async function addColumns(env, table, wanted) {
  const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
  const have = new Set((info.results || []).map((c) => c.name));
  for (const [name, type] of wanted) {
    if (!have.has(name)) {
      await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`).run();
    }
  }
}

/* ---------- protezioni basiche: troppe richieste da uno stesso posto ---------- */
const hits = new Map();

function clientIp(request) {
  const raw = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "";
  return raw.split(",")[0].trim().slice(0, 45) || "sconosciuto";
}

function tooMany(key, limit, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) {
    hits.set(key, arr);
    return true;
  }
  arr.push(now);
  hits.set(key, arr);
  if (hits.size > 4000) hits.clear();
  return false;
}

// figurine: solo queste, così nessuno può inventarsi roba strana
const STICKERS = [
  "love","party","fire","lol","wow","cry",
  "clap","dance","star","think","cool","hug",
  "cake","coffee","pizza","wave",
];
const REACTIONS = ["❤️", "😂", "👍", "😮", "😢", "🔥"];

// un evento finito resta in vista un paio d'ore, poi sparisce e viene cancellato
const EVENT_KEEP_MS = 3 * 60 * 60 * 1000; // finito l'evento, dopo tre ore sparisce

const LIMITS = {
  ask: [40, 60 * 60 * 1000],
  stt: [30, 60 * 60 * 1000],
  register: [8, 60 * 60 * 1000],
  login: [25, 10 * 60 * 1000],
  forgot: [6, 60 * 60 * 1000],
  reset: [12, 60 * 60 * 1000],
  feedback: [6, 60 * 60 * 1000],
  track: [150, 60 * 60 * 1000],
  events: [40, 60 * 60 * 1000],
  messages: [180, 60 * 60 * 1000],
  ping: [90, 60 * 60 * 1000],
  presence: [150, 60 * 60 * 1000],
  verify: [10, 60 * 60 * 1000],
  profile: [20, 60 * 60 * 1000],
  post: [80, 60 * 60 * 1000],
  extras: [40, 60 * 60 * 1000],
};

function limitFor(parts, method) {
  if (method !== "POST" && method !== "DELETE") return null;
  const a = parts[1];
  const b = parts[2];
  if (a === "map" && b === "ping") return "ping";
  if (a === "events" && parts[3] === "messages") return "messages";
  if (a === "events" && !b) return "events";
  if (a === "extras") return "extras";
  return LIMITS[a] ? a : null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

const bad = (message) => json({ error: message }, 400);

// le descrizioni tengono gli a capo e gli spazi come li scrive la persona:
// si tolgono solo gli spazi in fondo alle righe e le righe vuote di troppo
function testoLungo(value, min, max) {
  let s = String(value ?? "").replace(/\r\n?/g, "\n");
  s = s
    .split("\n")
    .map((r) => r.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "");
  if (s.trim().length < min || s.length > max) return null;
  return s;
}

function text(value, min, max) {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  if (s.length < min || s.length > max) return null;
  return s;
}

function isEmail(value) {
  const s = String(value ?? "").trim().toLowerCase();
  if (s.length < 5 || s.length > 120) return null;
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(s) ? s : null;
}

function phone(value) {
  const s = String(value ?? "").replace(/[\s.\-()/]/g, "");
  if (!/^\+?\d{7,15}$/.test(s)) return null;
  return s;
}

function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

function when(ts) {
  return new Date(ts).toLocaleString("it-IT", {
    timeZone: "Europe/Rome",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* ---------- base64url ---------- */

function b64uToBytes(value) {
  const s = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64u(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* ---------- notifiche push ---------- */

async function vapidAuth(env, endpoint, origin) {
  if (!env.VAPID_PRIVATE) throw new Error("VAPID_PRIVATE mancante");
  const jwk = JSON.parse(new TextDecoder().decode(b64uToBytes(env.VAPID_PRIVATE)));
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
  ]);
  const header = bytesToB64u(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: origin,
  };
  const payload = bytesToB64u(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(`${header}.${payload}`)
  );
  return `vapid t=${header}.${payload}.${bytesToB64u(new Uint8Array(signature))}, k=${VAPID_PUBLIC}`;
}

function catBytes(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// il testo viaggia DENTRO la notifica: il telefono non deve chiederlo a nessuno
async function encryptPush(message, p256dhB64, authB64) {
  const ua = b64uToBytes(p256dhB64);
  const authSecret = b64uToBytes(authB64);
  const ecdh = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ecdh.publicKey));
  const clientPub = await crypto.subtle.importKey("raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: clientPub }, ecdh.privateKey, 256)
  );
  const ikm = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const enc = new TextEncoder();
  const keyInfo = catBytes(enc.encode("WebPush: info"), new Uint8Array([0]), ua, asPublic);
  const prkBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: authSecret, info: keyInfo },
    ikm,
    256
  );
  const prk = await crypto.subtle.importKey("raw", new Uint8Array(prkBits), "HKDF", false, ["deriveBits"]);
  const cek = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("Content-Encoding: aes128gcm") },
        prk,
        128
      )
    ),
    "AES-GCM",
    false,
    ["encrypt"]
  );
  const nonce = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("Content-Encoding: nonce") },
      prk,
      96
    )
  );
  const plain = catBytes(enc.encode(JSON.stringify(message)), new Uint8Array([2]));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, cek, plain)
  );
  const rs = new Uint8Array([0, 0, 16, 0]); // record size 4096
  return catBytes(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

async function pushSendOne(env, endpoint, origin, message, keys) {
  try {
    const authorization = await vapidAuth(env, endpoint, origin);
    // TTL corto: un messaggio vecchio non serve, meglio non farlo arrivare in ritardo
    const headers = { TTL: "3600", Urgency: "high", Authorization: authorization };
    let body;
    if (message && keys?.p256dh && keys?.auth) {
      try {
        body = await encryptPush(message, keys.p256dh, keys.auth);
        headers["content-encoding"] = "aes128gcm";
        headers["content-type"] = "application/octet-stream";
      } catch {
        body = undefined; // se la cifratura non riesce, l'avviso parte lo stesso (testo chiesto al server)
      }
    }
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body,
    });
    const ora = Date.now();
    if (res.ok) {
      await env.DB.prepare(`UPDATE push_subs SET last_ok = ?, last_status = ? WHERE endpoint = ?`)
        .bind(ora, res.status, endpoint)
        .run()
        .catch(() => {});
    } else {
      await env.DB.prepare(`UPDATE push_subs SET last_fail = ?, last_status = ? WHERE endpoint = ?`)
        .bind(ora, res.status, endpoint)
        .run()
        .catch(() => {});
    }
    if (res.status === 404 || res.status === 410) {
      // il telefono non esiste più: app disinstallata o avvisi spenti. Me lo ricordo.
      await env.DB.prepare(
        `INSERT INTO push_dead (endpoint, email, device, status, at)
         SELECT endpoint, email, device, ?, ? FROM push_subs WHERE endpoint = ?
         ON CONFLICT(endpoint) DO UPDATE SET status = excluded.status, at = excluded.at`
      )
        .bind(res.status, ora, endpoint)
        .run()
        .catch(() => {});
      await env.DB.prepare(`DELETE FROM push_subs WHERE endpoint = ?`).bind(endpoint).run();
    }
    return res.status;
  } catch {
    return 0;
  }
}

const PUSH_MAX_PER_EVENT = 400; // oltre questo, un evento non manda avvisi a tutti in un colpo
const PUSH_BATCH = 20; // venti alla volta: regge anche con migliaia di iscritti

async function notifyNewEvent(env, event, origin) {
  const { results } = await env.DB.prepare(
    `SELECT p.endpoint AS endpoint, p.device AS device, p.categories AS categories,
            p.p256dh AS p256dh, p.auth AS auth, l.interests AS interests
     FROM push_subs p LEFT JOIN leads l ON l.email = p.email`
  ).all();
  const act = String(event.activity || "").toLowerCase();
  const muted = new Set(
    (((await env.DB.prepare(`SELECT device FROM mutes WHERE scope = 'all' AND (until = 0 OR until > ?)`).bind(Date.now()).all()).results) || []).map((r) => r.device)
  );
  const targets = (results || [])
    .filter((row) => {
      let list = ["ALL"];
      try {
        list = JSON.parse(row.categories || '["ALL"]');
      } catch {}
      if (muted.has(row.device)) return false;
      if (list.includes("ALL") || list.includes(event.category)) return true;
      // se è proprio una delle attività che ha scelto, l'avviso arriva comunque
      try {
        const ints = JSON.parse(row.interests || "[]");
        return Boolean(act) && ints.some((i) => String(i).toLowerCase() === act);
      } catch {
        return false;
      }
    })
    .slice(0, PUSH_MAX_PER_EVENT);

  // il testo viaggia dentro la notifica: niente giri in più quando sono in tanti
  const quando = new Date(Number(event.startsAt) || Date.now()).toLocaleString("it-IT", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Rome",
  });
  const message = {
    title: event.title || "Nuovo evento",
    body: `${quando} · ${event.place || "Catania"}${event.activity ? " — " + event.activity : ""}`.slice(0, 180),
    url: `/?e=${event.id}`,
  };

  const statuses = [];
  for (let i = 0; i < targets.length; i += PUSH_BATCH) {
    const slice = targets.slice(i, i + PUSH_BATCH);
    const done = await Promise.all(
      slice.map((row) => pushSendOne(env, row.endpoint, origin, message, row).catch(() => 0))
    );
    statuses.push(...done);
  }
  return { targeted: targets.length, reached: (results || []).length, statuses };
}

// l'app dice "sono aperta": serve a capire se si apre davvero e come
async function noteOpen(env, request) {
  const body = await request.json().catch(() => null);
  if (body?.test) return json({ ok: true, skip: true });   // giro di prova: non si registra
  const device = text(body?.device, 8, 64);
  if (!device) return bad("device");
  if (telefonoProva(device)) return json({ ok: true, skip: true });
  const mode = body?.mode === "app" ? "app" : "browser";
  const ua = String(body?.ua || "").slice(0, 140);
  const now = Date.now();
  const last = await env.DB.prepare(`SELECT at FROM opens WHERE device = ?`).bind(device).first();
  await env.DB.prepare(
    `INSERT INTO opens (device, at, mode, ua) VALUES (?, ?, ?, ?)
     ON CONFLICT(device) DO UPDATE SET at = excluded.at, mode = excluded.mode, ua = excluded.ua`
  )
    .bind(device, now, mode, ua)
    .run();
  // le aperture non finiscono più nel registro attività: erano righe anonime
  // ("aperto nel browser") che riempivano la parte alta degli insight
  return json({ ok: true });
}

async function liveFeed(env, url, request) {
  const device = (url.searchParams.get("device") || "").slice(0, 64);
  const since = Math.max(0, Number(url.searchParams.get("since")) || 0);
  const ok = (await isOwnerDevice(env, device)) || (await adminOk(env, url));
  if (!ok) return json({ error: "Solo il padrone." }, 403);
  const now = Date.now();
  const mio = ownerEmail(env);
  const mioLead = await env.DB.prepare(
    `SELECT first_name, COALESCE(first_name,'') || ' ' || COALESCE(last_name,'') AS nome FROM leads WHERE lower(email) = ? LIMIT 1`
  )
    .bind(mio)
    .first()
    .catch(() => null);
  const mioNome = String(mioLead?.first_name || "").toLowerCase();
  const mioNomeIntero = String(mioLead?.nome || "").toLowerCase();
  const { results } = await env.DB.prepare(
    `SELECT id, kind, who, detail, event_id, at FROM activity
      WHERE id > ?
        AND lower(COALESCE(who, '')) <> ?
        AND lower(COALESCE(who, '')) <> ?
        AND lower(COALESCE(who, '')) <> ?
        AND lower(COALESCE(who, '')) NOT LIKE '%prova%'
      ORDER BY id DESC LIMIT 40`
  )
    .bind(since, mio, mioNome, mioNomeIntero)
    .all();
  // solo quelle davvero da guardare: chi ha già il viso verificato non è più in attesa
  const pending = await env.DB.prepare(`SELECT COUNT(*) AS n FROM leads WHERE face_pending = 1 AND verified_face = 0 AND face_selfie IS NOT NULL`).first();

  // tutte le operazioni fatte dentro l'app: ogni tocco registrato, con il nome di chi l'ha fatto
  const opsRows = await env.DB.prepare(
    `SELECT k.device, k.kind, k.detail, k.at,
            COALESCE(
              (SELECT COALESCE(NULLIF(TRIM(COALESCE(l.first_name, '') || ' ' || COALESCE(l.last_name, '')), ''), l.email)
                 FROM leads l WHERE l.device = k.device ORDER BY l.created_at DESC LIMIT 1),
              (SELECT pd.email FROM person_dev pd WHERE pd.device = k.device LIMIT 1),
              ''
            ) AS chi
       FROM peek k
      WHERE k.at >= ?
        AND k.device NOT IN (SELECT device FROM owner_dev)
        AND k.device NOT IN (SELECT device FROM ignora)
      ORDER BY k.at DESC LIMIT 60`
  )
    .bind(now - 7 * 864e5)
    .all()
    .catch(() => ({ results: [] }));
  const ops = (opsRows.results || []).map((r) => ({
    k: r.kind,
    d: r.detail || "",
    chi: r.chi || "Ospite",
    at: Number(r.at) || 0,
  }));

  // quanto tempo ognuno passa dentro l'app nelle ultime 24 ore, e la media
  await ensureSessioni(env);
  const tempiRows = await env.DB.prepare(
    `SELECT device, COALESCE(NULLIF(chi, ''), '') AS chi, COUNT(*) AS n,
            CAST(SUM(MAX(0, MIN(7200000, (CASE WHEN end_at IS NULL THEN MIN(last_at, ?1) ELSE end_at END) - start_at))) / 1000 AS INTEGER) AS sec,
            MAX(CASE WHEN end_at IS NULL THEN last_at ELSE end_at END) AS ultima,
            SUM(CASE WHEN end_at IS NULL AND last_at >= ?3 THEN 1 ELSE 0 END) AS dentro
       FROM sessioni
      WHERE start_at >= ?2 AND device <> ''
        AND device NOT IN (SELECT device FROM owner_dev)
        AND device NOT IN (SELECT device FROM ignora)
        AND device NOT LIKE 'prova%' AND device NOT LIKE 'test%' AND device NOT LIKE 'demo%'
      GROUP BY device
      ORDER BY sec DESC LIMIT 40`
  )
    .bind(now, now - 864e5, now - 3 * 60 * 1000)
    .all()
    .catch(() => ({ results: [] }));
  const tempi = (tempiRows.results || [])
    .filter((r) => Number(r.sec) > 0)
    .map((r) => ({
      chi: r.chi || "Senza profilo",
      sec: Number(r.sec) || 0,
      aperture: Number(r.n) || 0,
      dentro: Number(r.dentro) > 0,
      ultima: Number(r.ultima) || 0,
      tu: r.device === device,
    }));
  const secondiTotali = tempi.reduce((a, r) => a + r.sec, 0);
  const media = tempi.length ? Math.round(secondiTotali / tempi.length) : 0;

  // chi è online adesso, con il nome: tu resti fuori (device, mail e dispositivi tuoi)
  const onlineRows = await env.DB
    .prepare(
      `SELECT p.device, p.seen_at,
              COALESCE(
                (SELECT COALESCE(NULLIF(TRIM(COALESCE(l.first_name,'') || ' ' || COALESCE(l.last_name,'')), ''), l.email)
                   FROM leads l WHERE l.device = p.device ORDER BY l.created_at DESC LIMIT 1),
                (SELECT pd.email FROM person_dev pd WHERE pd.device = p.device LIMIT 1),
                'Ospite'
              ) AS chi,
              (SELECT o.mode FROM opens o WHERE o.device = p.device) AS modo
         FROM presence p
        WHERE p.seen_at >= ?
          AND p.device <> ?
          AND p.device NOT IN (SELECT device FROM owner_dev)
          AND p.device NOT IN (SELECT device FROM ignora)
          AND p.device NOT LIKE 'prova%' AND p.device NOT LIKE 'test%' AND p.device NOT LIKE 'demo%'
        ORDER BY p.seen_at DESC LIMIT 20`
    )
    .bind(now - 3 * 60 * 1000, device)
    .all()
    .catch(() => ({ results: [] }));
  const online = (onlineRows.results || [])
    .filter((r) => !mioNome || String(r.chi || "").toLowerCase() !== mioNome)
    .map((r) => ({ chi: r.chi || "Ospite", at: Number(r.seen_at) || 0, modo: r.modo || "" }));

  // chi ha votato qualcosa, e cosa: non solo un numero, ma i nomi e il voto
  await ensureRatings(env).catch(() => {});
  const votiRows = await env.DB
    .prepare(
      `SELECT r.event_id, r.stars, r.vote, r.at,
              (SELECT COALESCE(NULLIF(pe.title,''), NULLIF(e.title,''), 'Ricordo') FROM past_events pe LEFT JOIN events e ON e.id = pe.id WHERE pe.id = r.event_id LIMIT 1) AS titolo,
              COALESCE(
                (SELECT COALESCE(NULLIF(TRIM(COALESCE(l.first_name,'') || ' ' || COALESCE(l.last_name,'')), ''), l.email)
                   FROM leads l WHERE l.device = r.device ORDER BY l.created_at DESC LIMIT 1),
                (SELECT pd.email FROM person_dev pd WHERE pd.device = r.device LIMIT 1),
                'Ospite'
              ) AS chi
         FROM event_ratings r
        WHERE r.device <> ?
          AND r.device NOT IN (SELECT device FROM owner_dev)
          AND r.device NOT IN (SELECT device FROM ignora)
          AND r.device NOT LIKE 'prova%' AND r.device NOT LIKE 'test%' AND r.device NOT LIKE 'demo%'
        ORDER BY r.at DESC LIMIT 20`
    )
    .bind(device)
    .all()
    .catch(() => ({ results: [] }));
  const voti = (votiRows.results || []).map((r) => ({
    chi: r.chi || "Ospite",
    titolo: r.titolo || "",
    stelle: Number(r.stars) || 0,
    pollice: Number(r.vote) || 0,
    at: Number(r.at) || 0,
  }));

  return json({
    items: results || [],
    ops,
    online,
    voti,
    tempi,
    media,
    tempoTotale: secondiTotali,
    profili: tempi.length,
    now,
    pendingVerify: pending?.n || 0,
  });
}

// la tabella dei tempi deve esserci sempre: la creo al volo se manca
let sessioniOk = false;
async function ensureSessioni(env) {
  if (sessioniOk) return;
  sessioniOk = true;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS sessioni (
       id TEXT PRIMARY KEY, device TEXT NOT NULL, chi TEXT NOT NULL DEFAULT '',
       modo TEXT NOT NULL DEFAULT '', start_at INTEGER NOT NULL, last_at INTEGER NOT NULL, end_at INTEGER)`
  )
    .run()
    .catch(() => {});
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_sessioni_device ON sessioni(device, start_at)`)
    .run()
    .catch(() => {});
}

// il nome della persona che sta usando questo telefono (vuoto se non si è registrata)
async function nomePersona(env, device) {
  try {
    const row = await env.DB.prepare(
      `SELECT COALESCE(NULLIF(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), ''), email) AS nome
         FROM leads WHERE device = ? ORDER BY created_at DESC LIMIT 1`
    )
      .bind(device)
      .first();
    if (row?.nome) return String(row.nome).slice(0, 60);
    const via = await env.DB.prepare(`SELECT email FROM person_dev WHERE device = ?`).bind(device).first();
    if (via?.email) {
      const l = await env.DB.prepare(
        `SELECT COALESCE(NULLIF(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), ''), email) AS nome
           FROM leads WHERE lower(email) = lower(?) LIMIT 1`
      )
        .bind(via.email)
        .first();
      return String(l?.nome || via.email || "").slice(0, 60);
    }
  } catch {}
  return "";
}

// ogni apertura, ogni minuto dentro e ogni chiusura: così si sa quanto tempo sta ognuno
async function noteSessione(env, request) {
  const body = await request.json().catch(() => null);
  if (!body || body.test) return json({ ok: true, skip: true });
  const device = text(body.device, 8, 64);
  const id = text(body.id, 6, 64);
  if (!device || !id) return json({ ok: false });
  if (telefonoProva(device)) return json({ ok: true, skip: true });
  await ensureSessioni(env);
  const stato = body.stato === "fine" ? "fine" : body.stato === "battito" ? "battito" : "inizio";
  const modo = body.modo === "app" ? "app" : "browser";
  const now = Date.now();
  const chi = await nomePersona(env, device);
  try {
    if (stato === "inizio") {
      await env.DB.prepare(
        `INSERT INTO sessioni (id, device, chi, modo, start_at, last_at, end_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET last_at = excluded.last_at,
           chi = CASE WHEN sessioni.chi = '' THEN excluded.chi ELSE sessioni.chi END`
      )
        .bind(id, device, chi, modo, now, now)
        .run();
      await logActivity(env, "open", chi || "Qualcuno", modo === "app" ? "app" : "browser", null);
    } else if (stato === "fine") {
      const res = await env.DB.prepare(
        `UPDATE sessioni SET last_at = ?, end_at = ?, chi = CASE WHEN chi = '' THEN ? ELSE chi END
          WHERE id = ? AND device = ? AND end_at IS NULL`
      )
        .bind(now, now, chi, id, device)
        .run();
      if (res?.meta?.changes) await logActivity(env, "close", chi || "Qualcuno", "", null);
    } else {
      await env.DB.prepare(
        `UPDATE sessioni SET last_at = ?, chi = CASE WHEN chi = '' THEN ? ELSE chi END
          WHERE id = ? AND device = ?`
      )
        .bind(now, chi, id, device)
        .run();
    }
    if (Math.random() < 0.05) {
      await env.DB.prepare(`DELETE FROM sessioni WHERE start_at < ?`).bind(now - 30 * 864e5).run();
    }
  } catch {}
  return json({ ok: true });
}

async function pushSubscribe(env, request) {
  const body = await request.json().catch(() => null);
  const sub = body?.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return bad("Sottoscrizione non valida.");
  }
  const email = isEmail(body.email) || "";
  const categories =
    Array.isArray(body.categories) && body.categories.length
      ? body.categories.filter((c) => CATEGORIES.includes(c)).slice(0, 12)
      : ["ALL"];
  const device = text(body.device ?? "", 0, 64) || "";

  if (device) {
    await env.DB.prepare(`DELETE FROM push_subs WHERE device = ? AND endpoint <> ?`)
      .bind(device, sub.endpoint.slice(0, 500))
      .run()
      .catch(() => {});
  }

  await env.DB.prepare(
    `INSERT INTO push_subs (endpoint, email, categories, device, created_at, p256dh, auth) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET email = excluded.email, categories = excluded.categories,
       device = CASE WHEN excluded.device <> '' THEN excluded.device ELSE push_subs.device END,
       p256dh = excluded.p256dh, auth = excluded.auth`
  )
    .bind(
      sub.endpoint.slice(0, 500),
      email,
      JSON.stringify(categories),
      device,
      Date.now(),
      String(sub.keys.p256dh || "").slice(0, 200),
      String(sub.keys.auth || "").slice(0, 100)
    )
    .run();

  const row = await env.DB.prepare(`SELECT * FROM leads WHERE email = ?`).bind(email).first();
  return json({ ok: true, categories, person: row ? personOf(row) : null });
}

// lo stato vero degli avvisi per questo telefono: serve a capire subito
// se il problema è il permesso, l'iscrizione o la consegna
async function pushState(env, url) {
  const device = (url.searchParams.get("device") || "").slice(0, 64);
  const email = (url.searchParams.get("email") || "").trim().toLowerCase().slice(0, 120);
  const { results } = await env.DB.prepare(
    `SELECT endpoint, last_status, last_ok, last_fail FROM push_subs
     WHERE (email <> '' AND email = ?) OR (device <> '' AND device = ?)`
  )
    .bind(email || "", device || "")
    .all()
    .catch(() => ({ results: [] }));
  const primo = (results || [])[0] || null;
  return json({
    ok: true,
    subs: (results || []).length,
    stato: primo ? { status: primo.last_status || 0, ok: primo.last_ok || 0, fail: primo.last_fail || 0 } : null,
    vapid: Boolean(env.VAPID_PRIVATE),
  });
}

// l'iscrizione push cambia da sola (scade): qui sposto i dati del vecchio endpoint al nuovo
async function pushRenew(env, request) {
  const body = await request.json().catch(() => null);
  const sub = body?.subscription;
  const oldEp = String(body?.oldEndpoint || "").slice(0, 500);
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth || !oldEp) return bad("renew");
  const email = isEmail(body.email) || "";
  const device = text(body.device ?? "", 0, 64) || "";
  const row = await env.DB.prepare(`SELECT email, categories, device FROM push_subs WHERE endpoint = ?`).bind(oldEp).first().catch(() => null);
  await env.DB.prepare(
    `INSERT INTO push_subs (endpoint, email, categories, device, created_at, p256dh, auth) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET email = excluded.email, categories = excluded.categories,
       device = excluded.device, p256dh = excluded.p256dh, auth = excluded.auth`
  )
    .bind(
      sub.endpoint.slice(0, 500),
      email || row?.email || "",
      row?.categories || '["ALL"]',
      device || row?.device || "",
      Date.now(),
      String(sub.keys.p256dh || "").slice(0, 200),
      String(sub.keys.auth || "").slice(0, 100)
    )
    .run()
    .catch(() => {});
  await env.DB.prepare(`DELETE FROM push_subs WHERE endpoint = ?`).bind(oldEp).run().catch(() => {});
  return json({ ok: true });
}

async function pushTest(env, request, origin) {
  const body = await request.json().catch(() => null);
  const email = isEmail(body?.email);
  const device = String(body?.device || "").slice(0, 64);
  if (!email && !device) return bad("Serve la mail con cui ti sei registrato.");
  const { results } = await env.DB.prepare(
    `SELECT endpoint, p256dh, auth FROM push_subs
     WHERE (email <> '' AND email = ?) OR (device <> '' AND device = ?)`
  )
    .bind(email || "", device)
    .all();
  if (!results?.length) {
    return json({ error: "Nessun avviso attivo per questa mail. Attivali prima." }, 404);
  }
  const prova = { title: "FUORI", body: "Prova: se leggi questo, gli avvisi arrivano anche ad app chiusa.", url: "/" };
  const statuses = await Promise.all(results.map((row) => pushSendOne(env, row.endpoint, origin, prova, row)));
  return json({ ok: true, sent: statuses.length, statuses });
}

/* ---------- silenziare un gruppo, o tutti ---------- */

async function isMuted(env, device, eventId) {
  if (!device) return false;
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT scope, until FROM mutes WHERE device = ? AND (scope = 'all' OR scope = ?)`
  )
    .bind(device, "event:" + eventId)
    .all();
  return (results || []).some((r) => !r.until || r.until > now);
}

async function muteInfo(env, device) {
  const now = Date.now();
  const { results } = await env.DB.prepare(`SELECT scope, until FROM mutes WHERE device = ?`).bind(device).all();
  const all = (results || []).find((r) => r.scope === "all");
  const groups = {};
  for (const r of results || []) {
    if (!r.scope.startsWith("event:")) continue;
    if (!r.until || r.until > now) groups[r.scope.slice(6)] = r.until || 0;
  }
  return { all: all && (!all.until || all.until > now) ? all.until || 0 : null, groups };
}

async function setMute(env, request) {
  const body = await request.json().catch(() => null);
  const device = text(body?.device, 8, 64);
  if (!device) return bad("device");
  const scope = body?.scope === "all" ? "all" : body?.eventId ? "event:" + text(body.eventId, 1, 40) : null;
  if (!scope) return bad("scope");
  if (body?.off) {
    await env.DB.prepare(`DELETE FROM mutes WHERE device = ? AND scope = ?`).bind(device, scope).run();
    return json({ ok: true, ...(await muteInfo(env, device)) });
  }
  const days = Number(body.days) || 0;
  const until = days > 0 ? Date.now() + days * 24 * 60 * 60 * 1000 : 0;
  await env.DB.prepare(
    `INSERT INTO mutes (device, scope, until) VALUES (?, ?, ?) ON CONFLICT(device, scope) DO UPDATE SET until = excluded.until`
  )
    .bind(device, scope, until)
    .run();
  return json({ ok: true, ...(await muteInfo(env, device)) });
}

/* ---------- avvisi alle persone giuste ---------- */

// chi è "dentro" un evento: chi organizza e chi partecipa
async function eventAudience(env, id, except) {
  const ev = await env.DB.prepare(`SELECT device FROM events WHERE id = ?`).bind(id).first();
  const { results } = await env.DB.prepare(
    `SELECT device FROM participants WHERE event_id = ? AND status = 'going'`
  )
    .bind(id)
    .all();
  const all = [ev?.device, ...(results || []).map((r) => r.device)];
  return [...new Set(all.filter((d) => d && d !== except))];
}

// registro di quello che succede: serve agli insight in tempo reale
// totali che restano anche quando gli eventi vecchi vengono cancellati
async function bump(env, key, n = 1) {
  try {
    await env.DB.prepare(
      `INSERT INTO tally (key, n) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET n = n + excluded.n`
    )
      .bind(key, n)
      .run();
  } catch {}
}

async function logActivity(env, kind, who, detail, eventId) {
  if (telefonoProva(who)) return;
  if (/prova|zz-/i.test(String(who || "")) || /^zz/i.test(String(detail || ""))) return;
  try {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO activity (kind, who, detail, event_id, at) VALUES (?, ?, ?, ?, ?)`
      ).bind(kind, String(who || "").slice(0, 120), String(detail || "").slice(0, 200), eventId || null, now),
      env.DB.prepare(`DELETE FROM activity WHERE at < ?`).bind(now - 8 * 24 * 60 * 60 * 1000),
    ]);
  } catch {}
}

async function deliverEndpoints(env, endpoints, message, origin) {
  const list = [...new Set(endpoints || [])].filter(Boolean);
  if (!list.length) return 0;
  const now = Date.now();
  await env.DB.batch(
    list.map((ep) =>
      env.DB.prepare(
        `INSERT INTO pend_notif (sub, title, body, url, at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(sub) DO UPDATE SET title = excluded.title, body = excluded.body, url = excluded.url, at = excluded.at`
      ).bind(ep.slice(0, 500), String(message.title || "").slice(0, 80), String(message.body || "").slice(0, 180), message.url || "/", now)
    )
  );
  // le chiavi servono a mettere il testo dentro la notifica
  let keyMap = new Map();
  try {
    const { results } = await env.DB.prepare(
      `SELECT endpoint, p256dh, auth FROM push_subs WHERE endpoint IN (${list.map(() => "?").join(",")})`
    )
      .bind(...list)
      .all();
    keyMap = new Map((results || []).map((r) => [r.endpoint, r]));
  } catch {}
  const statuses = await Promise.all(list.map((ep) => pushSendOne(env, ep, origin, message, keyMap.get(ep))));
  const morti = list.filter((ep, i) => statuses[i] === 404 || statuses[i] === 410);
  if (morti.length) {
    try {
      await env.DB.prepare(`DELETE FROM push_subs WHERE endpoint IN (${morti.map(() => "?").join(",")})`)
        .bind(...morti)
        .run();
    } catch {}
  }
  // se nessun telefono accetta l'avviso, lo scrivo nel registro: così non passa in silenzio
  if (statuses.length && statuses.every((s) => !s || s >= 400)) {
    try {
      const last = await env.DB.prepare(
        `SELECT at FROM activity WHERE kind = 'error' AND title = 'Avvisi non partiti' ORDER BY at DESC LIMIT 1`
      ).first();
      if (!last || Date.now() - last.at > 60 * 60 * 1000) {
        await logActivity(env, "error", "Avvisi non partiti", "Il telefono non ha accettato la notifica (" + statuses.join(",") + ").", null);
      }
    } catch {}
  }
  return list.length;
}

// i telefoni del padrone: i suoi dispositivi e la sua mail
async function ownerEndpoints(env) {
  const { results } = await env.DB.prepare(
    `SELECT endpoint FROM push_subs WHERE email = ? OR device IN (SELECT device FROM owner_dev)`
  )
    .bind(ownerEmail(env))
    .all();
  return (results || []).map((r) => r.endpoint).filter(Boolean);
}

// avvisi di lavoro: sempre, anche se il padrone ha silenziato i gruppi
async function notifyOwner(env, message, origin, ctx) {
  const job = (async () => {
    const eps = await ownerEndpoints(env);
    return deliverEndpoints(env, eps, message, origin);
  })().catch(() => 0);
  if (ctx?.waitUntil) ctx.waitUntil(job);
  else await job;
}

// manda l'avviso a quei telefoni, saltando chi ha silenziato il gruppo o tutti
async function notifyDevices(env, devices, eventId, message, origin) {
  const list = [...new Set(devices || [])].filter(Boolean);
  const targets = [];
  for (const dev of list) {
    if (await isMuted(env, dev, eventId)) continue;
    const { results } = await env.DB.prepare(`SELECT endpoint FROM push_subs WHERE device = ?`).bind(dev).all();
    for (const r of results || []) if (r.endpoint) targets.push(r.endpoint);
  }
  return deliverEndpoints(env, targets, message, origin);
}

async function latest(env, url) {
  const sub = (url && url.searchParams.get("s") || "").slice(0, 500);
  // se c'è un avviso appena arrivato (messaggio, richiesta, invito) quello viene prima
  if (sub) {
    const pend = await env.DB.prepare(
      `SELECT title, body, url FROM pend_notif WHERE sub = ? AND at > ?`
    )
      .bind(sub, Date.now() - 15 * 60 * 1000)
      .first();
    if (pend) return json({ title: pend.title, body: pend.body, url: pend.url });
  }
  let interests = [];
  if (sub) {
    const mine = await env.DB.prepare(
      `SELECT l.interests AS interests FROM push_subs p LEFT JOIN leads l ON l.email = p.email WHERE p.endpoint = ?`
    )
      .bind(sub)
      .first();
    try {
      interests = JSON.parse((mine && mine.interests) || "[]");
    } catch {}
  }

  // prima quello appena pubblicato, sennò il prossimo in arrivo
  let ev = await env.DB.prepare(
    `SELECT * FROM events WHERE starts_at >= ? ORDER BY created_at DESC LIMIT 1`
  )
    .bind(Date.now() - 6 * 60 * 60 * 1000)
    .first();
  if (!ev) {
    ev = await env.DB.prepare(`SELECT * FROM events WHERE starts_at >= ? ORDER BY starts_at ASC LIMIT 1`)
      .bind(Date.now())
      .first();
  }
  if (!ev) {
    return json({
      title: "Nessun evento, per ora",
      body: "Appena qualcuno ne pubblica uno ti arriva il primo avviso. Intanto guarda cosa c'è in giro.",
      url: "./",
    });
  }

  const going = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM participants WHERE event_id = ? AND status = 'going'`
  )
    .bind(ev.id)
    .first();
  const free = Math.max(0, (Number(ev.capacity) || 0) - Number((going && going.n) || 0));
  const spots = free === 0 ? "è pieno" : free === 1 ? "un posto solo libero" : `${free} posti liberi`;
  const desc = String(ev.description || "").replace(/\s+/g, " ").trim();
  const hook = desc ? `“${desc.slice(0, 80)}${desc.length > 80 ? "…" : ""}”` : ev.activity || "";
  const act = String(ev.activity || "").toLowerCase();
  const forYou = Boolean(act) && interests.some((i) => String(i).toLowerCase() === act);

  return json({
    title: `${forYou ? "Per te" : "Nuovo"}: ${String(ev.title || "").slice(0, 44)}`,
    body: `${when(ev.starts_at)} · ${ev.place} · ${spots}${hook ? " — " + hook : ""}`.slice(0, 190),
    url: `./?e=${ev.id}`,
  });
}

/* ---------- codici di verifica ---------- */

async function sendCode(env, channel, target, code) {
  // Email: se c'è RESEND_API_KEY parte davvero, altrimenti siamo in modalità prova.
  if (channel === "email" && env.RESEND_API_KEY) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.RESEND_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: env.MAIL_FROM || "FUORI <onboarding@resend.dev>",
          to: [target],
          subject: `FUORI · ${code} è il tuo codice`,
          text: `Il tuo codice è ${code}. Scade tra ${CODE_MINUTES} minuti. Se non sei stato tu, ignora questa mail.`,
        }),
      });
      return { sent: res.ok };
    } catch {
      return { sent: false };
    }
  }

  // SMS: pronto per il fornitore, non configurato.
  if (channel === "phone" && env.SMS_API_KEY && env.SMS_FROM) {
    return { sent: false };
  }

  return { sent: false };
}

async function requestCode(env, request) {
  const body = await request.json().catch(() => null);
  if (!body) return bad("body");

  const channel = body.channel === "phone" ? "phone" : "email";
  const target = channel === "phone" ? phone(body.phone) : isEmail(body.email);
  if (!target) return bad(channel === "phone" ? "Numero non valido." : "Mail non valida.");

  const existing = await env.DB.prepare(
    `SELECT created_at FROM codes WHERE target = ? AND channel = ?`
  )
    .bind(target, channel)
    .first();
  if (existing && Date.now() - existing.created_at < 60000) {
    return json({ error: "Aspetta un minuto prima di chiedere un altro codice." }, 429);
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  await env.DB.prepare(
    `INSERT INTO codes (target, channel, code, expires_at, attempts, created_at) VALUES (?, ?, ?, ?, 0, ?)
     ON CONFLICT(target, channel) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at, attempts = 0, created_at = excluded.created_at`
  )
    .bind(target, channel, code, Date.now() + CODE_MINUTES * 60 * 1000, Date.now())
    .run();

  const delivery = await sendCode(env, channel, target, code);

  return json({
    ok: true,
    channel,
    sent: delivery.sent,
    // modalità prova: senza fornitore configurato il codice si vede qui
    code: delivery.sent ? undefined : code,
  });
}

async function confirmCode(env, request) {
  const body = await request.json().catch(() => null);
  if (!body) return bad("body");

  const channel = body.channel === "phone" ? "phone" : "email";
  const target = channel === "phone" ? phone(body.phone) : isEmail(body.email);
  const code = String(body.code ?? "").replace(/\D/g, "");
  if (!target) return bad("Dati non validi.");
  if (code.length !== 6) return bad("Il codice ha sei cifre.");

  const row = await env.DB.prepare(`SELECT * FROM codes WHERE target = ? AND channel = ?`)
    .bind(target, channel)
    .first();
  if (!row) return bad("Nessun codice da confermare. Richiedine uno nuovo.");
  if (Date.now() > row.expires_at) {
    await env.DB.prepare(`DELETE FROM codes WHERE target = ? AND channel = ?`).bind(target, channel).run();
    return bad("Codice scaduto. Richiedine uno nuovo.");
  }
  if (row.attempts >= 5) {
    await env.DB.prepare(`DELETE FROM codes WHERE target = ? AND channel = ?`).bind(target, channel).run();
    return bad("Troppi tentativi. Richiedi un nuovo codice.");
  }

  if (row.code !== code) {
    await env.DB.prepare(`UPDATE codes SET attempts = attempts + 1 WHERE target = ? AND channel = ?`)
      .bind(target, channel)
      .run();
    return bad("Codice sbagliato.");
  }

  await env.DB.prepare(`DELETE FROM codes WHERE target = ? AND channel = ?`).bind(target, channel).run();

  if (channel === "email") {
    await env.DB.prepare(`UPDATE leads SET email_verified = 1 WHERE email = ?`).bind(target).run();
  } else {
    await env.DB.prepare(`UPDATE leads SET phone_verified = 1 WHERE phone = ?`).bind(target).run();
  }

  return json({ ok: true, channel });
}

/* ---------- persone ---------- */

async function saveLead(env, { email, city, device, source }) {
  const clean = isEmail(email);
  if (!clean) return false;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO leads (email, city, device, source, created_at) VALUES (?, ?, ?, ?, ?)`
  )
    .bind(clean, (city || CITY).slice(0, 40), (device || "").slice(0, 64), (source || "app").slice(0, 24), Date.now())
    .run();
  // segno che questo dispositivo è di questa persona: se domani entra da un altro
  // browser o reinstalla, nei numeri resta sempre una persona sola
  const dev = String(device || "").slice(0, 64);
  if (dev.length >= 8) {
    await env.DB.prepare(
      `INSERT INTO person_dev (device, email, at) VALUES (?, ?, ?)
       ON CONFLICT(device) DO UPDATE SET email = excluded.email, at = excluded.at`
    )
      .bind(dev, clean, Date.now())
      .run()
      .catch(() => {});
  }
  return true;
}

function safeList(value) {
  try { const v = JSON.parse(value || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}

function publicProfile(row, counts) {
  const first = row.first_name || "";
  const last = row.last_name || "";
  return {
    name: [first, last ? `${last.slice(0, 1)}.` : ""].filter(Boolean).join(" ") || "Anonimo",
    fullName: [first, last].filter(Boolean).join(" "),
    age: row.age || null,
    sex: row.sex || "",
    bio: row.bio || "",
    lookingFor: row.looking_for || "",
    done: row.done || "",
    photo: row.photo ? `/api/photo/${row.photo}` : "",
    verified: Boolean(row.email_verified && row.phone_verified),
    emailVerified: Boolean(row.email_verified),
    phoneVerified: Boolean(row.phone_verified),
    city: row.city || CITY,
    since: row.created_at,
    events: counts?.events || 0,
    going: counts?.going || 0,
  };
}

function personOf(row) {
  return {
    firstName: row.first_name || "",
    lastName: row.last_name || "",
    email: row.email,
    phone: row.phone || "",
    city: row.city || CITY,
    age: row.age || null,
    sex: row.sex || "n",
    bio: row.bio || "",
    lookingFor: row.looking_for || "",
    done: row.done || "",
    photo: row.photo ? `/api/photo/${row.photo}` : "",
    interests: safeList(row.interests),
    locale: row.locale || "it",
    verified: !!row.verified_face,
    facePending: !!row.face_pending,
    photoBad: !!row.photo_bad,
  };
}

async function hashPassword(password, saltB64) {
  const enc = new TextEncoder();
  const salt = saltB64
    ? Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0))
    : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    key,
    256
  );
  return {
    hash: bytesToB64u(new Uint8Array(bits)),
    salt: btoa(String.fromCharCode(...salt)),
  };
}

async function getProfile(env, url) {
  const email = isEmail(url.searchParams.get("email"));
  const device = (url.searchParams.get("device") || "").slice(0, 64);

  const row = email
    ? await env.DB.prepare(`SELECT * FROM leads WHERE email = ?`).bind(email).first()
    : device
    ? await env.DB.prepare(
        `SELECT * FROM leads WHERE device = ? ORDER BY created_at DESC LIMIT 1`
      )
        .bind(device)
        .first()
    : null;

  if (!row) return json({ error: "Profilo non trovato." }, 404);

  const [created, going] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE device = ?`).bind(row.device || "").first(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM participants WHERE device = ? AND status = 'going'`)
      .bind(row.device || "")
      .first(),
  ]);

  return json({ person: personOf(row), profile: publicProfile(row, { events: created?.n, going: going?.n }) });
}

async function saveProfile(env, request) {
  const body = await request.json().catch(() => null);
  if (!body) return bad("body");
  const device = text(body.device, 8, 64);
  if (!device) return bad("device");
  const me = await personFor(env, device);
  if (!me) return json({ error: "Prima entra: ci vuole un attimo." }, 403);
  const email = String(me.email).toLowerCase();

  // si aggiorna solo quello che arriva davvero: un salvataggio parziale non cancella il resto
  const sets = [];
  const vals = [];
  const set = (col, val) => {
    sets.push(`${col} = ?`);
    vals.push(val);
  };
  if (body.bio !== undefined) set("bio", text(body.bio ?? "", 0, 300) ?? "");
  if (body.lookingFor !== undefined) set("looking_for", text(body.lookingFor ?? "", 0, 200) ?? "");
  if (body.done !== undefined) set("done", text(body.done ?? "", 0, 200) ?? "");
  if (body.age !== undefined) {
    const age = Number(body.age);
    if (Number.isFinite(age) && age >= 18 && age <= 99) set("age", Math.round(age));
  }
  if (body.sex !== undefined && ["f", "m", "n"].includes(body.sex)) set("sex", body.sex);
  if (Array.isArray(body.interests)) {
    set("interests", JSON.stringify(body.interests.filter((i) => typeof i === "string").slice(0, 200).map((i) => i.slice(0, 40))));
  }
  if (!sets.length) return json({ ok: true });
  vals.push(email);
  await env.DB.prepare(`UPDATE leads SET ${sets.join(", ")} WHERE email = ?`).bind(...vals).run();

  return json({ ok: true });
}

/* ---------- confronto dei volti (Workers AI) ---------- */
function bytesToB64(bytes) {
  let out = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(out);
}

// quante facce si vedono
// nella foto deve esserci il viso di una persona vera: niente anime, disegni, avatar
async function personaVera(env, bytes, mime) {
  const promptFoto =
    "Osserva l'immagine. Rispondi con una sola parola: SCATTO se e una fotografia reale fatta con una fotocamera o un telefono e mostra il viso di una persona umana vera; DISEGNO se invece e un disegno, un anime, un cartone, un avatar, un rendering 3D, un dipinto, un logo, un animale o un oggetto.";
  if (env.GEMINI_KEY) {
    for (const modello of ["gemini-3-flash-preview"]) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${modello}:generateContent?key=${env.GEMINI_KEY}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: promptFoto }, { inlineData: { mimeType: mime || "image/jpeg", data: bytesToB64(bytes) } }] }],
              generationConfig: { temperature: 0, maxOutputTokens: 8 },
            }),
            signal: AbortSignal.timeout(9000),
          }
        );
        if (!res.ok) continue;
        const d = await res.json();
        const t = (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").toUpperCase();
        if (t.includes("DISEGNO")) return false;
        if (t.includes("SCATTO")) return true;
      } catch {}
    }
  }
  // riserva: due modelli di Cloudflare, e boccio solo se sono d'accordo
  const inglese = "Answer with one word only: SCATTO if this is a real photograph taken with a camera of a human being's face, or DISEGNO if it is a drawing, anime, cartoon, 3D render, avatar, painting, logo, animal or object.";
  const verdetti = [];
  for (const modello of ["@cf/llava-hf/llava-1.5-7b-hf", "@cf/meta/llama-3.2-11b-vision-instruct"]) {
    try {
      const out = await env.AI.run(modello, { image: Array.from(bytes), prompt: inglese, max_tokens: 12 });
      const txt = String(out?.description || out?.response || "").toUpperCase();
      verdetti.push(txt.includes("DISEGNO") ? false : txt.includes("SCATTO") ? true : null);
    } catch {
      verdetti.push(null);
    }
  }
  if (verdetti.length === 2 && verdetti[0] === false && verdetti[1] === false) return false;
  if (verdetti.includes(true)) return true;
  return null; // non lo so: meglio non bloccare una persona vera
}

async function faceCount(env, bytes) {
  if (!env.AI) return null;
  try {
    const res = await env.AI.run("@cf/llava-hf/llava-1.5-7b-hf", {
      image: Array.from(bytes),
      prompt: "How many human faces are clearly visible in this photo? Answer with one digit only.",
      max_tokens: 8,
    });
    const txt = String((res && (res.description || res.response || res.text)) || "");
    const found = txt.match(/\d+/);
    return found ? Number(found[0]) : null;
  } catch {
    return null;
  }
}

// l'impronta della foto, per capire se è la stessa persona
async function faceVector(env, bytes, type) {
  if (!env.AI) return null;
  try {
    const res = await env.AI.run("@cf/google/embeddinggemma-2", {
      messages: [[{
        role: "user",
        content: [
          { type: "text", text: "Photo of a person's face." },
          { type: "image_url", image_url: { url: `data:${type || "image/jpeg"};base64,${bytesToB64(bytes)}` } },
        ],
      }]],
    });
    return (res && res.data && res.data[0] && res.data[0].embedding) || null;
  } catch {
    return null;
  }
}

function cosSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

async function readBlob(env, key) {
  if (!key) return null;
  if (env.FILES) {
    const obj = await env.FILES.get(key);
    if (!obj) return null;
    return { bytes: new Uint8Array(await obj.arrayBuffer()), type: obj.httpMetadata?.contentType || "image/jpeg" };
  }
  const row = await env.DB.prepare(`SELECT type, b64 FROM blobs WHERE key = ?`).bind(key).first();
  if (!row) return null;
  return { bytes: Uint8Array.from(atob(row.b64), (c) => c.charCodeAt(0)), type: row.type || "image/jpeg" };
}

// soglie: sopra MATCH è la stessa persona, sotto NO_MATCH è un'altra.
// In mezzo non si boccia nessuno: la richiesta va in revisione.
const FACE_MATCH = 0.88;
const FACE_NO_MATCH = 0.72;

// Le foto stanno su R2 se c'e', altrimenti dentro il database (base64).
async function putBlob(env, key, bytes, contentType, b64) {
  if (env.FILES) {
    await env.FILES.put(key, bytes, { httpMetadata: { contentType } });
    return;
  }
  await env.DB.prepare(
    `INSERT OR REPLACE INTO blobs (key, type, b64, created_at) VALUES (?, ?, ?, ?)`
  )
    .bind(key, contentType, b64, Date.now())
    .run();
}

async function delBlob(env, key) {
  if (!key) return;
  if (env.FILES) {
    await env.FILES.delete(key).catch(() => {});
    return;
  }
  await env.DB.prepare(`DELETE FROM blobs WHERE key = ?`).bind(key).run().catch(() => {});
}

/* ---------- community: post, like, commenti ---------- */

function cleanCaption(v) {
  return String(v || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

async function feed(env, url) {
  const device = String(url.searchParams.get("device") || "").slice(0, 64);
  const who = isEmail(url.searchParams.get("email")) || "";
  const before = Number(url.searchParams.get("before") || 0);
  const limit = 10;
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.name, p.email, p.caption, p.photo, p.created_at, p.event_id, p.event_title,
            COALESCE(l.verified_face, 0) AS v,
            (SELECT COUNT(*) FROM post_likes k WHERE k.post_id = p.id) AS likes,
            (SELECT COUNT(*) FROM post_comments c WHERE c.post_id = p.id) AS comments,
            (SELECT COUNT(*) FROM post_likes k WHERE k.post_id = p.id AND k.device = ?) AS liked
     FROM posts p LEFT JOIN leads l ON l.email = p.email
     WHERE (? = 0 OR p.created_at < ?)
     ORDER BY p.created_at DESC LIMIT ?`
  )
    .bind(device, before, before, limit + 1)
    .all();
  const rows = results || [];
  const padrone = await isOwnerDevice(env, device);
  const more = rows.length > limit;
  const list = (more ? rows.slice(0, limit) : rows).map((r) => ({
    id: r.id,
    name: r.name || "FUORI",
    caption: r.caption || "",
    photo: `/api/photo/${r.photo}`,
    createdAt: r.created_at,
    verified: Boolean(r.v),
    mine: Boolean(who && r.email === who),
    padrone,
    likes: Number(r.likes || 0),
    comments: Number(r.comments || 0),
    liked: Number(r.liked || 0) > 0,
    eventId: r.event_id || "",
    eventTitle: r.event_title || "",
  }));
  return json({ posts: list, next: more ? list[list.length - 1].createdAt : null });
}

async function createPost(env, request) {
  const body = await request.json().catch(() => null);
  if (!body) return bad("body");
  const device = text(body.device, 8, 64);
  if (!device) return bad("device");
  // la mail non si prende dal corpo: chi pubblica è il telefono che ha fatto l'accesso
  const me = await personFor(env, device);
  if (!me) return json({ error: "Prima entra: serve un attimo." }, 403);
  const email = String(me.email).toLowerCase();

  const dataUrl = String(body.data || "");
  const match = /^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return bad("Serve una foto (o un video breve) da pubblicare.");
  const bytes = Uint8Array.from(atob(match[3]), (c) => c.charCodeAt(0));
  if (bytes.length > 400 * 1024) return bad("La foto è troppo grande: scegline una più leggera.");
  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM posts WHERE device = ? AND created_at > ?`
  ).bind(device, Date.now() - 3600 * 1000).first();
  if (Number(recent?.n || 0) >= 12) {
    return json({ error: "Hai pubblicato troppo in fretta. Riprova tra un po'." }, 429);
  }

  // foto di un evento: vale solo se ci sei stato davvero
  let eventId = String(body.eventId || "").slice(0, 40) || null;
  let eventTitle = null;
  if (eventId) {
    const ev = await env.DB.prepare(
      `SELECT e.id, e.title FROM events e JOIN participants p ON p.event_id = e.id
       WHERE e.id = ? AND p.device = ? AND p.status = 'going'`
    ).bind(eventId, device).first();
    if (ev) eventTitle = String(ev.title).slice(0, 90);
    else {
      // l'evento può essere già passato: allora vive nei ricordi e nella storia di chi c'era
      await ensureStoria(env).catch(() => {});
      const ric = await env.DB.prepare(
        `SELECT pe.title FROM past_events pe JOIN participants p ON p.event_id = pe.id
          WHERE pe.id = ? AND p.device = ? AND p.status = 'going'`
      )
        .bind(eventId, device)
        .first()
        .catch(() => null);
      let titolo = String(ric?.title || "").slice(0, 90);
      if (!titolo) {
        const st = await env.DB.prepare(
          `SELECT MAX(title) AS title FROM storia WHERE event_id = ? AND device = ? AND role <> 'pending'`
        )
          .bind(eventId, device)
          .first()
          .catch(() => null);
        titolo = String(st?.title || "").slice(0, 90);
      }
      if (titolo) eventTitle = titolo;
      else eventId = null;
    }
  }

  const key = `p-${crypto.randomUUID()}.${match[2]}`;
  await putBlob(env, key, bytes, match[1], match[3]);
  const id = crypto.randomUUID();
  const name = [me.first_name, me.last_name].filter(Boolean).join(" ") || "FUORI";
  await env.DB.prepare(
    `INSERT INTO posts (id, email, name, caption, photo, device, created_at, event_id, event_title)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, email, name, cleanCaption(body.caption), key, device, Date.now(), eventId, eventTitle).run();
  return json({ ok: true, id });
}

// il padrone dell'app può togliere o correggere qualsiasi post
async function possoModerare(env, device, email) {
  if (await isOwnerDevice(env, device)) return true;
  const who = await viewerEmail(env, device);
  return Boolean(who && email && String(email).toLowerCase() === String(who).toLowerCase());
}

async function deletePost(env, url) {
  const id = String(url.searchParams.get("id") || "");
  const email = isEmail(url.searchParams.get("email"));
  const device = String(url.searchParams.get("device") || "").slice(0, 64);
  if (!id || !email) return bad("id");
  const row = await env.DB.prepare(`SELECT photo, email, device FROM posts WHERE id = ?`).bind(id).first();
  if (!row) return json({ error: "Questo post non c'è più." }, 404);
  // solo chi l'ha scritto e il padrone: l'email scritta nella richiesta non basta più
  if (!(await creatorePost(env, row, device, email))) return json({ error: "Questo post non è tuo." }, 403);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM posts WHERE id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM post_likes WHERE post_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM post_comments WHERE post_id = ?`).bind(id),
  ]);
  await delBlob(env, row.photo);
  return json({ ok: true });
}

// correggo il testo di un post: il mio, oppure uno qualsiasi se sono il padrone
async function editPost(env, request) {
  const body = await request.json().catch(() => null);
  if (!body) return bad("body");
  const id = String(body.id || "").slice(0, 64);
  const device = String(body.device || "").slice(0, 64);
  const email = isEmail(body.email) || "";
  if (!id) return bad("id");
  const row = await env.DB.prepare(`SELECT email, device FROM posts WHERE id = ?`).bind(id).first();
  if (!row) return json({ error: "Questo post non c'è più." }, 404);
  // correggerlo può solo chi l'ha scritto e il padrone
  if (!(await creatorePost(env, row, device, email))) return json({ error: "Questo post non è tuo." }, 403);
  const caption = text(body.caption ?? "", 0, 400) ?? "";
  await env.DB.prepare(`UPDATE posts SET caption = ? WHERE id = ?`).bind(caption, id).run();
  return json({ ok: true, caption });
}

async function toggleLike(env, request) {
  const body = await request.json().catch(() => null);
  const id = String(body?.id || "");
  const device = String(body?.device || "").slice(0, 64);
  if (!id || !device) return bad("id");
  const post = await env.DB.prepare(`SELECT id FROM posts WHERE id = ?`).bind(id).first();
  if (!post) return json({ error: "Questo post non c'è più." }, 404);
  const already = await env.DB.prepare(
    `SELECT 1 FROM post_likes WHERE post_id = ? AND device = ?`
  ).bind(id, device).first();
  if (already) {
    await env.DB.prepare(`DELETE FROM post_likes WHERE post_id = ? AND device = ?`).bind(id, device).run();
  } else {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO post_likes (post_id, device, email, created_at) VALUES (?, ?, ?, ?)`
    ).bind(id, device, isEmail(body?.email) || "", Date.now()).run();
  }
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM post_likes WHERE post_id = ?`).bind(id).first();
  return json({ ok: true, liked: !already, likes: Number(row?.n || 0) });
}

async function listComments(env, url) {
  const id = String(url.searchParams.get("id") || "");
  if (!id) return bad("id");
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.name, c.email, c.text, c.created_at, COALESCE(l.verified_face, 0) AS v
     FROM post_comments c LEFT JOIN leads l ON l.email = c.email
     WHERE c.post_id = ? ORDER BY c.created_at ASC LIMIT 200`
  ).bind(id).all();
  return json({
    comments: (results || []).map((c) => ({
      id: c.id,
      name: c.name || "FUORI",
      text: c.text,
      createdAt: c.created_at,
      verified: Boolean(c.v),
    })),
  });
}

async function addComment(env, request) {
  const body = await request.json().catch(() => null);
  const id = String(body?.id || "");
  const txt = cleanCaption(body?.text);
  const device = text(body?.device, 8, 64);
  if (!id || !device || !txt) return bad("Scrivi qualcosa da commentare.");
  const post = await env.DB.prepare(`SELECT id FROM posts WHERE id = ?`).bind(id).first();
  if (!post) return json({ error: "Questo post non c'è più." }, 404);
  const me = await personFor(env, device);
  if (!me) return json({ error: "Prima entra: serve un attimo." }, 403);
  const email = String(me.email).toLowerCase();
  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM post_comments WHERE email = ? AND created_at > ?`
  ).bind(email, Date.now() - 3600 * 1000).first();
  if (Number(recent?.n || 0) >= 60) {
    return json({ error: "Troppi commenti in poco tempo. Riprova più tardi." }, 429);
  }
  const name = [me.first_name, me.last_name].filter(Boolean).join(" ") || "FUORI";
  await env.DB.prepare(
    `INSERT INTO post_comments (id, post_id, email, name, text, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(crypto.randomUUID(), id, email, name, txt.slice(0, 300), Date.now()).run();
  return json({ ok: true });
}

async function uploadPhoto(env, request, origin, ctx) {
  const body = await request.json().catch(() => null);
  if (!body) return bad("body");
  const device = text(body.device, 8, 64);
  if (!device) return bad("device");
  const me = await personFor(env, device);
  if (!me) return json({ error: "Prima entra: ci vuole un attimo." }, 403);
  const email = String(me.email).toLowerCase();

  const dataUrl = String(body.data || "");
  const match = /^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return bad("Immagine non valida.");

  const bytes = Uint8Array.from(atob(match[3]), (c) => c.charCodeAt(0));
  if (bytes.length > 400 * 1024) return bad("La foto è troppo grande (max 400 KB).");

  const umana = await personaVera(env, bytes, match[1]);
  if (umana === false) {
    await env.DB.prepare(`UPDATE leads SET photo_bad = 1 WHERE email = ?`).bind(email).run().catch(() => {});
    return json(
      {
        error:
          "In questa foto non c'è il viso di una persona vera. Disegni, anime, avatar e illustrazioni non vanno bene: serve una foto scattata a te, con la faccia scoperta e senza filtri.",
      },
      400
    );
  }

  // faccia e impronta si calcolano insieme: si risparmia metà del tempo
  const [faces, vector] = await Promise.all([faceCount(env, bytes), faceVector(env, bytes, match[1])]);
  if (faces !== null && faces > 1) {
    return json({ error: "In questa foto ci sono più persone. Per il profilo serve una foto con solo il tuo viso." }, 400);
  }

  // la stessa foto non può stare su due profili: basta scaricarla e usarla due volte.
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const impronta = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const giaUsata = await env.DB.prepare(
    `SELECT email FROM leads WHERE photo_hash = ? AND lower(email) <> ? LIMIT 1`
  )
    .bind(impronta, email)
    .first()
    .catch(() => null);
  if (giaUsata) {
    return json(
      {
        error:
          "Questa foto è già usata da un altro profilo. Serve una tua foto vera: se è la stessa persona, entra con quel profilo.",
      },
      409
    );
  }

  const key = `${crypto.randomUUID()}.${match[2]}`;
  await putBlob(env, key, bytes, match[1], match[3]);

  const before = await env.DB.prepare(`SELECT photo, face_selfie FROM leads WHERE email = ?`).bind(email).first();
  if (before?.photo) await delBlob(env, before.photo);
  // il selfie vecchio non serve più: la verità è sempre l'ultima foto caricata
  if (before?.face_selfie) await delBlob(env, before.face_selfie);

  // foto nuova = verifica da rifare, contro questa foto qui
  await env.DB.prepare(
    `UPDATE leads SET photo = ?, photo_face = ?, photo_hash = ?, verified_face = 0, face_pending = 0, face_selfie = NULL, photo_bad = 0 WHERE email = ?`
  )
    .bind(key, vector ? JSON.stringify(vector) : null, impronta, email)
    .run();

  await logActivity(env, "photo", email, "Ha cambiato la foto profilo", null);

  // la foto da sola non basta: lo diciamo subito, anche a telefono chiuso
  const dev = me.device || device;
  if (dev && ctx?.waitUntil) {
    ctx.waitUntil(
      notifyDevices(
        env,
        [dev],
        null,
        {
          title: "Foto caricata 👌",
          body: "Ora verifica il viso: senza non puoi creare eventi né partecipare. Due minuti, dal profilo.",
          url: "/?verify=1",
        },
        origin
      ).catch(() => 0)
    );
  }
  return json({ ok: true, photo: `/api/photo/${key}`, needsVerify: true });
}

// le foto dell'evento: niente verifica del viso, serve solo che chi carica
// sia una persona registrata e verificata
async function uploadEventPhoto(env, request) {
  const body = await request.json().catch(() => null);
  if (!body) return bad("body");
  const device = text(body.device, 8, 64) || "";
  if (!device) return bad("Serve il telefono.");
  const chi = await personFor(env, device).catch(() => null);
  if (!chi || !chi.photo) return bad("Prima metti la tua foto nel profilo.");
  if (!chi.verified_face) return bad("Prima verifica il viso: poi puoi caricare le foto degli eventi.");

  const dataUrl = String(body.data || "");
  const match = /^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return bad("Immagine non valida.");
  const bytes = Uint8Array.from(atob(match[3]), (c) => c.charCodeAt(0));
  if (bytes.length > 400 * 1024) return bad("La foto è troppo grande (max 400 KB).");

  const key = `${crypto.randomUUID()}.${match[2]}`;
  await putBlob(env, key, bytes, match[1], match[3]);
  return json({ ok: true, key, url: `/api/photo/${key}` });
}

async function verifyFace(env, request, origin, ctx) {
  const body = await request.json().catch(() => null);
  if (!body) return bad("body");
  const device = text(body.device, 8, 64);
  if (!device) return bad("device");
  const me = await personFor(env, device);
  if (!me) return json({ error: "Prima entra: ci vuole un attimo." }, 403);
  const email = String(me.email).toLowerCase();

  const dataUrl = String(body.data || "");
  const match = /^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return bad("Immagine non valida.");
  const bytes = Uint8Array.from(atob(match[3]), (c) => c.charCodeAt(0));
  if (bytes.length > 500 * 1024) return bad("Il selfie è troppo grande.");

  const umanaSelfie = await personaVera(env, bytes, match[1]);
  if (umanaSelfie === false) {
    return json(
      {
        error:
          "Nel selfie non c'è il viso di una persona vera. Serve una foto dal vivo di te: niente disegni, anime o immagini prese da internet.",
      },
      400
    );
  }

  if (!me.photo) {
    return json({ error: "Prima metti la foto profilo, poi il selfie: li confronto tra loro." }, 400);
  }

  // il confronto è sempre con la foto profilo che c'è adesso
  const foto = await readBlob(env, me.photo);
  let vOld = null;
  if (me.photo_face) {
    try {
      vOld = JSON.parse(me.photo_face);
    } catch {
      vOld = null;
    }
  }
  const [faces, vNew, computedOld] = await Promise.all([
    faceCount(env, bytes),
    faceVector(env, bytes, match[1]),
    vOld ? Promise.resolve(null) : foto ? faceVector(env, foto.bytes, foto.type) : Promise.resolve(null),
  ]);
  if (!vOld && computedOld) {
    vOld = computedOld;
    await env.DB.prepare(`UPDATE leads SET photo_face = ? WHERE email = ?`).bind(JSON.stringify(vOld), email).run();
  }

  if (faces !== null && faces > 1) {
    return json({ error: "Nel selfie ci sono più persone. Fallo da solo, con la tua faccia in primo piano." }, 400);
  }

  const score = vNew && vOld ? cosSim(vNew, vOld) : null;

  if (score !== null && score < FACE_NO_MATCH) {
    // il confronto automatico non è sicuro: invece di lasciarlo a terra lo metto in revisione,
    // così una persona lo guarda e decide (foto profilo + selfie)
    try {
      const chiave = `selfie-${crypto.randomUUID()}.${match[2]}`;
      await putBlob(env, chiave, bytes, match[1], match[3]);
      if (me.face_selfie && me.face_selfie !== chiave) await delBlob(env, me.face_selfie);
      await env.DB.prepare(
        `UPDATE leads SET face_selfie = ?, face_pending = 1, verified_face = 0, face_no = 0, face_score = ?, face_at = ? WHERE email = ?`
      ).bind(chiave, score, Date.now(), email).run();
    } catch {}
    await logActivity(env, "verify_fail", email, `Selfie non corrispondente alla foto (${Math.round(score * 100) / 100})`, null);
    notifyOwner(
      env,
      { title: "Verifica non riuscita", body: `${email}: il selfie non corrisponde alla foto profilo.`, url: "/" },
      origin,
      ctx
    );
    return json(
      {
        error: "Questo selfie non sembra la stessa persona della foto profilo. Mettiti in faccia, con luce davanti e senza filtri, e riprova: se la foto profilo è vecchia o poco chiara, cambiala prima e poi rifai il selfie.",
        score: Math.round(score * 100) / 100,
        retry: true,
      },
      400
    );
  }

  const key = `selfie-${crypto.randomUUID()}.${match[2]}`;
  await putBlob(env, key, bytes, match[1], match[3]);
  if (me.face_selfie) await delBlob(env, me.face_selfie);

  const certo = score !== null && score >= FACE_MATCH;
  const ok = score !== null;
  await env.DB.prepare(
    `UPDATE leads SET face_selfie = ?, face_pending = ?, verified_face = ?, face_no = 0, face_score = ?, face_at = ? WHERE email = ?`
  )
    .bind(key, certo ? 0 : 1, ok ? 1 : 0, score, Date.now(), email)
    .run();

  await logActivity(env, certo ? "verify_ok" : "verify_pending", email, certo ? "Verifica riuscita" : `Da guardare (confronto ${Math.round(score * 100) / 100})`, null);
  if (!certo) {
    notifyOwner(
      env,
      { title: "C'è una verifica da guardare", body: `${email} ha fatto il selfie: decidi tu se va bene.`, url: "/" },
      origin,
      ctx
    );
  }
  if (!ok) return json({ ok: true, pending: true, verified: false });
  return json({ ok: true, verified: true, pending: !certo, score: Math.round(score * 100) / 100 });
}

async function ownerFace(env, url, request) {
  if (request.method === "GET") {
    const rows = await env.DB.prepare(
      `SELECT email, phone, city, age, first_name, last_name, photo, face_selfie, verified_face, face_pending, face_no, face_score, face_at, created_at
       FROM leads WHERE face_pending = 1 OR face_no = 1 OR verified_face = 1
       ORDER BY face_pending DESC, face_no DESC, COALESCE(face_at, created_at) DESC LIMIT 60`
    ).all();
    const people = (rows.results || []).map((r) => ({
      email: r.email,
      name: [r.first_name, r.last_name].filter(Boolean).join(" ") || r.email,
      photo: r.photo ? `/api/photo/${r.photo}` : "",
      selfie: r.face_selfie ? `/api/photo/${r.face_selfie}?token=${encodeURIComponent(url.searchParams.get("token") || "")}` : "",
      phone: r.phone || "",
      city: r.city || "",
      age: r.age || null,
      verified: !!r.verified_face,
      // chi è già verificato non torna in coda: non c'è niente da guardare
      pending: !!r.face_pending && !r.verified_face,
      // "rifiutata": ci ho già guardato e non andava; resta qui se cambio idea
      rifiutata: !!r.face_no && !r.verified_face && !r.face_pending,
      score: r.face_score === null || r.face_score === undefined ? null : Math.round(r.face_score * 100) / 100,
      at: r.face_at || r.created_at || null,
    }));
    return json({
      people,
      conteggi: {
        attesa: people.filter((p) => p.pending).length,
        rifiutate: people.filter((p) => p.rifiutata).length,
        verificate: people.filter((p) => p.verified).length,
      },
    });
  }
  const body = await request.json().catch(() => null);
  const email = isEmail(body?.email);
  if (!email) return bad("email");
  const ok = Boolean(body.ok);
  await env.DB.prepare(`UPDATE leads SET verified_face = ?, face_pending = 0, face_no = ?, face_at = ? WHERE email = ?`)
    .bind(ok ? 1 : 0, ok ? 0 : 1, Date.now(), email)
    .run();
  await logActivity(env, ok ? "verify_ok" : "verify_fail", email, ok ? "Verificato a mano" : "Non approvato a mano", null);
  return json({ ok: true });
}

async function servePhoto(env, key, url) {
  // i selfie della verifica non sono foto pubbliche: li vede solo chi amministra.
  if (String(key).startsWith("selfie-")) {
    const ok = url ? await isOwner(env, url).catch(() => false) : false;
    if (!ok) return new Response("not found", { status: 404 });
  }
  const privata = String(key).startsWith("selfie-");
  const head = (type) => ({
    "content-type": type || "image/jpeg",
    // i selfie non restano in nessuna cache: né del telefono, né di un proxy
    "cache-control": privata ? "private, no-store" : "public, max-age=86400",
  });
  if (env.FILES) {
    const object = await env.FILES.get(key);
    if (object) return new Response(object.body, { headers: head(object.httpMetadata?.contentType) });
  }
  const row = await env.DB.prepare(`SELECT type, b64 FROM blobs WHERE key = ?`).bind(key).first();
  if (!row) return new Response("not found", { status: 404 });
  const bytes = Uint8Array.from(atob(row.b64), (c) => c.charCodeAt(0));
  return new Response(bytes, { headers: head(row.type) });
}

async function register(env, request, origin, ctx) {
  const body = await request.json().catch(() => null);
  if (!body) return bad("body");

  const firstName = text(body.firstName, 2, 40);
  const lastName = text(body.lastName, 0, 40) ?? "";
  const email = isEmail(body.email);
  const tel = phone(body.phone);
  const city = text(body.city ?? CITY, 2, 40) || CITY;
  const device = text(body.device ?? "", 0, 64) || "";
  const interests = Array.isArray(body.interests)
    ? body.interests.filter((i) => typeof i === "string").slice(0, 200).map((i) => i.slice(0, 40))
    : [];
  const categories = Array.isArray(body.categories)
    ? body.categories.filter((c) => CATEGORIES.includes(c)).slice(0, 12)
    : [];

  const age = Number(body.age);
  const sex = ["f", "m", "n"].includes(body.sex) ? body.sex : "n";
  const locale = ["it", "en", "es", "pt"].includes(body.locale) ? body.locale : "it";
  const strList = (v) =>
    Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 12).map((x) => x.slice(0, 40)) : [];
  const goals = strList(body.goals);
  const meet = strList(body.meet);
  const outings = strList(body.outings);

  if (!firstName) return bad("Scrivi il tuo nome.");
  if (!email) return bad("La mail non sembra giusta.");
  if (!tel) return bad("Serve un numero di telefono valido.");
  if (!(age >= 18 && age <= 99)) return bad("Serve un'età tra 18 e 99 anni.");

  const password = String(body.password || "");
  if (password.length < 8) return bad("La password deve avere almeno 8 caratteri.");

  const existing = await env.DB.prepare(`SELECT email, password_hash FROM leads WHERE email = ?`)
    .bind(email)
    .first();
  if (existing?.password_hash) {
    return json({ error: "Questa mail è già registrata. Entra con la password.", emailTaken: true }, 409);
  }
  const pwd = await hashPassword(password);

  await env.DB.prepare(
    `INSERT INTO leads (email, city, device, source, created_at, first_name, last_name, phone, interests,
                        age, sex, locale, goals, meet, outings, consent, last_seen, password_hash, password_salt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       first_name = excluded.first_name,
       last_name = excluded.last_name,
       phone = excluded.phone,
       interests = excluded.interests,
       city = excluded.city,
       device = excluded.device,
       age = excluded.age,
       sex = excluded.sex,
       locale = excluded.locale,
       goals = excluded.goals,
       meet = excluded.meet,
       outings = excluded.outings,
       consent = excluded.consent,
       last_seen = excluded.last_seen,
       password_hash = excluded.password_hash,
       password_salt = excluded.password_salt`
  )
    .bind(
      email, city, device, "registrazione", Date.now(), firstName, lastName, tel, JSON.stringify(interests),
      age, sex, locale, JSON.stringify(goals), JSON.stringify(meet), JSON.stringify(outings),
      body.consent === false ? 0 : 1, Date.now(), pwd.hash, pwd.salt
    )
    .run();

  if (Array.isArray(body.categories)) {
    await env.DB.prepare(`UPDATE push_subs SET categories = ? WHERE email = ?`)
      .bind(JSON.stringify(categories.length ? categories : ["ALL"]), email)
      .run();
  }

  const row = await env.DB.prepare(`SELECT * FROM leads WHERE email = ?`).bind(email).first();
  if (!existing?.password_hash) {
    await bump(env, "signups");
    const nome = [firstName, lastName].filter(Boolean).join(" ") || email;
    await logActivity(env, "signup", nome, email, null);
    notifyOwner(env, { title: "Nuova iscrizione", body: `${nome} si è appena iscritto.`, url: "/" }, origin, ctx);
  }
  return json({ ok: true, categories, person: row ? personOf(row) : null });
}

/** La persona registrata (e verificata) dietro questo telefono. */
// gli interessi stanno salvati come lista JSON
function parseList(v) {
  try {
    const arr = JSON.parse(v || "[]");
    if (Array.isArray(arr)) return arr.map((x) => String(x)).filter(Boolean).slice(0, 8);
  } catch {}
  return String(v || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 8);
}

// l'evento è di chi l'ha creato: si riconosce dal telefono o, se ha reinstallato, dalla sua email
// l'email serve solo per capire se un evento è tuo: la tengo da parte per
// mezzo minuto, così l'elenco non fa una interrogazione in più ogni volta
const emailCache = new Map();
async function viewerEmail(env, device) {
  if (!device) return "";
  const hit = emailCache.get(device);
  if (hit && Date.now() - hit.at < 30000) return hit.email;
  const p = await personFor(env, device).catch(() => null);
  const email = p?.email ? String(p.email).toLowerCase() : "";
  if (emailCache.size > 800) emailCache.clear();
  emailCache.set(device, { email, at: Date.now() });
  return email;
}
function isMyEvent(row, device, email) {
  if (!row) return false;
  if (device && row.device === device) return true;
  const mine = String(row.owner_email || "").toLowerCase();
  const who = String(email || "").toLowerCase();
  return Boolean(mine && who && mine === who);
}

async function personFor(env, device) {
  if (!device) return null;
  return env.DB.prepare(
    `SELECT * FROM leads WHERE device = ? ORDER BY created_at DESC LIMIT 1`
  )
    .bind(device)
    .first();
}

/* ---------- eventi ---------- */

// le foto dell'evento: chiavi delle immagini, al massimo tre, senza doppioni
function fotoValide(keys) {
  const viste = new Set();
  return (Array.isArray(keys) ? keys : [])
    .map((k) => String(k || ""))
    .filter((k) => /^[a-zA-Z0-9-]{8,64}\.(jpe?g|png|webp)$/i.test(k))
    .filter((k) => (viste.has(k) ? false : (viste.add(k), true)))
    .slice(0, 3);
}
// tengo solo le foto che esistono davvero: una chiave inventata non passa
async function fotoEsistenti(env, keys) {
  const buone = fotoValide(keys);
  if (!buone.length) return [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT key FROM blobs WHERE key IN (${buone.map(() => "?").join(",")})`
    )
      .bind(...buone)
      .all();
    const ci = new Set((results || []).map((r) => r.key));
    return buone.filter((k) => ci.has(k));
  } catch {
    return [];
  }
}
function fotoDi(row) {
  try { return fotoValide(JSON.parse(row.photos || "[]")); } catch { return []; }
}

// la prossima volta che l'evento succede: per quelli settimanali conta il giorno
// della settimana (o i giorni scelti), non la data del primo appuntamento
// ora e giorno a casa nostra: gli eventi sono in Sicilia, quindi il fuso è Roma
// (il server sta in UTC e senza questo un evento delle 21 sembrerebbe delle 19)
const FUSO = "Europe/Rome";
function oraRoma(ms) {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: FUSO, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
  }).formatToParts(new Date(ms));
  const o = {};
  for (const x of p) o[x.type] = x.value;
  const nomi = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { y: +o.year, m: +o.month, d: +o.day, hh: +o.hour % 24, mm: +o.minute, wd: nomi[o.weekday] };
}
// il momento esatto di un'ora italiana (cambia d'estate e d'inverno)
function oraItaliana(y, m, d, hh, mm) {
  let t = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 2; i++) {
    const c = oraRoma(t);
    const scarto = Date.UTC(c.y, c.m - 1, c.d, c.hh, c.mm) - t;
    t = Date.UTC(y, m - 1, d, hh, mm) - scarto;
  }
  return t;
}

function prossimaOccorrenza(row, now = Date.now()) {
  const starts = Number(row.starts_at) || 0;
  if (!starts) return 0;
  let giorni = [];
  try {
    const v = JSON.parse(row.weekdays || "null");
    if (Array.isArray(v)) giorni = v;
  } catch {}
  if (!giorni.length && row.weekly_day !== null && row.weekly_day !== undefined)
    giorni = [Number(row.weekly_day)];
  const primo = oraRoma(starts);
  const dopo = Math.max(now, starts);
  const oggi = oraRoma(now);
  let migliore = 0;
  // guardo i prossimi otto giorni: il primo che combacia è il prossimo appuntamento
  for (let k = 0; k < 8; k++) {
    const giorno = new Date(Date.UTC(oggi.y, oggi.m - 1, oggi.d + k));
    const wd = oraRoma(Date.UTC(giorno.getUTCFullYear(), giorno.getUTCMonth(), giorno.getUTCDate(), 12)).wd;
    for (const g of giorni) {
      const d = Number(g && typeof g === "object" ? g.d : g);
      if (d !== wd) continue;
      const t = g && typeof g === "object" && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(String(g.t || ""))
        ? String(g.t).split(":").map(Number)
        : [primo.hh, primo.mm];
      const cand = oraItaliana(giorno.getUTCFullYear(), giorno.getUTCMonth() + 1, giorno.getUTCDate(), t[0], t[1]);
      if (cand < dopo) continue;
      if (!migliore || cand < migliore) migliore = cand;
    }
    if (migliore) break;
  }
  return migliore;
}

// quando si chiudono le iscrizioni: l'anticipo scelto da chi organizza si applica
// al prossimo appuntamento (settimanali) o alla fine (eventi di più giorni)
function scadenzaIscrizioni(row, now = Date.now()) {
  const starts = Number(row.starts_at) || 0;
  const ends = Number(row.ends_at) || 0;
  const dichiarata = Number(row.signup_until) || 0;
  const anticipo = dichiarata && starts ? Math.max(0, starts - dichiarata) : 0;
  const settimanale = row.weekly_day !== null && row.weekly_day !== undefined;
  if (settimanale) {
    const until = Number(row.repeat_until) || 0;
    const occ = prossimaOccorrenza(row, now);
    // l'ultima volta è già passata: resta chiuso, non si riapre
    if (!occ || (until && occ > until)) return (until || starts) - anticipo;
    return occ - anticipo;
  }
  if (ends && ends > starts) return Math.max(starts, ends - anticipo);
  return dichiarata;
}

function shape(row, joined, mine, pending, hidePlace) {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    description: row.description,
    startsAt: row.starts_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at || 0,
    endsAt: row.ends_at || null,
    days: (() => { try { const v = JSON.parse(row.days || "null"); return Array.isArray(v) ? v : null; } catch { return null; } })(),
    weeklyDay: row.weekly_day ?? null,
    weekdays: (() => { try { const v = JSON.parse(row.weekdays || "null"); return Array.isArray(v) ? v : null; } catch { return null; } })(),
    repeatUntil: row.repeat_until || null,
    place: hidePlace ? "" : row.place,
    placeHidden: Boolean(hidePlace),
    // le foto dell'evento (fino a 3)
    photos: fotoDi(row).map((k) => `/api/photo/${k}`),
    activity: row.activity || "",
    lat: hidePlace ? null : (row.lat ?? null),
    lng: hidePlace ? null : (row.lng ?? null),
    capacity: row.capacity,
    host: row.host,
    city: row.city,
    approval: Boolean(row.approval),
    signupUntil: scadenzaIscrizioni(row) || null,
    ageMin: row.age_min ?? null,
    ageMax: row.age_max ?? null,
    ageLo: row.age_lo ?? null,
    ageHi: row.age_hi ?? null,
    access: row.access === "verified" || row.access === "invite" ? row.access : "photo",
    inviteCode: mine ? row.invite_code || "" : "",
    vibe: String(row.vibe || "").slice(0, 16),
    comfort: String(row.comfort || "").slice(0, 16),
    joined,
    pending: pending || 0,
    mine: Boolean(mine),
  };
}

// via gli eventi finiti da un pezzo: niente roba vecchia che resta per sempre
async function cleanOldEvents(env) {
  const cut = Date.now() - EVENT_KEEP_MS;
  await ensurePast(env).catch(() => {});
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.title, e.activity, e.category, e.place, e.city, e.starts_at, e.photos, e.host,
            COALESCE(e.access, 'open') AS access, COALESCE(e.description, '') AS description,
            (SELECT COUNT(*) FROM participants p WHERE p.event_id = e.id AND p.status = 'going') AS joined
     FROM events e
     WHERE COALESCE(e.ends_at, e.starts_at) < ?
       AND (e.weekly_day IS NULL OR (e.repeat_until IS NOT NULL AND e.repeat_until < ?))
     LIMIT 200`
  )
    .bind(cut, cut)
    .all();
  const passati = results || [];
  const ids = passati.map((x) => x.id).filter(Boolean);
  // anche i privati lasciano un ricordo: chi c'era lo vede tutto, gli altri solo che è successo
  if (passati.length) {
    await env.DB.batch(
      passati.map((r) =>
        env.DB.prepare(
          `INSERT OR REPLACE INTO past_events (id, title, activity, category, place, city, starts_at, people, at, photos, host, description, access)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          r.id,
          String(r.title || "").slice(0, 90),
          String(r.activity || "").slice(0, 40),
          String(r.category || "").slice(0, 24),
          String(r.place || "").slice(0, 90),
          String(r.city || "").slice(0, 40),
          Number(r.starts_at) || 0,
          Number(r.joined) || 0,
          Date.now(),
          JSON.stringify(fotoDi(r)),
          String(r.host || "").slice(0, 60),
          String(r.description || "").slice(0, 500),
          String(r.access || "open").slice(0, 12)
        )
      )
    ).catch(() => {});
    // i ricordi non si accumulano per sempre: due mesi e basta
    await env.DB.prepare(`DELETE FROM past_events WHERE at < ?`).bind(Date.now() - 60 * 864e5).run().catch(() => {});
  }
  // messaggi rimasti orfani (evento cancellato in passato): via anche quelli,
  // così il numero dei messaggi resta vero
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM reactions WHERE msg_id IN (SELECT id FROM messages WHERE event_id NOT IN (SELECT id FROM events))`),
    env.DB.prepare(`DELETE FROM messages WHERE event_id NOT IN (SELECT id FROM events)`),
    env.DB.prepare(`DELETE FROM typing WHERE event_id NOT IN (SELECT id FROM events)`),
  ]).catch(() => {});
  // gli eventi creati prima di questa regola: il padrone si ricava dalla sua scheda
  await env.DB.prepare(
    `UPDATE events SET owner_email = (SELECT email FROM leads WHERE leads.device = events.device LIMIT 1)
     WHERE owner_email IS NULL OR owner_email = ''`
  )
    .run()
    .catch(() => {});
  if (!ids.length) return 0;
  await ensureStoria(env).catch(() => {});
  for (const id of ids) {
    // prima di cancellare: chi l'ha creato e chi c'era restano nella sua scheda
    await env.DB.prepare(
      `INSERT OR IGNORE INTO storia (device, event_id, title, activity, category, place, starts_at, role, people, at, access)
       SELECT e.device, e.id, e.title, COALESCE(e.activity, ''), e.category, e.place, e.starts_at, 'host',
              (SELECT COUNT(*) FROM participants p2 WHERE p2.event_id = e.id AND p2.status = 'going'), ?, COALESCE(e.access, 'open')
       FROM events e WHERE e.id = ?`
    )
      .bind(Date.now(), id)
      .run()
      .catch(() => {});
    await env.DB.prepare(
      `INSERT OR IGNORE INTO storia (device, event_id, title, activity, category, place, starts_at, role, people, at, access)
       SELECT p.device, e.id, e.title, COALESCE(e.activity, ''), e.category, e.place, e.starts_at, 'going',
              (SELECT COUNT(*) FROM participants p2 WHERE p2.event_id = e.id AND p2.status = 'going'), ?, COALESCE(e.access, 'open')
       FROM participants p JOIN events e ON e.id = p.event_id
       WHERE e.id = ? AND p.status = 'going'`
    )
      .bind(Date.now(), id)
      .run()
      .catch(() => {});
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM reactions WHERE msg_id IN (SELECT id FROM messages WHERE event_id = ?)`).bind(id),
      env.DB.prepare(`DELETE FROM messages WHERE event_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM typing WHERE event_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM participants WHERE event_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM chat_read WHERE event_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM mutes WHERE scope = ?`).bind("event:" + id),
      env.DB.prepare(`DELETE FROM events WHERE id = ?`).bind(id),
    ]);
  }
  return ids.length;
}

let lastClean = 0;

/* ---------- gli eventi passati: solo il ricordo, senza indirizzi ---------- */

// Quando un evento finisce lo cancello, ma prima tengo due righe: che cosa era e in che zona.
// Niente indirizzo, niente titolo intero, niente descrizione: serve solo a far venire voglia.
let pastOk = false;
async function ensurePast(env) {
  if (pastOk) return;
  pastOk = true;
  // prima la tabella (con tutte le colonne), poi le colonne per chi ce l'ha già vecchia:
  // al contrario, su un database nuovo le colonne non venivano mai aggiunte
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS past_events (
       id TEXT PRIMARY KEY,
       title TEXT NOT NULL DEFAULT '',
       activity TEXT NOT NULL DEFAULT '',
       category TEXT NOT NULL DEFAULT '',
       place TEXT NOT NULL DEFAULT '',
       city TEXT NOT NULL DEFAULT '',
       starts_at INTEGER NOT NULL,
       people INTEGER NOT NULL DEFAULT 0,
       at INTEGER NOT NULL,
       photos TEXT,
       host TEXT,
       description TEXT,
       access TEXT
     )`
  )
    .run()
    .catch(() => {
      pastOk = false;
    });
  await addColumns(env, "past_events", [["photos", "TEXT"], ["host", "TEXT"], ["description", "TEXT"], ["access", "TEXT"]]).catch(() => {});
  // i ricordi salvati prima che ci fosse la descrizione la riprendono dall'evento, se c'è ancora
  await env.DB.prepare(
    `UPDATE past_events
     SET description = (SELECT COALESCE(e.description, '') FROM events e WHERE e.id = past_events.id)
     WHERE COALESCE(description, '') = ''
       AND EXISTS (SELECT 1 FROM events e WHERE e.id = past_events.id AND COALESCE(e.description, '') <> '')`
  )
    .run()
    .catch(() => {});
}

// la zona, non l'indirizzo: "Corso Marco Polo 39" diventa "Corso Marco Polo"
function zonaDi(place) {
  const p = String(place || "").split(/[,(]/)[0].replace(/\s+\d.*$/, "").trim();
  return p.length > 26 ? p.slice(0, 24) + "…" : p;
}

async function pastEvents(env, url) {
  await ensurePast(env).catch(() => {});
  const limit = Math.min(Math.max(Number(url?.searchParams?.get("limit")) || 6, 1), 20);
  const ora = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT activity, category, place, city, starts_at, people FROM past_events
     WHERE starts_at < ? AND starts_at > ?
     ORDER BY starts_at DESC LIMIT ?`
  )
    .bind(ora - EVENT_KEEP_MS, ora - 21 * 864e5, limit)
    .all()
    .catch(() => ({ results: [] }));
  return json({
    passati: (results || []).map((r) => ({
      cosa: String(r.activity || "").slice(0, 40),
      cat: String(r.category || "").slice(0, 24),
      // se la zona non è in elenco non si butta il ricordo: si mostra il luogo com'è
      zona: zonaDi(r.place) || String(r.place || "").slice(0, 40),
      quando: Number(r.starts_at) || 0,
      persone: Number(r.people) || 0,
    })),
  });
}


/* ---------- i voti: like, dislike e stelle ---------- */
let ratingsOk = false;
async function ensureRatings(env) {
  if (ratingsOk) return;
  ratingsOk = true;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS event_ratings (
       event_id TEXT NOT NULL,
       device TEXT NOT NULL,
       vote INTEGER NOT NULL DEFAULT 0,
       stars INTEGER NOT NULL DEFAULT 0,
       at INTEGER NOT NULL,
       PRIMARY KEY (event_id, device)
     )`
  ).run().catch(() => { ratingsOk = false; });
}

// i numeri di un evento: media delle stelle, quanti like e quanti dislike
async function ratingsDi(env, ids, device) {
  const out = {};
  if (!ids || !ids.length) return out;
  await ensureRatings(env).catch(() => {});
  const segni = ids.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT event_id,
       ROUND(AVG(CASE WHEN stars > 0 THEN stars END), 1) AS media,
       SUM(CASE WHEN stars > 0 THEN 1 ELSE 0 END) AS stelle,
       SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END) AS like,
       SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END) AS dislike
     FROM event_ratings WHERE event_id IN (${segni}) GROUP BY event_id`
  )
    .bind(...ids)
    .all()
    .catch(() => ({ results: [] }));
  for (const r of results || [])
    out[r.event_id] = {
      media: Number(r.media) || 0,
      stelle: Number(r.stelle) || 0,
      like: Number(r.like) || 0,
      dislike: Number(r.dislike) || 0,
      mio: 0,
      mie: 0,
    };
  if (device) {
    const miei = await env.DB.prepare(
      `SELECT event_id, vote, stars FROM event_ratings WHERE device = ? AND event_id IN (${segni})`
    )
      .bind(device, ...ids)
      .all()
      .catch(() => ({ results: [] }));
    for (const r of miei.results || []) {
      out[r.event_id] = out[r.event_id] || { media: 0, stelle: 0, like: 0, dislike: 0, mio: 0, mie: 0 };
      out[r.event_id].mio = Number(r.vote) || 0;
      out[r.event_id].mie = Number(r.stars) || 0;
    }
  }
  return out;
}

// si giudica solo un evento a cui si è stati: la prova resta nei ricordi (storia)
async function rateEvent(env, request) {
  const body = await request.json().catch(() => null);
  const device = String(body?.device || "").slice(0, 64);
  const eventId = String(body?.eventId || "").slice(0, 64);
  if (!device || !eventId) return json({ error: "Mi manca qualcosa." }, 400);
  const v = Number(body?.vote);
  const vote = v === 1 ? 1 : v === -1 ? -1 : 0;
  const stars = Math.min(5, Math.max(0, Math.round(Number(body?.stars) || 0)));
  await ensureStoria(env).catch(() => {});
  const mio = await env.DB.prepare(`SELECT role FROM storia WHERE device = ? AND event_id = ? LIMIT 1`)
    .bind(device, eventId)
    .first()
    .catch(() => null);
  // il permesso viene dal telefono che ha partecipato, non da una mail scritta nel corpo.
  // chi amministra l'app può comunque votare e togliere il voto a qualsiasi evento.
  const padrone = await sonoPadrone(env, device).catch(() => false);
  let permesso = Boolean(mio) || padrone;
  if (!permesso) {
    const part = await env.DB.prepare(
      `SELECT 1 AS ok FROM participants WHERE event_id = ? AND device = ? AND status = 'going' LIMIT 1`
    )
      .bind(eventId, device)
      .first()
      .catch(() => null);
    permesso = Boolean(part);
  }
  if (!permesso)
    return json({ error: "Si giudica solo un evento a cui hai partecipato.", code: "noPart" }, 403);
  await ensureRatings(env).catch(() => {});
  if (!vote && !stars) {
    await env.DB.prepare(`DELETE FROM event_ratings WHERE event_id = ? AND device = ?`).bind(eventId, device).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO event_ratings (event_id, device, vote, stars, at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(event_id, device) DO UPDATE SET vote = excluded.vote, stars = excluded.stars, at = excluded.at`
    )
      .bind(eventId, device, vote, stars, Date.now())
      .run();
  }
  const numeri = await ratingsDi(env, [eventId], device);
  return json({ ok: true, numeri: numeri[eventId] || { media: 0, stelle: 0, like: 0, dislike: 0, mio: 0, mie: 0 } });
}

// tutti gli eventi passati: l'archivio più quelli che restano solo nei ricordi delle persone.
// Niente doppioni: un evento che è in tutti e due i posti conta una volta.
async function pastRated(env, url) {
  await ensurePast(env).catch(() => {});
  await ensureStoria(env).catch(() => {});
  await ensureRatings(env).catch(() => {});
  // se un ricordo è senza descrizione ma l'evento ce l'ha ancora, la recupero subito
  await env.DB.prepare(
    `UPDATE past_events
     SET description = (SELECT COALESCE(e.description, '') FROM events e WHERE e.id = past_events.id)
     WHERE COALESCE(description, '') = ''
       AND EXISTS (SELECT 1 FROM events e WHERE e.id = past_events.id AND COALESCE(e.description, '') <> '')`
  )
    .run()
    .catch(() => {});
  const device = (url.searchParams.get("device") || "").slice(0, 64);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 40, 1), 200);
  const cat = (url.searchParams.get("cat") || "").slice(0, 24);
  const ora = Date.now();
  const padrone = await sonoPadrone(env, device).catch(() => false);
  const params = [ora, ora, device, device, cat, cat, limit];
  const { results } = await env.DB.prepare(
    `WITH passati AS (
       SELECT p.id, p.title, p.activity, p.category, p.place, p.city, p.starts_at, p.people, p.photos, p.host,
              COALESCE(p.description, '') AS description, COALESCE(p.access, 'open') AS access
       FROM past_events p WHERE p.starts_at <= ?
       UNION ALL
       SELECT s.event_id, MAX(s.title), MAX(COALESCE(s.activity, '')), MAX(s.category), MAX(s.place), '',
              MAX(s.starts_at), MAX(s.people), NULL, '',
              MAX(COALESCE((SELECT e2.description FROM events e2 WHERE e2.id = s.event_id), '')),
              COALESCE(MAX(s.access), 'open')
       FROM storia s
       WHERE s.starts_at <= ? AND s.event_id NOT IN (SELECT id FROM past_events)
       GROUP BY s.event_id
     )
     SELECT p.*,
       (SELECT COUNT(*) FROM event_ratings r WHERE r.event_id = p.id AND r.stars > 0) AS stelle_n,
       COALESCE((SELECT ROUND(AVG(r.stars), 1) FROM event_ratings r WHERE r.event_id = p.id AND r.stars > 0), 0) AS media,
       COALESCE(
         (SELECT s.role FROM storia s WHERE s.event_id = p.id AND s.device = ? LIMIT 1),
         (SELECT 'host' FROM events e WHERE e.id = p.id AND e.device = ? LIMIT 1)
       ) AS mio_ruolo
     FROM passati p
     WHERE (? = '' OR p.category = ?)
     ORDER BY p.starts_at DESC
     LIMIT ?`
  )
    .bind(...params)
    .all()
    .catch(() => ({ results: [] }));
  const righe = (results || []).map((r) => {
    const chiavi = (() => { try { return fotoValide(JSON.parse(r.photos || "[]")); } catch { return []; } })();
    // un evento privato lo vede per intero solo chi c'era: chi non c'era vede che è successo, non dove
    const privato = (r.access || "open") === "invite";
    const dentro = Boolean(r.mio_ruolo);
    const creatore = r.mio_ruolo === "host";
    const puoVedere = !privato || dentro;
    return {
      id: String(r.id || ""),
      titolo: String(r.title || "").slice(0, 90),
      att: String(r.activity || "").slice(0, 40),
      host: String(r.host || "").slice(0, 60),
      cat: String(r.category || "").slice(0, 24),
      luogo: puoVedere ? zonaDi(r.place) || String(r.place || "").slice(0, 40) : "",
      // l'indirizzo intero serve a chi amministra o a chi ha creato il ricordo, per poterlo correggere
      posto: puoVedere && (padrone || creatore) ? String(r.place || "").slice(0, 90) : "",
      citta: puoVedere ? String(r.city || "").slice(0, 40) : "",
      quando: Number(r.starts_at) || 0,
      persone: Number(r.people) || 0,
      foto: puoVedere && chiavi[0] ? `/api/photo/${chiavi[0]}` : "",
      fotos: puoVedere ? chiavi.map((k) => `/api/photo/${k}`) : [],
      // la descrizione e i nomi sono la parte intima del ricordo: li vedono solo
      // le persone che c'erano (o chi amministra). Gli altri vedono che è successo.
      descrizione: puoVedere && (dentro || padrone) ? String(r.description || "").slice(0, 400) : "",
      privato,
      media: Number(r.media) || 0,
      stelle: Number(r.stelle_n) || 0,
      // si giudica solo se si era dentro (o se si amministra): gli altri non li hanno visti.
      // così il pulsante non compare a chi poi verrebbe bloccato dal server.
      posso: dentro || padrone,
      // il ricordo lo sistema chi l'ha creato o chi amministra l'app
      modificabile: padrone || (dentro && creatore),
    };
  });
  // chi c'era: i nomi delle persone si vedono solo a chi ha partecipato (o a chi amministra).
  // Chi passa di lì vede che l'evento è esistito e quante persone c'erano, non chi sono.
  const conElenco = righe.filter((x) => x.posso && x.id).map((x) => x.id);
  const elenchi = {};
  if (conElenco.length) {
    const segni = conElenco.map(() => "?").join(",");
    const { results: gente } = await env.DB.prepare(
      `SELECT event_id, name, device FROM participants
       WHERE event_id IN (${segni}) AND status = 'going'
       ORDER BY created_at ASC LIMIT 500`
    )
      .bind(...conElenco)
      .all()
      .catch(() => ({ results: [] }));
    for (const g of gente || []) {
      const nome = String(g.name || "").trim().slice(0, 40);
      if (!nome) continue;
      (elenchi[g.event_id] = elenchi[g.event_id] || []).push({ nome, io: g.device === device });
    }
  }
  const numeri = await ratingsDi(env, righe.map((x) => x.id), device);
  // le foto che la community ha taggato con il ricordo: una query sola per tutti.
  // Se il ricordo è privato le vede solo chi c'era (o chi amministra).
  const community = {};
  const communityN = {};
  const conTag = righe.filter((x) => x.id && (!x.privato || x.posso)).map((x) => x.id);
  if (conTag.length) {
    const segni = conTag.map(() => "?").join(",");
    const { results: pub } = await env.DB.prepare(
      `SELECT p.event_id, p.photo, (SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id) AS likes
         FROM posts p WHERE p.event_id IN (${segni})
        ORDER BY likes DESC, p.created_at DESC`
    )
      .bind(...conTag)
      .all()
      .catch(() => ({ results: [] }));
    for (const r of pub || []) {
      const k = r.event_id;
      communityN[k] = (communityN[k] || 0) + 1;
      const b = (community[k] = community[k] || []);
      if (b.length < 6 && r.photo) b.push(`/api/photo/${r.photo}`);
    }
  }
  return json({
    passati: righe.map((x) => ({
      ...x,
      elenco: elenchi[x.id] || [],
      communityFotos: community[x.id] || [],
      communityN: communityN[x.id] || 0,
      voti: numeri[x.id] || { media: x.media, stelle: x.stelle, like: 0, dislike: 0, mio: 0, mie: 0 },
    })),
    padrone,
  });
}

// chi ha creato il ricordo o il padrone dell'app può cambiare tutto,
// comprese le foto: anche aggiungerle a un evento passato che non ne aveva
async function updatePast(env, id, request) {
  const body = await request.json().catch(() => null);
  if (!body) return bad("body");
  const device = text(body.device, 8, 64);
  if (!device) return bad("device");
  await ensurePast(env).catch(() => {});
  await ensureStoria(env).catch(() => {});
  // un ricordo può vivere solo nella storia delle persone (evento già cancellato).
  // In quel caso lo ricostruisco nell'archivio, così si possono aggiungere anche le foto.
  let row = await env.DB.prepare(`SELECT * FROM past_events WHERE id = ?`).bind(id).first();
  const evento = await env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(id).first().catch(() => null);
  const storiaHost = await env.DB.prepare(
    `SELECT 1 AS x FROM storia WHERE event_id = ? AND device = ? AND role = 'host' LIMIT 1`
  ).bind(id, device).first().catch(() => null);
  if (!row) {
    const h = await env.DB.prepare(
      `SELECT * FROM storia WHERE event_id = ? ORDER BY CASE WHEN role = 'host' THEN 0 ELSE 1 END, at DESC LIMIT 1`
    ).bind(id).first().catch(() => null);
    if (!h) return json({ error: "Ricordo non trovato." }, 404);
    const titolo = String(h.title || evento?.title || "").slice(0, 90);
    const attivita = String(h.activity || evento?.activity || "").slice(0, 40);
    const categoria = String(h.category || evento?.category || "").slice(0, 24);
    const posto = String(h.place || evento?.place || "").slice(0, 90);
    const citta = String(evento?.city || "").slice(0, 40);
    const quando = Number(h.starts_at) || Number(evento?.starts_at) || 0;
    const persone = Number(h.people) || 0;
    const accesso = String(h.access || evento?.access || "open").slice(0, 20);
    await env.DB.prepare(
      `INSERT OR IGNORE INTO past_events (id, title, activity, category, place, city, starts_at, people, at, photos, host, description, access)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)`
    ).bind(
      id, titolo, attivita, categoria, posto, citta, quando, persone, Date.now(),
      String(evento?.host || "").slice(0, 60),
      String(evento?.description || "").slice(0, 500),
      accesso
    ).run().catch(() => {});
    row = await env.DB.prepare(`SELECT * FROM past_events WHERE id = ?`).bind(id).first();
  }
  if (!row) return json({ error: "Ricordo non trovato." }, 404);
  let puo = await sonoPadrone(env, device).catch(() => false);
  if (!puo && storiaHost) puo = true;
  if (!puo && evento && evento.device === device) puo = true;
  if (!puo) return json({ error: "Solo chi ha creato il ricordo o chi amministra può modificarlo." }, 403);
  const title = text(body.title, 3, 90);
  if (!title) return bad("Il titolo deve avere tra 3 e 90 caratteri.");
  const description = testoLungo(body.description ?? "", 0, 500) ?? "";
  const place = text(body.place ?? "", 0, 90) ?? "";
  const city = text(body.city ?? "", 0, 40) ?? "";
  const host = text(body.host ?? "", 0, 60) ?? String(row.host || "");
  const activity = text(body.activity ?? "", 0, 40) ?? "";
  const category = CATEGORIES.includes(body.category) ? body.category : row.category;
  const startsAt = Number(body.startsAt) > 0 ? Number(body.startsAt) : Number(row.starts_at) || 0;
  // se il modulo manda le foto, tengo solo quelle che esistono davvero (max 3);
  // se non le manda, restano quelle già salvate
  const photos = Array.isArray(body.photos) ? await fotoEsistenti(env, body.photos) : fotoDi(row);
  const photosJson = JSON.stringify(photos);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE past_events SET title = ?, description = ?, place = ?, city = ?, host = ?, activity = ?, category = ?, starts_at = ?, photos = ? WHERE id = ?`
    ).bind(title, description, place, city, host, activity, category, startsAt, photosJson, id),
    env.DB.prepare(`UPDATE storia SET title = ?, activity = ?, category = ?, place = ?, starts_at = ? WHERE event_id = ?`).bind(
      title,
      activity,
      category,
      place,
      startsAt,
      id
    ),
  ]);
  // se l'evento originale esiste ancora, allineo anche lì le foto
  await env.DB.prepare(`UPDATE events SET photos = ? WHERE id = ?`).bind(photosJson, id).run().catch(() => {});
  return json({ ok: true });
}

// quante cose ci sono adesso, categoria per categoria e attività per attività.
// Se c'è un punto e un raggio, contano solo quelle dentro: matrice, lista e mappa dicono lo stesso numero.
async function categoryCounts(env, url) {
  const ora = Date.now();
  const lat = Number(url?.searchParams?.get("lat"));
  const lng = Number(url?.searchParams?.get("lng"));
  const r = Number(url?.searchParams?.get("r")) || 0;
  const centro = r > 0 && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  const { results } = await env.DB.prepare(
    `SELECT category, COALESCE(activity, '') AS activity, created_at, lat, lng
     FROM events
     WHERE starts_at >= ? OR COALESCE(ends_at, starts_at) >= ?
        OR (weekly_day IS NOT NULL AND (repeat_until IS NULL OR repeat_until >= ?))`
  )
    .bind(ora, ora, ora)
    .all()
    .catch(() => ({ results: [] }));
  const cats = {};
  let totale = 0;
  for (const row of results || []) {
    if (centro) {
      const d = Number.isFinite(row.lat) && Number.isFinite(row.lng) ? kmBetween(centro, { lat: row.lat, lng: row.lng }) : null;
      if (d === null || d > r) continue;
    }
    const id = String(row.category || "");
    const nuovo = Number(row.created_at) || 0;
    totale += 1;
    const box = (cats[id] = cats[id] || { n: 0, newest: 0, atts: {} });
    box.n += 1;
    if (nuovo > box.newest) box.newest = nuovo;
    const a = String(row.activity || "").trim();
    if (a) {
      const att = (box.atts[a] = box.atts[a] || { n: 0, newest: 0 });
      att.n += 1;
      if (nuovo > att.newest) att.newest = nuovo;
    }
  }
  return json({
    totale,
    cats: Object.entries(cats).map(([id, v]) => ({
      id,
      n: v.n,
      newest: v.newest,
      atts: Object.entries(v.atts)
        .map(([a, x]) => ({ a, n: x.n, newest: x.newest }))
        .sort((x, y) => y.n - x.n || x.a.localeCompare(y.a))
        .slice(0, 40),
    })),
  });
}

let aiEvCache = { at: 0, rows: null };
// l'elenco eventi serve identico a ogni domanda: si tiene mezzo minuto invece di interrogare il database ogni volta
async function eventiAI(env, now) {
  if (aiEvCache.rows && Date.now() - aiEvCache.at < 30000) return aiEvCache.rows;
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.title, e.category, e.description, e.activity, e.city, e.starts_at, e.place, e.capacity, COALESCE(e.access, 'open') AS access,
            (SELECT COUNT(*) FROM participants p WHERE p.event_id = e.id AND p.status = 'going') AS joined
     FROM events e
     WHERE e.starts_at > ? OR COALESCE(e.ends_at, e.starts_at) > ? OR (e.weekly_day IS NOT NULL AND (e.repeat_until IS NULL OR e.repeat_until > ?))
     ORDER BY e.starts_at ASC LIMIT 10`
  )
    .bind(now, now, now)
    .all();
  aiEvCache = { at: Date.now(), rows: results || [] };
  return aiEvCache.rows;
}

// gli eventi appena passati: servono per rispondere a "cosa c'era ieri?"
async function eventiPadutiAI(env, now) {
  const { results } = await env.DB.prepare(
    `SELECT title, activity, category, place, city, starts_at, people FROM past_events
     WHERE starts_at >= ? ORDER BY starts_at DESC LIMIT 6`
  )
    .bind(now - 8 * 864e5)
    .all()
    .catch(() => ({ results: [] }));
  return results || [];
}

// gli eventi creati da questa persona: servono per complimentarsi davvero
async function mieiEventiAI(env, device, now) {
  if (!device) return [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT e.title, e.starts_at, e.capacity, COALESCE(e.access, 'open') AS access,
              (SELECT COUNT(*) FROM participants p WHERE p.event_id = e.id AND p.status = 'going') AS joined
       FROM events e WHERE e.device = ? ORDER BY e.starts_at DESC LIMIT 4`
    ).bind(device).all();
    return results || [];
  } catch {
    return [];
  }
}

// il blocco che finisce nel prompt: eventi in programma, appena passati, meteo e luogo
// qualche evento ha la descrizione scritta tutta attaccata ("alberorotante"):
// letta così non si capisce, quindi in quel caso uso solo categoria e attività
function descrizioneUtile(descrizione) {
  const d = String(descrizione || "").replace(/\s+/g, " ").trim();
  if (!d) return "";
  const parole = d.split(" ").length;
  if (d.length > 30 && parole < Math.ceil(d.length / 40)) return "";
  return d.slice(0, 90);
}

async function bloccoAI(env, now, body, prontiPromise) {
  const fmt = new Intl.DateTimeFormat("it-IT", {
    timeZone: "Europe/Rome", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
  const quando = (ms) => fmt.format(new Date(ms)).replace(",", " ");
  const device = String(body?.device || "").slice(0, 64);
  const [prossimi, passati, miei] = await Promise.all([
    prontiPromise || eventiAI(env, now),
    eventiPadutiAI(env, now),
    mieiEventiAI(env, device, now),
  ]);
  const righe = [];
  righe.push("Eventi in programma (questi sono veri, non inventarne altri):");
  righe.push(
    prossimi.length
      ? prossimi
          .map(
            (e) =>
              `- ${e.title} | ${e.category} | ${[e.activity, descrizioneUtile(e.description)].filter(Boolean).join(": ")} | ${quando(e.starts_at)} | ${
                e.city ? e.city + " · " : ""
              }${e.access === "invite" ? "indirizzo nascosto, si entra su invito" : e.place} | ${e.joined} iscritti su ${e.capacity} posti`
          )
          .join("\n")
      : "(adesso non c'è niente in programma)"
  );
  if (passati.length) {
    righe.push("");
    righe.push("Eventi appena passati (ultimi giorni):");
    righe.push(
      passati
        .map((e) => `- ${e.title || e.activity} | ${e.category} | ${quando(e.starts_at)} | ${e.place} | ${e.people} persone`)
        .join("\n")
    );
  }
  const w = body?.meteo || {};
  const tempo = [];
  if (Number.isFinite(Number(w.t))) tempo.push(`${Math.round(Number(w.t))} gradi`);
  if (w.sky) tempo.push(String(w.sky).slice(0, 24));
  const dove = String(body?.citta || "").slice(0, 40);
  if (tempo.length) righe.push("", `Meteo adesso dove sta la persona: ${tempo.join(", ")}.`);
  else righe.push("", "Meteo: non disponibile. Non parlare del tempo e non dire caldo, freddo, pioggia, vento o nuvoloso.");
  if (dove) righe.push(`La persona sta a ${dove} (Sicilia).`);
  else if (body?.pos) righe.push("La persona ha dato la posizione ma non la città: è in zona Catania.");
  if (miei.length) {
    righe.push("");
    righe.push("Eventi creati da questa persona (numeri veri: usali per farle i complimenti se sono andati bene, non inventarne altri):");
    righe.push(
      miei
        .map((e) => `- ${e.title} | ${quando(e.starts_at)} | ${e.joined} iscritti su ${e.capacity} posti`)
        .join("\n")
    );
  }
  return righe.join("\n");
}

// la ricerca mentre si scrive: gli eventi in programma e quelli che restano nei ricordi.
// Torna poco e diviso in due, quanto basta a riempire i suggerimenti sotto il campo.
async function cerca(env, url) {
  const grezzo = String(url.searchParams.get("q") || "").trim().slice(0, 40);
  const device = (url.searchParams.get("device") || "").slice(0, 64);
  const q0 = grezzo.replace(/[%_]/g, " ").trim();
  if (q0.length < 2) return json({ q: grezzo, events: [], past: [] });
  await ensurePast(env).catch(() => {});
  await ensureStoria(env).catch(() => {});
  const like = `%${q0}%`;
  const adesso = Date.now();
  const [futuri, ricordi] = await Promise.all([
    env.DB.prepare(
      `SELECT e.id, e.title, e.activity, e.category, e.place, e.starts_at, e.weekdays,
              e.weekly_day, e.repeat_until, e.device, COALESCE(e.access, 'open') AS access,
              (SELECT COUNT(*) FROM participants p WHERE p.event_id = e.id AND p.status = 'going') AS joined,
              (SELECT COUNT(*) FROM participants p2 WHERE p2.event_id = e.id AND p2.device = ?) AS mine_in
         FROM events e
        WHERE (e.starts_at >= ? OR COALESCE(e.ends_at, e.starts_at) >= ?
               OR (e.weekly_day IS NOT NULL AND (e.repeat_until IS NULL OR e.repeat_until >= ?)))
          AND (e.title LIKE ? OR COALESCE(e.activity, '') LIKE ? OR COALESCE(e.place, '') LIKE ?)
        ORDER BY e.starts_at ASC
        LIMIT 6`
    )
      .bind(device, adesso, adesso, adesso, like, like, like)
      .all()
      .catch(() => ({ results: [] })),
    env.DB.prepare(
      `WITH passati AS (
         SELECT p.id, p.title, p.activity, p.starts_at
           FROM past_events p WHERE p.starts_at <= ?
         UNION ALL
         SELECT s.event_id, MAX(s.title), MAX(COALESCE(s.activity, '')), MAX(s.starts_at)
           FROM storia s
          WHERE s.starts_at <= ? AND s.event_id NOT IN (SELECT id FROM past_events)
          GROUP BY s.event_id
       )
       SELECT * FROM passati
        WHERE title LIKE ? OR activity LIKE ?
        ORDER BY starts_at DESC
        LIMIT 6`
    )
      .bind(adesso, adesso, like, like)
      .all()
      .catch(() => ({ results: [] })),
  ]);
  return json({
    q: grezzo,
    events: (futuri.results || []).map((r) => {
      const dentro = Number(r.mine_in || 0) > 0;
      // un evento privato non dice dove: chi non c'è dentro lo scopre solo entrando
      const nascosto = (r.access || "open") === "invite" && !dentro && r.device !== device;
      return {
        id: String(r.id || ""),
        title: String(r.title || "").slice(0, 90),
        activity: String(r.activity || "").slice(0, 40),
        category: String(r.category || "").slice(0, 24),
        when: Number(prossimaOccorrenza(r, adesso) || r.starts_at) || 0,
        place: nascosto ? "" : zonaDi(r.place) || String(r.place || "").slice(0, 30),
        joined: Number(r.joined) || 0,
      };
    }),
    past: (ricordi.results || []).map((r) => ({
      id: String(r.id || ""),
      title: String(r.title || "").slice(0, 90),
      activity: String(r.activity || "").slice(0, 40),
      when: Number(r.starts_at) || 0,
    })),
  });
}

// le foto che la community ha pubblicato per un evento, le più care prima:
// sono quelle che prendono il posto delle foto quando l'evento non ne ha
async function fotoCommunity(env, eventId, limite = 12) {
  if (!eventId) return { foto: [], n: 0 };
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.name, p.caption, p.photo, p.created_at,
            (SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id) AS likes,
            (SELECT COUNT(*) FROM posts q WHERE q.event_id = p.event_id) AS tot
       FROM posts p WHERE p.event_id = ?
      ORDER BY likes DESC, p.created_at DESC
      LIMIT ?`
  )
    .bind(eventId, Math.min(Math.max(Number(limite) || 12, 1), 24))
    .all()
    .catch(() => ({ results: [] }));
  const righe = results || [];
  return {
    foto: righe.map((r) => ({
      id: String(r.id || ""),
      name: String(r.name || "").slice(0, 40),
      caption: String(r.caption || "").slice(0, 200),
      photo: `/api/photo/${r.photo}`,
      likes: Number(r.likes) || 0,
    })),
    n: Number(righe[0]?.tot || 0),
  };
}

async function listEvents(env, url) {
  const device = (url.searchParams.get("device") || "").slice(0, 64);
  const city = (url.searchParams.get("city") || CITY).slice(0, 40);
  const cat = (url.searchParams.get("cat") || "").slice(0, 24);
  const q = (url.searchParams.get("q") || "").slice(0, 40).replace(/[%_]/g, " ");
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 40);
  const cursor = Number(url.searchParams.get("cursor")) || 0;
  const listEmail = await viewerEmail(env, device);
  // la lista mostra solo gli eventi di oggi: chi è finito da più di un paio d'ore sparisce
  if (Date.now() - lastClean > 10 * 60 * 1000) {
    lastClean = Date.now();
    await cleanOldEvents(env).catch(() => 0);
  }
  const from = Date.now() - EVENT_KEEP_MS;
  const startAt = cursor ? Math.max(cursor + 1, from) : from;
  // le stelle che servono ai preferiti ("più votati") senza una seconda chiamata
  await ensureRatings(env).catch(() => {});

  // niente filtro per città: gli eventi sono di tutta la Sicilia, e chi è a
  // Siracusa deve vedere gli eventi di Siracusa anche dalla lista di tutti i giorni
  const params = [startAt, startAt, startAt];
  // un evento lungo resta in lista finché non è finito; quello settimanale finché non scade
  let where = "(e.starts_at >= ? OR COALESCE(e.ends_at, e.starts_at) >= ? OR (e.weekly_day IS NOT NULL AND (e.repeat_until IS NULL OR e.repeat_until >= ?)))";
  if (cat) { where += " AND e.category = ?"; params.push(cat); }
  if (q) {
    where += " AND (e.title LIKE ? OR e.place LIKE ? OR e.description LIKE ? OR e.activity LIKE ?)";
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  params.push(limit + 1);

  const { results } = await env.DB.prepare(
    `SELECT e.*,
       (SELECT COUNT(*) FROM participants p WHERE p.event_id = e.id AND p.status = 'going') AS joined,
       (SELECT COUNT(*) FROM participants p WHERE p.event_id = e.id AND p.status = 'pending') AS pending,
       (SELECT COUNT(*) FROM participants p2 WHERE p2.event_id = e.id AND p2.device = ?) AS mine_in,
       (SELECT MIN(l.age) FROM participants p3 JOIN leads l ON l.device = p3.device
         WHERE p3.event_id = e.id AND p3.status = 'going' AND l.age >= 18) AS age_lo,
       (SELECT MAX(l.age) FROM participants p4 JOIN leads l ON l.device = p4.device
         WHERE p4.event_id = e.id AND p4.status = 'going' AND l.age >= 18) AS age_hi,
       COALESCE((SELECT ROUND(AVG(r.stars), 1) FROM event_ratings r WHERE r.event_id = e.id AND r.stars > 0), 0) AS media_stelle,
       (SELECT COUNT(*) FROM event_ratings r WHERE r.event_id = e.id AND r.stars > 0) AS stelle_n
     FROM events e
     WHERE ${where}
     ORDER BY e.starts_at ASC, e.id ASC
     LIMIT ?`
  )
    .bind(device, ...params)
    .all();

  const rows = results || [];
  const more = rows.length > limit;
  const page = rows.slice(0, limit);

  const events = page.map((row) => {
    const owner = isMyEvent(row, device, listEmail);
    const inside = Number(row.mine_in || 0) > 0;
    const hide = (row.access || "open") === "invite" && !owner && !inside;
    const ev = shape(row, row.joined, owner, owner ? row.pending : 0, hide);
    ev.media = Number(row.media_stelle) || 0;
    ev.stelle = Number(row.stelle_n) || 0;
    return ev;
  });
  await meteoPerEventi(events).catch(() => events);

  return json({
    city,
    categories: CATEGORIES,
    events,
    next: more ? page[page.length - 1].starts_at : null,
  });
}

const geoCache = new Map();
const wxCache = new Map();
// il meteo di ogni evento, diviso per zona: una chiamata sola per tutti
const eventWx = new Map();
const WX_EMOJI = { 0: "☀️", 1: "🌤️", 2: "🌤️", 3: "☁️", 45: "🌫️", 48: "🌫️", 51: "🌦️", 53: "🌦️", 55: "🌦️", 56: "🌧️", 57: "🌧️", 61: "🌧️", 63: "🌧️", 65: "🌧️", 66: "🌧️", 67: "🌧️", 71: "🌨️", 73: "🌨️", 75: "❄️", 77: "❄️", 80: "🌦️", 81: "🌧️", 82: "⛈️", 85: "🌨️", 86: "🌨️", 95: "⛈️", 96: "⛈️", 99: "⛈️" };

function skyFromCode(code) {
  if (code >= 95) return "temporale";
  if (code >= 80) return "rovesci";
  if (code >= 71) return "neve";
  if (code >= 51) return "pioggia";
  if (code >= 45) return "nebbia";
  if (code >= 3) return "nuvoloso";
  if (code >= 1) return "poco nuvoloso";
  return "sereno";
}

// il meteo di adesso dove si trova l'evento. Le zone vicine usano lo stesso numero:
// una fetch per tutti, e per quindici minuti resta in memoria.
async function meteoPerEventi(events) {
  if (!events || !events.length) return events;
  const now = Date.now();
  const chiave = (e) => {
    const a = Number(e.lat);
    const b = Number(e.lng);
    return Number.isFinite(a) && Number.isFinite(b) ? a.toFixed(1) + "," + b.toFixed(1) : "";
  };
  const punti = [...new Set(events.map(chiave).filter(Boolean))];
  const mancanti = punti.filter((k) => {
    const h = eventWx.get(k);
    return !h || now - h.at > 15 * 60 * 1000;
  });
  if (mancanti.length) {
    const la = mancanti.map((k) => k.split(",")[0]).join(",");
    const lo = mancanti.map((k) => k.split(",")[1]).join(",");
    const u =
      "https://api.open-meteo.com/v1/forecast?latitude=" + la + "&longitude=" + lo +
      "&current=temperature_2m,weather_code,precipitation&timezone=Europe%2FRome";
    const ctrl = new AbortController();
    const stop = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(u, { headers: { accept: "application/json" }, signal: ctrl.signal });
      if (res.ok) {
        const d = await res.json();
        const arr = Array.isArray(d) ? d : [d];
        arr.forEach((w, i) => {
          const k = mancanti[i];
          if (!k || !w) return;
          const cur = w.current || {};
          const code = Number(cur.weather_code ?? 0);
          eventWx.set(k, {
            at: now,
            data: {
              t: Math.round(Number(cur.temperature_2m ?? 0)),
              code,
              sky: skyFromCode(code),
              emoji: WX_EMOJI[code] || "🌡️",
            },
          });
        });
      }
    } catch {}
    clearTimeout(stop);
  }
  for (const e of events) {
    const h = eventWx.get(chiave(e));
    if (h) e.meteo = h.data;
  }
  return events;
}

async function weather(url) {
  // il meteo è quello dove sei tu, non quello di Catania
  const qLat = Number(url.searchParams.get("lat"));
  const qLng = Number(url.searchParams.get("lng"));
  const okPos = Number.isFinite(qLat) && Number.isFinite(qLng) && Math.abs(qLat) <= 90 && Math.abs(qLng) <= 180;
  const la = (okPos ? qLat : 37.5022).toFixed(2);
  const lo = (okPos ? qLng : 15.0873).toFixed(2);
  const key = la + "," + lo;
  const hit = wxCache.get(key);
  if (hit && Date.now() - hit.at < 20 * 60 * 1000) return json(hit.data);
  const meteo =
    "https://api.open-meteo.com/v1/forecast?latitude=" + la + "&longitude=" + lo +
    "&current=temperature_2m,precipitation,weather_code,wind_speed_10m" +
    "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code" +
    "&timezone=Europe%2FRome&forecast_days=1";
  const ctrl = new AbortController();
  const stop = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(meteo, { headers: { accept: "application/json" }, signal: ctrl.signal });
    clearTimeout(stop);
    if (!res.ok) throw new Error("meteo " + res.status);
    const d = await res.json();
    const cur = d.current || {};
    const day = d.daily || {};
    const code = Number(cur.weather_code ?? (day.weather_code || [0])[0] ?? 0);
    const rainProb = Number((day.precipitation_probability_max || [0])[0] || 0);
    const t = Math.round(Number(cur.temperature_2m ?? 0));
    const tmax = Math.round(Number((day.temperature_2m_max || [t])[0] ?? t));
    const tmin = Math.round(Number((day.temperature_2m_min || [t])[0] ?? t));
    const wind = Math.round(Number(cur.wind_speed_10m || 0));
    let mood = "mite";
    if (rainProb >= 50 || code >= 51) mood = "pioggia";
    else if (tmax <= 12) mood = "freddo";
    else if (tmax >= 27 && rainProb < 30) mood = "caldo";
    else if (rainProb < 25) mood = "sole";
    const data = { t, tmax, tmin, rainProb, wind, code, sky: skyFromCode(code), mood, at: Date.now() };
    wxCache.set(key, { at: Date.now(), data });
    return json({ ...data, lat: Number(la), lng: Number(lo) });
  } catch (e) {
    clearTimeout(stop);
    if (hit?.data) return json({ ...hit.data, stale: true });
    return json({ error: "meteo non disponibile", mood: "mite", t: null }, 200);
  }
}
let lastGeoCall = 0;

function splitCivic(q) {
  // "corso marco polo 39d" → via "corso marco polo", civico "39d"
  // e anche "via del caravaggio 24 trecastagni": il civico sta in mezzo
  const s = String(q).trim();
  const m = s.match(/^(.+?)[,\s]+(\d{1,4})\s*([a-zA-Z])?(?:[,\s]+(.+))?$/);
  if (!m) return { street: s, civic: "", town: "" };
  const street = m[1].trim();
  const core = stripRoadType(street);
  // "piazza 4 novembre" non è un civico: lì il numero fa parte del nome
  if (!street || core.length < 4 || (core === street && !street.includes(" ")))
    return { street: s, civic: "", town: "" };
  return { street, civic: m[2] + (m[3] ? m[3].toLowerCase() : ""), town: (m[4] || "").trim() };
}

// "corso marco polo" → "marco polo": serve per ritrovare la strada anche se il tipo è diverso
function stripRoadType(s) {
  return String(s || "")
    .replace(/^(corso|corsetto|via|viale|viale?|piazza|piazzale|vico|vicoletto|largo|salita|strada|contrada|traversa|lungomare)\s+/i, "")
    .trim();
}

function tidyPlace(v) {
  return String(v || "").replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ").trim();
}

function quickKm(a, b) {
  if (!a || !b || !Number.isFinite(b.lat) || !Number.isFinite(b.lng)) return 999;
  const dLat = (b.lat - a.lat) * 111;
  const dLng = (b.lng - a.lng) * 111 * Math.cos((a.lat * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

// OpenStreetMap per esteso: è quello che conosce più civici
async function nominatimQuery(q, limit) {
  const params = new URLSearchParams({
    format: "jsonv2",
    q,
    limit: String(limit || 6),
    "accept-language": "it",
    addressdetails: "1",
    countrycodes: "it",
  });
  const ctrl = new AbortController();
  const stop = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch("https://nominatim.openstreetmap.org/search?" + params.toString(), {
      headers: { "user-agent": "FUORI/1.0 (eventi a Catania)", accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const rows = await res.json().catch(() => []);
    return (Array.isArray(rows) ? rows : [])
      .map((r) => {
        const a = r.address || {};
        const street = tidyPlace(a.road || a.pedestrian || a.footway || a.square || a.path || "");
        const civic = tidyPlace(a.house_number || "");
        const city = tidyPlace(a.city || a.town || a.village || a.municipality || a.county || "");
        const name = street
          ? civic
            ? `${street}, ${civic}`
            : street
          : tidyPlace(String(r.display_name || "").split(",").slice(0, 2).join(", "));
        return {
          name,
          full: tidyPlace(r.display_name || ""),
          city,
          lat: Number(r.lat),
          lng: Number(r.lon),
          country: "IT",
          exact: Boolean(street && civic),
        };
      })
      .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
  } catch {
    return [];
  } finally {
    clearTimeout(stop);
  }
}

async function photonQuery(q, near) {
  const ctrl = new AbortController();
  const stop = setTimeout(() => ctrl.abort(), 6000);
  try {
    const purl = new URL("https://photon.komoot.io/api/");
    purl.searchParams.set("q", q);
    purl.searchParams.set("limit", "8");
    purl.searchParams.set("lat", String(near[0]));
    purl.searchParams.set("lon", String(near[1]));
    const res = await fetch(purl.toString(), {
      headers: { "user-agent": "FUORI/1.0 (eventi a Catania)", accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    return (data.features || [])
      .map((f) => {
        const pr = f.properties || {};
        const street = tidyPlace(pr.street || pr.name || "");
        const civic = tidyPlace(pr.housenumber || "");
        const name = street ? (civic ? `${street}, ${civic}` : street) : tidyPlace(pr.name || "");
        const bits = [pr.name, [pr.street, pr.housenumber].filter(Boolean).join(" "), pr.district, pr.city]
          .filter(Boolean)
          .map(tidyPlace);
        const coords = f.geometry?.coordinates || [];
        return {
          name: name || tidyPlace(bits.slice(0, 2).join(", ")),
          full: [...new Set(bits)].join(", "),
          city: tidyPlace(pr.city || pr.county || ""),
          lat: Number(coords[1]),
          lng: Number(coords[0]),
          country: pr.countrycode || "",
          exact: Boolean(pr.housenumber),
        };
      })
      .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
  } catch {
    return [];
  } finally {
    clearTimeout(stop);
  }
}

function mergePlaces(lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const r of list || []) {
      const k = `${r.lat.toFixed(4)},${r.lng.toFixed(4)}`;
      if (seen.has(k)) {
        // stessa via da due servizi: teniamo quello che ha il civico
        const old = out.find((x) => `${x.lat.toFixed(4)},${x.lng.toFixed(4)}` === k);
        if (old && !old.exact && r.exact) Object.assign(old, r);
        continue;
      }
      seen.add(k);
      out.push({ ...r });
    }
  }
  return out;
}

async function geocode(env, url) {
  const q = (url.searchParams.get("q") || "").trim().slice(0, 80);
  if (q.length < 3) return json({ results: [] });
  const key = q.toLowerCase();
  // ogni suggerimento dice in che paese sta: il telefono lo usa per la città dell'evento
  const conPaese = (list, scritta) =>
    (list || []).map((r) => ({
      ...r,
      city:
        String(r.city || "").trim() ||
        cittaScritta(String(r.full || "")) ||
        (Number.isFinite(r.lat) && inSicily(r.lat, r.lng) ? scritta : ""),
    }));
  const hit = geoCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) {
    return json({ results: conPaese(hit.results, cittaScritta(q) || "") });
  }

  const nearRaw = String(url.searchParams.get("near") || "").split(",").map(Number);
  const daTelefono = nearRaw.length === 2 && nearRaw.every(Number.isFinite) ? nearRaw : null;

  const { street, civic, town } = splitCivic(q);
  // si cerca intorno alla città scritta: "via etnea 5, siracusa" resta a Siracusa
  const scritta = cittaScritta(q) || town || "";
  const centro =
    (daTelefono ? { lat: daTelefono[0], lng: daTelefono[1] } : null) ||
    (scritta ? await townCoords(scritta).catch(() => null) : null) ||
    { lat: 37.5022, lng: 15.0873 };
  const near = [centro.lat, centro.lng];
  const here = centro;
  // prima qui si aggiungeva ", Catania" a ogni ricerca: un indirizzo di Palermo
  // tornava come una via di Catania
  const fullQ = /sicilia/i.test(q) ? q : `${q}, Sicilia`;
  const bare = stripRoadType(street);

  let lists = [];
  if (civic) {
    // prima l'indirizzo esatto, poi la strada (anche scritta in un altro modo: corso/viale/via)
    lists = [await nominatimQuery(fullQ, 6), await photonQuery(street, near)];
    const all = mergePlaces(lists);
    const want = civic.replace(/\s+/g, "").toLowerCase();
    const found = all.some((r) => (r.name + " " + r.full).replace(/\s+/g, "").toLowerCase().includes(want));
    if (!found) {
      lists = [
        ...lists,
        await photonQuery(bare, near),
        await nominatimQuery(`${bare}, ${/catania/i.test(q) ? "" : "Catania"}`, 6),
      ];
    }
  } else {
    // senza civico: si chiede a tutti e due, così la città giusta viene prima
    lists = [await photonQuery(q, near), await nominatimQuery(fullQ, 6)];
  }

  let results = mergePlaces(lists);

  // gli eventi si organizzano solo in Sicilia: fuori non ha senso proporli
  const sicilia = results.filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng) && inSicily(r.lat, r.lng));
  if (sicilia.length) results = sicilia;

  // ordine: prima la città giusta, poi chi ha il civico, poi chi è più vicino
  const wantCity = (scritta || CITY).toLowerCase();
  const want = civic.replace(/\s+/g, "").toLowerCase();
  const civicRe = want ? new RegExp(`(^|[^0-9a-z])${want}([^0-9a-z]|$)`) : null;
  const hasCivic = (r) => Boolean(civicRe) && (r.exact === true || civicRe.test(String(r.name || "").toLowerCase()));
  const giu = (v) => String(v || "").toLowerCase();
  const score = (r) => {
    const inCity = giu(r.city) === wantCity ? 0 : 1;
    const has = civic ? (hasCivic(r) ? 0 : 1) : 0;
    // se hai scritto il paese ("via ... 24 Trecastagni"), quello viene prima di tutto
    const inTown = town && giu(r.full).includes(giu(town)) ? -200 : 0;
    // la città scritta nella ricerca batte tutto il resto
    const inScritta = scritta && giu(r.full).includes(giu(scritta)) ? -300 : 0;
    return inScritta + inCity * 100 + has * 10 + inTown + quickKm(here, r) / 50;
  };
  results = results.map((r, i) => ({ r, i, s: score(r) })).sort((a, b) => a.s - b.s || a.i - b.i).map((x) => x.r);

  // se hai scritto la città, le vie di un altro paese non servono a niente:
  // o si tengono solo quelle giuste, o si propone il centro della città scritta
  if (scritta) {
    const voluta = scritta.toLowerCase();
    const centroCitta = await townCoords(scritta).catch(() => null);
    // una via a 40 chilometri non è "a Messina": o sta vicino al centro della
    // città scritta, o non serve
    const vicina = (r) => !centroCitta || quickKm(centroCitta, r) <= 18;
    const esatte = results.filter((r) => String(r.city || "").toLowerCase() === voluta && vicina(r));
    const citate = results.filter((r) => String(r.full || "").toLowerCase().includes(voluta) && vicina(r));
    if (esatte.length) results = esatte;
    else if (citate.length) results = citate;
    else if (centroCitta && inSicily(centroCitta.lat, centroCitta.lng)) {
      results = [{ name: `${scritta} (centro)`, full: scritta, city: scritta, lat: centroCitta.lat, lng: centroCitta.lng, country: "IT", exact: false }];
    } else results = [];
  }

  results = conPaese(results, scritta);

  // se il civico non esiste nelle mappe, teniamo comunque il numero scritto
  // dalla persona: le coordinate sono quelle della via, ma l'indirizzo resta completo
  if (civic && results.length) {
    // solo la strada che hai scritto si prende il numero: le altre restano come sono
    const streetKey = (s) =>
      stripRoadType(String(s || "").toLowerCase())
        .replace(/\b(del|dello|della|delle|dei|degli|di|da|la|il|lo|le|gli|i|l)\b/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    const qKey = streetKey(street);
    if (qKey) {
      // se c'è il civico, le altre strade non c'entrano: si tengono solo le vie giuste
      const giuste = results.filter((r) => {
        const k = streetKey(String(r.name || "").split(",")[0]);
        return Boolean(k && (k.includes(qKey) || qKey.includes(k)));
      });
      if (giuste.length) results = giuste;
    }
    results = results.map((r) => {
      if (hasCivic(r)) return r;
      const rKey = streetKey(String(r.name || "").split(",")[0]);
      const stessaStrada = Boolean(qKey && rKey && (rKey === qKey || rKey.includes(qKey) || qKey.includes(rKey)));
      if (!stessaStrada) return r;
      const name = /\d/.test(r.name) ? r.name : `${r.name}, ${civic}`;
      return { ...r, name, full: `${r.full}${r.full ? " · " : ""}civico non in mappa` };
    });
  }

  // il paese resta nella risposta: il telefono lo usa per la città dell'evento
  results = results.slice(0, 6).map(({ exact, ...rest }) => rest);

  if (geoCache.size > 500) geoCache.clear();
  geoCache.set(key, { results, at: Date.now() });
  return json({ results });
}

// la Sicilia è l'isola più le sue isole: Ustica, Eolie, Egadi, Pantelleria,
// Lampedusa e Linosa. Prima c'era un rettangolo solo sull'isola grande, così
// chi stava a Ustica o a Pantelleria si sentiva dire che non era in Sicilia.
const SICILY_AREAS = [
  { latMin: 36.6, latMax: 38.32, lngMin: 12.35, lngMax: 15.7 },   // isola principale (Reggio esclusa sotto)
  { latMin: 38.6, latMax: 38.8, lngMin: 13.1, lngMax: 13.25 },    // Ustica
  { latMin: 38.32, latMax: 38.85, lngMin: 14.3, lngMax: 15.3 },   // Eolie
  { latMin: 37.88, latMax: 38.05, lngMin: 11.95, lngMax: 12.42 }, // Egadi
  { latMin: 36.7, latMax: 36.86, lngMin: 11.9, lngMax: 12.1 },    // Pantelleria
  { latMin: 35.4, latMax: 35.9, lngMin: 12.5, lngMax: 12.9 },     // Lampedusa e Linosa
];

function inSicily(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  // dall'altra parte dello Stretto c'è la Calabria: Reggio Calabria non è Sicilia
  if (lat < 38.15 && lng > 15.62) return false;
  return SICILY_AREAS.some((a) => lat >= a.latMin && lat <= a.latMax && lng >= a.lngMin && lng <= a.lngMax);
}

// la città che la persona ha scritto dentro la ricerca ("via etnea 5, siracusa")
// serve a cercare lì e non sempre a Catania
const SIGLE = { sr: "Siracusa", ct: "Catania", pa: "Palermo", me: "Messina", tp: "Trapani", rg: "Ragusa", ag: "Agrigento", cl: "Caltanissetta", en: "Enna" };

// i comuni che la gente scrive davvero: servono a capire "piazza duomo siracusa"
// anche quando non c'è la virgola fra la via e il paese
const CITTA_NOTE = [
  "Catania", "Siracusa", "Palermo", "Messina", "Trapani", "Ragusa", "Agrigento", "Caltanissetta", "Enna",
  "Acireale", "Aci Castello", "Aci Trezza", "Aci Catena", "Aci Sant'Antonio", "Giarre", "Riposto", "Mascali",
  "Taormina", "Letojanni", "Giardini Naxos", "Fiumefreddo", "Militello", "Bronte", "Adrano", "Paternò",
  "Biancavilla", "Belpasso", "Mascalucia", "Nicolosi", "Pedara", "Trecastagni", "Viagrande", "San Giovanni la Punta",
  "Tremestieri", "Gravina", "San Gregorio", "Valverde", "Zafferana", "Linguaglossa", "Randazzo", "Castiglione di Sicilia",
  "Piedimonte", "Sant'Alfio", "Lentini", "Carlentini", "Francofonte", "Augusta", "Melilli", "Priolo", "Sortino",
  "Solarino", "Floridia", "Canicattini", "Noto", "Avola", "Pachino", "Portopalo", "Rosolini", "Ispica", "Pozzallo",
  "Modica", "Scicli", "Comiso", "Vittoria", "Ragusa Ibla", "Chiaramonte", "Monterosso", "Gela", "Niscemi", "Licata",
  "Palma di Montechiaro", "Favara", "Porto Empedocle", "Realmonte", "Sciacca", "Menfi", "Mazara", "Marsala",
  "Castelvetrano", "Partanna", "Salemi", "Alcamo", "Erice", "Valderice", "Cefalù", "Termini Imerese", "Bagheria",
  "Monreale", "Carini", "Partinico", "Milazzo", "Barcellona", "Patti", "Capo d'Orlando", "Sant'Agata di Militello",
  "Caltagirone", "Grammichele", "Mineo", "Ramacca", "Palagonia", "Scordia", "Piazza Armerina", "Barrafranca",
  "Mussomeli", "Gela", "Ustica", "Lipari", "Salina", "Stromboli", "Vulcano", "Panarea", "Filicudi", "Alicudi",
  "Pantelleria", "Lampedusa", "Linosa", "Favignana", "Marettimo", "Levanzo", "Messina", "Capo Peloro",
];

function cittaNelTesto(q) {
  const testo = String(q || "").toLowerCase();
  let trova = "";
  for (const c of CITTA_NOTE) {
    const nome = c.toLowerCase();
    const re = new RegExp(`(^|[^a-zà-ÿ])${nome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-zà-ÿ]|$)`);
    if (re.test(testo) && nome.length > trova.length) trova = c;
  }
  return trova;
}
const NON_CITTA = /^(sicilia|italia|italy|ita)$/i;
const TIPO_VIA = /^(via|viale|vialetto|piazza|piazzale|corso|corsetto|vico|vicoletto|largo|salita|strada|contrada|traversa|lungomare|scala|piano|interno|int\.?)\b/i;

function cittaScritta(q) {
  // "piazza duomo siracusa" non ha virgole: il nome del paese è dentro la frase
  const nota = cittaNelTesto(q);
  if (nota) return nota;
  const grezze = String(q || "")
    .split(/[,;()\-–—]/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (let i = grezze.length - 1; i >= 0; i--) {
    const grezza = grezze[i];
    // "via roma 5, SR": la sigla da sola dice la città
    const sigla = SIGLE[grezza.toLowerCase().replace(/\.$/, "")];
    if (sigla) return sigla;
    const p = grezza
      .replace(/\b\d{5}\b/g, " ")
      .replace(/\b(sr|ct|pa|me|tp|rg|ag|cl|en)\b\.?/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (p.length < 4 || p.length > 34) continue;
    if (/\d/.test(p)) continue;
    if (NON_CITTA.test(p)) continue;
    if (TIPO_VIA.test(p)) continue;
    return SIGLE[p.toLowerCase()] || p;
  }
  return "";
}

const townCache = new Map();

// coordinate della città scritta: una volta sola, poi resta in memoria
async function townCoords(nome) {
  const k = String(nome || "")
    .toLowerCase()
    .replace(/[^a-zà-ÿ ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (k.length < 4) return null;
  const gia = townCache.get(k);
  if (gia && Date.now() - gia.at < 24 * 60 * 60 * 1000) return gia.coords;
  let coords = null;
  try {
    const rows = mergePlaces([
      await nominatimQuery(`${nome}, Sicilia, Italia`, 3),
      await photonQuery(`${nome}, Sicilia`, [37.5022, 15.0873]),
    ]);
    // prima il comune che si chiama così davvero, poi una località che lo
    // contiene: "Trapani" non deve diventare una contrada di un altro paese
    const rango = (r) => {
      const nome = String(r.name || "").toLowerCase();
      const citta = String(r.city || "").toLowerCase();
      const tutto = `${citta} ${String(r.full || "").toLowerCase()} ${nome}`;
      if (citta === k || nome === k) return 0;
      if (citta.startsWith(k) || nome.startsWith(k)) return 1;
      if (tutto.includes(k)) return 2;
      return 9;
    };
    const buoni = rows
      .filter((r) => inSicily(r.lat, r.lng))
      .map((r) => ({ r, q: rango(r) }))
      // solo il comune giusto: "una via che si chiama Reggio Calabria" non basta
      .filter((x) => x.q <= 1)
      .sort((a, b) => a.q - b.q);
    if (buoni.length) coords = { lat: buoni[0].r.lat, lng: buoni[0].r.lng };
  } catch {}
  if (townCache.size > 500) townCache.clear();
  townCache.set(k, { coords, at: Date.now() });
  return coords;
}

// se il posto è scritto a parole, proviamo a capire dove sta.
// Prima si prende il primo risultato che sta in Sicilia: prima capitava che
// un indirizzo di Palermo tornasse da un paese di un'altra regione.
// dal punto sulla mappa capisco il paese: serve quando l'indirizzo non lo dice
const revCache = new Map();
async function reverseTown(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inSicily(lat, lng)) return "";
  const k = `${lat.toFixed(3)},${lng.toFixed(3)}`;
  if (revCache.has(k)) return revCache.get(k);
  let paese = "";
  const pulito = (v) => {
    const s = tidyPlace(v);
    return /^libero consorzio|^citta metropolitana|^provincia|^sicilia$/i.test(s) ? "" : s;
  };
  try {
    const r = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}`, {
      headers: { "user-agent": "FUORI/1.0 (fuori.app)" },
      signal: AbortSignal.timeout(2500),
    });
    if (r.ok) {
      const j = await r.json();
      const pr = (j.features || [])[0]?.properties || {};
      paese = pulito(pr.city || pr.town || pr.village || pr.municipality || pr.county || "");
    }
  } catch {}
  if (!paese) {
    try {
      const p2 = new URLSearchParams({ format: "jsonv2", lat: String(lat), lon: String(lng), zoom: "10", "accept-language": "it", addressdetails: "1" });
      const r2 = await fetch("https://nominatim.openstreetmap.org/reverse?" + p2.toString(), {
        headers: { "user-agent": "FUORI/1.0 (eventi a Catania)", accept: "application/json" },
        signal: AbortSignal.timeout(2500),
      });
      if (r2.ok) {
        const j2 = await r2.json();
        const a = j2.address || {};
        paese = pulito(a.city || a.town || a.village || a.municipality || a.county || j2.name || "");
      }
    } catch {}
  }
  if (revCache.size > 500) revCache.clear();
  revCache.set(k, paese);
  return paese;
}

// il paese esatto dove sono: lo chiede la home quando arriva una posizione nuova.
// La risposta resta in cache mezz'ora, così non si tempesta il servizio.
let DB = null;
async function whereAt(url) {
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return json({ town: "", label: "" });
  const det = await reversePlace(lat, lng).catch(() => null);
  const town = (det && det.town) || (await reverseTown(lat, lng).catch(() => ""));
  const label = det && det.label ? det.label : town;
  const short = det && det.short ? det.short : town;
  // conteggi per la mappa: nel tuo paese, nel mondo. Gli eventi hanno solo
  // lat/lng, quindi si conta in base al paese di ciascun evento.
  let perPaese = {}, mondo = 0;
  try {
    const rows = await DB.prepare("SELECT lat, lng FROM events WHERE lat IS NOT NULL AND lng IS NOT NULL").all();
    for (const r of rows.results || []) {
      mondo++;
      const det2 = await reversePlace(Number(r.lat), Number(r.lng)).catch(() => null);
      const code = (det2 && det2.paeseCode) || "?";
      perPaese[code] = (perPaese[code] || 0) + 1;
    }
  } catch {}
  return new Response(JSON.stringify({ town, label, short, ...(det || {}), perPaese, mondo }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=1800" },
  });
}

// il posto esatto: non solo il comune, anche la frazione e la provincia.
// Cosi' la mappa dice "Riposto (CT)" e non un generico "Catania".
const placeCacheSec = new Map();
async function reversePlace(lat, lng) {
  const k = `${Number(lat).toFixed(3)},${Number(lng).toFixed(3)}`;
  if (placeCacheSec.has(k)) return placeCacheSec.get(k);
  let out = null;
  const pulito = (v) => tidyPlace(v);
  try {
    const p = new URLSearchParams({
      format: "jsonv2", lat: String(lat), lon: String(lng), zoom: "18",
      "accept-language": "it", addressdetails: "1",
    });
    const r = await fetch("https://nominatim.openstreetmap.org/reverse?" + p.toString(), {
      headers: { "user-agent": "FUORI/1.0 (fuori.app)", accept: "application/json" },
      signal: AbortSignal.timeout(2600),
    });
    if (r.ok) {
      const j = await r.json();
      const a = j.address || {};
      const town = pulito(a.city || a.town || a.village || a.municipality || a.county || j.name || "");
      // la frazione/il quartiere vero prima di tutto, mai il generico "Municipio 1":
      // frazione (hamlet/village) > quartiere > zona > sobborgo amministrativo
      const quartiere = pulito(a.quarter || a.neighbourhood || "");
      const fraz = pulito(a.hamlet || a.village || "") || quartiere || pulito(a.locality || "") || pulito(a.suburb || a.city_district || "");
      const prov = pulito(a.county || "").replace(/^Citta metropolitana di /i, "").replace(/^Libero consorzio comunale di /i, "");
      const reg = pulito(a.state || a.region || "");
      const paese = pulito(a.country || "");
      const sigla = String(a["ISO3166-2-lvl6"] || "").split("-").pop() || "";
      // "Brera, Milano (MI), Lombardia": il quartiere, poi la citta', poi la provincia
      const testa = fraz && town && fraz.toLowerCase() !== town.toLowerCase() ? `${fraz}, ${town}` : town || fraz;
      const label = [testa ? testa + (prov && prov.toLowerCase() !== String(town).toLowerCase() ? " (" + prov + ")" : "") : "", reg, paese !== "Italia" ? paese : ""]
        .filter(Boolean).join(", ");
      // nome breve per la testata: la frazione/quartiere dove sei, poi la sigla della provincia
      const provincia = sigla || "";
      const posto = fraz && town && fraz.toLowerCase() !== town.toLowerCase() ? fraz : (town || fraz);
      const short = posto ? (provincia ? `${posto}, ${provincia}` : posto) : "";
      out = { town, fraz, quartiere, prov, reg, paese, paeseCode: String(a.country_code || "").toLowerCase(), sigla, label, short };
    }
  } catch {}
  if (placeCacheSec.size > 400) placeCacheSec.clear();
  placeCacheSec.set(k, out);
  return out;
}

async function placeCoords(place) {
  const q = String(place || "").trim();
  if (q.length < 3) return null;
  const scritta = cittaScritta(q);
  const centroCitta = scritta ? await townCoords(scritta).catch(() => null) : null;
  const centro = centroCitta || { lat: 37.5022, lng: 15.0873 };
  const term = /sicilia/i.test(q) ? q : `${q}, Sicilia`;
  const buono = (r) => r && Number.isFinite(r.lat) && Number.isFinite(r.lng) && inSicily(r.lat, r.lng);
  const trovati = mergePlaces([
    await nominatimQuery(term, 5).catch(() => []),
    await photonQuery(term, [centro.lat, centro.lng]).catch(() => []),
  ]);
  // se la persona ha scritto il paese, l'evento deve stare lì: o una via
  // vicina al paese, o il centro del paese. Mai una via di un altro comune.
  if (scritta && centroCitta) {
    const vicini = trovati.filter((r) => buono(r) && quickKm(centroCitta, r) <= 18);
    if (vicini.length) return vicini[0];
    return { lat: centroCitta.lat, lng: centroCitta.lng };
  }
  if (scritta) {
    // il paese scritto non risulta in Sicilia: si controlla il paese vero,
    // così un indirizzo di Reggio Calabria non finisce a Messina
    const paese = await nominatimQuery(`${scritta}, Italia`, 2).catch(() => []);
    const vero = paese.find((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
    if (vero) return vero;
  }
  const dentro = trovati.filter(buono);
  if (dentro.length) return dentro[0];
  const primo = trovati[0] || (await nominatimQuery(term, 3).catch(() => []))[0];
  return primo && Number.isFinite(primo.lat) && Number.isFinite(primo.lng) ? primo : null;
}

const MAP_TTL = 45 * 60 * 1000;

function round3(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

function kmBetween(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

async function mapPing(env, request) {
  const body = await request.json().catch(() => null);
  if (!body) return bad("body");
  const device = text(body.device, 8, 64);
  if (!device) return bad("device");
  const on = Boolean(body.on);
  if (!on) {
    await env.DB.prepare(`DELETE FROM map_people WHERE device = ?`).bind(device).run();
    return json({ ok: true, on: false });
  }
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return json({ error: "Posizione non valida." }, 400);
  }
  const person = await personFor(env, device);
  if (!person) return json({ error: "Serve un profilo per apparire sulla mappa." }, 403);
  // solo posizione approssimata: 3 decimali, circa 100 metri
  const lat3 = round3(lat);
  const lng3 = round3(lng);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO map_people (device, lat, lng, seen_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(device) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, seen_at = excluded.seen_at`
  )
    .bind(device, lat3, lng3, now)
    .run();
  // il log: una riga per posto nuovo (o dopo due ore fermo), così si legge come un percorso
  const ultimo = await env.DB.prepare(`SELECT lat, lng, at FROM map_log WHERE device = ? ORDER BY at DESC LIMIT 1`)
    .bind(device)
    .first()
    .catch(() => null);
  const spostato = !ultimo || Math.abs(ultimo.lat - lat3) > 0.002 || Math.abs(ultimo.lng - lng3) > 0.002;
  if (spostato || now - (ultimo.at || 0) > 2 * 3600 * 1000) {
    await env.DB.prepare(`INSERT INTO map_log (device, lat, lng, at) VALUES (?, ?, ?, ?)`)
      .bind(device, lat3, lng3, now)
      .run();
  }
  // ogni tanto butto via quello più vecchio di 30 giorni
  if (Math.random() < 0.05) {
    await env.DB.prepare(`DELETE FROM map_log WHERE at < ?`).bind(now - 30 * 864e5).run();
  }
  return json({ ok: true, on: true });
}

async function mapNearby(env, url) {
  const device = (url.searchParams.get("device") || "").slice(0, 64);
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  const r = Math.min(Math.max(Number(url.searchParams.get("r")) || 10, 1), 50);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return json({ error: "Posizione mancante." }, 400);
  const here = { lat, lng };
  const now = Date.now();

  const { results: people } = await env.DB.prepare(
    `SELECT m.device, m.lat, m.lng, l.first_name, l.last_name, l.age, l.sex, l.bio, l.done, l.looking_for, l.interests, l.photo
     FROM map_people m LEFT JOIN leads l ON l.device = m.device
     WHERE m.seen_at > ? LIMIT 200`
  )
    .bind(now - MAP_TTL)
    .all();

  const near = (people || [])
    .filter((p) => p.device !== device)
    .map((p) => ({ ...p, d: kmBetween(here, p) }))
    .filter((p) => p.d <= r)
    .sort((a, b) => a.d - b.d)
    .slice(0, 40)
    .map((p) => ({
      name: [p.first_name, p.last_name].filter(Boolean).join(" ") || "Qualcuno",
      age: p.age || null,
      sex: p.sex || "n",
      photo: p.photo ? `/api/photo/${p.photo}` : "",
      keywords: safeList(p.interests).slice(0, 3),
      bio: String(p.bio || p.done || p.looking_for || "").slice(0, 120),
      lat: p.lat,
      lng: p.lng,
      distance: Math.round(p.d * 1000),
    }));

  const known = Boolean(await personFor(env, device));
  const { results: rows } = await env.DB.prepare(
    `SELECT e.*,
       (SELECT COUNT(*) FROM participants p WHERE p.event_id = e.id AND p.status = 'going') AS joined
     FROM events e
     WHERE e.starts_at > ? AND e.lat IS NOT NULL AND e.lng IS NOT NULL
     ORDER BY e.starts_at ASC LIMIT 200`
  )
    .bind(now - 2 * 60 * 60 * 1000)
    .all();

  const nearEmail = await viewerEmail(env, device);
  // un evento privato lo vedono solo chi l'ha creato e chi è dentro:
  // per gli altri non esiste proprio, nemmeno sulla mappa
  const miei = new Set();
  if (device) {
    const dentro = await env.DB.prepare(`SELECT event_id FROM participants WHERE device = ? AND status = 'going'`)
      .bind(device)
      .all()
      .catch(() => ({ results: [] }));
    for (const riga of dentro.results || []) miei.add(riga.event_id);
  }
  const events = (rows || [])
    .map((e) => ({ ...e, d: kmBetween(here, e), _mio: isMyEvent(e, device, nearEmail) || miei.has(e.id) }))
    .filter((e) => String(e.access || "open") !== "invite" || e._mio)
    .sort((a, b) => a.d - b.d)
    .slice(0, 80)
    .map((e) => ({
      // sulla mappa ci sono tutti gli eventi, anche quelli lontani
      ...shape(e, e.joined || 0, e._mio, 0, false),
      distance: Math.round(e.d * 1000),
    }));

  return json({ people: known ? near : [], locked: !known, events });
}

async function listExtras(env) {
  const { results } = await env.DB.prepare(
    `SELECT kind, value, cat FROM extras ORDER BY created_at ASC LIMIT 500`
  ).all();
  const activities = [];
  const categories = [];
  for (const r of results || []) {
    if (r.kind === "activity") activities.push({ it: r.value, cat: r.cat || "", extra: true });
    else if (r.kind === "category") categories.push({ id: r.value, extra: true });
  }
  return json({ activities, categories });
}

async function createEvent(env, request, origin, ctx) {
  const body = await request.json().catch(() => null);
  if (!body) return bad("body");

  const title = text(body.title, 3, 80);
  const place = text(body.place, 2, 80);
  const host = text(body.host, 2, 40);
  const description = testoLungo(body.description ?? "", 0, 500) ?? "";
  const category = CATEGORIES.includes(body.category) ? body.category : "Altro";
  const activity = text(body.activity ?? "", 0, 40) || "";
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  const hasGeo = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  const device = text(body.device, 8, 64);
  const startsAt = Number(body.startsAt);
  const capacity = Math.round(Number(body.capacity) || 0);
  const city = text(body.city ?? CITY, 2, 40) || CITY;
  const approval = body.approval ? 1 : 0;
  // chi può partecipare: open (tutti), photo (serve foto), verified (serve la verifica del viso),
  // invite (privato: indirizzo nascosto e si entra solo col link d'invito)
  // la foto profilo è la base di FUORI: non esiste più l'evento "aperto a tutti"
  const access = ["verified", "invite"].includes(String(body.access || "")) ? String(body.access) : "photo";
  // energia e comfort zone: due scelte libere, servono a trovare la compagnia giusta
  const VIBES = ["calmo", "sociale", "vivace", "avventura"];
  const COMFORT = ["comodo", "medio", "osa"];
  const vibe = VIBES.includes(String(body.vibe || "")) ? String(body.vibe) : "";
  const comfort = COMFORT.includes(String(body.comfort || "")) ? String(body.comfort) : "";
  const inviteCode = access === "invite" ? crypto.randomUUID().replace(/-/g, "").slice(0, 10) : null;
  const signupHours = Number(body.signupHours);
  // fascia d'età: due pallini. Se manca o copre tutto, l'evento è per tutti.
  const clampAge = (v) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return null;
    return Math.min(90, Math.max(18, n));
  };
  let ageMin = clampAge(body.ageMin);
  let ageMax = clampAge(body.ageMax);
  if (ageMin !== null && ageMax !== null && ageMin > ageMax) [ageMin, ageMax] = [ageMax, ageMin];
  if (ageMin !== null && ageMin <= 18) ageMin = null;
  if (ageMax === 90) ageMax = null; // 90 è il massimo che si può scegliere: equivale a "tutti"
  if (ageMax !== null && ageMax > 90) ageMax = null;
  if (ageMin !== null && ageMax !== null && ageMin === ageMax) {
    return bad("La fascia d'età deve avere almeno un anno di spazio: allarga i pallini.");
  }
  const now = Date.now();

  // l'indirizzo scritto a parole diventa anche un punto sulla mappa: prima
  // l'evento restava senza coordinate e non compariva in nessuna mappa
  let latEvento = hasGeo ? lat : null;
  let lngEvento = hasGeo ? lng : null;
  let trovato = null;
  if (hasGeo && !inSicily(lat, lng)) {
    return bad("Questo indirizzo non risulta in Sicilia. Se è in Sicilia, scrivi anche il paese: per esempio «Via Roma 5, Noto».");
  }
  if (!hasGeo) {
    // nessun punto scelto: se il testo indica un posto fuori dalla Sicilia lo fermiamo qui
    const found = await placeCoords(place).catch(() => null);
    if (found && !inSicily(found.lat, found.lng)) {
      return bad("Questo indirizzo non risulta in Sicilia. Se è in Sicilia, scrivi anche il paese: per esempio «Via Roma 5, Noto».");
    }
    if (found) { latEvento = found.lat; lngEvento = found.lng; trovato = found; }
  }
  // la città dell'evento è quella scritta nell'indirizzo (o scelta dal suggerimento):
  // prima restava sempre "Catania" anche per un evento di Siracusa
  let cittaDaIndirizzo = cittaScritta(place) || (trovato && trovato.city) || text(body.city, 2, 40) || "";
  if (!cittaDaIndirizzo && Number.isFinite(latEvento)) {
    cittaDaIndirizzo = await reverseTown(latEvento, lngEvento).catch(() => "");
  }
  const cittaEvento = (cittaDaIndirizzo || city || CITY).slice(0, 40);

  if (!title) return bad("Il titolo deve avere tra 3 e 80 caratteri.");
  if (!place) return bad("Serve un posto.");
  if (!host) return bad("Serve il tuo nome.");
  if (!device) return bad("device");
  if (!Number.isFinite(startsAt) || startsAt < now - 60 * 60 * 1000) return bad("La data è nel passato.");
  if (startsAt > now + 60 * 24 * 60 * 60 * 1000) return bad("Puoi creare eventi entro due mesi.");
  if (capacity < 2 || capacity > 500) return bad("I posti devono essere tra 2 e 500.");

  const person = await personFor(env, device);
  if (!person) return json({ error: "Prima entra nella lista: serve un attimo.", needRegister: true }, 403);
  if (!person.photo) {
    return json(
      { error: "Prima carica la foto profilo, poi verifica il viso: servono tutte e due per organizzare un evento.", needPhoto: true },
      403
    );
  }
  if (!person.verified_face) {
    return json(
      { error: "La foto c'è, manca la verifica del viso: senza non si organizzano eventi. Si fa dal profilo in due minuti, con un selfie.", needVerify: true },
      403
    );
  }

  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM events WHERE device = ? AND created_at > ?`
  )
    .bind(device, now - 60 * 60 * 1000)
    .first();
  if ((recent?.n || 0) >= MAX_EVENTS_PER_DEVICE_HOUR) {
    return json({ error: "Hai creato troppi eventi nell'ultima ora. Riprova più tardi." }, 429);
  }

  // le iscrizioni chiudono N ore prima (0 o assente = fino all'inizio)
  const signupUntil =
    Number.isFinite(signupHours) && signupHours > 0
      ? Math.max(now, startsAt - signupHours * 60 * 60 * 1000)
      : null;

  const rip = ripetizioneEvento(body, startsAt);
  if (rip.error) return bad(rip.error);

  const id = crypto.randomUUID().slice(0, 8);
  await env.DB.prepare(
    `INSERT INTO events (id, title, category, description, starts_at, place, capacity, host, city, device, created_at, approval, signup_until, activity, lat, lng, age_min, age_max, access, invite_code, owner_email, ends_at, days, weekly_day, repeat_until, weekdays, photos, vibe, comfort)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, title, category, description, rip.startsAt || startsAt, place, capacity, host, cittaEvento, device, now, approval, signupUntil, activity, latEvento, lngEvento, ageMin, ageMax, access, inviteCode, person.email || null, rip.endsAt, rip.days ? JSON.stringify(rip.days) : null, rip.weeklyDay, rip.repeatUntil, rip.weekdays ? JSON.stringify(rip.weekdays) : null, JSON.stringify(await fotoEsistenti(env, body.photos)), vibe, comfort)
    .run();

  await env.DB.prepare(
    `INSERT OR IGNORE INTO participants (event_id, device, name, created_at, status) VALUES (?, ?, ?, ?, 'going')`
  )
    .bind(id, device, host, now)
    .run();

  // quello che le persone scrivono resta in memoria: se l'attività è nuova,
  // da adesso è nella lista di tutti.
  if (activity && activity.length >= 3) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO extras (kind, value, cat, created_at) VALUES ('activity', ?, ?, ?)`
    )
      .bind(activity, category || "", now)
      .run();
  }
  if (category) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO extras (kind, value, cat, created_at) VALUES ('category', ?, '', ?)`
    )
      .bind(category, now)
      .run();
  }

  await bump(env, "events");
  await logActivity(env, "event", host, `“${title}” · ${place}`, id);
  // di un evento privato non si dice dove: l'indirizzo resta nascosto anche nell'avviso
  const shownPlace = access === "invite" ? "indirizzo nascosto" : place;
  const notify = notifyNewEvent(env, { id, title, category, startsAt, place: shownPlace, activity }, origin).catch(() => null);
  if (ctx?.waitUntil) ctx.waitUntil(notify);
  else await notify;

  return json({ id });
}

async function eventDetail(env, id, url) {
  const device = (url.searchParams.get("device") || "").slice(0, 64);
  const row = await env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(id).first();
  if (!row) return json({ error: "Evento non trovato." }, 404);
  const adesso = Date.now();
  const settimanale = row.weekly_day !== null && row.weekly_day !== undefined;
  const ripeteAncora = settimanale && (!row.repeat_until || Number(row.repeat_until) >= adesso);
  const ancoraInCorso = (Number(row.ends_at) || 0) > adesso;
  if (!ripeteAncora && !ancoraInCorso && Number(row.starts_at) < adesso - EVENT_KEEP_MS) {
    await cleanOldEvents(env).catch(() => 0);
    return json({ error: "Questo evento è finito." }, 404);
  }

  // tutto quello che serve, chiesto insieme: una sola attesa invece di cinque
  const [lead, parts, org] = await Promise.all([
    device
      ? env.DB.prepare(`SELECT email, interests, city FROM leads WHERE device = ? ORDER BY created_at DESC LIMIT 1`)
          .bind(device)
          .first()
          .catch(() => null)
      : Promise.resolve(null),
    env.DB.prepare(
      `SELECT p.name, p.device, p.status, p.message, l.photo, l.bio, l.looking_for, l.done,
            l.email_verified, l.phone_verified, l.first_name, l.last_name, l.age, l.sex,
            l.city, l.interests, l.goals, l.outings, l.meet, l.verified_face, l.created_at,
            (SELECT COUNT(*) FROM participants p2 WHERE p2.device = p.device AND p2.status = 'going') AS dentro,
            (SELECT COUNT(*) FROM events e3 WHERE e3.device = p.device) AS organizza,
            (SELECT group_concat(title, ' · ') FROM
              (SELECT title FROM events e2 WHERE e2.device = p.device ORDER BY starts_at DESC LIMIT 3)) AS titoli
       FROM participants p
       LEFT JOIN leads l ON l.device = p.device
       WHERE p.event_id = ?
       ORDER BY p.created_at ASC
       LIMIT 500`
    )
      .bind(id)
      .all()
      .catch(() => ({ results: [] })),
    env.DB.prepare(
      `SELECT l.first_name, l.last_name, l.photo, l.bio, l.looking_for, l.done, l.email_verified,
              l.phone_verified, l.age, l.sex, l.city, l.interests, l.goals, l.outings, l.meet,
              l.verified_face, l.created_at,
              (SELECT COUNT(*) FROM participants p2 WHERE p2.device = ? AND p2.status = 'going') AS dentro,
              (SELECT COUNT(*) FROM events e3 WHERE e3.device = ?) AS organizza
       FROM leads l WHERE l.device = ? LIMIT 1`
    )
      .bind(row.device, row.device, row.device)
      .first()
      .catch(() => null),
  ]);

  const email = lead?.email ? String(lead.email).toLowerCase() : "";
  const padrone = await isOwnerDevice(env, device);
  const owner = padrone || isMyEvent(row, device, email);
  // chi non è registrato vede l'evento, ma non chi c'è dentro
  const known = owner || Boolean(lead);

  const all = parts.results || [];
  const mineIn = all.some((p) => p.device === device && (p.status === "going" || p.status === "pending"));
  const hide = (row.access || "open") === "invite" && !owner && !mineIn;
  const visible = !known ? [] : owner ? all : all.filter((p) => p.status === "going");
  const going = all.filter((p) => p.status === "going").length;
  const pending = all.filter((p) => p.status === "pending").length;

  // chi organizza: la sua scheda, così lo si può conoscere prima di entrare
  let organizzatore = null;
  if (known && !hide) {
    const nome = org
      ? [org.first_name, org.last_name].filter(Boolean).join(" ") || row.host || ""
      : row.host || "";
    organizzatore = {
      name: nome || "Chi organizza",
      photo: org?.photo ? `/api/photo/${org.photo}` : "",
      bio: org?.bio || "",
      done: org?.done || "",
      lookingFor: org?.looking_for || "",
      age: org?.age || null,
      sex: org?.sex || "n",
      verified: Boolean(org?.email_verified && org?.phone_verified),
      emailVerified: Boolean(org?.email_verified),
      faceVerified: Boolean(org?.verified_face),
      city: org?.city || "",
      since: org?.created_at || row.created_at || null,
      interests: parseList(org?.interests),
      goals: parseList(org?.goals),
      outings: parseList(org?.outings),
      meet: parseList(org?.meet),
      dentro: Number(org?.dentro) || 0,
      organizza: Number(org?.organizza) || 1,
      titoli: [row.title].filter(Boolean),
    };
  }

  // affinità: quante cose avete in comune, senza mai dire quali.
  // Serve a far nascere un discorso, non a classificare le persone.
  let affinita = new Map();
  if (known && !owner && device && lead) {
    const miei = new Set(parseList(lead.interests).map((x) => String(x).toLowerCase()));
    const insiemeRows = await env.DB.prepare(
      `SELECT b.device, COUNT(*) n
         FROM participants a JOIN participants b ON b.event_id = a.event_id AND b.device <> a.device
        WHERE a.device = ? AND a.status = 'going' AND b.status = 'going'
        GROUP BY b.device`
    )
      .bind(device)
      .all()
      .catch(() => ({ results: [] }));
    const insieme = new Map((insiemeRows.results || []).map((r) => [r.device, Number(r.n) || 0]));
    for (const p of all) {
      if (p.device === device) continue;
      const suoi = parseList(p.interests).map((x) => String(x).toLowerCase());
      const comuni = suoi.filter((x) => miei.has(x)).length;
      const statiInsieme = insieme.get(p.device) || 0;
      const stessaCitta = Boolean(p.city && lead.city && p.city === lead.city);
      const punti = Math.min(99, comuni * 16 + statiInsieme * 22 + (stessaCitta ? 8 : 0));
      if (comuni || statiInsieme) {
        affinita.set(p.device, {
          comuni,
          punti,
          testo:
            comuni >= 3
              ? `molto in comune (${comuni} interessi)`
              : comuni > 0
                ? `${comuni} ${comuni === 1 ? "interesse" : "interessi"} in comune`
                : "siete stati allo stesso evento",
        });
      }
    }
  }

  // le stelle servono ai preferiti ("più votati") e alla scheda dell'evento
  const numeri = await ratingsDi(env, [id], device).catch(() => ({}));
  const ev = shape(row, going, owner, pending, hide);
  ev.media = Number(numeri[id]?.media) || 0;
  ev.stelle = Number(numeri[id]?.stelle) || 0;
  // chi non può vedere l'evento non vede nemmeno le foto taggate
  const com = hide || !known ? { foto: [], n: 0 } : await fotoCommunity(env, id).catch(() => ({ foto: [], n: 0 }));

  return json({
    event: ev,
    organizzatore,
    owner,
    inviteOk: !hide,
    locked: !known,
    people: visible.map((p) => ({
      name: p.name,
      me: p.device === device,
      status: p.status,
      message: p.status === "pending" ? p.message || "" : "",
      photo: p.photo ? `/api/photo/${p.photo}` : "",
      bio: p.bio || "",
      done: p.done || "",
      lookingFor: p.looking_for || "",
      age: p.age || null,
      sex: p.sex || "n",
      verified: Boolean(p.email_verified && p.phone_verified),
      emailVerified: Boolean(p.email_verified),
      faceVerified: Boolean(p.verified_face),
      city: p.city || "",
      since: p.created_at || null,
      affinita: affinita.get(p.device) || null,
      interests: parseList(p.interests),
      goals: parseList(p.goals),
      outings: parseList(p.outings),
      meet: parseList(p.meet),
      dentro: Number(p.dentro) || 0,
      organizza: Number(p.organizza) || 0,
      titoli: String(p.titoli || "").split(" · ").filter(Boolean),
      device: p.device || undefined,
    })),
    imIn: all.some((p) => p.device === device && p.status === "going"),
    imPending: all.some((p) => p.device === device && p.status === "pending"),
    padrone,
    // chi ha davvero creato l'evento: serve a distinguerlo da chi amministra
    organizer: Boolean(device && row.device === device),
    // cosa ha pubblicato la community con il tag di questo evento
    community: com.foto,
    communityN: com.n,
  });
}

// come si ripete un evento: un giorno, più giorni di fila, giorni scelti, oppure ogni settimana
function ripetizioneEvento(body, startsAt) {
  const mode = ["single", "range", "days", "weekly"].includes(String(body.mode || "")) ? String(body.mode) : "single";
  const out = { mode, endsAt: null, days: null, weeklyDay: null, repeatUntil: null };
  const dayMs = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const MAX = 90 * 864e5;
  if (mode === "range") {
    const end = dayMs(body.endWhen);
    if (!end || end <= startsAt) return { error: "L'ultimo giorno deve venire dopo il primo." };
    if (end - startsAt > MAX) return { error: "Un evento può durare al massimo tre mesi." };
    out.endsAt = end;
  } else if (mode === "days") {
    const scelti = (Array.isArray(body.days) ? body.days : []).map(dayMs).filter(Boolean);
    const uniq = Array.from(new Set([startsAt, ...scelti]))
      .filter((n) => n >= startsAt - 864e5 && n <= startsAt + MAX)
      .sort((a, b) => a - b);
    if (uniq.length < 2) return { error: "Scegli almeno due giorni, oppure torna a \"un giorno solo\"." };
    out.days = uniq;
    out.endsAt = uniq[uniq.length - 1];
  } else if (mode === "weekly") {
    // uno o più giorni della settimana, ognuno con la sua ora
    const grezzo = Array.isArray(body.weekdays) && body.weekdays.length
      ? body.weekdays
      : [{ d: body.weekday, t: "" }];
    const visti = new Set();
    const giorni = [];
    for (const g of grezzo) {
      const d = Math.round(Number(g && g.d));
      if (!(d >= 0 && d <= 6) || visti.has(d)) continue;
      visti.add(d);
      const ora = /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(String((g && g.t) || "")) ? String(g.t) : "";
      giorni.push({ d, t: ora });
    }
    if (!giorni.length) return { error: "Scegli il giorno della settimana." };
    out.weekdays = giorni;
    out.weeklyDay = giorni[0].d;
    // il primo appuntamento è il più vicino tra i giorni scelti
    const base = new Date(startsAt);
    let migliore = null;
    for (const g of giorni) {
      const d0 = new Date(base.getTime());
      const salto = (g.d - d0.getDay() + 7) % 7;
      d0.setDate(d0.getDate() + salto);
      if (g.t) {
        const [hh, mm] = g.t.split(":").map(Number);
        d0.setHours(hh, mm, 0, 0);
        if (d0.getTime() < base.getTime()) d0.setDate(d0.getDate() + 7);
      }
      if (migliore === null || d0.getTime() < migliore) migliore = d0.getTime();
    }
    if (migliore !== null) out.startsAt = migliore;
    const until = dayMs(body.repeatUntil);
    if (until) {
      if (until < startsAt) return { error: "L'ultima data deve venire dopo la prima." };
      if (until - startsAt > 365 * 864e5) return { error: "Un evento settimanale può andare avanti al massimo un anno." };
      out.repeatUntil = until;
    }
  }
  return out;
}

// gli eventi passati di una persona: prima quelli che ha creato, poi quelli con più gente
async function storiaPersona(env, url) {
  const device = String(url.searchParams.get("device") || "").slice(0, 64);
  if (device.length < 5) return json({ events: [] });
  await ensureStoria(env).catch(() => {});
  const { results } = await env.DB.prepare(
    `SELECT event_id AS id, title, activity, category, place, starts_at, role, people
     FROM storia WHERE device = ? ORDER BY starts_at DESC LIMIT 40`
  )
    .bind(device)
    .all()
    .catch(() => ({ results: [] }));
  const righe = results || [];
  const peso = (r) =>
    (r.role === "host" ? 1000 : 0) + Math.min(Number(r.people) || 0, 20) * 10 + (r.activity ? 3 : 0);
  const scelte = righe
    .slice()
    .sort((a, b) => peso(b) - peso(a) || Number(b.starts_at) - Number(a.starts_at))
    .slice(0, 6)
    .sort((a, b) => Number(b.starts_at) - Number(a.starts_at));
  return json({ events: scelte });
}

async function joinEvent(env, id, request, origin, ctx) {
  const body = await request.json().catch(() => null);
  if (!body) return bad("body");
  const name = text(body.name, 2, 40);
  const device = text(body.device, 8, 64);
  if (!name) return bad("Scrivi il tuo nome.");
  if (!device) return bad("device");

  const person = await personFor(env, device);
  if (!person) return json({ error: "Prima entra nella lista: ci vogliono trenta secondi.", needRegister: true }, 403);

  const row = await env.DB.prepare(`SELECT capacity, city, approval, signup_until, age_min, age_max, access, invite_code, title, device AS owner,
      starts_at, ends_at, weekly_day, weekdays, repeat_until
      FROM events WHERE id = ?`)
    .bind(id)
    .first();
  if (!row) return json({ error: "Evento non trovato." }, 404);

  // ogni evento decide chi fa entrare
  // per partecipare servono tutte e due le cose: foto profilo e verifica del viso
  if (!person.photo) {
    return json(
      { error: "Prima carica la foto profilo, poi verifica il viso: servono tutte e due per partecipare.", needPhoto: true },
      403
    );
  }
  if (!person.verified_face) {
    return json(
      { error: "La foto c'è, manca la verifica del viso: senza non si partecipa. Si fa dal profilo in due minuti, con un selfie.", needVerify: true },
      403
    );
  }

  const age = Number(person.age);
  const ageMin = row.age_min ?? null;
  const ageMax = row.age_max ?? null;
  if ((ageMin !== null || ageMax !== null) && Number.isFinite(age) && age > 0) {
    if ((ageMin !== null && age < ageMin) || (ageMax !== null && age > ageMax)) {
      const who =
        ageMin !== null && ageMax !== null
          ? `chi ha tra i ${ageMin} e i ${ageMax} anni`
          : ageMin !== null
            ? `chi ha almeno ${ageMin} anni`
            : `chi ha fino a ${ageMax} anni`;
      return json(
        { error: `Questo evento è per ${who}: il tuo profilo dice ${age} anni, quindi qui non si può entrare. Guarda gli altri, ce ne sono di tutti i tipi.`, ageBlocked: true },
        409
      );
    }
  }

  const scadenza = scadenzaIscrizioni(row);
  if (scadenza && Date.now() > scadenza) {
    return json({ error: "Iscrizioni chiuse: si entrava solo fino a prima." }, 409);
  }

  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM participants WHERE event_id = ? AND status = 'going'`
  )
    .bind(id)
    .first();
  const already = await env.DB.prepare(`SELECT status FROM participants WHERE event_id = ? AND device = ?`)
    .bind(id, device)
    .first();

  // evento privato: si passa col codice che ha in mano chi organizza,
  // oppure chiedendo di entrare: la richiesta arriva a chi organizza
  let richiestaInvito = false;
  if ((row.access || "open") === "invite" && !already) {
    const code = String(body.invite || "").trim().toLowerCase().slice(0, 32);
    if (!row.invite_code || code !== String(row.invite_code).toLowerCase()) {
      if (body.request !== true) {
        return json(
          { error: "Questo evento è privato: si entra con l'invito di chi organizza, oppure chiedendo di partecipare.", needInvite: true },
          403
        );
      }
      richiestaInvito = true;
    }
  }

  if (!already && (count?.n || 0) >= row.capacity) {
    return json({ error: "Posti finiti. La prossima volta.", full: true }, 409);
  }

  const status = row.approval || richiestaInvito ? "pending" : "going";
  const message = text(body.message ?? "", 0, 200) ?? "";

  await env.DB.prepare(
    `INSERT INTO participants (event_id, device, name, created_at, status, message) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id, device) DO UPDATE SET name = excluded.name, message = excluded.message, status = excluded.status`
  )
    .bind(id, device, name, Date.now(), status, message)
    .run();

  await saveLead(env, { email: person.email, city: row.city, device, source: "partecipa" });

  await bump(env, "joins");
  await logActivity(env, status === "pending" ? "request" : "join", name, `“${row.title}”`, id);

  // chi organizza lo viene a sapere subito
  if (row.owner && row.owner !== device) {
    const job = notifyDevices(
      env,
      [row.owner],
      id,
      {
        title: status === "pending" ? "Qualcuno vuole entrare" : "Nuova iscrizione",
        body: status === "pending"
          ? `${name} chiede di entrare in “${row.title}”. Decidi tu se farlo passare.`
          : `${name} si è iscritto a “${row.title}”.`,
        url: `/?e=${id}`,
      },
      origin
    ).catch(() => 0);
    if (ctx?.waitUntil) ctx.waitUntil(job);
    else await job;
  }

  return json({ ok: true, status });
}

async function decideRequest(env, id, request, origin, ctx) {
  const body = await request.json().catch(() => null);
  const device = text(body?.device, 8, 64);
  const target = text(body?.target, 8, 64);
  const action = body?.action === "accept" ? "going" : body?.action === "decline" ? "declined" : null;
  if (!device || !target || !action) return bad("Richiesta non valida.");

  const row = await env.DB.prepare(`SELECT device, access, owner_email FROM events WHERE id = ?`).bind(id).first();
  if (!row) return json({ error: "Evento non trovato." }, 404);
  if (!isMyEvent(row, device, await viewerEmail(env, device)))
    return json({ error: "Solo chi organizza decide." }, 403);

  if (action === "going") {
    // dentro entrano solo persone con la foto (e verificate, se l'evento lo richiede)
    const chi = await personFor(env, target);
    if (!chi || !chi.photo) {
      return json(
        { error: "Questa persona non ha la foto profilo: non può entrare. Puoi rifiutarla, o chiederle di caricare la foto e verificare il viso.", needPhoto: true },
        409
      );
    }
    if (!chi.verified_face) {
      return json(
        { error: "Questa persona non ha verificato il viso: per entrare servono foto e verifica. Puoi rifiutarla, o chiederle di farla e riprovare.", needVerify: true },
        409
      );
    }
  }

  await env.DB.prepare(`UPDATE participants SET status = ? WHERE event_id = ? AND device = ?`)
    .bind(action, id, target)
    .run();

  const evRow = await env.DB.prepare(`SELECT title FROM events WHERE id = ?`).bind(id).first();
  await logActivity(env, action === "going" ? "accept" : "decline", target, `“${evRow?.title || ""}”`, id);
  if (action === "going") {
    const ev = evRow;
    const job = notifyDevices(
      env,
      [target],
      id,
      {
        title: "Sei dentro",
        body: `L'organizzatore ti ha fatto entrare in “${ev?.title || "l'evento"}”. La chat del gruppo è aperta.`,
        url: `/?e=${id}`,
      },
      origin
    ).catch(() => 0);
    if (ctx?.waitUntil) ctx.waitUntil(job);
    else await job;
  }

  return json({ ok: true, status: action });
}

async function leaveEvent(env, id, request) {
  const body = await request.json().catch(() => null);
  const device = text(body?.device, 8, 64);
  if (!device) return bad("device");
  await env.DB.prepare(`DELETE FROM participants WHERE event_id = ? AND device = ?`).bind(id, device).run();
  return json({ ok: true });
}

// i telefoni di un elenco di persone: serve per gli avvisi che non si possono perdere
async function endpointsForDevices(env, devices) {
  const list = [...new Set(devices || [])].filter(Boolean);
  if (!list.length) return [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT endpoint FROM push_subs WHERE device IN (${list.map(() => "?").join(",")})`
    )
      .bind(...list)
      .all();
    return (results || []).map((r) => r.endpoint).filter(Boolean);
  } catch {
    return [];
  }
}

// chi ha a che fare con un evento: dentro, nei preferiti, o l'ha solo guardato
async function chiSegueLEvento(env, id, titolo) {
  const devices = new Set();
  const prendi = async (q, ...args) => {
    try {
      const { results } = await env.DB.prepare(q).bind(...args).all();
      for (const r of results || []) if (r.device) devices.add(r.device);
    } catch {}
  };
  await prendi(`SELECT device FROM participants WHERE event_id = ?`, id);
  await prendi(`SELECT device FROM saved WHERE event_id = ?`, id);
  if (titolo)
    await prendi(
      `SELECT DISTINCT device FROM peek WHERE kind = 'evento_aperto' AND detail = ? AND at > ?`,
      titolo,
      Date.now() - 30 * 864e5
    );
  return devices;
}

async function deleteEvent(env, id, request, ctx) {
  const body = await request.json().catch(() => null);
  const device = text(body?.device, 8, 64);
  if (!device) return bad("device");
  const row = await env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(id).first();
  if (!row) return json({ error: "Evento non trovato." }, 404);
  const padrone = await sonoPadrone(env, device);
  if (!padrone && !isMyEvent(row, device, await viewerEmail(env, device)))
    return json({ error: "Questo evento non è tuo." }, 403);
  // prima di toglierlo: chi partecipa, chi l'ha salvato, chi l'ha guardato
  // deve sapere che non c'è più. Arriva come notifica, anche ad app chiusa.
  const titolo = String(row.title || "").slice(0, 80);
  // il motivo lo scrive chi annulla: senza, non si annulla (lo chiede l'app)
  const motivo = String(body?.motivo || "").replace(/\s+/g, " ").trim().slice(0, 180);
  if (motivo.length < 5) return json({ error: "Scrivi perché annulli l'evento: lo leggono tutti gli iscritti." }, 400);
  const chi = await chiSegueLEvento(env, id, titolo);
  chi.delete(device);
  const avviso = {
    title: "Evento annullato",
    body: `“${titolo || "L'evento"}” non c'è più. Motivo: ${motivo}`,
    url: "/",
    motivo,
  };
  const mandaAvviso = (async () => {
    const eps = await endpointsForDevices(env, [...chi]);
    return deliverEndpoints(env, eps, avviso, new URL(request.url).origin);
  })().catch(() => 0);
  if (ctx && ctx.waitUntil) ctx.waitUntil(mandaAvviso);
  else await mandaAvviso;
  // se l'evento è già passato finisce nei ricordi con la sua descrizione, non sparisce
  if (Number(row.starts_at) <= Date.now()) {
    await ensurePast(env).catch(() => {});
    const andati = await env.DB.prepare(`SELECT COUNT(*) AS n FROM participants WHERE event_id = ? AND status = 'going'`).bind(id).first().catch(() => null);
    await env.DB.prepare(
      `INSERT OR REPLACE INTO past_events (id, title, activity, category, place, city, starts_at, people, at, photos, host, description, access)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        String(row.title || "").slice(0, 90),
        String(row.activity || "").slice(0, 40),
        String(row.category || "").slice(0, 24),
        String(row.place || "").slice(0, 90),
        String(row.city || "").slice(0, 40),
        Number(row.starts_at) || 0,
        Number(andati?.n) || 0,
        Date.now(),
        JSON.stringify(fotoDi(row)),
        String(row.host || "").slice(0, 60),
        String(row.description || "").slice(0, 500),
        String(row.access || "open").slice(0, 12)
      )
      .run()
      .catch(() => {});
  }
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM participants WHERE event_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM events WHERE id = ?`).bind(id),
  ]);
  return json({ ok: true });
}

/* ---------- modifica di un evento già creato ---------- */

async function updateEvent(env, id, request) {
  const body = await request.json().catch(() => null);
  if (!body) return bad("body");
  const device = text(body.device, 8, 64);
  if (!device) return bad("device");

  const row = await env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(id).first();
  if (!row) return json({ error: "Evento non trovato." }, 404);
  // il padrone dell'app sistema qualsiasi evento, anche quello di un altro
  const padrone = await sonoPadrone(env, device);
  if (!padrone && !isMyEvent(row, device, await viewerEmail(env, device)))
    return json({ error: "Questo evento non è tuo." }, 403);

  const title = text(body.title, 3, 80);
  const place = text(body.place, 2, 80);
  const host = text(body.host, 2, 40);
  if (!title) return bad("Il titolo deve avere tra 3 e 80 caratteri.");
  if (!place) return bad("Serve un posto.");
  if (!host) return bad("Serve il tuo nome.");

  const description = testoLungo(body.description ?? "", 0, 500) ?? "";
  const category = CATEGORIES.includes(body.category) ? body.category : row.category;
  const activity = text(body.activity ?? "", 0, 40) || "";
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  const hasGeo = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  // si organizza solo in Sicilia (qui la posizione è già calcolata)
  let latEvento = hasGeo ? lat : null;
  let lngEvento = hasGeo ? lng : null;
  if (hasGeo && !inSicily(lat, lng)) {
    return bad("Questo indirizzo non risulta in Sicilia. Se è in Sicilia, scrivi anche il paese: per esempio «Via Roma 5, Noto».");
  }
  let trovato = null;
  if (!hasGeo) {
    const found = await placeCoords(place).catch(() => null);
    if (found && !inSicily(found.lat, found.lng)) {
      return bad("Questo indirizzo non risulta in Sicilia. Se è in Sicilia, scrivi anche il paese: per esempio «Via Roma 5, Noto».");
    }
    // anche modificando: l'indirizzo scritto vale come punto sulla mappa
    if (found) { latEvento = found.lat; lngEvento = found.lng; trovato = found; }
  }
  // anche qui la città segue l'indirizzo (se non si capisce, resta quella di prima)
  let cittaDaIndirizzo = cittaScritta(place) || (trovato && trovato.city) || text(body.city, 2, 40) || "";
  if (!cittaDaIndirizzo && Number.isFinite(latEvento)) {
    cittaDaIndirizzo = await reverseTown(latEvento, lngEvento).catch(() => "");
  }
  const cittaEvento = (cittaDaIndirizzo || row.city || CITY).slice(0, 40);
  const approval = body.approval ? 1 : 0;
  const access = ["verified", "invite"].includes(String(body.access || "")) ? String(body.access) : "photo";
  // se diventa privato adesso, il codice d'invito nasce in questo momento; se torna pubblico sparisce
  const inviteCode =
    access === "invite" ? row.invite_code || crypto.randomUUID().replace(/-/g, "").slice(0, 10) : null;

  const clampAge = (v) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return null;
    return Math.min(90, Math.max(18, n));
  };
  let ageMin = clampAge(body.ageMin);
  let ageMax = clampAge(body.ageMax);
  if (ageMin !== null && ageMax !== null && ageMin > ageMax) [ageMin, ageMax] = [ageMax, ageMin];
  if (ageMin !== null && ageMin <= 18) ageMin = null;
  if (ageMax === 90 || (ageMax !== null && ageMax > 90)) ageMax = null;
  if (ageMin !== null && ageMax !== null && ageMin === ageMax) {
    return bad("La fascia d'età deve avere almeno un anno di spazio: allarga i pallini.");
  }

  const now = Date.now();
  const startsAt = Number(body.startsAt);
  const sameDate = Number.isFinite(startsAt) && Math.abs(startsAt - row.starts_at) < 60 * 1000;
  // un evento già iniziato si può ancora correggere, ma non si può spostare nel passato
  if (!Number.isFinite(startsAt) || (!sameDate && startsAt < now - 60 * 60 * 1000)) {
    return bad("La data è nel passato.");
  }
  if (startsAt > now + 60 * 24 * 60 * 60 * 1000) return bad("Puoi creare eventi entro due mesi.");

  const capacity = Math.round(Number(body.capacity) || row.capacity);
  if (capacity < 2 || capacity > 500) return bad("I posti devono essere tra 2 e 500.");
  // chi è già dentro non resta fuori: i posti non possono scendere sotto gli iscritti
  const taken = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM participants WHERE event_id = ? AND status IN ('going', 'pending')`
  )
    .bind(id)
    .first();
  const inside = taken?.n || 0;
  if (inside > capacity) {
    return json({ error: `Ci sono già ${inside} iscritti: metti almeno ${inside} posti.` }, 400);
  }

  const signupHours = Number(body.signupHours);
  const signupUntil =
    Number.isFinite(signupHours) && signupHours > 0
      ? Math.max(now, startsAt - signupHours * 60 * 60 * 1000)
      : null;

  const rip = ripetizioneEvento(body, startsAt);
  if (rip.error) return bad(rip.error);

  await env.DB.prepare(
    `UPDATE events SET city = ?, title = ?, category = ?, description = ?, starts_at = ?, place = ?, capacity = ?,
      host = ?, approval = ?, signup_until = ?, activity = ?, lat = ?, lng = ?, age_min = ?, age_max = ?, access = ?,
      invite_code = ?, updated_at = ?, ends_at = ?, days = ?, weekly_day = ?, repeat_until = ?, weekdays = ?, photos = ?,
      vibe = ?, comfort = ?
     WHERE id = ?`
  )
    .bind(
      cittaEvento, title, category, description, rip.startsAt || startsAt, place, capacity, host, approval, signupUntil,
      activity, latEvento, lngEvento, ageMin, ageMax, access, inviteCode, Date.now(),
      rip.endsAt, rip.days ? JSON.stringify(rip.days) : null, rip.weeklyDay, rip.repeatUntil, rip.weekdays ? JSON.stringify(rip.weekdays) : null,
      JSON.stringify(await fotoEsistenti(env, body.photos)),
      ['calmo', 'sociale', 'vivace', 'avventura'].includes(String(body.vibe || '')) ? String(body.vibe) : (row.vibe || null),
      ['comodo', 'medio', 'osa'].includes(String(body.comfort || '')) ? String(body.comfort) : (row.comfort || null),
      id
    )
    .run();

  return json({ ok: true, id });
}

/* ---------- feedback ---------- */

async function createFeedback(env, request) {
  const body = await request.json().catch(() => null);
  if (!body) return bad("body");

  const message = text(body.text, 3, 800);
  if (!message) return bad("Scrivi almeno una frase.");
  const device = text(body.device ?? "", 0, 64) || "";
  const email = isEmail(body.email);
  const mood = Number(body.mood);
  const now = Date.now();

  if (device) {
    const recent = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM feedback WHERE device = ? AND created_at > ?`
    )
      .bind(device, now - 60 * 60 * 1000)
      .first();
    if ((recent?.n || 0) >= MAX_FEEDBACK_PER_DEVICE_HOUR) {
      return json({ error: "Ne hai già dette tante. Riprova tra un po'." }, 429);
    }
  }

  const kind = ["bug", "idea", "altro"].includes(String(body.kind || "")) ? String(body.kind) : "altro";
  await env.DB.prepare(
    `INSERT INTO feedback (text, email, device, city, mood, path, kind, stato, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'nuova', ?)`
  )
    .bind(
      message,
      email,
      device,
      (body.city || CITY).slice(0, 40),
      Number.isFinite(mood) && mood >= 1 && mood <= 5 ? Math.round(mood) : null,
      String(body.path || "").slice(0, 120),
      kind,
      now
    )
    .run();
  await bump(env, "feedback");

  if (email) await saveLead(env, { email, city: body.city, device, source: "feedback" });

  return json({ ok: true });
}

/* ---------- numeri e amministrazione ---------- */

/* ---------- recupero password ---------- */
function randTok(n = 24) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function mailReset(env, to, link) {
  if (!env.RESEND_API_KEY) return false;
  const from = env.MAIL_FROM || "FUORI <onboarding@resend.dev>";
  const html =
    `<div style="font-family:system-ui,-apple-system,sans-serif;background:#0b0b0b;color:#f5f5f5;padding:26px">` +
    `<p style="margin:0 0 14px;letter-spacing:.18em;font-size:12px;color:#c6ff00">FUORI</p>` +
    `<h1 style="margin:0 0 10px;font-size:21px">Scegli una password nuova</h1>` +
    `<p style="margin:0 0 18px;color:#bdbdbd">Il link vale un'ora e funziona una volta sola. Se non hai chiesto tu il cambio, ignora questa mail: la password resta quella di prima.</p>` +
    `<p style="margin:0 0 20px"><a href="${link}" style="display:inline-block;background:#c6ff00;color:#0b0b0b;padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:700">Scegli la password</a></p>` +
    `<p style="margin:0;color:#7d7d7d;font-size:12px">Se il pulsante non funziona, copia questo indirizzo: ${link}</p></div>`;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to, subject: "FUORI · la tua nuova password", html }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/* ---------- tentativi sul mio account: chi li fa, da dove, e cosa decido io ---------- */
let secOk = false;
async function ensureSecurity(env) {
  if (secOk) return;
  secOk = true;
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS security_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        che TEXT NOT NULL, esito TEXT NOT NULL, email TEXT, device TEXT, ip TEXT, ua TEXT, nota TEXT, at INTEGER NOT NULL
      )`
    ).run();
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_sec_at ON security_alerts(at)`).run();
  } catch { secOk = false; }
}

async function securityNote(env, a) {
  await ensureSecurity(env);
  const at = Date.now();
  const che = String(a.che || "Tentativo").slice(0, 80);
  await env.DB.prepare(
    `INSERT INTO security_alerts (che, esito, email, device, ip, ua, nota, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(che, String(a.esito || "da valutare").slice(0, 16), String(a.email || "").slice(0, 80), String(a.device || "").slice(0, 64), String(a.ip || "").slice(0, 48), String(a.ua || "").slice(0, 120), String(a.nota || "").slice(0, 160), at)
    .run()
    .catch(() => {});
  // un avviso sul telefono, al massimo uno ogni 5 minuti
  try {
    const ultimo = await env.DB.prepare(`SELECT v FROM meta WHERE k = 'sec_push'`).first();
    if (a.esito === "bloccato" && (!ultimo || at - Number(ultimo.v) > 5 * 60 * 1000)) {
      await env.DB.prepare(`INSERT INTO meta (k, v) VALUES ('sec_push', ?) ON CONFLICT(k) DO UPDATE SET v = ?`)
        .bind(String(at), String(at))
        .run();
      await notifyOwner(env, { title: "Tentativo sul tuo account", body: `${che}: bloccato. È negli insight.`, url: "/?sicurezza=1" }, a.origin || "https://fuori.fuori-catania.workers.dev");
    }
  } catch {}
}

async function ownerAlerts(env, url) {
  const device = text(url.searchParams.get("device"), 8, 64);
  const permesso = (await isOwner(env, url)) || (device && (await sonoPadrone(env, device)));
  if (!permesso) return json({ error: "Non trovato." }, 404);
  await ensureSecurity(env);
  const { results } = await env.DB.prepare(
    `SELECT che, esito, nota, ip, ua, at FROM security_alerts ORDER BY at DESC LIMIT 30`
  )
    .all()
    .catch(() => ({ results: [] }));
  return json({
    alerts: (results || []).map((r) => ({
      che: r.che,
      esito: r.esito,
      nota: r.nota,
      dove: r.ip ? `rete ${r.ip}` : "",
      at: r.at,
    })),
  });
}

async function forgot(env, request) {
  const body = await request.json().catch(() => null);
  const email = isEmail(body?.email);
  // stessa risposta sempre: non diciamo a nessuno chi è iscritto
  if (!email) return json({ ok: true, mail: false });
  // il mio account non si resetta da solo: il link non parte mai e il tentativo
  // finisce nei miei insight, con il telefono e la rete da cui è arrivato
  if (email === ownerEmail(env)) {
    const device = text(body?.device, 8, 64);
    await securityNote(env, {
      che: "Reset password del tuo account",
      esito: "bloccato",
      email,
      device,
      ip: clientIp(request),
      ua: request.headers.get("user-agent") || "",
      nota: "Password non inviata: il tuo account si sblocca solo dal tuo telefono.",
      origin: new URL(request.url).origin,
      env,
    }).catch(() => {});
    return json({ ok: true, mail: false, known: true });
  }
  const row = await env.DB.prepare(`SELECT email FROM leads WHERE email = ?`).bind(email).first();
  if (!row) return json({ ok: true, mail: false, known: false });
  const tok = randTok(24);
  const hash = await sha256hex(tok);
  const exp = Date.now() + 60 * 60 * 1000;
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM resets WHERE email = ?`).bind(email),
    env.DB.prepare(`INSERT INTO resets (token, email, exp, used) VALUES (?, ?, ?, 0)`).bind(hash, email, exp),
  ]);
  const origin = new URL(request.url).origin;
  const link = `${origin}/?reset=${tok}`;
  const sent = await mailReset(env, email, link);
  // se l'invio mail non è configurato il link si mostra nella pagina
  return json({ ok: true, mail: sent, known: true, link: sent ? undefined : link });
}

async function resetPassword(env, request) {
  const body = await request.json().catch(() => null);
  const tok = String(body?.token || "").slice(0, 120);
  const password = String(body?.password || "");
  if (!tok) return bad("token");
  if (password.length < 8) return json({ error: "La password deve avere almeno 8 caratteri." }, 400);
  const hash = await sha256hex(tok);
  const row = await env.DB.prepare(`SELECT email, exp, used FROM resets WHERE token = ?`).bind(hash).first();
  if (!row || row.used || row.exp < Date.now()) {
    return json({ error: "Link scaduto o già usato. Chiedine un altro." }, 400);
  }
  const pwd = await hashPassword(password);
  await env.DB.batch([
    env.DB.prepare(`UPDATE leads SET password_hash = ?, password_salt = ? WHERE email = ?`).bind(pwd.hash, pwd.salt, row.email),
    env.DB.prepare(`UPDATE resets SET used = 1 WHERE token = ?`).bind(hash),
  ]);
  return json({ ok: true });
}

// chi ha scritto il post: il telefono che l'ha pubblicato, o la sua email verificata
async function creatorePost(env, row, device, email) {
  if (!row) return false;
  if (await sonoPadrone(env, device)) return true;
  if (row.device && device && row.device === device) return true;
  const who = await viewerEmail(env, device);
  const sua = String(row.email || "").toLowerCase();
  return Boolean(who && sua && String(who).toLowerCase() === sua);
}

/* ---------- il padrone di casa ---------- */
function ownerEmail(env) {
  return String(env.ADMIN_EMAIL || "christianguarrera@gmail.com").trim().toLowerCase();
}

async function hmacB64(env, msg) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(env.ADMIN_KEY || "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function ownerLogin(env, request) {
  const body = await request.json().catch(() => null);
  const email = isEmail(body?.email);
  const password = String(body?.password || "");
  const only = ownerEmail(env);
  if (!email || email !== only) return json({ error: "Questa parte è solo dell'amministratore." }, 403);
  const row = await env.DB.prepare(`SELECT * FROM leads WHERE email = ?`).bind(email).first();
  if (!row || !row.password_hash) return json({ error: "Email o password sbagliati." }, 401);
  const { hash } = await hashPassword(password, row.password_salt);
  if (hash !== row.password_hash) return json({ error: "Email o password sbagliati." }, 401);
  await markOwnerDevice(env, body?.device);
  const exp = Date.now() + 12 * 60 * 60 * 1000;
  return json({ ok: true, token: `${exp}.${await hmacB64(env, "owner|" + only + "|" + exp)}` });
}

// il permesso dei numeri scadeva dopo 12 ore e sembrava "rotto": qui il telefono
// lo rinnova da solo, usando il permesso vecchio (che solo io posso aver ricevuto)
async function ownerRefresh(env, request) {
  const body = await request.json().catch(() => null);
  const vecchio = String(body?.token || "");
  const [expStr, sig] = vecchio.split(".");
  const exp = Number(expStr);
  if (!env.ADMIN_KEY || !sig || !Number.isFinite(exp)) return json({ error: "Non trovato." }, 404);
  // vale anche un permesso scaduto, ma non più vecchio di due mesi
  if (exp < Date.now() - 60 * 24 * 60 * 60 * 1000) return json({ error: "Non trovato." }, 404);
  try {
    const want = await hmacB64(env, "owner|" + ownerEmail(env) + "|" + exp);
    if (want !== sig) return json({ error: "Non trovato." }, 404);
    const nuovo = Date.now() + 7 * 24 * 60 * 60 * 1000;
    return json({ ok: true, token: `${nuovo}.${await hmacB64(env, "owner|" + ownerEmail(env) + "|" + nuovo)}` });
  } catch {
    return json({ error: "Non trovato." }, 404);
  }
}

async function isOwner(env, url) {
  const token = String(url.searchParams.get("token") || "");
  const [expStr, sig] = token.split(".");
  const exp = Number(expStr);
  if (!env.ADMIN_KEY || !sig || !Number.isFinite(exp) || exp < Date.now()) return false;
  const want = await hmacB64(env, "owner|" + ownerEmail(env) + "|" + exp);
  return want === sig;
}

// le foto che aspettano ancora la verifica del viso (le verificate non servono)
async function ownerPhotos(env) {
  const rows =
    (
      await env.DB.prepare(
        `SELECT first_name, last_name, email, photo, face_selfie,
                COALESCE(verified_face,0) viso, COALESCE(face_pending,0) in_corso, created_at
         FROM leads
         WHERE photo IS NOT NULL AND photo != '' AND COALESCE(verified_face,0) = 0
         ORDER BY created_at DESC LIMIT 200`
      ).all()
    ).results || [];
  const photos = rows.map((r) => ({
    da: r.created_at || 0,
    nome: [r.first_name, r.last_name].filter(Boolean).join(" ") || r.email,
    fotoUrl: `/api/photo/${r.photo}`,
    selfieUrl: r.face_selfie ? `/api/photo/${r.face_selfie}` : "",
    stato: r.in_corso ? "in corso" : r.face_selfie ? "dubbio" : "mai",
    statoTesto: r.in_corso
      ? "ha iniziato la verifica, non l'ha finita"
      : r.face_selfie
        ? "ha mandato il selfie, da controllare"
        : "foto caricata, verifica mai iniziata",
  }));
  return json({ photos });
}

// tutte le persone, una per una, con tutto quello che fanno
// come stanno gli avvisi: quanti telefoni sono iscritti e se l'ultimo invio è arrivato
async function ownerPush(env) {
  const rows = await env.DB.prepare(
    `SELECT p.email, p.device, p.created_at, p.last_ok, p.last_fail, p.last_status, p.endpoint,
            l.first_name, l.last_name
     FROM push_subs p LEFT JOIN leads l ON (l.email = p.email OR (p.device <> '' AND l.device = p.device))
     ORDER BY COALESCE(p.last_ok, p.created_at) DESC
     LIMIT 60`
  )
    .all()
    .catch(() => ({ results: [] }));
  const lista = (rows.results || []).map((r) => ({
    chi: [r.first_name, r.last_name].filter(Boolean).join(" ") || r.email || "senza nome",
    email: r.email || "",
    device: r.device || "",
    da: r.created_at || null,
    ok: r.last_ok || null,
    ko: r.last_fail || null,
    stato: r.last_status || null,
    telefono: String(r.endpoint || "").split("/").pop().slice(0, 10),
  }));
  return json({
    avvisi: lista,
    conteggi: {
      iscritti: lista.length,
      arrivati: lista.filter((r) => r.ok).length,
      falliti: lista.filter((r) => r.ko && (!r.ok || r.ko > r.ok)).length,
      ultimo: lista.reduce((m, r) => Math.max(m, r.ok || 0), 0) || null,
    },
  });
}

async function ownerPeople(env) {
  const now = Date.now();
  const people = await env.DB.prepare(
    `SELECT l.email, l.phone, l.device, l.first_name, l.last_name, l.age, l.sex, l.city, l.locale,
            l.created_at, l.last_seen, l.interests, l.goals, l.meet, l.outings, l.done,
            l.looking_for, l.bio, l.photo, l.email_verified, l.phone_verified, l.verified_face,
            l.face_pending, l.consent, l.source,
            (SELECT COUNT(*) FROM events e WHERE e.device = l.device) AS creati,
            (SELECT COUNT(*) FROM participants p WHERE p.device = l.device AND p.status = 'going') AS dentro,
            (SELECT COUNT(*) FROM participants p WHERE p.device = l.device AND p.status = 'pending') AS attesa,
            (SELECT COUNT(*) FROM messages m WHERE m.device = l.device) AS messaggi,
            (SELECT COUNT(*) FROM reactions r WHERE r.device = l.device) AS reazioni,
            (SELECT COUNT(*) FROM dl_dev d WHERE d.device = l.device) AS download,
            (SELECT COUNT(*) FROM visits v WHERE v.device = l.device) AS visite,
            (SELECT screens FROM visits v WHERE v.device = l.device ORDER BY day DESC LIMIT 1) AS schermate,
            (SELECT at FROM opens o WHERE o.device = l.device) AS aperto_at,
            (SELECT mode FROM opens o WHERE o.device = l.device) AS aperto_modo,
            (SELECT seen_at FROM map_people mp WHERE mp.device = l.device) AS pos_at,
            (SELECT group_concat(title, ' · ') FROM
              (SELECT title FROM events e2 WHERE e2.device = l.device ORDER BY e2.created_at DESC LIMIT 3)) AS titoli
     FROM leads l
     WHERE l.email NOT LIKE 'prova%' AND l.email NOT LIKE 'test%' AND l.email NOT LIKE '%@esempio.%'
     ORDER BY COALESCE(l.last_seen, l.created_at) DESC
     LIMIT 300`
  )
    .all()
    .catch(() => ({ results: [] }));

  const [msgRows, partRows, peekRows, posRows, owner] = await Promise.all([
    env.DB.prepare(
      `SELECT m.device, m.text, m.kind, m.created_at, e.title
       FROM messages m
       JOIN (SELECT device, MAX(id) AS id FROM messages GROUP BY device) last ON last.id = m.id
       LEFT JOIN events e ON e.id = m.event_id`
    )
      .all()
      .catch(() => ({ results: [] })),
    env.DB.prepare(
      `SELECT p.device, p.status, p.created_at, e.title, e.id AS event_id, e.starts_at
       FROM participants p LEFT JOIN events e ON e.id = p.event_id
       ORDER BY p.created_at DESC LIMIT 1200`
    )
      .all()
      .catch(() => ({ results: [] })),
    env.DB.prepare(`SELECT device, kind, detail, at FROM peek WHERE at > ? ORDER BY at DESC LIMIT 2000`)
      .bind(now - 14 * 864e5)
      .all()
      .catch(() => ({ results: [] })),
    env.DB.prepare(`SELECT device, lat, lng, at FROM map_log WHERE at > ? ORDER BY at DESC LIMIT 3000`)
      .bind(now - 30 * 864e5)
      .all()
      .catch(() => ({ results: [] })),
    env.DB.prepare(`SELECT device FROM owner_dev`)
      .all()
      .catch(() => ({ results: [] })),
  ]);

  const byDevice = (rows) => {
    const map = new Map();
    for (const row of rows || []) {
      if (!map.has(row.device)) map.set(row.device, []);
      map.get(row.device).push(row);
    }
    return map;
  };
  // ultimi posti di ognuno (8 al massimo), per il log delle posizioni
  const posLog = new Map();
  for (const r of posRows.results || []) {
    const a = posLog.get(r.device) || [];
    if (a.length < 8) a.push({ at: r.at, lat: r.lat, lng: r.lng });
    posLog.set(r.device, a);
  }
  const lastMsg = new Map((msgRows.results || []).map((r) => [r.device, r]));
  const parts = byDevice(partRows.results);
  const peeks = byDevice(peekRows.results);
  const owners = new Set((owner.results || []).map((r) => r.device));
  const jsonList = (v) => {
    try {
      const arr = JSON.parse(v || "[]");
      return Array.isArray(arr) ? arr.slice(0, 8) : [];
    } catch {
      return [];
    }
  };

  return json({
    now,
    people: (people.results || []).map((p) => ({
      nome: [p.first_name, p.last_name].filter(Boolean).join(" ") || p.email || "senza nome",
      email: p.email || "",
      telefono: p.phone || "",
      device: p.device || "",
      age: p.age || null,
      sex: p.sex || "n",
      city: p.city || "",
      locale: p.locale || "",
      source: p.source || "",
      iscritto: p.created_at || null,
      fotoUrl: p.photo ? `/api/photo/${p.photo}` : "",
      ultimo: p.last_seen || p.created_at || null,
      aperto: p.aperto_at || null,
      modo: p.aperto_modo || "",
      posizione: p.pos_at || null,
      posizioni: posLog.get(p.device) || [],
      verifiche: {
        email: Boolean(p.email_verified),
        telefono: Boolean(p.phone_verified),
        viso: Boolean(p.verified_face),
        visoInAttesa: Boolean(p.face_pending),
        foto: Boolean(p.photo),
        consenso: Boolean(p.consent),
      },
      gusti: {
        interessi: jsonList(p.interests),
        obiettivi: jsonList(p.goals),
        conoscere: jsonList(p.meet),
        uscite: jsonList(p.outings),
      },
      testo: { bio: p.bio || "", cerca: p.looking_for || "", fatto: p.done || "" },
      numeri: {
        creati: p.creati || 0,
        dentro: p.dentro || 0,
        attesa: p.attesa || 0,
        messaggi: p.messaggi || 0,
        reazioni: p.reazioni || 0,
        download: p.download || 0,
        visite: p.visite || 0,
      },
      titoli: String(p.titoli || "").split(" · ").filter(Boolean),
      schermate: String(p.schermate || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(-8),
      eventi: (parts.get(p.device) || []).slice(0, 6).map((e) => ({
        titolo: e.title || "",
        id: e.event_id || "",
        stato: e.status || "",
        quando: e.starts_at || null,
      })),
      ultimoMessaggio: lastMsg.has(p.device)
        ? {
            testo: String(lastMsg.get(p.device).text || "").slice(0, 140),
            quando: lastMsg.get(p.device).created_at || null,
            evento: lastMsg.get(p.device).title || "",
            tipo: lastMsg.get(p.device).kind || "text",
          }
        : null,
      tocchi: (peeks.get(p.device) || []).slice(0, 14).map((x) => ({ cosa: x.kind, su: x.detail, quando: x.at })),
      padrone: owners.has(p.device),
    })),
  });
}

/* ---------- accesso ---------- */

const loginHits = new Map();

// reinstallazione: il telefono cambia, la persona no. I suoi eventi, i suoi messaggi
// e le sue iscrizioni passano al nuovo telefono, così non perde niente.
async function adoptDevice(env, email, oldDevice, device) {
  if (!email || !device || !oldDevice || oldDevice === device) return;
  try {
    await env.DB.batch([
      env.DB.prepare(`UPDATE events SET device = ? WHERE device = ?`).bind(device, oldDevice),
      env.DB.prepare(`UPDATE messages SET device = ? WHERE device = ?`).bind(device, oldDevice),
      env.DB.prepare(
        `INSERT OR IGNORE INTO participants (event_id, device, name, created_at, status)
         SELECT event_id, ?, name, created_at, status FROM participants WHERE device = ?`
      ).bind(device, oldDevice),
      env.DB.prepare(`DELETE FROM participants WHERE device = ?`).bind(oldDevice),
      env.DB.prepare(`UPDATE participants SET device = ? WHERE device = ?`).bind(device, oldDevice),
    ]);
  } catch {}
}

async function login(env, request) {
  const body = await request.json().catch(() => null);
  if (!body) return bad("body");
  const email = isEmail(body.email);
  const password = String(body.password || "");
  if (!email || password.length < 6) return json({ error: "Email o password sbagliati." }, 401);

  const now = Date.now();
  const recent = (loginHits.get(email) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (recent.length >= 8) return json({ error: "Troppi tentativi. Riprova tra qualche minuto." }, 429);

  const row = await env.DB.prepare(`SELECT * FROM leads WHERE email = ?`).bind(email).first();
  if (!row || !row.password_hash) {
    loginHits.set(email, recent.concat(now));
    return json({ error: "Email o password sbagliati." }, 401);
  }

  const { hash } = await hashPassword(password, row.password_salt);
  if (hash !== row.password_hash) {
    loginHits.set(email, recent.concat(now));
    return json({ error: "Email o password sbagliati." }, 401);
  }

  const device = text(body.device, 8, 64);
  // il mio account entra solo dal mio telefono: da un altro, la password non basta
  if (email === ownerEmail(env) && !(await isOwnerDevice(env, device))) {
    await securityNote(env, {
      che: "Accesso al tuo account da un altro telefono",
      esito: "bloccato",
      email,
      device,
      ip: clientIp(request),
      ua: request.headers.get("user-agent") || "",
      nota: "Password corretta, ma il telefono non è il tuo: accesso negato.",
      origin: new URL(request.url).origin,
      env,
    }).catch(() => {});
    return json({ error: "Email o password sbagliati." }, 401);
  }
  if (device) {
    await adoptDevice(env, email, row.device, device);
    await env.DB.prepare(`UPDATE leads SET device = ?, last_seen = ? WHERE email = ?`)
      .bind(device, now, email)
      .run();
  }
  loginHits.delete(email);
  let extra = {};
  if (email === ownerEmail(env)) await markOwnerDevice(env, device);
  if (email === ownerEmail(env) && env.ADMIN_KEY) {
    const exp = Date.now() + 12 * 60 * 60 * 1000;
    extra = { owner: `${exp}.${await hmacB64(env, "owner|" + email + "|" + exp)}` };
  }
  return json({ ok: true, person: personOf({ ...row, device: device || row.device }), ...extra });
}

async function logout(env, request) {
  const body = await request.json().catch(() => null);
  const device = text(body?.device, 8, 64);
  if (!device) return bad("device");
  await env.DB.prepare(`UPDATE leads SET device = NULL WHERE device = ?`).bind(device).run();
  return json({ ok: true });
}

/* ---------- voce -> testo ---------- */

async function speechToText(env, request) {
  const body = await request.json().catch(() => null);
  if (!body) return bad("body");
  if (!env.GEMINI_KEY) return json({ error: "assistente non configurato" }, 503);

  const audio = String(body.audio || "");
  if (audio.length < 100) return bad("Audio non valido.");
  if (audio.length > 2.6e6) return bad("Registrazione troppo lunga.");

  const mime = String(body.mime || "audio/webm").split(";")[0].trim().toLowerCase();
  const allowed = ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-wav", "audio/aac", "audio/flac"];
  if (!allowed.includes(mime)) return bad("Formato audio non supportato.");

  const lang = ["it", "en", "es", "pt"].includes(body.lang) ? body.lang : "it";
  const device = String(body.device || "").slice(0, 64);
  const now = Date.now();

  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ask_log WHERE device = ? AND created_at > ?`
  )
    .bind(device, now - 3600 * 1000)
    .first();
  if ((recent?.n || 0) > 120) return json({ error: "Troppe richieste di fila. Riprova tra un po'." }, 429);

  const langueName = { it: "italiano", en: "inglese", es: "spagnolo", pt: "portoghese" }[lang];
  // istruzioni strette: il modello tendeva a "ripulire" la frase, aggiungendo
  // parole mai dette o saltando quelle dette piano
  const prompt = `Trascrivi ESATTAMENTE le parole che senti in questo audio, in ${langueName}.
Regole: scrivi tutto in minuscolo, senza maiuscole. Metti la virgola o il punto solo dove la voce fa una pausa vera, senza aggiungerne altre.
Non correggere, non riassumere, non completare le frasi, non aggiungere parole tue.
Se una parola si sente poco, scrivi quello che senti piuttosto che inventarla.
Se l'audio è silenzioso o incomprensibile rispondi solo con: vuoto
Rispondi solo con la trascrizione, niente virgolette e niente commenti.`;

  const payload = {
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mime, data: audio } },
        ],
      },
    ],
    generationConfig: { temperature: 0, maxOutputTokens: 260, thinkingConfig: { thinkingBudget: 0 } },
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    for (const model of GEMINI_MODELS) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_KEY}`,
          { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }
        );
        if (!res.ok) continue;
        const data = await res.json();
        const text = (data.candidates?.[0]?.content?.parts || [])
          .map((p) => p.text || "")
          .join("")
          .replace(/^["'“”\s]+|["'“”\s]+$/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 400);
        if (!text || /^vuoto$/i.test(text)) continue;
        await logAsk(env, device, now);
        if (Math.random() < 0.02) {
          await env.DB.prepare(`DELETE FROM ask_log WHERE created_at < ?`).bind(now - 7 * 864e5).run();
        }
        return json({ ok: true, text });
      } catch {}
    }
  }
  return json({ error: "Non sono riuscito a trascrivere. Riprova o scrivi." }, 502);
}

/* ---------- chat di gruppo ---------- */

async function chatGate(env, eventId, device) {
  if (!device) return { ok: false };
  const ev = await env.DB.prepare(`SELECT device, owner_email FROM events WHERE id = ?`).bind(eventId).first();
  if (!ev) return { ok: false, missing: true };
  if (isMyEvent(ev, device, await viewerEmail(env, device))) return { ok: true, owner: true };
  const p = await env.DB.prepare(
    `SELECT status FROM participants WHERE event_id = ? AND device = ?`
  )
    .bind(eventId, device)
    .first();
  return { ok: Boolean(p && p.status === "going"), owner: false };
}

async function setTyping(env, id, request) {
  const body = await request.json().catch(() => null);
  if (!body) return bad("body");
  const device = text(body.device, 8, 64);
  if (!device) return bad("device");
  const gate = await chatGate(env, id, device);
  if (!gate.ok) return json({ error: "Solo chi partecipa può scrivere." }, 403);
  // il nome lo prende il server: quello giusto, non quello che il telefono dichiara
  const who = await env.DB.prepare(
    `SELECT p.name, l.first_name, e.host FROM participants p
     LEFT JOIN leads l ON l.device = p.device
     JOIN events e ON e.id = p.event_id
     WHERE p.event_id = ? AND p.device = ?`
  )
    .bind(id, device)
    .first();
  const host = gate.owner ? await env.DB.prepare(`SELECT host FROM events WHERE id = ?`).bind(id).first() : null;
  const name = text(who?.first_name || who?.name || host?.host || body.name, 1, 40) || "Qualcuno";
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO typing (event_id, device, name, at) VALUES (?, ?, ?, ?)
       ON CONFLICT(event_id, device) DO UPDATE SET name = excluded.name, at = excluded.at`
    ).bind(id, device, name, now),
    // chi si è fermato da un po' non risulta più
    env.DB.prepare(`DELETE FROM typing WHERE event_id = ? AND at < ?`).bind(id, now - 30 * 1000),
  ]);
  return json({ ok: true });
}

// quanti messaggi nuovi ci sono, evento per evento, per un dispositivo
async function unread(env, url) {
  const device = (url.searchParams.get("device") || "").slice(0, 64);
  if (!device) return json({ total: 0, events: {} });
  // Il segnalibro è l'ultimo messaggio letto (non un'ora): così il conto è esatto.
  // Chi arriva per la prima volta parte da adesso: la cronologia vecchia non conta.
  // attenzione: questa rotta la chiamano tutti, ogni pochi secondi.
  // Quindi scrive SOLO la prima volta che un telefono si presenta, mai più.
  if (telefonoProva(device)) return json({ ok: true, skip: true, unread: 0 });
  let mark = await env.DB.prepare(`SELECT msg_id FROM chat_read WHERE device = ? AND event_id = ''`).bind(device).first();
  if (!mark) {
    const top = await env.DB.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM messages`).first();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO chat_read (device, event_id, at, msg_id) VALUES (?, '', ?, ?)
         ON CONFLICT(device, event_id) DO NOTHING`
      ).bind(device, Date.now(), top?.m || 0),
      // segnalibri nati prima di questa versione: partono da adesso, non dalla preistoria
      env.DB.prepare(
        `UPDATE chat_read SET msg_id = (SELECT COALESCE(MAX(id), 0) FROM messages m WHERE m.event_id = chat_read.event_id)
          WHERE device = ? AND event_id <> '' AND msg_id = 0`
      ).bind(device),
    ]);
    mark = { msg_id: top?.m || 0 };
  }

  const { results } = await env.DB.prepare(
    `SELECT m.event_id AS id, COUNT(*) AS n
       FROM messages m
       JOIN participants p ON p.event_id = m.event_id AND p.device = ?1 AND p.status = 'going'
       LEFT JOIN chat_read r ON r.event_id = m.event_id AND r.device = ?1
      WHERE m.device <> ?1 AND m.id > MAX(COALESCE(r.msg_id, 0), ?2)
      GROUP BY m.event_id`
  )
    .bind(device, mark.msg_id || 0)
    .all();
  const events = {};
  let total = 0;
  for (const row of results || []) {
    events[row.id] = row.n;
    total += row.n;
  }
  return json({ total, events });
}

async function listMessages(env, id, url) {
  const device = (url.searchParams.get("device") || "").slice(0, 64);
  const since = Math.max(0, Number(url.searchParams.get("since")) || 0);
  const gate = await chatGate(env, id, device);
  if (!gate.ok) return json({ error: "Solo chi partecipa può leggere la chat.", locked: true }, 403);

  const alive = Date.now() - 5000; // chi ha scritto negli ultimi 5 secondi sta scrivendo
  const segnaLetto = url.searchParams.get("read") === "1" && Boolean(device);
  // le reazioni si chiedono solo per gli ultimi messaggi: il resto della chat è già vecchio
  const [msgs, members, typing, reacts] = await Promise.all([
    env.DB.prepare(
      `SELECT id, device, name, text, kind, media, created_at FROM messages
       WHERE event_id = ? AND id > ? ORDER BY id ASC LIMIT 80`
    )
      .bind(id, since)
      .all()
      .catch(() => ({ results: [] })),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM participants WHERE event_id = ? AND status = 'going'`)
      .bind(id)
      .first()
      .catch(() => null),
    env.DB.prepare(`SELECT name FROM typing WHERE event_id = ? AND device <> ? AND at > ? ORDER BY name ASC`)
      .bind(id, device, alive)
      .all()
      .catch(() => ({ results: [] })),
    env.DB.prepare(
      `SELECT r.msg_id AS m, r.emoji AS e, COUNT(*) AS n,
              SUM(CASE WHEN r.device = ? THEN 1 ELSE 0 END) AS mine
         FROM reactions r JOIN messages mm ON mm.id = r.msg_id
        WHERE mm.event_id = ? AND mm.id > (SELECT COALESCE(MAX(id), 0) - 300 FROM messages WHERE event_id = ?)
        GROUP BY r.msg_id, r.emoji`
    )
      .bind(device, id, id)
      .all()
      .catch(() => ({ results: [] })),
  ]);

  // se la chat è aperta davanti agli occhi, è tutto letto fino all'ultimo messaggio
  // (una sola scrittura, e solo quando serve: non a ogni giro di controllo)
  if (segnaLetto && !telefonoProva(device)) {
    await env.DB.prepare(
      `INSERT INTO chat_read (device, event_id, at, msg_id)
       SELECT ?, ?, ?, COALESCE(MAX(id), 0) FROM messages WHERE event_id = ?
       ON CONFLICT(device, event_id) DO UPDATE SET
         at = excluded.at,
         msg_id = CASE WHEN excluded.msg_id > chat_read.msg_id THEN excluded.msg_id ELSE chat_read.msg_id END`
    )
      .bind(device, id, Date.now(), id)
      .run()
      .catch(() => {});
  }

  return json({
    messages: (msgs.results || []).map((m) => ({
      id: m.id,
      name: m.name,
      text: m.text,
      kind: m.kind || "text",
      at: m.created_at,
      mine: m.device === device,
    })),
    reactions: (reacts.results || []).map((r) => ({ m: r.m, e: r.e, n: r.n, mine: Boolean(r.mine) })),
    members: (members?.n || 0) + 1,
    typing: (typing?.results || []).map((r) => r.name).filter(Boolean).slice(0, 4),
  });
}

// un emoji per messaggio: se rimetti lo stesso lo togli, se cambi lo sostituisci
async function reactTo(env, id, mid, request) {
  const body = await request.json().catch(() => null);
  const device = text(body?.device, 8, 64);
  if (!device) return bad("device");
  const gate = await chatGate(env, id, device);
  if (!gate.ok) return json({ error: "Solo chi partecipa può reagire.", locked: true }, 403);
  const emoji = String(body?.emoji || "");
  if (!REACTIONS.includes(emoji)) return bad("Reazione non valida.");
  const msg = await env.DB.prepare(`SELECT id FROM messages WHERE id = ? AND event_id = ?`).bind(Number(mid) || 0, id).first();
  if (!msg) return bad("Messaggio non trovato.");
  const had = await env.DB.prepare(`SELECT emoji FROM reactions WHERE msg_id = ? AND device = ?`).bind(msg.id, device).first();
  if (had && had.emoji === emoji) {
    await env.DB.prepare(`DELETE FROM reactions WHERE msg_id = ? AND device = ?`).bind(msg.id, device).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO reactions (msg_id, device, emoji, at) VALUES (?, ?, ?, ?)
       ON CONFLICT(msg_id, device) DO UPDATE SET emoji = excluded.emoji, at = excluded.at`
    )
      .bind(msg.id, device, emoji, Date.now())
      .run();
  }
  const { results } = await env.DB.prepare(
    `SELECT emoji AS e, COUNT(*) AS n, SUM(CASE WHEN device = ? THEN 1 ELSE 0 END) AS mine
       FROM reactions WHERE msg_id = ? GROUP BY emoji`
  )
    .bind(device, msg.id)
    .all();
  return json({ ok: true, msgId: msg.id, reactions: results || [] });
}

async function postMessage(env, id, request, origin, ctx) {
  const body = await request.json().catch(() => null);
  if (!body) return bad("body");
  const device = text(body.device, 8, 64);
  const gate = await chatGate(env, id, device || "");
  if (!gate.ok) return json({ error: "Solo chi partecipa può scrivere.", locked: true }, 403);

  const kind = body.kind === "sticker" ? "sticker" : "text";
  let msg = "";
  const media = null;
  if (kind === "sticker") {
    const s = String(body.sticker || "");
    if (!STICKERS.includes(s)) return bad("Figurina sconosciuta.");
    msg = s;
  } else {
    msg = text(body.text, 1, 500);
    if (!msg) return bad("Scrivi qualcosa.");
  }

  const now = Date.now();
  const last = await env.DB.prepare(
    `SELECT created_at FROM messages WHERE event_id = ? AND device = ? ORDER BY id DESC LIMIT 1`
  )
    .bind(id, device)
    .first();
  if (last && now - last.created_at < 1200) return json({ error: "Un attimo tra un messaggio e l'altro." }, 429);

  const person = await personFor(env, device);
  const name = text(body.name, 1, 40) || person?.first_name || "Ospite";

  const info = await env.DB.prepare(
    `INSERT INTO messages (event_id, device, name, text, kind, media, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, device, name, msg, kind, media, now)
    .run();
  await bump(env, "messages");

  // avviso a chi partecipa (tranne chi ha scritto), nel rispetto dei silenziamenti
  const ev = await env.DB.prepare(`SELECT title FROM events WHERE id = ?`).bind(id).first();
  const who = person?.first_name || name;
  await logActivity(env, "chat", who, String(ev?.title || "").slice(0, 60), id);
  const audience = await eventAudience(env, id, device);
  const job = notifyDevices(
    env,
    audience,
    id,
    {
      title: String(ev?.title || "Gruppo").slice(0, 60),
      body: `${who}: ${kind === "sticker" ? "ha mandato una figurina" : msg}`.slice(0, 160),
      url: `/?e=${id}`,
    },
    origin
  ).catch(() => 0);
  if (ctx?.waitUntil) ctx.waitUntil(job);
  else await job;

  return json({ ok: true, id: info.meta?.last_row_id || null });
}

/* ---------- chi è questa persona, per il giorno ---------- */
// Niente doppi conteggi: la chiave è il giorno + indirizzo + browser.
// Se la stessa persona ricarica, o reinstalla l'app dallo stesso telefono,
// resta una visita sola. Due persone diverse sullo stesso WiFi restano due,
// perché il browser (user agent) le distingue quasi sempre.
async function personKey(request, body) {
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "";
  const ua = request.headers.get("user-agent") || "";
  const dev = String(body?.device || "").slice(0, 60);
  // se so il dispositivo, quella è la persona: stesso telefono su WiFi o in 4G
  // resta una persona sola, anche a distanza di giorni
  const raw = dev.length >= 8 ? `dev|${dev}` : `${ip}|${ua}|${body?.tz || ""}`;
  const stable = await sha256hex(raw);
  const who = stable.slice(0, 24);
  return { who, device: dev, ip: ip.slice(0, 60) };
}

// quando entro col mio account, il telefono o il browser che sto usando
// diventa "mio": da quel momento non entra più nelle statistiche
async function markOwnerDevice(env, device) {
  const d = String(device || "").slice(0, 64);
  if (d.length < 8) return;
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO owner_dev (device, at) VALUES (?, ?)`).bind(d, Date.now()),
      env.DB.prepare(`DELETE FROM visits WHERE device = ?`).bind(d),
      env.DB.prepare(`DELETE FROM presence WHERE device = ?`).bind(d),
      env.DB.prepare(`DELETE FROM people WHERE who = ?`).bind((await sha256hex(`dev|${d}`)).slice(0, 24)),
    ]);
  } catch {}
}

// il padrone è chi ha i suoi telefoni registrati, oppure chi è entrato con la sua email
async function sonoPadrone(env, device) {
  if (await isOwnerDevice(env, device)) return true;
  try {
    const who = await viewerEmail(env, device);
    return Boolean(who && String(who).toLowerCase() === ownerEmail(env));
  } catch {
    return false;
  }
}

async function isOwnerDevice(env, device) {
  const d = String(device || "").slice(0, 64);
  if (d.length < 8) return false;
  try {
    const row = await env.DB.prepare(`SELECT 1 AS x FROM owner_dev WHERE device = ?`).bind(d).first();
    return Boolean(row);
  } catch {
    return false;
  }
}

// cosa toccano dentro l'app: un rigo per gesto, solo per gli occhi del padrone
async function notePeek(env, request) {
  const body = await request.json().catch(() => null);
  const device = text(body?.device ?? "", 6, 64) || "";
  if (!device) return json({ ok: false });
  if (telefonoProva(device)) return json({ ok: true, skip: true });
  if (await isOwnerDevice(env, device)) return json({ ok: true, skip: true });
  const items = Array.isArray(body?.items) ? body.items.slice(0, 12) : [];
  if (!items.length) return json({ ok: true });
  const now = Date.now();
  const rows = items
    .filter((x) => x && x.k)
    .map((x) =>
      env.DB.prepare(`INSERT INTO peek (device, kind, detail, at) VALUES (?, ?, ?, ?)`).bind(
        device,
        String(x.k).slice(0, 24),
        String(x.d ?? "").slice(0, 80),
        now
      )
    );
  try {
    await env.DB.batch(rows);
    // di tanto in tanto si fa pulizia: i tocchi vecchi non servono più
    if (Math.random() < 0.02) {
      await env.DB.prepare(`DELETE FROM peek WHERE at < ?`).bind(now - 14 * 864e5).run();
    }
  } catch {}
  return json({ ok: true });
}

async function trackHit(env, request) {
  return trackHitInner(env, request);
}

// le prove (i miei giri di controllo) non entrano nei numeri: arrivano con test=1
async function trackHitInner(env, request) {
  const body = (await request.json().catch(() => null)) || {};
  if (body.prova) return json({ ok: true, skip: true });
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const langTag = ["it", "en", "es", "pt"].includes(body.lang) ? body.lang : "";
  const screen = String(body.path || "home").slice(0, 40).replace(/[^a-z0-9_/\-]/gi, "");
  const { who, device } = await personKey(request, body);
  if (telefonoProva(device)) return json({ ok: true, skip: true });
  if (await isOwnerDevice(env, device)) return json({ ok: true, skip: true });
  const isApp = body.app ? 1 : 0;
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO visits (day, who, device, lang, first_at, last_at, views, screens)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(day, who) DO UPDATE SET
           last_at = excluded.last_at,
           views = views + 1,
           screens = CASE WHEN instr(screens, excluded.screens || ',') > 0 THEN screens ELSE screens || excluded.screens || ',' END`
      ).bind(day, who, device, langTag, now, now, screen + ","),
      env.DB.prepare(
        `INSERT INTO people (who, first_at, last_at, days, visits, is_app) VALUES (?, ?, ?, 1, 1, ?)
         ON CONFLICT(who) DO UPDATE SET last_at = excluded.last_at, visits = visits + 1, days = days + 1, is_app = MAX(is_app, excluded.is_app)`
      ).bind(who, now, now, isApp),
      // la vecchia tabella resta, per non perdere lo storico
      env.DB.prepare(
        `INSERT INTO hits (day, path, lang, count) VALUES (?, ?, ?, 1)
         ON CONFLICT(day, path, lang) DO UPDATE SET count = count + 1`
      ).bind(day, screen, langTag),
    ]);
  } catch {}
  return json({ ok: true });
}

async function trackFriction(env, request) {
  const body = (await request.json().catch(() => null)) || {};
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const kind = String(body.kind || "").slice(0, 30).replace(/[^a-z_]/gi, "");
  const detail = String(body.detail || "").slice(0, 60).replace(/[<>]/g, "");
  if (!kind) return json({ ok: false });
  try {
    await env.DB.prepare(
      `INSERT INTO friction (day, kind, detail, count) VALUES (?, ?, ?, 1)
       ON CONFLICT(day, kind, detail) DO UPDATE SET count = count + 1`
    ).bind(day, kind, detail).run();
  } catch {}
  return json({ ok: true });
}

async function noteDownload(env, request, url) {
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const qDevice = String(url?.searchParams?.get("d") || "").slice(0, 64);
  const { who, device } = await personKey(request, { device: qDevice });
  if (await isOwnerDevice(env, device)) return;
  // le prove non gonfiano il contatore degli scaricamenti
  if (/^(prova|test|demo)/i.test(device) || url?.searchParams?.get("test") === "1") return;
  try {
    // la chiave è il dispositivo: chi riscarica lo stesso APK non gonfia il numero
    if (body?.prova || body?.test) return json({ ok: true, skip: true });
    const key = device.length >= 8 ? `d:${device}` : `w:${who}`;
    const res = await env.DB.prepare(`INSERT OR IGNORE INTO dl_dev (device, at) VALUES (?, ?)`).bind(key, now).run();
    if (res.meta && res.meta.changes) {
      await env.DB.prepare(
        `INSERT INTO dlwho (day, who) VALUES (?, ?) ON CONFLICT(day, who) DO NOTHING`
      ).bind(day, key).run();
      await env.DB.prepare(
        `INSERT INTO dl (day, count) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET count = count + 1`
      ).bind(day).run();
      await logActivity(env, "download", "qualcuno", "Ha scaricato l'app", null);
    }
  } catch {}
}

/* ---------- assistente (Gemini) ---------- */

// 3.5-flash risponde in ~2s e parla un italiano naturale; il lite è la scorta veloce
const GEMINI_MODELS = ["gemini-3-flash-preview", "gemini-2.5-flash"];
// modelli sul binding AI di Cloudflare: funzionano senza altre chiavi
// mistral parla italiano molto meglio degli altri: è il primo della fila
const WORKERS_MODELS = ["@cf/mistralai/mistral-small-3.1-24b-instruct", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct-fast"];
const LANG_NAMES = { it: "italiano", en: "inglese", es: "spagnolo", pt: "portoghese" };

function askPrompt(lang, eventsBlock, nowIso, nowLocal = "", timeLocal = "", chiedeAiuto = false, sessoUtente = "") {
  const righe = [
    "Sei l'assistente di FUORI, l'app degli eventi tra persone a Catania e in Sicilia.",
    "Parli come un amico che conosce la città: semplice e diretto, una battuta leggera ogni tanto. Mai volgare, mai invadente.",
    "LUNGHEZZA: massimo due frasi e 35 parole. Prima la risposta, poi al massimo una domanda breve.",
    "Rispondi SOLO a quello che ti hanno chiesto. Se non hai capito, chiedi di ripetere in una riga: non inventare.",
    "Usa le parole esatte della persona: se dice padel non rispondere di pallavolo, se dice sushi non rispondere di pizza. Se una parola è ambigua o sembra trascritta male, chiedi conferma invece di indovinare.",
    "Non ripetere la domanda cambiandola: rispondi a quella, non a una simile che ti sembra più comoda.",
    "Se non hai un dato certo, dillo in una frase (non lo so, non ce l'ho qui) e proponi cosa si può fare nell'app.",
    "Non aprire con Ciao o Salve: entra nel discorso. Se ti chiedono come stai, rispondi di te con positività e chiedi come sta la persona.",
    "Scrivi come si parla: punteggiatura normale, niente elenchi, asterischi, titoli, emoji o parentesi. Gli orari sempre completi: 20:30, non 20.",
    "Se proponi un evento dì sempre titolo, cosa si fa, giorno, ora e zona. Scegli UN evento dall'elenco qui sotto e raccontalo con parole tue.",
    "L'elenco degli eventi serve a te: non copiarlo, non leggere titoli e orari in fila.",
    "Non inventare mai eventi, locali, indirizzi, prezzi, orari, persone o meteo. Se un dato non è nell'elenco, non c'è: dillo o fai una domanda.",
    "Se il meteo non è scritto qui sotto, non parlarne e non dare consigli su come vestirsi.",
    "Se ti chiedono cosa c'era o com'è andata, puoi usare gli eventi passati nell'elenco e dire quante persone sono andate.",
    "Ti fai un'idea della persona da quello che sai di lei nell'app (interessi, eventi a cui partecipa o che ha creato, zona, meteo) e adatti i consigli a lei: mai consigli uguali per tutti.",
    "Se vogliono solo chiacchierare, fagli compagnia: una frase tua e una domanda. Non tirare in mezzo gli eventi se non c'entrano.",
    "Se la persona è giù, prima una frase calda e breve, senza consigli e senza eventi; poi chiedi se vuole raccontarti.",
    "Dai sempre del tu. Non dire mai se sei maschio o femmina e non inventare ricordi o esperienze fatte insieme.",
    "Se chiedono come si usa FUORI, spiega in due righe: guarda gli eventi, tocca Partecipo, oppure crea il tuo con il +.",
    sessoUtente === "m"
      ? "Chi ti scrive è un uomo: parla di lui al maschile (sei stanco, sei contento)."
      : sessoUtente === "f"
        ? "Chi ti scrive è una donna: parla di lei al femminile (sei stanca, sei contenta)."
        : "Non sai se chi ti scrive è un uomo o una donna: usa frasi neutre.",
    "Non puoi iscrivere nessuno a un evento, non puoi creare eventi e non puoi invitare persone al posto loro: sono cose che fa la persona dall'app. Se te lo chiede, dillo in una frase semplice, per esempio «Devi toccare Partecipo tu: io non posso farlo per te», e spiegale dove sta il pulsante.",
    "Resti dentro FUORI: non apri altre app, mappe o collegamenti e non dai indicazioni stradali. Se serve, dì alla persona dove toccare nell'app.",
    "Non scrivere mai comandi, codice o JSON nel testo: la persona deve leggere solo frasi normali.",
    `Rispondi SEMPRE in ${LANG_NAMES[lang] || "italiano"}, anche se la domanda è in un'altra lingua.`,
    `Oggi a Catania è ${nowLocal} (Europe/Rome). Ora locale: ${timeLocal}.`,
    chiedeAiuto ? COME_FUNZIONA : "",
    eventsBlock,
  ];
  return righe.filter(Boolean).join("\n");
}

const COME_FUNZIONA =
  "Come funziona FUORI, in parole semplici: 1) apri l'app e guarda gli eventi qui vicino; 2) tocca un evento e leggi dove, quando e chi c'è; 3) tocca «Partecipo»: se serve, metti foto e selfie per farti riconoscere; 4) se non trovi niente, tocca il + e crea il tuo evento, scrivendo cosa, dove e quando. Dentro ogni evento c'è una chat per organizzarsi. Chi organizza può accettare o rifiutare le richieste. Se ti chiedono come si fa qualcosa, spiega questi passaggi con frasi corte, senza inventarne altri.";

// Prompt corto per i modelli di scorta: con troppe istruzioni si perdono pezzi
// e inventano frasi senza senso. Le regole qui sono poche e tutte importanti.
function askPromptSemplice(lang, eventsBlock, nowLocal, timeLocal, sessoUtente) {
  const righe = [
    "Sei l'assistente di FUORI, l'app di eventi tra persone a Catania e in Sicilia.",
    `Rispondi SEMPRE in ${LANG_NAMES[lang] || "italiano"}, con parole semplici e naturali, come un amico. Massimo due frasi e 35 parole.`,
    "Rispondi prima alla domanda. Se ti chiede come stai, rispondi con una frase positiva e chiedi come sta la persona: non usare frasi senza senso.",
    "Non cambiare le parole della persona (padel non è pallavolo, sushi non è pizza): se non capisci, chiedi in una riga.",
    "Se ti chiede cosa fare, scegli uno o due eventi veri dall'elenco e dì titolo, giorno, ora e zona. Se non c'è niente, dillo chiaramente e proponi una cosa semplice.",
    "Non inventare eventi, locali, orari o meteo. Se il meteo non è scritto nell'elenco, non parlarne e non dare consigli su vestiti, caldo o freddo.",
    "Non contraddirti e non fare domande strane. Fai una sola domanda semplice e pertinente. Niente elenchi, asterischi, titoli o emoji. Scrivi gli orari completi: 10:00, 16:00, 20:30, mai troncati.",
    "Dai del tu. Non dire se sei maschio o femmina e non inventare ricordi.",
    "Non puoi iscrivere, creare o invitare al posto della persona: dille che deve toccare lei il pulsante nell'app.",
    sessoUtente === "m"
      ? "Chi ti scrive è un uomo: parla di lui al maschile."
      : sessoUtente === "f"
        ? "Chi ti scrive è una donna: parla di lei al femminile."
        : "Non sai se chi ti scrive è un uomo o una donna: usa frasi neutre.",
    `Oggi è ${nowLocal}. Ora locale: ${timeLocal}.`,
    eventsBlock,
  ];
  return righe.join("\n");
}

/* ---------- quanto possiamo parlare: la quota gratuita è di casa, va divisa ---------- */
// Google, con la chiave gratuita, dà circa 20 richieste al giorno per modello di testo
// e 10 per modello di voce. Ne teniamo un po' da parte per gli altri.
// tetti giornalieri: adesso dietro c'è una fila di modelli (2 di Google + 3 di Cloudflare),
// quindi si può essere molto più generosi senza spendere niente
// tetti altissimi: servono solo a fermare gli abusi, non le persone che parlano
const TETTO = { testo: 5000, voce: 5000 };

function giornoRoma() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

async function quotaAI(env, device, tipo) {
  const day = giornoRoma();
  const tetto = TETTO[tipo] || 30;
  try {
    const [tot, attivi, mio] = await Promise.all([
      env.DB.prepare(`SELECT COALESCE(SUM(n), 0) AS n FROM ai_use WHERE day = ? AND tipo = ?`).bind(day, tipo).first(),
      env.DB.prepare(`SELECT COUNT(DISTINCT device) AS n FROM ai_use WHERE day >= ?`).bind(giornoRomaDi(new Date(Date.now() - 7 * 864e5))).first(),
      env.DB.prepare(`SELECT n FROM ai_use WHERE day = ? AND device = ? AND tipo = ?`).bind(day, device, tipo).first(),
    ]);
    if ((tot?.n || 0) >= tetto) {
      return {
        ok: false,
        messaggio:
          tipo === "voce"
            ? "Adesso ho la voce un attimo affaticata: riprova tra un minuto."
            : "Adesso ho la testa piena: ridimmi tra un minuto, che ci sono.",
      };
    }
    const persone = Math.max(1, attivi?.n || 1);
    const minimo = tipo === "voce" ? 2 : 3;
    const perPersona = Math.max(minimo, Math.min(tipo === "voce" ? 400 : 400, Math.floor(tetto / persone)));
    if ((mio?.n || 0) >= perPersona) {
      return {
        ok: false,
        messaggio:
          tipo === "voce"
            ? `Per oggi hai già usato la voce ${perPersona} volte: siamo in tanti e la quota è gratuita. Domani torna, o scrivimi che ti rispondo lo stesso.`
            : `Per oggi ci siamo detti tutto (${perPersona} domande): la quota gratuita è condivisa, domani si riapre. Intanto dai un'occhiata agli eventi.`,
      };
    }
    if (!telefonoProva(device)) {
      await env.DB.prepare(
        `INSERT INTO ai_use (day, device, tipo, n) VALUES (?, ?, ?, 1)
         ON CONFLICT(day, device, tipo) DO UPDATE SET n = n + 1`
      ).bind(day, device, tipo).run();
    }
    return { ok: true, perPersona, restanti: Math.max(0, perPersona - ((mio?.n || 0) + 1)) };
  } catch {
    return { ok: true };
  }
}

function giornoRomaDi(d) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

// qualche volta il modello raddoppia una sillaba ("un albebero"): la rimetto a posto.
// Le parole che hanno davvero una doppia di fila restano come sono.
const FRASI_STORTE = [
  [/\bun albebero\b/gi, "un albero"],
  [/\balbebero\b/gi, "albero"],
  [/\balberbero\b/gi, "albero"],
  [/\bmetti comodo\b/gi, "mettiti comodo"],
  [/\bmetti tranquill([oa])\b/gi, "mettiti tranquill$1"],
  [/\bmetti a posto\b/gi, "mettiti a posto"],
  [/\bmetti seduto\b/gi, "mettiti seduto"],
  [/\bci mettiamo comodi\b/gi, "ci mettiamo comodi"],
  [/\b(niente|nulla|qualcosa) di in programma\b/gi, "$1 in programma"],
];

// solo i refusi che ho visto davvero: una regola generica sulle sillabe
// raddoppiate rovinava parole giuste ("mettiti" diventava "metti")
function paroleGiuste(t) {
  let s = String(t || "");
  for (const [cerca, metti] of FRASI_STORTE) s = s.replace(cerca, metti);
  return s;
}

// una frase che comincia con "cosa", "ti va di", "vuoi" è una domanda anche
// senza punto interrogativo: senza, la voce la legge come un'affermazione
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

// una risposta scritta bene si sente anche ad alta voce: maiuscola e punto finale
function rifinisci(t) {
  let s = domandeGiuste(paroleGiuste(String(t || "").replace(/\n?\s*AZIONE\s*[=:]?\s*\{[\s\S]*$/i, "").replace(/\n?\s*AZIONE\s*[=:]?\s*$/im, "").trim()));
  if (!s) return s;
  s = s.replace(/\s+/g, " ").replace(/\s+([,.!?;:])/g, "$1");
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (!/[.!?…"]$/.test(s)) s += ".";
  return s;
}

// se il meteo non c'è, il modello di scorta a volte inventa consigli sul vestiario.
// Meglio togliere quella frase che lasciare uscire una cosa senza senso.
function pulisciMeteo(testo, haMeteo) {
  if (haMeteo) return testo;
  const senza = String(testo || "")
    .replace(/[^.?!]*(?:portare un po' di caldo|porta un po' di caldo|vestirti|indossare|mettiti|copriti|bevanda calda)[^.?!]*[.?!]?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return senza || "Non so che tempo farà, quindi non posso consigliarti come vestirti.";
}

/* ---------- l'assistente che fa le cose al posto tuo ---------- */

// quanto è avanti (o indietro) l'Italia in quel momento
function offsetRoma(ts) {
  const nome = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Rome", timeZoneName: "longOffset" }).format(new Date(ts));
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(nome);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 3600 + Number(m[3]) * 60) * 1000;
}

// "2026-11-20" + "20:30" scritti in ora italiana diventano millisecondi
function tsRoma(giorno, ora) {
  const g = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(giorno || "").trim());
  if (!g) return null;
  const o = /^(\d{1,2})[.:](\d{2})$/.exec(String(ora || "").trim());
  const hh = o ? Number(o[1]) : 20;
  const mm = o ? Number(o[2]) : 0;
  if (hh > 23 || mm > 59) return null;
  const base = Date.UTC(Number(g[1]), Number(g[2]) - 1, Number(g[3]), hh, mm);
  return base - offsetRoma(base);
}

function categoriaDa(nome) {
  const s = String(nome || "").toLowerCase().trim();
  return CATEGORIES.find((c) => c === s) || CATEGORIES.find((c) => s.includes(c)) || "Altro";
}

async function azioneAI(env, request, origin) {
  const body = await request.json().catch(() => null);
  if (!body) return bad("body");
  const device = text(body.device, 8, 64);
  const a = body.azione && typeof body.azione === "object" ? body.azione : null;
  if (!device || !a) return bad("azione");
  const person = await personFor(env, device);
  if (!person) return json({ error: "Prima entra nella lista: serve un attimo." }, 403);
  const tipo = String(a.tipo || "").toLowerCase();

  if (tipo === "crea_evento") {
    let startsAt = tsRoma(a.giorno, a.ora);
    // capita che il modello scriva un anno vecchio: se è nel passato lo porto all'anno giusto
    if (startsAt && startsAt < Date.now() - 3600000) {
      const g = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(a.giorno || "").trim());
      if (g) {
        for (let anno = Number(g[1]) + 1; anno <= Number(g[1]) + 3; anno++) {
          const prova = tsRoma(`${anno}-${g[2]}-${g[3]}`, a.ora);
          if (prova && prova > Date.now() - 3600000) { startsAt = prova; break; }
        }
      }
    }
    if (!startsAt) return json({ error: "Mi manca il giorno giusto: dimmi la data e l'ora." });
    const titolo = text(a.titolo, 3, 80);
    const posto = text(a.posto, 2, 80);
    if (!titolo || !posto) return json({ error: "Mi mancano il titolo o il posto: dimmeli e lo creo subito." });
    const accesso = ["photo", "verified", "invite"].includes(String(a.accesso || "")) ? String(a.accesso) : "verified";
    const corpo = {
      title: titolo,
      place: posto,
      city: text(a.citta ?? CITY, 2, 40) || CITY,
      host: text(person.first_name || "Ospite", 2, 40),
      description: String(a.descrizione || "").slice(0, 500),
      category: categoriaDa(a.categoria),
      activity: text(a.attivita ?? a.categoria ?? "", 0, 40) || "",
      startsAt,
      capacity: Math.round(Number(a.posti) || 20),
      device,
      access: accesso,
      approval: Boolean(a.approva),
    };
    const finta = new Request("https://fuori.local/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(corpo),
    });
    const r = await createEvent(env, finta, origin, null);
    const data = await r.json().catch(() => null);
    if (!data?.id) return json({ error: String(data?.error || "Non sono riuscito a crearlo.") });
    const quando = new Intl.DateTimeFormat("it-IT", {
      timeZone: "Europe/Rome", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
    }).format(new Date(startsAt));
    return json({
      ok: true,
      evento: { id: data.id, title: titolo, url: `${origin}/e/${data.id}` },
      fatto: `Fatto: ho creato «${titolo}» per ${quando}, a ${posto}.`,
    });
  }

  if (tipo === "invita") {
    const titoli = Array.isArray(a.eventi)
      ? a.eventi.map((x) => String(x || "").toLowerCase().trim()).filter(Boolean).slice(0, 8)
      : [];
    const padrone = await sonoPadrone(env, device);
    const { results } = await env.DB.prepare(
      `SELECT id, title, category, invite_code, access, starts_at FROM events WHERE starts_at >= ? AND (device = ?${padrone ? " OR 1 = 1" : ""}) ORDER BY starts_at LIMIT 60`
    )
      .bind(Date.now() - 3600000, device)
      .all();
    let scelti = results || [];
    if (titoli.length) {
      scelti = scelti.filter((e) => {
        const t = String(e.title || "").toLowerCase();
        return titoli.some((x) => t.includes(x) || x.includes(t));
      });
    }
    if (!scelti.length) return json({ error: "Non trovo eventi tuoi da invitare: dimmi il titolo giusto, o crealo prima." });

    // chi invito: tutti, chi ha i miei interessi, o le persone che nomina
    const chi = a.chi;
    let devices = [];
    if (Array.isArray(chi) && chi.length) {
      for (const k of chi.map((x) => String(x || "").trim().toLowerCase()).filter(Boolean).slice(0, 60)) {
        const { results: trovati } = await env.DB.prepare(
          `SELECT device FROM leads WHERE length(device) >= 8
             AND (lower(email) = ? OR lower(first_name) = ?
                  OR lower(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) = ?)`
        )
          .bind(k, k, k)
          .all();
        for (const r of trovati || []) if (r.device) devices.push(r.device);
      }
    } else if (String(chi || "").toLowerCase() === "interessi") {
      let miei = [];
      try { miei = JSON.parse(person.interests || "[]").map((x) => String(x).toLowerCase()); } catch {}
      if (!miei.length) miei = scelti.map((e) => String(e.category || "").toLowerCase()).filter(Boolean);
      const { results: gente } = await env.DB.prepare(
        `SELECT device, interests FROM leads WHERE device <> ? AND length(device) >= 8`
      )
        .bind(device)
        .all();
      for (const r of gente || []) {
        let suoi = [];
        try { suoi = JSON.parse(r.interests || "[]").map((x) => String(x).toLowerCase()); } catch {}
        if (miei.length && suoi.some((x) => miei.includes(x))) devices.push(r.device);
      }
    } else {
      const { results: gente } = await env.DB.prepare(
        `SELECT device FROM leads WHERE device <> ? AND length(device) >= 8`
      )
        .bind(device)
        .all();
      devices = (gente || []).map((r) => r.device).filter(Boolean);
    }
    devices = [...new Set(devices)].filter((d) => d && d !== device).slice(0, 300);
    if (!devices.length) return json({ error: "Non ho trovato nessuno da invitare con quel criterio." });

    for (const ev of scelti) {
      const link = `${origin}/e/${ev.id}${ev.invite_code ? "?i=" + ev.invite_code : ""}`;
      await notifyDevices(
        env,
        devices,
        ev.id,
        { title: "Invito", body: `${person.first_name || "Qualcuno"} ti invita a «${ev.title}»`, url: link },
        origin
      ).catch(() => 0);
    }
    const nomi = scelti.map((e) => `«${e.title}»`).join(", ");
    return json({ ok: true, fatto: `Ho invitato ${devices.length} ${devices.length === 1 ? "persona" : "persone"} a ${nomi}.` });
  }

  // l'iscrizione non la faccio io: toccare Partecipo è un gesto della persona,
  // con i suoi controlli (foto, viso, età, posti, invito). Qui rispondo e basta.
  if (tipo === "iscrivi") {
    return json({
      ok: false,
      error: "L'iscrizione devi farla tu: apri l'evento e tocca «Partecipo». Io non posso premere quei pulsanti al posto tuo.",
    });
  }

  // navigatore: il client apre Google o Apple Maps con il percorso verso l'evento
  if (tipo === "naviga") {
    const titolo = String(a.evento || "").toLowerCase().trim();
    if (!titolo) return json({ error: "Dimmi a quale evento vuoi andare." });
    const { results } = await env.DB.prepare(
      `SELECT id, title, place, city, lat, lng FROM events WHERE starts_at >= ? ORDER BY starts_at LIMIT 200`
    )
      .bind(Date.now() - 3600000)
      .all();
    const trovato = (results || []).find((e) => {
      const t = String(e.title || "").toLowerCase();
      return t === titolo || t.includes(titolo) || titolo.includes(t);
    });
    if (!trovato) return json({ error: "Non trovo un evento con questo nome. Dimmi il titolo esatto." });
    return json({
      ok: true,
      percorso: { titolo: trovato.title, place: trovato.place, city: trovato.city || CITY, lat: trovato.lat, lng: trovato.lng },
      fatto: `Ecco il percorso per «${trovato.title}».`,
    });
  }

  return json({ error: "Questa cosa non la so fare." });
}

const askCache = new Map();

/* ---------- assistente: la risposta arriva parola per parola ---------- */
// un flusso che parte dal primo pezzo già letto e poi continua da solo
function sseDaTesto(testo) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: testo }], role: "model" }, index: 0 }] })}\n\n`));
      c.close();
    },
  });
}

function flussoDaPrimo(p) {
  return new ReadableStream({
    start(c) { c.enqueue(p.primo); },
    async pull(c) {
      try {
        const { done, value } = await p.lettore.read();
        if (done) c.close();
        else c.enqueue(value);
      } catch { try { c.close(); } catch {} }
    },
    cancel() { try { p.lettore.cancel(); } catch {} },
  });
}

// i modelli Cloudflare parlano un formato diverso: lo traduco in quello che
// il telefono sa già leggere, così il testo compare comunque parola per parola
function geminiDaWorkers(p) {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = "";
  const emetti = (c, testo) => {
    if (!testo) return;
    c.enqueue(enc.encode(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: testo }], role: "model" }, index: 0 }] })}\n\n`));
  };
  const mangia = (c, byte) => {
    buf += dec.decode(byte, { stream: true });
    const righe = buf.split("\n");
    buf = righe.pop() || "";
    for (const riga of righe) {
      const t = riga.trim();
      if (!t.startsWith("data:")) continue;
      const d = t.slice(5).trim();
      if (!d || d === "[DONE]") continue;
      try {
        const j = JSON.parse(d);
        emetti(c, j.response ?? j.choices?.[0]?.delta?.content ?? "");
      } catch {}
    }
  };
  return flussoDaPrimo(p).pipeThrough(new TransformStream({
    transform(chunk, controller) { mangia(controller, chunk); },
    flush(controller) { mangia(controller, enc.encode("\n")); },
  }));
}

async function primoGemini(env, payload, signal) {
  try {
    let r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:streamGenerateContent?alt=sse&key=${env.GEMINI_KEY}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal }
    );
    if (r.status === 400) {
      const corpo = { ...payload, generationConfig: { ...payload.generationConfig, thinkingConfig: undefined } };
      r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:streamGenerateContent?alt=sse&key=${env.GEMINI_KEY}`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo), signal }
      );
    }
    if (!(r.ok && r.body)) return null;
    const lettore = r.body.getReader();
    const { value, done } = await lettore.read();
    if (done || !value) return null;
    return { tipo: "gemini", lettore, primo: value };
  } catch { return null; }
}

// I modelli di scorta rispondono tutti insieme: in streaming perdevano pezzi
// (per esempio "10:00" diventava "1:") e inventavano frasi strane.
// Così il testo è completo e passa dal controllo finale prima di arrivare all'app.
async function primoWorkers(env, messaggi, haMeteo = false) {
  for (const modello of WORKERS_MODELS) {
    try {
      const out = await env.AI.run(modello, { messages: messaggi, max_tokens: 400, temperature: 0.5 });
      const testo = pulisciMeteo(rifinisci(String(out?.response || "").trim()), haMeteo);
      if (testo.length < 2) continue;
      return { tipo: "workers", testo, modello };
    } catch {}
  }
  return null;
}

async function askGeminiStream(env, request) {
  const body = await request.json().catch(() => null);
  if (!body) return bad("body");
  const question = String(body.text || "").replace(/\s+/g, " ").trim().slice(0, 400);
  if (question.length < 2) return bad("Scrivi una domanda.");

  // senza chiave Google si torna alla risposta normale, tutta insieme
  if (!env.GEMINI_KEY) {
    const copia = new Request(request.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return askGemini(env, copia);
  }

  const lang = ["it", "en", "es", "pt"].includes(body.lang) ? body.lang : "it";
  const device = String(body.device || "").slice(0, 64);
  const now = Date.now();
  const cacheKey = lang + "|" + question.toLowerCase();

  const hit = askCache.get(cacheKey);
  if (hit && now - hit.at < 10 * 60 * 1000) {
    return new Response(hit.answer, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }

  // prima di parlare: quanto ci resta oggi?
  // la quota non interrompe la conversazione: se Google è a secco rispondono i modelli di Cloudflare
  // le tre cose che servono prima di chiamare il modello le faccio insieme, non una dopo
  // l'altra: si risparmiano un paio di giri e la prima parola arriva prima
  // eventi, quota, conteggio, sesso e blocco partono insieme: la prima parola
  // non aspetta una query dopo l'altra
  const prontiP = eventiAI(env, now);
  const [, recent, , io, blocco] = await Promise.all([
    quotaAI(env, device, "testo"),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM ask_log WHERE device = ? AND created_at > ?`)
      .bind(device, now - 3600 * 1000)
      .first(),
    prontiP,
    env.DB.prepare(`SELECT sex FROM leads WHERE device = ? ORDER BY created_at DESC LIMIT 1`)
      .bind(device)
      .first()
      .catch(() => null),
    bloccoAI(env, now, body, prontiP),
  ]);
  const sessoUtente = io?.sex === "m" || io?.sex === "f" ? io.sex : "";
  if ((recent?.n || 0) > 40) return json({ error: "Troppe domande di fila. Riprova tra un po'." }, 429);

  const fmt = new Intl.DateTimeFormat("it-IT", {
    timeZone: "Europe/Rome", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
  const nowLocal = new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(now));
  const timeLocal = new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" }).format(new Date(now));

  const chiedeAiuto = /come\s+(si\s+)?(fa|faccio|funziona|creo|partecipo|mi\s+iscrivo)|iscri|registr|verific|foto|profilo|account|invito/i.test(question);
  const systemText = askPrompt(lang, blocco, new Date(now).toISOString(), nowLocal, timeLocal, chiedeAiuto, sessoUtente);

  const storia = Array.isArray(body.history) ? body.history.slice(-10) : [];
  const contents = [];
  for (const turn of storia) {
    const txt = String(turn?.text || "").slice(0, 800);
    if (!txt) continue;
    contents.push({ role: turn.role === "bot" ? "model" : "user", parts: [{ text: txt }] });
  }
  contents.push({ role: "user", parts: [{ text: question }] });

  const payload = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents,
    // senza questi permessi il modello a volte si blocca da solo a metà frase ("Certo" e basta)
    safetySettings: SICUREZZA,
    generationConfig: { temperature: 0.8, maxOutputTokens: 260, topP: 0.95, thinkingConfig: { thinkingBudget: 0 } },
  };

  // Google parte subito; se dopo 1,2 secondi non ha ancora detto la prima parola,
  // entra anche un modello Cloudflare. Vince chi parla per primo: la risposta
  // non resta mai ferma quattro o cinque secondi.
  const messaggi = [{ role: "system", content: askPromptSemplice(lang, blocco, nowLocal, timeLocal, sessoUtente) }];
  for (const turn of storia) {
    const txt = String(turn?.text || "").slice(0, 800);
    if (!txt) continue;
    messaggi.push({ role: turn.role === "bot" ? "assistant" : "user", content: txt });
  }
  messaggi.push({ role: "user", content: question });

  const ac = new AbortController();
  let finito = false;
  const gemP = primoGemini(env, payload, ac.signal).then((x) => { if (x) finito = true; return x; });
  let workersP = null;
  const wP = new Promise((res) => {
    // Gemini ha un italiano migliore: gli lasciamo tre secondi di vantaggio.
    // I modelli Cloudflare restano la scorta se Google non risponde in tempo.
    setTimeout(async () => {
      if (finito) return res(null);
      workersP = primoWorkers(env, messaggi, blocco.includes("Meteo adesso"));
      res(await workersP);
    }, 3000);
  });
  const valido = (p) => p.then((x) => (x ? x : Promise.reject(new Error("vuoto"))));
  const vinto = await Promise.any([
    valido(gemP),
    valido(wP),
    new Promise((_, no) => setTimeout(() => no(new Error("tempo")), 8500)),
  ]).catch(() => null);

  if (vinto?.tipo === "workers") {
    try { ac.abort(); } catch {}
  } else if (vinto?.tipo === "gemini" && workersP) {
    workersP.then((x) => { if (x && x !== vinto) { try { x.lettore.cancel(); } catch {} } }).catch(() => {});
  }

  if (vinto) {
    await logAsk(env, device, now);
    const corpo = vinto.tipo === "gemini" ? flussoDaPrimo(vinto) : sseDaTesto(vinto.testo);
    return new Response(corpo, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
        "x-fuori-engine": vinto.tipo,
        "x-fuori-model": vinto.modello || "",
      },
    });
  }

  // né Google né Cloudflare hanno risposto in tempo: ultimo tentativo, tutto insieme
  for (const modello of WORKERS_MODELS) {
    try {
      const out = await Promise.race([
        env.AI.run(modello, { messages: messaggi, max_tokens: 400, temperature: 0.5 }),
        new Promise((r) => setTimeout(() => r(null), 5000)),
      ]);
      if (!out) continue;
      const testo = String(out?.response || "").trim();
      if (!testo) continue;
      if (askCache.size > 300) askCache.clear();
      const pulito = pulisciMeteo(rifinisci(testo), blocco.includes("Meteo adesso"));
      askCache.set(cacheKey, { answer: pulito.slice(0, 1200), at: Date.now() });
      return new Response(pulito, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    } catch {}
  }
  return json({ error: "assistente occupato" }, 503);
}

async function askGemini(env, request) {
  const body = await request.json().catch(() => null);
  if (!body) return bad("body");
  const question = String(body.text || "").replace(/\s+/g, " ").trim().slice(0, 400);
  if (question.length < 2) return bad("Scrivi una domanda.");
  if (!env.GEMINI_KEY && !env.AI) return json({ error: "assistente non configurato" }, 503);

  const lang = ["it", "en", "es", "pt"].includes(body.lang) ? body.lang : "it";
  const device = String(body.device || "").slice(0, 64);
  const now = Date.now();

  const cacheKey = lang + "|" + question.toLowerCase();
  const hit = askCache.get(cacheKey);
  if (hit && now - hit.at < 10 * 60 * 1000) return json({ ok: true, answer: hit.answer, cached: true });

  // la quota non ferma più la conversazione: se Google ha finito, rispondono i modelli di Cloudflare
  await quotaAI(env, device, "testo");

  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ask_log WHERE device = ? AND created_at > ?`
  )
    .bind(device, now - 3600 * 1000)
    .first();
  if ((recent?.n || 0) > 40) return json({ error: "Troppe domande di fila. Riprova tra un po'." }, 429);

  const results = await eventiAI(env, now);

  const fmt = new Intl.DateTimeFormat("it-IT", {
    timeZone: "Europe/Rome", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
  const nowLocal = new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(now));
  const timeLocal = new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" }).format(new Date(now));
  const blocco = await bloccoAI(env, now, body);
  const chiedeAiuto = /come\s+(si\s+)?(fa|faccio|funziona|creo|partecipo|mi\s+iscrivo)|iscri|registr|verific|foto|profilo|account|invito/i.test(question);
  const io = await env.DB.prepare(`SELECT sex FROM leads WHERE device = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(device)
    .first()
    .catch(() => null);
  const sessoUtente = io?.sex === "m" || io?.sex === "f" ? io.sex : "";
  const systemText = askPrompt(lang, blocco, new Date(now).toISOString(), nowLocal, timeLocal, chiedeAiuto, sessoUtente);

  const storia = Array.isArray(body.history) ? body.history.slice(-10) : [];
  // se c'è la chiave Google, il cervello è Gemini: meglio di tutto il resto
  if (env.AI && !env.GEMINI_KEY) {
    const messaggi = [{ role: "system", content: askPromptSemplice(lang, blocco, nowLocal, timeLocal, sessoUtente) }];
    for (const turn of storia) {
      const txt = String(turn?.text || "").slice(0, 800);
      if (txt) messaggi.push({ role: turn.role === "bot" ? "assistant" : "user", content: txt });
    }
    messaggi.push({ role: "user", content: question });
    const scelti = /^@cf\/[\w./-]+$/.test(String(body.model || "")) ? [String(body.model), ...WORKERS_MODELS] : WORKERS_MODELS;
    for (const model of scelti) {
      try {
        const out = await env.AI.run(model, { messages: messaggi, max_tokens: 480, temperature: 0.8 });
        const answer = String(out?.response || "").replace(/^\s*assistente\s*:\s*/i, "").trim();
        if (!answer) continue;
        if (askCache.size > 300) askCache.clear();
        askCache.set(cacheKey, { answer, at: Date.now() });
        await logAsk(env, device, now);
        return json({ answer: pulisciMeteo(rifinisci(answer), blocco.includes("Meteo adesso")).slice(0, 1200) });
      } catch {}
    }
  }

  const contents = [];
  const history = storia;
  for (const turn of history) {
    const txt = String(turn?.text || "").slice(0, 800);
    if (!txt) continue;
    contents.push({ role: turn.role === "bot" ? "model" : "user", parts: [{ text: txt }] });
  }
  contents.push({ role: "user", parts: [{ text: question }] });

  const payload = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents,
    // niente "ragionamento" lungo: qui serve una risposta pronta, non un saggio
    // senza questi permessi il modello a volte si blocca da solo a metà frase ("Certo" e basta)
    safetySettings: SICUREZZA,
    generationConfig: { temperature: 0.8, maxOutputTokens: 260, topP: 0.95, thinkingConfig: { thinkingBudget: 0 } },
  };

  const inizio = Date.now();
  for (let attempt = 0; attempt < 2; attempt++) {
  for (const model of GEMINI_MODELS) {
    if (Date.now() - inizio > 22000) break;
    try {
      let res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_KEY}`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000) }
      );
      if (res.status === 400) {
        const corpo = { ...payload, generationConfig: { ...payload.generationConfig, thinkingConfig: undefined } };
        res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_KEY}`,
          { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo), signal: AbortSignal.timeout(8000) }
        );
      }
      if (!res.ok) continue;
      const data = await res.json();
      const answer = (data.candidates?.[0]?.content?.parts || [])
        .map((p) => p.text || "")
        .join("")
        .trim();
      const tagliata = data.candidates?.[0]?.finishReason === "SAFETY";
      if (!answer || (tagliata && answer.length < 60)) continue;
      if (askCache.size > 300) askCache.clear();
      askCache.set(cacheKey, { answer, at: Date.now() });
      await logAsk(env, device, now);
      if (Math.random() < 0.02) {
        await env.DB.prepare(`DELETE FROM ask_log WHERE created_at < ?`).bind(now - 7 * 864e5).run();
      }
      return json({ answer: rifinisci(answer).slice(0, 1200) });
    } catch {}
  }
  if (attempt === 0) await new Promise((r) => setTimeout(r, 350));
  }
  return json({ error: "assistente occupato" }, 503);
}

function b64DiBytes(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return btoa(s);
}

// PCM grezzo (16 bit, mono) dentro un file WAV che il telefono sa suonare
// toglie il silenzio ai bordi e ammorbidisce l'attacco: è quello che faceva "tac" e "clac"
function senzaStacchi(pcm, rate) {
  const campioni = Math.floor(pcm.length / 2);
  if (campioni < rate * 0.05) return pcm;
  const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const soglia = 200;
  let inizio = 0;
  let fine = campioni - 1;
  while (inizio < campioni && Math.abs(dv.getInt16(inizio * 2, true)) < soglia) inizio++;
  while (fine > inizio && Math.abs(dv.getInt16(fine * 2, true)) < soglia) fine--;
  if (fine <= inizio) return pcm;
  inizio = Math.max(0, inizio - Math.floor(rate * 0.02));
  fine = Math.min(campioni - 1, fine + Math.floor(rate * 0.04));
  const n = fine - inizio + 1;
  const out = pcm.slice(inizio * 2, (inizio + n) * 2);
  const ov = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const salita = Math.min(Math.floor(rate * 0.01), Math.floor(n / 4));
  const discesa = Math.min(Math.floor(rate * 0.015), Math.floor(n / 4));
  for (let i = 0; i < salita; i++) ov.setInt16(i * 2, Math.round(ov.getInt16(i * 2, true) * (i / salita)), true);
  for (let i = 0; i < discesa; i++) {
    const j = n - 1 - i;
    ov.setInt16(j * 2, Math.round(ov.getInt16(j * 2, true) * (i / discesa)), true);
  }
  return out;
}

function wavDaPcm(pcm, rate) {
  const out = new Uint8Array(44 + pcm.length);
  const dv = new DataView(out.buffer);
  const scrivi = (off, str) => { for (let i = 0; i < str.length; i++) out[off + i] = str.charCodeAt(i); };
  scrivi(0, "RIFF"); dv.setUint32(4, 36 + pcm.length, true); scrivi(8, "WAVE");
  scrivi(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true); dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  scrivi(36, "data"); dv.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

// la voce con cui FUORI risponde: naturale, non quella del telefono
const LINGUA_VOCE = { it: "it", en: "en", es: "es", pt: "pt-PT" };

// Voce Google "da traduzione": italiana, naturale, senza quota e velocissima (circa due decimi di secondo).
// Regge fino a 200 caratteri per richiesta: il client manda pezzi corti.
// Google mette pause lunghe dopo il punto e dopo ogni a capo: per la voce
// trasformo i punti in virgole (pausa corta) e tengo il punto solo alla fine.
function testoPerLettura(raw) {
  let s = String(raw || "").replace(/\s+/g, " ").trim();
  // tengo punti, punti interrogativi ed esclamativi: Google li usa per le pause
  // e per l'intonazione (una domanda deve salire, non suonare come un'affermazione)
  s = s.replace(/…+/g, ".");
  s = s.replace(/\.{2,}/g, ".");
  s = s.replace(/\s*([,;!?])\s*/g, "$1 ");
  // lo spazio dopo i due punti e dopo il punto va messo solo quando separa le
  // parole: dentro un orario (20:00) o un numero (3.5) resta tutto attaccato
  s = s.replace(/\s*:\s*/g, (m, off, str) => {
    const a = str[off - 1] || "", b = str[off + m.length] || "";
    return /\d/.test(a) && /\d/.test(b) ? ":" : ": ";
  });
  s = s.replace(/\s*\.\s*/g, (m, off, str) => {
    const a = str[off - 1] || "", b = str[off + m.length] || "";
    return /\d/.test(a) && /\d/.test(b) ? "." : ". ";
  });
  // "alle20:00" -> "alle 20:00": la voce deve staccare l'ora dalla parola
  s = s.replace(/([a-zà-ù])(\d{1,2}[:.]\d{2})/gi, "$1 $2");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

// Google regge al massimo ~200 caratteri per richiesta: un testo più lungo va
// spezzato, ma i pezzi li unisco QUI in un audio solo, così il telefono non ha
// buchi né pause tra una parte e l'altra.
function spezzaLettura(s, max = 195) {
  const out = [];
  let cur = "";
  for (const parola of String(s || "").split(" ")) {
    if (!parola) continue;
    if (!cur) { cur = parola; continue; }
    if ((cur + " " + parola).length > max) { out.push(cur); cur = parola; }
    else cur += " " + parola;
  }
  if (cur) out.push(cur);
  return out;
}

async function voceGoogleUno(testo, lang) {
  const pulito = String(testo || "").trim().slice(0, 200);
  if (pulito.length < 2) return null;
  const tl = LINGUA_VOCE[lang] || "it";
  const coda = `ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(tl)}&q=${encodeURIComponent(pulito)}`;
  for (const host of ["translate.googleapis.com", "translate.google.com"]) {
    try {
      const r = await fetch(`https://${host}/translate_tts?${coda}`, {
        headers: { "user-agent": "Mozilla/5.0 (Linux; Android 14) Chrome/122", referer: "https://translate.google.com/" },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) continue;
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf.length < 1500) continue;
      return { b64: b64DiBytes(buf), bytes: buf, mime: "audio/mpeg" };
    } catch {}
  }
  return null;
}

async function voceGoogle(testo, lang) {
  const pulito = testoPerLettura(testo).slice(0, 1180);
  if (pulito.length < 2) return null;
  const pezzi = spezzaLettura(pulito, 195);
  const parti = [];
  for (const pezzo of pezzi) {
    const uno = await voceGoogleUno(pezzo, lang);
    if (!uno) break;
    parti.push(uno);
  }
  if (!parti.length) return null;
  if (parti.length === 1) return parti[0];
  let tot = 0;
  for (const p of parti) tot += p.bytes ? p.bytes.length : 0;
  if (!tot) return parti[0];
  const buf = new Uint8Array(tot);
  let off = 0;
  for (const p of parti) { buf.set(p.bytes, off); off += p.bytes.length; }
  return { b64: b64DiBytes(buf), mime: "audio/mpeg" };
}

const SICUREZZA = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
];

const VOCE_MODELLI = ["gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts"];
const voceStop = new Map();
let voceGiro = 0;

async function speakText(env, request) {
  const body = await request.json().catch(() => null);
  if (!body) return bad("body");
  if (!env.GEMINI_KEY && !env.AI) return json({ error: "voce non configurata" }, 503);
  const testo = String(body.text || "").replace(/\s+/g, " ").trim().slice(0, 1200);
  if (testo.length < 2) return bad("Testo vuoto.");
  const lang = ["it", "en", "es", "pt"].includes(body.lang) ? body.lang : "it";
  const device = String(body.device || "").slice(0, 64);
  const now = Date.now();
  const recent = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ask_log WHERE device = ? AND created_at > ?`)
    .bind(device, now - 3600 * 1000)
    .first();
  if ((recent?.n || 0) > 600) return json({ error: "Troppe richieste di fila. Riprova tra un po'." }, 429);

  // la voce non consuma più quota: adesso arriva da Google Traduttore, senza limiti giornalieri

  // senza chiave Google: voce italiana libera di Cloudflare (meglio di quella del telefono)
  if (!env.GEMINI_KEY && env.AI) {
    const testo2 = String(body.text || "").replace(/\s+/g, " ").trim().slice(0, 480);
    for (const modello of ["@cf/facebook/mms-tts-ita", "@cf/myshell-ai/melotts"]) {
      try {
        const out = await env.AI.run(modello, { text: testo2, lang: "it" });
        const audio = out?.audio;
        if (!audio) continue;
        const b64 = typeof audio === "string" ? audio : b64DiBytes(new Uint8Array(audio));
        if (!b64) continue;
        return json({ audio: b64, mime: "audio/mpeg" });
      } catch {}
    }
    return json({ error: "voce non disponibile" }, 502);
  }

  const sesso = body.voice === "m" ? "m" : "f";
  const voce = sesso === "m" ? "Puck" : "Kore";

  // la stessa frase non si paga due volte: resta in cache per un giorno
  const impronta = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); };
  const chiaveVoce = new URL(`https://voce.fuori.local/${lang}/${sesso}/${impronta(testo)}`);
  try {
    const preso = await caches.default.match(chiaveVoce);
    if (preso) return preso;
  } catch {}
  // la voce di Google Traduttore va benissimo per la femminile (naturale e senza quota).
  // per la maschile provo prima una voce maschile vera, poi ripiego su Google.
  if (sesso === "f") {
    const pronta = await voceGoogle(testo, lang);
    if (pronta) {
      const risposta = json({ audio: pronta.b64, mime: pronta.mime });
      try { caches.default.put(chiaveVoce, risposta.clone()); } catch {}
      return risposta;
    }
  } else {
    // maschile: Google risponde in mezzo secondo. Il tono lo abbassa il telefono con il
    // detune (cambio di velocità naturale, senza il ronzio del vecchio taglia-incolla).
    const pronta = await voceGoogle(testo, lang);
    if (pronta) {
      const risposta = json({ audio: pronta.b64, mime: pronta.mime, timbro: "robot" });
      try { caches.default.put(chiaveVoce, risposta.clone()); } catch {}
      return risposta;
    }
  }
  // attenzione: i modelli di voce non accettano istruzioni separate (danno errore 400).
  // Quindi nel testo va solo quello che deve essere letto, niente frasi di comando.
  const payload = {
    contents: [{ role: "user", parts: [{ text: testo }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voce } } },
    },
  };
  let data = null;
  // la voce gratuita ha un tetto di poche richieste al minuto per modello:
  // se un modello dice "troppe richieste" lo metto in castigo per un minuto invece di ritentarlo ogni frase
  // giro a turno: la richiesta dopo usa un altro modello, così non sbatto sul tetto al minuto
  const partenza = voceGiro++ % VOCE_MODELLI.length;
  const inFila = [...VOCE_MODELLI.slice(partenza), ...VOCE_MODELLI.slice(0, partenza)];
  for (const modelloVoce of inFila) {
    const stop = voceStop.get(modelloVoce) || 0;
    if (Date.now() < stop) continue;
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelloVoce}:generateContent?key=${env.GEMINI_KEY}`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(sesso === "m" ? 7000 : 25000) }
      );
      if (res.status === 429) { voceStop.set(modelloVoce, Date.now() + 60000); continue; }
      if (res.status === 400) { voceStop.set(modelloVoce, Date.now() + 3600000); continue; }
      if (!res.ok) continue;
      const d = await res.json();
      if ((d.candidates?.[0]?.content?.parts || []).some((p) => p.inlineData || p.inline_data)) { data = d; break; }
    } catch {}
  }
  if (!data) {
    // la voce maschile vera non è disponibile in questo momento: leggo con Google
    // e dico al telefono di abbassare il tono, così resta maschile lo stesso
    const ripiego = await voceGoogle(testo, lang);
    if (ripiego) return json({ audio: ripiego.b64, mime: ripiego.mime, timbro: "robot" });
    return json({ error: "voce non disponibile" }, 502);
  }
  const part = (data.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData || p.inline_data);
  const b64 = part?.inlineData?.data || part?.inline_data?.data || "";
  if (!b64) return json({ error: "voce vuota" }, 502);
  const mime = part?.inlineData?.mimeType || part?.inline_data?.mime_type || "audio/L16;rate=24000";
  const rate = Number((/rate=(\d+)/.exec(mime) || [])[1]) || 24000;
  const pcm = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  let pulito = pcm;
  try { pulito = senzaStacchi(pcm, rate); } catch {}
  await logAsk(env, device, now);
  const rispostaVoce = json({ audio: b64DiBytes(wavDaPcm(pulito, rate)), mime: "audio/wav" });
  try {
    const daMettere = new Response(rispostaVoce.clone().body, {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=86400" },
    });
    await caches.default.put(chiaveVoce, daMettere);
  } catch {}
  return rispostaVoce;
}

async function stats(env) {
  const now = Date.now();
  const [events, people, leads, notes, subs, verified] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE starts_at >= ?`).bind(now - 2 * 60 * 60 * 1000).first(),
    env.DB.prepare(
      `SELECT COUNT(DISTINCT p.device) AS n FROM participants p JOIN events e ON e.id = p.event_id WHERE e.starts_at >= ?`
    )
      .bind(now - 2 * 60 * 60 * 1000)
      .first(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM leads WHERE lower(COALESCE(email, '')) <> ?`).bind(ownerEmail(env)).first(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM feedback`).first(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM push_subs`).first(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM leads WHERE email_verified = 1`).first(),
  ]);

  return json({
    events: events?.n || 0,
    people: people?.n || 0,
    leads: leads?.n || 0,
    feedback: notes?.n || 0,
    push: subs?.n || 0,
    verified: verified?.n || 0,
  });
}

async function adminOk(env, url) {
  const key = url.searchParams.get("key") || "";
  if (env.ADMIN_KEY && key === env.ADMIN_KEY) return true;
  return isOwner(env, url);
}

async function admin(env, url, request) {
  if (!(await adminOk(env, url))) {
    return json({ error: "Chiave non valida." }, 401);
  }

  if (request.method === "DELETE") {
    const email = isEmail(url.searchParams.get("email"));
    const fbId = Number(url.searchParams.get("feedback"));
    if (email) {
      const row = await env.DB.prepare(`SELECT device FROM leads WHERE email = ?`).bind(email).first();
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM leads WHERE email = ?`).bind(email),
        env.DB.prepare(`DELETE FROM push_subs WHERE email = ?`).bind(email),
      ]);
      // chi cancella l'account sparisce anche dalla mappa
      if (row?.device) {
        await env.DB.prepare(`DELETE FROM map_people WHERE device = ?`).bind(row.device).run();
      }
      return json({ ok: true });
    }
    if (Number.isFinite(fbId) && fbId > 0) {
      await env.DB.prepare(`DELETE FROM feedback WHERE id = ?`).bind(fbId).run();
      return json({ ok: true });
    }
    return bad("Cosa cancello?");
  }

  const [leads, feedback, counts] = await Promise.all([
    env.DB.prepare(
      `SELECT email, first_name, last_name, phone, city, source, interests, bio, looking_for, done,
              email_verified, phone_verified, created_at, age, sex, locale, goals, meet, outings, consent
       FROM leads ORDER BY created_at DESC LIMIT 2000`
    ).all(),
    env.DB.prepare(
      `SELECT id, text, email, mood, path, created_at FROM feedback ORDER BY created_at DESC LIMIT 500`
    ).all(),
    stats(env),
  ]);

  const tally = new Map();
  for (const lead of leads.results || []) {
    try {
      for (const interest of JSON.parse(lead.interests || "[]")) {
        tally.set(interest, (tally.get(interest) || 0) + 1);
      }
    } catch {}
  }
  const topInterests = [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([interest, count]) => ({ interest, count }));

  // lo stato degli avvisi e cosa è successo nelle ultime ore: la stanza dei bottoni
  // si aggiorna da sola, senza ricaricare a mano
  const [pushRow, liveRow] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS subs,
              SUM(CASE WHEN last_ok IS NOT NULL THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN last_fail IS NOT NULL THEN 1 ELSE 0 END) AS fail,
              MAX(last_ok) AS ultimo_ok, MAX(last_fail) AS ultimo_fail
       FROM push_subs`
    ).first().catch(() => null),
    env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM events WHERE starts_at > ?) AS eventi,
              (SELECT COUNT(*) FROM leads WHERE created_at > ?) AS nuovi,
              (SELECT COUNT(*) FROM feedback WHERE created_at > ?) AS pareri`
    ).bind(Date.now(), Date.now() - 864e5, Date.now() - 864e5).first().catch(() => null),
  ]);

  return json({
    stats: await counts.json(),
    leads: leads.results || [],
    feedback: feedback.results || [],
    topInterests,
    push: {
      subs: Number(pushRow?.subs) || 0,
      ok: Number(pushRow?.ok) || 0,
      fail: Number(pushRow?.fail) || 0,
      ultimoOk: Number(pushRow?.ultimo_ok) || 0,
      ultimoFail: Number(pushRow?.ultimo_fail) || 0,
    },
    live: {
      eventi: Number(liveRow?.eventi) || 0,
      nuovi: Number(liveRow?.nuovi) || 0,
      pareri: Number(liveRow?.pareri) || 0,
      at: Date.now(),
    },
  });
}

/* ---------- avvisi per l'app vera (arrivano anche a schermo spento) ---------- */

// gli avvisi si mandano una volta sola per telefono: la chiave resta qui
let notifOk = false;
let storiaOk = false;
// chi ha creato o a chi ha partecipato: serve alla scheda di una persona
async function ensureStoria(env) {
  if (storiaOk) return;
  storiaOk = true;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS storia (
       device TEXT NOT NULL,
       event_id TEXT NOT NULL,
       title TEXT NOT NULL DEFAULT '',
       activity TEXT NOT NULL DEFAULT '',
       category TEXT NOT NULL DEFAULT '',
       place TEXT NOT NULL DEFAULT '',
       starts_at INTEGER NOT NULL,
       role TEXT NOT NULL DEFAULT 'going',
       people INTEGER NOT NULL DEFAULT 0,
       at INTEGER NOT NULL,
       PRIMARY KEY (device, event_id)
     )`
  )
    .run()
    .catch(() => {
      storiaOk = false;
    });
  // i privati non devono comparire nei ricordi pubblici della community
  await addColumns(env, "storia", [["access", "TEXT"]]).catch(() => {});
}


/* ---------- preferiti: il server sa cosa hai messo da parte ---------- */
let savedOk = false;
async function ensureSaved(env) {
  if (savedOk) return;
  savedOk = true;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS saved (
       device TEXT NOT NULL,
       event_id TEXT NOT NULL,
       at INTEGER NOT NULL,
       PRIMARY KEY (device, event_id)
     )`
  )
    .run()
    .catch(() => {});
}

async function savedList(env, url) {
  await ensureSaved(env).catch(() => {});
  const device = String(url.searchParams.get("device") || "").slice(0, 64);
  if (!device) return bad("device");
  if (telefonoProva(device)) return json({ ids: [] });
  const { results } = await env.DB.prepare(`SELECT event_id FROM saved WHERE device = ?`).bind(device).all();
  return json({ ids: (results || []).map((r) => r.event_id) });
}

async function savedSet(env, request) {
  await ensureSaved(env).catch(() => {});
  const body = await request.json().catch(() => null);
  if (!body) return bad("body");
  const device = String(body.device || "").slice(0, 64);
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((x) => typeof x === "string" && x.length > 0 && x.length < 40).slice(0, 200)
    : null;
  if (!device || !ids) return bad("ids");
  if (telefonoProva(device)) return json({ ok: true, skip: true });
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM saved WHERE device = ?`).bind(device),
    ...ids.map((id) => env.DB.prepare(`INSERT OR IGNORE INTO saved (device, event_id, at) VALUES (?, ?, ?)`).bind(device, id, now)),
  ]);
  return json({ ok: true, n: ids.length });
}

async function ensureNotif(env) {
  if (notifOk) return;
  notifOk = true;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS notif_sent (chi TEXT NOT NULL, k TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (chi, k))`
  )
    .run()
    .catch(() => {});
}

async function appNotif(env, url) {
  await ensureNotif(env).catch(() => {});
  const email = String(url.searchParams.get("email") || "").toLowerCase().trim().slice(0, 120);
  const dev = String(url.searchParams.get("d") || "").slice(0, 64);
  const chi = isEmail(email) ? "e:" + email : "d:" + (dev || "ignoto");
  const now = Date.now();
  const all = async (sql, ...b) => {
    try {
      return (await env.DB.prepare(sql).bind(...b).all()).results || [];
    } catch {
      return [];
    }
  };
  const ora = (ms) =>
    new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));

  const presi = new Set((await all(`SELECT k FROM notif_sent WHERE chi = ?`, chi)).map((r) => r.k));
  const nuovi = [];
  const aggiungi = (k, titolo, testo) => {
    if (presi.has(k) || nuovi.length >= 6) return;
    presi.add(k);
    nuovi.push({ k, titolo: String(titolo).slice(0, 80), testo: String(testo || "").slice(0, 140) });
  };

  // eventi che cominciano nelle prossime cinque ore
  for (const e of await all(
    `SELECT id, title, place, starts_at, COALESCE(access, 'open') a FROM events
     WHERE starts_at > ? AND starts_at < ? ORDER BY starts_at ASC LIMIT 6`,
    now,
    now + 5 * 3600e3
  )) {
    aggiungi("e:" + e.id, `Stasera: ${e.title}`, `${ora(e.starts_at)} · ${e.a === "invite" ? "su invito" : e.place}`);
  }

  // eventi appena creati
  for (const e of await all(
    `SELECT id, title, place, city FROM events WHERE created_at > ? ORDER BY created_at DESC LIMIT 4`,
    now - 6 * 3600e3
  )) {
    aggiungi("n:" + e.id, `Nuovo evento: ${e.title}`, `${e.place || e.city || "in zona"} · guardalo nell'app`);
  }

  // roba della persona: per chi ha scritto l'email mi ritrovo il telefono
  if (isEmail(email)) {
    const devices = (await all(`SELECT device FROM leads WHERE email = ?`, email)).map((r) => r.device).filter(Boolean);
    if (devices.length) {
      const segnaposto = devices.map(() => "?").join(",");
      for (const e of await all(
        `SELECT e.id, e.title, e.starts_at, e.place FROM participants p JOIN events e ON e.id = p.event_id
         WHERE p.device IN (${segnaposto}) AND p.status = 'going' AND e.starts_at > ? AND e.starts_at < ?
         ORDER BY e.starts_at ASC LIMIT 4`,
        ...devices,
        now,
        now + 8 * 3600e3
      )) {
        aggiungi("m:" + e.id, `Ci sei stasera: ${e.title}`, `${ora(e.starts_at)} · ${e.place || "in zona"}`);
      }
      for (const m of await all(
        `SELECT m.id, m.text, m.name, e.title, e.id eid FROM messages m JOIN events e ON e.id = m.event_id
         WHERE m.event_id IN (SELECT event_id FROM participants WHERE device IN (${segnaposto}))
           AND m.created_at > ? AND m.device NOT IN (${segnaposto})
         ORDER BY m.created_at DESC LIMIT 4`,
        ...devices,
        now - 3 * 3600e3,
        ...devices
      )) {
        aggiungi("msg:" + m.id, `Messaggio in ${m.title}`, `${m.name || "qualcuno"}: ${m.text}`);
      }
    }
  }

  if (nuovi.length) {
    await env.DB.batch(
      nuovi.map((n) => env.DB.prepare(`INSERT OR IGNORE INTO notif_sent (chi, k, at) VALUES (?, ?, ?)`).bind(chi, n.k, now))
    ).catch(() => {});
    if (Math.random() < 0.1) {
      await env.DB.prepare(`DELETE FROM notif_sent WHERE at < ?`).bind(now - 30 * 864e5).run().catch(() => {});
    }
  }
  return json({ ok: true, ora: ora(now), items: nuovi.map((n) => ({ id: n.k, title: n.titolo, body: n.testo })) });
}

/* ---------- chi c'è adesso ---------- */

async function presencePing(env, request) {
  const body = await request.json().catch(() => null);
  const device = text(body?.device, 8, 64);
  if (!device) return bad("device");
  const now = Date.now();
  const escluso = await env.DB.prepare(`SELECT 1 FROM ignora WHERE device = ?`).bind(device).first().catch(() => null);
  if (!(await isOwnerDevice(env, device)) && !escluso) {
    await env.DB.prepare(
      `INSERT INTO presence (device, seen_at) VALUES (?, ?)
       ON CONFLICT(device) DO UPDATE SET seen_at = excluded.seen_at`
    )
      .bind(device, now)
      .run();
  }
  if (Math.random() < 0.05) {
    await env.DB.prepare(`DELETE FROM presence WHERE seen_at < ?`).bind(now - 864e5).run();
  }
  const online = (await env.DB.prepare(
    `SELECT COUNT(*) n FROM presence WHERE seen_at >= ? AND device NOT IN (SELECT device FROM owner_dev)`
  ).bind(now - 3 * 60 * 1000).first())?.n || 0;
  return json({ ok: true, online });
}

/* ---------- numeri del padrone ---------- */

// l'elenco degli esclusi deve esserci sempre: se manca lo creo al volo, senza fermare i numeri
let ignoraOk = false;
async function ensureIgnora(env) {
  if (ignoraOk) return;
  ignoraOk = true;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ignora (device TEXT PRIMARY KEY, at INTEGER NOT NULL)`)
    .run()
    .catch(() => {});
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS person_dev (device TEXT PRIMARY KEY, email TEXT NOT NULL, at INTEGER NOT NULL)`
  )
    .run()
    .catch(() => {});
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS push_dead (
       endpoint TEXT PRIMARY KEY,
       email TEXT,
       device TEXT,
       status INTEGER,
       at INTEGER NOT NULL
     )`
  )
    .run()
    .catch(() => {});
  // chi si era già registrato prima di questa regola: lo riempio una volta
  await env.DB.prepare(
    `INSERT OR IGNORE INTO person_dev (device, email, at)
     SELECT device, email, COALESCE(created_at, 0) FROM leads WHERE device IS NOT NULL AND length(device) >= 8`
  )
    .run()
    .catch(() => {});
}

// i dispositivi del padrone stanno sempre fra gli esclusi: i suoi numeri non
// devono mai entrare negli insight, né dai telefoni registrati né dalla sua mail
async function sincronizzaMiei(env) {
  const mio = ownerEmail(env);
  const now = Date.now();
  await env.DB.prepare(`INSERT OR IGNORE INTO ignora (device, at) SELECT device, ? FROM owner_dev`)
    .bind(now)
    .run()
    .catch(() => {});
  await env.DB.prepare(`INSERT OR IGNORE INTO ignora (device, at) SELECT device, ? FROM person_dev WHERE lower(email) = ?`)
    .bind(now, mio)
    .run()
    .catch(() => {});
  await env.DB.prepare(
    `INSERT OR IGNORE INTO ignora (device, at)
     SELECT device, ? FROM leads WHERE lower(email) = ? AND device IS NOT NULL AND length(device) >= 8`
  )
    .bind(now, mio)
    .run()
    .catch(() => {});
}

async function ownerStats(env, url) {
  await ensureIgnora(env).catch(() => {});
  await sincronizzaMiei(env).catch(() => {});
  const mio = ownerEmail(env);
  // il mio nome, per togliere anche le righe del registro dove compare
  const mioNome = String(
    (await env.DB.prepare(`SELECT first_name FROM leads WHERE lower(email) = ? LIMIT 1`).bind(mio).first().catch(() => null))
      ?.first_name || "Christian"
  ).toLowerCase();
  const days = Math.min(30, Math.max(1, Number(url?.searchParams?.get("days")) || 7));
  // il telefono da cui guardi i numeri non conta mai: sei tu
  const ioSql = String(url?.searchParams?.get("device") || "").replace(/'/g, "''");
  const now = Date.now();
  const key = (ts) => new Date(ts).toISOString().slice(0, 10);
  const today = key(now);
  const from = key(now - (days - 1) * 864e5);
  const one = async (sql, ...b) => (await env.DB.prepare(sql).bind(...b).first())?.n || 0;
  // "una persona sola": se ha una mail la conto per mail, così Chrome, Firefox e l'app
  // sullo stesso telefono fanno una persona e non tre. Dispositivi miei e prove restano fuori.
  const CHI = `COALESCE(NULLIF(pd.email, ''), NULLIF(l.email, ''), 'w:' || v.who)`;
  const NON_VERI = `v.device NOT IN (SELECT device FROM owner_dev)
        AND v.device NOT IN (SELECT device FROM ignora)
        AND v.device NOT LIKE 'prova%' AND v.device NOT LIKE 'test%' AND v.device NOT LIKE 'demo%'`;
  // fuori i profili di prova, i miei dispositivi e la mia mail: qui contano solo le altre persone
  const mioSql = String(mio || "").replace(/'/g, "''");
  const NON_PROVA = `email NOT LIKE 'prova%' AND email NOT LIKE 'test%' AND email NOT LIKE '%@esempio.%'
        AND lower(COALESCE(email, '')) <> '${mioSql}'
        AND COALESCE(device, '') NOT IN (SELECT device FROM owner_dev)
        AND COALESCE(device, '') NOT IN (SELECT device FROM ignora)`;
  const PERSONE = `FROM visits v LEFT JOIN person_dev pd ON (pd.device = v.device)
        LEFT JOIN leads l ON (l.device = v.device AND l.device <> '')`;
  const VISITE = `${PERSONE}
        WHERE ${NON_VERI}`;
  const all = async (sql, ...b) => (await env.DB.prepare(sql).bind(...b).all()).results || [];

  const [
    perGiorno, iscrittiGiorno, dlGiorno, nuoviGiorno,
    iscritti, downloadTot, feedbackTot, eventiFuturi, messaggi, domande, online, attivi,
    sesso, eta, lingue, citta, percorsi, ore, leadRows, ultimiFeedback, attrito,
    fVisite, fProfilo, fEvento, fRegistra, fIscrizione, persone, inApp,
  ] = await Promise.all([
    all(`SELECT v.day d, COUNT(DISTINCT ${CHI}) unici, SUM(v.views) views ${VISITE} AND v.day >= ? GROUP BY v.day ORDER BY d`, from),
    all(`SELECT substr(date(created_at/1000,'unixepoch'),1,10) d, COUNT(*) n FROM leads WHERE created_at >= ? AND ${NON_PROVA} GROUP BY d`, now - days * 864e5),
    all(
      `SELECT v.day d, COUNT(DISTINCT ${CHI}) n ${PERSONE}
       WHERE ${NON_VERI} AND v.day >= ? AND date(l.created_at/1000,'unixepoch') = v.day GROUP BY v.day`,
      from
    ),
    all(
      `SELECT day d, COUNT(*) n FROM dlwho WHERE day >= ?
        AND who NOT IN (SELECT 'd:' || device FROM owner_dev)
        AND who NOT IN (SELECT 'd:' || device FROM ignora)
       GROUP BY day ORDER BY d`,
      from
    ),

    one(`SELECT COUNT(*) n FROM leads WHERE ${NON_PROVA}`),
    one(
      `SELECT COUNT(DISTINCT COALESCE(NULLIF(l.email, ''), d.device)) n FROM dl_dev d
       LEFT JOIN leads l ON (('d:' || l.device) = d.device AND l.device <> '')
       WHERE d.device NOT LIKE '%prova%' AND d.device NOT LIKE '%test%'
         AND COALESCE(l.email, '') NOT LIKE '%@esempio.%'
         AND REPLACE(d.device, 'd:', '') NOT IN (SELECT device FROM owner_dev)
         AND REPLACE(d.device, 'd:', '') NOT IN (SELECT device FROM ignora)`
    ),
    one(`SELECT COUNT(*) n FROM feedback WHERE lower(COALESCE(email, '')) <> ?`, mio),
    one(`SELECT COUNT(*) n FROM events WHERE starts_at >= ?`, now),
    one(
      `SELECT COUNT(*) n FROM messages WHERE device NOT IN (SELECT device FROM owner_dev)
        AND device NOT IN (SELECT device FROM ignora)
        AND device NOT LIKE 'prova%' AND device NOT LIKE 'test%' AND device NOT LIKE 'demo%'`
    ),
    one(
      `SELECT COUNT(*) n FROM ask_log WHERE device NOT IN (SELECT device FROM owner_dev)
        AND device NOT IN (SELECT device FROM ignora)
        AND device NOT LIKE 'prova%' AND device NOT LIKE 'test%' AND device NOT LIKE 'demo%'`
    ),
    one(
      `SELECT COUNT(*) n FROM presence WHERE seen_at >= ?
        AND device NOT IN (SELECT device FROM owner_dev) AND device NOT IN (SELECT device FROM ignora)
        AND device <> '${ioSql}'
        AND device NOT LIKE 'prova%' AND device NOT LIKE 'test%' AND device NOT LIKE 'demo%'`,
      now - 3 * 60 * 1000
    ),
    one(`SELECT COUNT(*) n FROM leads WHERE last_seen >= ? AND ${NON_PROVA}`, now - 864e5),
    all(`SELECT COALESCE(NULLIF(sex,''),'nd') k, COUNT(*) n FROM leads WHERE ${NON_PROVA} GROUP BY k ORDER BY n DESC`),
    all(
      `SELECT CASE
         WHEN age IS NULL OR age < 1 THEN 'nd'
         WHEN age < 20 THEN '16-19' WHEN age < 25 THEN '20-24' WHEN age < 30 THEN '25-29'
         WHEN age < 35 THEN '30-34' WHEN age < 45 THEN '35-44' WHEN age < 55 THEN '45-54'
         ELSE '55 e più' END k, COUNT(*) n
       FROM leads WHERE ${NON_PROVA} GROUP BY k ORDER BY n DESC`
    ),
    all(
      `SELECT CASE lang WHEN 'it' THEN 'italiano' WHEN 'en' THEN 'inglese' WHEN 'es' THEN 'spagnolo'
         WHEN 'pt' THEN 'portoghese' ELSE 'altro' END k, SUM(count) n
       FROM hits WHERE day >= ? GROUP BY k ORDER BY n DESC`, from
    ),
    all(`SELECT COALESCE(NULLIF(city,''),'non indicata') k, COUNT(*) n FROM leads WHERE ${NON_PROVA} GROUP BY k ORDER BY n DESC LIMIT 6`),
    all(`SELECT path k, SUM(count) n FROM hits WHERE day >= ? GROUP BY k ORDER BY n DESC LIMIT 8`, from),
    all(
      `SELECT CAST(strftime('%H', first_at/1000, 'unixepoch') AS INTEGER) h, COUNT(*) n
       FROM visits WHERE day >= ?
         AND device NOT IN (SELECT device FROM owner_dev)
         AND device NOT IN (SELECT device FROM ignora)
        GROUP BY h ORDER BY h`, from
    ),
    all(`SELECT interests FROM leads WHERE ${NON_PROVA}`),
    all(`SELECT text, created_at FROM feedback ORDER BY created_at DESC LIMIT 4`),
    all(
      `SELECT kind, detail, SUM(count) n FROM friction WHERE day >= ?
       GROUP BY kind, detail ORDER BY n DESC LIMIT 8`, from
    ),
    one(`SELECT COUNT(DISTINCT ${CHI}) n ${VISITE} AND v.day >= ?`, from),
    one(`SELECT COUNT(DISTINCT ${CHI}) n ${VISITE} AND v.day >= ? AND v.screens LIKE '%profilo%'`, from),
    one(`SELECT COUNT(DISTINCT ${CHI}) n ${VISITE} AND v.day >= ? AND v.screens LIKE '%evento%'`, from),
    one(`SELECT COUNT(DISTINCT ${CHI}) n ${VISITE} AND v.day >= ? AND v.screens LIKE '%registrazione%'`, from),
    one(`SELECT COUNT(DISTINCT ${CHI}) n ${VISITE} AND v.day >= ? AND v.screens LIKE '%iscrizione%'`, from),
    one(`SELECT COUNT(DISTINCT ${CHI}) n ${VISITE}`),
    one(
      `SELECT COUNT(DISTINCT ${CHI}) n ${PERSONE}
        JOIN people p ON p.who = v.who WHERE ${NON_VERI} AND p.is_app = 1`
    ),
  ]);

  // totali di sempre (contatori che non si azzerano con la pulizia degli eventi)
  const tallyOf = async (key) => {
    try {
      const row = await env.DB.prepare(`SELECT n FROM tally WHERE key = ?`).bind(key).first();
      return Number(row?.n) || 0;
    } catch {
      return 0;
    }
  };
  const [eventiSempre, messaggiSempre] = await Promise.all([tallyOf("events"), tallyOf("messages")]);

  // serie giorno per giorno, con gli zeri dove non c'è nessuno
  const serie = [];
  const map = (rows, f) => new Map(rows.map((r) => [r.d, f(r)]));
  const mU = map(perGiorno, (r) => r.unici);
  const mV = map(perGiorno, (r) => r.views);
  const mN = map(nuoviGiorno, (r) => r.n);
  const mI = map(iscrittiGiorno, (r) => r.n);
  const mD = map(dlGiorno, (r) => r.n);
  for (let i = days - 1; i >= 0; i--) {
    const d = key(now - i * 864e5);
    serie.push({ d, unici: mU.get(d) || 0, views: mV.get(d) || 0, nuovi: mN.get(d) || 0, iscritti: mI.get(d) || 0, download: mD.get(d) || 0 });
  }
  const sum = (k) => serie.reduce((a, r) => a + (r[k] || 0), 0);

  // andamento nel tempo: settimana, mesi e anni (le stesse persone "una volta sola")
  const [perMese, perAnno] = await Promise.all([
    all(`SELECT substr(v.day, 1, 7) k, COUNT(DISTINCT ${CHI}) n ${VISITE} GROUP BY k ORDER BY k`),
    all(`SELECT substr(v.day, 1, 4) k, COUNT(DISTINCT ${CHI}) n ${VISITE} GROUP BY k ORDER BY k`),
  ]);
  const mese = new Map(perMese.map((r) => [r.k, r.n]));
  const anno = new Map(perAnno.map((r) => [r.k, r.n]));
  const meseOra = new Date(now);
  const meseChiave = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const mesi = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(meseOra.getUTCFullYear(), meseOra.getUTCMonth() - i, 1));
    const k = meseChiave(d);
    mesi.push({ k, n: mese.get(k) || 0 });
  }
  const anni = [];
  const annoOra = meseOra.getUTCFullYear();
  const primoAnno = perAnno.length ? Number(perAnno[0].k) : annoOra;
  for (let y = Math.max(primoAnno, annoOra - 5); y <= annoOra; y++) anni.push({ k: String(y), n: anno.get(String(y)) || 0 });
  // una persona che torna tre giorni resta una persona, non tre
  const personePeriodo = await one(
    `SELECT COUNT(DISTINCT ${CHI}) n ${VISITE} AND v.day >= ?`,
    from
  ).catch(() => 0);
  const oggiRow = serie[serie.length - 1] || { unici: 0, views: 0, nuovi: 0, iscritti: 0, download: 0 };

  const tally = new Map();
  for (const row of leadRows) {
    try {
      for (const it of JSON.parse(row.interests || "[]")) tally.set(it, (tally.get(it) || 0) + 1);
    } catch {}
  }
  const interessi = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, n]) => ({ k, n }));

  const attritoNomi = {
    tocco_furioso: "Toccano lo stesso punto più volte",
    ricerca_vuota: "Cercano qualcosa che non ha ancora eventi",
    attivita_vuota: "Cercano un'attività che nessuno ha ancora proposto",
    errore_campo: "Sbagliano un campo",
    abbandono: "Aprono e chiudono senza finire",
    lento: "Aspettano troppo",
    crash: "L'app si blocca",
  };
  const attrito2 = (attrito || []).map((r) => ({ kind: attritoNomi[r.kind] || r.kind, detail: r.detail || "", n: r.n }));

  // ---- app: quante persone la scaricano, quante se ne vanno, dopo quanto e perché ----
  const app = {
    installati: 0, installatiPeriodo: 0, disinstallati: 0, tornati: 0, restano: 0, percRestano: 0,
    dopo: { media: 0, entroUno: 0, entroSette: 0, oltre: 0 },
    motivi: [], nomi: [],
  };
  try {
    // una persona sola anche se scarica da due telefoni o reinstalla: la conto per mail, sennò per dispositivo
    const chiHa = `COALESCE(NULLIF(pd.email, ''), NULLIF(l.email, ''), REPLACE(d.device, 'd:', ''))`;
    const scaricato = await env.DB.prepare(
      `SELECT ${chiHa} chi, MAX(d.at) at FROM dl_dev d
       LEFT JOIN person_dev pd ON (('d:' || pd.device) = d.device)
       LEFT JOIN leads l ON (('d:' || l.device) = d.device)
       WHERE REPLACE(d.device, 'd:', '') NOT IN (SELECT device FROM owner_dev)
         AND REPLACE(d.device, 'd:', '') NOT IN (SELECT device FROM ignora)
       GROUP BY chi`
    )
      .all()
      .catch(() => ({ results: [] }));
    const gente = scaricato.results || [];
    app.installati = gente.length;
    app.installatiPeriodo = gente.filter((r) => Number(r.at) >= now - days * 864e5).length;

    const morti = await env.DB.prepare(
      `SELECT x.endpoint, COALESCE(NULLIF(pd.email, ''), NULLIF(x.email, ''), x.endpoint) chi,
              x.email, x.device, x.at, x.status,
              (SELECT MAX(d.at) FROM dl_dev d WHERE d.device = 'd:' || x.device) AS installato,
              (SELECT created_at FROM leads l2 WHERE l2.email = x.email) AS iscritto,
              (SELECT COUNT(*) FROM push_subs s WHERE s.email = x.email AND s.email <> '') AS vivo,
              (SELECT COUNT(*) FROM participants pp WHERE pp.device = x.device AND pp.status = 'going') AS dentro,
              (SELECT COUNT(*) FROM events e WHERE e.device = x.device) AS creati,
              (SELECT COUNT(*) FROM messages m WHERE m.device = x.device) AS messaggi,
              (SELECT COUNT(*) FROM ask_log a WHERE a.device = x.device) AS domande,
              (SELECT COUNT(*) FROM leads l3 WHERE l3.device = x.device AND COALESCE(l3.photo, '') <> '') AS foto
       FROM push_dead x
       LEFT JOIN person_dev pd ON (pd.device = x.device)
       WHERE x.at >= ?
         AND x.device NOT IN (SELECT device FROM owner_dev)
         AND x.device NOT IN (SELECT device FROM ignora)
       ORDER BY x.at DESC`
    )
      .bind(now - 30 * 864e5)
      .all()
      .catch(() => ({ results: [] }));

    // una persona = una riga sola, anche se ha disinstallato tre volte
    const perChi = new Map();
    for (const r of morti.results || []) {
      const chi = r.chi || r.endpoint;
      const gia = perChi.get(chi);
      if (!gia || Number(r.at) > Number(gia.at)) perChi.set(chi, r);
    }
    const usciti = [...perChi.values()];
    app.disinstallati = usciti.length;
    app.tornati = usciti.filter((r) => Number(r.vivo) > 0).length;
    app.restano = Math.max(0, app.installati - (app.disinstallati - app.tornati));

    // dopo quanto se ne vanno: dall'installazione (o dall'iscrizione) al momento in cui il telefono spariva
    const giorniDa = (r) => {
      const inizio = Number(r.installato) || Number(r.iscritto) || 0;
      const fine = Number(r.at) || 0;
      if (!inizio || !fine || fine < inizio) return null;
      return (fine - inizio) / 864e5;
    };
    let somma = 0, quanti = 0;
    for (const r of usciti) {
      const g = giorniDa(r);
      if (g === null) continue;
      somma += g;
      quanti++;
      if (g <= 1) app.dopo.entroUno++;
      else if (g <= 7) app.dopo.entroSette++;
      else app.dopo.oltre++;
    }
    app.dopo.media = quanti ? Math.round((somma / quanti) * 10) / 10 : 0;

    // il "perché": dai dati si vede solo cosa NON avevano fatto. Lo dico per quello che è.
    const conta = (f) => usciti.filter(f).length;
    const cand = [
      ["non avevano mai partecipato a un evento", conta((r) => !Number(r.dentro))],
      ["non avevano mai scritto in una chat", conta((r) => !Number(r.messaggi))],
      ["non avevano mai chiesto all'assistente", conta((r) => !Number(r.domande))],
      ["non avevano messo la foto profilo", conta((r) => !Number(r.foto))],
    ];
    app.motivi = cand.filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([testo, n]) => ({ testo, n }));

    // chi non si fa vedere da due settimane: non so se ha disinstallato, so che non c'è
    app.spariti =
      (await env.DB.prepare(
        `SELECT COUNT(*) n FROM leads WHERE COALESCE(last_seen, created_at) < ? AND created_at < ?`
      )
        .bind(now - 14 * 864e5, now - 14 * 864e5)
        .first()
        .catch(() => null))?.n || 0;

    app.nomi = usciti.slice(0, 8).map((r) => {
      const g = giorniDa(r);
      const nome = String(r.email || "").split("@")[0] || "senza nome";
      return {
        chi: nome,
        giorni: g === null ? null : Math.max(0, Math.round(g * 10) / 10),
        perche: Number(r.status) === 410 ? "ha spento gli avvisi" : "ha tolto l'app dal telefono",
        tornato: Number(r.vivo) > 0,
      };
    });
  } catch {}

  // ---- statistiche della community: solo le altre persone.
  // Tu e l'assistente restate fuori da ogni numero e da ogni frase.
  const community = {
    persone: 0, eventi: 0, inProgramma: 0, partecipazioni: 0,
    mediaPartecipanti: 0, categorie: [], citta: [], ricordi: { tot: 0, conFoto: 0, conDescrizione: 0, votoMedio: 0 },
    chat: { messaggi: 0, eventi: 0 }, ritornoPersone: 0,
    adesso: { online: 0, inCorso: 0, prossime24: 0, oggiNuovi: 0, msgOra: 0 },
    crescita: { nuovi: { ora: 0, prima: 0, perc: 0 }, eventi: { ora: 0, prima: 0, perc: 0 }, partecipazioni: { ora: 0, prima: 0, perc: 0 } },
    etaMedia: 0, giorni: [], fasce: [], accesso: [], riempimento: 0, top: [],
  };
  try {
    // nessun numero sulle mie cose: solo device e mail degli altri
    const ALTRI = `COALESCE(device, '') NOT IN (SELECT device FROM owner_dev) AND COALESCE(device, '') NOT IN (SELECT device FROM ignora)`;
    const ALTRI_E = `COALESCE(e.device, '') NOT IN (SELECT device FROM owner_dev) AND COALESCE(e.device, '') NOT IN (SELECT device FROM ignora)`;
    const [
      gente, tuttiEventi, inProg, presi, perCat, perCitta, msg, chatEv, tornati,
      onlineOra, inCorso, prossime24, oggiNuovi, nuoviSett, nuoviPrima,
      evSett, evPrima, parteSett, partePrima, etaMedia, perGiorno, perFascia,
      accessi, capTot, postiPresi, topEv, msgOra,
    ] = await Promise.all([
      one(`SELECT COUNT(*) n FROM leads WHERE ${NON_PROVA}`),
      one(`SELECT COUNT(*) n FROM events WHERE ${ALTRI}`),
      one(`SELECT COUNT(*) n FROM events WHERE starts_at >= ? AND ${ALTRI}`, now),
      one(`SELECT COUNT(*) n FROM participants WHERE status = 'going' AND ${ALTRI}`),
      all(`SELECT COALESCE(NULLIF(category,''),'altro') k, COUNT(*) n FROM events WHERE ${ALTRI} GROUP BY k ORDER BY n DESC`),
      all(`SELECT COALESCE(NULLIF(city,''),'Catania') k, COUNT(*) n FROM events WHERE ${ALTRI} GROUP BY k ORDER BY n DESC LIMIT 8`),
      one(`SELECT COUNT(*) n FROM messages WHERE ${ALTRI}`),
      one(`SELECT COUNT(DISTINCT event_id) n FROM messages WHERE ${ALTRI}`),
      one(`SELECT COUNT(*) n FROM (SELECT device FROM participants WHERE status = 'going' AND ${ALTRI} GROUP BY device HAVING COUNT(*) > 1)`),
      // adesso
      one(
        `SELECT COUNT(*) n FROM presence WHERE seen_at >= ? AND device <> '${ioSql}' AND ${ALTRI}`,
        now - 3 * 60 * 1000
      ),
      one(`SELECT COUNT(*) n FROM events WHERE starts_at BETWEEN ? AND ? AND ${ALTRI}`, now - 3 * 3600e3, now),
      one(`SELECT COUNT(*) n FROM events WHERE starts_at BETWEEN ? AND ? AND ${ALTRI}`, now, now + 24 * 3600e3),
      one(
        `SELECT COUNT(*) n FROM leads WHERE substr(date(created_at/1000,'unixepoch'),1,10) = ? AND ${NON_PROVA}`,
        today
      ),
      // questa settimana contro quella prima
      one(`SELECT COUNT(*) n FROM leads WHERE created_at >= ? AND ${NON_PROVA}`, now - 7 * 864e5),
      one(`SELECT COUNT(*) n FROM leads WHERE created_at >= ? AND created_at < ? AND ${NON_PROVA}`, now - 14 * 864e5, now - 7 * 864e5),
      one(`SELECT COUNT(*) n FROM events WHERE created_at >= ? AND ${ALTRI}`, now - 7 * 864e5),
      one(`SELECT COUNT(*) n FROM events WHERE created_at >= ? AND created_at < ? AND ${ALTRI}`, now - 14 * 864e5, now - 7 * 864e5),
      one(`SELECT COUNT(*) n FROM participants WHERE status = 'going' AND created_at >= ? AND ${ALTRI}`, now - 7 * 864e5),
      one(`SELECT COUNT(*) n FROM participants WHERE status = 'going' AND created_at >= ? AND created_at < ? AND ${ALTRI}`, now - 14 * 864e5, now - 7 * 864e5),
      one(`SELECT ROUND(AVG(age)) n FROM leads WHERE age > 0 AND ${NON_PROVA}`),
      // quando si esce: giorno della settimana e fascia oraria (ultimi 90 giorni)
      all(
        `SELECT CAST(strftime('%w', starts_at/1000, 'unixepoch') AS INTEGER) k, COUNT(*) n
           FROM events WHERE starts_at >= ? AND starts_at < ? AND ${ALTRI}
          GROUP BY k ORDER BY k`,
        now - 90 * 864e5, now + 90 * 864e5
      ),
      all(
        `SELECT CASE
           WHEN h < 6 THEN 'notte' WHEN h < 12 THEN 'mattina'
           WHEN h < 18 THEN 'pomeriggio' ELSE 'sera' END k, COUNT(*) n
         FROM (SELECT CAST(strftime('%H', starts_at/1000, 'unixepoch') AS INTEGER) h
                 FROM events WHERE starts_at >= ? AND starts_at < ? AND ${ALTRI})
         GROUP BY k`,
        now - 90 * 864e5, now + 90 * 864e5
      ),
      all(`SELECT COALESCE(NULLIF(access,''),'open') k, COUNT(*) n FROM events WHERE ${ALTRI} GROUP BY k ORDER BY n DESC`),
      one(`SELECT SUM(capacity) n FROM events WHERE starts_at >= ? AND capacity > 0 AND ${ALTRI}`, now),
      one(
        `SELECT COUNT(*) n FROM participants p JOIN events e ON e.id = p.event_id
          WHERE p.status = 'going' AND e.starts_at >= ? AND ${ALTRI_E}
            AND p.device NOT IN (SELECT device FROM owner_dev)`,
        now
      ),
      all(
        `SELECT e.id, e.title, e.city, e.capacity, COUNT(p.device) going
           FROM events e LEFT JOIN participants p
             ON p.event_id = e.id AND p.status = 'going'
            AND p.device NOT IN (SELECT device FROM owner_dev)
          WHERE e.starts_at >= ? AND e.device NOT IN (SELECT device FROM owner_dev)
          GROUP BY e.id ORDER BY going DESC, e.starts_at ASC LIMIT 6`,
        now
      ),
      one(`SELECT COUNT(*) n FROM messages WHERE created_at >= ? AND ${ALTRI}`, now - 3600e3),
    ]);

    const perc = (a, b) => (Number(b) > 0 ? Math.round(((Number(a) - Number(b)) / Number(b)) * 100) : Number(a) > 0 ? 100 : 0);
    community.persone = Number(gente) || 0;
    community.eventi = Number(tuttiEventi) || 0;
    community.inProgramma = Number(inProg) || 0;
    community.partecipazioni = Number(presi) || 0;
    community.mediaPartecipanti = community.eventi
      ? Math.round((community.partecipazioni / community.eventi) * 10) / 10
      : 0;
    community.etaMedia = Number(etaMedia) || 0;
    community.adesso = {
      online: Number(onlineOra) || 0,
      inCorso: Number(inCorso) || 0,
      prossime24: Number(prossime24) || 0,
      oggiNuovi: Number(oggiNuovi) || 0,
      msgOra: Number(msgOra) || 0,
    };
    community.crescita = {
      nuovi: { ora: Number(nuoviSett) || 0, prima: Number(nuoviPrima) || 0, perc: perc(nuoviSett, nuoviPrima) },
      eventi: { ora: Number(evSett) || 0, prima: Number(evPrima) || 0, perc: perc(evSett, evPrima) },
      partecipazioni: { ora: Number(parteSett) || 0, prima: Number(partePrima) || 0, perc: perc(parteSett, partePrima) },
    };

    const totaleCat = (perCat || []).reduce((a, r) => a + (Number(r.n) || 0), 0) || 1;
    community.categorie = (perCat || []).map((r) => ({
      k: String(r.k || ""), n: Number(r.n) || 0, perc: Math.round(((Number(r.n) || 0) / totaleCat) * 100),
    }));
    const totaleCitta = (perCitta || []).reduce((a, r) => a + (Number(r.n) || 0), 0) || 1;
    community.citta = (perCitta || []).map((r) => ({
      k: String(r.k || ""), n: Number(r.n) || 0, perc: Math.round(((Number(r.n) || 0) / totaleCitta) * 100),
    }));

    // giorni della settimana: lunedì primo, domenica ultima
    const nomiGiorni = ["lun", "mar", "mer", "gio", "ven", "sab", "dom"];
    const contaGiorno = new Map((perGiorno || []).map((r) => [Number(r.k), Number(r.n) || 0]));
    const totGiorni = [...contaGiorno.values()].reduce((a, b) => a + b, 0) || 1;
    community.giorni = [1, 2, 3, 4, 5, 6, 0].map((w) => {
      const n = contaGiorno.get(w) || 0;
      return { k: nomiGiorni[(w + 6) % 7], n, perc: Math.round((n / totGiorni) * 100) };
    });

    // fasce della giornata, in ordine
    const fascia = new Map((perFascia || []).map((r) => [String(r.k), Number(r.n) || 0]));
    const totFasce = [...fascia.values()].reduce((a, b) => a + b, 0) || 1;
    community.fasce = ["mattina", "pomeriggio", "sera", "notte"].map((k) => {
      const n = fascia.get(k) || 0;
      return { k, n, perc: Math.round((n / totFasce) * 100) };
    });

    const nomiAccesso = { photo: "con foto", verified: "viso verificato", invite: "solo invito", open: "aperto a tutti" };
    const totAcc = (accessi || []).reduce((a, r) => a + (Number(r.n) || 0), 0) || 1;
    community.accesso = (accessi || []).map((r) => ({
      k: nomiAccesso[String(r.k)] || String(r.k || "altro"),
      n: Number(r.n) || 0,
      perc: Math.round(((Number(r.n) || 0) / totAcc) * 100),
    }));

    community.riempimento = Number(capTot) > 0 ? Math.round((Number(postiPresi) / Number(capTot)) * 100) : 0;
    community.top = (topEv || []).map((r) => ({
      id: String(r.id || ""),
      title: String(r.title || ""),
      city: String(r.city || ""),
      going: Number(r.going) || 0,
      capacity: Number(r.capacity) || 0,
      perc: Number(r.capacity) > 0 ? Math.round((Number(r.going) / Number(r.capacity)) * 100) : 0,
    }));

    const ric = await env.DB.prepare(
      `SELECT COUNT(*) n,
         SUM(CASE WHEN COALESCE(photos,'[]') NOT IN ('[]','') THEN 1 ELSE 0 END) conf,
         SUM(CASE WHEN COALESCE(description,'') <> '' THEN 1 ELSE 0 END) cond
       FROM past_events`
    )
      .first()
      .catch(() => null);
    const voto = await env.DB.prepare(`SELECT ROUND(AVG(stars),1) m FROM event_ratings WHERE stars > 0`)
      .first()
      .catch(() => null);
    community.ricordi = {
      tot: Number(ric?.n) || 0,
      conFoto: Number(ric?.conf) || 0,
      conDescrizione: Number(ric?.cond) || 0,
      votoMedio: Number(voto?.m) || 0,
    };
    community.chat = { messaggi: Number(msg) || 0, eventi: Number(chatEv) || 0 };
    // quante persone sono state a più di un evento: è il segno che la community tiene
    community.ritornoPersone = community.persone
      ? Math.round(((Number(tornati) || 0) / community.persone) * 100)
      : 0;
  } catch {}

  const tot = Number(personePeriodo) || sum("unici");
  const ritorno = tot > 0 ? Math.round(((tot - sum("nuovi")) / tot) * 100) : 0;

  return json({
    giorni: days,
    oggi: {
      unici: oggiRow.unici, views: oggiRow.views, nuovi: oggiRow.nuovi,
      iscritti: oggiRow.iscritti, download: oggiRow.download, online, attivi,
    },
    periodo: {
      unici: tot, views: sum("views"), nuovi: sum("nuovi"), ritorno,
      iscritti: sum("iscritti"), download: sum("download"),
      media: Math.round(tot / days),
    },
    totali: {
      iscritti,
      download: downloadTot,
      feedback: feedbackTot,
      // numeri veri, letti adesso dal database
      eventi: eventiFuturi,
      messaggi,
      domande,
      persone,
      inApp,
    },
    serie,
    andamento: {
      settimana: serie.map((r) => ({ k: r.d, n: r.unici })),
      mesi,
      anni,
    },
    app,
    community,
    sesso, eta, lingue, citta, interessi, percorsi, ore,
    imbuto: [
      { k: "Hanno aperto l'app", n: fVisite },
      { k: "Hanno aperto il profilo", n: fProfilo },
      { k: "Hanno visto un evento", n: fEvento },
      { k: "Hanno iniziato la registrazione", n: fRegistra },
      { k: "Si sono iscritti a un evento", n: fIscrizione },
    ],
    attrito: attrito2,
    ultimiFeedback,
  });
}

function giorni(serie) {
  const ult = serie.slice(-3).reduce((a, r) => a + r.unici, 0);
  const pre = serie.slice(-6, -3).reduce((a, r) => a + r.unici, 0);
  return { calo: pre > 0 && ult < pre * 0.6 };
}

/* ---------- come si sentono: una risposta al giorno, per gli insight ---------- */
let moodsOk = false;
async function ensureMoods(env) {
  if (moodsOk) return;
  moodsOk = true;
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS moods (
        device TEXT NOT NULL,
        day TEXT NOT NULL,
        mood TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (device, day)
      )`
    ).run();
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_moods_at ON moods(at)`).run();
  } catch {}
}

async function noteMood(env, request) {
  const body = await request.json().catch(() => null);
  const device = text(body?.device, 8, 64);
  const mood = text(body?.mood, 2, 24);
  if (!device || !mood) return bad("mood");
  // io e i telefoni di prova non entriamo mai nei numeri
  if (telefonoProva(device)) return json({ ok: true, skip: true });
  if (await sonoPadrone(env, device).catch(() => false)) return json({ ok: true, skip: true });
  await ensureMoods(env);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(body?.day || "")) ? body.day : new Date().toISOString().slice(0, 10);
  try {
    await env.DB.prepare(
      `INSERT INTO moods (device, day, mood, at) VALUES (?, ?, ?, ?)
       ON CONFLICT(device, day) DO UPDATE SET mood = excluded.mood, at = excluded.at`
    )
      .bind(device, day, mood.slice(0, 24), Date.now())
      .run();
  } catch {}
  return json({ ok: true });
}

async function moodStats(env, url) {
  const device = text(url.searchParams.get("device"), 8, 64);
  if (!device) return bad("device");
  if (!(await sonoPadrone(env, device))) return json({ error: "Non trovato." }, 404);
  await ensureMoods(env);
  const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 30));
  const from = Date.now() - days * 864e5;
  let moods = [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT m.mood, COUNT(*) AS n
         FROM moods m LEFT JOIN leads l ON l.device = m.device
        WHERE m.at >= ?
          AND m.device NOT LIKE 'zz%'
          AND COALESCE(l.email, '') <> ?
          AND m.device NOT IN (SELECT device FROM owner_dev)
        GROUP BY m.mood ORDER BY n DESC`
    )
      .bind(from, ownerEmail(env))
      .all();
    moods = results || [];
  } catch {}
  const oggi = new Date().toISOString().slice(0, 10);
  const t = await env.DB.prepare(
    `SELECT COUNT(*) AS n
       FROM moods m LEFT JOIN leads l ON l.device = m.device
      WHERE m.day = ?
        AND m.device NOT LIKE 'zz%'
        AND COALESCE(l.email, '') <> ?
        AND m.device NOT IN (SELECT device FROM owner_dev)`
  )
    .bind(oggi, ownerEmail(env))
    .first()
    .catch(() => null);
  return json({ moods, today: Number(t?.n) || 0, days });
}

/* ---------- router ---------- */

async function api(request, env, url, ctx) {
  const parts0 = url.pathname.split("/").filter(Boolean);
  const bucket = limitFor(parts0, request.method);
  if (bucket) {
    const [max, win] = LIMITS[bucket];
    if (tooMany(bucket + "|" + clientIp(request), max, win)) {
      return json({ error: "Troppe richieste di fila. Riprova tra qualche minuto." }, 429);
    }
  }
  await initDb(env);

  const method = request.method;
  const parts = url.pathname.split("/").filter(Boolean);
  const origin = url.origin;

  if (method !== "GET" && !sameOrigin(request)) {
    return json({ error: "Origine non consentita." }, 403);
  }

  if (parts[1] === "saved") {
    if (method === "GET") return savedList(env, url);
    if (method === "POST") return savedSet(env, request);
    return bad("method");
  }

  if (parts[1] === "appnotif" && method === "GET") {
    return appNotif(env, url);
  }

  if (parts[1] === "stats" && method === "GET") {
    if (!(await adminOk(env, url))) return json({ error: "Non trovato." }, 404);
    return stats(env);
  }
  if (parts[1] === "track" && method === "POST") return trackHit(env, request);
  if (parts[1] === "friction" && method === "POST") return trackFriction(env, request);
  // traccia dell'avvio: serve a capire perché a volte l'app si chiude da sola
  if (parts[1] === "boot" && method === "POST") {
    const b = (await request.json().catch(() => null)) || {};
    const id = String(b.id || "").slice(0, 24);
    const ev = String(b.event || "").slice(0, 16).replace(/[^a-z]/gi, "");
    if (!id || !ev) return json({ ok: false });
    const now2 = Date.now();
    const day2 = new Date(now2).toISOString().slice(0, 10);
    await env.DB.prepare(`INSERT OR REPLACE INTO boots (day, boot, event, ms, mode, ua, at) VALUES (?,?,?,?,?,?,?)`)
      .bind(day2, id, ev, Math.min(Number(b.ms) || 0, 600000), String(b.mode || "").slice(0, 8), String(request.headers.get("user-agent") || "").slice(0, 120), now2)
      .run().catch(() => {});
    return json({ ok: true });
  }

  if (parts[1] === "presence" && method === "POST") return presencePing(env, request);
  if (parts[1] === "ask" && method === "POST") return askGemini(env, request);
  if (parts[1] === "askstream" && method === "POST") return askGeminiStream(env, request);
  if (parts[1] === "azione" && method === "POST") return azioneAI(env, request, origin);
  if (parts[1] === "speak" && method === "POST") return speakText(env, request);
  if (parts[1] === "stt" && method === "POST") return speechToText(env, request);
  if (parts[1] === "geo" && method === "GET") return geocode(env, url);
  DB = env.DB;
  if (parts[1] === "where" && method === "GET") return whereAt(url);
  if (parts[1] === "weather" && method === "GET") return weather(url);
  if (parts[1] === "extras" && method === "GET") return listExtras(env);
  if (parts[1] === "extras" && method === "DELETE") {
    const key = url.searchParams.get("key") || "";
    if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return json({ error: "no" }, 403);
    const value = (url.searchParams.get("value") || "").slice(0, 40);
    if (!value) return bad("value");
    await env.DB.prepare(`DELETE FROM extras WHERE value = ?`).bind(value).run();
    return json({ ok: true });
  }
  if (parts[1] === "map") {
    if (parts[2] === "ping" && method === "POST") return mapPing(env, request);
    if (parts[2] === "people" && method === "GET") return mapNearby(env, url);
    if (method === "GET") return mapNearby(env, url);
  }
  if (parts[1] === "latest" && method === "GET") return latest(env, url);

  if (parts[1] === "owner" && parts[2] === "live" && method === "GET") return liveFeed(env, url, request);

  if (parts[1] === "open" && method === "POST") return noteOpen(env, request);
  if (parts[1] === "sessione" && method === "POST") return noteSessione(env, request);
  if (parts[1] === "unread" && method === "GET") return unread(env, url);

  if (parts[1] === "mutes") {
    const device = (url.searchParams.get("device") || "").slice(0, 64);
    if (method === "GET") return json(await muteInfo(env, device));
    if (method === "POST") return setMute(env, request);
  }
  if (parts[1] === "owner" && parts[2] === "alerts" && method === "GET") return ownerAlerts(env, url);
  if (parts[1] === "mood" && method === "POST") return noteMood(env, request);
  if (parts[1] === "moods" && method === "GET") return moodStats(env, url);
  if (parts[1] === "feedback" && method === "POST") return createFeedback(env, request);
  if (parts[1] === "error" && method === "POST") return autoReport(env, request);
  if (parts[1] === "owner" && parts[2] === "feedback" && (method === "GET" || method === "POST")) {
    if (!(await isOwner(env, url))) return json({ error: "Non trovato." }, 404);
    return ownerFeedback(env, url, request);
  }
  if (parts[1] === "register" && method === "POST") return register(env, request, origin, ctx);
  if (parts[1] === "my-events" && method === "GET") {
    const device = String(url.searchParams.get("device") || "").slice(0, 64);
    if (!device) return json({ events: [] });
    const { results } = await env.DB.prepare(
      `SELECT e.id, e.title, e.starts_at, e.place
         FROM participants p JOIN events e ON e.id = p.event_id
        WHERE p.device = ? AND p.status = 'going'
        ORDER BY e.starts_at DESC LIMIT 40`
    ).bind(device).all();
    return json({
      events: (results || []).map((r) => ({ id: r.id, title: r.title, startsAt: r.starts_at, place: r.place })),
    });
  }

  if (parts[1] === "feed" && method === "GET") return feed(env, url);
  if (parts[1] === "post") {
    if (parts[2] === "like" && method === "POST") return toggleLike(env, request);
    if (parts[2] === "comments") {
      if (method === "GET") return listComments(env, url);
      if (method === "POST") return addComment(env, request);
    }
    if (!parts[2] && method === "POST") return createPost(env, request);
    if (!parts[2] && method === "DELETE") return deletePost(env, url);
    if (parts[2] === "edit" && method === "POST") return editPost(env, request);
  }
  if (parts[1] === "person" && parts[2] === "past" && method === "GET") return storiaPersona(env, url);
  if (parts[1] === "login" && method === "POST") return login(env, request);
  if (parts[1] === "forgot" && method === "POST") return forgot(env, request);
  if (parts[1] === "reset" && method === "POST") return resetPassword(env, request);
  if (parts[1] === "owner" && parts[2] === "stats" && method === "GET") {
    if (!(await isOwner(env, url))) return json({ error: "Non trovato." }, 404);
    return ownerStats(env, url);
  }
  if (parts[1] === "owner" && parts[2] === "people" && method === "GET") {
    if (!(await isOwner(env, url))) return json({ error: "Non trovato." }, 404);
    return ownerPeople(env);
  }
  if (parts[1] === "owner" && parts[2] === "push" && method === "GET") {
    if (!(await isOwner(env, url))) return json({ error: "Non trovato." }, 404);
    return ownerPush(env);
  }
  if (parts[1] === "owner" && parts[2] === "token" && method === "POST") return ownerRefresh(env, request);
  if (parts[1] === "owner" && parts[2] === "photos" && method === "GET") {
    if (!(await isOwner(env, url))) return json({ error: "Non trovato." }, 404);
    return ownerPhotos(env);
  }
  if (parts[1] === "peek" && method === "POST") return notePeek(env, request);
  if (parts[1] === "owner" && method === "POST") return ownerLogin(env, request);
  if (parts[1] === "logout" && method === "POST") return logout(env, request);

  if (parts[1] === "verify") {
    if (parts[2] === "request" && method === "POST") return requestCode(env, request);
    if (parts[2] === "confirm" && method === "POST") return confirmCode(env, request);
  }

  if (parts[1] === "verify" && parts[2] === "face" && method === "POST") return verifyFace(env, request, origin, ctx);

  if (parts[1] === "owner" && parts[2] === "face") {
    if (!(await isOwner(env, url))) return json({ error: "Non trovato." }, 404);
    return ownerFace(env, url, request);
  }

  if (parts[1] === "profile") {
    if (parts[2] === "photo" && method === "POST") return uploadPhoto(env, request, origin, ctx);
    if (method === "GET" && !parts[2]) return getProfile(env, url);
    if (method === "POST" && !parts[2]) return saveProfile(env, request);
  }

  if (parts[1] === "event" && parts[2] === "photo" && method === "POST") return uploadEventPhoto(env, request);

  if (parts[1] === "photo" && method === "GET") return servePhoto(env, parts.slice(2).join("/"), url);

  if (parts[1] === "push") {
    if (parts[2] === "key" && method === "GET") return json({ publicKey: VAPID_PUBLIC, key: VAPID_PUBLIC });
    if (parts[2] === "subscribe" && method === "POST") return pushSubscribe(env, request);
    if (parts[2] === "renew" && method === "POST") return pushRenew(env, request);
    if (parts[2] === "state" && method === "GET") return pushState(env, url);
    if (parts[2] === "test" && method === "POST") return pushTest(env, request, origin);
  }

  if (parts[1] === "version" && method === "GET") return json({ v: CLIENT_V });

  if (parts[1] === "search" && method === "GET") return cerca(env, url);

  if (parts[1] === "past" && method === "GET")
    return url.searchParams.get("full") ? pastRated(env, url) : pastEvents(env, url);
  if (parts[1] === "past" && parts[2] && method === "POST") return updatePast(env, parts[2].slice(0, 40), request);

  if (parts[1] === "rate" && method === "POST") return rateEvent(env, request);

  if (parts[1] === "counts" && method === "GET") return categoryCounts(env, url);

  if (parts[1] === "admin") return admin(env, url, request);

  if (parts[1] === "events") {
    if (parts.length === 2) {
      if (method === "GET") return listEvents(env, url);
      if (method === "POST") return createEvent(env, request, origin, ctx);
    }
    if (parts.length >= 3) {
      const id = parts[2].slice(0, 40);
      const action = parts[3];
      if (method === "GET" && !action) return eventDetail(env, id, url);
      if (action === "messages") {
        const mid = parts[4];
        if (mid && method === "POST" && parts[5] === "react") return reactTo(env, id, mid, request);
        if (mid) return bad("Cosa vuoi fare?");
        if (method === "GET") return listMessages(env, id, url);
        if (method === "POST") return postMessage(env, id, request, origin, ctx);
      }
      if (method === "POST" && action === "typing") return setTyping(env, id, request);
      if (method === "POST" && action === "join") return joinEvent(env, id, request, origin, ctx);
      if (method === "POST" && action === "leave") return leaveEvent(env, id, request);
      if (method === "POST" && action === "decide") return decideRequest(env, id, request, origin, ctx);
      if (method === "DELETE" && !action) return deleteEvent(env, id, request, ctx);
      if ((method === "PUT" || method === "PATCH") && !action) return updateEvent(env, id, request);
    }
  }

  return json({ error: "Non trovato." }, 404);
}

// l'app stessa manda qui gli errori che le scappano: così si vedono senza che nessuno scriva
/* ---------- segnalazioni che si sistemano da sole ---------- */

// Le famiglie di errore che so riconoscere. Se una famiglia compare qui con un numero
// di versione, vuol dire che quella toppa è già dentro l'app: al primo avvio dopo il
// deploy tutte le segnalazioni aperte di quella famiglia si chiudono da sole,
// senza che il padrone debba premere niente.
const SISTEMATE = {
  notifica: 249, // avvisi: permesso chiesto dall'app, invii tracciati, errori raccolti
};
const ARCHIVIA_DOPO = 30 * 24 * 60 * 60 * 1000; // un mese senza che ricapiti

function classeErrore(msg) {
  const m = String(msg || "").toLowerCase();
  if (/notifica|notification|service worker|push/.test(m)) return "notifica";
  if (/cannot read propert|undefined is not|has no properties|of null|is not a function/.test(m)) return "dato";
  if (/failed to fetch|networkerror|load failed|network request failed|offline/.test(m)) return "rete";
  if (/quotaexceeded|quota exceeded|storage full|no space/.test(m)) return "memoria";
  if (/timeout|timed out|abort/.test(m)) return "tempo";
  return "altro";
}

// Chiude quelle già sistemate e archivia quelle ferme da un mese. Nulla sparisce:
// restano tutte nella linguetta "Risolti", con scritto chi le ha chiuse e perché.
async function sistemaSegnalazioni(env) {
  const ora = Date.now();
  // le vecchie non hanno la famiglia: la ricavo dal testo, così valgono anche loro
  const vecchie = await env.DB.prepare(
    `SELECT id, text FROM feedback WHERE kind = 'auto' AND COALESCE(classe, '') = '' LIMIT 500`
  )
    .all()
    .catch(() => ({ results: [] }));
  for (const r of vecchie.results || []) {
    await env.DB.prepare(`UPDATE feedback SET classe = ? WHERE id = ?`)
      .bind(classeErrore(r.text), r.id)
      .run()
      .catch(() => {});
  }

  let chiuse = 0;
  for (const [classe, versione] of Object.entries(SISTEMATE)) {
    const r = await env.DB.prepare(
      `UPDATE feedback SET stato = 'risolta', azione = 'auto', azione_at = ?,
         risposta = ? WHERE kind = 'auto' AND stato <> 'risolta' AND classe = ?`
    )
      .bind(ora, `nella versione ${versione}: non devi fare niente.`, classe)
      .run()
      .catch(() => null);
    chiuse += Number(r?.meta?.changes) || 0;
  }
  const ferme = await env.DB.prepare(
    `UPDATE feedback SET stato = 'risolta', azione = 'auto', azione_at = ?,
       risposta = 'Archiviata da sola: da un mese non si è più presentata.'
     WHERE kind = 'auto' AND stato <> 'risolta' AND created_at < ?`
  )
    .bind(ora, ora - ARCHIVIA_DOPO)
    .run()
    .catch(() => null);
  chiuse += Number(ferme?.meta?.changes) || 0;
  return chiuse;
}

// Ogni errore raccolto da sola diventa una riga che si spiega: cosa succede, perché,
// e cosa serve fare. "auto" vuol dire che posso sistemarlo io senza cambiare idea all'app,
// "scelta" vuol dire che serve una decisione del padrone prima di toccare qualcosa.
function diagnosiErrore(msg, where) {
  const m = String(msg || "").toLowerCase();
  const dove = String(where || "");
  if (/notifica|notification/.test(m)) {
    return {
      cosa: "Un avviso non è riuscito a comparire sul telefono, anche se il sito l'aveva mandato.",
      perche: "Android blocca gli avvisi quando il permesso è spento, quando il telefono è in risparmio energetico o quando il sistema li scarta per conto suo.",
      come: "L'app chiede il permesso all'avvio e ogni rifiuto resta scritto qui: se il numero cresce, il blocco è nelle impostazioni del telefono, non nel sito. Quando è il telefono, lo dico chiaro invece di far finta di niente.",
      soluzione: "auto",
    };
  }
  if (/cannot read propert|undefined is not|has no properties|of null/.test(m)) {
    return {
      cosa: "Una parte della schermata non era ancora pronta quando qualcuno l'ha toccata, e l'app ha provato a leggerla lo stesso.",
      perche: "Un dato che arriva dopo (un evento, una persona, una foto) veniva usato prima di essere arrivato: da soli in casa non succede, succede con la rete lenta.",
      come: "Metto il controllo prima di ogni uso di quel dato: se manca, la parte si salta e l'app resta in piedi invece di fermarsi.",
      soluzione: "auto",
    };
  }
  if (/failed to fetch|networkerror|load failed|network request failed|offline/.test(m)) {
    return {
      cosa: "La rete è caduta nel momento esatto in cui l'app stava chiedendo qualcosa.",
      perche: "Telefono in ascensore, wifi che salta, o passaggio da wifi a dati.",
      come: "L'app già riprova da sola una volta; se succede ancora mostro un avviso chiaro invece di una schermata vuota.",
      soluzione: "auto",
    };
  }
  if (/quotaexceeded|quota exceeded|storage full|no space/.test(m)) {
    return {
      cosa: "La memoria del telefono dove l'app tiene le cose era piena.",
      perche: "Foto e dati salvati in locale si accumulano e il browser chiude i rubinetti.",
      come: "Butto via le copie vecchie e tengo solo quello che serve; si pulisce da sola.",
      soluzione: "auto",
    };
  }
  if (/script error/.test(m)) {
    return {
      cosa: "Un pezzo di codice esterno ha dato errore senza dire dove né cosa.",
      perche: "Il browser nasconde i dettagli degli script che non sono del tuo sito.",
      come: "Mi serve sapere la schermata e il gesto: senza quello sto indovinando. Se vuoi, dimmi cosa stavi facendo.",
      soluzione: "scelta",
    };
  }
  if (/timeout|timed out|abort/.test(m)) {
    return {
      cosa: "Una richiesta ci ha messo troppo e l'app l'ha interrotta.",
      perche: "Il server o la rete erano lenti in quel momento.",
      come: "Alzo il tempo di attesa dove serve e riprovo una volta in più prima di arrendermi.",
      soluzione: "auto",
    };
  }
  return {
    cosa: `Errore non ancora riconosciuto${dove ? ` (in ${dove})` : ""}.`,
    perche: "Non ho abbastanza dettagli per dire con sicurezza da dove viene.",
    come: "Se mi dici cosa stavi facendo e su quale schermata, lo trovo e lo sistemo. Se intanto capita di nuovo, lo riprendo da qui.",
    soluzione: "scelta",
  };
}

async function autoReport(env, request) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ ok: false });
  const msg = String(body.msg || "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (msg.length < 4) return json({ ok: false });
  const where = String(body.where || "").slice(0, 80);
  const path = String(body.path || "").slice(0, 120);
  const version = String(body.version || "").slice(0, 12);
  const device = String(body.device || "").slice(0, 64);
  const email = isEmail(body.email);
  const firma = `${msg.slice(0, 120)}|${where}`.slice(0, 200);
  const now = Date.now();

  // la stessa cosa non la riporto mille volte: se l'ho già vista da poco, la salto
  const gia = await env.DB.prepare(
    `SELECT id FROM feedback WHERE kind = 'auto' AND text LIKE ? AND created_at > ? LIMIT 1`
  )
    .bind(`%${firma.slice(0, 60)}%`, now - 12 * 60 * 60 * 1000)
    .first()
    .catch(() => null);
  if (gia) return json({ ok: true, skip: true });

  const d = diagnosiErrore(msg, where);
  const classe = classeErrore(msg);
  await env.DB.prepare(
    `INSERT INTO feedback (text, email, device, city, mood, path, kind, stato, diagnosi, soluzione, classe, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, 'auto', 'nuova', ?, ?, ?, ?)`
  )
    .bind(
      `[${firma}] ${path} v${version}`,
      email,
      device,
      CITY,
      path,
      JSON.stringify(d),
      d.soluzione,
      classe,
      now
    )
    .run()
    .catch(() => {});

  // se la famiglia è già sistemata, la nuova arriva con la data dentro: o la toppa
  // non basta, o è un'altra cosa. In entrambi i casi resta aperta e la guardo.
  if (SISTEMATE[classe]) {
    await env.DB.prepare(`UPDATE feedback SET stato = 'nuova' WHERE created_at = ? AND kind = 'auto' AND classe = ?`)
      .bind(now, classe)
      .run()
      .catch(() => {});
  }

  // un avviso al padrone, al massimo uno all'ora: così lo sa anche con l'app chiusa
  try {
    const ultimo = await env.DB.prepare(`SELECT v FROM meta WHERE k = 'seg_push'`).first();
    if (!ultimo || now - Number(ultimo.v) > 60 * 60 * 1000) {
      await env.DB.prepare(`INSERT INTO meta (k, v) VALUES ('seg_push', ?) ON CONFLICT(k) DO UPDATE SET v = ?`)
        .bind(String(now), String(now))
        .run();
      const origin = new URL(request.url).origin;
      await notifyOwner(
        env,
        { title: "C'è una segnalazione nuova", body: String(d.cosa || msg).slice(0, 150), url: "/?segnalazioni=1" },
        origin,
        null
      );
    }
  } catch {}

  return json({ ok: true });
}

// Le segnalazioni, per il padrone. Ognuna ha uno stato chiaro:
//   nuova     = da risolvere
//   sospesa   = in sospeso, aspetta una decisione o un lavoro mio
//   risolta   = fatto
// E può portare una richiesta: "torna come prima", "modifica così" (con le sue parole),
// oppure "approva". Quelle richieste restano scritte e le leggo la prossima volta che mi scrive.
async function ownerFeedback(env, url, request) {
  if (request.method === "POST") {
    const body = await request.json().catch(() => null);
    const id = Number(body?.id) || 0;
    if (!id) return bad("id");
    const azione = ["", "indietro", "modifica", "approva", "scarta", "letto"].includes(String(body?.azione ?? ""))
      ? String(body?.azione ?? "")
      : "";
    let stato = ["nuova", "vista", "sospesa", "risolta"].includes(String(body?.stato || "")) ? String(body.stato) : "";
    const risposta = String(body?.risposta || "").replace(/\s+/g, " ").trim().slice(0, 600);
    // la richiesta decide lo stato: quello che chiede lui vale più del tasto premuto
    if (azione === "indietro" || azione === "modifica" || azione === "approva") stato = "sospesa";
    if (azione === "scarta") stato = "risolta";
    if (!stato && !azione && !risposta) return bad("niente da cambiare");
    const ora = Date.now();
    await env.DB.prepare(
      `UPDATE feedback SET
         stato = COALESCE(NULLIF(?, ''), stato),
         azione = COALESCE(NULLIF(?, ''), azione),
         azione_at = CASE WHEN ? <> '' THEN ? ELSE azione_at END,
         risposta = CASE WHEN ? <> '' THEN ? ELSE risposta END
       WHERE id = ?`
    )
      .bind(stato, azione, azione, ora, risposta, risposta, id)
      .run()
      .catch(async () => {
        await env.DB.prepare(`UPDATE feedback SET stato = ? WHERE id = ?`).bind(stato || "nuova", id).run();
      });
    return json({ ok: true });
  }

  const rows = await env.DB.prepare(
    `SELECT f.id, f.text, f.email, f.device, f.path, f.kind, f.stato, f.created_at, f.mood,
            f.diagnosi, f.soluzione, f.risposta, f.azione, f.azione_at, f.classe,
            l.first_name, l.last_name, l.photo
     FROM feedback f LEFT JOIN leads l ON (l.email = f.email OR (f.device <> '' AND l.device = f.device))
     ORDER BY f.created_at DESC LIMIT 120`
  )
    .all()
    .catch(() => ({ results: [] }));

  const lista = (rows.results || []).map((f) => {
    let d = null;
    try { d = f.diagnosi ? JSON.parse(f.diagnosi) : null; } catch {}
    return {
      id: f.id,
      testo: f.text || "",
      chi: [f.first_name, f.last_name].filter(Boolean).join(" ") || f.email || (f.device ? "senza nome" : "anonimo"),
      email: f.email || "",
      foto: f.photo ? `/api/photo/${f.photo}` : "",
      tipo: f.kind || "altro",
      stato: f.stato || "nuova",
      dove: f.path || "",
      quando: f.created_at || null,
      voto: f.mood || null,
      cosa: d?.cosa || "",
      perche: d?.perche || "",
      come: d?.come || "",
      soluzione: f.soluzione || d?.soluzione || "",
      classe: f.classe || "",
      risposta: f.risposta || "",
      azione: f.azione || "",
      azioneQuand: f.azione_at || null,
    };
  });
  const conta = (s) => lista.filter((x) => x.stato === s).length;
  return json({
    segnalazioni: lista,
    conteggi: {
      nuove: conta("nuova"),
      sospese: conta("sospesa"),
      risolte: conta("risolta"),
      errori: lista.filter((s) => s.tipo === "auto" && s.stato !== "risolta").length,
      totali: lista.length,
      mie: lista.filter((s) => s.azione && s.stato !== "risolta").length,
    },
  });
}

/* ---------- un promemoria al giorno, senza stressare nessuno ---------- */

const REMIND = {
  it: { title: "Cosa ti va di fare oggi?", body: "Due minuti e vedi chi c'è stasera qui intorno. Se non ti va, salta: non insisto." },
  en: { title: "What are you up to today?", body: "Two minutes and you'll see who's out tonight nearby. If you're not in the mood, skip it." },
  es: { title: "¿Qué te apetece hacer hoy?", body: "Dos minutos y ves quién está esta noche por aquí. Si no te apetece, pásalo." },
  pt: { title: "O que te apetece fazer hoje?", body: "Dois minutos e vê quem está esta noite por perto. Se não te apetecer, ignora." },
};

// chi ha messo la foto ma non ha verificato il viso: un promemoria al giorno
async function remindUnverified(env, origin) {
  const { results } = await env.DB.prepare(
    `SELECT p.endpoint AS endpoint, p.device AS device
     FROM push_subs p JOIN leads l ON l.device = p.device
     WHERE l.photo IS NOT NULL AND l.photo != '' AND COALESCE(l.verified_face, 0) = 0`
  ).all();
  const endpoints = (results || []).map((r) => r.endpoint).filter(Boolean);
  if (!endpoints.length) return 0;
  return deliverEndpoints(
    env,
    [...new Set(endpoints)],
    {
      title: "Ti manca un passaggio",
      body: "Hai la foto, ma non hai verificato il viso: senza la verifica non puoi creare eventi né partecipare. Due minuti dal profilo.",
      url: "/?verify=1",
    },
    origin
  );
}

async function remindEveryone(env, origin) {
  const { results } = await env.DB.prepare(
    `SELECT p.endpoint AS endpoint, p.device AS device, l.locale AS locale
     FROM push_subs p LEFT JOIN leads l ON l.email = p.email`
  ).all();
  const rows = results || [];
  if (!rows.length) return 0;
  const muted = new Set(
    (((await env.DB.prepare(`SELECT device FROM mutes WHERE scope = 'all' AND (until = 0 OR until > ?)`).bind(Date.now()).all()).results) || []).map((r) => r.device)
  );
  const byLocale = {};
  for (const r of rows) {
    if (!r.endpoint || muted.has(r.device)) continue;
    const key = REMIND[r.locale] ? r.locale : "it";
    (byLocale[key] = byLocale[key] || []).push(r.endpoint);
  }
  let sent = 0;
  for (const [key, eps] of Object.entries(byLocale)) {
    sent += await deliverEndpoints(env, eps, { ...REMIND[key], url: "/" }, origin);
  }
  return sent;
}

// quando qualcuno incolla un link d'evento (WhatsApp, Instagram, Telegram)
// l'anteprima deve dire cosa è, non una frase generica
function escAttr(v) {
  return String(v || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function setMeta(html, key, value) {
  const re = new RegExp('(<meta\\s+(?:property|name)="' + key + '"\\s+content=")[^"]*(")', "i");
  if (!re.test(html)) return html;
  return html.replace(re, `$1${escAttr(value)}$2`);
}

async function sharePage(env, request, url) {
  const eid = (url.searchParams.get("e") || "").slice(0, 40);
  const assetUrl = new URL("/index.html", url.origin);
  const res = await env.ASSETS.fetch(new Request(assetUrl.toString(), { headers: request.headers }));
  let html = await res.text();
  const htmlOut = (h) =>
    new Response(h, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=60",
      },
    });

  if (!eid) return htmlOut(html);
  const row = await env.DB.prepare(`SELECT id, title, place, starts_at, access FROM events WHERE id = ?`)
    .bind(eid)
    .first()
    .catch(() => null);
  if (!row) return htmlOut(html);

  const priv = (row.access || "open") === "invite";
  const quando = new Date(Number(row.starts_at) || Date.now()).toLocaleString("it-IT", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Rome",
  });
  const title = `${row.title} · ${priv ? "invito su FUORI" : "su FUORI"}`;
  const desc = priv
    ? `${quando} · indirizzo nascosto · si entra solo con l'invito`
    : `${quando}${row.place ? " · " + row.place : ""}`;
  const img = `${url.origin}${priv ? "/og-invito.png" : "/og.png"}`;
  const code = url.searchParams.get("invite");
  const shareUrl = `${url.origin}/?e=${encodeURIComponent(row.id)}${priv && code ? "&invite=" + encodeURIComponent(code) : ""}`;

  html = html.replace(/<title>[^<]*<\/title>/i, `<title>${escAttr(title)}</title>`);
  html = setMeta(html, "og:title", title);
  html = setMeta(html, "og:description", desc);
  html = setMeta(html, "og:url", shareUrl);
  html = setMeta(html, "og:image", img);
  html = setMeta(html, "twitter:title", title);
  html = setMeta(html, "twitter:description", desc);
  html = setMeta(html, "twitter:image", img);
  return htmlOut(html);
}

/* ---------- i preferiti che stanno per cominciare ---------- */
const SAVED_TXT = {
  it: { t: "Il tuo evento si avvicina", q: (o) => (o <= 12 ? "oggi" : o <= 36 ? "domani" : `tra ${Math.round(o / 24)} giorni`), b: "Se non puoi andare, toglilo dai preferiti." },
  en: { t: "Your saved event is coming up", q: (o) => (o <= 12 ? "today" : o <= 36 ? "tomorrow" : `in ${Math.round(o / 24)} days`), b: "If you can't make it, remove it from your saved." },
  es: { t: "Tu evento guardado se acerca", q: (o) => (o <= 12 ? "hoy" : o <= 36 ? "mañana" : `dentro de ${Math.round(o / 24)} días`), b: "Si no puedes ir, quítalo de guardados." },
  pt: { t: "O seu evento guardado está a chegar", q: (o) => (o <= 12 ? "hoje" : o <= 36 ? "amanhã" : `daqui a ${Math.round(o / 24)} dias`), b: "Se não puder ir, remova-o dos guardados." },
};

async function remindSaved(env, origin) {
  await ensureSaved(env).catch(() => {});
  await ensureNotif(env).catch(() => {});
  const now = Date.now();
  let righe = [];
  try {
    righe = (
      await env.DB.prepare(
        `SELECT s.device AS device, e.id AS id, e.title AS title, e.starts_at AS starts_at, e.place AS place,
                COALESCE(e.access, 'open') AS access
         FROM saved s JOIN events e ON e.id = s.event_id
         WHERE e.starts_at > ? AND e.starts_at <= ?
         ORDER BY e.starts_at ASC LIMIT 400`
      )
        .bind(now + 15 * 60e3, now + 30 * 3600e3)
        .all()
    ).results || [];
  } catch {
    return 0;
  }
  if (!righe.length) return 0;
  const subs = ((await env.DB.prepare(
    `SELECT p.endpoint AS endpoint, p.device AS device, l.locale AS locale
     FROM push_subs p LEFT JOIN leads l ON l.email = p.email`
  ).all()).results || []).filter((r) => r.endpoint);
  if (!subs.length) return 0;
  const muted = new Set(
    (((await env.DB.prepare(`SELECT device FROM mutes WHERE scope = 'all' AND (until = 0 OR until > ?)`).bind(now).all()).results) || []).map((r) => r.device)
  );
  const perTelefono = new Map();
  let sent = 0;
  for (const r of righe) {
    const miei = subs.filter((s) => s.device === r.device && !muted.has(s.device));
    if (!miei.length) continue;
    const gia = await env.DB.prepare(`SELECT 1 AS x FROM notif_sent WHERE chi = ? AND k = ?`)
      .bind("d:" + r.device, "sv:" + r.id)
      .first();
    if (gia) continue;
    const quanti = (perTelefono.get(r.device) || 0) + 1;
    if (quanti > 2) continue;
    perTelefono.set(r.device, quanti);
    const L = SAVED_TXT[String(miei[0].locale || "it").slice(0, 2)] || SAVED_TXT.it;
    const ore = Math.max(1, Math.round((r.starts_at - now) / 3600e3));
    const quando = `${L.q(ore)} ${new Date(r.starts_at).toLocaleTimeString("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" })}`;
    const dove = r.access === "invite" ? "su invito" : String(r.place || "");
    sent += await deliverEndpoints(
      env,
      [...new Set(miei.map((s) => s.endpoint))],
      { title: `${L.t}: ${r.title}`, body: `${quando}${dove ? " · " + dove : ""}. ${L.b}`, url: "/?e=" + r.id },
      origin
    );
    await env.DB.prepare(`INSERT OR IGNORE INTO notif_sent (chi, k, at) VALUES (?, ?, ?)`)
      .bind("d:" + r.device, "sv:" + r.id, now)
      .run()
      .catch(() => {});
  }
  return sent;
}

export default {
  async scheduled(event, env, ctx) {
    const SITO = "https://fuori.fuori-catania.workers.dev";
    // ogni mezz'ora: i promemoria degli eventi salvati che stanno per cominciare
    ctx.waitUntil(cleanOldEvents(env).catch(() => 0));
    ctx.waitUntil(remindSaved(env, SITO).catch(() => 0));
    // una volta al giorno alle 9: "cosa ti va di fare oggi?" e il promemoria verifica
    if (!event.cron || event.cron === "0 9 * * *") {
      ctx.waitUntil(remindEveryone(env, SITO).catch(() => 0));
      ctx.waitUntil(remindUnverified(env, SITO).catch(() => 0));
    }
    // i miei telefoni restano fuori dai numeri anche se registro un telefono nuovo
    ctx.waitUntil(ensureIgnora(env).then(() => sincronizzaMiei(env)).catch(() => 0));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // link d'evento o d'invito incollato da qualche parte: anteprima su misura
    if (
      request.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/index.html") &&
      url.searchParams.get("e")
    ) {
      return sharePage(env, request, url);
    }
    // il file che dice a Chrome "questa app è davvero di questo sito"
    if (url.pathname === "/.well-known/assetlinks.json") {
      return new Response(
        JSON.stringify([
          {
            relation: ["delegate_permission/common.handle_all_urls"],
            target: {
              namespace: "android_app",
              package_name: "it.fuori.app",
              sha256_cert_fingerprints: [
                "6B:17:69:9A:77:95:12:15:E4:59:2E:73:73:73:BD:A7:B6:7A:D7:23:A8:63:78:E1:67:EC:FA:1A:53:B9:62:73",
              ],
            },
          },
        ]),
        { headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" } }
      );
    }
    if (url.pathname === "/fuori.apk") {
      try {
        await initDb(env);
        await noteDownload(env, request, url);
      } catch {}
    }
    if (url.pathname.startsWith("/api/")) {
      try {
        return await api(request, env, url, ctx);
      } catch (err) {
        console.error("api", err);
        return json({ error: "server" }, 500);
      }
    }
    let res;
    try {
      res = await env.ASSETS.fetch(request);
    } catch {
      // l'unica cosa peggiore di un errore è una pagina bianca
      return new Response(
        '<!doctype html><html lang="it"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FUORI</title><body style="background:#0a0a0a;color:#fff;font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;text-align:center"><div><p style="font-size:20px;font-weight:700;margin:0 0 10px">Un attimo</p><p style="opacity:.7;margin:0 0 20px">Ricarica tra un secondo.</p><button onclick="location.reload()" style="background:#d7ff3e;color:#0a0a0a;border:0;border-radius:999px;padding:14px 26px;font-weight:800;font-size:16px">Ricarica</button></div></body></html>',
        { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
      );
    }
    const headers = new Headers(res.headers);
    // il file dell'app: il browser deve scaricarlo, non provare ad aprirlo
    if (url.pathname === "/fuori.apk") {
      headers.set("content-type", "application/vnd.android.package-archive");
      headers.set("content-disposition", 'attachment; filename="FUORI.apk"');
      headers.set("cache-control", "no-store");
    }
    // paletti al browser: niente script da fuori, niente trappole sui tipi
    headers.set("x-content-type-options", "nosniff");
    headers.set("x-frame-options", "DENY");
    headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
    headers.set("cross-origin-opener-policy", "same-origin");
    headers.set("referrer-policy", "strict-origin-when-cross-origin");
    headers.set("permissions-policy", "geolocation=(self), microphone=(self), camera=(self)");
    headers.set(
      "content-security-policy",
      "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; " +
        "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; " +
        "connect-src 'self' blob: https://cloudflareinsights.com; media-src 'self' blob:; manifest-src 'self'; " +
        "frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'"
    );
    // la pagina e il suo indice non si tengono mai in cache: se cambia, si vede subito
    if (url.pathname === "/" || url.pathname === "/index.html") headers.set("cache-control", "no-cache");
    if (!headers.has("cache-control")) {
      // quello che ha il numero di versione nell'indirizzo non cambia più: si tiene per un anno
      const versioned = url.searchParams.has("v") && /\.(js|css|png|json|webmanifest)$/.test(url.pathname);
      headers.set(
        "cache-control",
        versioned ? "public, max-age=31536000, immutable" : "public, max-age=300, stale-while-revalidate=86400"
      );
    }
    return new Response(res.body, { status: res.status, headers });
  },
};
