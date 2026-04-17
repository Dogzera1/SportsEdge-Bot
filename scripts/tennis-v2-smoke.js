#!/usr/bin/env node
'use strict';

// Tennis v2 — Smoke Test (Fase 1A do plano Vetor 1)
//
// Objetivo: VALIDAR ou MATAR features novas com sample mínimo de horas (~2-3h impl + 1min execução).
// Se nenhuma feature tem |corr| > 0.10 com outcome, mata o vetor cedo (kill switch).
//
// Sem look-ahead: features computadas com asOfDate = sent_at de cada tip.
//
// Uso: node scripts/tennis-v2-smoke.js [--limit 200] [--verbose]

require('dotenv').config({ override: true });
const path = require('path');
const initDatabase = require('../lib/database');
const v2 = require('../lib/tennis-features-v2');

const DB_PATH = (process.env.DB_PATH || path.join(__dirname, '../sportsedge.db')).trim().replace(/^=+/, '');
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit'))?.split('=')[1]
                       || (process.argv.includes('--limit') ? process.argv[process.argv.indexOf('--limit') + 1] : '500'), 10);
const VERBOSE = process.argv.includes('--verbose');

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 5) return null;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX, dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  if (den === 0) return null;
  return num / den;
}

// p-value approx (Fisher z): p ≈ 2 × (1 − Φ(|z|)) onde z = atanh(r) × √(n−3)
function pValueApprox(r, n) {
  if (r == null || n < 5) return null;
  const z = Math.atanh(Math.max(-0.9999, Math.min(0.9999, r))) * Math.sqrt(n - 3);
  // Aproximação CDF normal: 0.5 * (1 + erf(z/√2))
  // Usa erf approx (Abramowitz)
  const erf = (x) => {
    const t = 1 / (1 + 0.3275911 * Math.abs(x));
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return x >= 0 ? y : -y;
  };
  const cdf = 0.5 * (1 + erf(Math.abs(z) / Math.SQRT2));
  return parseFloat((2 * (1 - cdf)).toFixed(4));
}

async function main() {
  console.log(`\n╔══════════════════════════════════════════════════════════════════╗`);
  console.log(`║  Tennis v2 — Smoke Test (Fase 1A)                                ║`);
  console.log(`║  Kill switch: nenhuma feature |corr| > 0.10 → MATA vetor         ║`);
  console.log(`╚══════════════════════════════════════════════════════════════════╝\n`);
  console.log(`DB: ${DB_PATH}`);
  console.log(`Limit: ${LIMIT} tips\n`);

  const { db } = initDatabase(DB_PATH);

  // Pega tips tennis settled
  const tips = db.prepare(`
    SELECT id, sport, match_id, event_name, participant1, participant2, tip_participant,
           odds, ev, sent_at, settled_at, result
    FROM tips
    WHERE sport = 'tennis'
      AND result IN ('win','loss')
      AND sent_at IS NOT NULL
    ORDER BY sent_at DESC
    LIMIT ?
  `).all(LIMIT);

  if (!tips.length) {
    console.log('❌ Nenhuma tip tennis settled. Sem dados pra testar.');
    process.exit(0);
  }

  console.log(`Tips analisadas: ${tips.length}`);
  console.log(`Período: ${tips[tips.length - 1].sent_at} → ${tips[0].sent_at}\n`);

  // Compute features pra cada tip
  const samples = [];
  let withFeatures = 0, withoutHistory = 0;
  for (const tip of tips) {
    const features = v2.computeAllFeatures(db, tip.tip_participant, tip.event_name, tip.sent_at);
    const outcome = tip.result === 'win' ? 1 : 0;
    samples.push({ tip, features, outcome });
    // "Tem histórico" se algum dos counts > 0
    const hasAny = features.matches_last_14d > 0 || features.days_since_last_match != null;
    if (hasAny) withFeatures++; else withoutHistory++;

    if (VERBOSE) {
      console.log(`  #${tip.id} ${tip.tip_participant} (${tip.event_name?.slice(0,30)}) | ${tip.result.toUpperCase()} | f=${JSON.stringify(features)}`);
    }
  }
  console.log(`Tips com histórico: ${withFeatures} | sem histórico: ${withoutHistory}`);
  if (withFeatures < 30) {
    console.log(`\n⚠️ Apenas ${withFeatures} tips têm histórico em match_results. Sample baixo demais pra correlação confiável.`);
    console.log(`   Sugestão: rodar sync de pro stats (PandaScore tennis) ou Sackmann CSV download antes.`);
  }

  // Computa correlação por feature
  const FEATURES = [
    'fatigue_minutes_avg_7d',
    'matches_last_7d',
    'matches_last_14d',
    'days_since_last_match',
    'is_surface_transition',
    'matches_since_transition',
  ];

  console.log(`\n═══════════════════════════════════════════════════════════════════`);
  console.log(`📊 CORRELAÇÃO PEARSON: feature vs outcome (1=win, 0=loss)`);
  console.log(`═══════════════════════════════════════════════════════════════════\n`);
  console.log(`Feature                       | n    | corr     | p-value  | sinal?`);
  console.log(`------------------------------+------+----------+----------+--------`);

  const featureResults = {};
  let anyFeatureSignal = false;
  for (const fname of FEATURES) {
    const xs = [], ys = [];
    for (const s of samples) {
      let v = s.features[fname];
      if (v == null) continue;
      if (typeof v === 'boolean') v = v ? 1 : 0;
      if (!Number.isFinite(v)) continue;
      xs.push(v);
      ys.push(s.outcome);
    }
    if (xs.length < 5) {
      console.log(`${fname.padEnd(30)} | n=${xs.length.toString().padStart(3)}|   N/A    |   N/A    |  insuf.`);
      featureResults[fname] = { n: xs.length, corr: null, pValue: null, hasSignal: false };
      continue;
    }
    const corr = pearson(xs, ys);
    const pval = pValueApprox(corr, xs.length);
    const sigStr = (corr != null && Math.abs(corr) > 0.10) ? '✅ SIM' : '❌ não';
    if (Math.abs(corr) > 0.10 && xs.length >= 30) anyFeatureSignal = true;
    featureResults[fname] = { n: xs.length, corr: parseFloat((corr || 0).toFixed(4)), pValue: pval, hasSignal: Math.abs(corr) > 0.10 };
    console.log(`${fname.padEnd(30)} | ${String(xs.length).padStart(4)} | ${(corr >= 0 ? '+' : '') + corr.toFixed(4)} | ${pval?.toFixed(4) || 'N/A'} | ${sigStr}`);
  }

  // Veredito
  console.log(`\n═══════════════════════════════════════════════════════════════════`);
  console.log(`🎯 VEREDITO`);
  console.log(`═══════════════════════════════════════════════════════════════════\n`);
  if (withFeatures < 30) {
    console.log(`⚪ INCONCLUSIVO — sample com histórico (n=${withFeatures}) baixo demais pra decisão estatística.`);
    console.log(`   Próxima ação: aguardar mais tips settled OU baixar Sackmann CSV pra match_results retroativo.`);
  } else if (anyFeatureSignal) {
    console.log(`🟢 SINAL DETECTADO — pelo menos uma feature tem |corr| > 0.10 com sample n≥30.`);
    console.log(`   Vetor 1 sobrevive ao smoke test. Próximo passo: Fase 1B (backtest formal com Brier).`);
    const winners = Object.entries(featureResults).filter(([, r]) => r.hasSignal && r.n >= 30);
    console.log(`   Features promissoras:`);
    winners.forEach(([f, r]) => console.log(`     - ${f} (corr ${r.corr}, n=${r.n}, p=${r.pValue})`));
  } else {
    console.log(`🔴 VETOR 1 MORRE NO SMOKE TEST.`);
    console.log(`   Nenhuma feature tem |corr| > 0.10 com sample suficiente (n≥30).`);
    console.log(`   Conclusão: features fatigue/surface/recency não capturam edge MENSURÁVEL no nosso dataset.`);
    console.log(`   Próxima ação:`);
    console.log(`     1. Considerar Vetor 2 (latência em esports — Steam RT, VLR live).`);
    console.log(`     2. OU aceitar premissa: modelagem pública não gera edge suficiente neste sport.`);
    console.log(`     3. NÃO implementar v2 (economia de ~150-200h conforme plano).`);
  }

  console.log('');
  process.exit(anyFeatureSignal ? 0 : (withFeatures < 30 ? 0 : 1));
}

main().catch(e => { console.error('Erro:', e); process.exit(2); });
