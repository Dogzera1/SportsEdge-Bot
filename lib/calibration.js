/**
 * calibration.js — Calibração isotônica de probabilidades do modelo.
 *
 * Por quê: os models (Elo, esportsPreFilter) emitem probabilidades brutas.
 * Na prática, um modelo pode dizer "70%" mas empiricamente acertar 60%
 * (overconfident) ou 78% (underconfident). Calibração ajusta a probabilidade
 * reportada para bater com o histórico real.
 *
 * Algoritmo: binning + isotonic regression (PAV — Pool Adjacent Violators).
 *   1. Agrupa tips settled por bin de probabilidade (5% de largura)
 *   2. Calcula win rate empírico por bin
 *   3. Aplica PAV para garantir monotonicidade (P maior → WR maior)
 *   4. Interpola linearmente entre bin centers
 *
 * Requer MIN_SAMPLES (padrão 30) por esporte — abaixo disso, retorna prob raw.
 * Cache TTL 1h, recarrega do DB.
 */

const MIN_SAMPLES = 30;
const BIN_WIDTH = 0.05; // bins de 5%
const CACHE_TTL = 60 * 60 * 1000;
// 2026-05-07 (audit P2): SWR (stale-while-revalidate) — quando expira, retorna
// curva antiga + agenda async reload em vez de bloquear caller. better-sqlite3 é
// sync (DB query 5-50ms blocking event loop), e múltiplos callers chegando no
// mesmo segundo pós-expiração causariam N reloads sequenciais. _refreshing flag
// dedup. Usa setImmediate pra fora do call stack atual.
const _refreshing = new Set(); // sport in-flight refreshes

let _cache = new Map(); // sport → { curve: [{ bin, empirical }], exp }

// Cutoffs para ignorar tips antes de fixes críticos.
// Tips anteriores a essas datas têm ruído (bugs corrigidos) e distorcem calibração.
const SPORT_CUTOFFS = {
  // Fix map-vs-series odds LoL: antes desse ciclo, odds podiam ser de série
  // quando o modelo previa ganhador do mapa (e vice-versa) → losses artificiais.
  esports: '2026-04-15',
  // Dota: novo sport label aplicado hoje — todos os tips anteriores estavam
  // misturados como 'esports'. Dota limpo começa agora.
  dota2: '2026-04-15',
};

function _computeCurve(db, sport) {
  const cutoff = SPORT_CUTOFFS[sport];
  const cutoffClause = cutoff ? `AND sent_at >= '${cutoff}'` : '';
  // 2026-05-06 FIX: filtrar shadow tips. Em sports shadow-only (Dota2, Val,
  // basket fase 1) curve era fitada em research-only nunca dispatched →
  // calib retornava empirical em direção à shadow distribution. Quando bot
  // promovia tips depois, model_p_pick já estava shifted pela própria
  // distribuição shadow → feedback loop. Ver project_audit_completo_2026_05_06.md.
  const rows = db.prepare(`
    SELECT model_p_pick AS p, result
    FROM tips
    WHERE sport = ?
      AND model_p_pick IS NOT NULL
      AND result IN ('win', 'loss')
      AND COALESCE(is_shadow, 0) = 0
      AND (archived IS NULL OR archived = 0)
      ${cutoffClause}
  `).all(sport);

  if (rows.length < MIN_SAMPLES) return null;

  // Bucket em bins de BIN_WIDTH
  const bins = new Map();
  for (const r of rows) {
    const p = Math.max(0, Math.min(1, Number(r.p)));
    if (!Number.isFinite(p)) continue;
    const binIdx = Math.floor(p / BIN_WIDTH);
    const center = (binIdx + 0.5) * BIN_WIDTH;
    if (!bins.has(center)) bins.set(center, { wins: 0, total: 0 });
    const b = bins.get(center);
    if (r.result === 'win') b.wins++;
    b.total++;
  }

  // Array ordenado por bin center
  const sorted = [...bins.entries()]
    .map(([bin, stat]) => ({ bin, empirical: stat.wins / stat.total, n: stat.total }))
    .sort((a, b) => a.bin - b.bin);

  // Filtra bins com sample < 3 (muito ruidoso)
  const filtered = sorted.filter(b => b.n >= 3);
  if (filtered.length < 3) return null;

  // PAV — força monotonicidade ascendente
  const pav = filtered.map(b => ({ ...b }));
  let i = 0;
  while (i < pav.length - 1) {
    if (pav[i].empirical > pav[i + 1].empirical) {
      // Merge: média ponderada pelo n
      const merged = {
        bin: (pav[i].bin * pav[i].n + pav[i + 1].bin * pav[i + 1].n) / (pav[i].n + pav[i + 1].n),
        empirical: (pav[i].empirical * pav[i].n + pav[i + 1].empirical * pav[i + 1].n) / (pav[i].n + pav[i + 1].n),
        n: pav[i].n + pav[i + 1].n,
      };
      pav.splice(i, 2, merged);
      if (i > 0) i--;
    } else {
      i++;
    }
  }

  return pav;
}

// 2026-05-07 (audit P2): SWR wrapper. Antes _loadCurve fazia DB query síncrona
// inline no caller (5-50ms blocking event loop). Múltiplos callers depois de
// expiração TTL faziam reloads sequenciais redundantes (cada um esperava seu
// turno no event loop). Agora: cache hit fresco → retorna curva imediato; cache
// hit expirado → retorna stale + agenda async refresh; cache miss → sync inline
// (boot path, single block).
function _loadCurve(db, sport) {
  const now = Date.now();
  const hit = _cache.get(sport);

  // Cache miss: sync compute (única vez no lifetime do sport)
  if (!hit) {
    const curve = _computeCurve(db, sport);
    _cache.set(sport, { curve, exp: now + CACHE_TTL });
    return curve;
  }

  // Cache hit fresco
  if (hit.exp > now) return hit.curve;

  // Cache hit expirado — return stale + schedule async refresh (SWR)
  if (!_refreshing.has(sport)) {
    _refreshing.add(sport);
    setImmediate(() => {
      try {
        const fresh = _computeCurve(db, sport);
        _cache.set(sport, { curve: fresh, exp: Date.now() + CACHE_TTL });
      } catch (_) {
        // Mantém stale entry — próxima call volta a tentar
      } finally {
        _refreshing.delete(sport);
      }
    });
  }
  return hit.curve;
}

/**
 * Aplica calibração isotônica sobre uma probabilidade raw do modelo.
 * Sem amostra suficiente → retorna probRaw unchanged.
 *
 * @param {object} db - better-sqlite3 instance
 * @param {string} sport
 * @param {number} probRaw - probabilidade 0-1 bruta
 * @returns {number} probabilidade calibrada 0-1
 */
function calibrateProbability(db, sport, probRaw) {
  const p = Math.max(0, Math.min(1, Number(probRaw)));
  if (!Number.isFinite(p)) return probRaw;
  const curve = _loadCurve(db, sport);
  if (!curve || curve.length < 2) return p;

  // Interpola linearmente entre bin centers
  if (p <= curve[0].bin) return curve[0].empirical;
  if (p >= curve[curve.length - 1].bin) return curve[curve.length - 1].empirical;

  for (let i = 0; i < curve.length - 1; i++) {
    const a = curve[i], b = curve[i + 1];
    if (p >= a.bin && p <= b.bin) {
      const t = (p - a.bin) / (b.bin - a.bin);
      return a.empirical + t * (b.empirical - a.empirical);
    }
  }
  return p;
}

/**
 * Retorna stats de calibração para debug/dashboard.
 * @returns {{ samples, curve } | null}
 */
function getCalibrationStats(db, sport) {
  const curve = _loadCurve(db, sport);
  const totalRow = db.prepare(
    `SELECT COUNT(*) c FROM tips WHERE sport = ? AND model_p_pick IS NOT NULL AND result IN ('win','loss') AND (archived IS NULL OR archived = 0)`
  ).get(sport);
  return {
    samples: totalRow?.c || 0,
    calibrated: !!curve,
    curve: curve || null,
    minSamplesRequired: MIN_SAMPLES,
  };
}

function invalidateCache(sport = null) {
  if (sport) _cache.delete(sport);
  else _cache.clear();
}

module.exports = { calibrateProbability, getCalibrationStats, invalidateCache };
