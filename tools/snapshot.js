// Scarica l'elenco iscritti e lo salva in ../data/iscritti.csv (solo in locale).
// Uso: node tools/snapshot.js [url]
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const URL_BASE = process.argv[2] || "https://site-f0584112723c40898d830d5242a2cc4f.freebuff.page";
const key = fs.readFileSync(path.join(root, ".admin-key"), "utf8").trim();

const csvCell = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

(async () => {
  const res = await fetch(`${URL_BASE}/api/admin?key=${encodeURIComponent(key)}`);
  if (!res.ok) throw new Error("admin " + res.status);
  const data = await res.json();

  const cols = ["email", "first_name", "last_name", "phone", "age", "sex", "city",
    "email_verified", "phone_verified", "interests", "goals", "meet", "outings", "created_at"];
  const lines = [cols.join(",")];
  for (const l of data.leads || []) {
    lines.push(cols.map((c) => {
      let v = l[c];
      if (c === "created_at" && v) v = new Date(v).toISOString().slice(0, 10);
      if (typeof v === "string" && v.startsWith("[")) {
        try { v = JSON.parse(v).join("; "); } catch {}
      }
      return csvCell(v);
    }).join(","));
  }

  const dir = path.join(root, "..", "data");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "iscritti.csv"), lines.join("\n") + "\n");
  fs.writeFileSync(
    path.join(dir, "conteggio.json"),
    JSON.stringify({ aggiornato: new Date().toISOString(), ...data.stats }, null, 2)
  );
  console.log(JSON.stringify(data.stats));
  console.log(`iscritti salvati: ${(data.leads || []).length}`);
})();
