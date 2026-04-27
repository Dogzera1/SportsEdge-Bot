'use strict';

/**
 * tennis-markov-calib.js — aplica calibração isotonic (PAV + Beta smoothing)
 * sobre P do Markov pre-jogo em mercados handicapGames e totalGames.
 *
 * Ajustado contra outcome real de market_tips_shadow tennis settled
 * (script: scripts/fit-tennis-markov-calibration.js). Resolve overconfidence
 * sistemática do Markov pre-jogo (serve probability estática + pontos
 * independentes) que produzia P_med 0.78 em handicapGames com hit real <70%.
 *
 * Disable via TENNIS_MARKOV_CALIB_DISABLED=true.
 */

const fs = require('fs');
const path = require('path');

const CALIB_PATH = process.env.TENNIS_MARKOV_CALIB_PATH
  || path.join(__dirname, 'tennis-markov-calib.json');

let _cached = null;
let _loadFailed = false;

function _load() {
  if (_cached || _loadFailed) return _cached;
  try {
    if (!fs.existsSync(CALIB_PATH)) { _loadFailed = true; return null; }
    const raw = JSON.parse(fs.readFileSync(CALIB_PATH, 'utf8'));
    if (!raw.markets) { _loadFailed = true; return null; }
    _cached = raw;
    return _cached;
  } catch (e) {
    _loadFailed = true;
    return null;
  }
}

function isCalibEnabled() {
  if (/^(1|true|yes)$/i.test(String(process.env.TENNIS_MARKOV_CALIB_DISABLED || ''))) return false;
  return !!_load();
}

/**
 * Aplica calibração isotônica linear-interpolada por bins.
 * Retorna pRaw inalterado se mercado não tem calib ou módulo desabilitado.
 *
 * @param {number} pRaw   P do Markov (0-1)
 * @param {string} market 'handicapGames' | 'totalGames'
 * @returns {number} pCalib (ou pRaw se sem calib)
 */
function applyMarkovCalib(pRaw, market) {
  if (!Number.isFinite(pRaw) || pRaw < 0 || pRaw > 1) return pRaw;
  if (!isCalibEnabled()) return pRaw;
  const c = _load();
  if (!c) return pRaw;
  const m = c.markets[market];
  if (!m || !Array.isArray(m.bins) || !m.bins.length) return pRaw;
  const bins = m.bins;
  // Clamp para o pCalib do bin extremo (standard isotonic behavior).
  if (pRaw <= bins[0].mid) return bins[0].pCalib;
  if (pRaw >= bins[bins.length - 1].mid) return bins[bins.length - 1].pCalib;
  // Linear interp entre mids consecutivos
  for (let i = 0; i < bins.length - 1; i++) {
    const a = bins[i], b = bins[i + 1];
    if (pRaw >= a.mid && pRaw <= b.mid) {
      const span = b.mid - a.mid;
      if (span <= 0) return a.pCalib;
      const t = (pRaw - a.mid) / span;
      return a.pCalib + t * (b.pCalib - a.pCalib);
    }
  }
  return pRaw;
}

function getCalibMeta() {
  const c = _load();
  if (!c) return null;
  return {
    fittedAt: c.fittedAt,
    nSamples: c.nSamples,
    markets: Object.fromEntries(Object.entries(c.markets).map(([k, v]) => [k, { nBins: v.bins.length, nTotal: v.nTotal }])),
  };
}

module.exports = { applyMarkovCalib, isCalibEnabled, getCalibMeta };
