// A che "voglia" risponde un'attività: calma, energia, divertimento, scoperta, gusto.
// Più di una può valere: un trekking è energia e anche calma.
const RULES = [
  ["calma", /yoga|meditazion|respirazion|spa\b|terme|massagg|sauna|bagno turco|retreat|passeggiata|forest bathing|birdwatching|giardinaggio|orto |piante|picnic|fal[òo]|tramont|osservare le stelle|astronomia|pesca|turismo lento|apicoltura|micologia|t[èe]\b|camminate in citt|fitwalking|stretching|sonno|digiuno|pet therapy|gatti|cani\b|acquerello|calligrafia|maglia|uncinetto|ricamo|legatoria|book club|poesia|glamping|campeggio|\bnuoto\b|snorkeling|\bmare\b|piscina|lettura|relax/i],
  ["energia", /quad|paintball|laser game|go kart|arrampicata|boulder|palestra di roccia|parapendio|deltaplano|paracadutismo|bungee|zip line|parco avventura|rafting|kitesurf|surf\b|wakeboard|sci nautico|motociclismo|rally|automobilismo|crossfit|functional|calisthenics|boxe|kickboxing|muay thai|parkour|trail|trekking|escursion|ciclismo|mountain bike|gravel|downhill|speleologia|grotte|orienteering|geocaching|skateboard|slackline|softair|equitazione|poligono|tiro a segno|tiro con l'arco|rugby|hockey|immersioni|apnea|snowboard|sci\b|ciaspole|slittino|volcano|corsa|windsurf|sup\b|\bvela\b|hiking|arrampicata/i],
  ["divertimento", /karaoke|bowling|biliardo|freccette|flipper|calcio balilla|bocce|quiz|bingo|tombola|burraco|risiko|poker|giochi di carte|escape room|laser|discoteca|festa|\brave\b|silent disco|dj set|open mic|stand up|cabaret|comic convention|pub\b|stadio|delitto|larp|retrogaming|videogiochi|torneo|speed date|salsa|bachata|tango|swing|hip hop|danza|breakdance|musical|\bopera\b|balletto|concerto|musica dal vivo|jam session|coro|beatmaking|dj\b|notte bianca|halloween|capodanno|addio al celibato|big party|festival|sfilata|\bfiera\b|comic/i],
  ["scoperta", /museo|mostra|galleria|archeologic|chiese|monument|borgo|storia|architettura|visita guidata|murales|documentari|conferenza|ted talk|dibattito|podcast|filosofia|scienza|divulgazione|matematica|lingua|scambio linguistico|cineforum|teatro|fotografia|viaggio|road trip|weekend|gita|isole|cammino|interrail|camper|couchsurfing|mercatini|mercat|birdwatching|micologia|apicoltura|astronomia|planetario|tour\b|storia locale|biblioteca|letteratura|giornalismo|debate|tech|robotica|droni|coding|programmazione|intelligenza artificiale|crittografia|cybersecurity/i],
  ["gusto", /vino|degustazione|birra|cocktail|cena|aperitivo|brunch|pizza|street food|food tour|sagra|mercato|picnic|barbecue|cucin|cucina|pasta|pasticceria|pane|cake design|colazione|afterwork|caff[èe]|t[èe] pomeridiano|vegetarian|etnica|gelato|pistacchio|cannolo|food|mangiare|ristorante|trattoria|pesce|formagg|\bolio\b|miele|dolci|\bbar\b/i],
];

// se nessuna parola chiave scatta, la categoria dice già molto
const BY_CAT = {
  sport: "energia",
  sociale: "gusto",
  creativita: "calma",
  cinema: "scoperta",
  musica: "divertimento",
  serate: "divertimento",
  giochi: "divertimento",
  natura: "calma",
  benessere: "calma",
  lingue: "scoperta",
  tech: "scoperta",
  animali: "calma",
  volontariato: "scoperta",
  viaggi: "scoperta",
};

function moods(it, cat) {
  const out = [];
  for (const [id, re] of RULES) if (re.test(it)) out.push(id);
  if (!out.length && BY_CAT[cat]) out.push(BY_CAT[cat]);
  return out;
}

module.exports = { moods };
