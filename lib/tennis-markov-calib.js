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
let _watcher = null;
const _CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30min: pega nightly retrain sem restart

// 2026-05-10 P1 brain audit: fs.watch invalida cache imediatamente quando JSON
// muda em disco (refit deploy, /admin/mt-refit-calib write). Antes TTL 30min
// causava window de 5-30min servindo old calib pós-refit.
function _setupWatcher() {
  if (_watcher) return;
  try {
    if (!fs.existsSync(CALIB_PATH)) return;
    _watcher = fs.watch(CALIB_PATH, { persistent: false }, () => {
      _cached = null;
      _cachedMtimeMs = 0;
      _lastCheckTs = 0;
    });
    _watcher.unref?.();
  } catch (_) { /* fail-open: TTL ainda funciona */ }
}

function _invalidate() {
  _cached = null;
  _cachedMtimeMs = 0;
  _lastCheckTs = 0;
}

function _load() {
  _setupWatcher();
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
 * Routing prioritário (mais específico → mais genérico):
 *   1. opts.isLive=true: tenta markets.live[market]
 *   2. opts.tier + opts.format + opts.side: tiers[tier].formats[format].sides[side] (v3)
 *   3. opts.tier + opts.format: tiers[tier].formats[format] (v3)
 *   4. opts.tier + opts.side: markets[market].tiers[tier].sides[side] (v2.1)
 *   5. opts.tier: markets[market].tiers[tier] (v2)
 *   6. opts.side: markets[market].sides[side] (v2.1 fallback sem tier match)
 *   7. markets[market] default bins (v1 fallback)
 *
 * 2026-05-07: tier-aware (schema v2). Causa-fix Challenger leak.
 * 2026-05-11: side-aware (schema v2.1). Causa-fix tennis HG home leak — HOME
 *             buckets EV 15-30% ROI -44 a -63% calib_gap +70-94pp consistente
 *             em n=124 settled. HOME/AWAY tem dinâmicas diferentes (serve adv,
 *             court familiarity); fit monolítico vaza nos lados extremos.
 * 2026-05-25: format-aware (schema v3). Causa-fix Bo5 Grand Slam ATP R1 leak —
 *             ATP main calib v2 mistura Bo3 (Masters/500/250) com Bo5 (Slams),
 *             Bo3 domina sample → Slam Bo5 R1 calib_gap -30.8pp consistente.
 *             Tier+format split: tiers[atp_main].formats[bo5] cobre Slam main draw.
 *             Kill switch: TENNIS_CALIB_FORMAT_DISABLED=true (skipa lookup format,
 *             cai pra tier-only — comportamento v2.1 legacy).
 *
 * Live calib separada está ready em infra mas atualmente vazia (sample
 * insuficiente — 21 live tips total / 0 settled).
 *
 * @param {number} pRaw    P do Markov (0-1)
 * @param {string} market  'handicapGames' | 'totalGames'
 * @param {object} [opts]
 * @param {boolean} [opts.isLive]
 * @param {string}  [opts.tier]   'atp_main'|'wta_main'|'atp_challenger'|'wta125k'|'itf'|null
 * @param {string}  [opts.format] 'bo3'|'bo5'|null — derivado de bestOf no scanner
 * @param {string}  [opts.side]   'home'|'away'|'over'|'under'|null
 * @returns {number} pCalib (ou pRaw se sem calib)
 */
function applyMarkovCalib(pRaw, market, opts = {}) {
  if (!Number.isFinite(pRaw) || pRaw < 0 || pRaw > 1) return pRaw;
  // 2026-05-06 FIX: TENNIS_MARKOV_CALIB_DISABLED=true antes só pulava isotonic
  // mas continuava aplicando shrink (k=0.65 totalGames perdia 10pp silently).
  // Agora kill switch real: short-circuit completo se calib disabled. Use
  // TENNIS_MARKOV_SHRINK_DISABLED=true se quiser desligar APENAS shrink.
  if (!isCalibEnabled()) return pRaw;
  const fmtDisabled = /^(1|true|yes)$/i.test(String(process.env.TENNIS_CALIB_FORMAT_DISABLED || ''));
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
    // Schema v3: tier+format+side (mais específico — Bo5 Slam ATP home, etc)
    if (!m && !fmtDisabled && opts.tier && opts.format && opts.side
        && c.markets?.[market]?.tiers?.[opts.tier]?.formats?.[opts.format]?.sides?.[opts.side]?.bins?.length) {
      m = c.markets[market].tiers[opts.tier].formats[opts.format].sides[opts.side];
    }
    // Schema v3: tier+format (sem side)
    if (!m && !fmtDisabled && opts.tier && opts.format
        && c.markets?.[market]?.tiers?.[opts.tier]?.formats?.[opts.format]?.bins?.length) {
      m = c.markets[market].tiers[opts.tier].formats[opts.format];
    }
    // Schema v2.1: tier+side bins se presente
    if (!m && opts.tier && opts.side
        && c.markets?.[market]?.tiers?.[opts.tier]?.sides?.[opts.side]?.bins?.length) {
      m = c.markets[market].tiers[opts.tier].sides[opts.side];
    }
    // Schema v2: tier bins (sem side)
    if (!m && opts.tier && c.markets?.[market]?.tiers?.[opts.tier]?.bins?.length) {
      m = c.markets[market].tiers[opts.tier];
    }
    // Schema v2.1 fallback: side bins (sem tier match)
    if (!m && opts.side && c.markets?.[market]?.sides?.[opts.side]?.bins?.length) {
      m = c.markets[market].sides[opts.side];
    }
    // Default fallback (schema v1)
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
    markets: Object.fromEntries(Object.entries(c.markets).map(([k, v]) => [k, {
      nBins: v.bins?.length || 0,
      nTotal: v.nTotal,
      sides: v.sides ? Object.fromEntries(Object.entries(v.sides).map(([s, vs]) => [s, { nBins: vs.bins?.length || 0, nTotal: vs.nTotal }])) : undefined,
      tiers: v.tiers ? Object.fromEntries(Object.entries(v.tiers).map(([t, vt]) => [t, {
        nBins: vt.bins?.length || 0,
        nTotal: vt.nTotal,
        sides: vt.sides ? Object.fromEntries(Object.entries(vt.sides).map(([s, vts]) => [s, { nBins: vts.bins?.length || 0, nTotal: vts.nTotal }])) : undefined,
        formats: vt.formats ? Object.fromEntries(Object.entries(vt.formats).map(([f, vtf]) => [f, {
          nBins: vtf.bins?.length || 0,
          nTotal: vtf.nTotal,
          sides: vtf.sides ? Object.fromEntries(Object.entries(vtf.sides).map(([s, vtfs]) => [s, { nBins: vtfs.bins?.length || 0, nTotal: vtfs.nTotal }])) : undefined,
        }])) : undefined,
      }])) : undefined,
    }])),
  };
}

module.exports = { applyMarkovCalib, isCalibEnabled, getCalibMeta, SHRINK_DEFAULTS, _invalidate };
