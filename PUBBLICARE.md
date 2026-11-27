# PUBBLICARE FUORI — tecnologie, GitHub, Android e iPhone

Questo file risponde a due domande:

1. **Con che tecnologia è fatta FUORI** (una sola o più di una).
2. **Come si pubblicano le nuove versioni da GitHub**, sul sito e sugli store Android e Apple.

---

## 1. Le tecnologie, una per una

FUORI non è fatta con un solo strumento: è un insieme di pezzi, ognuno con il suo mestiere.

| Pezzo | Tecnologia | Dove sta |
| --- | --- | --- |
| Interfaccia dell'app | **HTML + CSS + JavaScript puro**, senza framework (niente React, Vue, Angular) | `public/index.html`, `public/styles.css`, `src/app.js` |
| App installabile sul telefono (PWA) | **Web App Manifest + Service Worker** (icona, schermo intero, cache) | `public/manifest.webmanifest`, `public/sw.js` |
| Server e API | **Cloudflare Workers** (JavaScript che gira sui server Cloudflare) | `worker.js` (un unico file, ~8.000 righe) |
| Database | **Cloudflare D1** (SQLite gestito), tabelle create dal worker (`SCHEMA_V = 13`) | binding `DB` in `wrangler.toml` |
| Foto e immagini | salvate nel database, tabella `blobs` (R2 è disattivato) | `worker.js` |
| Intelligenza artificiale | **Cloudflare Workers AI** (binding `AI`), con supporto opzionale a una chiave Gemini | `worker.js` |
| Notifiche | **Web Push con chiavi VAPID** + cron giornaliero | `worker.js`, `public/sw.js` |
| Mappe | **Leaflet + OpenStreetMap** | `public/vendor/leaflet.*` |
| Testi e contenuti | file `.txt` con campi separati da `|`, compilati in JSON | `content/`, `tools/build-content.js` |
| Build | **Bash + Node.js + terser** (minifica) | `build.sh`, `tools/` |
| App Android | **Java nativo** + **Trusted Web Activity** (Google androidbrowserhelper 2.5.0): apre il sito come app vera, con notifiche e posizione | `android/` |
| App iPhone | **Swift + Capacitor 7** (WKWebView): apre lo stesso sito dentro un'app Apple | `ios/` |
| Pubblicazione | **Cloudflare Workers** per il sito, **GitHub Actions** per compilare e caricare le app | `wrangler.toml`, `.github/workflows/` |

In due parole: **il cuore è un sito/app web in JavaScript che gira su Cloudflare; Android e iPhone sono due "custodie" native che aprono quello stesso sito.** Non ci sono due prodotti diversi da mantenere: si aggiorna il sito e le app vedono subito la novità.

Cosa **non** c'è: nessun server Node.js in produzione, nessun database MySQL/Postgres, nessun framework frontend, nessuna app nativa scritta due volte.

---

## 2. Cosa serve per pubblicare (account e costi)

| Cosa | A cosa serve | Costo |
| --- | --- | --- |
| Cloudflare | sito, server, database (già attivo) | già pagato / piano gratuito |
| GitHub | codice e pubblicazione automatica (già attivo) | gratuito |
| Google Play Console | pubblicare l'app Android sullo store Google | **25 $ una volta sola** |
| Apple Developer Program | pubblicare l'app iPhone su App Store / TestFlight | **99 $ all'anno** |

Senza l'account Google l'APK si può comunque scaricare dal sito. Senza l'account Apple l'app iPhone non si può firmare né installare: non è una scelta tecnica, è una regola di Apple.

---

## 3. I segreti da mettere su GitHub (una volta sola)

Vai su GitHub → repository `devilhack-s/fuori` → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**. Per ognuno incolla nome e valore.

| Nome del segreto | Serve per | Da dove si prende |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | pubblicare sito e server | file `.cf-token` nell'archivio privato |
| `CLOUDFLARE_ACCOUNT_ID` | id account Cloudflare | `379873b2dba7c5687bc217d5911f62f8` |
| `ANDROID_KEYSTORE_BASE64` | firmare l'APK | `.fuori.keystore` convertito in base64 |
| `ANDROID_STORE_PASSWORD` | password del keystore | `.apk-signing.env` |
| `ANDROID_KEY_ALIAS` | nome della chiave | `.apk-signing.env` |
| `ANDROID_KEY_PASSWORD` | password della chiave | `.apk-signing.env` |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | caricare su Google Play | file JSON del service account Google (punto 5) |
| `APPLE_TEAM_ID` | firmare l'app iPhone | App Store Connect → Membership |
| `APPLE_KEY_ID` | chiave API Apple | App Store Connect → Integrations |
| `APPLE_ISSUER_ID` | chiave API Apple | App Store Connect → Integrations |
| `APPLE_KEY_P8` | chiave API Apple (file `.p8` in base64) | si scarica una volta sola da Apple |

**Come si converte un file in base64** (serve per il keystore e per la chiave Apple):

- Mac/Linux: `base64 -w0 .fuori.keystore`
- Windows PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes(".fuori.keystore"))`

Copia tutto il risultato, senza spazi né a capo. Se non vuoi farlo a mano, chiedi all'assistente che ha l'archivio privato: te lo prepara lui.

> **Regola d'oro:** questi valori stanno **solo** nei segreti di GitHub. Mai in un file del repository, mai in chat, mai in una pagina web.

---

## 4. Pubblicare il sito (automatico)

Workflow: `.github/workflows/deploy-web.yml`

- Si attiva da solo a ogni modifica su `main` che tocchi sito, server, contenuti o build.
- Esegue `./build.sh` e poi `npx wrangler@4 deploy`.
- Alla fine chiama `/api/version` e mostra la versione online.

Se il token Cloudflare manca, il workflow si ferma con un messaggio chiaro: non pubblica nulla a metà.

Per pubblicare **a mano**, senza aspettare GitHub: Actions → *Pubblica sito e app web* → **Run workflow**.

---

## 5. Pubblicare l'app Android

Workflow: `.github/workflows/android.yml`

Cosa fa, in ordine:

1. compila l'APK firmato e l'AAB (il formato che vuole Google Play);
2. li mette tra i file scaricabili del workflow;
3. se c'è il segreto `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`, carica l'AAB su Google Play;
4. se ci sono i segreti Cloudflare, copia il nuovo APK in `public/fuori.apk` e ripubblica il sito, così anche chi scarica dal sito ha l'ultima versione.

### Preparazione una volta sola su Google Play

1. Crea l'app in [Play Console](https://play.google.com/console) con package **`it.fuori.app`** (attenzione: deve essere esattamente questo).
2. In Google Cloud crea un **service account**, abilita **Google Play Android Developer API**, scarica la chiave JSON.
3. In Play Console → **Utenti e autorizzazioni** → invita il service account e dagli il permesso di pubblicare.
4. Incolla il contenuto del JSON nel segreto `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`.
5. **Il primo AAB va caricato a mano** dalla Play Console: Google non accetta il primo caricamento da un'automazione. Dopo il primo, i successivi sono automatici.

### La cosa da non dimenticare: le impronte digitali

L'app Android è una Trusted Web Activity: per aprirsi a schermo intero (senza la barra del browser) Chrome controlla che l'app sia davvero "di proprietà" del sito. Il controllo si fa su:

```
https://fuori.fuori-catania.workers.dev/.well-known/assetlinks.json
```

Dentro `worker.js` c'è già l'impronta della chiave con cui firmi tu l'APK. Quando carichi su Google Play, però, **Google firma l'app con una sua chiave**: la trovi in Play Console → **Integrità dell'app** → *Certificato della chiave di firma dell'app*. Quella impronta SHA-256 va aggiunta all'elenco in `worker.js` (basta aggiungere una riga nell'array `sha256_cert_fingerprints`). Se non lo fai, l'app da Play si apre con la barra dell'indirizzo in alto.

### Pubblicare una versione nuova

```bash
git tag v1.8
git push origin v1.8
```

Il tag fa partire il workflow: versione `1.8`, codice versione sempre crescente (`1000 + numero del run`), AAB su Play, APK aggiornato sul sito.

In alternativa: Actions → **App Android (APK e Google Play)** → **Run workflow**, scegli il canale (`internal` per provare, `production` per tutti).

---

## 6. Pubblicare l'app iPhone

Workflow: `.github/workflows/ios.yml`

L'app iPhone è nuova: è un guscio **Capacitor** che apre lo stesso sito. Prima di questa consegna **non esisteva**.

Cosa fa il workflow:

1. installa le dipendenze e sincronizza il progetto iOS;
2. compila e firma l'app su un Mac messo a disposizione da GitHub (gratis per i repository pubblici);
3. la carica su **TestFlight**;
4. la pubblicazione vera e propria sull'App Store la approvi tu da App Store Connect (descrizione, foto, privacy, invio alla revisione).

Se i segreti Apple non ci sono, il workflow **non fallisce**: salta la parte Apple e lo scrive nel riepilogo. Così un tag per Android non si rompe.

### Preparazione una volta sola su Apple

1. Iscriviti all'**Apple Developer Program** (99 $/anno).
2. In [App Store Connect](https://appstoreconnect.apple.com) crea l'app con bundle id **`it.fuori.app`**, nome **FUORI**, lingua principale italiano.
3. In **Users and Access → Integrations → App Store Connect API** crea una chiave con ruolo *App Manager*. Scarica il file `.p8` (si può scaricare **una volta sola**).
4. Metti nei segreti GitHub: `APPLE_KEY_ID`, `APPLE_ISSUER_ID`, `APPLE_KEY_P8` (base64 del `.p8`), `APPLE_TEAM_ID`.

### Cose da sapere, senza girarci intorno

- **La revisione Apple è il passaggio più incerto.** Le app che sono solo un sito dentro una finestra vengono a volte rifiutate (linea guida 4.2, "funzionalità minima"). Per aumentare le possibilità: descrizione chiara, screenshot veri, account di prova per il revisore, e in futuro qualche funzione nativa (notifiche push native, condivisione, ecc.).
- **Le notifiche push del sito non funzionano nell'app iPhone**: iOS non le passa a una WebView. Su Android sì. Se servono su iPhone, va aggiunto un plugin nativo.
- **Service worker e cache offline** non sono disponibili allo stesso modo dentro la WebView: l'app ha bisogno di rete.
- Il progetto iOS **non è mai stato compilato** da chi ha preparato questa consegna (non c'era un Mac). La prima esecuzione del workflow dirà se serve una correzione; il codice è standard Capacitor, quindi la base è affidabile, ma va verificata.

---

## 7. Riepilogo: cosa è automatico e cosa resta manuale

| Azione | Come | Automatico? |
| --- | --- | --- |
| Aggiornare sito e server | push su `main` | sì |
| Aggiornare l'APK scaricabile dal sito | tag `v...` | sì (se ci sono i segreti Cloudflare) |
| Caricare su Google Play | tag `v...` | sì, dopo il primo caricamento manuale |
| Caricare su TestFlight | tag `v...` | sì, con i segreti Apple |
| Mandare l'app alla revisione Apple | App Store Connect | no, decide una persona |
| Mandare l'app in produzione su Google Play | Play Console | dipende dal canale scelto |
| Aggiungere l'impronta di Google Play in `assetlinks.json` | modifica a `worker.js` | no, una volta sola |

---

## 8. Regole di sicurezza

- Il repository è **pubblico**: chiunque legge il codice. Non deve mai contenere chiavi.
- I segreti stanno solo in GitHub → Actions → Secrets, e nell'archivio privato `accessi-fuori-PRIVATO.zip`.
- Il keystore Android è insostituibile: senza, non puoi più aggiornare l'app già installata. Tienilo in due posti sicuri.
- Se un token viene esposto, si rigenera dal pannello (Cloudflare, Google, Apple) senza toccare il codice.

---

## 9. Cosa non è stato verificato

- I tre workflow non sono mai stati eseguiti: sono stati scritti e controllati a mano.
- Il progetto iOS non è mai stato compilato (serve macOS/Xcode).
- La build Android non è stata eseguita in questa sede (manca l'ambiente Android): il progetto era già in uso e le modifiche riguardano solo firma e versione, ma la prima esecuzione va guardata.

La prima volta che lanci un workflow, guarda il risultato nella scheda **Actions** di GitHub: se qualcosa è rosso, il messaggio dice quale passo ha fallito.
