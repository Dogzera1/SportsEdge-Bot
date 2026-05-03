'use strict';

/**
 * lol-map-model.js — P(team vence o mapa atual) em LoL com base em live stats.
 *
 * Estrutura espelha dota-map-model.js com coeficientes tunados pra LoL:
 *   - Gold weight: 8000 (LoL tem gold diffs menores e mais sensíveis que Dota)
 *   - Tower/drake/baron bonuses (LoL-específicos)
 *   - Momentum da série (quem ganhou mapa anterior)
 *   - Baseline pré-mapa (prob-série como prior fraco)
 *
 * Uso:
 *   predictLolMapWinner({ liveStats, seriesScore, baselineP, pickTeam, team1Name })
 *
 * Live stats esperados (formato Riot lolesports):
 *   { hasLiveStats, gameTime (s), blueTeam: { name, totalGold, totalKills, towerKills,
 *                                              dragons, barons, inhibitors },
 *                                  redTeam: {...} }
 */

function _logistic(x) { return 1 / (1 + Math.exp(-x)); }

function predictLolMapWinner({ liveStats, seriesScore, baselineP = 0.5, pickTeam, team1Name }) {
  const factors = [];
  if (!liveStats?.hasLiveStats) {
    return { p: baselineP, confidence: 0.2, factors, reason: 'sem live stats — usando baseline' };
  }

  const blue = liveStats.blueTeam || {};
  const red  = liveStats.redTeam  || {};
  const gameTime = Number(liveStats.gameTime) || 0; // segundos
  const gameMin = gameTime / 60;

  // 1) Gold diff modulado por tempo
  // Pre-10min: gold diff fraco (lane phase). 10-25min: médio. 25+: forte.
  const goldDiff = (blue.totalGold || 0) - (red.totalGold || 0);
  const timeWeight = Math.min(1, Math.max(0.3, (gameMin - 5) / 25));
  // 5k lead aos 25min → ~+0.62; 5k aos 10min → ~+0.55. Mais sensível que Dota (LoL gold menor).
  const goldShift = _logistic(goldDiff / 8000 * timeWeight * 2) - 0.5;
  if (goldDiff !== 0) factors.push({ name: 'goldDiff', delta: +goldShift.toFixed(3), value: goldDiff });

  // 2) Kill diff
  const killDiff = (blue.totalKills || 0) - (red.totalKills || 0);
  const killShift = _logistic(killDiff / 8) - 0.5; // ±8 kills → ±0.22 (LoL kill scale menor que Dota)
  if (killDiff !== 0) factors.push({ name: 'killDiff', delta: +killShift.toFixed(3), value: killDiff });

  // 3) Torre diff — LoL fator específico forte (controle de mapa / structure dmg)
  const towerDiff = (blue.towerKills || 0) - (red.towerKills || 0);
  const towerShift = _logistic(towerDiff / 4) - 0.5; // ±4 towers → ±0.22
  if (towerDiff !== 0) factors.push({ name: 'towerDiff', delta: +towerShift.toFixed(3), value: towerDiff });

  // 4) Dragon diff — proxy de soul acumulado
  const blueDragons = typeof blue.dragons === 'number' ? blue.dragons
    : Array.isArray(blue.dragonTypes) ? blue.dragonTypes.length : 0;
  const redDragons = typeof red.dragons === 'number' ? red.dragons
    : Array.isArray(red.dragonTypes) ? red.dragonTypes.length : 0;
  const dragonDiff = blueDragons - redDragons;
  // Aproaching soul (4 drakes) = +0.15 boost
  let dragonShift = dragonDiff * 0.03;
  if (blueDragons >= 3) dragonShift += 0.05;
  if (redDragons >= 3) dragonShift -= 0.05;
  if (dragonDiff !== 0) factors.push({ name: 'dragonDiff', delta: +dragonShift.toFixed(3), value: `${blueDragons}-${redDragons}` });

  // 5) Baron diff — buff é decisivo em endgame
  const baronDiff = (blue.barons || 0) - (red.barons || 0);
  const baronShift = baronDiff * 0.08; // cada baron = +8pp swing
  if (baronDiff !== 0) factors.push({ name: 'baronDiff', delta: +baronShift.toFixed(3), value: baronDiff });

  // 6) Inhibitor diff — pressão estrutural forte
  const inhibDiff = (blue.inhibitors || 0) - (red.inhibitors || 0);
  const inhibShift = inhibDiff * 0.06;
  if (inhibDiff !== 0) factors.push({ name: 'inhibDiff', delta: +inhibShift.toFixed(3), value: inhibDiff });

  // 7) Momentum da série
  // 2026-05-03 FIX: name match flexível (norm + substring) — antes strict toLowerCase
  // equality flippava momentum sign quando "T1" vs "T1 Esports" / "PSG.LGD" vs "PSG LGD".
  const _normTeam = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
  const _teamMatches = (a, b) => {
    const na = _normTeam(a), nb = _normTeam(b);
    if (!na || !nb) return false;
    return na === nb || (na.length >= 3 && (na.includes(nb) || nb.includes(na)));
  };

  let momentumShift = 0;
  const s1 = seriesScore?.score1 || 0;
  const s2 = seriesScore?.score2 || 0;
  if (s1 + s2 >= 1 && team1Name) {
    const blueIsTeam1 = _teamMatches(blue.name, team1Name);
    if (s1 > s2) momentumShift = blueIsTeam1 ? +0.03 : -0.03;
    else if (s2 > s1) momentumShift = blueIsTeam1 ? -0.03 : +0.03;
    if (momentumShift) factors.push({ name: 'momentum', delta: momentumShift, value: `${s1}-${s2}` });
  }

  // 8) Baseline (prior fraco)
  // Mais peso quando live sinal é fraco (game curto ou poucas métricas)
  const hasStrongLive = gameMin >= 15 && Math.abs(goldDiff) >= 2000;
  const baselineWeight = hasStrongLive ? 0.2 : 0.5;
  const baselineShift = (baselineP - 0.5) * baselineWeight;
  if (baselineShift !== 0) factors.push({ name: 'baseline', delta: +baselineShift.toFixed(3), value: baselineP });

  let pBlue = 0.5 + goldShift + killShift + towerShift + dragonShift + baronShift + inhibShift + momentumShift + baselineShift;
  pBlue = Math.max(0.05, Math.min(0.95, pBlue));

  // Confiança
  let confidence = 0.30;
  if (gameMin >= 10) confidence += 0.15;
  if (gameMin >= 20) confidence += 0.15;
  if (gameMin >= 30) confidence += 0.10;
  if (Math.abs(goldDiff) >= 5000) confidence += 0.10;
  if ((blue.barons || 0) + (red.barons || 0) >= 1) confidence += 0.05;
  confidence = Math.min(0.95, confidence);

  // Ajusta pra perspectiva do pickTeam — usa _teamMatches (norm + substring)
  // 2026-05-03 FIX: junto com fix do bot.js:7505 (passa pickTeam=team1), name
  // mismatch strict caía em fallback baselineP. Match flexível resolve "T1" vs
  // "T1 Esports" e similar PandaScore vs Riot divergence.
  let p = pBlue;
  if (pickTeam) {
    const pickIsBlue = _teamMatches(pickTeam, blue.name);
    const pickIsRed  = _teamMatches(pickTeam, red.name);
    if (pickIsRed && !pickIsBlue) p = 1 - pBlue;
    else if (!pickIsBlue && !pickIsRed) {
      return { p: baselineP, confidence: 0.15, factors, reason: `pickTeam "${pickTeam}" não bate com blue/red (${blue.name}/${red.name})` };
    }
  }

  const reason = `gameMin=${gameMin.toFixed(1)} goldDiff=${goldDiff} towerDiff=${towerDiff} dragonDiff=${dragonDiff} baronDiff=${baronDiff} pBlue=${(pBlue*100).toFixed(1)}%`;
  return { p: +p.toFixed(3), confidence: +confidence.toFixed(2), factors, reason };
}

module.exports = { predictLolMapWinner };
