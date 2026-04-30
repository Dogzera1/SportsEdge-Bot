'use strict';

/**
 * lib/metrics.js — counters in-memory cross-process pra observabilidade.
 *
 * Use:
 *   const m = require('./metrics');
 *   m.incr('tips_emitted', { sport: 'lol' });
 *   m.incr('rejection', { sport: 'lol', reason: 'ev_below_min' });
 *   m.timing('scanner_cycle_ms', 1234, { sport: 'tennis' });
 *   m.gauge('analyzed_map_size', 1234, { sport: 'lol' });
 *
 *   const snap = m.snapshot();   // pra /health/metrics
 *   m.snapshot1h();              // só último 1h (rolling)
 *
 * Storage: 2 buckets — total (acumulado desde boot) + rolling 1h
 * (5 sub-buckets de 12min, rotated a cada 12min).
 *
 * Não persiste em disco — restart zera. Pra histórico, use logs/audit.
 */

const COUNTER_KIND = 'counter';
const TIMING_KIND = 'timing';
const GAUGE_KIND = 'gauge';

const _bootedAt = Date.now();
const _totals = new Map();    // key → { value, kind, samples? }
const _rollingBuckets = [];   // cada bucket: { startMs, counters: Map }
const ROLLING_WINDOW_MS = 60 * 60 * 1000;
const ROLLING_BUCKETS = 5;
const BUCKET_DURATION_MS = ROLLING_WINDOW_MS / ROLLING_BUCKETS;

// Cardinality cap: previne explosão de _totals quando alguém emite metric com
// tag high-cardinality (ex: gauge('foo', v, { matchId: <id-único-por-call> })).
// Eviction FIFO baseada em ordem de inserção do Map. Sem isso, processo pode
// vazar memória silenciosamente em deploy long-running.
// Override via METRICS_MAX_ENTRIES env. Default 5000 cabe ~50 métricas × 100 tags.
const MAX_TOTALS_ENTRIES = Math.max(500, parseInt(process.env.METRICS_MAX_ENTRIES || '5000', 10) || 5000);
let _evictionCount = 0; // counter local (não emite via metrics pra evitar recursão)
let _evictionWarnedAt = 0;
function _evictIfFull() {
  if (_totals.size <= MAX_TOTALS_ENTRIES) return;
  // Evict ~1% das oldest entries de uma vez (amortiza overhead) — em prática
  // só dispara quando atinge cap, então 1 evição = N novas, evitando O(n²)
  // edge case quando high-cardinality emite em rajada.
  const evictBatch = Math.max(1, Math.floor(MAX_TOTALS_ENTRIES * 0.01));
  let i = 0;
  for (const k of _totals.keys()) {
    _totals.delete(k);
    _evictionCount++;
    if (++i >= evictBatch) break;
  }
  // Warn 1×/h pra não inundar logs em pico
  const now = Date.now();
  if (now - _evictionWarnedAt > 60 * 60 * 1000) {
    _evictionWarnedAt = now;
    try {
      const utils = require('./utils');
      utils.log('WARN', 'METRICS-CAP', `evicted ${_evictionCount} entries (cap=${MAX_TOTALS_ENTRIES}); investigate high-cardinality tags`);
    } catch (_) {}
  }
}

function _ensureRollingBucket() {
  const now = Date.now();
  const head = _rollingBuckets[_rollingBuckets.length - 1];
  if (!head || now - head.startMs >= BUCKET_DURATION_MS) {
    _rollingBuckets.push({ startMs: now, counters: new Map() });
    while (_rollingBuckets.length > ROLLING_BUCKETS) _rollingBuckets.shift();
  }
  return _rollingBuckets[_rollingBuckets.length - 1];
}

function _key(metric, tags) {
  if (!tags) return metric;
  const parts = Object.keys(tags).sort().map(k => `${k}=${tags[k]}`);
  return parts.length ? `${metric}|${parts.join(',')}` : metric;
}

function _initEntry(kind) {
  if (kind === TIMING_KIND) return { kind, count: 0, sum: 0, min: Infinity, max: 0 };
  if (kind === GAUGE_KIND) return { kind, value: 0, ts: 0 };
  return { kind: COUNTER_KIND, value: 0 };
}

function incr(metric, tags = null, by = 1) {
  if (!metric) return;
  const k = _key(metric, tags);
  const t = _totals.get(k) || _initEntry(COUNTER_KIND);
  t.value += by;
  _totals.set(k, t);
  _evictIfFull();
  const bucket = _ensureRollingBucket();
  const r = bucket.counters.get(k) || _initEntry(COUNTER_KIND);
  r.value += by;
  bucket.counters.set(k, r);
}

function timing(metric, ms, tags = null) {
  if (!metric || !Number.isFinite(ms)) return;
  const k = _key(metric, tags);
  const t = _totals.get(k);
  const e = t && t.kind === TIMING_KIND ? t : _initEntry(TIMING_KIND);
  e.count++;
  e.sum += ms;
  if (ms < e.min) e.min = ms;
  if (ms > e.max) e.max = ms;
  _totals.set(k, e);
  _evictIfFull();
}

function gauge(metric, value, tags = null) {
  if (!metric || !Number.isFinite(value)) return;
  const k = _key(metric, tags);
  _totals.set(k, { kind: GAUGE_KIND, value, ts: Date.now() });
  _evictIfFull();
}

function snapshot() {
  const out = { booted_at: new Date(_bootedAt).toISOString(), uptime_s: Math.round((Date.now() - _bootedAt) / 1000), counters: {}, timings: {}, gauges: {} };
  for (const [k, e] of _totals.entries()) {
    if (e.kind === COUNTER_KIND) out.counters[k] = e.value;
    else if (e.kind === TIMING_KIND) {
      out.timings[k] = {
        count: e.count,
        avg_ms: e.count > 0 ? +(e.sum / e.count).toFixed(1) : 0,
        min_ms: e.min === Infinity ? 0 : +e.min.toFixed(1),
        max_ms: +e.max.toFixed(1),
      };
    } else if (e.kind === GAUGE_KIND) {
      out.gauges[k] = { value: e.value, age_s: Math.round((Date.now() - e.ts) / 1000) };
    }
  }
  return out;
}

function snapshot1h() {
  const merged = new Map();
  for (const b of _rollingBuckets) {
    for (const [k, e] of b.counters.entries()) {
      const prev = merged.get(k) || 0;
      merged.set(k, prev + e.value);
    }
  }
  return { window_min: Math.round(ROLLING_WINDOW_MS / 60000), counters: Object.fromEntries(merged) };
}

function reset() {
  _totals.clear();
  _rollingBuckets.length = 0;
  _evictionCount = 0;
}

function getCardinalityStats() {
  return {
    size: _totals.size,
    cap: MAX_TOTALS_ENTRIES,
    evictions: _evictionCount,
  };
}

/**
 * Mescla snapshot externo (de outro processo, ex: bot.js → server.js).
 * Counters: soma. Timings: agrega count/sum/min/max. Gauges: substitui (last-write-wins).
 * Recebe tags com prefix automatico { ...tags, src: 'bot' } se prefix passado.
 */
function mergeSnapshot(snap, opts = {}) {
  if (!snap || typeof snap !== 'object') return false;
  const prefix = opts.prefix || ''; // ex: 'bot:' → counters viram 'bot:tips_emitted|sport=lol'
  const _tagged = (k) => prefix ? `${prefix}${k}` : k;
  if (snap.counters) {
    for (const [k, v] of Object.entries(snap.counters)) {
      if (!Number.isFinite(v)) continue;
      const tk = _tagged(k);
      const e = _totals.get(tk) || _initEntry(COUNTER_KIND);
      e.value += v;
      _totals.set(tk, e);
    }
  }
  if (snap.timings) {
    for (const [k, v] of Object.entries(snap.timings)) {
      if (!v || !Number.isFinite(v.count) || v.count <= 0) continue;
      const tk = _tagged(k);
      const e = _totals.get(tk);
      const merged = e && e.kind === TIMING_KIND ? e : _initEntry(TIMING_KIND);
      // Reconstrói sum a partir de avg*count (perdemos precisão mas é approx OK)
      const incomingSum = (v.avg_ms || 0) * v.count;
      merged.count += v.count;
      merged.sum += incomingSum;
      if (Number.isFinite(v.min_ms) && v.min_ms < merged.min) merged.min = v.min_ms;
      if (Number.isFinite(v.max_ms) && v.max_ms > merged.max) merged.max = v.max_ms;
      _totals.set(tk, merged);
    }
  }
  if (snap.gauges) {
    for (const [k, v] of Object.entries(snap.gauges)) {
      const value = v && Number.isFinite(v.value) ? v.value : null;
      if (value == null) continue;
      const tk = _tagged(k);
      _totals.set(tk, { kind: GAUGE_KIND, value, ts: Date.now() });
    }
  }
  _evictIfFull();
  return true;
}

module.exports = { incr, timing, gauge, snapshot, snapshot1h, reset, mergeSnapshot, getCardinalityStats };
