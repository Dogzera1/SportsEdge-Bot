#!/usr/bin/env node
'use strict';

require('dotenv').config({ override: true });
const path = require('path');
const initDatabase = require('../lib/database');
const { esportsPreFilter } = require('../lib/ml');
const { log, calcKellyFraction } = require('../lib/utils');

const DB_PATH = (process.env.DB_PATH || path.join(__dirname, '../sportsedge.db')).trim().replace(/^=+/, '');

async function main() {
  console.log('\n=== SportsEdge Backtesting Engine ===\n');
  console.log(`DB: ${DB_PATH}\n`);

  const { db } = initDatabase(DB_PATH);

  // Load all settled tips
  const tips = db.prepare(`
    SELECT id, sport, match_id, participant1, participant2, tip_participant,
           odds, ev, stake, confidence, is_live, sent_at, result, market_type
    FROM tips
    WHERE result IN ('win', 'loss')
    ORDER BY sent_at ASC
  `).all();

  console.log(`Total tips settled: ${tips.length}`);
  if (!tips.length) {
    console.log('Nenhum tip settled. Rode o bot por um período antes do backtest.');
    process.exit(0);
  }

  // ── Overall metrics ──
  const metrics = {
    total: 0, wins: 0, losses: 0,
    totalStaked: 0, totalProfit: 0,
    byConf: { ALTA: newBucket(), MÉDIA: newBucket(), BAIXA: newBucket() },
    byType: { live: newBucket(), pregame: newBucket() },
    bySport: {},
    calibration: Array.from({ length: 10 }, (_, i) => ({
      bucket: `${i * 10}-${i * 10 + 10}%`,
      predicted: i * 10 + 5,
      wins: 0,
      total: 0
    })),
    oddsDistribution: {}
  };

  // ── ML re-simulation tracking ──
  // For each esports tip, re-run esportsPreFilter with data available UP TO sent_at
  const mlSim = {
    total: 0, passed: 0, blocked: 0,
    // Factor accuracy: did each factor predict the correct winner?
    factors: {
      forma:     { correct: 0, total: 0 },
      h2h:       { correct: 0, total: 0 },
      compScore: { correct: 0, total: 0 }
    }
  };

  // Prepare queries for form/H2H up to a given date (no look-ahead bias)
  const getFormUpTo = db.prepare(`
    SELECT * FROM match_results
    WHERE (lower(team1) = lower(?) OR lower(team2) = lower(?))
      AND game = ?
      AND resolved_at < ?
    ORDER BY resolved_at DESC
    LIMIT 10
  `);

  const getH2HUpTo = db.prepare(`
    SELECT * FROM match_results
    WHERE ((lower(team1) = lower(?) AND lower(team2) = lower(?))
        OR (lower(team1) = lower(?) AND lower(team2) = lower(?)))
      AND game = ?
      AND resolved_at < ?
    ORDER BY resolved_at DESC
    LIMIT 10
  `);

  for (const tip of tips) {
    const stake  = parseFloat(tip.stake) || 1;
    const odds   = parseFloat(tip.odds)  || 1;
    const isWin  = tip.result === 'win';
    const profit = isWin ? stake * (odds - 1) : -stake;
    const conf   = (tip.confidence || 'MÉDIA').toUpperCase();
    const type   = tip.is_live ? 'live' : 'pregame';

    metrics.total++;
    metrics.wins    += isWin ? 1 : 0;
    metrics.losses  += isWin ? 0 : 1;
    metrics.totalStaked  += stake;
    metrics.totalProfit  += profit;

    // By confidence
    const bc = metrics.byConf[conf] || metrics.byConf['MÉDIA'];
    bc.total++; bc.staked += stake; bc.profit += profit; if (isWin) bc.wins++;

    // By type
    metrics.byType[type].total++;
    metrics.byType[type].staked += stake;
    metrics.byType[type].profit += profit;
    if (isWin) metrics.byType[type].wins++;

    // By sport
    if (!metrics.bySport[tip.sport]) metrics.bySport[tip.sport] = newBucket();
    metrics.bySport[tip.sport].total++;
    metrics.bySport[tip.sport].staked += stake;
    metrics.bySport[tip.sport].profit += profit;
    if (isWin) metrics.bySport[tip.sport].wins++;

    // Calibration: use EV to estimate predicted probability
    // p_predicted = (EV/100 + 1) / odds (from Kelly formula)
    const ev = parseFloat(String(tip.ev).replace('%', '').replace('+', '')) || 0;
    const pPredicted = Math.max(0, Math.min(1, (ev / 100 + 1) / odds));
    const bucketIdx  = Math.min(9, Math.floor(pPredicted * 10));
    metrics.calibration[bucketIdx].wins  += isWin ? 1 : 0;
    metrics.calibration[bucketIdx].total++;

    // ── ML re-simulation (esports only, skip live re-sim as compScore unavailable) ──
    if (tip.sport === 'esports' && tip.participant1 && tip.participant2 && tip.sent_at) {
      mlSim.total++;

      const cutoff  = tip.sent_at;
      const game    = 'lol'; // default game key used in match_results
      const p1      = tip.participant1;
      const p2      = tip.participant2;

      // Form data up to sent_at
      const form1Rows = getFormUpTo.all(p1, p1, game, cutoff);
      const form2Rows = getFormUpTo.all(p2, p2, game, cutoff);

      const buildForm = (rows, team) => {
        const wins   = rows.filter(r => r.winner && r.winner.toLowerCase() === team.toLowerCase()).length;
        const losses = rows.length - wins;
        const winRate = rows.length > 0 ? (wins / rows.length) * 100 : 50;
        return { wins, losses, winRate };
      };

      const form1 = buildForm(form1Rows, p1);
      const form2 = buildForm(form2Rows, p2);

      // H2H up to sent_at
      const h2hRows = getH2HUpTo.all(p1, p2, p2, p1, game, cutoff);
      const h2hT1Wins = h2hRows.filter(r => r.winner && r.winner.toLowerCase() === p1.toLowerCase()).length;
      const h2hT2Wins = h2hRows.filter(r => r.winner && r.winner.toLowerCase() === p2.toLowerCase()).length;
      const h2h = { t1Wins: h2hT1Wins, t2Wins: h2hT2Wins };

      const enrich = { form1, form2, h2h };
      const oddsObj = { t1: String(odds), t2: String(2.0) }; // p2 odds unknown; use 2.0 as neutral

      // compScore not available historically — pass null
      const mlResult = esportsPreFilter(null, oddsObj, enrich, false, null, null);

      if (mlResult.pass) mlSim.passed++;
      else mlSim.blocked++;

      // Determine actual winning side (t1 = participant1)
      const actualWinner = isWin
        ? (tip.tip_participant === tip.participant1 ? 't1' : 't2')
        : (tip.tip_participant === tip.participant1 ? 't2' : 't1');

      // Forma factor accuracy
      if (form1Rows.length > 0 && form2Rows.length > 0) {
        mlSim.factors.forma.total++;
        const formaFavors = form1.winRate >= form2.winRate ? 't1' : 't2';
        if (formaFavors === actualWinner) mlSim.factors.forma.correct++;
      }

      // H2H factor accuracy
      if (h2hT1Wins + h2hT2Wins > 0) {
        mlSim.factors.h2h.total++;
        const h2hFavors = h2hT1Wins >= h2hT2Wins ? 't1' : 't2';
        if (h2hFavors === actualWinner) mlSim.factors.h2h.correct++;
      }
    }
  }

  // ── Print Report ──
  const roi = metrics.totalStaked > 0 ? (metrics.totalProfit / metrics.totalStaked * 100) : 0;
  const wr  = metrics.total > 0 ? (metrics.wins / metrics.total * 100) : 0;

  console.log('── GERAL ──');
  console.log(`Tips: ${metrics.total} | Wins: ${metrics.wins} (${wr.toFixed(1)}%) | Losses: ${metrics.losses}`);
  console.log(`Staked: ${metrics.totalStaked.toFixed(1)}u | Profit: ${metrics.totalProfit >= 0 ? '+' : ''}${metrics.totalProfit.toFixed(2)}u | ROI: ${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%`);

  console.log('\n── POR CONFIANÇA ──');
  for (const [conf, b] of Object.entries(metrics.byConf)) {
    if (!b.total) continue;
    const r = b.staked > 0 ? (b.profit / b.staked * 100) : 0;
    const w = b.total > 0 ? (b.wins / b.total * 100) : 0;
    console.log(`  ${conf}: ${b.total} tips | WR ${w.toFixed(1)}% | ROI ${r >= 0 ? '+' : ''}${r.toFixed(2)}% | P&L ${b.profit >= 0 ? '+' : ''}${b.profit.toFixed(2)}u`);
  }

  console.log('\n── POR TIPO ──');
  for (const [type, b] of Object.entries(metrics.byType)) {
    if (!b.total) continue;
    const r = b.staked > 0 ? (b.profit / b.staked * 100) : 0;
    const w = b.total > 0 ? (b.wins / b.total * 100) : 0;
    console.log(`  ${type}: ${b.total} tips | WR ${w.toFixed(1)}% | ROI ${r >= 0 ? '+' : ''}${r.toFixed(2)}% | P&L ${b.profit >= 0 ? '+' : ''}${b.profit.toFixed(2)}u`);
  }

  console.log('\n── POR ESPORTE ──');
  for (const [sport, b] of Object.entries(metrics.bySport)) {
    if (!b.total) continue;
    const r = b.staked > 0 ? (b.profit / b.staked * 100) : 0;
    const w = b.total > 0 ? (b.wins / b.total * 100) : 0;
    console.log(`  ${sport}: ${b.total} tips | WR ${w.toFixed(1)}% | ROI ${r >= 0 ? '+' : ''}${r.toFixed(2)}% | P&L ${b.profit >= 0 ? '+' : ''}${b.profit.toFixed(2)}u`);
  }

  // ── ML re-simulation results ──
  if (mlSim.total > 0) {
    console.log('\n── ML RE-SIMULAÇÃO (esports, sem look-ahead) ──');
    console.log(`  Tips re-simulados: ${mlSim.total} | Aprovados: ${mlSim.passed} | Bloqueados: ${mlSim.blocked}`);

    console.log('\n── PRECISÃO POR FATOR ──');
    console.log('  Fator      | Corretos | Total | Acurácia');
    console.log('  -----------|----------|-------|----------');
    for (const [factor, f] of Object.entries(mlSim.factors)) {
      if (!f.total) continue;
      const acc = (f.correct / f.total * 100).toFixed(1);
      console.log(`  ${factor.padEnd(10)} | ${String(f.correct).padEnd(8)} | ${String(f.total).padEnd(5)} | ${acc}%`);
    }
  }

  console.log('\n── CALIBRAÇÃO (prob. prevista vs. win rate real) ──');
  console.log('  Bucket    | Previsto | Real     | N');
  console.log('  ----------|----------|----------|----');
  for (const c of metrics.calibration) {
    if (!c.total) continue;
    const real    = (c.wins / c.total * 100).toFixed(1);
    const diff    = (c.wins / c.total * 100 - c.predicted).toFixed(1);
    const diffStr = parseFloat(diff) >= 0 ? `+${diff}%` : `${diff}%`;
    console.log(`  ${c.bucket.padEnd(10)}| ${c.predicted}%     | ${real.padEnd(8)}| ${c.total} (${diffStr})`);
  }

  // ── Kelly efficiency ──
  console.log('\n── KELLY EFFICIENCY ──');
  const positiveEV = tips.filter(t => {
    const ev = parseFloat(String(t.ev).replace('%', '').replace('+', '')) || 0;
    return ev > 0;
  });
  const negEV = tips.filter(t => {
    const ev = parseFloat(String(t.ev).replace('%', '').replace('+', '')) || 0;
    return ev <= 0;
  });
  const posWR = positiveEV.length > 0
    ? positiveEV.filter(t => t.result === 'win').length / positiveEV.length * 100
    : 0;
  const negWR = negEV.length > 0
    ? negEV.filter(t => t.result === 'win').length / negEV.length * 100
    : 0;
  console.log(`  EV+ tips: ${positiveEV.length} | WR: ${posWR.toFixed(1)}%`);
  console.log(`  EV<=0 tips: ${negEV.length} | WR: ${negWR.toFixed(1)}%`);

  // ── Odds distribution ──
  console.log('\n── DISTRIBUIÇÃO DE ODDS (win rate por faixa) ──');
  const oddsBuckets = {};
  for (const tip of tips) {
    const o      = parseFloat(tip.odds) || 0;
    const bucket = o < 1.5 ? '<1.5' : o < 2.0 ? '1.5-2.0' : o < 2.5 ? '2.0-2.5' : o < 3.0 ? '2.5-3.0' : '3.0+';
    if (!oddsBuckets[bucket]) oddsBuckets[bucket] = { wins: 0, total: 0, profit: 0 };
    oddsBuckets[bucket].total++;
    if (tip.result === 'win') oddsBuckets[bucket].wins++;
    const stake = parseFloat(tip.stake) || 1;
    const odds  = parseFloat(tip.odds)  || 1;
    oddsBuckets[bucket].profit += tip.result === 'win' ? stake * (odds - 1) : -stake;
  }
  const bucketOrder = ['<1.5', '1.5-2.0', '2.0-2.5', '2.5-3.0', '3.0+'];
  for (const bucket of bucketOrder) {
    const b = oddsBuckets[bucket];
    if (!b) continue;
    const wr = (b.wins / b.total * 100).toFixed(1);
    console.log(`  ${bucket}: ${b.total} tips | WR ${wr}% | P&L ${b.profit >= 0 ? '+' : ''}${b.profit.toFixed(2)}u`);
  }

  // ── Análise por factorCount (novo: distingue tips com vs sem dados ML) ──
  console.log('\n── ROI POR FACTORCOUNT (dados ML disponíveis) ──');
  const byFactorCount = {};
  for (const tip of tips) {
    if (tip.sport !== 'esports') continue;
    // model_p_pick > 0 indica que factorCount >= 1
    const hasModelP = tip.model_p_pick && parseFloat(tip.model_p_pick) > 0;
    const bucket = hasModelP ? 'com_dados_ml' : 'sem_dados_ml';
    if (!byFactorCount[bucket]) byFactorCount[bucket] = newBucket();
    byFactorCount[bucket].total++;
    const s = parseFloat(tip.stake) || 1;
    const o = parseFloat(tip.odds)  || 1;
    const p = tip.result === 'win';
    byFactorCount[bucket].staked += s;
    byFactorCount[bucket].profit += p ? s * (o - 1) : -s;
    if (p) byFactorCount[bucket].wins++;
  }
  for (const [b, d] of Object.entries(byFactorCount)) {
    const r = d.staked > 0 ? (d.profit / d.staked * 100) : 0;
    const w = d.total > 0 ? (d.wins / d.total * 100) : 0;
    const icon = r > 0 ? '✅' : '❌';
    console.log(`  ${icon} ${b}: ${d.total} tips | WR ${w.toFixed(1)}% | ROI ${r >= 0 ? '+' : ''}${r.toFixed(2)}%`);
  }

  // ── CLV analysis ──
  const clvTips = tips.filter(t => t.clv_odds && parseFloat(t.clv_odds) > 1);
  if (clvTips.length > 0) {
    console.log('\n── CLV (Closing Line Value) ──');
    const clvValues = clvTips.map(t => {
      const tipOdds = parseFloat(t.odds) || 1;
      const clvOdds = parseFloat(t.clv_odds) || 1;
      return ((tipOdds / clvOdds) - 1) * 100; // CLV positivo = bet antes do closing foi melhor
    });
    const avgCLV = clvValues.reduce((a, b) => a + b, 0) / clvValues.length;
    const posRate = clvValues.filter(v => v > 0).length / clvValues.length * 100;
    console.log(`  Tips com CLV: ${clvTips.length} | CLV médio: ${avgCLV >= 0 ? '+' : ''}${avgCLV.toFixed(2)}%`);
    console.log(`  CLV positivo: ${posRate.toFixed(1)}% das tips`);
    if (avgCLV > 1.5) console.log('  ✅ CLV positivo consistente — modelo tem edge real');
    else if (avgCLV > 0) console.log('  🟡 CLV marginalmente positivo — monitorar');
    else console.log('  ❌ CLV negativo — apostas pioram após o bet (sem edge ou timing ruim)');
  }

  // ── Recomendações automáticas ──
  console.log('\n── RECOMENDAÇÕES ──');
  const esportsTips = tips.filter(t => t.sport === 'esports' && t.result);
  if (esportsTips.length >= 20) {
    const roiEsports = esportsTips.reduce((acc, t) => {
      const s = parseFloat(t.stake) || 1, o = parseFloat(t.odds) || 1;
      return acc + (t.result === 'win' ? s * (o - 1) : -s);
    }, 0) / esportsTips.reduce((acc, t) => acc + (parseFloat(t.stake) || 1), 0) * 100;

    if (roiEsports < -10) {
      console.log('  → ROI < -10%: considere LOL_KELLY_CAL=0.7 e aumentar LOL_MIN_EDGE_NO_COMP para 6.0');
    } else if (roiEsports < 0) {
      console.log('  → ROI negativo: considere LOL_KELLY_CAL=0.8 e revisar thresholds de EV');
    } else if (roiEsports > 10) {
      console.log('  → ROI > +10%: sistema com edge. Pode testar LOL_KELLY_CAL=1.1 para aumentar stakes');
    } else {
      console.log('  → ROI marginalmente positivo: manter configuração atual, aumentar sample size');
    }

    const altaTips = esportsTips.filter(t => (t.confidence || '').toUpperCase() === 'ALTA');
    const altaROI = altaTips.length > 5 ? altaTips.reduce((acc, t) => {
      const s = parseFloat(t.stake) || 1, o = parseFloat(t.odds) || 1;
      return acc + (t.result === 'win' ? s * (o - 1) : -s);
    }, 0) / altaTips.reduce((acc, t) => acc + (parseFloat(t.stake) || 1), 0) * 100 : null;

    if (altaROI !== null && altaROI < -5) {
      console.log('  → ALTA confiança com ROI negativo: elevar LOL_EV_THRESHOLD para 8');
    }
  } else {
    console.log(`  → Sample size insuficiente (${esportsTips.length} esports tips). Mínimo 20 para recomendações.`);
  }

  console.log('\n=== Fim do Backtest ===\n');
  db.close();
}

function newBucket() {
  return { wins: 0, losses: 0, total: 0, staked: 0, profit: 0 };
}

main().catch(e => { console.error(e); process.exit(1); });
