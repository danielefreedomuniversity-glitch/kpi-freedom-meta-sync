/* ============================================================
   KPI Freedom University — server v2
   ============================================================
   Fa tre cose:
   1. Serve il SITO della dashboard (dashboard.html) con password
   2. /api/sync: interroga Meta (spesa, click, lead, video...),
      GHL (fissate, show, vendite, cash — attribuiti per campagna
      via UTM) e il foglio Google dei SETTER (tentativi, assegnati,
      riprogrammate), e restituisce tutto già fuso nel formato
      campagna -> adset -> inserzione -> giorno
   3. /api/ping: verifica della password

   Variabili d'ambiente su Render:
     META_TOKEN, META_AD_ACCOUNT_ID  (già presenti)
     SYNC_API_KEY   = password del sito (es. CollabStore123)
     GHL_TOKEN      = token Integrazione privata GHL
     GHL_LOCATION_ID= id del sub-account GHL
   ============================================================ */
import express from "express";
import cors from "cors";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json());

const {
  META_TOKEN, META_AD_ACCOUNT_ID,
  SYNC_API_KEY,
  GHL_TOKEN, GHL_LOCATION_ID,
  PORT = 3000
} = process.env;

/* ID dei fogli Google (non sono segreti: sono in sola lettura via link) */
const SHEET_SETTER_ID = "17hr_OMh-5ixP43Wi--OddB3RRQbQqxdgEQzGBEAmHiA";
const SHEET_CLOSER_ID = "1QHgIzzrLaxPiwgpQlrG68VRx_5SP1WJBlRoFd_Cc2d4";

if (!META_TOKEN || !META_AD_ACCOUNT_ID) {
  console.error("Mancano META_TOKEN o META_AD_ACCOUNT_ID."); process.exit(1);
}

const GRAPH = "https://graph.facebook.com/v20.0";
const GHL = "https://services.leadconnectorhq.com";
const ghlHeaders = { Authorization: `Bearer ${GHL_TOKEN}`, Version: "2021-07-28", Accept: "application/json" };

/* ---------- sito con password ---------- */
let dashboardHTML = "";
try { dashboardHTML = readFileSync(join(__dirname, "dashboard.html"), "utf8"); }
catch { dashboardHTML = "<h1>dashboard.html mancante nel repository</h1>"; }

app.get("/", (_req, res) => res.type("html").send(dashboardHTML));
app.get("/health", (_req, res) => res.json({ ok: true }));

function checkKey(req, res, next) {
  if (SYNC_API_KEY && req.query.key !== SYNC_API_KEY)
    return res.status(401).json({ ok: false, error: "Password errata." });
  next();
}
app.get("/api/ping", checkKey, (_req, res) => res.json({ ok: true }));

/* ============================================================
   1) META — invariato: insight per inserzione, per giorno
   ============================================================ */
const FIELDS = [
  "campaign_name","adset_name","ad_name",
  "spend","impressions","reach","clicks","inline_link_clicks","actions",
  "video_p25_watched_actions","video_p50_watched_actions",
  "video_p75_watched_actions","video_p100_watched_actions",
  "video_thruplay_watched_actions"
].join(",");
const actionValue = (a,t)=>{ const h=(Array.isArray(a)?a:[]).find(x=>x.action_type===t); return h?Math.round(parseFloat(h.value)):0; };

async function fetchMeta(since, until) {
  const params = new URLSearchParams({
    level:"ad", time_increment:"1",
    time_range: JSON.stringify({since,until}),
    fields: FIELDS, limit:"500", access_token: META_TOKEN
  });
  let url = `${GRAPH}/act_${META_AD_ACCOUNT_ID}/insights?${params}`;
  const rows=[];
  while(url){
    let j=null;
    for(let tent=1;tent<=4;tent++){
      j = await (await fetch(url)).json();
      if(!j.error) break;
      /* code 1/2 = errore temporaneo di Meta: aspetta e riprova da solo */
      if([1,2].includes(j.error.code) && tent<4){ await new Promise(r=>setTimeout(r,3000*tent)); continue; }
      throw new Error(`Meta API: ${j.error.message} (code ${j.error.code})`);
    }
    rows.push(...(j.data||[]));
    url = j.paging?.next || null;
  }
  return rows;
}

/* ---------- struttura condivisa campagna->adset->inserzione->giorno ---------- */
function makeShape(){
  const campagne = new Map();
  const cell = (cp,as,ad,day)=>{
    if(!campagne.has(cp)) campagne.set(cp,{nome:cp,adset:new Map()});
    const c=campagne.get(cp);
    if(!c.adset.has(as)) c.adset.set(as,{nome:as,creative:new Map()});
    const a=c.adset.get(as);
    if(!a.creative.has(ad)) a.creative.set(ad,{nome:ad,dati:{}});
    const cr=a.creative.get(ad);
    if(!cr.dati[day]) cr.dati[day]={};
    return cr.dati[day];
  };
  const toArray = ()=>[...campagne.values()].map(cp=>({
    nome:cp.nome,
    adset:[...cp.adset.values()].map(as=>({nome:as.nome, creative:[...as.creative.values()]}))
  }));
  return { cell, toArray };
}

/* ============================================================
   2) GHL — opportunità -> eventi per campagna/adset/creativa/giorno
   ============================================================ */
const norm = s => String(s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim();
const money = v => { const n=parseFloat(String(v??"").replace(/[€$\s]/g,"").replace(/\.(?=\d{3}\b)/g,"").replace(",",".")); return isFinite(n)?n:0; };
const dayOf = v => { if(!v) return null; const s=String(v); const m=s.match(/^(\d{4})-(\d{2})-(\d{2})/); return m?`${m[1]}-${m[2]}-${m[3]}`:null; };

async function ghlGET(path){
  const r = await fetch(GHL+path, {headers: ghlHeaders});
  const j = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(`GHL ${path}: ${j.message||j.error||r.status}`);
  return j;
}

/* ID dei campi UTM di questa location (dalla diagnosi): funzionano anche senza
   il permesso "campi personalizzati" sul token. Gli altri campi (Cash, Contrattualizzato,
   Data Vendita) si risolvono per nome appena il token ha lo scope giusto. */
const FIELD_FALLBACK = {
  "eIWChn1tSHr9SV3k8nPg": "utm source",
  "ngCaDZhKshp4XYiq1Vme": "utm campaign",
  "bFlpzo17stRQocW1WAEh": "utm medium",
  "4v33gsK21jenFc8xEyw4": "utm content"
};

async function fetchGHL(since, until, shape, warn){
  if(!GHL_TOKEN || !GHL_LOCATION_ID){ warn.push("GHL non configurato (mancano GHL_TOKEN / GHL_LOCATION_ID)."); return; }

  /* mappe: id fase -> nome, id campo -> nome */
  const stages = new Map();   // stageId -> {pipe, stage}
  const pipes = await ghlGET(`/opportunities/pipelines?locationId=${GHL_LOCATION_ID}`);
  (pipes.pipelines||[]).forEach(p=>(p.stages||[]).forEach(s=>stages.set(s.id,{pipe:norm(p.name),stage:norm(s.name)})));

  const cf = new Map(Object.entries(FIELD_FALLBACK));   // fieldId -> nome normalizzato
  let scopeOk=false;
  for(const q of ["?model=opportunity","?model=contact","?model=all",""]){
    try{
      const defs = await ghlGET(`/locations/${GHL_LOCATION_ID}/customFields${q}`);
      (defs.customFields||[]).forEach(f=>cf.set(f.id, norm(f.name)));
      scopeOk=true;                                     // continua comunque: unisci tutti gli elenchi
    }catch(e){ /* variante non disponibile, prova la prossima */ }
  }
  if(!scopeOk) warn.push("Token GHL senza permesso sui campi personalizzati: gli UTM funzionano lo stesso, ma Cash Collected / Contrattualizzato / Data Vendita no. Aggiungi lo scope \"View Custom Fields\" all'integrazione privata in GHL.");
  else{
    const trovato = n => [...cf.values()].some(v=>v.includes(n));
    const mancanti = ["cash collected","contrattualizzato","data vendita"].filter(n=>!trovato(n));
    if(mancanti.length) warn.push("Campi GHL non trovati per nome: "+mancanti.join(", ")+" — controlla come si chiamano esattamente in GHL (Impostazioni → Campi personalizzati).");
  }

  const cfVal = (opp, ...names)=>{
    const arr = opp.customFields||opp.customField||opp.custom_fields||[];
    for(const f of arr){
      const nm = cf.get(f.id||f.customFieldId)||norm(f.name||f.key||"");
      if(names.some(n=>nm.includes(n))){
        const v = f.fieldValue ?? f.fieldValueString ?? f.field_value ?? f.value;
        if(Array.isArray(v)) return v.join(", ");
        return v ?? null;
      }
    }
    return null;
  };
  let nTot=0, nFb=0, nAttr=0, nNoUtm=0, cashSum=0;
  const codaDettagli=[];   /* vinti senza cash leggibile: riletti in dettaglio a fine giro */

  /* tutte le opportunità, paginazione a cursore (startAfter): regge qualsiasi volume */
  let got=0, startAfter=null, startAfterId=null, guardia=0;
  while(guardia++ < 500){
    let path = `/opportunities/search?location_id=${GHL_LOCATION_ID}&limit=100`;
    if(startAfterId) path += `&startAfterId=${encodeURIComponent(startAfterId)}&startAfter=${encodeURIComponent(startAfter)}`;
    const j = await ghlGET(path);
    const list = j.opportunities||[];
    if(!list.length) break;
    got += list.length;

    for(const o of list){
      nTot++;
      const a0 = Array.isArray(o.attributions)&&o.attributions.length ? o.attributions[o.attributions.length-1] : null;
      const src = norm(cfVal(o,"utm source") ?? a0?.utmSource ?? o.source ?? o.contact?.attributionSource?.utmSource ?? "");
      if(!src.includes("facebook")) continue;          // SOLO Facebook, come richiesto
      nFb++;

      const utmCp = cfVal(o,"utm campaign") ?? a0?.utmCampaign ?? a0?.campaign ?? o.contact?.attributionSource?.campaign ?? null;
      if(utmCp) nAttr++; else nNoUtm++;
      const cp = utmCp ?? "— GHL non attribuito";
      const as = cfVal(o,"utm medium")   ?? a0?.utmMedium  ?? "—";
      const ad = cfVal(o,"utm content")  ?? a0?.utmContent ?? "—";
      const st = stages.get(o.pipelineStageId) || {pipe:"",stage:""};
      const created = dayOf(o.createdAt);
      const changed = dayOf(o.lastStageChangeAt || o.lastStatusChangeAt || o.updatedAt) || created;
      const inRange = d => d && d>=since && d<=until;
      const add=(day,field,n=1)=>{ if(!inRange(day)) return; const c=shape.cell(String(cp).trim(),String(as).trim(),String(ad).trim(),day); c[field]=(c[field]||0)+n; };

      if(st.pipe.includes("setter")){
        const s=st.stage;
        add(created,"assegnati");                     // ogni lead entrato in pipeline = assegnato quel giorno
        const contattato = ["contattato","call 1","call 2","call 3","non interessato","non in target","semina","appuntamento fissato"].some(x=>s.includes(x));
        if(contattato) add(changed,"contattati");
        /* tentativi: stima dalle fasi CALL (per difetto: gli esiti non ricordano quanti tentativi hanno richiesto) */
        if(s.includes("call 1")) add(changed,"tentativi",1);
        else if(s.includes("call 2")) add(changed,"tentativi",2);
        else if(s.includes("call 3")) add(changed,"tentativi",3);
        if(s.includes("non interessato")) add(changed,"nonInteressato");
        if(s.includes("non in target"))   add(changed,"nonTarget");
        if(s.includes("semina")||s.includes("numero errato")) add(changed,"nonFissati");
        /* le fissate NON si contano qui: quando il setter fissa, il flusso crea
           l'opportunità nella pipeline CLOSER — contarle in entrambe = doppioni */
      }
      else if(st.pipe.includes("closer")){
        add(created,"fissate");                       // creata nella pipeline closer = call fissata quel giorno
        const s=st.stage;
        if(s.includes("no show")) add(changed,"noShow");
        if(["follow","vinto","perso"].some(x=>s.includes(x))) add(changed,"show");
        if(s.includes("vinto")){
          const cashProva = money(cfVal(o,"cash collected"));
          const contrProva = money(cfVal(o,"contrattualizzato"));
          if(!cashProva && !contrProva && codaDettagli.length<300){
            /* la ricerca spesso NON porta i campi custom: rileggo il dettaglio dopo */
            codaDettagli.push({o, add, changed});
          } else {
            const saleDay = dayOf(cfVal(o,"data vendita")) || changed;
            add(saleDay,"vendite");
            const venduto = contrProva || (+o.monetaryValue||0);
            cashSum+=cashProva;
            if(contrProva) add(saleDay,"contr",contrProva);
            if(venduto)    add(saleDay,"venduto",venduto);
            if(cashProva)  add(saleDay,"cash",cashProva);
          }
        }
      }
    }
    const m=j.meta||{};
    if(list.length<100 || !m.startAfterId) break;
    startAfterId=m.startAfterId; startAfter=m.startAfter;
  }
  /* ---- I1: rilettura dettagli per i vinti senza campi custom nella ricerca ---- */
  if(codaDettagli.length){
    let letti=0, cashDet=0;
    for(let i=0;i<codaDettagli.length;i+=8){
      await Promise.all(codaDettagli.slice(i,i+8).map(async ({o, add, changed})=>{
        try{
          const jd = await ghlGET(`/opportunities/${o.id}`);
          const det = jd.opportunity || jd;
          const arr = det && (det.customFields||det.customField||det.custom_fields);
          if(arr && arr.length) o.customFields = arr;
          letti++;
        }catch(e){ /* dettaglio non leggibile: uso quello che ho */ }
        const saleDay = dayOf(cfVal(o,"data vendita")) || changed;
        add(saleDay,"vendite");
        const contr = money(cfVal(o,"contrattualizzato"));
        const cash  = money(cfVal(o,"cash collected"));
        const venduto = contr || (+o.monetaryValue||0);
        cashSum+=cash; cashDet+=cash;
        if(contr)   add(saleDay,"contr",contr);
        if(venduto) add(saleDay,"venduto",venduto);
        if(cash)    add(saleDay,"cash",cash);
      }));
    }
    warn.push(`GHL: ${codaDettagli.length} vendite rilette dal dettaglio opportunità (cash recuperato € ${Math.round(cashDet)}).`);
  }
  if(!got) warn.push("GHL: nessuna opportunità ricevuta — controlla token e Location ID.");
  else warn.push(`GHL: ${nFb} opportunità Facebook su ${nTot} totali · ${nAttr} attribuite via UTM · ${nNoUtm} senza UTM (finite in "— GHL non attribuito") · cash letto € ${Math.round(cashSum)}.`);
}

/* ============================================================
   3) FOGLIO SETTER (Google Sheets, scheda TEAM)
   solo i campi che GHL non conosce: tentativi, assegnati, riprogrammate
   ============================================================ */
function parseCSVText(text){
  const rows=[]; let row=[],cur="",q=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(q){ if(ch==='"'){ if(text[i+1]==='"'){cur+='"';i++;} else q=false; } else cur+=ch; }
    else if(ch==='"') q=true;
    else if(ch==='\n'||ch==='\r'){ if(cur!==""||row.length){row.push(cur);rows.push(row);row=[];cur="";} if(ch==='\r'&&text[i+1]==='\n')i++; }
    else if(ch===','){ row.push(cur); cur=""; }
    else cur+=ch;
  }
  if(cur!==""||row.length){row.push(cur);rows.push(row);}
  return rows;
}
const itDate = s => { const m=String(s||"").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m?`${m[3]}-${String(m[2]).padStart(2,"0")}-${String(m[1]).padStart(2,"0")}`:null; };
const num = s => { const v=parseFloat(String(s??"").replace(/\./g,"").replace(",",".")); return isFinite(v)?v:0; };

async function fetchSetterSheet(since, until, shape, warn){
  try{
    const url=`https://docs.google.com/spreadsheets/d/${SHEET_SETTER_ID}/gviz/tq?tqx=out:csv&sheet=TEAM`;
    const r = await fetch(url);
    if(!r.ok) throw new Error("HTTP "+r.status);
    const rows = parseCSVText(await r.text());
    const hi = rows.findIndex(r=>norm(r[0]).includes("data"));
    if(hi<0) throw new Error("intestazione 'Data' non trovata nella scheda TEAM");
    const head = rows[hi].map(norm);
    const col = name => head.findIndex(h=>h.includes(name));
    const cRip=col("riprogrammate");
    let n=0;
    for(let i=hi+1;i<rows.length;i++){
      const day = itDate(rows[i][0]); if(!day || day<since || day>until) continue;
      const rip=cRip>=0?num(rows[i][cRip]):0;
      if(!rip) continue;
      const c = shape.cell("⚙ Team — registro setter","Fogli Google","Attività non attribuita",day);
      c.riprog=(c.riprog||0)+rip;
      n++;
    }
    if(!n) warn.push("Foglio setter: nessuna riga con Riprogrammate nel periodo (assegnati, tentativi e tutto il resto arrivano già da GHL).");
  }catch(e){ warn.push("Foglio setter non leggibile: "+e.message); }
}

/* ============================================================
   RICUCITURA (aggiunta Fase A) — gli UTM scritti a mano negli
   annunci non coincidono coi nomi veri di Meta: le campagne nate
   solo da GHL (niente spesa) vengono riagganciate alla campagna
   Meta che contiene TUTTE le loro parole. AdSet e inserzioni si
   agganciano per nome uguale, altrimenti in un cassetto
   "— da GHL (utm)" dentro la campagna giusta.
   ============================================================ */
const tokensDi = s => [...new Set(String(s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"")
  .replace(/[^a-z0-9]+/g," ").trim().split(" ").filter(x=>x))];
function fondiDati(dst, src){
  for(const [iso, rec] of Object.entries(src.dati||{})){
    if(!dst.dati[iso]) dst.dati[iso]={};
    for(const [k,v] of Object.entries(rec)) dst.dati[iso][k]=(dst.dati[iso][k]||0)+v;
  }
}
function stitchCampagne(campagne, warn){
  const haSpesa = cp => cp.adset.some(a=>a.creative.some(cr=>Object.values(cr.dati||{}).some(d=>"spesa" in d)));
  const meta = campagne.filter(haSpesa);
  const out = [];
  for(const cp of campagne){
    if(haSpesa(cp) || /non attribuito|registro setter|\{\{/.test(cp.nome)){ out.push(cp); continue; }
    const tk = tokensDi(cp.nome);
    const cand = meta.filter(m => { const mt=new Set(tokensDi(m.nome)); return tk.length && tk.every(t=>mt.has(t)); });
    if(cand.length !== 1){ out.push(cp); continue; }
    const dest = cand[0];
    const normN = s => tokensDi(s).join(" ");
    for(const as of cp.adset){
      let asDest = dest.adset.find(a => normN(a.nome) === normN(as.nome));
      if(!asDest){
        if(as.creative.length===1 && normN(as.creative[0].nome)==="" ) { /* mai */ }
        asDest = dest.adset.find(a => a.nome === "— da GHL (utm non combacianti)");
        if(!asDest){ asDest = { nome:"— da GHL (utm non combacianti)", creative:[] }; dest.adset.push(asDest); }
      }
      for(const cr of as.creative){
        let crDest = asDest.creative.find(c => normN(c.nome) === normN(cr.nome));
        if(!crDest){ crDest = { nome: cr.nome, dati:{} }; asDest.creative.push(crDest); }
        fondiDati(crDest, cr);
      }
    }
    warn.push(`Ricucitura: eventi GHL di "${cp.nome}" agganciati a "${dest.nome}" (utm scritti a mano negli annunci — per il futuro usate {{campaign.name}} / {{adset.name}} / {{ad.name}}).`);
  }
  return out;
}

/* ============================================================
   /api/sync — tutto insieme
   ============================================================ */
app.get("/api/sync", checkKey, async (req,res)=>{
  try{
    const until = req.query.until || new Date().toISOString().slice(0,10);
    const since = req.query.since || new Date(Date.now()-30*864e5).toISOString().slice(0,10);
    const warn = [];
    const shape = makeShape();

    /* Meta (non bloccante: se Meta ha un singhiozzo, GHL e fogli arrivano lo stesso) */
    let metaRows = [];
    try{ metaRows = await fetchMeta(since, until); }
    catch(e){ warn.push("Meta API: "+e.message+" — riprova tra qualche minuto, GHL e fogli sono comunque aggiornati."); }
    for(const row of metaRows){
      const d = shape.cell(row.campaign_name, row.adset_name, row.ad_name, row.date_start);
      d.spesa=(d.spesa||0)+parseFloat(row.spend||0);
      d.impressions=(d.impressions||0)+parseInt(row.impressions||0,10);
      d.reach=(d.reach||0)+parseInt(row.reach||0,10);
      d.click=(d.click||0)+parseInt(row.inline_link_clicks??row.clicks??0,10);
      d.video25=(d.video25||0)+actionValue(row.video_p25_watched_actions,"video_view");
      d.video50=(d.video50||0)+actionValue(row.video_p50_watched_actions,"video_view");
      d.video75=(d.video75||0)+actionValue(row.video_p75_watched_actions,"video_view");
      d.video100=(d.video100||0)+actionValue(row.video_p100_watched_actions,"video_view");
      d.thruplay=(d.thruplay||0)+actionValue(row.video_thruplay_watched_actions,"video_view");
      d.visiteVsl=(d.visiteVsl||0)+actionValue(row.actions,"landing_page_view");
      d.lead=(d.lead||0)+(actionValue(row.actions,"lead")||actionValue(row.actions,"onsite_conversion.lead_grouped"));
    }

    /* GHL + foglio setter (non bloccanti: se falliscono, Meta arriva comunque) */
    try{ await fetchGHL(since, until, shape, warn); }catch(e){ warn.push("GHL: "+e.message); }
    await fetchSetterSheet(since, until, shape, warn);

    res.json({ ok:true, since, until, nMeta: metaRows.length, warn, campagne: stitchCampagne(shape.toArray(), warn) });
  }catch(err){
    console.error(err);
    res.status(500).json({ ok:false, error:String(err.message||err) });
  }
});

/* ---------- diagnosi GHL: mostra cosa risponde davvero l'API ---------- */
app.get("/api/ghl-debug", checkKey, async (_req,res)=>{
  const out={};
  try{
    const pipes = await ghlGET(`/opportunities/pipelines?locationId=${GHL_LOCATION_ID}`);
    out.pipelines=(pipes.pipelines||[]).map(p=>({nome:p.name, fasi:(p.stages||[]).map(s=>s.name)}));
  }catch(e){ out.pipelines="ERRORE: "+e.message; }
  const tutti=new Map();
  for(const q of ["?model=opportunity","?model=contact","?model=all",""]){
    try{
      const defs = await ghlGET(`/locations/${GHL_LOCATION_ID}/customFields${q}`);
      (defs.customFields||[]).forEach(f=>tutti.set(f.id,f.name));
      out["campi"+(q||"?default")]=(defs.customFields||[]).length+" campi";
    }catch(e){ out["campi"+(q||"?default")]="ERRORE: "+e.message; }
  }
  out.campiChiave={};
  for(const n of ["cash","contrattualizzato","data vendita","utm campaign","utm source"]){
    out.campiChiave[n]=[...tutti.values()].filter(v=>String(v).toLowerCase().includes(n));
  }
  out.tuttiICampi=[...tutti.values()];
  try{
    const j = await ghlGET(`/opportunities/search?location_id=${GHL_LOCATION_ID}&limit=3&page=1`);
    out.esempioOpportunita=(j.opportunities||[]).map(o=>({
      nome:o.name, fase:o.pipelineStageId, creata:o.createdAt, valore:o.monetaryValue,
      chiavi:Object.keys(o),
      customFields:(o.customFields||o.customField||[]).slice(0,25)
    }));
  }catch(e){ out.esempioOpportunita="ERRORE: "+e.message; }
  res.json(out);
});

/* ============================================================
   REPORT IA (aggiunta v2.2) — facoltativo, non tocca il resto.
   Rifinisce il report della dashboard con Claude (Anthropic).
   Per attivarlo, su Render → Environment aggiungi:
     ANTHROPIC_API_KEY = chiave presa da console.anthropic.com
   (facoltativo: ANTHROPIC_MODEL per cambiare modello)
   Senza chiave l'endpoint risponde 501 e la dashboard mostra
   comunque il report scritto in locale: nulla si rompe.
   ============================================================ */
const REPORT_AI_SYSTEM =
  "Sei l'analista marketing di Freedom University. Ricevi un report KPI generato da una dashboard " +
  "(funnel: Meta Ads → lead → setter → closer). Riscrivilo come messaggio professionale, chiaro e " +
  "sintetico da inviare al responsabile via WhatsApp o email, in italiano. Regole tassative: usa SOLO i numeri " +
  "presenti nel report, non inventarne e non ricalcolarne; mantieni le sezioni (Advertising, Setting, Closing, " +
  "Economics, Confronto, Campagne, Lettura) accorpandole solo se vuote; grassetti in stile WhatsApp con " +
  "*asterischi*; niente tabelle, niente markdown con #; chiudi con una lettura manageriale di 2-3 frasi e UNA " +
  "raccomandazione operativa concreta. Rispondi solo con il testo del report, senza premesse né commenti.";

app.post("/api/report-ai", checkKey, async (req, res) => {
  try{
    const AI_KEY = process.env.ANTHROPIC_API_KEY || "";
    if(!AI_KEY) return res.status(501).json({ ok:false, error:"IA non configurata: aggiungi ANTHROPIC_API_KEY nelle variabili d'ambiente su Render (chiave da console.anthropic.com)." });
    const report = String((req.body && req.body.report) || "").slice(0, 20000);
    if(!report.trim()) return res.status(400).json({ ok:false, error:"Report vuoto." });

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": AI_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
        max_tokens: 1500,
        system: REPORT_AI_SYSTEM,
        messages: [{ role:"user", content: "Riscrivi questo report KPI per il mio responsabile:\n\n" + report }]
      })
    });
    const j = await r.json();
    if(j.error) throw new Error(j.error.message || "Errore dell'API IA");
    const testo = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    if(!testo) throw new Error("Risposta IA vuota.");
    res.json({ ok:true, testo });
  }catch(err){
    res.status(500).json({ ok:false, error:String(err.message || err) });
  }
});

app.listen(PORT, ()=>console.log(`KPI server v2 attivo sulla porta ${PORT}`));
