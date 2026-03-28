require('dotenv').config();
const { log, httpGet, safeParse, norm, oddsApiAllowed } = require('../lib/utils');

const THE_ODDS_KEY = process.env.THE_ODDS_API_KEY || '';

// ── Surface & Tier helpers ──
function surfaceFromTitle(title) {
  const t = (title || '').toLowerCase();
  if (t.includes('french open') || t.includes('roland') || t.includes('clay') ||
      t.includes('barcelona') || t.includes('madrid') || t.includes('rome') ||
      t.includes('monte-carlo') || t.includes('monte carlo') || t.includes('hamburg') ||
      t.includes('estoril') || t.includes('bucharest') || t.includes('lyon') ||
      t.includes('geneva') || t.includes('munich') || t.includes('belgrade') ||
      t.includes('houston') || t.includes('marrakech') || t.includes('cagliari') ||
      t.includes('buenos aires') || t.includes('rio') || t.includes('bastad') ||
      t.includes('kitzbuhel') || t.includes('umag') || t.includes('gstaad') ||
      t.includes('cordoba') || t.includes('santiago')) return 'clay';
  if (t.includes('wimbledon') || t.includes('grass') || t.includes("queen's") ||
      t.includes('halle') || t.includes('s-hertogenbosch') || t.includes('eastbourne') ||
      t.includes('nottingham') || t.includes('newport') || t.includes('mallorca')) return 'grass';
  return 'hard';
}

function tierFromTitle(title) {
  const t = (title || '').toLowerCase();
  if (t.includes('australian open') || t.includes('french open') || t.includes('wimbledon') ||
      t.includes('us open') || t.includes('grand slam') || t.includes('roland garros')) return 'Grand Slam';
  if (t.includes('indian wells') || t.includes('miami open') || t.includes('monte-carlo') ||
      t.includes('madrid') || t.includes('rome') || t.includes('canadian open') ||
      t.includes('western') || t.includes('cincinnati') || t.includes('shanghai') ||
      t.includes('paris masters') || t.includes('bercy') || t.includes('masters 1000') ||
      t.includes('atp 1000')) return 'Masters 1000';
  if (t.includes('atp 500') || t.includes('500')) return 'ATP 500';
  if (t.includes('wta 1000')) return 'WTA 1000';
  if (t.includes('wta 500')) return 'WTA 500';
  if (t.includes('wta') || t.includes("women's")) return 'WTA';
  if (t.includes('challenger')) return 'Challenger';
  if (t.includes('itf')) return 'ITF';
  return 'ATP 250';
}

// ── Cache ──
let cachedMatches = null;
let cachedSports = null;
let lastMatchFetch = 0;
let lastSportsFetch = 0;
// TTL 12h (era 6h): reduz refreshes de 4x/dia para 2x/dia, permitindo cobrir
// 8 torneios dentro do budget de 500 req/mês do plano gratuito da The Odds API
const MATCHES_TTL = 12 * 60 * 60 * 1000;
const SPORTS_TTL  = 24 * 60 * 60 * 1000;

// Prioridade de tier para garantir que Grand Slams e Masters 1000 sempre entrem
const TIER_PRIORITY = {
  'Grand Slam': 0,
  'Masters 1000': 1,
  'WTA 1000': 1,
  'ATP 500': 2,
  'WTA 500': 2,
  'ATP 250': 3,
  'WTA': 3,
  'Challenger': 4,
  'ITF': 5
};

// ── Get active tennis sports from The Odds API ──
async function getActiveTennisSports() {
  const now = Date.now();
  if (cachedSports && now - lastSportsFetch < SPORTS_TTL) return cachedSports;
  if (!THE_ODDS_KEY) return [];

  try {
    if (!oddsApiAllowed('TENNIS')) return cachedSports || [];
    const r = await httpGet(`https://api.the-odds-api.com/v4/sports/?apiKey=${THE_ODDS_KEY}&all=false`);
    if (r.status !== 200) return cachedSports || [];
    const sports = safeParse(r.body, []);
    // Filtra tênis e ordena por prioridade de tier (Grand Slam primeiro, ITF por último)
    cachedSports = sports
      .filter(s => s.group === 'Tennis')
      .sort((a, b) => {
        const ta = TIER_PRIORITY[tierFromTitle(a.title)] ?? 6;
        const tb = TIER_PRIORITY[tierFromTitle(b.title)] ?? 6;
        return ta - tb;
      });
    lastSportsFetch = now;
    log('INFO', 'TENNIS', `${cachedSports.length} tennis sports active (ordenados por tier)`);
    return cachedSports;
  } catch(e) {
    log('WARN', 'TENNIS', 'getActiveTennisSports: ' + e.message);
    return cachedSports || [];
  }
}

// ── Main: fetch tournaments + matches + odds ──
async function refreshMatches(force = false) {
  const now = Date.now();
  if (!force && cachedMatches && now - lastMatchFetch < MATCHES_TTL) return cachedMatches;
  if (!THE_ODDS_KEY) {
    log('WARN', 'TENNIS', 'THE_ODDS_API_KEY não configurada — sem dados de tênis');
    return [];
  }

  let db;
  try {
    db = require('../lib/database')().db;
  } catch(e) {
    log('WARN', 'TENNIS', 'DB indisponível: ' + e.message);
    return [];
  }

  try {
    const sports = await getActiveTennisSports();
    const allMatches = [];

    // 6 torneios por refresh com TTL 12h: 6×2×30=360 odds + 6×1×30=180 settle = ~570/mês
    // Ordenados por tier: Grand Slam > Masters 1000 > ATP/WTA 500 > 250 > Challenger
    for (const sport of sports.slice(0, 6)) {
      try {
        if (!oddsApiAllowed('TENNIS')) break;
        const r = await httpGet(
          `https://api.the-odds-api.com/v4/sports/${sport.key}/odds/?apiKey=${THE_ODDS_KEY}&regions=eu,us&markets=h2h&oddsFormat=decimal`
        );
        if (r.status !== 200) continue;

        const events = safeParse(r.body, []);
        if (!Array.isArray(events) || !events.length) continue;

        const surface = surfaceFromTitle(sport.title);
        const tier = tierFromTitle(sport.title);
        const tournamentId = 'tennis_' + sport.key;

        db.prepare(`INSERT OR REPLACE INTO events (id, sport, name, date, location, url) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(
            tournamentId, 'tennis',
            `[${tier}] ${sport.title}`,
            events[0]?.commence_time?.slice(0, 10) || new Date().toISOString().slice(0, 10),
            surface, sport.key
          );

        for (const ev of events) {
          const bk = ev.bookmakers?.find(b => b.key === 'pinnacle') || ev.bookmakers?.[0];
          const market = bk?.markets?.find(m => m.key === 'h2h');
          const o1 = market?.outcomes?.[0];
          const o2 = market?.outcomes?.[1];
          const odds = (o1 && o2) ? {
            t1: parseFloat(o1.price).toFixed(2),
            t2: parseFloat(o2.price).toFixed(2),
            t1Name: o1.name,
            t2Name: o2.name,
            bookmaker: bk.title || bk.key
          } : null;

          const matchId = 'tennis_' + ev.id;

          // Não sobrescrever partidas já finalizadas
          const existing = db.prepare(`SELECT winner FROM matches WHERE id = ?`).get(matchId);
          if (existing?.winner) continue;

          db.prepare(`
            INSERT OR REPLACE INTO matches (id, sport, event_id, event_name, participant1_name,
              participant2_name, category, is_title, is_main, status, winner, match_time, event_date)
            VALUES (?, 'tennis', ?, ?, ?, ?, ?, 0, 0, 'upcoming', NULL, ?, ?)
          `).run(
            matchId, tournamentId, sport.title,
            ev.home_team, ev.away_team, surface,
            ev.commence_time, ev.commence_time?.slice(0, 10)
          );

          allMatches.push({
            id: matchId,
            sport: 'tennis',
            event_id: tournamentId,
            event_name: sport.title,
            participant1_name: ev.home_team,
            participant2_name: ev.away_team,
            category: surface,
            tier,
            match_time: ev.commence_time,
            event_date: ev.commence_time?.slice(0, 10),
            odds
          });
        }

        await new Promise(resolve => setTimeout(resolve, 250));
      } catch(e) {
        log('WARN', 'TENNIS', `${sport.key}: ${e.message}`);
      }
    }

    cachedMatches = allMatches;
    lastMatchFetch = now;
    log('INFO', 'TENNIS', `${allMatches.length} partidas em ${sports.slice(0, 6).length} torneios (TTL 12h)`);
    return allMatches;
  } catch(e) {
    log('ERROR', 'TENNIS', 'refreshMatches: ' + e.message);
    return cachedMatches || [];
  }
}

// ── Settlement via The Odds API scores endpoint ──
// GET /v4/sports/{sport}/scores/?daysFrom=1 retorna eventos finalizados com placar
let lastSettleRun = 0;
// Settlement 1x/dia é suficiente — resultados de tênis não mudam retroativamente
const SETTLE_TTL = 24 * 60 * 60 * 1000;

async function settleResults() {
  if (!THE_ODDS_KEY) return;
  const now = Date.now();
  if (now - lastSettleRun < SETTLE_TTL) return; // evita desperdício de quota
  lastSettleRun = now;

  let db;
  try {
    db = require('../lib/database')().db;
  } catch(e) { return; }

  try {
    const sports = await getActiveTennisSports();

    for (const sport of sports.slice(0, 6)) {
      try {
        if (!oddsApiAllowed('TENNIS-SETTLE')) break;
        // daysFrom=2 retorna resultados dos últimos 2 dias
        const r = await httpGet(
          `https://api.the-odds-api.com/v4/sports/${sport.key}/scores/?apiKey=${THE_ODDS_KEY}&daysFrom=2`
        );
        if (r.status !== 200) continue;

        const scores = safeParse(r.body, []);
        if (!Array.isArray(scores)) continue;

        for (const s of scores) {
          if (!s.completed) continue;

          const matchId = 'tennis_' + s.id;
          const existing = db.prepare(`SELECT winner FROM matches WHERE id = ?`).get(matchId);
          if (!existing || existing.winner) continue;

          // Determinar vencedor pelo placar de sets
          const homeScore = s.scores?.find(sc => sc.name === s.home_team);
          const awayScore = s.scores?.find(sc => sc.name === s.away_team);
          if (!homeScore || !awayScore) continue;

          const homeVal = parseFloat(homeScore.score) || 0;
          const awayVal = parseFloat(awayScore.score) || 0;
          if (homeVal === awayVal) continue;

          const winner = homeVal > awayVal ? s.home_team : s.away_team;

          db.prepare(`UPDATE matches SET winner=?, status='completed' WHERE id=?`)
            .run(winner, matchId);
          log('INFO', 'TENNIS-SETTLE', `${s.home_team} vs ${s.away_team} → ${winner}`);
        }

        await new Promise(r => setTimeout(r, 200));
      } catch(e) {
        log('WARN', 'TENNIS-SETTLE', `${sport.key}: ${e.message}`);
      }
    }
  } catch(e) {
    log('WARN', 'TENNIS', 'settleResults: ' + e.message);
  }
}

// getPlayerStats não disponível sem api de estatísticas de tênis
// Claude AI tem conhecimento atualizado dos jogadores — suficiente para a análise
async function getPlayerStats() {
  return null;
}

module.exports = { refreshMatches, getPlayerStats, settleResults, surfaceFromTitle, tierFromTitle };
