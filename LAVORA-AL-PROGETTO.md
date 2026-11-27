# Come far lavorare un'altra IA su FUORI

Questo file contiene il testo pronto da incollare in **Claude** o in **Google AI Studio** (o in qualsiasi altro assistente).

**Prima di incollarlo:**

- **Claude** (piano a pagamento): collega il repository GitHub `devilhack-s/fuori` dall'apposita integrazione, così legge e scrive i file da solo. Il repository è pubblico, quindi la lettura funziona anche senza collegamento.
- **Google AI Studio**: non ha un collegamento diretto a GitHub. Incolla il testo e allega il file `fuori-sorgente-completo.zip` (tutto il codice). Per le chiavi allega `accessi-fuori-PRIVATO.zip` solo se ti fidi di quella chat e ricordati che è privato.
- Entrambi possono **leggere** il repository pubblico. Per **scrivere** su GitHub serve un'autorizzazione: l'integrazione di Claude, oppure un token che dai tu al momento (mai in una chat pubblica).

---

## TESTO DA INCOLLARE (da qui in giù)

Ciao. Da adesso lavori al progetto **FUORI**, un'app e un sito per conoscersi e per gli eventi a Catania. Ti passo tutto quello che serve per iniziare senza rifare il lavoro da zero.

### Cos'è FUORI

Profili, eventi, foto da verificare, messaggi, un assistente con l'intelligenza artificiale, notifiche, mappa, area amministratore. Gira su Cloudflare (worker + sito statico + database D1). Ha un'app Android che apre il sito come app vera e un'app iPhone (Capacitor) appena creata.

- Sito in produzione: https://fuori.fuori-catania.workers.dev
- Codice: **https://github.com/devilhack-s/fuori** — repository **pubblico**, branch `main`.
- Clona senza credenziali: `git clone https://github.com/devilhack-s/fuori`

### Prima di scrivere una riga

1. Clona il repository e leggi, in quest'ordine: `README.md`, `RIPRISTINO.md`, `PUBBLICARE.md`.
2. Controlla di avere l'ultima versione: `git log --oneline -5`.
3. Se il proprietario ti ha dato l'archivio `accessi-fuori-PRIVATO.zip`, estrailo **fuori** dalla cartella del repository e copia i file `.cf-token`, `.admin-key`, `.vapid-private.b64`, `.apk-signing.env`, `.fuori.keystore` nella radice del progetto. Il `.gitignore` li esclude: non aggiungerli mai al versionamento.

### Com'è fatto (mappa del codice)

| Percorso | Cosa contiene |
| --- | --- |
| `worker.js` | Tutto il server: API, database, foto, notifiche, assistente, cron. Le tabelle le crea da solo (`SCHEMA_V = 13`). |
| `src/app.js` | Tutta l'interfaccia dell'app, un unico file (~10.000 righe). |
| `public/` | Quello che viene pubblicato: `index.html`, `styles.css`, icone, traduzioni, mappa (Leaflet), `fuori.apk`. |
| `public/app.min.js` | **Generato**: non modificarlo a mano. |
| `content/` | I testi delle attività, file `.txt` con campi separati da `|`. |
| `tools/` | `build-content.js` (testi → JSON), regole di stagione e umore, icone. |
| `android/` | App Android nativa (Trusted Web Activity): Java, Gradle, firma. |
| `ios/` | App iPhone (Capacitor 7, WKWebView): apre lo stesso sito. |
| `build.sh` | Build: contenuti, minifica, allineamento di tutte le versioni. |
| `wrangler.toml` | Configurazione Cloudflare: worker, database D1, cron. |
| `.github/workflows/` | Pubblicazione automatica: sito, Android, iPhone. |

### Dati fissi dell'infrastruttura (non sono segreti)

| Cosa | Valore |
| --- | --- |
| Account Cloudflare | `379873b2dba7c5687bc217d5911f62f8` |
| Worker | `fuori` — https://fuori.fuori-catania.workers.dev |
| Database D1 | nome `fuori`, id `4c79ee68-51de-4ee7-8af6-22a7d1e85280` |
| Email amministratore | `christianguarrera@gmail.com` |
| Versione client | 560 (in `src/app.js` e `worker.js`) |
| Schema database | `SCHEMA_V = 13` |

### Come si costruisce e si pubblica

```bash
./build.sh
CLOUDFLARE_API_TOKEN="$(tr -d '\n\r ' < .cf-token)" \
CLOUDFLARE_ACCOUNT_ID=379873b2dba7c5687bc217d5911f62f8 \
npx --yes wrangler@4 deploy

# verifica (la cache può tenere una copia vecchia per qualche secondo)
curl -s "https://fuori.fuori-catania.workers.dev/api/version?x=$RANDOM"
```

### Regole di lavoro (imparate sul campo, non ignorarle)

- `src/app.js` è un unico file: ogni modifica visibile deve far salire `VERSION`. `build.sh` propaga il numero a `worker.js` (`CLIENT_V`), `public/index.html` e `public/sw.js`, così i telefoni si aggiornano.
- `public/app.min.js` è generato: si rigenera con `./build.sh`.
- I testi si modificano in `content/*.txt`, non nel JSON generato.
- Se aggiungi una tabella al database, alza `SCHEMA_V` e aggiungi il `CREATE TABLE IF NOT EXISTS` nel worker.
- Ripubblicare **non cancella** i dati: il deploy carica solo worker e file statici.
- Le foto stanno nella tabella `blobs` del database D1.
- Il deploy passa dal worker per `/`, `/index.html` e `/fuori.apk` (anteprime social e conteggio download).
- Il repository è **pubblico**: nessuna chiave, nessun token, nessun file `.env` deve mai essere committato.

### App e store

I workflow sono in `.github/workflows/`:

- `deploy-web.yml` — a ogni push su `main` pubblica sito e server.
- `android.yml` — con un tag `v1.8` (o a mano) compila APK firmato + AAB, carica su Google Play e aggiorna `fuori.apk` sul sito. Richiede i segreti `ANDROID_KEYSTORE_BASE64`, `ANDROID_STORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
- `ios.yml` — con un tag carica su TestFlight. Richiede `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_ISSUER_ID`, `APPLE_KEY_P8`.

Dettagli, costi e passaggi una volta sola: `PUBBLICARE.md`.

**Non creare tag, non pubblicare e non cambiare i segreti senza chiedere al proprietario.** Un tag fa partire una pubblicazione vera.

### Come voglio che lavori

- Rispondi in italiano semplice, senza gergo: il proprietario non è uno sviluppatore.
- Prima di modificare, leggi il codice che tocchi. Dopo aver modificato, esegui `./build.sh` e controlla che non dia errori.
- Fai modifiche piccole e verificabili, una alla volta. Se una modifica è visibile, alza `VERSION`.
- Non toccare i dati degli utenti, non svuotare tabelle, non cambiare il database di produzione senza autorizzazione.
- Se non hai accesso in scrittura a GitHub, prepara le modifiche in locale e spiega al proprietario come applicarle (o chiedi l'accesso). Non chiedere mai di incollare chiavi in una chat pubblica.
- Se una cosa non l'hai provata, dillo: "non verificato" è meglio di "funziona".

### Da dove partire

Leggi `PUBBLICARE.md` e dimmi in due righe: (1) se il repository è completo, (2) qual è la prima cosa che proponi di sistemare, (3) se ti serve l'archivio delle chiavi. Poi aspetti il via.

---

## Fine del testo da incollare
