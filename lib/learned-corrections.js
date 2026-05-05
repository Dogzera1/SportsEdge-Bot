'use strict';

/**
 * learned-corrections.js
 *
 * Aplicações da CALIBRAÇÃO do modelo derivadas do readiness-learner.
 * Filosofia: ataca a CAUSA (modelo overconfident, EV inflado) — não o
 * sintoma (kelly cut, disable). Aplicado em /record-tip antes do gate de EV.
 *
 * Tipos:
 *   prob_shrink  — `p_adj = (p - 0.5) * factor + 0.5`. Encolhe probabilidade
 *                  em direção a 0.5 quando modelo overconfident. factor=1.0
 *                  identity, factor=0.7 encolhe 30%, factor=0.0 → 0.5 (kill).
 *
 *   ev_shrink    — `ev_adj = ev * factor`. Reduz EV % quando o modelo
 *                  superestima edge vs realizado. factor=0.7 corta 30%.
 *
 * Persistência: tabela `learned_corrections` (mig 090). Cache em memória
 * com refresh on-demand (loadFromDb chamado em boot + após learner aplica).
 *
 * Lookup: getActive(sport, market, league) — busca em ordem de especificidade:
 *   1. (sport, market, league_pattern matching league)
 *   2. (sport, market, league_pattern=NULL)
 *   3. (sport, market=NULL, league_pattern matching league)
 *   4. (sport, market=NULL, league_pattern=NULL)
 * Primeiro match vence.
 */

const _cache = {
  byKey: new Map(),  // 'sport|market|league_pattern|type' → row
  bySport: new Map(),// sport → array of rows (pra busca por especificidade)
  loadedAt: 0,
};

function _normSport(s) { return String(s || '').toLowerCase().trim(); }
function _normMarket(m) { return m ? String(m).toUpperCase() : null; }
function _normLeague(l) { return l ? String(l).toLowerCase() : ''; }

function loadFromDb(db) {
  if (!db) return { n: 0 };
  _cache.byKey.clear();
  _cache.bySport.clear();
  try {
    const rows = db.prepare(`
      SELECT * FROM learned_corrections WHERE status = 'active'
      ORDER BY
        CASE WHEN league_pattern IS NOT NULL THEN 0 ELSE 1 END,
        CASE WHEN market IS NOT NULL THEN 0 ELSE 1 END
    `).all();
    for (const r of rows) {
      const sport = _normSport(r.sport);
      const market = _normMarket(r.market);
      const lp = r.league_pattern || null;
      const k = `${sport}|${market || ''}|${lp || ''}|${r.correction_type}`;
      // 2026-05-05: parse evidence pra extrair factor_by_bucket (per-pmodel
      // shrinkage). Inject como _factor_by_bucket pra acesso rápido em
      // applyToProbWithBuckets sem reparse a cada tip.
      try {
        if (r.evidence) {
          const ev = JSON.parse(r.evidence);
          if (ev && ev.factor_by_bucket && typeof ev.factor_by_bucket === 'object') {
            r._factor_by_bucket = ev.factor_by_bucket;
          }
        }
      } catch (_) { /* evidence pode estar malformed — ignore */ }
      _cache.byKey.set(k, r);
      if (!_cache.bySport.has(sport)) _cache.bySport.set(sport, []);
      _cache.bySport.get(sport).push(r);
    }
    _cache.loadedAt = Date.now();
    return { n: rows.length };
  } catch (e) {
    return { n: 0, error: e.message };
  }
}

/**
 * Retorna correções ativas pra (sport, market, league) — pode haver até 2
 * (uma de cada tipo). Ordem de especificidade: league_pattern match → market
 * match → wildcard. Primeiro match por tipo vence.
 */
function getActive(sport, market, league) {
  const sp = _normSport(sport);
  const mk = _normMarket(market);
  const lg = _normLeague(league);
  const candidates = _cache.bySport.get(sp) || [];
  const found = {};
  for (const r of candidates) {
    if (found[r.correction_type]) continue; // já achou mais específico
    const rMk = _normMarket(r.market);
    const rLp = r.league_pattern ? String(r.league_pattern).toLowerCase() : null;
    // Market filter: se row tem market, deve bater; se NULL, aplica a todos
    if (rMk && rMk !== mk) continue;
    // League filter: se row tem league_pattern, league da tip deve conter pattern
    if (rLp && !lg.includes(rLp)) continue;
    found[r.correction_type] = r;
  }
  return found;
}

/**
 * Aplica correção ao p (probabilidade). Returns adjusted p.
 * `factor`: 1.0 = identity, 0.7 = encolhe 30% em direção a 0.5,
 *           1.3 = AMPLIFICA 30% pra fora de 0.5 (positive learning),
 *           0.0 = força 0.5 (kill).
 * Clamp [0.001, 0.999] pra evitar p inválido em amplify alto.
 */
function applyToProb(p, factor) {
  if (!Number.isFinite(p) || !Number.isFinite(factor)) return p;
  const adj = (p - 0.5) * factor + 0.5;
  return Math.max(0.001, Math.min(0.999, adj));
}

// 2026-05-05 — buckets de pmodel pra shrinkage condicional.
// Modelo pode ter bias asymmetric (overconfident só em favoritos com p>0.7).
// Aplicar shrinkage uniforme encolhe demais p≈0.55 (que estava OK).
// 4 buckets cobrem o range típico de tip; cada um ganha factor independente.
const PMODEL_BUCKETS = [
  { key: 'lt55',   min: 0.0,   max: 0.55 },
  { key: '55_65',  min: 0.55,  max: 0.65 },
  { key: '65_75',  min: 0.65,  max: 0.75 },
  { key: 'gte75',  min: 0.75,  max: 1.0 },
];

function pToBucket(p) {
  if (!Number.isFinite(p)) return null;
  for (const b of PMODEL_BUCKETS) {
    if (p >= b.min && p < b.max) return b.key;
  }
  return PMODEL_BUCKETS[PMODEL_BUCKETS.length - 1].key;
}

/**
 * Aplica prob shrinkage com lookup de factor per pmodel bucket. Se houver
 * `factor_by_bucket` no evidence (JSON com {lt55: 0.95, '55_65': 0.85, ...}),
 * usa factor específico do bucket de p; senão usa factor global.
 */
function applyToProbWithBuckets(p, correction) {
  if (!correction || !Number.isFinite(p)) return p;
  const factorsByBucket = correction._factor_by_bucket; // injected pelo getActive
  if (factorsByBucket) {
    const b = pToBucket(p);
    const f = factorsByBucket[b];
    if (Number.isFinite(f)) return applyToProb(p, f);
  }
  return applyToProb(p, Number(correction.factor));
}

function applyToEv(evPct, factor) {
  if (!Number.isFinite(evPct) || !Number.isFinite(factor)) return evPct;
  return evPct * factor;
}

/**
 * High-level helper: aplica correções ativas ao tip e retorna ajustes.
 * Não persiste — apenas computa. Caller decide o que fazer com o resultado.
 *
 * @param {object} tip — { sport, market, league, p, ev, odds }
 * @returns {{ p, ev, applied: Array<{type, factor, id}>, original: {p,ev} }}
 */
function applyToTip({ sport, market, league, p, ev, odds }) {
  const corrections = getActive(sport, market, league);
  const result = {
    p: Number(p),
    ev: Number(ev),
    original: { p: Number(p), ev: Number(ev) },
    applied: [],
  };
  if (corrections.prob_shrink) {
    // Per-bucket shrinkage se factor_by_bucket existe; senão global factor.
    const corr = corrections.prob_shrink;
    const adjP = applyToProbWithBuckets(result.p, corr);
    const usedBucket = corr._factor_by_bucket ? pToBucket(result.p) : null;
    const fUsed = corr._factor_by_bucket
      ? (corr._factor_by_bucket[usedBucket] ?? Number(corr.factor))
      : Number(corr.factor);
    result.p = adjP;
    if (Number.isFinite(odds) && odds > 1) {
      result.ev = (result.p * odds - 1) * 100;
    }
    result.applied.push({
      type: 'prob_shrink', factor: fUsed, id: corr.id,
      bucket: usedBucket, // null se factor global
    });
  }
  if (corrections.ev_shrink) {
    const f = Number(corrections.ev_shrink.factor);
    result.ev = applyToEv(result.ev, f);
    result.applied.push({ type: 'ev_shrink', factor: f, id: corrections.ev_shrink.id });
  }
  return result;
}

function setAuto(db, opts = {}) {
  if (!db) return null;
  const { sport, market, league_pattern, correction_type, factor, evidence, expiresInDays } = opts;
  if (!sport || !correction_type || !Number.isFinite(factor)) return null;
  const nowIso = new Date().toISOString();
  const expIso = expiresInDays
    ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
    : null;
  try {
    // Marca correções existentes do mesmo (sport, market, league_pattern, type) como superseded
    db.prepare(`
      UPDATE learned_corrections
         SET status = 'superseded'
       WHERE sport = ?
         AND COALESCE(market, '') = COALESCE(?, '')
         AND COALESCE(league_pattern, '') = COALESCE(?, '')
         AND correction_type = ?
         AND status = 'active'
    `).run(_normSport(sport), _normMarket(market) || null, league_pattern || null, correction_type);
    const r = db.prepare(`
      INSERT INTO learned_corrections
        (sport, market, league_pattern, correction_type, factor, source,
         applied_at, expires_at, status, evidence)
      VALUES (?, ?, ?, ?, ?, 'auto', ?, ?, 'active', ?)
    `).run(
      _normSport(sport),
      _normMarket(market) || null,
      league_pattern || null,
      correction_type,
      Number(factor),
      nowIso,
      expIso,
      evidence ? JSON.stringify(evidence) : null,
    );
    loadFromDb(db);
    return { id: r.lastInsertRowid };
  } catch (_) {
    return null;
  }
}

function revert(db, id, reason) {
  if (!db || !id) return false;
  try {
    db.prepare(`UPDATE learned_corrections SET status = 'reverted', evidence = COALESCE(evidence, '{}') WHERE id = ?`).run(id);
    loadFromDb(db);
    return true;
  } catch (_) { return false; }
}

function listAll(db, opts = {}) {
  if (!db) return [];
  const days = opts.days || 60;
  const status = opts.status || null;
  let where = `applied_at >= datetime('now', '-${days} days')`;
  const args = [];
  if (status) { where += ` AND status = ?`; args.push(status); }
  const rows = db.prepare(`
    SELECT * FROM learned_corrections WHERE ${where}
    ORDER BY applied_at DESC LIMIT 200
  `).all(...args);
  return rows.map(r => ({ ...r, evidence: r.evidence ? JSON.parse(r.evidence) : null }));
}

module.exports = {
  loadFromDb,
  getActive,
  applyToProb,
  applyToProbWithBuckets,
  applyToEv,
  applyToTip,
  setAuto,
  revert,
  listAll,
  pToBucket,
  PMODEL_BUCKETS,
};
