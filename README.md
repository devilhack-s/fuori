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
| `android/` | App Android nativa (Trusted Web Activity + notifiche e posizione) per generare l'APK. |
| `ios/` | App iPhone (Capacitor 7, apre lo stesso sito). Nuova: non ancora compilata. |
| `.github/workflows/` | Pubblicazione automatica: sito su Cloudflare, app Android su Google Play, app iPhone su TestFlight. |
| `PUBBLICARE.md` | Guida completa: tecnologie, account store, segreti GitHub, come si pubblica. |
| `LAVORA-AL-PROGETTO.md` | Testo pronto da incollare in Claude o Google AI Studio per far lavorare un'altra IA sul progetto. |
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

Per l'app iPhone servono Node.js e CocoaPods su un Mac:

```bash
npm ci
npx cap sync ios
npm run ios:apri      # apre il progetto in Xcode
```

## Pubblicare su GitHub e sugli store

Il repository include tre workflow in `.github/workflows/`:

- `deploy-web.yml` — pubblica sito e server a ogni push su `main`;
- `android.yml` — con un tag `v1.8` compila APK firmato + AAB, carica su Google Play e aggiorna `fuori.apk` sul sito;
- `ios.yml` — con un tag compila l'app iPhone e la carica su TestFlight.

I segreti da impostare, i costi degli account e i passaggi una volta sola sono in [`PUBBLICARE.md`](PUBBLICARE.md).

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
- L'app iPhone apre lo stesso sito: le modifiche al sito si vedono subito anche su iPhone, senza ripubblicare l'app. Le notifiche push però funzionano solo su Android.
- Licenza: vedi `LICENSE` e `NOTICE`.
