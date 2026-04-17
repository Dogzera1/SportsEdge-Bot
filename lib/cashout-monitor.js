/**
 * cashout-monitor.js — Saúde em tempo real de tips pendentes.
 *
 * Recomputa P(pick) usando live stats e flagga tips que estão "morrendo"
 * (prob despencou vs no envio). Permite alertar o usuário sobre oportunidade
 * de cashout/hedge — a execução fica por conta dele (casas não oferecem API).
 *
 * Cobre: LoL, tennis, darts. Outros esportes caem no path 'unknown' (sem sinal).
 *
 * Não toca DB, não envia Telegram. É função pura dado (tip, liveStats).
 */

const { log } = require('./utils');

// ── Heurísticas por sport ──
// Mapeiam sinal de placar → prob atual do pick ganhar.

function _lolCurrentP(tip, gameData) {
  // gameData: { blueTeam, redTeam, goldDiff } ou { summary: {...} }
  const s = gameData?.summary || gameData;
  if (!s || typeof s.goldDiff !== 'number') return null;
  const pickIsBlue = _nameMatch(tip.tip_participant, s.blue?.name);
  const pickIsRed = _nameMatch(tip.tip_participant, s.red?.name);
  if (!pickIsBlue && !pickIsRed) return null;
  const goldDiffForPick = pickIsBlue ? s.goldDiff : -s.goldDiff;
  // Curva suave: ±12k gold diff ≈ ±80% prob shift
  const delta = Math.max(-1, Math.min(1, goldDiffForPick / 12000));
  return Math.max(0.05, Math.min(0.95, 0.5 + delta * 0.35));
}

function _setsCurrentP(tip, liveScore) {
  // Usado por tennis/darts — modelo de sets lead
  if (!liveScore?.isLive) return null;
  const homeSets = liveScore.setsHome ?? 0;
  const awaySets = liveScore.setsAway ?? 0;
  const pickIsHome = _nameMatch(tip.tip_participant, tip.participant1);
  const pickIsAway = _nameMatch(tip.tip_participant, tip.participant2);
  if (!pickIsHome && !pickIsAway) return null;
  const pickSets = pickIsHome ? homeSets : awaySets;
  const oppSets  = pickIsHome ? awaySets : homeSets;
  const diff = pickSets - oppSets;
  // Bo3: diff de 2 = vitória; Bo5: diff de 3.
  // Conservador: cada set lead aumenta prob em ~25pp
  const base = 0.5 + diff * 0.22;
  return Math.max(0.05, Math.min(0.95, base));
}

function _nameMatch(a, b) {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

/**
 * Avalia saúde de uma tip live com stats atuais.
 *
 * @param {object} tip — row do DB (com tip_participant, participant1/2, odds, model_p_pick)
 * @param {object} liveCtx — { sport, gameData?, liveScore? }
 * @returns {{ verdict, currentP, currentEv, originalP, deltaP, reason }}
 */
function checkTipHealth(tip, liveCtx) {
  const originalP = Number(tip.model_p_pick) || null;
  const odds = Number(tip.odds) || 0;
  if (!odds || !originalP) {
    return { verdict: 'unknown', reason: 'sem modelo original', currentP: null, currentEv: null, originalP, deltaP: null };
  }

  let currentP = null;
  const sport = liveCtx?.sport || tip.sport;
  if (sport === 'esports' || sport === 'lol') currentP = _lolCurrentP(tip, liveCtx.gameData);
  else if (sport === 'tennis') currentP = _setsCurrentP(tip, liveCtx.liveScore);
  else if (sport === 'darts')  currentP = _setsCurrentP(tip, liveCtx.liveScore);

  if (currentP == null) {
    return { verdict: 'unknown', reason: 'sem sinal live suportado', currentP: null, currentEv: null, originalP, deltaP: null };
  }

  const currentEv = (currentP * odds - 1) * 100;
  const deltaP = currentP - originalP;

  let verdict = 'keep';
  let reason = 'saudável';
  if (currentEv < -20 || deltaP <= -0.30) {
    verdict = 'dying';
    reason = `EV atual ${currentEv.toFixed(1)}%, P caiu ${(deltaP * 100).toFixed(0)}pp (${(originalP*100).toFixed(0)}→${(currentP*100).toFixed(0)})`;
  } else if (currentEv < -5 || deltaP <= -0.15) {
    verdict = 'alert';
    reason = `EV ${currentEv.toFixed(1)}%, P ${(originalP*100).toFixed(0)}→${(currentP*100).toFixed(0)}`;
  }

  return {
    verdict,
    currentP: +currentP.toFixed(3),
    currentEv: +currentEv.toFixed(1),
    originalP: +originalP.toFixed(3),
    deltaP: +deltaP.toFixed(3),
    reason,
  };
}

module.exports = { checkTipHealth };
