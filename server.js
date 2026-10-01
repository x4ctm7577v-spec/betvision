// BetVision (100xBajo) - Fase 1: cuotas en vivo, cuentas, suscripción, registro de apuestas y CLV
// Node.js 18+. Dependencias: stripe, @supabase/supabase-js
const http = require('http');
const fs = require('fs');
const path = require('path');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const E = process.env;
const PORT = E.PORT || 3000;
const APP_URL = (E.APP_URL || '').replace(/\/$/, '');
const SPORTS = (E.SPORTS || 'baseball_mlb,americanfootball_nfl').split(',').map(s => s.trim()).filter(Boolean);
const REGIONS = E.REGIONS || 'us';
const MY_BOOK = E.MY_BOOK || 'hardrockbet';
const REFRESH_MIN = Number(E.REFRESH_MIN) || 180;
const TRIAL_DAYS = Number(E.TRIAL_DAYS) || 7;
const SCORES_MIN = Number(E.SCORES_MIN) || 360;   // cada cuánto consultar marcadores (cuesta créditos)
const PICK_MIN_EV = Number(E.PICK_MIN_EV) || 0.03; // valor mínimo para guardar una selección en el récord

// Limpia el SUPABASE_URL por si se pegó con algo de más (por ejemplo /rest/v1/)
let SUPA_URL = (E.SUPABASE_URL || '').trim();
try { if (SUPA_URL) SUPA_URL = new URL(SUPA_URL).origin; } catch (e) { console.error('SUPABASE_URL no es válido'); }
const SUPA_ANON = (E.SUPABASE_ANON_KEY || '').trim();
const stripe = E.STRIPE_SECRET_KEY ? Stripe(E.STRIPE_SECRET_KEY) : null;
const sb = SUPA_URL && E.SUPABASE_SERVICE_KEY ? createClient(SUPA_URL, E.SUPABASE_SERVICE_KEY.trim(), { auth: { persistSession: false } }) : null;

const LABEL = { baseball_mlb: 'MLB', americanfootball_nfl: 'NFL', icehockey_nhl: 'NHL', basketball_nba: 'NBA', soccer_spain_la_liga: 'LaLiga', soccer_epl: 'Premier League', soccer_mexico_ligamx: 'Liga MX', mma_mixed_martial_arts: 'UFC/MMA' };
// Afiliados: JSON en la variable AFFILIATES, por ejemplo
// [{"key":"hardrockbet","name":"Hard Rock Bet","url":"https://tu-enlace-de-afiliado","deeplink":"","offer":"","states":["FL"]}]
// "deeplink" es opcional: una plantilla con {url} si el programa permite enlazar a una jugada con tu código.
let AFFILIATES = [];
try { AFFILIATES = JSON.parse(E.AFFILIATES || '[]'); } catch (e) { console.error('AFFILIATES no es un JSON válido'); }
const affOf = key => AFFILIATES.find(a => a.key === key);
let cache = { updated: null, games: [], reco: null, remaining: null, errors: [], myBook: MY_BOOK };

/* ---------- Cuotas y probabilidad de consenso ---------- */
async function oddsApi(pathAndQuery) {
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const r = await fetch(`https://api.the-odds-api.com/v4/${pathAndQuery}${sep}apiKey=${E.ODDS_API_KEY}`);
  if (!r.ok) throw new Error(`The Odds API ${r.status}: ${await r.text()}`);
  cache.remaining = r.headers.get('x-requests-remaining');
  return r.json();
}
function analyze(ev, sport) {
  const books = [];
  for (const b of ev.bookmakers || []) {
    const m = (b.markets || []).find(x => x.key === 'h2h');
    if (!m) continue;
    const prices = {}, links = {};
    m.outcomes.forEach(o => { prices[o.name] = o.price; links[o.name] = o.link || m.link || b.link || null; });
    books.push({ key: b.key, title: b.title, prices, links });
  }
  if (!books.length) return null;
  const names = [...new Set(books.flatMap(b => Object.keys(b.prices)))];
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
    for (const b of books) { const pr = b.prices[n]; if (pr && (!best || pr > best.price)) best = { price: pr, book: b.title, link: b.links[n] }; }
    const myPrice = mine ? mine.prices[n] || null : null;
    const myLink = mine ? mine.links[n] : null;
    const byBook = {};
    for (const b of books) if (b.prices[n]) byBook[b.key] = { t: b.title, pr: b.prices[n], l: b.links[n] || null };
    return { name: n, p, fair: 1 / p, best, myPrice, myLink, myBook: mine ? mine.title : null, byBook, evBest: p * best.price - 1, evMine: myPrice ? p * myPrice - 1 : null };
  });
  return { id: ev.id, sport, league: LABEL[sport] || sport, start: ev.commence_time, home: ev.home_team, away: ev.away_team, books: used, hasMyBook: !!mine, outcomes };
}
function recommend(games) {
  const now = Date.now();
  const up = games.filter(g => new Date(g.start).getTime() > now && g.outcomes.length === 2);
  const pick = list => { const seen = new Set(), out = []; for (const c of list) { if (seen.has(c.gid)) continue; seen.add(c.gid); out.push(c); if (out.length === 3) break; } return out; };
  const cands = up.flatMap(g => g.outcomes.map((o, i) => {
    const fl = g.ctx ? g.ctx.flags.filter(f => f.team === o.name || (f.team == null && f.risk)) : [];
    const pb = o.pBV != null ? o.pBV : o.p, price = o.myPrice || o.best.price;
    return { gid: g.id, idx: i, league: g.league, start: g.start, team: o.name, vs: o.name === g.home ? g.away : g.home, p: pb, pc: o.p, price, ev: pb * price - 1, risk: fl.filter(f => f.risk).map(f => f.text), notes: fl.filter(f => !f.risk).map(f => f.text), bestPrice: o.best.price, bestBook: o.best.book, plus: fl.some(f => f.plus), tags: fl.map(f => f.tag).filter(Boolean) };
  }));
  // Más seguro: machos de 60 % o más sin riesgos de contexto; si no hay suficientes, los más probables con sus avisos
  const safeC = cands.filter(c => c.p >= 0.6 && !c.risk.length && c.team !== 'Draw').sort((a, b) => b.p - a.p);
  let safest = pick(safeC).slice(0, 2), safeFiltered = true;
  if (safest.length < 2) { safest = pick([...cands].filter(c => c.team !== 'Draw').sort((a, b) => b.p - a.p)).slice(0, 2); safeFiltered = false; }
  const macho = safeC[0] || null;
  const value = pick(cands.filter(c => c.ev > 0.01 && c.p >= 0.35).sort((a, b) => b.ev - a.ev));
  const sum = legs => { if (!legs.length) return null; const p = legs.reduce((t, x) => t * x.p, 1), price = legs.reduce((t, x) => t * x.price, 1); return { legs, p, price, ev: p * price - 1 }; };
  const v = sum(value);
  // Underdogs: pagan +120 o más, con al menos 35 % de probabilidad y valor positivo
  const dogs = cands.filter(c => c.price >= 2.2 && c.p >= 0.35 && c.ev > 0.02).sort((a, b) => b.ev - a.ev);
  const dogList = [], seenDog = new Set();
  for (const c of dogs) { if (seenDog.has(c.gid)) continue; seenDog.add(c.gid); dogList.push(c); if (dogList.length === 6) break; }
  const dp = sum(dogList.slice(0, 2));
  const context = []; { const seen = new Set(); for (const c of cands.filter(c => c.plus && c.ev > 0).sort((a, b) => b.ev - a.ev)) { if (seen.has(c.gid)) continue; seen.add(c.gid); context.push(c); if (context.length === 5) break; } }
  // Rebote: todos los equipos que vienen de perder (se muestran con su valor real, sea bueno o malo)
  const rebote = []; { const seen = new Set(); for (const c of cands.filter(c => c.tags.includes('rebote')).sort((a, b) => b.p - a.p)) { const k = c.gid + c.team; if (seen.has(k)) continue; seen.add(k); rebote.push(c); if (rebote.length === 8) break; } }
  // Recomendación BetVision: junta todo (valor, pitcheo, bullpen, motivación, rebote) y descarta los riesgos
  const W = { sp: 3, bp: 2, full: 2, rebote: 1 };
  const scored = cands.filter(c => c.team !== 'Draw' && c.p >= 0.4 && !c.risk.length).map(c => {
    // El valor se mide con la mejor cuota disponible (la que conviene buscar)
    const evB = c.p * c.bestPrice - 1, reasons = c.tags.filter(t => W[t]).length + (c.plus ? 1 : 0);
    let sc = evB * 50;
    for (const t of c.tags) if (W[t]) sc += W[t];
    if (c.plus) sc += 2;
    return Object.assign({}, c, { score: sc, evBest: evB, reasons });
  }).filter(c => (c.reasons > 0 || c.evBest > 0) && c.evBest > -0.045 && c.score > 0).sort((a, b) => b.score - a.score);
  const bvLegs = pick(scored).slice(0, 3);
  const bv = bvLegs.length >= 2 ? sum(bvLegs) : null;
  return { bv, bvTop: scored[0] || null, rebote, safest: sum(safest), safeFiltered, macho, context, value: v && v.legs.length >= 2 ? v : null, dogs: dogList, dogParlay: dp && dp.legs.length === 2 ? dp : null };
}


/* ---------- Contexto MLB: récord, rachas, abridores y clasificados ----------
   Fuente: API pública de MLB (statsapi.mlb.com). Sirve para probar; para cobrar
   hay que usar un proveedor con licencia comercial. Se apaga con MLB_CONTEXT=off. */
const MLB_CTX = E.MLB_CONTEXT !== 'off';
let mlbCtx = { at: 0, teams: {}, games: [], pens: {} };
const norm = x => String(x || '').toLowerCase().normalize('NFD').replace(/[^a-z ]/g, '').trim();
const tk = name => { const w = norm(name).split(' ').filter(Boolean); return w[w.length - 1] === 'sox' ? w.slice(-2).join(' ') : w[w.length - 1]; };
async function getJson(url) { const r = await fetch(url); if (!r.ok) throw new Error('MLB ' + r.status); return r.json(); }
async function loadMlbContext() {
  if (!MLB_CTX || Date.now() - mlbCtx.at < 30 * 60e3) return;
  const season = new Date().getFullYear(), teams = {}, games = [], pids = new Set();
  try {
    const st = await getJson(`https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=${season}&standingsTypes=regularSeason`);
    for (const rec of st.records || []) for (const t of rec.teamRecords || []) {
      const sr = (t.records && t.records.splitRecords) || [];
      const l10 = sr.find(x => x.type === 'lastTen'), hm = sr.find(x => x.type === 'home'), aw = sr.find(x => x.type === 'away');
      teams[tk(t.team.name)] = {
        name: t.team.name, w: t.wins, l: t.losses, streak: t.streak ? t.streak.streakCode : null,
        l10: l10 ? `${l10.wins}-${l10.losses}` : null, clinched: !!t.clinched,
        elim: !t.clinched && t.eliminationNumber === 'E' && t.wildCardEliminationNumber === 'E',
        left: 162 - (t.wins + t.losses),
        homeRec: hm ? [hm.wins, hm.losses] : null, awayRec: aw ? [aw.wins, aw.losses] : null
      };
    }
  } catch (e) { console.error('Contexto MLB (posiciones):', e.message); }
  try {
    const d = x => new Date(x).toISOString().slice(0, 10);
    const sc = await getJson(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${d(Date.now() - 7 * 864e5)}&endDate=${d(Date.now() + 3 * 864e5)}&hydrate=probablePitcher,seriesStatus,venue(location,fieldInfo)`);
    for (const day of sc.dates || []) for (const g of day.games || []) {
      const hp = g.teams.home.probablePitcher, ap = g.teams.away.probablePitcher;
      if (hp) pids.add(hp.id); if (ap) pids.add(ap.id);
      const ss = g.seriesStatus || {};
      const final = g.status && (g.status.abstractGameState === 'Final' || /final|completed/i.test(g.status.detailedState || ''));
      games.push({ date: g.gameDate, type: g.gameType, series: g.seriesDescription || '', seriesState: ss.result || ss.description || null, gameNo: g.seriesGameNumber || null, ofGames: g.gamesInSeries || null,
        final: !!final, hs: g.teams.home.score, as: g.teams.away.score, venue: g.venue ? { name: g.venue.name, lat: g.venue.location && g.venue.location.defaultCoordinates && g.venue.location.defaultCoordinates.latitude, lon: g.venue.location && g.venue.location.defaultCoordinates && g.venue.location.defaultCoordinates.longitude, roof: g.venue.fieldInfo && g.venue.fieldInfo.roofType } : null,
        home: g.teams.home.team.name, away: g.teams.away.team.name, hid: g.teams.home.team.id, aid: g.teams.away.team.id, hp: hp ? { id: hp.id, name: hp.fullName } : null, ap: ap ? { id: ap.id, name: ap.fullName } : null });
    }
  } catch (e) { console.error('Contexto MLB (calendario):', e.message); }
  if (pids.size) {
    try {
      const pe = await getJson(`https://statsapi.mlb.com/api/v1/people?personIds=${[...pids].join(',')}&hydrate=stats(group=[pitching],type=[season],season=${season})`);
      const ps = {};
      for (const p of pe.people || []) { const sp = (((p.stats || [])[0] || {}).splits || [])[0]; if (sp && sp.stat) ps[p.id] = { era: sp.stat.era, whip: sp.stat.whip, w: sp.stat.wins, l: sp.stat.losses, ip: sp.stat.inningsPitched, so: sp.stat.strikeOuts }; }
      games.forEach(g => { if (g.hp) Object.assign(g.hp, ps[g.hp.id] || {}); if (g.ap) Object.assign(g.ap, ps[g.ap.id] || {}); });
    } catch (e) { console.error('Contexto MLB (abridores):', e.message); }
  }
  // Bullpen y cerrador de los equipos que juegan en los próximos días
  const pens = {};
  const soon = games.filter(g => !g.final && new Date(g.date).getTime() > Date.now() - 6 * 3600e3);
  const ids = [...new Set(soon.flatMap(g => [g.hid, g.aid]).filter(Boolean))].slice(0, 30);
  for (const id of ids) {
    const pen = {};
    try {
      const rp = await getJson(`https://statsapi.mlb.com/api/v1/teams/${id}/stats?stats=statSplits&group=pitching&season=${season}&sitCodes=rp`);
      const st = ((((rp.stats || [])[0] || {}).splits || [])[0] || {}).stat;
      if (st) { pen.era = st.era; pen.whip = st.whip; }
    } catch (e) { /* sin dato de bullpen */ }
    try {
      const ld = await getJson(`https://statsapi.mlb.com/api/v1/teams/${id}/leaders?leaderCategories=saves&season=${season}&limit=1`);
      const top = ((((ld.teamLeaders || [])[0] || {}).leaders || [])[0]) || null;
      if (top && top.person) {
        pen.closer = { id: top.person.id, name: top.person.fullName, sv: Number(top.value) || null };
        const cs = await getJson(`https://statsapi.mlb.com/api/v1/people/${top.person.id}/stats?stats=season,gameLog&group=pitching&season=${season}`);
        for (const blk of cs.stats || []) {
          const type = blk.type && blk.type.displayName;
          if (type === 'season' && blk.splits && blk.splits[0]) { const t = blk.splits[0].stat; Object.assign(pen.closer, { era: t.era, whip: t.whip, sv: t.saves, bs: t.blownSaves }); }
          if (type === 'gameLog') {
            const days = new Set((blk.splits || []).map(x => x.date).filter(Boolean));
            // En playoffs, sumar también los juegos de postemporada
            try {
              const po = await getJson(`https://statsapi.mlb.com/api/v1/people/${top.person.id}/stats?stats=gameLog&group=pitching&season=${season}&gameType=F,D,L,W`);
              for (const b2 of po.stats || []) for (const x of b2.splits || []) if (x.date) days.add(x.date);
            } catch (e) { /* sin juegos de postemporada */ }
            const ago = n => new Date(Date.now() - n * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
            pen.closer.pitchedYesterday = days.has(ago(1));
            pen.closer.pitchedTwoDays = days.has(ago(1)) && days.has(ago(2));
            pen.closer.last3 = [1, 2, 3].filter(n => days.has(ago(n))).length;
          }
        }
      }
    } catch (e) { /* sin dato de cerrador */ }
    if (Object.keys(pen).length) pens[id] = pen;
  }
  for (const g of soon) {
    const v = g.venue, t = new Date(g.date).getTime();
    if (!v || v.lat == null || /dome|retractable/i.test(v.roof || '') || t - Date.now() > 48 * 3600e3) continue;
    try {
      const w = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${v.lat}&longitude=${v.lon}&hourly=precipitation_probability,temperature_2m,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=UTC&forecast_days=3`);
      const H = w.hourly || {}, hour = new Date(Math.round(t / 3600e3) * 3600e3).toISOString().slice(0, 13) + ':00';
      const i = (H.time || []).indexOf(hour);
      if (i >= 0) g.wx = { rain: H.precipitation_probability[i], temp: Math.round(H.temperature_2m[i]), wind: Math.round(H.wind_speed_10m[i]), venue: v.name };
    } catch (e) { /* sin clima */ }
  }
  if (Object.keys(teams).length || games.length) mlbCtx = { at: Date.now(), teams, games, pens };
}
// Probabilidad BetVision: el consenso de las casas ajustado por contexto (máximo ±5 puntos)
function applyContext(g) {
  // Motivación (ya existía) + pitcheo. Los pesos son pequeños a propósito: el mercado ya descuenta
  // buena parte del pitcheo, y se ajustarán con los resultados del Récord.
  const TILT = { sp: 0.015, bp: 0.01, full: 0.005, closer: -0.015 };
  const adjOf = name => {
    const fl = (g.ctx ? g.ctx.flags : []).filter(f => f.team === name);
    const a = fl.filter(f => f.plus).reduce((t, f) => t + f.adj, 0) + fl.reduce((t, f) => t + (TILT[f.tag] || 0), 0);
    return Math.max(-0.05, Math.min(0.05, a));
  };
  const two = g.outcomes.length === 2;
  for (const o of g.outcomes) {
    let a = adjOf(o.name);
    if (two) a -= adjOf(g.outcomes.find(x => x !== o).name);
    o.pBV = Math.max(0.02, Math.min(0.98, o.p + a));
    o.adj = o.pBV - o.p;
    const price = o.myPrice || o.best.price;
    o.evBV = o.pBV * price - 1;
  }
  g.pick = selectFor(g);
}
// Selección por partido: analiza a los dos equipos y elige el de mejor escenario (puede ser el underdog)
function selectFor(g) {
  if (g.outcomes.length !== 2) return null;
  const c = g.ctx, fl = c && !c.locked ? c.flags : [];
  const sides = g.outcomes.map((o, idx) => {
    const price = o.myPrice || o.best.price, pM = o.pBV != null ? o.pBV : o.p, pImpl = 1 / price;
    const mine = fl.filter(f => f.team === o.name || (f.team == null && f.risk));
    const pro = mine.filter(f => !f.risk).map(f => f.text), con = mine.filter(f => f.risk).map(f => f.text);
    if (o.name === g.home) pro.push('Juega en casa.');
    return { idx, team: o.name, pM, pMarket: o.p, pImpl, edge: pM - pImpl, ev: pM * price - 1, price, book: o.myPrice ? o.myBook : o.best.book, pro, con };
  });
  const unc = [];
  if (g.sport === 'baseball_mlb') {
    if (!c || c.locked) unc.push('Sin datos del partido (abridores, bullpen).');
    else { for (const x of [c.home, c.away]) if (!x.pitcher) unc.push(`${x.team} no ha anunciado abridor.`); }
  }
  if (g.books < 4) unc.push(`Solo ${g.books} casas con cuota: el consenso es menos confiable.`);
  if (new Date(g.start).getTime() - Date.now() > 30 * 3600e3) unc.push('Falta más de un día: la cuota y las alineaciones pueden cambiar.');
  const byEv = [...sides].sort((a, b) => b.ev - a.ev)[0];
  const byP = [...sides].sort((a, b) => b.pM - a.pM)[0];
  let sel, state;
  if (byEv.ev > 0) { sel = byEv; if (byEv.con.length) unc.push(`${byEv.team} tiene un riesgo: ${byEv.con[0]}`); if (byEv.ev < 0.02) unc.push('La ventaja sobre el precio es muy pequeña (menos de 2 %).'); state = !unc.length ? 'verde' : 'amarillo'; }
  else { sel = byP; state = 'blanco'; }
  const other = sides.find(x => x !== sel);
  return { state, team: sel.team, idx: sel.idx, underdog: sel.pMarket < other.pMarket, pM: sel.pM, pMarket: sel.pMarket, pImpl: sel.pImpl, edge: sel.edge, ev: sel.ev, price: sel.price, book: sel.book, uncertainty: unc.length ? 'alta' : 'baja', unc, sides };
}
const nick = n => /Sox$|Jays$/.test(n) ? n.split(' ').slice(-2).join(' ') : n.split(' ').pop();
function mlbContextFor(g) {
  if (g.sport !== 'baseball_mlb' || (!Object.keys(mlbCtx.teams).length && !mlbCtx.games.length)) return null;
  const t0 = new Date(g.start).getTime();
  const mg = mlbCtx.games.find(x => tk(x.home) === tk(g.home) && tk(x.away) === tk(g.away) && Math.abs(new Date(x.date) - t0) < 6 * 3600e3);
  const post = mg ? !['R', 'S', 'E', 'A'].includes(mg.type) : false;
  const side = (name, p) => { const t = mlbCtx.teams[tk(name)]; return { homeRec: t ? t.homeRec : null, awayRec: t ? t.awayRec : null, team: name, record: t ? `${t.w}-${t.l}` : null, l10: t ? t.l10 : null, streak: t ? t.streak : null, clinched: t ? t.clinched : false, elim: t ? t.elim : false, left: t ? t.left : null, pitcher: p || null }; };
  const H = side(g.home, mg && mg.hp), A = side(g.away, mg && mg.ap), flags = [];
  const pens = mlbCtx.pens || {};
  if (mg) { H.bullpen = pens[mg.hid] || null; A.bullpen = pens[mg.aid] || null; }
  for (const x of [H, A]) {
    if (!post && x.clinched && x.left !== null && x.left <= 3) flags.push({ team: x.team, risk: true, text: `${x.team} ya clasificó: podría descansar titulares. Confirma la alineación.` });
    if (!post && x.elim) flags.push({ team: x.team, risk: false, text: `${x.team} ya está eliminado.` });
    if (mg && !x.pitcher) flags.push({ team: x.team, risk: true, text: `${x.team} todavía no anuncia abridor.` });
    const y = x === H ? A : H;
    if (!post && y.clinched && y.left !== null && y.left <= 3 && !x.clinched) flags.push({ team: x.team, plus: true, adj: x.elim ? 0.02 : 0.04, text: x.elim ? `${x.team} juega contra un rival que ya clasificó y puede sentar a sus estrellas.` : `${x.team} todavía necesita ganar y su rival ya clasificó: puede sentar a sus estrellas. Ventaja de motivación.` });
    const m = /^([WL])(\d+)$/.exec(x.streak || '');
    if (m && +m[2] >= 3) flags.push({ team: x.team, risk: false, text: `${x.team} lleva ${m[2]} ${m[1] === 'W' ? 'victorias' : 'derrotas'} seguidas. Ojo: las rachas no predicen el próximo juego.` });
  }
  // De local / de visitante
  const pctRec = r => r && r[0] + r[1] >= 20 ? r[0] / (r[0] + r[1]) : null;
  const ah = pctRec(H.homeRec), aa = pctRec(A.awayRec);
  if (ah != null && ah >= 0.6) flags.push({ team: H.team, risk: false, tag: 'casa', chip: `🏠 ${nick(H.team)} fuerte en casa`, text: `${H.team} es fuerte en casa: ${H.homeRec[0]}-${H.homeRec[1]}.` });
  if (aa != null && aa <= 0.42) flags.push({ team: A.team, risk: false, tag: 'visita', chip: `✈️ ${nick(A.team)} flojo de visitante`, text: `${A.team} sufre de visitante: ${A.awayRec[0]}-${A.awayRec[1]}.` });
  if (aa != null && aa >= 0.58) flags.push({ team: A.team, risk: false, tag: 'visita', chip: `✈️ ${nick(A.team)} gana de visitante`, text: `${A.team} juega bien de visitante: ${A.awayRec[0]}-${A.awayRec[1]}.` });
  // Clima
  const wx = mg && mg.wx;
  if (wx) {
    if (wx.rain >= 50) flags.push({ team: null, risk: true, tag: 'lluvia', chip: `🌧️ Lluvia ${wx.rain} %`, text: `Lluvia probable (${wx.rain} %) en ${wx.venue}: el juego puede retrasarse o suspenderse. Revisa las reglas de tu casa para juegos suspendidos.` });
    else if (wx.rain >= 30) flags.push({ team: null, risk: false, tag: 'lluvia', chip: `🌦️ Posible lluvia ${wx.rain} %`, text: `Posible lluvia (${wx.rain} %) en ${wx.venue}.` });
    if (wx.wind >= 15) flags.push({ team: null, risk: false, tag: 'viento', chip: `💨 Viento ${wx.wind} mph`, text: `Viento fuerte (${wx.wind} mph): puede afectar los batazos largos y el total de carreras.` });
    if (wx.temp <= 50) flags.push({ team: null, risk: false, tag: 'frio', chip: `🥶 ${wx.temp}°F`, text: `Hace frío (${wx.temp}°F): la pelota vuela menos, suele favorecer juegos de pocas carreras.` });
  }
  for (const x of [H, A]) {
    const c = x.bullpen && x.bullpen.closer;
    if (c && c.pitchedTwoDays) flags.push({ team: x.team, risk: true, tag: 'closer', chip: `😮‍💨 Cerrador de ${nick(x.team)} cansado`, text: `El cerrador de ${x.team} (${c.name}) lanzó ayer y antier: podría no estar disponible hoy.` });
    else if (c && c.pitchedYesterday) flags.push({ team: x.team, risk: false, text: `El cerrador de ${x.team} (${c.name}) lanzó ayer.` });
  }
  const bh = parseFloat(H.bullpen && H.bullpen.era), ba = parseFloat(A.bullpen && A.bullpen.era);
  if (!isNaN(bh) && !isNaN(ba) && Math.abs(bh - ba) >= 0.75) {
    const [b, w] = bh < ba ? [H, A] : [A, H];
    flags.push({ team: b.team, risk: false, tag: 'bp', chip: `🧱 Mejor bullpen: ${nick(b.team)}`, text: `Bullpen más fuerte: ${b.team} (${b.bullpen.era} ERA) contra ${w.team} (${w.bullpen.era} ERA).` });
  }
  const eh = parseFloat(H.pitcher && H.pitcher.era), ea = parseFloat(A.pitcher && A.pitcher.era);
  if (!isNaN(eh) && !isNaN(ea) && Math.abs(eh - ea) >= 1) {
    const [b, w] = eh < ea ? [H, A] : [A, H];
    flags.push({ team: b.team, risk: false, tag: 'sp', chip: `⚾ Mejor abridor: ${nick(b.team)}`, text: `Ventaja en el abridor para ${b.team}: ${b.pitcher.name} (${b.pitcher.era} ERA) contra ${w.pitcher.name} (${w.pitcher.era} ERA).` });
    if (!isNaN(bh) && !isNaN(ba) && ((b === H && bh < ba) || (b === A && ba < bh))) flags.push({ team: b.team, risk: false, tag: 'full', text: `Ventaja de pitcheo completa para ${b.team}: mejor abridor y mejor bullpen.` });
  }
  const same = x => tk(x.home) === tk(g.home) && tk(x.away) === tk(g.away) || tk(x.home) === tk(g.away) && tk(x.away) === tk(g.home);
  const fmtG = x => `${new Date(x.date).toLocaleDateString('es', { timeZone: 'America/New_York', day: 'numeric', month: 'short' })}: ${x.away} ${x.as} en ${x.home} ${x.hs}`;
  const done = mlbCtx.games.filter(x => x.final && new Date(x.date).getTime() < t0).sort((a, b) => new Date(b.date) - new Date(a.date));
  const h2h = done.filter(same).slice(0, 5).map(fmtG);
  const lastOf = name => { const x = done.find(y => tk(y.home) === tk(name) || tk(y.away) === tk(name)); return x ? fmtG(x) : null; };
  H.lastGame = lastOf(g.home); A.lastGame = lastOf(g.away);
  // Rebote: equipo que perdió su último juego (la estrategia del usuario; se mide en el Récord)
  for (const x of [H, A]) {
    const lg = done.find(y => tk(y.home) === tk(x.team) || tk(y.away) === tk(x.team));
    if (!lg || lg.hs == null || lg.as == null) continue;
    const home = tk(lg.home) === tk(x.team), mine = home ? lg.hs : lg.as, other = home ? lg.as : lg.hs;
    if (!(mine < other)) continue;
    let elimTxt = '';
    if (post && mg && mg.ofGames) {
      const need = Math.ceil(mg.ofGames / 2);
      const inSeries = done.filter(y => same(y) && y.type === mg.type && new Date(y.date).getTime() > t0 - 10 * 864e5);
      const lossesX = inSeries.filter(y => { const h = tk(y.home) === tk(x.team); return (h ? y.hs : y.as) < (h ? y.as : y.hs); }).length;
      if (lossesX === need - 1) elimTxt = ' Hoy juega por su vida: si pierde, queda eliminado.';
    }
    flags.push({ team: x.team, risk: false, tag: 'rebote', chip: elimTxt ? `🔥 ${nick(x.team)} juega por su vida` : `🔄 ${nick(x.team)} viene de perder`, text: `Rebote: ${x.team} perdió su último juego (${mine}-${other}).${elimTxt}` });
  }
  const serie = mg && (mg.gameNo || mg.seriesState) ? { juego: mg.gameNo ? `Juego ${mg.gameNo}${mg.ofGames ? ' de ' + mg.ofGames : ''}` : null, estado: mg.seriesState } : null;
  return { wx: wx || null, home: H, away: A, post, series: mg ? mg.series : "", serie, h2h, flags };
}

/* ---------- Récord y apuestas: línea de cierre y calificación ---------- */
async function updateClosing(games) {
  if (!sb) return;
  const nowIso = new Date().toISOString();
  for (const table of ['bets', 'picks']) {
    const { data: open } = await sb.from(table).select('id,game_id,team').eq('status', 'open').gt('start_time', nowIso);
    for (const b of open || []) {
      const g = games.find(x => x.id === b.game_id); if (!g) continue;
      const o = g.outcomes.find(x => x.name === b.team); if (!o) continue;
      const upd = { closing_prob: o.p };
      if (table === 'bets') upd.closing_odds = o.myPrice || o.best.price;
      await sb.from(table).update(upd).eq('id', b.id);
    }
  }
}
// Guarda cada recomendación la primera vez que aparece. Nunca se borra ni se edita la cuota original.
async function recordPicks(games, reco) {
  if (!sb) return;
  const now = Date.now(), rows = [];
  for (const g of games) {
    if (new Date(g.start).getTime() <= now) continue;
    for (const o of g.outcomes) {
      if (o.name === 'Draw') continue;
      const price = o.myPrice || o.best.price, pb = o.pBV != null ? o.pBV : o.p, ev = pb * price - 1;
      if (ev >= PICK_MIN_EV && pb >= 0.25) rows.push({ game_id: g.id, sport_key: g.sport, league: g.league, start_time: g.start, team: o.name, opponent: o.name === g.home ? g.away : g.home, kind: 'valor', prob: pb, odds: price, book: o.myPrice ? o.myBook : o.best.book, ev, closing_prob: o.p });
    }
  }
  for (const g of games) {
    const k = g.pick; if (!k || k.state === 'blanco' || new Date(g.start).getTime() <= now) continue;
    rows.push({ game_id: g.id, sport_key: g.sport, league: g.league, start_time: g.start, team: k.team, opponent: k.team === g.home ? g.away : g.home, kind: k.state === 'verde' ? 'sel_verde' : 'sel_amarillo', prob: k.pM, odds: k.price, book: k.book, ev: k.ev, closing_prob: k.pMarket });
  }
  for (const c of reco.rebote || []) {
    const g = games.find(x => x.id === c.gid); if (!g || new Date(g.start).getTime() <= now) continue;
    rows.push({ game_id: c.gid, sport_key: g.sport, league: g.league, start_time: g.start, team: c.team, opponent: c.vs, kind: 'rebote', prob: c.p, odds: c.price, book: null, ev: c.ev, closing_prob: c.pc });
  }
  if (rows.length) await sb.from('picks').upsert(rows, { onConflict: 'game_id,team,kind', ignoreDuplicates: true });
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  for (const [kind, r] of [['betvision', reco.bv], ['valor', reco.value], ['favoritos', reco.safest], ['underdogs', reco.dogParlay]]) {
    if (!r) continue;
    const legs = r.legs.map(l => ({ game_id: l.gid, team: l.team, vs: l.vs, league: l.league, start: l.start, sport_key: (games.find(g => g.id === l.gid) || {}).sport, prob: l.p, odds: l.price }));
    await sb.from('parlays').upsert({ day, kind, legs, prob: r.p, odds: r.price }, { onConflict: 'day,kind', ignoreDuplicates: true });
  }
}
const scoresCache = {};
async function getScores(sport) {
  const c = scoresCache[sport];
  if (c && Date.now() - c.at < SCORES_MIN * 60e3) return c.data;
  const data = await oddsApi(`sports/${sport}/scores?daysFrom=3`);
  scoresCache[sport] = { at: Date.now(), data };
  return data;
}
function resultOf(scores, sport, gameId, team) {
  const ev = (scores[sport] || []).find(s => s.id === gameId);
  if (!ev || !ev.completed || !ev.scores) return null;
  const mine = Number((ev.scores.find(s => s.name === team) || {}).score);
  const other = Number((ev.scores.find(s => s.name !== team) || {}).score);
  if (isNaN(mine) || isNaN(other)) return null;
  if (mine === other) return sport.startsWith('soccer') ? 'lost' : 'push'; // en fútbol, el empate pierde la apuesta al ganador
  return mine > other ? 'won' : 'lost';
}
async function gradeAll() {
  if (!sb) return;
  const cut = Date.now() - 3 * 3600e3, cutIso = new Date(cut).toISOString();
  const [{ data: ob }, { data: op }, { data: opl }] = await Promise.all([
    sb.from('bets').select('*').eq('status', 'open').lt('start_time', cutIso),
    sb.from('picks').select('*').eq('status', 'open').lt('start_time', cutIso),
    sb.from('parlays').select('*').eq('status', 'open')
  ]);
  const parl = (opl || []).filter(p => (p.legs || []).every(l => new Date(l.start).getTime() < cut));
  const sports = new Set([...(ob || []), ...(op || [])].map(x => x.sport_key));
  parl.forEach(p => p.legs.forEach(l => l.sport_key && sports.add(l.sport_key)));
  if (!sports.size) return;
  const scores = {};
  for (const sp of sports) { try { scores[sp] = await getScores(sp); } catch (e) { console.error('Marcadores', sp, e.message); } }
  for (const b of ob || []) {
    const r = resultOf(scores, b.sport_key, b.game_id, b.team); if (!r) continue;
    await sb.from('bets').update({ status: r, profit: r === 'won' ? b.stake * (b.odds_taken - 1) : r === 'lost' ? -b.stake : 0 }).eq('id', b.id);
  }
  for (const k of op || []) {
    const r = resultOf(scores, k.sport_key, k.game_id, k.team); if (!r) continue;
    await sb.from('picks').update({ status: r, profit: r === 'won' ? k.odds - 1 : r === 'lost' ? -1 : 0 }).eq('id', k.id);
  }
  for (const p of parl) {
    const res = p.legs.map(l => resultOf(scores, l.sport_key, l.game_id, l.team));
    let status = null, profit = 0;
    if (res.includes('lost')) { status = 'lost'; profit = -1; }
    else if (res.every(x => x)) {
      if (res.every(x => x === 'push')) status = 'push';
      else { status = 'won'; profit = p.legs.reduce((t, l, i) => t * (res[i] === 'won' ? l.odds : 1), 1) - 1; }
    }
    if (status) await sb.from('parlays').update({ status, profit }).eq('id', p.id);
  }
}
async function refresh() {
  if (!E.ODDS_API_KEY) { cache.errors = ['Falta la variable ODDS_API_KEY']; return; }
  const errors = [], games = [];
  for (const s of SPORTS) {
    try { (await oddsApi(`sports/${s}/odds?regions=${REGIONS}&markets=h2h&oddsFormat=decimal&includeLinks=true`)).forEach(ev => { const g = analyze(ev, s); if (g) games.push(g); }); }
    catch (e) { errors.push(`${LABEL[s] || s}: ${e.message}`); }
  }
  games.sort((a, b) => new Date(a.start) - new Date(b.start));
  try { await loadMlbContext(); } catch (e) { console.error('Contexto MLB:', e.message); }
  games.forEach(g => { g.ctx = mlbContextFor(g); applyContext(g); });
  cache = { ...cache, updated: new Date().toISOString(), games, reco: recommend(games), errors };
  try { await recordPicks(games, cache.reco); await updateClosing(games); await gradeAll(); } catch (e) { console.error('Récord/apuestas:', e.message); }
  console.log(`[${cache.updated}] ${games.length} partidos. Créditos restantes: ${cache.remaining}`);
}

/* ---------- Usuarios y suscripción ---------- */
const paying = p => !!p && ['active', 'trialing'].includes(p.sub_status);
const onAppTrial = p => !!p && !!p.trial_ends && new Date(p.trial_ends).getTime() > Date.now();
// Premium = suscripción de Stripe activa, o los días de prueba gratis sin tarjeta
const isPremium = p => paying(p) || onAppTrial(p);
async function getUser(req) {
  const h = req.headers.authorization || '';
  if (!sb || !h.startsWith('Bearer ')) return null;
  const { data, error } = await sb.auth.getUser(h.slice(7));
  return error ? null : data.user;
}
async function getProfile(user) {
  let { data } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
  if (!data) {
    // Cuenta nueva: empieza la prueba gratis sin tarjeta
    const trial_ends = new Date(Date.now() + TRIAL_DAYS * 864e5).toISOString();
    ({ data } = await sb.from('profiles').insert({ id: user.id, email: user.email, trial_ends }).select().single());
  } else if (!data.trial_ends) {
    // Cuentas creadas antes de este cambio: la prueba cuenta desde que se registraron
    const trial_ends = new Date(new Date(data.created_at || Date.now()).getTime() + TRIAL_DAYS * 864e5).toISOString();
    await sb.from('profiles').update({ trial_ends }).eq('id', user.id);
    data.trial_ends = trial_ends;
  }
  return data;
}
async function syncSubscription(sub) {
  const end = sub.current_period_end || (sub.items && sub.items.data[0] && sub.items.data[0].current_period_end);
  await sb.from('profiles').update({ sub_status: sub.status, period_end: end ? new Date(end * 1000).toISOString() : null, had_trial: true }).eq('stripe_customer_id', sub.customer);
}
function publicData(full) {
  // Versión gratis: partidos y probabilidades; sin valor, cuotas justas ni parlays.
  return { ...full, premium: false, reco: null, games: full.games.map(g => ({ ...g, pick: null, ctx: g.ctx ? { locked: true } : null, outcomes: g.outcomes.map(o => ({ name: o.name, p: o.p })) })) };
}


/* ---------- Pregúntale a BetVision: analista con IA (API de Claude) ---------- */
const ASK_LIMIT = Number(E.ASK_LIMIT) || 20;           // preguntas por usuario al día
const askCount = new Map();
function askAllowed(uid) {
  const day = new Date().toISOString().slice(0, 10), c = askCount.get(uid);
  if (!c || c.day !== day) { askCount.set(uid, { day, n: 1 }); return true; }
  if (c.n >= ASK_LIMIT) return false;
  c.n++; return true;
}
const usOdds = d => d >= 2 ? '+' + Math.round((d - 1) * 100) : '-' + Math.round(100 / (d - 1));
function dataForAI() {
  const now = Date.now(), lim = now + 30 * 3600e3;
  return cache.games.filter(g => { const t = new Date(g.start).getTime(); return t > now && t < lim; }).slice(0, 30).map(g => ({
    liga: g.league,
    hora_et: new Date(g.start).toLocaleString('es', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' }),
    local: g.home, visita: g.away,
    seleccion_betvision: g.pick ? { estado: ({ verde: 'Recomendación', amarillo: 'Recomendación con incertidumbre alta', blanco: 'Sin ventaja estadística clara' })[g.pick.state], equipo: g.pick.team, underdog: g.pick.underdog, prob_modelo: +(g.pick.pM * 100).toFixed(1), prob_del_precio: +(g.pick.pImpl * 100).toFixed(1), incertidumbre: g.pick.unc } : null,
    selecciones: g.outcomes.map(o => ({ equipo: o.name, prob_casas: +(o.p * 100).toFixed(1), prob_betvision: +((o.pBV != null ? o.pBV : o.p) * 100).toFixed(1), cuota: usOdds(o.myPrice || o.best.price), casa: o.myPrice ? o.myBook : o.best.book, valor_pct: +(((o.pBV != null ? o.pBV : o.p) * (o.myPrice || o.best.price) - 1) * 100).toFixed(1) })),
    contexto: g.ctx ? { tipo: g.ctx.series || null, serie: g.ctx.serie, local: g.ctx.home, visita: g.ctx.away, juegos_recientes_entre_ellos: g.ctx.h2h, alertas: g.ctx.flags.map(f => f.text) } : 'sin datos de contexto'
  }));
}
const AI_RULES = `Eres el analista de BetVision (100xBajo). Hablas en español sencillo, directo y sin vender humo, para apostadores latinos en EE. UU. Usas "macho" para el favorito y "hembra" para el underdog.

CÓMO ANALIZAS (en este orden):
1. El juego primero, no la casa: TODO el pitcheo, que es lo que más pesa en béisbol: abridores (récord, ERA, WHIP, ponches, innings), bullpen (ERA y WHIP de los relevistas) y cerrador (salvamentos, salvamentos fallados, ERA y si está cansado porque lanzó ayer o antier). Busca equipos con buen abridor Y buen cierre. Luego: cómo va la serie y qué pasó en el juego anterior, último juego de cada equipo, récord, últimos 10 y motivación (quién necesita ganar, quién ya clasificó y puede sentar a sus estrellas, playoffs o partido sin importancia).
2. Nivel de riesgo de cada selección: 🟢 bajo, ⚠️ medio o 🔴 alto, con el porqué en 1 o 2 frases concretas.
3. El precio al final: la línea de la casa solo sirve para saber si paga lo justo. Compara la cuota con "prob_betvision" (probabilidad de BetVision) y di si tiene valor.

CUANDO EL USUARIO TE DA SU BOLETO (por ejemplo "Phillies -115, White Sox +125…"):
- Busca cada equipo en los datos y analiza pata por pata con este formato:
  "1. Equipo cuota — emoji y veredicto corto", luego 2 o 3 líneas con abridores, serie y contexto, y cierra con "➡️ tu conclusión".
- Después, una sección "Lo que realmente me preocupa": cuántas patas necesita, cuáles concentran el riesgo, y la cuota y probabilidad combinada aproximada (multiplica las probabilidades de cada pata). Si te da el monto y el pago, verifica que cuadren.
- Termina con un resumen de riesgo por pata y, si hay una pata débil, sugiere qué cambiarías o si conviene quitarla, sin decirle que debe apostar.
- Si un equipo del boleto no está en los datos, dilo claramente y no inventes nada sobre él.

CUANDO TE PIDEN RECOMENDACIONES:
- Da primero el "Macho del día" (apuesta directa) y luego 1 o 2 parlays de 2 o 3 selecciones, cada selección con su porqué y su riesgo.

REGLAS FIJAS:
- Usa SOLO los datos que te doy. No inventes lesiones, alineaciones, estadísticas ni resultados. Si falta algo, dilo.
- Las rachas por sí solas no predicen el próximo juego: úsalas como contexto, nunca como "ya le toca".
- Nunca digas "seguro", "sí o sí", "fijo" ni "garantizado". Di cuántas veces de cada 100 puede perder.
- Si un rival ya clasificó y puede descansar, recomienda confirmar la alineación.
- "Ambiente y calle": puedes buscar en internet noticias de última hora (lesiones, alineaciones, bajas, peleas en el vestuario, problemas con la directiva, rivalidad, ambiente del estadio). Separa siempre lo CONFIRMADO (con la fuente) de los RUMORES, y nunca conviertas un rumor en probabilidad. Tradúcelo en consejos cortos y claros, por ejemplo: "Juega sin su estrella: esa pata baja de 🟢 a ⚠️".
- El clima, el récord de local/visitante y los consejos rápidos (chips) vienen en los datos; úsalos. La lluvia es un riesgo de suspensión, no de resultado.
- Si el cerrador de un equipo está cansado, súbele el riesgo a esa pata, sobre todo en juegos cerrados.
- Al usuario le gusta la estrategia "Rebote": equipos que perdieron su último juego (sobre todo si juegan por su vida en playoffs), combinados con alguna cuota que pague bien y pocas patas (2 o 3). Señala qué equipos están en rebote, pero dile con honestidad que perder ayer, por sí solo, no está comprobado como ventaja y que las casas ya lo meten en la cuota; lo que decide es el pitcheo y el precio.
- Cada partido trae "seleccion_betvision" (🟢 Recomendación, 🟡 con incertidumbre alta, ⚪ sin ventaja clara). Úsala y explica la diferencia entre "creo que puede ganar" y "es buena apuesta": probabilidad del modelo contra la probabilidad que implica el precio. Si es ⚪, dilo sin forzar certeza.
- Termina siempre con "🧠 Recomendación BetVision": tu jugada final basada en TODO (pitcheo completo, valor, contexto, rebote), en 2 o 3 patas como máximo, con probabilidad aproximada del parlay, cuánto cobra con $20 y cuál es la pata más débil. Si es con bonus bet, recuerda que el bonus no se devuelve: solo se cobra la ganancia.
- Sugiere montos pequeños: 1 % o 2 % del presupuesto.
- Escribe para el teléfono: párrafos cortos y emojis solo para el riesgo. Máximo unas 350 palabras.
- Termina siempre con: "Juega responsable. (esto es 100 pa bajo)"`;
async function askClaude(messages) {
  const system = `${AI_RULES}\n\nFecha y hora actual (Este de EE. UU.): ${new Date().toLocaleString('es', { timeZone: 'America/New_York', dateStyle: 'full', timeStyle: 'short' })}.\nCuotas actualizadas: ${cache.updated || 'desconocido'}.\n\nDatos de los próximos partidos (JSON):\n${JSON.stringify(dataForAI())}`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': E.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: E.CLAUDE_MODEL || 'claude-sonnet-5', max_tokens: 2200, system, messages, ...(E.ASK_NEWS === 'off' ? {} : { tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }] }) })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || `Claude ${r.status}`);
  return (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
}

/* ---------- HTTP ---------- */
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise((ok, ko) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => ok(Buffer.concat(c))); req.on('error', ko); });
const INDEX = path.join(__dirname, 'index.html');

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/api/config') return send(res, 200, { supabaseUrl: SUPA_URL, supabaseAnon: SUPA_ANON, price: E.PRICE_LABEL || '$99 al mes', trialDays: TRIAL_DAYS, affiliates: AFFILIATES.map(({ key, name, offer, states }) => ({ key, name, offer: offer || '', states: states || [] })) });

    if (p === '/go') {
      const key = url.searchParams.get('b'), target = url.searchParams.get('u');
      const aff = affOf(key);
      let dest = null;
      const known = target && cache.games.some(g => g.outcomes.some(o => o.byBook && o.byBook[key] && o.byBook[key].l === target));
      if (known) dest = aff && aff.deeplink && aff.deeplink.includes('{url}') ? aff.deeplink.replace('{url}', encodeURIComponent(target)) : target;
      else if (aff && aff.url) dest = aff.url;
      if (!dest) { res.writeHead(302, { Location: '/' }); return res.end(); }
      if (sb) { const user = await getUser(req).catch(() => null); sb.from('clicks').insert({ book: key, kind: known ? 'bet' : 'signup', user_id: user ? user.id : null }).then(() => {}, () => {}); }
      res.writeHead(302, { Location: dest }); return res.end();
    }

    if (p === '/api/stripe-webhook' && req.method === 'POST') {
      const raw = await readBody(req);
      let event;
      try { event = stripe.webhooks.constructEvent(raw, req.headers['stripe-signature'], E.STRIPE_WEBHOOK_SECRET); }
      catch (e) { return send(res, 400, { error: 'Firma inválida' }); }
      const o = event.data.object;
      if (event.type === 'checkout.session.completed' && o.client_reference_id) {
        await sb.from('profiles').update({ stripe_customer_id: o.customer }).eq('id', o.client_reference_id);
        if (o.subscription) await syncSubscription(await stripe.subscriptions.retrieve(o.subscription));
      } else if (event.type.startsWith('customer.subscription.')) {
        await syncSubscription(o);
      }
      return send(res, 200, { received: true });
    }

    if (p === '/api/record') {
      if (!sb) return send(res, 200, { picks: [], parlays: [], pending: 0 });
      const user = await getUser(req);
      const prem = user ? isPremium(await getProfile(user)) : false;
      const [{ data: pk }, { data: pl }] = await Promise.all([
        sb.from('picks').select('kind,league,start_time,team,opponent,prob,odds,book,ev,closing_prob,status,profit').order('start_time', { ascending: false }).limit(500),
        sb.from('parlays').select('day,kind,legs,prob,odds,status,profit').order('day', { ascending: false }).limit(120)
      ]);
      const picks = pk || [], parlays = pl || [];
      const pending = picks.filter(x => x.status === 'open').length + parlays.filter(x => x.status === 'open').length;
      return send(res, 200, { premium: prem, pending, picks: prem ? picks : picks.filter(x => x.status !== 'open'), parlays: prem ? parlays : parlays.filter(x => x.status !== 'open') });
    }

    if (p === '/api/data') {
      const user = await getUser(req);
      const prof = user ? await getProfile(user) : null;
      return send(res, 200, isPremium(prof) ? { ...cache, premium: true } : publicData(cache));
    }

    if (p.startsWith('/api/')) {
      const user = await getUser(req);
      if (!user) return send(res, 401, { error: 'Inicia sesión' });
      const prof = await getProfile(user);

      if (p === '/api/me' && req.method === 'GET') return send(res, 200, { email: user.email, premium: isPremium(prof), paying: paying(prof), on_trial: onAppTrial(prof) && !paying(prof), trial_ends: prof.trial_ends, sub_status: prof.sub_status, period_end: prof.period_end, bankroll: Number(prof.bankroll) || 0, state: prof.state || '', book: prof.book || '' });
      if (p === '/api/me' && req.method === 'PUT') {
        const b = JSON.parse((await readBody(req)).toString() || '{}');
        const upd = {};
        if (b.bankroll !== undefined) upd.bankroll = Math.max(0, Math.min(1e7, Number(b.bankroll) || 0));
        if (b.state !== undefined) upd.state = String(b.state).toUpperCase().slice(0, 2);
        if (b.book !== undefined) upd.book = String(b.book).slice(0, 40);
        await sb.from('profiles').update(upd).eq('id', user.id);
        return send(res, 200, upd);
      }
      if (p === '/api/checkout' && req.method === 'POST') {
        const session = await stripe.checkout.sessions.create({
          mode: 'subscription',
          line_items: [{ price: E.STRIPE_PRICE_ID, quantity: 1 }],
          // Si todavía le quedan días de prueba (más de 2), el primer cobro llega cuando termina la prueba
          subscription_data: onAppTrial(prof) && new Date(prof.trial_ends).getTime() - Date.now() > 2 * 864e5 ? { trial_end: Math.floor(new Date(prof.trial_ends).getTime() / 1000) } : undefined,
          client_reference_id: user.id,
          ...(prof.stripe_customer_id ? { customer: prof.stripe_customer_id } : { customer_email: user.email }),
          success_url: `${APP_URL}/?pago=ok`, cancel_url: `${APP_URL}/?pago=cancelado`
        });
        return send(res, 200, { url: session.url });
      }
      if (p === '/api/portal' && req.method === 'POST') {
        if (!prof.stripe_customer_id) return send(res, 400, { error: 'Sin suscripción' });
        const s = await stripe.billingPortal.sessions.create({ customer: prof.stripe_customer_id, return_url: APP_URL });
        return send(res, 200, { url: s.url });
      }

      if (!isPremium(prof)) return send(res, 402, { error: 'Función Premium' });

      if (p === '/api/ask' && req.method === 'POST') {
        if (!E.ANTHROPIC_API_KEY) return send(res, 503, { error: 'El asistente todavía no está configurado.' });
        const b = JSON.parse((await readBody(req)).toString() || '{}');
        const msgs = (Array.isArray(b.messages) ? b.messages : []).slice(-8)
          .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
          .map(m => ({ role: m.role, content: m.content.slice(0, 1500) }));
        if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return send(res, 400, { error: 'Escribe una pregunta.' });
        while (msgs.length && msgs[0].role !== 'user') msgs.shift();
        if (!askAllowed(user.id)) return send(res, 429, { error: `Llegaste al límite de ${ASK_LIMIT} preguntas por hoy. Vuelve mañana.` });
        try { return send(res, 200, { answer: await askClaude(msgs) }); }
        catch (e) { console.error('Asistente:', e.message); return send(res, 502, { error: 'El asistente no respondió. Intenta de nuevo en un momento.' }); }
      }
      if (p === '/api/bets' && req.method === 'GET') {
        const { data } = await sb.from('bets').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(500);
        return send(res, 200, data || []);
      }
      if (p === '/api/bets' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)).toString() || '{}');
        const g = cache.games.find(x => x.id === b.gid);
        const o = g && g.outcomes[b.idx];
        const odds = Number(b.odds), stake = Number(b.stake);
        if (!o || !(odds > 1) || !(stake > 0)) return send(res, 400, { error: 'Datos inválidos' });
        if (new Date(g.start).getTime() < Date.now()) return send(res, 400, { error: 'El partido ya empezó' });
        const row = { user_id: user.id, game_id: g.id, sport_key: g.sport, league: g.league, start_time: g.start, team: o.name, opponent: o.name === g.home ? g.away : g.home, odds_taken: odds, stake, prob_taken: o.p, closing_prob: o.p, closing_odds: o.myPrice || o.best.price };
        const { data, error } = await sb.from('bets').insert(row).select().single();
        return error ? send(res, 500, { error: error.message }) : send(res, 200, data);
      }
      if (p === '/api/bets' && req.method === 'DELETE') {
        await sb.from('bets').delete().eq('id', url.searchParams.get('id')).eq('user_id', user.id).eq('status', 'open');
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'No encontrado' });
    }

    if (p === '/terminos') {
      const t = fs.readFileSync(path.join(__dirname, 'terminos.html'), 'utf8')
        .replaceAll('{{CONTACT}}', E.CONTACT_EMAIL || 'el correo de contacto de BetVision')
        .replaceAll('{{PRICE}}', E.PRICE_LABEL || '$99 al mes')
        .replaceAll('{{TRIAL}}', String(TRIAL_DAYS))
        .replaceAll('{{DATE}}', E.TERMS_DATE || '26 de septiembre de 2026');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(t);
    }
    const STATIC = { '/manifest.webmanifest': 'application/manifest+json', '/apple-touch-icon.png': 'image/png', '/icon-192.png': 'image/png', '/icon-512.png': 'image/png' };
    if (STATIC[p] && fs.existsSync(path.join(__dirname, p.slice(1)))) {
      res.writeHead(200, { 'Content-Type': STATIC[p], 'Cache-Control': 'public, max-age=86400' });
      return fs.createReadStream(path.join(__dirname, p.slice(1))).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(INDEX).pipe(res);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'Error del servidor' });
  }
}).listen(PORT, () => console.log(`BetVision escuchando en el puerto ${PORT}`));

refresh();
setInterval(refresh, REFRESH_MIN * 60 * 1000);
