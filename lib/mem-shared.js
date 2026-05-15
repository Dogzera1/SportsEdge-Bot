'use strict';

/**
 * mem-shared.js — Cross-process memory critical signal via shared files.
 *
 * Audit Sprint 4 #2 (2026-05-15): bot.js + server.js são processos separados
 * (spawned via start.js launcher). Cada um seta global._memCritical
 * baseado em SUA própria RSS. Quando bot.js é crítico, server.js NÃO sabe
 * e vice-versa. Em Railway 512MB cap, ambos podem somar > cap → OOM kill.
 *
 * Mecanismo: cada processo escreve seu state em `_mem_critical_<name>.json`.
 * Leitura escaneia todos os arquivos `_mem_critical_*.json` e retorna true
 * se QUALQUER processo está crítico (com timestamp recente < maxAge).
 *
 * Edge cases:
 *   - Process crash sem cleanup: timestamp stale → tratado como não crítico (60s default maxAge)
 *   - File não existe: tratado como não crítico
 *   - JSON inválido: tratado como não crítico (catch silent)
 *   - Write race: cada processo escreve no SEU arquivo (sem write race possível)
 */

const fs = require('fs');
const path = require('path');

function _dir() {
  return process.env.MEM_SHARED_DIR || path.join(__dirname, '..');
}

function _filePath(processName) {
  const safe = String(processName || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(_dir(), `_mem_critical_${safe}.json`);
}

/**
 * Escreve state de memory crítico do processo atual.
 * @param {string} processName — ex: 'bot' | 'server'
 * @param {boolean} isCritical
 * @param {number} rssMb — RSS atual em MB (informational)
 */
function writeMemState(processName, isCritical, rssMb) {
  try {
    fs.writeFileSync(_filePath(processName), JSON.stringify({
      critical: !!isCritical,
      rssMb: Number.isFinite(rssMb) ? rssMb : null,
      ts: Date.now(),
      processName,
    }));
  } catch (_) {
    // Best-effort. Falha não bloqueia processo principal.
  }
}

/**
 * Verifica se QUALQUER processo está crítico via shared files.
 * @param {number} maxAgeMs — idade máxima do timestamp pra considerar valido (default 60s)
 * @returns {boolean}
 */
function isAnyProcessCritical(maxAgeMs = 60000) {
  try {
    const dir = _dir();
    if (!fs.existsSync(dir)) return false;
    const files = fs.readdirSync(dir).filter(f => f.startsWith('_mem_critical_') && f.endsWith('.json'));
    const now = Date.now();
    for (const fname of files) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf8'));
        if (s && s.critical && (now - s.ts) < maxAgeMs) return true;
      } catch (_) {
        // Arquivo individual corrupto/race read — skip silencioso
      }
    }
    return false;
  } catch (_) {
    return false;
  }
}

/**
 * Lista state de todos os processos (informational/debug).
 * @returns {Array<{name, critical, rssMb, ts, ageMs}>}
 */
function listProcessStates() {
  try {
    const dir = _dir();
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter(f => f.startsWith('_mem_critical_') && f.endsWith('.json'));
    const now = Date.now();
    const out = [];
    for (const fname of files) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf8'));
        out.push({
          name: s.processName || fname.replace(/^_mem_critical_|\.json$/g, ''),
          critical: !!s.critical,
          rssMb: s.rssMb,
          ts: s.ts,
          ageMs: now - (s.ts || 0),
        });
      } catch (_) {}
    }
    return out;
  } catch (_) {
    return [];
  }
}

module.exports = { writeMemState, isAnyProcessCritical, listProcessStates };
