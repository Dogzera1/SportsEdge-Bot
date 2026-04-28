'use strict';
// Audita market_tips_shadow por sport × tier × market.
// Uso: node scripts/audit-market-tips-by-tier.js [--days=30] [--input=.tmp_mt_audit.json]
// Sem --input, usa fetch direto pra prod RAILWAY_BASE.

const fs = require('fs');
const path = require('path');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));

const DAYS = parseInt(args.days || '30', 10);
const INPUT = args.input || path.join(__dirname, '..', '.tmp_mt_audit.json');

// Tier classification — alinhado com gates_runtime_state e league_blocklist
const TIER_RULES = {
  lol: {
    1: ['LCK', 'LPL', 'LEC', 'LCS', 'LTA', 'Worlds', 'MSI', 'World Championship', 'Mid-Season Invitational', 'Esports World Cup', 'EWC'],
    2: ['LCK Challengers', 'LDL', 'LCK CL', 'PRM', 'EMEA Masters', 'EMEA Master', 'NLC', 'NACL', 'LCO', 'LJL', 'CBLOL', 'VCS', 'PCS', 'LLA'],
    3: [], // resto
  },
  cs2: {
    1: ['IEM', 'BLAST', 'PGL', 'ESL Pro', 'Major', 'BLAST Premier', 'Astralis Talent', 'CCT'],
    2: ['ESEA', 'European Pro League', 'EPL', 'Elisa', 'Thunderpick'],
    3: [],
  },
  dota2: {
    1: ['DreamLeague', 'PGL', 'ESL One', 'Riyadh', 'TI', 'The International', 'Major'],
    2: ['DPC', 'BB Dacha', 'BetBoom'],
    3: [],
  },
  valorant: {
    1: ['VCT', 'Champions', 'Masters', 'VCT Pacific', 'VCT EMEA', 'VCT Americas'],
    2: ['Challengers', 'Game Changers', 'VCL'],
    3: [],
  },
  tennis: {
    1: ['Grand Slam', 'ATP Finals', 'WTA Finals', 'Wimbledon', 'US Open', 'Australian Open', 'Roland Garros', 'French Open',
        'Madrid', 'Rome', 'Indian Wells', 'Miami', 'Cincinnati', 'Canada', 'Shanghai', 'Paris Masters', 'Monte Carlo', 'ATP Masters', 'Mutua Madrid'],
    2: ['ATP 500', 'ATP 250', 'WTA 1000', 'WTA 500', 'WTA 250'],
    3: ['Challenger', 'WTA 125', 'ITF'],
  },
  football: {
    1: ['Premier League', 'La Liga', 'Bundesliga', 'Serie A', 'Ligue 1', 'Champions League', 'UEFA', 'World Cup', 'Brasileirao Serie A'],
    2: ['Championship', 'Eredivisie', 'Primeira Liga', 'Brasileirao Serie B', 'Serie B', 'Segunda', '2.Bundesliga', 'Ligue 2'],
    3: [],
  },
};

function tierOf(sport, league) {
  const rules = TIER_RULES[sport];
  if (!rules || !league) return 3;
  const L = String(league).toLowerCase();
  for (const t of [1, 2]) {
    if (rules[t].some(p => L.includes(String(p).toLowerCase()))) return t;
  }
  return 3;
}

function fmt(n, dec = 2) {
  if (n == null || !Number.isFinite(n)) return '?';
  return Number(n).toFixed(dec);
}

function pct(num, den) {
  if (!den || den <= 0) return '?';
  return `${(num / den * 100).toFixed(1)}%`;
}

function loadTips() {
  if (!fs.existsSync(INPUT)) {
    console.error(`Input não encontrado: ${INPUT}`);
    console.error('Rode antes: curl -sk RAILWAY_BASE/market-tips-recent?days=30&limit=500&dedup=0 > .tmp_mt_audit.json');
    process.exit(1);
  }
  const j = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
  return j.tips || [];
}

function main() {
  const tips = loadTips();
  console.log(`\n=== AUDIT MARKET TIPS — últimos ${DAYS}d (${tips.length} rows raw) ===\n`);

  // Index by (sport, tier, market)
  const buckets = new Map();
  const keyOf = (s, t, m) => `${s}|t${t}|${m}`;

  for (const tip of tips) {
    const sport = tip.sport;
    const tier = tierOf(sport, tip.league);
    const market = tip.market;
    const key = keyOf(sport, tier, market);
    if (!buckets.has(key)) buckets.set(key, { sport, tier, market, n: 0, pending: 0, settled: 0, wins: 0, losses: 0, voids: 0, profit_u: 0, staked_u: 0, clv_sum: 0, clv_n: 0, evs: [] });
    const b = buckets.get(key);
    b.n++;
    if (tip.result === 'win') { b.wins++; b.settled++; }
    else if (tip.result === 'loss') { b.losses++; b.settled++; }
    else if (tip.result === 'void') { b.voids++; }
    else b.pending++;
    if (tip.result === 'win' || tip.result === 'loss') {
      b.profit_u += Number(tip.profit_units || 0);
      b.staked_u += Number(tip.stake_units || 1);
    }
    if (tip.clv_pct != null && Number.isFinite(tip.clv_pct)) {
      b.clv_sum += Number(tip.clv_pct);
      b.clv_n++;
    }
    if (Number.isFinite(tip.ev_pct)) b.evs.push(Number(tip.ev_pct));
  }

  const rows = [...buckets.values()].sort((a, b) => {
    if (a.sport !== b.sport) return a.sport.localeCompare(b.sport);
    if (a.tier !== b.tier) return a.tier - b.tier;
    return b.n - a.n;
  });

  // Per-sport totals
  const sportTotals = new Map();
  for (const b of rows) {
    if (!sportTotals.has(b.sport)) sportTotals.set(b.sport, { n: 0, settled: 0, wins: 0, profit_u: 0, staked_u: 0, clv_sum: 0, clv_n: 0 });
    const s = sportTotals.get(b.sport);
    s.n += b.n; s.settled += b.settled; s.wins += b.wins;
    s.profit_u += b.profit_u; s.staked_u += b.staked_u;
    s.clv_sum += b.clv_sum; s.clv_n += b.clv_n;
  }

  console.log(`${'SPORT'.padEnd(10)} ${'TIER'.padEnd(6)} ${'MARKET'.padEnd(28)} ${'N'.padStart(4)} ${'STL'.padStart(4)} ${'W-L'.padStart(7)} ${'HIT%'.padStart(6)} ${'PROFIT'.padStart(8)} ${'STK'.padStart(7)} ${'ROI'.padStart(7)} ${'CLV'.padStart(7)} ${'avgEV'.padStart(7)}`);
  console.log('-'.repeat(118));

  let curSport = null;
  for (const b of rows) {
    if (curSport && curSport !== b.sport) {
      const s = sportTotals.get(curSport);
      const roi = s.staked_u > 0 ? (s.profit_u / s.staked_u * 100) : null;
      const hit = s.settled > 0 ? (s.wins / s.settled * 100) : null;
      const clv = s.clv_n > 0 ? (s.clv_sum / s.clv_n) : null;
      console.log('-'.repeat(118));
      console.log(`${('Σ ' + curSport).padEnd(10)} ${''.padEnd(6)} ${''.padEnd(28)} ${String(s.n).padStart(4)} ${String(s.settled).padStart(4)} ${(s.wins+'-'+(s.settled-s.wins)).padStart(7)} ${(hit!=null?fmt(hit,1)+'%':'?').padStart(6)} ${fmt(s.profit_u,2).padStart(8)} ${fmt(s.staked_u,1).padStart(7)} ${(roi!=null?fmt(roi,1)+'%':'?').padStart(7)} ${(clv!=null?fmt(clv,2)+'%':'?').padStart(7)}`);
      console.log('='.repeat(118));
    }
    curSport = b.sport;
    const roi = b.staked_u > 0 ? (b.profit_u / b.staked_u * 100) : null;
    const hit = b.settled > 0 ? (b.wins / b.settled * 100) : null;
    const clv = b.clv_n > 0 ? (b.clv_sum / b.clv_n) : null;
    const avgEv = b.evs.length ? b.evs.reduce((a, c) => a + c, 0) / b.evs.length : null;
    console.log(`${b.sport.padEnd(10)} ${('T'+b.tier).padEnd(6)} ${b.market.slice(0,28).padEnd(28)} ${String(b.n).padStart(4)} ${String(b.settled).padStart(4)} ${(b.wins+'-'+b.losses).padStart(7)} ${(hit!=null?fmt(hit,1)+'%':'?').padStart(6)} ${fmt(b.profit_u,2).padStart(8)} ${fmt(b.staked_u,1).padStart(7)} ${(roi!=null?fmt(roi,1)+'%':'?').padStart(7)} ${(clv!=null?fmt(clv,2)+'%':'?').padStart(7)} ${(avgEv!=null?fmt(avgEv,1)+'%':'?').padStart(7)}`);
  }
  // last sport sigma
  if (curSport) {
    const s = sportTotals.get(curSport);
    const roi = s.staked_u > 0 ? (s.profit_u / s.staked_u * 100) : null;
    const hit = s.settled > 0 ? (s.wins / s.settled * 100) : null;
    const clv = s.clv_n > 0 ? (s.clv_sum / s.clv_n) : null;
    console.log('-'.repeat(118));
    console.log(`${('Σ ' + curSport).padEnd(10)} ${''.padEnd(6)} ${''.padEnd(28)} ${String(s.n).padStart(4)} ${String(s.settled).padStart(4)} ${(s.wins+'-'+(s.settled-s.wins)).padStart(7)} ${(hit!=null?fmt(hit,1)+'%':'?').padStart(6)} ${fmt(s.profit_u,2).padStart(8)} ${fmt(s.staked_u,1).padStart(7)} ${(roi!=null?fmt(roi,1)+'%':'?').padStart(7)} ${(clv!=null?fmt(clv,2)+'%':'?').padStart(7)}`);
  }

  // Total
  const G = { n: 0, settled: 0, wins: 0, profit_u: 0, staked_u: 0, clv_sum: 0, clv_n: 0 };
  for (const s of sportTotals.values()) { G.n += s.n; G.settled += s.settled; G.wins += s.wins; G.profit_u += s.profit_u; G.staked_u += s.staked_u; G.clv_sum += s.clv_sum; G.clv_n += s.clv_n; }
  const groi = G.staked_u > 0 ? (G.profit_u / G.staked_u * 100) : null;
  const ghit = G.settled > 0 ? (G.wins / G.settled * 100) : null;
  const gclv = G.clv_n > 0 ? (G.clv_sum / G.clv_n) : null;
  console.log('='.repeat(118));
  console.log(`${'GERAL'.padEnd(10)} ${''.padEnd(6)} ${''.padEnd(28)} ${String(G.n).padStart(4)} ${String(G.settled).padStart(4)} ${(G.wins+'-'+(G.settled-G.wins)).padStart(7)} ${(ghit!=null?fmt(ghit,1)+'%':'?').padStart(6)} ${fmt(G.profit_u,2).padStart(8)} ${fmt(G.staked_u,1).padStart(7)} ${(groi!=null?fmt(groi,1)+'%':'?').padStart(7)} ${(gclv!=null?fmt(gclv,2)+'%':'?').padStart(7)}`);

  // Flags
  console.log('\n=== ALERTAS (n≥10 settled) ===\n');
  const flags = [];
  for (const b of rows) {
    if (b.settled < 10) continue;
    const roi = (b.profit_u / b.staked_u) * 100;
    const clv = b.clv_n > 0 ? (b.clv_sum / b.clv_n) : 0;
    if (roi <= -10) flags.push(`🔴 ${b.sport}/T${b.tier}/${b.market}: ROI ${fmt(roi,1)}% n=${b.settled} (LEAK forte)`);
    else if (roi <= -3 && clv < 0) flags.push(`🟠 ${b.sport}/T${b.tier}/${b.market}: ROI ${fmt(roi,1)}% CLV ${fmt(clv,2)}% n=${b.settled} (leak + CLV neg)`);
    else if (roi >= 10 && b.settled >= 20) flags.push(`🟢 ${b.sport}/T${b.tier}/${b.market}: ROI ${fmt(roi,1)}% n=${b.settled} (winner consistente)`);
  }
  if (flags.length) flags.forEach(f => console.log('  ', f));
  else console.log('  Nenhum sinal forte (n=10+ ainda não atingido em vários buckets)');

  // Pending exposure
  const pending = tips.filter(t => !t.result);
  const pendingByMarket = new Map();
  for (const t of pending) {
    const k = `${t.sport}|${t.market}`;
    pendingByMarket.set(k, (pendingByMarket.get(k) || 0) + 1);
  }
  console.log(`\n=== PENDING (${pending.length} tips abertas) ===`);
  for (const [k, n] of [...pendingByMarket.entries()].sort((a,b) => b[1] - a[1])) {
    console.log(`  ${k}: ${n}`);
  }
}

main();
