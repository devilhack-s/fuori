# RIPRISTINO — come riprendere FUORI da zero

Questo file serve a chi (persona o assistente) riprende il progetto senza avere la memoria delle conversazioni precedenti.

## 1. Cosa hai in mano

- Il **codice completo** in questo repository (sito + server + contenuti + progetto Android + progetto iPhone).
- Un archivio separato `accessi-fuori-PRIVATO.zip` con le chiavi e un **backup del database**.
- Il sito online su Cloudflare: https://fuori.fuori-catania.workers.dev

## 2. Dati dell'infrastruttura (non sono segreti)

| Cosa | Valore |
| --- | --- |
| Account Cloudflare | `379873b2dba7c5687bc217d5911f62f8` |
| Worker | `fuori` (URL sopra) |
| Database D1 | nome `fuori`, id `4c79ee68-51de-4ee7-8af6-22a7d1e85280` |
| Bucket R2 | `fuori-files` (creato ma **disattivato**: le foto stanno nel DB) |
| Email amministratore | `christianguarrera@gmail.com` (variabile `ADMIN_EMAIL` in `wrangler.toml`) |
| Versione client | 560 (`src/app.js`, `worker.js` → `CLIENT_V`) |
| Schema DB | `SCHEMA_V = 13`, creato in automatico dal worker |

## 3. Segreti (nell'archivio privato, MAI su GitHub)

| File | A cosa serve |
| --- | --- |
| `.cf-token` | token API Cloudflare: pubblica il sito e legge/scrive il database |
| `.admin-key` | chiave amministratore dentro l'app |
| `.vapid-private.b64` | chiave privata per le notifiche push |
| `.apk-signing.env` | password e alias del keystore |
| `.fuori.keystore` | chiave di firma dell'APK: **senza questa non si possono aggiornare le app già installate** |

Copiali nella cartella del progetto prima di pubblicare. Il deploy dei file non tocca il database: i dati degli utenti restano.

## 4. Primo avvio in locale

```bash
npm install -g wrangler     # oppure usa npx
node tools/build-content.js # testi → JSON
./build.sh                  # minifica l'app e allinea le versioni
npx wrangler@4 dev          # anteprima locale
```

Requisiti: Node 18+.

## 5. Pubblicare una modifica

```bash
./build.sh
CLOUDFLARE_API_TOKEN="$(tr -d '\n\r ' < .cf-token)" \
CLOUDFLARE_ACCOUNT_ID=379873b2dba7c5687bc217d5911f62f8 \
npx --yes wrangler@4 deploy
```

Poi verifica che la versione sia quella nuova:

```bash
curl -s "https://fuori.fuori-catania.workers.dev/api/version?x=$RANDOM"
# → {"v":"560"}
```

Le risposte possono restare in cache per qualche secondo: usa il parametro `?x=` per non leggere una copia vecchia.

## 6. Regole di lavoro sul progetto (importanti)

- `src/app.js` è **un unico file** con tutta l'interfaccia; `public/app.min.js` è generato, non va modificato a mano.
- Ogni modifica visibile deve far salire `VERSION` in `src/app.js`: `build.sh` propaga il numero a `worker.js` (`CLIENT_V`), `public/index.html` e `public/sw.js`. Serve a far aggiornare i telefoni.
- I testi stanno in `content/*.txt` con campi separati da `|` e vengono compilati in `public/activities.json` e nelle traduzioni.
- Le tabelle del database si creano da sole: se aggiungi una tabella, alza `SCHEMA_V` e aggiungi il `CREATE TABLE IF NOT EXISTS` corrispondente.
- Modificare il codice e ripubblicare **non cancella** dati: il deploy carica solo worker e file statici.
- Le foto (profilo, attività, ricordi) sono nella tabella `blobs` del database D1.
- L'app Android punta all'URL di produzione in `android/app/src/main/AndroidManifest.xml` e `android/app/src/main/java/it/fuori/app/NotifCheck.java`; il progetto è una WebView con notifiche e servizio in background.

## 7. Backup del database

L'archivio privato contiene `database-fuori.sql` (schema + dati). Per rifarlo in qualsiasi momento:

```bash
npx --yes wrangler@4 d1 export fuori --remote --output database-fuori.sql
```

Per ripristinarlo su un database nuovo:

```bash
npx --yes wrangler@4 d1 execute fuori --remote --file database-fuori.sql
```

## 8. Cose da sapere che non si vedono nel codice

- La verifica delle foto e le segnalazioni sono gestite dall'admin dentro l'app (chiave in `.admin-key`).
- L'assistente usa il binding `AI` di Cloudflare configurato in `wrangler.toml`.
- Il cron `0 9 * * *` manda un solo promemoria al giorno.
- Il deploy passa dal worker per `/`, `/index.html` e `/fuori.apk` (serve per anteprime social e conteggio download).
