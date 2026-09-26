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

const stripe = E.STRIPE_SECRET_KEY ? Stripe(E.STRIPE_SECRET_KEY) : null;
const sb = E.SUPABASE_URL && E.SUPABASE_SERVICE_KEY ? createClient(E.SUPABASE_URL, E.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } }) : null;

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
  const cands = up.flatMap(g => g.outcomes.map((o, i) => ({ gid: g.id, idx: i, league: g.league, start: g.start, team: o.name, vs: o.name === g.home ? g.away : g.home, p: o.p, price: o.myPrice || o.best.price, ev: o.myPrice ? o.evMine : o.evBest })));
  const safest = pick([...cands].sort((a, b) => b.p - a.p)).slice(0, 2);
  const value = pick(cands.filter(c => c.ev > 0.01 && c.p >= 0.35).sort((a, b) => b.ev - a.ev));
  const sum = legs => { if (!legs.length) return null; const p = legs.reduce((t, x) => t * x.p, 1), price = legs.reduce((t, x) => t * x.price, 1); return { legs, p, price, ev: p * price - 1 }; };
  const v = sum(value);
  return { safest: sum(safest), value: v && v.legs.length >= 2 ? v : null };
}

/* ---------- Apuestas: línea de cierre y liquidación ---------- */
async function updateClosing(games) {
  if (!sb) return;
  const now = Date.now();
  const { data: open } = await sb.from('bets').select('id,game_id,team').eq('status', 'open').gt('start_time', new Date(now).toISOString());
  for (const b of open || []) {
    const g = games.find(x => x.id === b.game_id); if (!g) continue;
    const o = g.outcomes.find(x => x.name === b.team); if (!o) continue;
    await sb.from('bets').update({ closing_prob: o.p, closing_odds: o.myPrice || o.best.price }).eq('id', b.id);
  }
}
async function settle() {
  if (!sb) return;
  const cutoff = new Date(Date.now() - 3 * 3600e3).toISOString();
  const { data: open } = await sb.from('bets').select('*').eq('status', 'open').lt('start_time', cutoff);
  if (!open || !open.length) return;
  for (const sport of [...new Set(open.map(b => b.sport_key))]) {
    let scores;
    try { scores = await oddsApi(`sports/${sport}/scores?daysFrom=3`); } catch (e) { console.error(e.message); continue; }
    for (const b of open.filter(x => x.sport_key === sport)) {
      const ev = scores.find(s => s.id === b.game_id);
      if (!ev || !ev.completed || !ev.scores) continue;
      const mine = Number((ev.scores.find(s => s.name === b.team) || {}).score);
      const other = Number((ev.scores.find(s => s.name !== b.team) || {}).score);
      if (isNaN(mine) || isNaN(other)) continue;
      const status = mine > other ? 'won' : mine < other ? 'lost' : 'push';
      const profit = status === 'won' ? b.stake * (b.odds_taken - 1) : status === 'lost' ? -b.stake : 0;
      await sb.from('bets').update({ status, profit }).eq('id', b.id);
    }
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
  cache = { ...cache, updated: new Date().toISOString(), games, reco: recommend(games), errors };
  try { await updateClosing(games); await settle(); } catch (e) { console.error('Apuestas:', e.message); }
  console.log(`[${cache.updated}] ${games.length} partidos. Créditos restantes: ${cache.remaining}`);
}

/* ---------- Usuarios y suscripción ---------- */
const isPremium = p => !!p && ['active', 'trialing'].includes(p.sub_status);
async function getUser(req) {
  const h = req.headers.authorization || '';
  if (!sb || !h.startsWith('Bearer ')) return null;
  const { data, error } = await sb.auth.getUser(h.slice(7));
  return error ? null : data.user;
}
async function getProfile(user) {
  let { data } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
  if (!data) { ({ data } = await sb.from('profiles').insert({ id: user.id, email: user.email }).select().single()); }
  return data;
}
async function syncSubscription(sub) {
  const end = sub.current_period_end || (sub.items && sub.items.data[0] && sub.items.data[0].current_period_end);
  await sb.from('profiles').update({ sub_status: sub.status, period_end: end ? new Date(end * 1000).toISOString() : null, had_trial: true }).eq('stripe_customer_id', sub.customer);
}
function publicData(full) {
  // Versión gratis: partidos y probabilidades; sin valor, cuotas justas ni parlays.
  return { ...full, premium: false, reco: null, games: full.games.map(g => ({ ...g, outcomes: g.outcomes.map(o => ({ name: o.name, p: o.p })) })) };
}

/* ---------- HTTP ---------- */
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise((ok, ko) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => ok(Buffer.concat(c))); req.on('error', ko); });
const INDEX = path.join(__dirname, 'index.html');

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/api/config') return send(res, 200, { supabaseUrl: E.SUPABASE_URL, supabaseAnon: E.SUPABASE_ANON_KEY, price: E.PRICE_LABEL || '$99 al mes', trialDays: TRIAL_DAYS, affiliates: AFFILIATES.map(({ key, name, offer, states }) => ({ key, name, offer: offer || '', states: states || [] })) });

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

    if (p === '/api/data') {
      const user = await getUser(req);
      const prof = user ? await getProfile(user) : null;
      return send(res, 200, isPremium(prof) ? { ...cache, premium: true } : publicData(cache));
    }

    if (p.startsWith('/api/')) {
      const user = await getUser(req);
      if (!user) return send(res, 401, { error: 'Inicia sesión' });
      const prof = await getProfile(user);

      if (p === '/api/me' && req.method === 'GET') return send(res, 200, { email: user.email, premium: isPremium(prof), sub_status: prof.sub_status, period_end: prof.period_end, bankroll: Number(prof.bankroll) || 0, state: prof.state || '', book: prof.book || '' });
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
          subscription_data: prof.had_trial ? undefined : { trial_period_days: TRIAL_DAYS },
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

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(INDEX).pipe(res);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'Error del servidor' });
  }
}).listen(PORT, () => console.log(`BetVision escuchando en el puerto ${PORT}`));

refresh();
setInterval(refresh, REFRESH_MIN * 60 * 1000);
