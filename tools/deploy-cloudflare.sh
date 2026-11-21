#!/usr/bin/env bash
# Pubblica FUORI sull'account Cloudflare dell'utente.
# Serve un token API in .cf-token (una riga sola) oppure in CLOUDFLARE_API_TOKEN.
set -euo pipefail
cd "$(dirname "$0")/.."

export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-379873b2dba7c5687bc217d5911f62f8}"
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && [ -f .cf-token ]; then
  CLOUDFLARE_API_TOKEN="$(tr -d '\n\r ' < .cf-token)"
  export CLOUDFLARE_API_TOKEN
fi
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "ERRORE: manca il token API (file .cf-token)"
  exit 1
fi

WR="npx --yes wrangler@4"

# 1) database D1
DB_ID="$($WR d1 list --json 2>/dev/null | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try { const list=JSON.parse(s); const f=list.find(x=>x.name==="fuori"); console.log(f?f.uuid:""); } catch { console.log(""); }
});')"

if [ -z "$DB_ID" ]; then
  echo "→ creo il database D1 \"fuori\""
  $WR d1 create fuori >/dev/null
  DB_ID="$($WR d1 list --json 2>/dev/null | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    try { const list=JSON.parse(s); const f=list.find(x=>x.name==="fuori"); console.log(f?f.uuid:""); } catch { console.log(""); }
  });')"
fi
if [ -z "$DB_ID" ]; then
  echo "ERRORE: non riesco a creare/trovare il database D1"
  exit 1
fi
echo "→ database D1: $DB_ID"

# scrivo l'id nella configurazione (idempotente)
node -e '
const fs=require("fs");
const id=process.argv[1];
let t=fs.readFileSync("wrangler.toml","utf8");
t=t.replace(/database_id = "[^"]*"/, `database_id = "${id}"`);
fs.writeFileSync("wrangler.toml",t);
' "$DB_ID"

# 2) bucket R2 per le foto
$WR r2 bucket create fuori-files >/dev/null 2>&1 || echo "→ bucket R2 già presente (o R2 non attivo: va attivato dal dashboard)"

# 3) build del sito statico e pubblicazione
node tools/build-content.js >/dev/null
./build.sh >/dev/null
$WR deploy

echo "Fatto. Indirizzo: https://fuori.<sottodominio>.workers.dev"
