// Regole per capire stagione e "all'aperto" di un'attività, senza scriverlo a mano
// per tutte. Le regole sono volutamente semplici: si guarda il nome.
const norm = (s) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

// attive solo quando fa caldo (mare, barca, picnic...)
const SUMMER = [
  "mare", "spiaggia", "snorkeling", "immersioni", "apnea", "surf", "windsurf", "kitesurf",
  "sup", "vela", "barca", "gommone", "kayak", "canoa", "sci nautico", "wakeboard",
  "beach volley", "pallanuoto", "picnic", "gelato", "granita", "campeggio", "glamping",
  "falo", "tramonti", "pulizia di spiagge", "tuffi", "barbecue", "gita al mare",
  "visita alle isole", "viaggio low cost", "pesca in barca", "nuoto", "acque libere", "bagno",
];

// roba da neve: ha senso solo nel cuore dell'inverno
const SNOW = [
  "sci", "snowboard", "ciaspole", "slittino", "pattinaggio su ghiaccio", "hockey su ghiaccio",
];

// attive solo quando fa freddo o nelle feste
const WINTER = [
  "terme", "spa", "sauna", "bagno turco", "mercatini", "natale", "capodanno", "halloween",
  "cioccolata", "fonduta", "vin brul", "gita in montagna",
];

// roba che si fa dentro, al riparo
const INDOOR = [
  "palestra", "piscina", "bowling", "biliardo", "sala giochi", "flipper", "indoor",
  "palazzetto", "boulder", "muro", "arti marziali", "boxe", "kickboxing", "judo", "karate",
  "muay thai", "jiu jitsu", "scherma", "ginnastica", "functional", "crossfit", "calisthenics",
  "pilates", "yoga", "danza", "salsa", "bachata", "tango", "swing", "hip hop", "breakdance",
  "acrobatica", "trampolino", "cinema", "teatro", "museo", "mostra", "galleria", "escape room",
  "videogiochi", "retrogaming", "cucina", "corso", "laboratorio", "workshop", "biliardino",
  "calcio balilla", "freccette", "quiz", "tombola", "poker", "scacchi", "dama", "burraco",
  "risiko", "mahjong", "puzzle", "carte", "larp", "rpg", "bowling", "karaoke", "concerto",
  "discoteca", "pub", "cocktail", "degustazione", "birra", "vino", "caffe", "te pomeridiano",
  "ceramica", "tornio", "serigrafia", "fumetto", "calligrafia", "mosaico", "incisione",
  "legatoria", "camera oscura", "cake design", "profumi", "cosmetica", "ricamo", "sartoria",
  "maglia", "uncinetto", "falegnameria", "restauro", "acquerello", "pittura", "scultura",
  "disegno", "scrittura", "poesia", "book club", "fotografia", "podcast", "montaggio",
  "programmazione", "robotica", "elettronica", "stampanti 3d", "modellismo", "cybersecurity",
  "social media", "doppiaggio", "recitazione", "musica elettronica", "beatmaking", "dj set",
  "produzione musicale", "chitarra", "ukulele", "coro", "imparare uno strumento", "jam session",
  "massaggi", "respirazione", "meditazione", "nutrizione", "coaching", "public speaking",
  "lingua", "scambio linguistico", "conversazione", "filosofia", "storia", "scienza",
  "matematica", "divulgazione", "giornalismo", "debate", "lingua dei segni", "speed date",
  "networking", "colazione di lavoro", "cena tra sconosciuti", "cena con delitto", "open mic",
  "stand up", "cabaret", "musical", "opera", "balletto", "conferenza", "ted talk", "dibattito",
  "cineforum", "documentari", "visita guidata", "storia locale", "architettura",
];

// roba che sta bene fuori anche se la categoria non lo direbbe
const OUTDOOR_ANY = [
  "picnic", "barbecue", "mercato", "sagra", "street food", "food tour", "passeggiata",
  "camminata", "camminate", "giro in bici", "tour in bici", "murales", "borgo", "archeologici",
  "giardinaggio", "orto", "apicoltura", "birdwatching", "astronomia", "stelle", "micologia",
  "fotografia di strada", "fotografia urbana", "mercato rionale", "caccia al tesoro",
];

const OUTDOOR_CATS = new Set(["sport", "natura", "viaggi"]);

const esc = (k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const has = (list, name) =>
  list.some((k) => new RegExp("(?:^|[^a-z])" + esc(k) + "(?:$|[^a-z])").test(name));

function seasons(it, cat) {
  const name = norm(it);
  return {
    season: has(SUMMER, name)
      ? "estate"
      : has(SNOW, name)
        ? "neve"
        : has(WINTER, name)
          ? "inverno"
          : "sempre",
    out: has(OUTDOOR_ANY, name) ? true : OUTDOOR_CATS.has(cat) ? !has(INDOOR, name) : false,
  };
}

module.exports = { seasons };
