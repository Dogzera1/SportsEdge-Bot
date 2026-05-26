'use strict';

// AI real-emit guards (P0 fix 2026-05-26).
// Bug histórico: Tennis Ben Shelton EV=468% emitido como real (2026-05-22 audit).
// Cap defensivo foi adicionado em _runAiShadow (bot.js:10611) via commit 1a45897,
// mas os 6 paths main /claude (LoL 11753, Dota 17651, MMA 18724, Tennis 20406,
// Football 21768, CS 23358) ficaram sem proteção — justamente onde o volume real
// é maior. P5 cross-sport closure.
//
// Hierarquia env: <SPORT>_AI_REAL_MAX_EV > AI_REAL_MAX_EV > default
// Default: 40% (lol/cs/dota/val/football/tennis), 50% (mma — variance maior).
// Set 0 ou negativo desativa o cap (debug only).

function aiRealMaxEvCheck(sport, tipEvNum) {
  if (!Number.isFinite(tipEvNum)) return { ok: true, cap: null, reason: null };
  const sportU = String(sport || '').toUpperCase();
  const _evCapDefault = sport === 'mma' ? 50 : 40;
  const _evCap = parseFloat(
    process.env[`${sportU}_AI_REAL_MAX_EV`]
    ?? process.env.AI_REAL_MAX_EV
    ?? String(_evCapDefault)
  );
  if (!Number.isFinite(_evCap) || _evCap <= 0) {
    return { ok: true, cap: null, reason: null };
  }
  if (tipEvNum > _evCap) {
    return {
      ok: false,
      cap: _evCap,
      reason: `EV=${tipEvNum.toFixed(1)}% > cap=${_evCap}% (${sportU}_AI_REAL_MAX_EV ou AI_REAL_MAX_EV)`
    };
  }
  return { ok: true, cap: _evCap, reason: null };
}

module.exports = { aiRealMaxEvCheck };
