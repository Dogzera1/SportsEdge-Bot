'use strict';

function _num(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function _clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

/**
 * Global Risk Manager (cross-sport)
 *
 * Snapshot esperado (server `/risk-snapshot`):
 * {
 *   totalBanca: number,
 *   totalPendingReais: number,
 *   bySport: { [sport]: { currentBanca:number, pendingReais:number } }
 * }
 */
function adjustStakeUnits(sport, desiredUnits, snapshot, opts = {}) {
  const units = _num(desiredUnits);
  if (units == null || units <= 0) return { ok: false, units: 0, reason: 'invalid_units' };

  const s = String(sport || '');
  const snap = snapshot || {};
  const bySport = snap.bySport || {};
  const sportRow = bySport[s] || null;

  const totalBanca = _num(snap.totalBanca) ?? 0;
  const totalPendingReais = _num(snap.totalPendingReais) ?? 0;

  const currentBancaSport = _num(sportRow?.currentBanca) ?? 0;
  const pendingReaisSport = _num(sportRow?.pendingReais) ?? 0;

  // Defaults (conservadores)
  const minUnits = _num(opts.minUnits) ?? 0.5;
  const maxGlobalRiskPct = _num(opts.maxGlobalRiskPct) ?? 0.10; // 10% da banca total exposta em tips pendentes
  const maxSportRiskPct = _num(opts.maxSportRiskPct) ?? 0.20;   // 20% da banca do esporte exposta

  // Precisa banca para converter u -> reais (1u = 1% banca do sport)
  const unitValue = currentBancaSport > 0 ? (currentBancaSport / 100) : null;
  if (!unitValue) return { ok: true, units: units, reason: 'no_bankroll' };

  const desiredReais = units * unitValue;

  const globalCap = totalBanca > 0 ? (totalBanca * maxGlobalRiskPct) : null;
  const sportCap = currentBancaSport > 0 ? (currentBancaSport * maxSportRiskPct) : null;

  let allowedReais = desiredReais;

  if (globalCap != null) {
    const remainingGlobal = globalCap - totalPendingReais;
    allowedReais = Math.min(allowedReais, remainingGlobal);
  }
  if (sportCap != null) {
    const remainingSport = sportCap - pendingReaisSport;
    allowedReais = Math.min(allowedReais, remainingSport);
  }

  if (!Number.isFinite(allowedReais)) return { ok: true, units: units, reason: 'no_caps' };
  if (allowedReais <= 0) return { ok: false, units: 0, reason: 'risk_cap_reached' };

  const allowedUnits = _clamp(allowedReais / unitValue, 0, units);
  if (allowedUnits < minUnits) return { ok: false, units: allowedUnits, reason: 'below_min_units' };

  // arredonda para 0.5u (padrão projeto)
  const rounded = Math.floor(allowedUnits * 2) / 2;
  return { ok: true, units: rounded, reason: rounded < units ? 'reduced' : 'ok' };
}

module.exports = { adjustStakeUnits };

