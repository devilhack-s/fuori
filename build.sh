#!/bin/bash
# contenuti + client "chiuso": il javascript che esce è minificato
set -e
cd "$(dirname "$0")"
node tools/build-content.js
npx --yes terser src/app.js -c passes=2,pure_getters=true -m --comments false -o public/app.min.js
ls -l src/app.js public/app.min.js | awk '{print $5, $9}'

# la versione del client va anche nel worker: così i telefoni sanno quando aggiornarsi
V=$(sed -n 's/^const VERSION = "\([0-9]*\)";/\1/p' src/app.js | head -1)
if [ -n "$V" ]; then
  sed -i "s/^const CLIENT_V = \"[0-9]*\";/const CLIENT_V = \"$V\";/" worker.js
  # ogni file caricato ha la sua versione: così il telefono non usa mai una copia vecchia
  sed -i "s/?v=[0-9]\+\"/?v=$V\"/g; s/\"fuori-v[0-9]\+\"/\"fuori-v$V\"/" public/index.html public/sw.js
fi
