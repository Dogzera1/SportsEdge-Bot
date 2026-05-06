// EV→ROI empirical calibration (2026-05-01).
//
// Substitui HIGH_EV_THROTTLE hardcoded por curva data-driven. Lê tips settled
// (não-shadow, não-archived) per (sport, bucket EV), calcula ROI realizado e
// deriva multiplier de Kelly: ROI≥0 → mult=1.0; ROI<0 → shrink linear até floor.
//
// Buckets EV: <3, 3-5, 5-8, 8-12, >12. Igual /roi-by-ev-bucket pra alinhar
// análise. Sample mínimo n por bucket evita ruído (default 10).
//
// Cache em memória; refresh manual via refreshEvCalibration(db). Stale OK —
// fail-open retorna mult null e caller cai no throttle/1.0.
//
// Tunables (env):
//   EV_CALIB=false              — desliga (caller usa fallback)
//   EV_CALIB_DAYS=60            — janela amostra
//   EV_CALIB_MIN_N=10           — n mínimo por bucket
//   EV_CALIB_MIN_MULT=0.20      — floor multiplier
//   EV_CALIB_SLOPE=1.6          — shrink slope (ROI=-0.5 × 1.6 = -0.8 → mult=0.20)

const BUCKETS = [
  { idx: 0, label: '<3',   min: -Infinity, max: 3 },
  { idx: 1, label: '3-5',  min: 3,         max: 5 },
  { idx: 2, label: '5-8',  min: 5,         max: 8 },
  { idx: 3, label: '8-12', min: 8,         max: 12 },
  { idx: 4, label: '>12',  min: 12,        max: Infinity },
];

let _cache = {
  mtime: 0,
  bySportMarketBucket: new Map(), // 'sport|MARKET|idx' -> { mult, roi, n, stake }
  bySportBucket: new Map(),       // 'sport|idx' -> { mult, roi, n, stake }
  byBucketGlobal: new Map(),      // idx -> { mult, roi, n, stake }
  disabled: false,
};

function _evToBucketIdx(evPct) {
  if (!Number.isFinite(evPct)) return -1;
  for (const b of BUCKETS) {
    if (evPct >= b.min && evPct < b.max) return b.idx;
  }
  return BUCKETS.length - 1;
}

function _roiToMult(roi, minMult, slope) {
  if (!Number.isFinite(roi)) return 1;
  if (roi >= 0) return 1;
  // ROI -0.10 (×1.6) → mult 0.84 ; ROI -0.32 → 0.488 ; ROI -0.5 → 0.20 (floor)
  return Math.max(minMult, 1 + roi * slope);
}

function refreshEvCalibration(db) {
  if (/^(0|false|no)$/i.test(String(process.env.EV_CALIB ?? ''))) {
    _cache = { mtime: Date.now(), bySportMarketBucket: new Map(), bySportBucket: new Map(), byBucketGlobal: new Map(), disabled: true };
    return _cache;
  }
  if (!db || typeof db.prepare !== 'function') return _cache;
  const days = Math.max(14, parseInt(process.env.EV_CALIB_DAYS || '60', 10));
  const minN = Math.max(5, parseInt(process.env.EV_CALIB_MIN_N || '10', 10));
  const minMult = Math.max(0.05, parseFloat(process.env.EV_CALIB_MIN_MULT || '0.20'));
  const slope = Math.max(0.5, parseFloat(process.env.EV_CALIB_SLOPE || '1.6'));
  // 2026-05-06: per-market bucket precisa n maior (sample dilui ao split por market).
  // Default min_n_market=20. Cascade fallback: market → sport → global.
  const minNMarket = Math.max(minN, parseInt(process.env.EV_CALIB_MIN_N_MARKET || '20', 10));

  // 2026-05-03 FIX: filtro is_shadow=0 excluía sports em modo shadow-only (Dota2,
  // Val, Snooker etc) → bucket calibration nunca ganhava amostra. Agora include
  // shadow tips por default (são tips reais settled, só sem dispatch DM). Opt-out
  // via EV_CALIB_REAL_ONLY=true.
  const realOnly = /^(1|true|yes)$/i.test(String(process.env.EV_CALIB_REAL_ONLY || ''));
  const shadowFilter = realOnly ? "AND COALESCE(is_shadow, 0) = 0" : '';
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT sport,
        UPPER(COALESCE(market_type, 'ML')) AS market,
        CAST(REPLACE(REPLACE(ev, '+', ''), '%', '') AS REAL) AS ev_num,
        result,
        COALESCE(stake_reais, 0) AS stake,
        COALESCE(profit_reais, 0) AS profit
      FROM tips
      WHERE ev IS NOT NULL
        AND result IN ('win','loss')
        ${shadowFilter}
        AND COALESCE(archived, 0) = 0
        AND sent_at >= datetime('now', '-' || ? || ' days')
    `).all(days);
  } catch (e) {
    return _cache; // fail-open: keep old
  }

  const aggSportMarket = new Map(); // 'sp|MK|idx'
  const aggSport = new Map();        // 'sp|idx'
  const aggGlobal = new Map();       // 'idx'
  for (const r of rows) {
    if (!Number.isFinite(r.ev_num) || r.stake <= 0) continue;
    const sp = String(r.sport || '').toLowerCase();
    const mk = String(r.market || 'ML').toUpperCase();
    const idx = _evToBucketIdx(r.ev_num);
    if (idx < 0) continue;
    if (sp) {
      const km = `${sp}|${mk}|${idx}`;
      const curM = aggSportMarket.get(km) || { n: 0, stake: 0, profit: 0 };
      curM.n++; curM.stake += r.stake; curM.profit += r.profit;
      aggSportMarket.set(km, curM);
      const ks = `${sp}|${idx}`;
      const curS = aggSport.get(ks) || { n: 0, stake: 0, profit: 0 };
      curS.n++; curS.stake += r.stake; curS.profit += r.profit;
      aggSport.set(ks, curS);
    }
    const cg = aggGlobal.get(idx) || { n: 0, stake: 0, profit: 0 };
    cg.n++; cg.stake += r.stake; cg.profit += r.profit;
    aggGlobal.set(idx, cg);
  }

  const bySportMarket = new Map();
  for (const [k, v] of aggSportMarket) {
    if (v.n < minNMarket || v.stake <= 0) continue;
    const roi = v.profit / v.stake;
    bySportMarket.set(k, { mult: _roiToMult(roi, minMult, slope), roi, n: v.n, stake: v.stake });
  }
  const bySport = new Map();
  for (const [k, v] of aggSport) {
    if (v.n < minN || v.stake <= 0) continue;
    const roi = v.profit / v.stake;
    bySport.set(k, { mult: _roiToMult(roi, minMult, slope), roi, n: v.n, stake: v.stake });
  }
  const byGlobal = new Map();
  for (const [idx, v] of aggGlobal) {
    if (v.n < minN || v.stake <= 0) continue;
    const roi = v.profit / v.stake;
    byGlobal.set(idx, { mult: _roiToMult(roi, minMult, slope), roi, n: v.n, stake: v.stake });
  }

  _cache = { mtime: Date.now(), bySportMarketBucket: bySportMarket, bySportBucket: bySport, byBucketGlobal: byGlobal, disabled: false };
  return _cache;
}

// Returns mult [minMult, 1] or null se não tem amostra suficiente.
// Caller deve fallback pra throttle/1.0 quando null.
// 2026-05-06: cascade lookup market → sport → global. Quando market informado
// e bucket (sport, market) tem n suficiente, prefere essa calibração mais fina.
// Fallback: sport-wide bucket → global bucket.
function getEvCalibrationMult(sport, evPct, market = null) {
  if (_cache.disabled) return null;
  if (!Number.isFinite(evPct)) return null;
  const idx = _evToBucketIdx(evPct);
  if (idx < 0) return null;
  const sp = String(sport || '').toLowerCase();
  const mk = market ? String(market).toUpperCase() : null;
  if (sp && mk) {
    const hitM = _cache.bySportMarketBucket.get(`${sp}|${mk}|${idx}`);
    if (hitM) return hitM.mult;
  }
  if (sp) {
    const hit = _cache.bySportBucket.get(`${sp}|${idx}`);
    if (hit) return hit.mult;
  }
  const g = _cache.byBucketGlobal.get(idx);
  if (g) return g.mult;
  return null;
}

function getEvCalibrationSnapshot() {
  const sportMarket = [];
  for (const [k, v] of _cache.bySportMarketBucket || []) {
    const [sp, mk, idx] = k.split('|');
    sportMarket.push({
      sport: sp, market: mk, bucket: BUCKETS[Number(idx)].label,
      mult: +v.mult.toFixed(3), roi_pct: +(v.roi * 100).toFixed(1),
      n: v.n, stake: +v.stake.toFixed(2),
    });
  }
  const sport = [];
  for (const [k, v] of _cache.bySportBucket) {
    const [sp, idx] = k.split('|');
    sport.push({
      sport: sp, bucket: BUCKETS[Number(idx)].label,
      mult: +v.mult.toFixed(3), roi_pct: +(v.roi * 100).toFixed(1),
      n: v.n, stake: +v.stake.toFixed(2),
    });
  }
  const global = [];
  for (const [idx, v] of _cache.byBucketGlobal) {
    global.push({
      bucket: BUCKETS[idx].label,
      mult: +v.mult.toFixed(3), roi_pct: +(v.roi * 100).toFixed(1),
      n: v.n, stake: +v.stake.toFixed(2),
    });
  }
  return {
    mtime: _cache.mtime,
    age_min: _cache.mtime ? Math.round((Date.now() - _cache.mtime) / 60000) : null,
    disabled: !!_cache.disabled,
    by_sport_market: sportMarket.sort((a, b) => a.sport.localeCompare(b.sport) || a.market.localeCompare(b.market) || a.bucket.localeCompare(b.bucket)),
    by_sport: sport.sort((a, b) => a.sport.localeCompare(b.sport) || a.bucket.localeCompare(b.bucket)),
    global: global.sort((a, b) => a.bucket.localeCompare(b.bucket)),
  };
}

module.exports = {
  refreshEvCalibration,
  getEvCalibrationMult,
  getEvCalibrationSnapshot,
  _BUCKETS: BUCKETS,
};
