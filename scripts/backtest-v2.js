#!/usr/bin/env node
'use strict';

// Backtest v2 — aplica os gates atuais (sharp divergence, P-vs-modelo, tier-aware,
// EV sanity) retroativamente em tips settled. Compara performance REAL vs HIPOTÉTICA.
// Reporta veredito: "modelo tem edge?" por sport+phase+tier.
//
// Uso: node scripts/backtest-v2.js [--days 60] [--verbose]
//
// Output:
//   - ROI/Brier real (tips que passaram nos gates antigos)
//   - ROI/Brier hipotético (se gates novos tivessem rodado retroativamente)
//   - Comparação: stake salvo, win rate diff, Brier improvement
//   - Veredito por bucket: edge real / variância / sample insuficiente

require('dotenv').config({ override: true });
const path = require('path');
const initDatabase = require('../lib/database');

const DB_PATH = (process.env.DB_PATH || path.join(__dirname, '../sportsedge.db')).trim().replace(/^=+/, '');
const DAYS = parseInt(process.argv.find(a => a.startsWith('--days'))?.split('=')[1] || (process.argv.includes('--days') ? process.argv[process.argv.indexOf('--days') + 1] : '90'), 10);
const VERBOSE = process.argv.includes('--verbose');

// ── Gates atuais (replicados aqui pra usar offline) ──
const SHARP_CAP_PP = {
  esports: 15, dota: 15, mma: 10, tennis: 12, football: 10,
  cs: 12, valorant: 12, darts: 15, snooker: 15, tabletennis: 20,
};
const VALIDATE_P_TOL_PP = 8;
const EV_SANITY_MAX = 50;
const LOL_TIER2_EV_CAP = 25;
const CS_TIER1_RE = /\b(major|iem\b|katowice|cologne|esl pro league|epl\b|blast premier|esports world cup|ewc|austin|rio|shanghai|paris)\b/i;
const TIER1_REGEX = {
  esports: /\b(lck|lec|lcs|lpl|msi\b|worlds|cblol|dota.*?(major|riyadh|the international|ti\d|dpc))\b/i,
  cs: CS_TIER1_RE,
  valorant: /\b(vct.*?(champions|masters|internationals)|game changers championship|valorant.*?champions)\b/i,
  tennis: /\b(grand slam|wimbledon|us open|roland garros|australian open|atp masters|wta 1000|atp 1000|atp finals|wta finals)\b/i,
  mma: /\b(ufc \d{3,}|ufc on |ufc fight night|ufc apex)\b/i,
  football: /\b(premier league|la liga|bundesliga|serie a$|ligue 1|champions league|brasileirao|brasileirão|copa libertadores)\b/i,
};
const tierOf = (sport, eventName) => {
  const re = TIER1_REGEX[sport];
  if (!re) return 'unknown';
  return re.test(String(eventName || '')) ? 'tier1' : 'tier2plus';
};
const isLolTier1 = (s) => /\b(lck|lec|lcs|lpl|msi|worlds|cblol|cbloldbrazil|lla|pcs|lco|vcs|esports world cup)\b/i.test(s || '');

function dejuice(odd1, odd2) {
  const o1 = parseFloat(odd1), o2 = parseFloat(odd2);
  if (!o1 || !o2 || o1 <= 1 || o2 <= 1) return null;
  const r1 = 1 / o1, r2 = 1 / o2;
  const vig = r1 + r2;
  return { p1: r1 / vig, p2: r2 / vig };
}

// Aplica gates simulando se a tip teria passado HOJE.
// Retorna { passed: bool, reasons: [reason, reason] }
function applyCurrentGates(tip) {
  const reasons = [];
  const odds = parseFloat(tip.odds);
  const ev = parseFloat(tip.ev);
  const modelP = parseFloat(tip.model_p_pick);

  // Gate: EV sanity (>50% rejeita)
  if (ev > EV_SANITY_MAX) reasons.push(`ev_sanity_${ev.toFixed(0)}>50`);

  // Gate: P-vs-model (precisamos comparar P do texto vs modelP)
  // Não temos texto da IA salvo — pulamos esse gate. Assumimos que se model_p_pick existe, IA P era próximo.

  // Gate: sharp divergence — só aplica se odd vem de Pinnacle (não temos bookmaker per tip facilmente)
  // Aproximação: se modelP existe, calcula divergência vs implied raw (1/odd não dejuiced)
  if (Number.isFinite(modelP) && Number.isFinite(odds) && odds > 1) {
    const impliedRaw = 1 / odds;
    // Estimativa conservadora: assumimos vig 5%, então impliedDejuiced ≈ impliedRaw / 1.025
    const impliedDejuiced = impliedRaw / 1.025;
    const divPp = Math.abs(modelP - impliedDejuiced) * 100;
    const cap = SHARP_CAP_PP[tip.sport] ?? 15;
    if (divPp > cap) reasons.push(`sharp_div_${divPp.toFixed(0)}>cap${cap}`);
  }

  // Gate: LoL tier 2-3 EV cap
  if (tip.sport === 'esports' && !isLolTier1(tip.event_name) && ev > LOL_TIER2_EV_CAP) {
    reasons.push(`lol_tier2_ev_${ev.toFixed(0)}>25`);
  }

  // Gate: CS tier 2+ — conf ALTA não deveria existir
  if (tip.sport === 'cs' && tierOf('cs', tip.event_name) === 'tier2plus' && tip.confidence === 'ALTA') {
    reasons.push(`cs_tier2_alta_rebaixada`);
  }

  // Gate: MMA non-sharp (assumimos book não-sharp se odds são "não usuais" pra Pinnacle).
  // Sem bookmaker real, estimamos: MMA EV>12% em book non-sharp não passaria.
  // Heurística fraca; só sinaliza se EV > 18% (provável non-sharp inflado).
  if (tip.sport === 'mma' && ev > 18) {
    reasons.push(`mma_high_ev_check_book`);
  }

  return { passed: reasons.length === 0, reasons };
}

function brier(p, outcome) {
  // outcome: 1 = win, 0 = loss
  const pClamped = Math.max(0.01, Math.min(0.99, p));
  return (pClamped - outcome) ** 2;
}

function newBucket() {
  return {
    n: 0, wins: 0, losses: 0, pushes: 0,
    stakeR: 0, profitR: 0,
    brierSum: 0, brierN: 0,
    blocked_by_gates: 0, gate_reasons: {},
    saved_loss: 0, // stake salvo se tips bloqueadas eram losses
    lost_profit: 0, // profit perdido se tips bloqueadas eram wins
  };
}

function aggBucket(b) {
  const decided = b.wins + b.losses;
  return {
    n: b.n,
    wins: b.wins, losses: b.losses, pushes: b.pushes,
    hitRate: decided > 0 ? parseFloat((b.wins / decided * 100).toFixed(1)) : null,
    roi: b.stakeR > 0 ? parseFloat(((b.profitR / b.stakeR) * 100).toFixed(2)) : null,
    profit_reais: parseFloat(b.profitR.toFixed(2)),
    stake_reais: parseFloat(b.stakeR.toFixed(2)),
    brier: b.brierN > 0 ? parseFloat((b.brierSum / b.brierN).toFixed(3)) : null,
  };
}

async function main() {
  console.log(`\n╔══════════════════════════════════════════════════════════════════╗`);
  console.log(`║  SportsEdge Backtest v2 — Validação dos gates novos             ║`);
  console.log(`╚══════════════════════════════════════════════════════════════════╝\n`);
  console.log(`DB: ${DB_PATH}`);
  console.log(`Janela: últimos ${DAYS} dias`);
  console.log(`Verbose: ${VERBOSE ? 'sim' : 'não (use --verbose pra ver tip por tip)'}\n`);

  const { db } = initDatabase(DB_PATH);

  const tips = db.prepare(`
    SELECT id, sport, match_id, event_name, participant1, participant2,
           tip_participant, odds, ev, stake, stake_reais, profit_reais,
           confidence, is_live, sent_at, settled_at, result, model_p_pick, clv_odds
    FROM tips
    WHERE result IN ('win','loss','push')
      AND settled_at IS NOT NULL
      AND settled_at >= datetime('now', ?)
    ORDER BY sent_at ASC
  `).all(`-${DAYS} days`);

  if (!tips.length) {
    console.log('❌ Nenhum tip settled na janela. Rode o bot mais tempo ou aumente --days.');
    process.exit(0);
  }

  console.log(`Tips settled na janela: ${tips.length}`);
  console.log(`Período: ${tips[0].settled_at} → ${tips[tips.length - 1].settled_at}\n`);

  // ── REAL: o que efetivamente aconteceu ──
  const real = { overall: newBucket(), buckets: new Map() };
  // ── HIPOTÉTICO: aplicando gates atuais ──
  const hyp = { overall: newBucket(), buckets: new Map(), blocked: newBucket() };
  // ── Reasons globais ──
  const allReasons = {};

  for (const tip of tips) {
    const sport = tip.sport;
    const phase = tip.is_live ? 'live' : 'pregame';
    const tier = tierOf(sport, tip.event_name);
    const key = `${sport}|${phase}|${tier}`;
    const odds = parseFloat(tip.odds);
    const stakeR = Number(tip.stake_reais) || 0;
    const profitR = tip.result === 'push' ? 0 : Number(tip.profit_reais) || 0;
    const isWin = tip.result === 'win';
    const isLoss = tip.result === 'loss';
    const isPush = tip.result === 'push';

    // Brier setup: usa model_p_pick se houver
    const pStored = parseFloat(tip.model_p_pick);
    const pUsed = (Number.isFinite(pStored) && pStored > 0 && pStored < 1)
      ? pStored
      : (odds > 1 ? 1 / odds : 0.5);

    // ── REAL ──
    const realB = real.buckets.get(key) || newBucket();
    realB.n++;
    if (isWin) realB.wins++;
    else if (isLoss) realB.losses++;
    else if (isPush) realB.pushes++;
    realB.stakeR += stakeR;
    realB.profitR += profitR;
    if (isWin || isLoss) {
      realB.brierSum += brier(pUsed, isWin ? 1 : 0);
      realB.brierN++;
    }
    real.buckets.set(key, realB);

    real.overall.n++;
    if (isWin) real.overall.wins++;
    else if (isLoss) real.overall.losses++;
    else if (isPush) real.overall.pushes++;
    real.overall.stakeR += stakeR;
    real.overall.profitR += profitR;
    if (isWin || isLoss) {
      real.overall.brierSum += brier(pUsed, isWin ? 1 : 0);
      real.overall.brierN++;
    }

    // ── HIPOTÉTICO ──
    const gateResult = applyCurrentGates(tip);
    if (!gateResult.passed) {
      // Tip teria sido BLOQUEADA pelos gates novos
      hyp.blocked.n++;
      hyp.blocked.stakeR += stakeR;
      hyp.blocked.profitR += profitR;
      if (isWin) hyp.blocked.lost_profit += profitR; // teria ganho mas bloqueamos
      else if (isLoss) hyp.blocked.saved_loss += Math.abs(profitR); // teria perdido mas bloqueamos
      // Trackeia reasons
      gateResult.reasons.forEach(r => {
        const tag = r.split('_')[0]; // primeira palavra como categoria
        allReasons[tag] = (allReasons[tag] || 0) + 1;
      });
      const realB2 = real.buckets.get(key);
      if (realB2) realB2.blocked_by_gates++;
      if (VERBOSE) {
        console.log(`  🚫 #${tip.id} ${sport}|${phase}|${tier} | ${tip.tip_participant} @ ${odds} | ${tip.result.toUpperCase()} (${profitR>=0?'+':''}R$${profitR.toFixed(2)}) | gates: ${gateResult.reasons.join(', ')}`);
      }
      continue;
    }
    // Tip passa nos gates
    const hypB = hyp.buckets.get(key) || newBucket();
    hypB.n++;
    if (isWin) hypB.wins++;
    else if (isLoss) hypB.losses++;
    else if (isPush) hypB.pushes++;
    hypB.stakeR += stakeR;
    hypB.profitR += profitR;
    if (isWin || isLoss) {
      hypB.brierSum += brier(pUsed, isWin ? 1 : 0);
      hypB.brierN++;
    }
    hyp.buckets.set(key, hypB);

    hyp.overall.n++;
    if (isWin) hyp.overall.wins++;
    else if (isLoss) hyp.overall.losses++;
    else if (isPush) hyp.overall.pushes++;
    hyp.overall.stakeR += stakeR;
    hyp.overall.profitR += profitR;
    if (isWin || isLoss) {
      hyp.overall.brierSum += brier(pUsed, isWin ? 1 : 0);
      hyp.overall.brierN++;
    }
  }

  // ── PRINT REAL ──
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('📊 RESULTADO REAL (tips que passaram nos gates antigos)');
  console.log('═══════════════════════════════════════════════════════════════════\n');
  printOverall(real.overall);

  // ── PRINT HIPOTÉTICO ──
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('🧪 SIMULAÇÃO COM GATES ATUAIS (se rodassem retroativamente)');
  console.log('═══════════════════════════════════════════════════════════════════\n');
  printOverall(hyp.overall);

  // ── COMPARAÇÃO ──
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('🔄 COMPARAÇÃO REAL vs HIPOTÉTICO');
  console.log('═══════════════════════════════════════════════════════════════════\n');
  const realRoi = real.overall.stakeR > 0 ? (real.overall.profitR / real.overall.stakeR) * 100 : 0;
  const hypRoi = hyp.overall.stakeR > 0 ? (hyp.overall.profitR / hyp.overall.stakeR) * 100 : 0;
  const realBrier = real.overall.brierN > 0 ? real.overall.brierSum / real.overall.brierN : null;
  const hypBrier = hyp.overall.brierN > 0 ? hyp.overall.brierSum / hyp.overall.brierN : null;

  console.log(`Tips:    ${real.overall.n} (real) → ${hyp.overall.n} (com gates) | ${hyp.blocked.n} bloqueadas`);
  console.log(`Stake:   R$${real.overall.stakeR.toFixed(2)} → R$${hyp.overall.stakeR.toFixed(2)} | R$${hyp.blocked.stakeR.toFixed(2)} não-arriscado`);
  console.log(`Profit:  R$${real.overall.profitR.toFixed(2)} → R$${hyp.overall.profitR.toFixed(2)}`);
  console.log(`ROI:     ${realRoi >= 0 ? '+' : ''}${realRoi.toFixed(2)}% → ${hypRoi >= 0 ? '+' : ''}${hypRoi.toFixed(2)}% (Δ ${((hypRoi - realRoi) >= 0 ? '+' : '')}${(hypRoi - realRoi).toFixed(2)}pp)`);
  if (realBrier && hypBrier) {
    console.log(`Brier:   ${realBrier.toFixed(3)} → ${hypBrier.toFixed(3)} (${(hypBrier - realBrier) < 0 ? '↓ melhor' : '↑ pior'})`);
  }
  console.log(`\nDas ${hyp.blocked.n} tips bloqueadas:`);
  console.log(`  💚 Loss salva: R$${hyp.blocked.saved_loss.toFixed(2)} (não teríamos perdido)`);
  console.log(`  💔 Win perdida: R$${hyp.blocked.lost_profit.toFixed(2)} (não teríamos ganho)`);
  const netGate = hyp.blocked.saved_loss - hyp.blocked.lost_profit;
  console.log(`  📊 Net gates: R$${netGate >= 0 ? '+' : ''}${netGate.toFixed(2)} ${netGate >= 0 ? '✅ gates valeram' : '❌ gates custaram'}`);

  // ── REASONS DE BLOQUEIO ──
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('🚫 RAZÕES DE BLOQUEIO (top categorias)');
  console.log('═══════════════════════════════════════════════════════════════════\n');
  Object.entries(allReasons).sort((a, b) => b[1] - a[1]).forEach(([reason, count]) => {
    console.log(`  ${reason.padEnd(20)} → ${count} tips`);
  });

  // ── BUCKETS COMPARAÇÃO ──
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('📦 POR BUCKET (sport × phase × tier)');
  console.log('═══════════════════════════════════════════════════════════════════\n');
  console.log('Bucket                          | Real n/W-L  | Real ROI  | Hyp n/W-L  | Hyp ROI   | Δ ROI    | Veredito');
  console.log('--------------------------------+-------------+-----------+------------+-----------+----------+----------');
  const allKeys = new Set([...real.buckets.keys(), ...hyp.buckets.keys()]);
  const sortedKeys = [...allKeys].sort();
  for (const key of sortedKeys) {
    const r = real.buckets.get(key);
    const h = hyp.buckets.get(key) || newBucket();
    if (!r || r.n < 3) continue; // skip buckets minúsculos
    const rRoi = r.stakeR > 0 ? (r.profitR / r.stakeR * 100) : 0;
    const hRoi = h.stakeR > 0 ? (h.profitR / h.stakeR * 100) : 0;
    const delta = hRoi - rRoi;
    const verdict = verdictBucket(r, h);
    const realStr = `${r.n}/${r.wins}W-${r.losses}L`;
    const hypStr = `${h.n}/${h.wins}W-${h.losses}L`;
    console.log(
      key.padEnd(31), '|',
      realStr.padEnd(11), '|',
      `${rRoi >= 0 ? '+' : ''}${rRoi.toFixed(1)}%`.padStart(8), '|',
      hypStr.padEnd(10), '|',
      `${hRoi >= 0 ? '+' : ''}${hRoi.toFixed(1)}%`.padStart(8), '|',
      `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}pp`.padStart(8), '|',
      verdict
    );
  }

  // ── VEREDITO FINAL ──
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('🎯 VEREDITO FINAL');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  // Brier baseline: aposta no implied (1/odd dejuiced) — "monkey betting"
  // Brier do modelo precisa ser MELHOR que esse pra ter edge
  let baselineBrier = 0, baselineN = 0;
  for (const tip of tips) {
    if (tip.result === 'win' || tip.result === 'loss') {
      const odds = parseFloat(tip.odds);
      if (odds > 1) {
        baselineBrier += brier(1 / odds, tip.result === 'win' ? 1 : 0);
        baselineN++;
      }
    }
  }
  const baselineBrierAvg = baselineN > 0 ? baselineBrier / baselineN : null;

  console.log(`Sample total: ${real.overall.n} tips em ${DAYS} dias (${(real.overall.n / DAYS).toFixed(1)} tips/dia)`);
  console.log('');
  if (real.overall.n < 30) {
    console.log('⚠️ SAMPLE INSUFICIENTE pra conclusão estatística (precisa ≥30, idealmente ≥100)');
    console.log('   Rode mais tempo antes de tomar decisões drásticas.');
  } else if (real.overall.n < 100) {
    console.log('⚠️ Sample baixo (n<100) — vereditos são preliminares, alta variância.');
  }
  if (realBrier && baselineBrierAvg) {
    const brierDiff = realBrier - baselineBrierAvg;
    console.log(`\nBrier:`);
    console.log(`  Modelo:    ${realBrier.toFixed(3)}`);
    console.log(`  Baseline:  ${baselineBrierAvg.toFixed(3)} (apostar no favorito do mercado dejuiced)`);
    console.log(`  Diff:      ${brierDiff >= 0 ? '+' : ''}${brierDiff.toFixed(3)}`);
    if (brierDiff < -0.005) {
      console.log(`  ✅ Modelo TEM edge calibrado vs baseline (Brier menor = predições mais corretas)`);
    } else if (brierDiff < 0.005) {
      console.log(`  ⚪ Modelo está EQUIVALENTE ao baseline — sem edge significativo de calibração`);
    } else {
      console.log(`  ❌ Modelo PIOR que baseline — calibração ruim, modelo está adicionando ruído`);
    }
  }
  console.log(`\nROI:`);
  console.log(`  Real (gates antigos):       ${realRoi >= 0 ? '+' : ''}${realRoi.toFixed(2)}%`);
  console.log(`  Hipotético (gates atuais):  ${hypRoi >= 0 ? '+' : ''}${hypRoi.toFixed(2)}%`);
  if (real.overall.n < 30) {
    console.log(`  ⚪ Sample n=${real.overall.n} insuficiente pra veredito ROI (precisa ≥30, idealmente ≥100).`);
  } else if (realRoi > 5 && real.overall.n >= 100) {
    console.log(`  ✅ ROI positivo sustentado em sample relevante — modelo provavelmente lucrativo`);
  } else if (realRoi > 0 && real.overall.n >= 30) {
    console.log(`  🟡 ROI positivo, sample limitado (n<100) — pode ser variância`);
  } else if (realRoi > -5) {
    console.log(`  ⚪ ROI próximo de break-even — modelo paga vig mas não gera edge`);
  } else {
    console.log(`  ❌ ROI negativo — modelo está perdendo dinheiro consistentemente`);
  }
  if (netGate > 0) {
    console.log(`\nGates atuais valeriam +R$${netGate.toFixed(2)} se aplicados retroativamente.`);
  } else {
    console.log(`\nGates atuais teriam custado R$${Math.abs(netGate).toFixed(2)} se aplicados retroativamente.`);
    console.log(`(ou seja: tips bloqueadas eram majoritariamente winners)`);
  }
  console.log('');
  console.log('───────────────────────────────────────────────────────────────────');
  console.log('Próximas ações sugeridas:');
  console.log('  • ROI verde + Brier melhor que baseline → modelo OK, manter coleta');
  console.log('  • ROI negativo + Brier ruim → revisitar lib/<sport>-ml.js');
  console.log('  • Buckets vermelhos com n>=20 → considerar shadow temporário');
  console.log('  • Verbose flag (--verbose) mostra tip-por-tip qual gate bloquearia');
  console.log('');
}

function printOverall(b) {
  const decided = b.wins + b.losses;
  const wr = decided > 0 ? (b.wins / decided * 100) : 0;
  const roi = b.stakeR > 0 ? (b.profitR / b.stakeR) * 100 : 0;
  const brier = b.brierN > 0 ? b.brierSum / b.brierN : null;
  console.log(`Tips:    ${b.n} | W: ${b.wins} | L: ${b.losses} | Push: ${b.pushes}`);
  console.log(`HitRate: ${wr.toFixed(1)}%`);
  console.log(`Stake:   R$${b.stakeR.toFixed(2)} (real)`);
  console.log(`Profit:  R$${b.profitR >= 0 ? '+' : ''}${b.profitR.toFixed(2)}`);
  console.log(`ROI:     ${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%`);
  if (brier != null) console.log(`Brier:   ${brier.toFixed(3)} (n=${b.brierN})`);
}

function verdictBucket(real, hyp) {
  const n = real.n;
  if (n < 10) return '⚪ small (n<10)';
  const rRoi = real.stakeR > 0 ? (real.profitR / real.stakeR * 100) : 0;
  const hRoi = hyp.stakeR > 0 ? (hyp.profitR / hyp.stakeR * 100) : 0;
  if (n >= 30) {
    if (rRoi > 5) return '🟢 LUCRATIVO';
    if (rRoi < -10) return '🔴 BLEED';
    if (hRoi - rRoi > 10) return '🛡️ GATES SALVAM';
    return '🟡 break-even';
  }
  if (rRoi > 10) return '🟢 promising';
  if (rRoi < -15) return '🔴 alarming';
  return '🟡 watch';
}

main().catch(e => { console.error('Erro:', e); process.exit(1); });
