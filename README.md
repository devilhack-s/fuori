# FUORI — codice sorgente completo

Questo repository contiene **tutto il codice di FUORI**: il sito/app web, il server che gira su Cloudflare, i contenuti editoriali e il progetto Android dell'app installabile.

Versione attuale del client: **560**.

- Sito in produzione: https://fuori.fuori-catania.workers.dev
- App Android: scaricabile dal sito (`/fuori.apk`), progetto sorgente in `android/`

## Com'è fatto

| Cartella / file | Cosa contiene |
| --- | --- |
| `worker.js` | Tutto il server: API, database, immagini, notifiche, assistente. Crea e aggiorna da solo le tabelle del database (`SCHEMA_V = 13`). |
| `src/app.js` | Tutta l'interfaccia dell'app (un unico file, viene minificato nella build). |
| `content/` | I testi dell'app e delle attività (file `.txt` con campi separati da `|`). |
| `public/` | Quello che viene pubblicato: `index.html`, `styles.css`, icone, immagini, traduzioni (`lang/`), APK, mappa (Leaflet). |
| `tools/` | Script di build: `build-content.js` (testi → JSON), regole di stagione/umore, generazione icone. |
| `android/` | Progetto Android (WebView + notifiche) per generare l'APK. |
| `build.sh` | Build: rigenera i contenuti, minifica `src/app.js` in `public/app.min.js` e allinea i numeri di versione. |
| `wrangler.toml` | Configurazione Cloudflare: database D1 `fuori`, sito statico, cron giornaliero. |
| `deploy.json` | Manifest usato dal deploy (worker + cartella `public/`). |

## Come si costruisce e si pubblica

Serve [Node.js](https://nodejs.org) (18 o superiore) e un token API di Cloudflare.

```bash
./build.sh                      # rigenera contenuti + app.min.js + versioni
npx --yes wrangler@4 deploy     # pubblica su Cloudflare
```

Il deploy usa queste variabili:

```bash
export CLOUDFLARE_ACCOUNT_ID=379873b2dba7c5687bc217d5911f62f8
export CLOUDFLARE_API_TOKEN=...        # oppure metti il token in .cf-token
```

In alternativa: `tools/deploy-cloudflare.sh` fa build + deploy e, se serve, crea il database.

Database D1: nome `fuori`, id `4c79ee68-51de-4ee7-8af6-22a7d1e85280`.
Le tabelle le crea il worker al primo avvio: non serve lanciare SQL a mano.

Interrogare i dati:

```bash
npx --yes wrangler@4 d1 execute fuori --remote --command "SELECT count(*) FROM participants"
```

## Segreti (NON stanno in questo repository)

Per scelta non sono versionati, perché chiunque legga il repository potrebbe usarli:

- `.cf-token` — token API Cloudflare (pubblica il sito, legge il database)
- `.admin-key` — chiave amministratore dell'app
- `.vapid-private.b64` — chiave per le notifiche push
- `.apk-signing.env` + `.fuori.keystore` — firma dell'APK (serve per aggiornare l'app installata senza disinstallarla)

Sono custoditi a parte (archivio `accessi-fuori-PRIVATO.zip` consegnato insieme a questo codice). Vanno copiati nella cartella del progetto prima del deploy. Se un token viene perso o esposto, si rigenera dal pannello Cloudflare senza toccare il codice.

## Note utili

- Le foto profilo e delle attività sono salvate nel database D1 (tabella `blobs`), non su R2 (disattivato).
- Il numero di versione (`src/app.js` → `const VERSION`, e `worker.js` → `CLIENT_V`) viene allineato automaticamente da `build.sh`: i telefoni si aggiornano da soli quando cambia.
- Il cron in `wrangler.toml` manda un promemoria al giorno alle 9.
- Licenza: vedi `LICENSE` e `NOTICE`.
