/* ============================================================
   KPI Freedom University — server di sincronizzazione Meta
   ============================================================
   Fa da ponte sicuro fra il Business Manager e la dashboard:
   - tiene il token di Meta solo qui, mai nel browser
   - la dashboard chiama GET /api/sync e riceve i dati già pronti
     nel formato campagna -> adset -> inserzione -> giorno

   Non serve altro oltre a Node.js. Nessuna dipendenza esterna
   pesante: solo express e node-fetch (integrato da Node 18+).
   ============================================================ */
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());               // in produzione: limita all'origine della tua dashboard
app.use(express.json());

const {
  META_TOKEN,            // token di sistema del Business Manager (obbligatorio)
  META_AD_ACCOUNT_ID,    // es. 123456789012345 (senza "act_")
  SYNC_API_KEY,          // chiave a piacere che la dashboard deve mandare per sincronizzare
  PORT = 3000
} = process.env;

if (!META_TOKEN || !META_AD_ACCOUNT_ID) {
  console.error("Mancano META_TOKEN o META_AD_ACCOUNT_ID nelle variabili d'ambiente. Vedi .env.example.");
  process.exit(1);
}

const GRAPH = "https://graph.facebook.com/v20.0";

/* ---------- protezione semplice: chiave condivisa nella query ---------- */
function checkKey(req, res, next) {
  if (SYNC_API_KEY && req.query.key !== SYNC_API_KEY) {
    return res.status(401).json({ error: "Chiave di sincronizzazione mancante o errata." });
  }
  next();
}

/* ---------- campi che chiediamo a Meta, a livello di singola inserzione, per giorno ---------- */
const FIELDS = [
  "campaign_name", "adset_name", "ad_name",
  "spend", "impressions", "reach", "clicks", "inline_link_clicks",
  "actions", "video_thruplay_watched_actions"
].join(",");

/* estrae un contatore da "actions" (le conversioni Meta sono lì dentro) */
function actionValue(actions, type) {
  if (!Array.isArray(actions)) return 0;
  const hit = actions.find(a => a.action_type === type);
  return hit ? Math.round(parseFloat(hit.value)) : 0;
}

async function fetchInsights(since, until) {
  const params = new URLSearchParams({
    level: "ad",
    time_increment: "1",                       // una riga per giorno
    time_range: JSON.stringify({ since, until }),
    fields: FIELDS,
    limit: "500",
    access_token: META_TOKEN
  });

  let url = `${GRAPH}/act_${META_AD_ACCOUNT_ID}/insights?${params}`;
  const rows = [];

  while (url) {
    const r = await fetch(url);
    const j = await r.json();
    if (j.error) throw new Error(`Meta API: ${j.error.message} (code ${j.error.code})`);
    rows.push(...(j.data || []));
    url = j.paging && j.paging.next ? j.paging.next : null;
  }
  return rows;
}

/* ---------- trasforma le righe di Meta nel formato campagna->adset->inserzione->giorno
   usato dalla dashboard (stessa struttura del CSV importato a mano) ---------- */
function toDashboardShape(rows) {
  const campagne = new Map();

  for (const row of rows) {
    const cpName = row.campaign_name, asName = row.adset_name, adName = row.ad_name;
    if (!campagne.has(cpName)) campagne.set(cpName, { nome: cpName, adset: new Map() });
    const cp = campagne.get(cpName);
    if (!cp.adset.has(asName)) cp.adset.set(asName, { nome: asName, creative: new Map() });
    const as = cp.adset.get(asName);
    if (!as.creative.has(adName)) as.creative.set(adName, { nome: adName, dati: {} });
    const cr = as.creative.get(adName);

    cr.dati[row.date_start] = {
      spesa: parseFloat(row.spend || 0),
      impressions: parseInt(row.impressions || 0, 10),
      reach: parseInt(row.reach || 0, 10),
      click: parseInt(row.inline_link_clicks ?? row.clicks ?? 0, 10),
      // Meta non espone più un campo dedicato alle "riproduzioni da 3 secondi":
      // si approssima con il conteggio generale delle visualizzazioni video.
      video3s: actionValue(row.actions, "video_view"),
      thruplay: actionValue(row.video_thruplay_watched_actions, "video_view"),
      // "visite" (landing page view) e "lead" arrivano dentro "actions"
      visite: actionValue(row.actions, "landing_page_view"),
      lead: actionValue(row.actions, "lead") || actionValue(row.actions, "onsite_conversion.lead_grouped")
    };
  }

  // Map -> array semplice, pronto per JSON
  return [...campagne.values()].map(cp => ({
    nome: cp.nome,
    adset: [...cp.adset.values()].map(as => ({
      nome: as.nome,
      creative: [...as.creative.values()]
    }))
  }));
}

/* ---------- endpoint principale ---------- */
app.get("/api/sync", checkKey, async (req, res) => {
  try {
    const until = req.query.until || new Date().toISOString().slice(0, 10);
    const since = req.query.since || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    const rows = await fetchInsights(since, until);
    res.json({ ok: true, since, until, nRows: rows.length, campagne: toDashboardShape(rows) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Server di sincronizzazione attivo sulla porta ${PORT}`));
