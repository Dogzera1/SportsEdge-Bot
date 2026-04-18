/**
 * dota-map-model.js — Modelo de probabilidade de vitória de MAPA (não série) em Dota 2.
 *
 * Consome live stats do /opendota-live (Steam RT quando disponível) e calcula
 * P(team vence o mapa atual) combinando:
 *   - Gold diff (modulado por game time)
 *   - Kill diff
 *   - Momentum da série (quem ganhou mapa anterior)
 *   - Baseline pré-mapa (prob-série como prior fraco)
 *
 * Uso:
 *   predictMapWinner({ liveStats, seriesScore, baselineP, pickTeam })
 *   → { p, confidence, factors, reason }
 *
 * Design:
 *   - Probabilidade referência sempre pro BLUE team do liveStats (depois ajusta pro pick)
 *   - factors: array pra logging/debug
 *   - confidence: 0..1 — baixa em early game/sem per-player stats
 */

function _logistic(x) { return 1 / (1 + Math.exp(-x)); }

/**
 * @param {object} args
 * @param {object} args.liveStats — payload /opendota-live (hasLiveStats, gameTime, blueTeam, redTeam, radiantLead)
 * @param {object} args.seriesScore — { score1, score2, team1, team2 } (score da série até o momento, NÃO inclui mapa atual)
 * @param {number} [args.baselineP] — P(blue vence mapa) antes de live stats. Default 0.5.
 * @param {string} [args.pickTeam] — nome do time escolhido. Se fornecido, retorna P(pickTeam).
 * @param {string} [args.team1Name] — nome do team1 da série (alinha com seriesScore.score1)
 * @returns {{ p: number, confidence: number, factors: Array<{name,delta,value}>, reason: string }}
 */
function predictMapWinner({ liveStats, seriesScore, baselineP = 0.5, pickTeam, team1Name }) {
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
  const goldDiff = (blue.totalGold || 0) - (red.totalGold || 0); // + = blue na frente
  const timeWeight = Math.min(1, Math.max(0.3, (gameMin - 5) / 25)); // 0.3 aos 5min → 1.0 aos 30min
  // 10k lead aos 30min → ~+0.73; 10k aos 10min → ~+0.55
  const goldShift = _logistic(goldDiff / 10000 * timeWeight * 2) - 0.5;
  if (goldDiff !== 0) factors.push({ name: 'goldDiff', delta: +goldShift.toFixed(3), value: goldDiff });

  // 2) Kill diff — sinaliza snowball/tempo
  const killDiff = (blue.totalKills || 0) - (red.totalKills || 0);
  const killShift = _logistic(killDiff / 12) - 0.5; // ±12 kills → ±0.22
  if (killDiff !== 0) factors.push({ name: 'killDiff', delta: +killShift.toFixed(3), value: killDiff });

  // 3) Momentum da série (mapa anterior)
  let momentumShift = 0;
  const s1 = seriesScore?.score1 || 0;
  const s2 = seriesScore?.score2 || 0;
  if (s1 + s2 >= 1 && team1Name) {
    const blueIsTeam1 = String(liveStats.blueTeam?.name || '').toLowerCase() === String(team1Name || '').toLowerCase();
    // quem ganhou mapa anterior ganha +0.04
    if (s1 > s2) momentumShift = blueIsTeam1 ? +0.04 : -0.04;
    else if (s2 > s1) momentumShift = blueIsTeam1 ? -0.04 : +0.04;
    if (momentumShift) factors.push({ name: 'momentum', delta: momentumShift, value: `${s1}-${s2}` });
  }

  // 4) Radiant side advantage (~53% historical pro play).
  // Aplica só quando liveStats.team1IsRadiant é conhecido. Pequeno shift pro blue=team1.
  let radiantShift = 0;
  if (typeof liveStats.team1IsRadiant === 'boolean') {
    radiantShift = liveStats.team1IsRadiant ? 0.015 : -0.015;
    factors.push({ name: 'radiantSide', delta: radiantShift, value: liveStats.team1IsRadiant ? 'team1 Radiant' : 'team1 Dire' });
  }

  // 5) Draft meta factor — picks forte vs fraco na meta pro (via OpenDota hero stats).
  // Requer liveStats.blueTeam.heroes + liveStats.redTeam.heroes + db injected.
  let draftShift = 0;
  if (liveStats._db && Array.isArray(blue.players) && Array.isArray(red.players)) {
    try {
      const { getDraftMatchupFactor } = require('./dota-hero-features');
      const blueHeroes = blue.players.map(p => p.hero).filter(h => h && h !== '?');
      const redHeroes  = red.players.map(p => p.hero).filter(h => h && h !== '?');
      if (blueHeroes.length >= 3 && redHeroes.length >= 3) {
        const mf = getDraftMatchupFactor(liveStats._db, blueHeroes, redHeroes);
        if (mf) {
          // factor é em pp; converte pra shift (×0.01)
          draftShift = Math.max(-0.04, Math.min(0.04, mf.factor * 0.01));
          if (draftShift !== 0) factors.push({ name: 'draftMeta', delta: +draftShift.toFixed(3), value: mf.detail });
        }
      }
    } catch (_) { /* fail silent */ }
  }

  // 6) Baseline (prior fraco): 0.3 peso quando live stats sólidas, 0.7 quando não
  const hasPerPlayer = !!liveStats.hasPlayerStats;
  const baselineWeight = hasPerPlayer ? 0.25 : 0.6;
  const baselineShift = (baselineP - 0.5) * baselineWeight;
  if (baselineShift !== 0) factors.push({ name: 'baseline', delta: +baselineShift.toFixed(3), value: baselineP });

  let pBlue = 0.5 + goldShift + killShift + momentumShift + radiantShift + draftShift + baselineShift;
  pBlue = Math.max(0.05, Math.min(0.95, pBlue));

  // Confiança: função de game time + tipo de dados
  let confidence = 0.35;
  if (gameMin >= 10) confidence += 0.15;
  if (gameMin >= 25) confidence += 0.15;
  if (hasPerPlayer) confidence += 0.2;
  if (Math.abs(goldDiff) >= 8000) confidence += 0.1;
  confidence = Math.min(0.95, confidence);

  // Ajusta pra perspectiva do pickTeam se fornecido
  let p = pBlue;
  if (pickTeam) {
    const pickIsBlue = String(pickTeam || '').toLowerCase() === String(blue.name || '').toLowerCase();
    const pickIsRed  = String(pickTeam || '').toLowerCase() === String(red.name  || '').toLowerCase();
    if (pickIsRed) p = 1 - pBlue;
    else if (!pickIsBlue) {
      return { p: baselineP, confidence: 0.15, factors, reason: `pickTeam "${pickTeam}" não bate com blue/red` };
    }
  }

  const reason = `gameMin=${gameMin.toFixed(1)} goldDiff=${goldDiff} killDiff=${killDiff} pBlue=${(pBlue*100).toFixed(1)}%`;
  return { p: +p.toFixed(3), confidence: +confidence.toFixed(2), factors, reason };
}

module.exports = { predictMapWinner };
