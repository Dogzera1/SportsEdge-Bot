'use strict';

/**
 * cs-map-model.js — P(team vence o mapa atual) em CS2 com HLTV scorebot.
 *
 * Coefs tunados pra CS2 MR12 (first to 13; OT first to 16 em rounds 24-28):
 *   - Score diff dominante, ponderado por round progress
 *   - Match point (≥12 rounds) = bonus forte
 *   - CT side slight advantage (~52% historic)
 *   - Baseline peso moderado (50% quando early, 20% quando late)
 *
 * Uso:
 *   predictCsMapWinner({ liveStats, seriesScore, baselineP, team1Name, team1IsCT })
 */

function _logistic(x) { return 1 / (1 + Math.exp(-x)); }

// CT side advantage por mapa (HLTV 2024-2025 pro data, CT win rate em MR12).
// Mapas mais CT-sided: Anubis/Nuke. Mais balanceados: Ancient/Dust2.
const CT_ADVANTAGE_BY_MAP = {
  inferno:  0.020, // 52% CT
  mirage:   0.040, // 54% CT
  anubis:   0.050, // 55% CT (mais CT-sided)
  nuke:     0.050, // 55% CT
  vertigo:  0.020, // 52% CT
  ancient:  0.010, // 51% CT
  train:    0.030, // 53% CT
  dust2:    0.010, // 51% CT (mais balanceado)
  overpass: 0.030, // 53%
};
function _ctAdvantageForMap(mapName) {
  const k = String(mapName || '').toLowerCase().replace(/^de_/, '').trim();
  return CT_ADVANTAGE_BY_MAP[k] ?? 0.020; // 2% default quando mapa desconhecido
}

function predictCsMapWinner({ liveStats, seriesScore, baselineP = 0.5, team1Name, team1IsCT }) {
  const factors = [];
  if (!liveStats || !liveStats.live) {
    return { p: baselineP, confidence: 0.2, factors, reason: 'sem live stats' };
  }

  const scoreT = Number(liveStats.scoreT) || 0;
  const scoreCT = Number(liveStats.scoreCT) || 0;
  const round = Number(liveStats.round) || (scoreT + scoreCT + 1);

  // Quem é team1? Se team1IsCT=true, t1 é CT (score CT = t1 rounds).
  // Se team1IsCT=false → t1 é T.
  // Se undefined → infere via players (se disponível).
  let t1IsCT = team1IsCT;
  if (t1IsCT == null && Array.isArray(liveStats.players) && liveStats.players.length) {
    // Heurística: só dá pra saber com nomes de jogadores por time, o que
    // o summarizeScoreboard não preserva diretamente. Fallback 50/50.
    t1IsCT = null;
  }

  const t1Rounds = t1IsCT === true ? scoreCT : (t1IsCT === false ? scoreT : Math.max(scoreT, scoreCT));
  const t2Rounds = t1IsCT === true ? scoreT : (t1IsCT === false ? scoreCT : Math.min(scoreT, scoreCT));
  const roundsPlayed = t1Rounds + t2Rounds;
  const scoreDiff = t1Rounds - t2Rounds;

  // 1) Score diff modulado por round progress.
  // Round 1-10 → shift fraco; 15+ → forte; 20+ → dominante.
  const progress = Math.min(1, roundsPlayed / 24);
  const scoreShift = _logistic(scoreDiff / 3 * Math.max(0.3, progress * 2)) - 0.5;
  if (scoreDiff !== 0) factors.push({ name: 'scoreDiff', delta: +scoreShift.toFixed(3), value: `${t1Rounds}-${t2Rounds}` });

  // 2) Match point (≥12) — muito perto de fechar mapa.
  let mpShift = 0;
  if (t1Rounds >= 12 && t2Rounds < 12) {
    mpShift = 0.18 + (t1Rounds - 12) * 0.03; // +18pp @12, +21pp @13 (already won)
  } else if (t2Rounds >= 12 && t1Rounds < 12) {
    mpShift = -0.18 - (t2Rounds - 12) * 0.03;
  }
  if (mpShift) factors.push({ name: 'matchPoint', delta: +mpShift.toFixed(3), value: `t1=${t1Rounds} t2=${t2Rounds}` });

  // 3) CT side advantage — per-map baseado em HLTV 2024-2025 pro CT win rate.
  // Varia 51-55% (Dust2 mais balanceado, Anubis/Nuke mais CT-sided).
  let sideShift = 0;
  const mapName = liveStats.mapName || '';
  const ctAdv = _ctAdvantageForMap(mapName);
  if (t1IsCT === true) sideShift = ctAdv;
  else if (t1IsCT === false) sideShift = -ctAdv;
  if (sideShift) factors.push({
    name: 'ctSide',
    delta: sideShift,
    value: `${t1IsCT ? 'team1' : 'team2'} CT on ${mapName || '?'} (${(ctAdv*100).toFixed(1)}%)`,
  });

  // 4) Economy state — sum(money) per side. Eco round (sum<12.5k = 5×2500) tem
  //    P(win round) ~25%; full buy (sum>20k) ~50%; mid ~38%. Diff entre lados
  //    indica qual side tem economic edge nos próximos rounds.
  //    Empirical: economy edge equilibrado por map progress (mid-late = mais relevante).
  let economyShift = 0;
  if (Array.isArray(liveStats.players) && liveStats.players.length >= 6) {
    let moneyT = 0, moneyCT = 0, countT = 0, countCT = 0;
    for (const p of liveStats.players) {
      const m = Number(p.money);
      if (!Number.isFinite(m)) continue;
      if (p.side === 'T') { moneyT += m; countT++; }
      else if (p.side === 'CT') { moneyCT += m; countCT++; }
    }
    if (countT >= 4 && countCT >= 4) {
      // Diff normalized by typical full-buy total (~25k per side)
      const diffNorm = (moneyT - moneyCT) / 25000;
      // Cap shift ±0.05 (5pp). Mid-late game economy edge mais relevante.
      const economyWeight = roundsPlayed < 6 ? 0.02 : 0.04;
      const rawShift = Math.max(-0.05, Math.min(0.05, diffNorm * economyWeight));
      // Map pra t1 perspective
      const t1Shift = t1IsCT === true ? -rawShift : (t1IsCT === false ? rawShift : 0);
      economyShift = t1Shift;
      if (Math.abs(economyShift) >= 0.005) {
        factors.push({
          name: 'economy',
          delta: +economyShift.toFixed(3),
          value: `T=$${(moneyT/1000).toFixed(1)}k CT=$${(moneyCT/1000).toFixed(1)}k`,
        });
      }
    }
  }

  // 5) Momentum série.
  let momentumShift = 0;
  const s1 = seriesScore?.score1 || 0;
  const s2 = seriesScore?.score2 || 0;
  if (s1 + s2 >= 1) {
    if (s1 > s2) momentumShift = 0.03;
    else if (s2 > s1) momentumShift = -0.03;
    if (momentumShift) factors.push({ name: 'momentum', delta: momentumShift, value: `${s1}-${s2}` });
  }

  // 6) Baseline peso moderado.
  // Early game (round < 6) = baseline domina. Late (round > 18) = live signal forte.
  const baselineWeight = roundsPlayed < 6 ? 0.5 : roundsPlayed < 15 ? 0.3 : 0.15;
  const baselineShift = (baselineP - 0.5) * baselineWeight;
  if (baselineShift !== 0) factors.push({ name: 'baseline', delta: +baselineShift.toFixed(3), value: baselineP });

  let pT1 = 0.5 + scoreShift + mpShift + sideShift + momentumShift + baselineShift + economyShift;
  pT1 = Math.max(0.02, Math.min(0.98, pT1));

  // Confiança: aumenta com rounds played.
  let confidence = 0.25;
  if (roundsPlayed >= 6) confidence += 0.15;
  if (roundsPlayed >= 12) confidence += 0.15;
  if (roundsPlayed >= 18) confidence += 0.15;
  if (Math.abs(scoreDiff) >= 5) confidence += 0.10;
  if (t1Rounds >= 13 || t2Rounds >= 13) confidence = 0.99; // matematicamente decidido
  confidence = Math.min(0.99, confidence);

  // Ajusta pra pickTeam.
  let p = pT1;
  if (team1Name && liveStats.pickTeam && String(team1Name).toLowerCase() !== String(liveStats.pickTeam).toLowerCase()) {
    p = 1 - pT1;
  }

  const reason = `rounds=${roundsPlayed} score=${t1Rounds}-${t2Rounds} diff=${scoreDiff} pT1=${(pT1*100).toFixed(1)}%`;
  return { p: +p.toFixed(3), confidence: +confidence.toFixed(2), factors, reason };
}

module.exports = { predictCsMapWinner };
