// Converte i file di testo (pipe-separated) in i18n.js e activities.json.
// Uso: node tools/build-content.js
const fs = require("fs");
const path = require("path");
const { seasons } = require("./season-rules.js");
const { moods } = require("./mood-rules.js");

const root = path.join(__dirname, "..");
const content = path.join(root, "content");
const pub = path.join(root, "public");

function readChunks(prefix) {
  return fs
    .readdirSync(content)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".txt"))
    .sort()
    .map((f) => fs.readFileSync(path.join(content, f), "utf8"))
    .join("\n");
}

// ---------- testi ----------
const langs = ["it", "en", "es", "pt"];
const dict = { it: {}, en: {}, es: {}, pt: {} };
let n = 0;
for (const line of readChunks("text-").split("\n")) {
  const clean = line.trim();
  if (!clean || clean.startsWith("#")) continue;
  const parts = clean.split("|");
  if (parts.length < 5) {
    console.error("riga incompleta:", clean.slice(0, 60));
    continue;
  }
  const [key, ...vals] = parts;
  langs.forEach((l, i) => {
    dict[l][key] = vals[i].trim();
  });
  n++;
}
const missing = langs.map((l) => `${l}:${Object.keys(dict[l]).length}`).join(" ");
// una lingua per file: il telefono scarica solo quella che gli serve
fs.mkdirSync(path.join(pub, "lang"), { recursive: true });
for (const l of langs) {
  fs.writeFileSync(
    path.join(pub, "lang", l + ".js"),
    "/* generato - non modificare a mano */\nLANG_DATA=" + JSON.stringify(dict[l]) + ";\n"
  );
}
console.log(`testi: ${n} chiavi (${missing})`, (fs.statSync(path.join(pub, "lang", "it.js")).size / 1024).toFixed(1) + " KB per lingua");

// ---------- attività ----------
const categories = [
  ["sport", "Sport", "Sport", "Deporte", "Esporte"],
  ["sociale", "Incontri", "Social", "Social", "Social"],
  ["cinema", "Cultura e spettacoli", "Culture and shows", "Cultura y espectáculos", "Cultura e espetáculos"],
  ["musica", "Musica", "Music", "Música", "Música"],
  ["serate", "Serate", "Nights out", "Salidas", "Noites"],
  ["giochi", "Giochi", "Games", "Juegos", "Jogos"],
  ["creativita", "Creatività", "Making", "Creatividad", "Criatividade"],
  ["natura", "Aria aperta", "Outdoors", "Aire libre", "Ar livre"],
  ["benessere", "Benessere", "Wellbeing", "Bienestar", "Bem-estar"],
  ["lingue", "Lingue e mente", "Languages and mind", "Idiomas y mente", "Línguas e mente"],
  ["tech", "Tecnologia", "Tech", "Tecnología", "Tecnologia"],
  ["animali", "Animali", "Animals", "Animales", "Animais"],
  ["volontariato", "Comunità", "Community", "Comunidad", "Comunidade"],
  ["viaggi", "Viaggi", "Travel", "Viajes", "Viagens"],
];
const catIds = new Set(categories.map((c) => c[0]));
const activities = [];
const seen = new Set();
for (const line of readChunks("activities-").split("\n")) {
  const clean = line.trim();
  if (!clean || clean.startsWith("#")) continue;
  const [it, cat, en, es, pt] = clean.split("|").map((s) => (s || "").trim());
  if (!it || !catIds.has(cat)) {
    console.error("attività ignorata:", clean.slice(0, 50));
    continue;
  }
  const k = it.toLowerCase();
  if (seen.has(k)) continue;
  seen.add(k);
  const season = seasons(it, cat);
  const item = { it, cat, season: season.season, out: season.out, m: moods(it, cat) };
  if (en) item.en = en;
  if (es) item.es = es;
  if (pt) item.pt = pt;
  if (en && es && pt) item.pop = 1;
  activities.push(item);
}
const out = {
  categories: categories.map(([id, it, en, es, pt]) => ({ id, it, en, es, pt })),
  activities,
};

// ---------- zone (Sicilia) ----------
const zones = [];
try {
  for (const line of fs.readFileSync(path.join(content, "zones-sicilia.txt"), "utf8").split("\n")) {
    const clean = line.trim();
    if (!clean || clean.startsWith("#")) continue;
    const [n, la, lo, acts] = clean.split("|").map((x) => (x || "").trim());
    const lat = Number(la);
    const lng = Number(lo);
    if (!n || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      console.error("zona ignorata:", clean.slice(0, 50));
      continue;
    }
    const good = (acts || "")
      .split(";")
      .map((x) => x.trim())
      .filter((x) => x && seen.has(x.toLowerCase()));
    zones.push({ n, lat, lng, acts: good });
  }
} catch (e) {
  console.error("zone non lette:", e.message);
}
fs.writeFileSync(path.join(pub, "zones.json"), JSON.stringify(zones));
console.log(`zone: ${zones.length}`);
fs.writeFileSync(path.join(pub, "activities.json"), JSON.stringify(out));
const byCat = {};
for (const a of activities) byCat[a.cat] = (byCat[a.cat] || 0) + 1;
console.log(
  `attività: ${activities.length} (${activities.filter((a) => a.pop).length} tradotte)`,
  JSON.stringify(byCat),
  (fs.statSync(path.join(pub, "activities.json")).size / 1024).toFixed(1) + " KB"
);
