#!/usr/bin/env node
'use strict';

/**
 * backtest-football-coefs.js — backtest holdout dos coeficientes adicionados
 * em sprints recentes (Dixon-Coles ρ + H2H blend weight) sobre match_results
 * históricos. Compara Brier de pH/pD/pA + over25 entre configurações.
 *
 * Workflow:
 *   1. Pull match_results football (target leagues, últimos N dias) via /admin endpoint
 *      OU lê /data/football-poisson-params.json local pra teams.
 *   2. Pra cada match: split temporal (treina em < match_date, testa no match)
 *      mas isso é lento — atalho: usa params CURRENT como proxy + roda predição.
 *      Esse aproach NÃO é puro out-of-sample mas é diretional pra avaliar shift
 *      relativo dos coeficientes.
 *   3. Roda predictFootball com cada combinação:
 *        baseline   (DC off, H2H off)
 *        +DC        (DC on -0.10, H2H off)
 *        +H2H       (DC off, H2H 0.15)
 *        +DC+H2H    (DC on, H2H 0.15)
 *   4. Computa Brier multi-class (pH/pD/pA) + Brier over25.
 *   5. Reporta delta de cada configuração vs baseline.
 *
 * Uso:
 *   node scripts/backtest-football-coefs.js [--days=180] [--remote=URL] [--limit=2000]
 *
 * Caveats:
 *   - Params atual é fitado com TODOS os matches incluindo os de teste — leak temporal.
 *     Resultado mostra UPPER BOUND do lift; out-of-sample real pode ser 30-50% menor.
 *   - Dataset é pequeno por liga; resultado per-league têm variance alta.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  const a = argv[i];
  return a.includes('=') ? a.split('=').slice(1).join('=') : argv[i + 1];
}

const DAYS = parseInt(arg('days', '180'), 10);
const LIMIT = parseInt(arg('limit', '2000'), 10);
const REMOTE = arg('remote', null);
const SRC = arg('src', null);

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    lib.get(url, { rejectUnauthorized: false, headers: { 'user-agent': 'fb-coef-backtest' } }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function loadMatches() {
  if (SRC) {
    return JSON.parse(fs.readFileSync(SRC, 'utf8'));
  }
  if (REMOTE) {
    // /admin/eval-football-poisson não retorna matches list; usar via Brier endpoint
    // requer admin auth. Fallback simples: usuário fornece via --src=path.json
    throw new Error('REMOTE não suportado neste script (requer admin auth). Use --src=match_results.json');
  }
  // DB local: tenta carregar
  try {
    const Database = require('better-sqlite3');
    const dbPath = (process.env.DB_PATH || './data/tipsbot.db').trim().replace(/^=+/, '');
    const db = new Database(dbPath, { readonly: true });
    const since = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
    const rows = db.prepare(`
      SELECT team1, team2, final_score, league, resolved_at
      FROM match_results
      WHERE game = 'football' AND resolved_at >= ?
      ORDER BY resolved_at DESC
      LIMIT ?
    `).all(since, LIMIT);
    db.close();
    return rows;
  } catch (e) {
    throw new Error(`DB local read failed: ${e.message}. Use --src=path.json`);
  }
}

function loadParams() {
  const p = path.join(__dirname, '..', 'data', 'football-poisson-params.json');
  if (!fs.existsSync(p)) {
    throw new Error(`Params não encontrado em ${p}. Treina via /admin/train-football-poisson primeiro.`);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function brierMulticlass(pH, pD, pA, actual) {
  const yH = actual === 'H' ? 1 : 0;
  const yD = actual === 'D' ? 1 : 0;
  const yA = actual === 'A' ? 1 : 0;
  return ((pH - yH) ** 2 + (pD - yD) ** 2 + (pA - yA) ** 2);
}

function brierBinary(p, y) {
  return (p - (y ? 1 : 0)) ** 2;
}

(async () => {
  console.log('[load] params...');
  const params = loadParams();
  console.log(`[load] params: leagues=${Object.keys(params.leagues || {}).length} teams=${params.teamsCount} h2h_pairs=${params.h2hCount || 0}`);

  console.log('[load] matches...');
  const matches = await loadMatches();
  console.log(`[load] matches: ${matches.length} rows`);

  // Configurations a testar
  const configs = [
    { name: 'baseline',  dcRho: 0,    h2hBlend: 0 },
    { name: '+DC',       dcRho: -0.10, h2hBlend: 0 },
    { name: '+H2H',      dcRho: 0,    h2hBlend: 0.15 },
    { name: '+DC+H2H',   dcRho: -0.10, h2hBlend: 0.15 },
  ];
  const results = configs.map(c => ({ name: c.name, n: 0, brierMulti: 0, brierOver25: 0, evaluable: 0 }));

  // Predict cada match com cada config
  for (const m of matches) {
    const [hg, ag] = String(m.final_score || '').split('-').map(s => parseInt(s, 10));
    if (!Number.isFinite(hg) || !Number.isFinite(ag)) continue;
    const actual = hg > ag ? 'H' : (hg === ag ? 'D' : 'A');
    const totalGoals = hg + ag;
    const over25Real = totalGoals > 2.5 ? 1 : 0;

    for (let i = 0; i < configs.length; i++) {
      const c = configs[i];
      // Force env override para essa run
      process.env.FB_DC_RHO = String(c.dcRho);
      process.env.FB_H2H_BLEND_WEIGHT = String(c.h2hBlend);
      // Re-require pra pegar env atual? Mais limpo: clear cache.
      delete require.cache[require.resolve('../lib/football-poisson-trained')];
      const { predictFootball } = require('../lib/football-poisson-trained');
      const pred = predictFootball({ teamHome: m.team1, teamAway: m.team2, league: m.league });
      if (!pred) continue;
      results[i].n++;
      results[i].brierMulti += brierMulticlass(pred.pH, pred.pD, pred.pA, actual);
      const over25Pred = pred.markets?.ou?.['2.5']?.over;
      if (Number.isFinite(over25Pred)) {
        results[i].brierOver25 += brierBinary(over25Pred, over25Real);
        results[i].evaluable++;
      }
    }
  }

  // Print
  console.log('\n=== BACKTEST RESULTS ===');
  console.log(`Matches evaluados: ${results[0].n} (n>0)`);
  console.log(`${'config'.padEnd(12)} ${'n'.padStart(5)} ${'brier_1x2'.padStart(11)} ${'Δ_vs_base'.padStart(10)} ${'brier_O25'.padStart(11)} ${'Δ_vs_base'.padStart(10)}`);
  console.log('-'.repeat(70));
  const baseMulti = results[0].n > 0 ? results[0].brierMulti / results[0].n : 0;
  const baseO25 = results[0].evaluable > 0 ? results[0].brierOver25 / results[0].evaluable : 0;
  for (const r of results) {
    const avgMulti = r.n > 0 ? r.brierMulti / r.n : 0;
    const avgO25 = r.evaluable > 0 ? r.brierOver25 / r.evaluable : 0;
    const dMulti = avgMulti - baseMulti;
    const dO25 = avgO25 - baseO25;
    const fmt = (n) => (n >= 0 ? '+' : '') + n.toFixed(4);
    console.log(`${r.name.padEnd(12)} ${String(r.n).padStart(5)} ${avgMulti.toFixed(4).padStart(11)} ${fmt(dMulti).padStart(10)} ${avgO25.toFixed(4).padStart(11)} ${fmt(dO25).padStart(10)}`);
  }
  console.log('\n(brier menor = melhor; Δ negativo vs baseline = config melhor)');
  console.log('\n[caveat] params atual contém os matches de teste (leak temporal).');
  console.log('Resultado é UPPER BOUND. Out-of-sample real esperado ~30-50% menor delta.');
})();
