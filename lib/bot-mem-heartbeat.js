'use strict';

/**
 * bot-mem-heartbeat.js — Periodic bot.js memory snapshot via shared file.
 *
 * Audit P0 architectural 2026-05-15: bot.js + server.js separate processes
 * (start.js spawn). server.js /admin/memory-breakdown só vê SUA memória.
 * Pra diagnose restart loop precisamos visibilidade bot.js process tambem.
 *
 * lib/mem-shared.js (Sprint 4 #2) já dá signal CRITICAL crosspoc, mas não
 * detalhe (RSS, V8 heap, uptime). Este módulo escreve _bot_mem_snapshot.json
 * com info detalhada que server.js endpoint lê.
 *
 * Cheap: ~200 bytes/snapshot, escrita atomic via JSON.stringify single call.
 * Frequência 60s default — alinha com mem_guard cron.
 */

const fs = require('fs');
const path = require('path');

function _resolveSnapshotPath() {
  try {
    const dbPath = process.env.DB_PATH || 'sportsedge.db';
    const dbDir = path.dirname(path.isAbsolute(dbPath) ? dbPath : path.resolve(dbPath));
    return path.join(dbDir, '_bot_mem_snapshot.json');
  } catch (_) {
    return path.resolve('_bot_mem_snapshot.json');
  }
}

/**
 * Escreve snapshot atual do processo (process.memoryUsage + v8 stats + uptime).
 * Chamado periodicamente pelo bot.js mem_guard cron.
 */
function writeBotMemSnapshot() {
  try {
    const mem = process.memoryUsage();
    let v8stats = null;
    try {
      const v8 = require('v8');
      const s = v8.getHeapStatistics();
      v8stats = {
        total_heap_size_mb: Math.round(s.total_heap_size / 1048576),
        used_heap_size_mb: Math.round(s.used_heap_size / 1048576),
        heap_size_limit_mb: Math.round(s.heap_size_limit / 1048576),
        malloced_memory_mb: Math.round(s.malloced_memory / 1048576),
        native_contexts: s.number_of_native_contexts,
        detached_contexts: s.number_of_detached_contexts,
      };
    } catch (_) {}
    const payload = {
      ts: new Date().toISOString(),
      uptime_s: Math.round(process.uptime()),
      memoryMb: {
        rss: Math.round(mem.rss / 1048576),
        heap_used: Math.round(mem.heapUsed / 1048576),
        heap_total: Math.round(mem.heapTotal / 1048576),
        external: Math.round((mem.external || 0) / 1048576),
        array_buffers: Math.round((mem.arrayBuffers || 0) / 1048576),
      },
      v8: v8stats,
      memCritical: !!(global._memCritical && global._memCritical.ts),
    };
    fs.writeFileSync(_resolveSnapshotPath(), JSON.stringify(payload));
  } catch (_) {
    // Best-effort. Falha de FS não bloqueia processo principal.
  }
}

/**
 * Lê o último snapshot escrito. Retorna null se ausente ou inválido.
 */
function readBotMemSnapshot() {
  try {
    const p = _resolveSnapshotPath();
    if (!fs.existsSync(p)) return null;
    const stat = fs.statSync(p);
    const content = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      ...content,
      _ageMs: Date.now() - stat.mtime.getTime(),
    };
  } catch (_) {
    return null;
  }
}

module.exports = { writeBotMemSnapshot, readBotMemSnapshot };
