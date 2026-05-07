'use strict';

/**
 * feed-heartbeat.js — watchdog pra detectar feed externo silenciosamente
 * quebrado (Pinnacle/PandaScore/Sofascore/etc retornando vazio sem erro).
 *
 * Problema: feed pode degradar sem throw — endpoint volta 200 c/ array vazio,
 * ou volta status 200 mas API key expirada retorna error wrapped. Hoje
 * isso parece "calmo" no log e usuário não nota até abrir dashboard.
 *
 * API:
 *   markFeedSuccess(source, sport, count)  — call quando fetch retorna ≥1 item
 *   markFeedFailure(source, sport, reason) — call em error/empty/throw
 *   checkFeedHealth(opts)                  — cron: retorna lista de degraded feeds
 *   getFeedHealth()                        — snapshot pra dashboard
 *
 * Estado in-memory: source|sport → { lastSuccessMs, lastFailureMs, successCount,
 *                                    failureCount, lastReason }
 * Restart zera. Sem persist — heartbeat é "estado atual", não histórico.
 *
 * Default expected intervals:
 *   pinnacle:   2min  (poll constante)
 *   pandascore: 5min
 *   sofascore:  10min
 *   espn:       15min
 *   hltv:       30min
 *   opendota:   10min
 *   riot:       3min
 *   odds-api:   15min
 *
 * Override via FEED_INTERVAL_<SOURCE_UPPER>=<minutes>.
 * Degraded = staleness > 3× expected interval.
 */

const _state = new Map(); // key: source|sport → state object

const DEFAULT_INTERVALS_MIN = {
  pinnacle: 2,
  pandascore: 5,
  sofascore: 10,
  espn: 15,
  hltv: 30,
  opendota: 10,
  riot: 3,
  'odds-api': 15,
  'sx-bet': 10,
  'football-data': 60,
  default: 15,
};

function _key(source, sport) {
  return `${String(source || 'unknown').toLowerCase()}|${String(sport || 'all').toLowerCase()}`;
}

function _expectedIntervalMs(source) {
  const src = String(source || '').toLowerCase().replace(/[^a-z0-9-]/g, '_');
  const envKey = `FEED_INTERVAL_${src.toUpperCase().replace(/-/g, '_')}`;
  const envVal = parseFloat(process.env[envKey]);
  if (Number.isFinite(envVal) && envVal > 0) return envVal * 60_000;
  const def = DEFAULT_INTERVALS_MIN[src] ?? DEFAULT_INTERVALS_MIN.default;
  return def * 60_000;
}

function markFeedSuccess(source, sport, count = 1) {
  if (!source) return;
  const k = _key(source, sport);
  const cur = _state.get(k) || { successCount: 0, failureCount: 0 };
  cur.lastSuccessMs = Date.now();
  cur.successCount = (cur.successCount || 0) + 1;
  cur.lastCount = count;
  cur.source = source;
  cur.sport = sport || 'all';
  _state.set(k, cur);
}

function markFeedFailure(source, sport, reason = 'unknown') {
  if (!source) return;
  const k = _key(source, sport);
  const cur = _state.get(k) || { successCount: 0, failureCount: 0 };
  cur.lastFailureMs = Date.now();
  cur.failureCount = (cur.failureCount || 0) + 1;
  cur.lastReason = String(reason).slice(0, 100);
  cur.source = source;
  cur.sport = sport || 'all';
  _state.set(k, cur);
}

/**
 * Verifica saúde de todos feeds rastreados. Retorna lista de degraded.
 * @param {object} opts
 * @param {number} [opts.staleMultiplier=3] — N× expected interval = stale
 * @param {boolean} [opts.includeNeverSuccessful=true] — incluir feeds só com failures
 * @param {number} [opts.minObservations=2] — n mínimo de events pra avaliar (evita falso positivo no boot)
 * @returns {Array<{source, sport, status, lastSuccessMin, lastReason, expectedIntervalMin, ratio}>}
 */
function checkFeedHealth(opts = {}) {
  const staleMul = opts.staleMultiplier ?? 3;
  const minObs = opts.minObservations ?? 2;
  const includeNever = opts.includeNeverSuccessful ?? true;
  const now = Date.now();
  const alerts = [];
  for (const [k, s] of _state) {
    const totalObs = (s.successCount || 0) + (s.failureCount || 0);
    if (totalObs < minObs) continue;
    const expected = _expectedIntervalMs(s.source);
    const sinceLastSuccess = s.lastSuccessMs ? (now - s.lastSuccessMs) : Infinity;
    const ratio = sinceLastSuccess / expected;
    if (!s.lastSuccessMs && includeNever) {
      alerts.push({
        source: s.source, sport: s.sport, status: 'never_successful',
        lastSuccessMin: null, lastReason: s.lastReason || 'no_success_yet',
        expectedIntervalMin: expected / 60_000, ratio: Infinity,
        successCount: s.successCount, failureCount: s.failureCount,
      });
      continue;
    }
    if (ratio > staleMul) {
      alerts.push({
        source: s.source, sport: s.sport,
        status: 'stale',
        lastSuccessMin: +(sinceLastSuccess / 60_000).toFixed(1),
        lastReason: s.lastReason || null,
        expectedIntervalMin: +(expected / 60_000).toFixed(1),
        ratio: +ratio.toFixed(1),
        successCount: s.successCount, failureCount: s.failureCount,
      });
    }
  }
  return alerts;
}

function getFeedHealth() {
  const now = Date.now();
  const out = [];
  for (const [, s] of _state) {
    const expected = _expectedIntervalMs(s.source);
    const sinceLastSuccess = s.lastSuccessMs ? (now - s.lastSuccessMs) : null;
    out.push({
      source: s.source,
      sport: s.sport,
      lastSuccessMin: sinceLastSuccess != null ? +(sinceLastSuccess / 60_000).toFixed(1) : null,
      lastFailureMin: s.lastFailureMs ? +((now - s.lastFailureMs) / 60_000).toFixed(1) : null,
      lastReason: s.lastReason || null,
      successCount: s.successCount || 0,
      failureCount: s.failureCount || 0,
      lastCount: s.lastCount,
      expectedIntervalMin: +(expected / 60_000).toFixed(1),
      stale: sinceLastSuccess != null && sinceLastSuccess > expected * 3,
    });
  }
  return out.sort((a, b) => `${a.source}|${a.sport}`.localeCompare(`${b.source}|${b.sport}`));
}

function _resetForTests() { _state.clear(); }

// 2026-05-03 FIX: persist cross-restart pra Railway (boot count alto). Antes
// "Restart zera" — feed pode estar down há horas, signal perde a cada redeploy.
// Persiste via dump JSON em path configurable; restore on require.
const _persistPath = process.env.FEED_HEARTBEAT_PERSIST_PATH || './data/feed_heartbeat.json';
const _persistDisabled = /^(0|false|no)$/i.test(String(process.env.FEED_HEARTBEAT_PERSIST || ''));
let _persistDirty = false;

// 2026-05-07 (audit P2): throttled error logging pra fs IO. Antes catch silent
// /* fail-silent */ — se persist nunca grava (permissions, disk full, etc),
// nunca avisa. Log throttle 1/h por op pra evitar spam mas garantir visibility.
const _ioErrLastLog = new Map();
function _logIoErr(op, err) {
  try {
    const now = Date.now();
    const last = _ioErrLastLog.get(op) || 0;
    if (now - last > 60 * 60 * 1000) {
      _ioErrLastLog.set(op, now);
      console.warn(`[feed-heartbeat] ${op} fs IO err: ${err?.message || err} path=${_persistPath}`);
    }
  } catch (_) { /* logging não pode quebrar caller */ }
}

function _restore() {
  if (_persistDisabled) return;
  try {
    const fs = require('fs');
    if (!fs.existsSync(_persistPath)) return;
    const raw = fs.readFileSync(_persistPath, 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return;
    for (const entry of arr) {
      if (!entry?.source) continue;
      const k = _key(entry.source, entry.sport);
      _state.set(k, entry);
    }
  } catch (e) { _logIoErr('restore', e); }
}

// 2026-05-03: cross-process refresh. server.js escreve markFeedSuccess; bot.js
// chama checkFeedHealth (cron 5min). Sem isso bot.js fica congelado no
// snapshot de boot e dispara stale falso. Merge por max(lastSuccessMs).
function refreshFromDisk() {
  if (_persistDisabled) return 0;
  try {
    const fs = require('fs');
    if (!fs.existsSync(_persistPath)) return 0;
    const raw = fs.readFileSync(_persistPath, 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return 0;
    let merged = 0;
    for (const entry of arr) {
      if (!entry?.source) continue;
      const k = _key(entry.source, entry.sport);
      const cur = _state.get(k);
      const diskSucc = entry.lastSuccessMs || 0;
      const diskFail = entry.lastFailureMs || 0;
      const memSucc = cur?.lastSuccessMs || 0;
      const memFail = cur?.lastFailureMs || 0;
      if (!cur || diskSucc > memSucc || diskFail > memFail) {
        _state.set(k, entry);
        merged++;
      }
    }
    return merged;
  } catch (e) { _logIoErr('refreshFromDisk', e); return 0; }
}

function _persist() {
  if (_persistDisabled || !_persistDirty) return;
  _persistDirty = false;
  try {
    const fs = require('fs');
    const path = require('path');
    fs.mkdirSync(path.dirname(_persistPath), { recursive: true });
    // 2026-05-06 FIX: atomic write via temp + rename. Antes bot.js + server.js
    // (processos separados) ambos required este módulo → cada um carregava
    // _state distinto e _persist escrevia concorrente no mesmo arquivo →
    // último a escrever ganhava, perdendo updates do outro processo.
    // markFeedSuccess do server podia ser sobrescrito por dump antigo do bot
    // gerando "stale" alerta falso. Atomic rename é POSIX-safe (no Windows
    // funciona se ninguém tem o arquivo aberto). Mesma técnica do tennis-markov-calib.
    const arr = Array.from(_state.values());
    const tmp = `${_persistPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(arr));
    try {
      fs.renameSync(tmp, _persistPath);
    } catch (eRename) {
      _logIoErr('persist_rename', eRename);
      // Windows pode falhar se outro processo está lendo. Limpa temp.
      try { fs.unlinkSync(tmp); } catch (_e) {}
    }
  } catch (e) { _logIoErr('persist', e); }
}

// Auto-restore on first require + persist a cada 5min + on process exit.
_restore();
const _persistInt = setInterval(_persist, 5 * 60 * 1000);
if (typeof _persistInt.unref === 'function') _persistInt.unref();
process.on('beforeExit', _persist);
process.on('SIGTERM', _persist);
process.on('SIGINT', _persist);

// Hooks pra marcar dirty
const _origSuccess = markFeedSuccess;
const _origFailure = markFeedFailure;
function _wrapSuccess(...args) { _origSuccess(...args); _persistDirty = true; }
function _wrapFailure(...args) { _origFailure(...args); _persistDirty = true; }

module.exports = {
  markFeedSuccess: _wrapSuccess,
  markFeedFailure: _wrapFailure,
  checkFeedHealth,
  getFeedHealth,
  refreshFromDisk,
  _resetForTests,
  _persist,
};
