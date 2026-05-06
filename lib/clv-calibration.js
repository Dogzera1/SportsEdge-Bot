'use strict';

/**
 * CLV calibration layer — apply pós-isotonic.
 *
 * Stack:
 *   p_raw  → isotonic (W/L target)  → p_iso
 *   p_iso  → clv_calib (CLV target) → p_final
 *
 * Lê lib/{sport}-clv-calibration.json gerado por scripts/fit-clv-calibration.js.
 * Sem arquivo / arquivo stale → retorna p_iso inalterado (no-op safe).
 *
 * Uso:
 *   const { applyClvCalib } = require('./clv-calibration');
 *   const pFinal = applyClvCalib('lol', pIsoCalibrated);
 *
 * Opt-out global: CLV_CALIB_DISABLED=true
 * Override blend per-sport: CLV_BLEND_WEIGHT_LOL=0.4 etc
 */

const fs = require('fs');
const path = require('path');

const _cache = new Map(); // sport → { data, loadedAt, mtime }
const TTL_MS = 30 * 60 * 1000;
const STALE_DAYS_MAX = 60;

function _loadCalib(sport) {
  const cached = _cache.get(sport);
  // 2026-05-06: TTL gate ANTES de statSync — caller hot path (4 sports × 50 events
  // = 200 syscalls/ciclo só pra checar mtime). Padrão correto está em
  // tennis-markov-calib.js. Stat só na primeira call ou após TTL.
  if (cached && (Date.now() - cached.loadedAt) < TTL_MS) {
    return cached.data;
  }
  const filePath = path.resolve(__dirname, `${sport}-clv-calibration.json`);
  let mtime = 0;
  try { mtime = fs.statSync(filePath).mtimeMs; } catch { return null; }
  if (cached && cached.mtime === mtime) {
    cached.loadedAt = Date.now();
    return cached.data;
  }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    // Sanity: arquivo precisa ter blocks + fittedAt
    if (!data?.blocks?.length || !data.fittedAt) return null;
    // Stale check: arquivo >60d → não confia
    const ageDays = (Date.now() - new Date(data.fittedAt).getTime()) / 86400000;
    if (ageDays > STALE_DAYS_MAX) return null;
    _cache.set(sport, { data, loadedAt: Date.now(), mtime });
    return data;
  } catch { return null; }
}

/**
 * Aplica blend CLV-target sobre p_iso (prob já calibrada por isotonic W/L).
 * @param {string} sport
 * @param {number} pIso — prob calibrada do isotonic, [0, 1]
 * @param {object} [opts]
 * @param {number} [opts.blendWeight] — override default do calib file
 * @returns {number} pFinal — clamped [0.01, 0.99]
 */
function applyClvCalib(sport, pIso, opts = {}) {
  if (!Number.isFinite(pIso) || pIso <= 0 || pIso >= 1) return pIso;
  if (/^(1|true|yes)$/i.test(String(process.env.CLV_CALIB_DISABLED || ''))) return pIso;

  const data = _loadCalib(sport);
  if (!data?.blocks?.length) return pIso;

  // Per-sport blend override via env (ex: CLV_BLEND_WEIGHT_LOL=0.40)
  const envKey = `CLV_BLEND_WEIGHT_${sport.toUpperCase()}`;
  const envBlend = parseFloat(process.env[envKey] || '');
  const globalBlend = parseFloat(process.env.CLV_BLEND_WEIGHT || '');
  const blendW = Number.isFinite(opts.blendWeight) ? opts.blendWeight
    : Number.isFinite(envBlend) ? envBlend
    : Number.isFinite(globalBlend) ? globalBlend
    : (data.blend_weight_default ?? 0.30);

  // Find target via interpolation entre blocks
  const blocks = data.blocks;
  let target;
  if (pIso <= blocks[0].pMax) {
    target = blocks[0].clvMean;
  } else if (pIso >= blocks[blocks.length - 1].pMin) {
    target = blocks[blocks.length - 1].clvMean;
  } else {
    target = pIso; // fallback
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (pIso >= b.pMin && pIso <= b.pMax) { target = b.clvMean; break; }
      if (i + 1 < blocks.length) {
        const n = blocks[i + 1];
        if (pIso > b.pMax && pIso < n.pMin) {
          const t = (pIso - b.pMax) / (n.pMin - b.pMax);
          target = b.clvMean + t * (n.clvMean - b.clvMean);
          break;
        }
      }
    }
  }
  const pFinal = Math.max(0.01, Math.min(0.99, blendW * target + (1 - blendW) * pIso));
  return pFinal;
}

/**
 * Diagnóstico — retorna info do calib carregado pro sport.
 * Útil em /agents/model-calibration ou /health/metrics.
 */
function getCalibInfo(sport) {
  const data = _loadCalib(sport);
  if (!data) return null;
  return {
    sport,
    fittedAt: data.fittedAt,
    nBlocks: data.blocks.length,
    nSamples: data.nSamples,
    blendWeight: data.blend_weight_default,
    metrics: data.metrics,
  };
}

function clearCache() { _cache.clear(); }

module.exports = { applyClvCalib, getCalibInfo, clearCache };
