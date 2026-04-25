'use strict';

/**
 * velocity-tracker.js
 *
 * Detecta movimento RÁPIDO de odd Pinnacle (= sharp money entrando).
 * Diferente de stale-line:
 *   - Stale: Pinnacle moveu, outra casa NÃO → aposta na casa atrasada
 *   - Velocity: Pinnacle move >X% em <Y min → aposta no LADO QUE CAIU
 *     em qualquer book (incluindo Pinnacle) ANTES do consenso chegar lá
 *
 * Lógica:
 *   - Reusa ring buffer do stale-line-detector (pin odd history)
 *   - Calcula velocity = (odd_now / odd_5min_ago - 1) * 100
 *   - Quando |velocity| > VELOCITY_THRESHOLD_PCT em VELOCITY_WINDOW_MIN
 *     → sharp move detectado
 *   - Direção: se odd CAIU, lado virou favorito (sharp money entrou nele)
 *
 * Stale + Super + Velocity formam stack complementar:
 *   - Stale = casa não acompanhou (timing-based)
 *   - Super = casa diverge muito (state-based)
 *   - Velocity = Pinnacle se move rápido (momentum-based, mais cedo)
 *
 * Env:
 *   VELOCITY_DISABLED=true → desliga
 *   VELOCITY_THRESHOLD_PCT (default 3) — magnitude mínima do movimento
 *   VELOCITY_WINDOW_MIN (default 5)    — janela em minutos pra calcular
 */

const _lastDmAt = new Map();

function _normMatch(team1, team2) {
  return [team1, team2].map(s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')).sort().join('-');
}

/**
 * Recebe ring buffer compartilhado do stale-line e calcula velocity.
 * @param {Map} ringBuf — _ringBuf de stale-line-detector (key: sport|matchKey|side, val: [{ts, odd}])
 * @param {object} args { sport, team1, team2, side }
 * @returns evento ou null
 */
function checkVelocity(ringBuf, args) {
  if (/^(1|true|yes)$/i.test(String(process.env.VELOCITY_DISABLED || ''))) return null;
  const { sport, team1, team2, side } = args;
  const matchKey = _normMatch(team1, team2);
  const k = `${sport}|${matchKey}|${side}`;
  const buf = ringBuf.get(k);
  if (!buf || buf.length < 2) return null;

  const windowMin = parseInt(process.env.VELOCITY_WINDOW_MIN || '5', 10);
  const cutoff = Date.now() - windowMin * 60 * 1000;
  // Pega entry MAIS RECENTE depois do cutoff (=== odd há ~5min)
  const oldEntries = buf.filter(e => e.ts <= cutoff);
  if (!oldEntries.length) return null;
  const oldOdd = oldEntries[oldEntries.length - 1].odd;
  const newOdd = buf[buf.length - 1].odd;
  if (!Number.isFinite(oldOdd) || !Number.isFinite(newOdd) || oldOdd <= 1 || newOdd <= 1) return null;

  const velocityPct = (newOdd / oldOdd - 1) * 100;
  const threshold = parseFloat(process.env.VELOCITY_THRESHOLD_PCT || '3');
  if (Math.abs(velocityPct) < threshold) return null;

  return {
    sport, matchKey, matchLabel: `${team1} vs ${team2}`,
    side,
    oldOdd: +oldOdd.toFixed(3),
    newOdd: +newOdd.toFixed(3),
    velocityPct: +velocityPct.toFixed(2),
    windowMin,
    direction: velocityPct < 0 ? 'down' : 'up', // down = lado virou favorito
  };
}

function shouldDm(sport, matchKey, side, cooldownMs = 60 * 60 * 1000) {
  const k = `${sport}|${matchKey}|${side}`;
  const last = _lastDmAt.get(k) || 0;
  if (Date.now() - last < cooldownMs) return false;
  _lastDmAt.set(k, Date.now());
  return true;
}

module.exports = { checkVelocity, shouldDm };
