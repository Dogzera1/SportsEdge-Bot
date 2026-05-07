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
let _cachedMtimeMs = 0;
let _lastCheckTs = 0;
const _CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30min: pega nightly retrain sem restart

function _load() {
  // Invalida cache periodicamente (pra picking up nightly retrain writes).
  // mtime check evita re-parse desnecessário quando arquivo não mudou.
  const now = Date.now();
  if (_cached && (now - _lastCheckTs) < _CHECK_INTERVAL_MS) return _cached;
  try {
    if (!fs.existsSync(CALIB_PATH)) { _lastCheckTs = now; return _cached; }
    const stat = fs.statSync(CALIB_PATH);
    if (_cached && stat.mtimeMs === _cachedMtimeMs) {
      _lastCheckTs = now;
      return _cached;
    }
    const raw = JSON.parse(fs.readFileSync(CALIB_PATH, 'utf8'));
    if (!raw.markets) { _lastCheckTs = now; return _cached; }
    _cached = raw;
    _cachedMtimeMs = stat.mtimeMs;
    _lastCheckTs = now;
    return _cached;
  } catch (e) {
    _lastCheckTs = now;
    return _cached; // mantém cache anterior em caso de erro transitório
  }
}

function isCalibEnabled() {
  if (/^(1|true|yes)$/i.test(String(process.env.TENNIS_MARKOV_CALIB_DISABLED || ''))) return false;
  return !!_load();
}

/**
 * Shrink universal pós-isotonic. Audit 2026-05-04 mostrou Markov tennis
 * permanecer overconfident MESMO depois da calib isotônica em pModel altos:
 *   - handicapGames pModel 80%+: gap -27.3pp (real 61.5% vs predicted 88.8%)
 *   - totalGames pModel 65-70%: gap -37.2pp (ROI -44.7%)
 *
 * Aplica linear shrink towards 0.5: pShrink = 0.5 + k * (pCalib - 0.5).
 * k=1.0 = sem shrink. k=0.5 = puxa metade da distância p/ 0.5.
 *
 * Defaults derivados pra fechar gap no audit (cap ~0.78 / ~0.63 nas faixas
 * problemáticas). Override via env:
 *   TENNIS_MARKOV_SHRINK_HANDICAPGAMES=0.85  (afrouxa shrink handicap)
 *   TENNIS_MARKOV_SHRINK_TOTALGAMES=0.55     (aperta shrink total)
 *   TENNIS_MARKOV_SHRINK_DISABLED=true       (kill switch)
 */
const SHRINK_DEFAULTS = {
  handicapGames: 0.75,
  totalGames: 0.65,
};

function _getShrinkCoef(market) {
  if (/^(1|true|yes)$/i.test(String(process.env.TENNIS_MARKOV_SHRINK_DISABLED || ''))) return 1.0;
  const envKey = `TENNIS_MARKOV_SHRINK_${String(market || '').toUpperCase()}`;
  const env = parseFloat(process.env[envKey]);
  if (Number.isFinite(env) && env > 0 && env <= 1.0) return env;
  const def = SHRINK_DEFAULTS[market];
  return Number.isFinite(def) && def > 0 ? def : 1.0;
}

function _applyShrink(p, market) {
  const k = _getShrinkCoef(market);
  if (!(k < 1.0) || !Number.isFinite(p)) return p;
  const shrunk = 0.5 + k * (p - 0.5);
  // Clamp defensivo (k em [0,1] já garante 0-1 in→0-1 out, mas guarda contra edge cases)
  if (shrunk < 0.001) return 0.001;
  if (shrunk > 0.999) return 0.999;
  return shrunk;
}

/**
 * Aplica calibração isotônica linear-interpolada por bins.
 * Retorna pRaw inalterado se mercado não tem calib ou módulo desabilitado.
 *
 * Routing prioritário:
 *   1. opts.isLive=true: tenta markets.live[market]
 *   2. opts.tier (e.g., 'main'/'challenger'/'wta125k'/'itf'):
 *        markets[market].tiers[tier] se presente (calib v2 schema)
 *   3. markets[market] default bins (legacy v1 fallback, ou fold-in v2 quando
 *      tier não tem sample suficiente)
 *
 * 2026-05-07: tier-aware. Causa-fix tennis leak — Challenger entrega 7-17pp
 * menos hit que main no mesmo bucket p_model; calib monolítica não capturava.
 * Schema v2 (tiers presente) refit'ado em scripts/fit-tennis-markov-calibration.js
 * com --min-tier-n=30 default.
 *
 * Live calib separada está ready em infra mas atualmente vazia (sample
 * insuficiente — 21 live tips total / 0 settled).
 *
 * @param {number} pRaw    P do Markov (0-1)
 * @param {string} market  'handicapGames' | 'totalGames'
 * @param {object} [opts]
 * @param {boolean} [opts.isLive]
 * @param {string}  [opts.tier]  'main'|'challenger'|'wta125k'|'itf'|null
 * @returns {number} pCalib (ou pRaw se sem calib)
 */
function applyMarkovCalib(pRaw, market, opts = {}) {
  if (!Number.isFinite(pRaw) || pRaw < 0 || pRaw > 1) return pRaw;
  // 2026-05-06 FIX: TENNIS_MARKOV_CALIB_DISABLED=true antes só pulava isotonic
  // mas continuava aplicando shrink (k=0.65 totalGames perdia 10pp silently).
  // Agora kill switch real: short-circuit completo se calib disabled. Use
  // TENNIS_MARKOV_SHRINK_DISABLED=true se quiser desligar APENAS shrink.
  if (!isCalibEnabled()) return pRaw;
  // Compute pCalib (isotonic) — se calib ausente, usa pRaw.
  // Shrink é aplicado DEPOIS, independente da calib (mas só se calib enabled),
  // pra defender contra overconfidence residual que sobreviveu à isotonic.
  const pCalib = (() => {
    const c = _load();
    if (!c) return pRaw;
    let m = null;
    // Live tem prioridade absoluta quando habilitado
    if (opts.isLive && c.markets?.live?.[market]?.bins?.length) {
      m = c.markets.live[market];
    }
    // Tier-aware (schema v2): tier-specific bins se presente
    if (!m && opts.tier && c.markets?.[market]?.tiers?.[opts.tier]?.bins?.length) {
      m = c.markets[market].tiers[opts.tier];
    }
    // Default fallback (schema v1 ou v2 sem tier match)
    if (!m) m = c.markets[market];
    if (!m || !Array.isArray(m.bins) || !m.bins.length) return pRaw;
    const bins = m.bins;
    if (pRaw <= bins[0].mid) return bins[0].pCalib;
    if (pRaw >= bins[bins.length - 1].mid) return bins[bins.length - 1].pCalib;
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
  })();
  return _applyShrink(pCalib, market);
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

module.exports = { applyMarkovCalib, isCalibEnabled, getCalibMeta, SHRINK_DEFAULTS };
