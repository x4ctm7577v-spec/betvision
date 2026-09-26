// BetVision (100xBajo) - servidor de datos en vivo
// Requiere Node.js 18 o superior. Sin dependencias externas.
const http = require('http');
const fs = require('fs');
const path = require('path');

const KEY = process.env.ODDS_API_KEY;                 // tu clave de The Odds API
const PORT = process.env.PORT || 3000;
const SPORTS = (process.env.SPORTS || 'baseball_mlb,americanfootball_nfl').split(',').map(s => s.trim()).filter(Boolean);
const REGIONS = process.env.REGIONS || 'us';           // 'us' o 'us,eu' (eu incluye Pinnacle, cuesta el doble)
const MY_BOOK = process.env.MY_BOOK || 'hardrockbet';  // clave de tu casa en The Odds API
const REFRESH_MIN = Number(process.env.REFRESH_MIN) || 180; // cada cuántos minutos actualizar

const LABEL = {
  baseball_mlb: 'MLB', americanfootball_nfl: 'NFL', icehockey_nhl: 'NHL', basketball_nba: 'NBA',
  soccer_spain_la_liga: 'LaLiga', soccer_epl: 'Premier League', soccer_mexico_ligamx: 'Liga MX',
  soccer_uefa_champs_league: 'Champions League', mma_mixed_martial_arts: 'UFC/MMA'
};

let cache = { updated: null, games: [], reco: null, remaining: null, errors: [], myBook: MY_BOOK };

async function fetchSport(sport) {
  const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds?apiKey=${KEY}&regions=${REGIONS}&markets=h2h&oddsFormat=decimal`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${LABEL[sport] || sport}: error ${r.status} ${await r.text()}`);
  cache.remaining = r.headers.get('x-requests-remaining');
  return r.json();
}

// Probabilidad de consenso: quita el margen de cada casa y promedia.
function analyze(ev, sport) {
  const books = [];
  for (const b of ev.bookmakers || []) {
    const m = (b.markets || []).find(x => x.key === 'h2h');
    if (!m) continue;
    const prices = {};
    m.outcomes.forEach(o => { prices[o.name] = o.price; });
    books.push({ key: b.key, title: b.title, prices });
  }
  if (!books.length) return null;
  let names = [...new Set(books.flatMap(b => Object.keys(b.prices)))];
  names.sort((a, b) => (a === ev.home_team ? -1 : b === ev.home_team ? 1 : a === 'Draw' ? 1 : b === 'Draw' ? -1 : 0));
  const sums = Object.fromEntries(names.map(n => [n, 0]));
  let used = 0;
  for (const b of books) {
    if (!names.every(n => b.prices[n])) continue;
    const raw = names.map(n => 1 / b.prices[n]);
    const tot = raw.reduce((a, c) => a + c, 0);
    names.forEach((n, i) => { sums[n] += raw[i] / tot; });
    used++;
  }
  if (!used) return null;
  const mine = books.find(b => b.key === MY_BOOK);
  const outcomes = names.map(n => {
    const p = sums[n] / used;
    let best = null;
    for (const b of books) {
      const pr = b.prices[n];
      if (pr && (!best || pr > best.price)) best = { price: pr, book: b.title };
    }
    const myPrice = mine ? mine.prices[n] || null : null;
    return { name: n, p, fair: 1 / p, best, myPrice, evBest: p * best.price - 1, evMine: myPrice ? p * myPrice - 1 : null };
  });
  return { id: ev.id, sport, league: LABEL[sport] || sport, start: ev.commence_time, home: ev.home_team, away: ev.away_team, books: used, hasMyBook: !!mine, outcomes };
}

// Dos parlays: el de más probabilidad y el de más valor (si existe).
function recommend(games) {
  const now = Date.now();
  const up = games.filter(g => new Date(g.start).getTime() > now && g.outcomes.length === 2);
  const pick = list => { const seen = new Set(), out = []; for (const c of list) { if (seen.has(c.gid)) continue; seen.add(c.gid); out.push(c); if (out.length === 3) break; } return out; };
  const cands = up.flatMap(g => g.outcomes.map(o => ({ gid: g.id, league: g.league, start: g.start, team: o.name, vs: o.name === g.home ? g.away : g.home, p: o.p, price: o.myPrice || o.best.price, book: o.myPrice ? 'tu casa' : o.best.book, ev: o.myPrice ? o.evMine : o.evBest })));
  const safest = pick([...cands].sort((a, b) => b.p - a.p)).slice(0, 2);
  const value = pick(cands.filter(c => c.ev > 0.01 && c.p >= 0.35).sort((a, b) => b.ev - a.ev));
  const sum = legs => legs.length ? { legs, p: legs.reduce((t, x) => t * x.p, 1), price: legs.reduce((t, x) => t * x.price, 1) } : null;
  const s = sum(safest), v = sum(value);
  if (s) s.ev = s.p * s.price - 1;
  if (v) v.ev = v.p * v.price - 1;
  return { safest: s, value: v && v.legs.length >= 2 ? v : null };
}

async function refresh() {
  if (!KEY) { cache.errors = ['Falta la variable ODDS_API_KEY']; return; }
  const errors = [], games = [];
  for (const s of SPORTS) {
    try { (await fetchSport(s)).forEach(ev => { const g = analyze(ev, s); if (g) games.push(g); }); }
    catch (e) { errors.push(e.message); }
  }
  games.sort((a, b) => new Date(a.start) - new Date(b.start));
  cache = { ...cache, updated: new Date().toISOString(), games, reco: recommend(games), errors };
  console.log(`[${cache.updated}] ${games.length} partidos. Créditos restantes: ${cache.remaining}`);
}

const INDEX = fs.existsSync(path.join(__dirname, 'index.html')) ? path.join(__dirname, 'index.html') : path.join(__dirname, 'public', 'index.html');
http.createServer((req, res) => {
  if (req.url.startsWith('/api/data')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(cache));
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  fs.createReadStream(INDEX).pipe(res);
}).listen(PORT, () => console.log(`BetVision escuchando en el puerto ${PORT}`));

refresh();
setInterval(refresh, REFRESH_MIN * 60 * 1000);
