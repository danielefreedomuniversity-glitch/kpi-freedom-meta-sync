# Collegare la dashboard al Business Manager — guida completa

Tempo stimato: 20–30 minuti la prima volta. Poi tutto automatico.

## 1. Crea un'app su Meta for Developers
1. Vai su https://developers.facebook.com/apps → **Crea app**
2. Tipo di app: **Business**
3. Dai un nome (es. "KPI Freedom University Sync") e collegala al tuo Business Manager
4. Nella dashboard dell'app, aggiungi il prodotto **Marketing API**

## 2. Genera il token di sistema (System User Token)
Questo è il passo più importante: usa un utente di sistema, non il tuo token personale, perché non scade e puoi limitarne i permessi.

1. Vai su **business.facebook.com → Impostazioni aziendali → Utenti → Utenti di sistema**
2. **Aggiungi** → crea un utente di sistema con ruolo "Amministratore" (o "Dipendente" se preferisci limitare)
3. Selezionalo → **Aggiungi risorse** → assegna l'account pubblicitario giusto con permesso "Controllo totale" (o almeno "Analisi")
4. **Genera nuovo token** → seleziona la tua app (creata al punto 1) → permessi: **ads_read** (basta questo, non serve altro)
5. Copia il token: comincia con `EAA...`. Non scade, ma puoi revocarlo in qualsiasi momento dallo stesso pannello.

## 3. Trova l'ID del tuo account pubblicitario
In Gestione inserzioni, in alto a sinistra vedi qualcosa come "Account: 123456789012345". Ti serve solo la parte numerica, senza "act_" davanti.

## 4. Configura il server
1. Scarica questa cartella
2. Rinomina `.env.example` in `.env`
3. Compila:
   - `META_TOKEN` = il token del punto 2
   - `META_AD_ACCOUNT_ID` = il numero del punto 3
   - `SYNC_API_KEY` = una password a piacere, la userai anche nella dashboard

## 5. Mettilo online (serve un indirizzo pubblico, non basta il tuo PC)
Il modo più semplice e gratuito è **Render.com**:
1. Crea un repository GitHub con questi file (index.js, package.json, .env.example — NON caricare il tuo .env vero)
2. Su Render.com → **New → Web Service** → collega il repository
3. Build command: `npm install` · Start command: `npm start`
4. In **Environment**, aggiungi le stesse variabili del tuo `.env` (META_TOKEN, META_AD_ACCOUNT_ID, SYNC_API_KEY)
5. Deploy. Render ti darà un indirizzo tipo `https://kpi-freedom-sync.onrender.com`

Alternative equivalenti: Railway.app, Fly.io, un VPS qualsiasi con `pm2 start index.js`.

## 6. Collega la dashboard
Nella dashboard, apri **Importa da Meta → Sincronizzazione automatica**, e inserisci:
- Indirizzo del server: `https://kpi-freedom-sync.onrender.com`
- Chiave: quella che hai messo in `SYNC_API_KEY`

Da lì in poi, **Sincronizza ora** chiama il server, che interroga Meta e restituisce spesa, impressions, reach, click, video, lead di ogni campagna/adset/inserzione, giorno per giorno, per il mese aperto nella dashboard.

## Cosa resta manuale
Meta conosce solo la parte Advertising (spesa, click, lead...). Non sa nulla di call fissate, show, vendite, cash: quelli stanno nel tuo CRM/calendario e restano da inserire a mano, oppure — se il tuo CRM ha un'API — posso costruire un secondo endpoint identico a questo per quello.

## Nota sui tempi
Non esiste un "tempo reale" vero nemmeno dentro Meta Ads Manager: i dati si consolidano con qualche ora di ritardo per via delle finestre di attribuzione (click e view fino a 7/1 giorno dopo). Il server può essere richiamato anche ogni 15 minuti se vuoi, ma i numeri delle ultime ore saranno comunque provvisori — è così ovunque, non solo qui.
