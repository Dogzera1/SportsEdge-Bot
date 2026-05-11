'use strict';

/**
 * hour-gate.js — bloqueia tip emit em horas BRT "dead zone" por sport.
 *
 * 2026-05-11 (audit lucratividade): /admin/time-of-day-analysis revelou
 * patterns claros:
 *   Tennis: 8h-10h BRT ROI -50%, 13h BRT ROI -7%, 17h BRT ROI +39%
 *   LoL: 15h ROI -63%, 20h ROI +32% hit 75%
 *
 * Wire gate é OPT-IN via env. Default OFF (preserva back-compat).
 *
 * Env:
 *   <SPORT>_HOURS_BLOCKED=8,10,13     — CSV horas BRT bloqueadas pra sport
 *   <SPORT>_HOURS_ALLOWED=15,16,17    — alternativa: lista whitelist (raro)
 *   TZ_OFFSET_HOURS=-3                — default BRT (sobrescreve)
 *
 * P2-compliant: usa stats real (audit endpoint) pra justificar bloqueio.
 * Não bloqueia shadow (research universe).
 */

function _getLocalHour(tzOffsetHours = -3) {
  const utcMs = Date.now();
  const localMs = utcMs + tzOffsetHours * 3600 * 1000;
  return new Date(localMs).getUTCHours();
}

function _parseHourList(raw) {
  if (!raw) return null;
  const parts = String(raw).split(',').map(s => s.trim()).filter(Boolean);
  const hours = [];
  for (const p of parts) {
    const n = parseInt(p, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 23) hours.push(n);
  }
  return hours.length ? new Set(hours) : null;
}

/**
 * Retorna { blocked: bool, reason: string, hour: number } pra sport+hora atual.
 * Quando blocked=true, caller deve skip emit (não emit shadow nem real).
 *
 * @param {string} sport — 'tennis', 'lol', 'cs', 'football', etc.
 * @returns {{ blocked: boolean, reason: string|null, hour: number }}
 */
function checkHourGate(sport) {
  const tzOffset = parseFloat(process.env.TZ_OFFSET_HOURS || '-3');
  const hour = _getLocalHour(tzOffset);
  const sp = String(sport || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  // Blocklist tem precedência sobre allowlist (se ambas setadas).
  const blockedSet = _parseHourList(process.env[`${sp}_HOURS_BLOCKED`]);
  if (blockedSet && blockedSet.has(hour)) {
    return {
      blocked: true,
      reason: `hour ${hour}h BRT in ${sp}_HOURS_BLOCKED`,
      hour,
    };
  }
  const allowedSet = _parseHourList(process.env[`${sp}_HOURS_ALLOWED`]);
  if (allowedSet && !allowedSet.has(hour)) {
    return {
      blocked: true,
      reason: `hour ${hour}h BRT not in ${sp}_HOURS_ALLOWED`,
      hour,
    };
  }
  return { blocked: false, reason: null, hour };
}

module.exports = { checkHourGate, _getLocalHour, _parseHourList };
