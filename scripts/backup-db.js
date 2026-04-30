#!/usr/bin/env node
'use strict';

/**
 * scripts/backup-db.js — backup SQLite consistente via online VACUUM INTO.
 *
 * Diferente de copiar o .db direto: VACUUM INTO produz arquivo único snapshot
 * mesmo com WAL ativo (consolida WAL → main DB). Sem race com escritas live.
 *
 * Uso CLI:
 *   node scripts/backup-db.js                          # snapshot pra backups/
 *   node scripts/backup-db.js --dest /custom/path.db   # destino custom
 *   node scripts/backup-db.js --keep 14                # retention 14 dias (default 7)
 *   node scripts/backup-db.js --json                   # output JSON pra cron
 *
 * Como módulo:
 *   const { runBackup } = require('./scripts/backup-db');
 *   const r = await runBackup({ dest, keepDays });
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function _argVal(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

function _resolveDbPath() {
  const raw = (process.env.DB_PATH || 'sportsedge.db').toString().trim().replace(/^=+/, '');
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(__dirname, '..', raw);
}

function _ensureBackupDir(dir) {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch (e) {
    return false;
  }
}

function _formatStamp(d = new Date()) {
  // YYYYMMDD-HHMM (UTC) — ordenable lexicograficamente, não colide em <1min runs.
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}

function _humanBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return `${n}B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

/**
 * Roda backup snapshot via VACUUM INTO. Retorna metadata (path, size, ms).
 *
 * @param {object} opts
 * @param {string} [opts.source]    — caminho do DB origem (default: DB_PATH env)
 * @param {string} [opts.dest]      — caminho destino (default: backups/sportsedge_<stamp>.db)
 * @param {number} [opts.keepDays=7] — retenção (deleta backups mais velhos)
 * @param {boolean} [opts.silent]   — sem console.log
 */
async function runBackup(opts = {}) {
  const t0 = Date.now();
  const source = opts.source || _resolveDbPath();
  const keepDays = Number.isFinite(+opts.keepDays) && +opts.keepDays > 0
    ? +opts.keepDays
    : parseInt(process.env.DB_BACKUP_KEEP_DAYS || '7', 10);

  if (!fs.existsSync(source)) {
    return { ok: false, reason: 'source_not_found', source };
  }
  const sourceStat = fs.statSync(source);

  const backupDir = opts.dest
    ? path.dirname(path.resolve(opts.dest))
    : path.resolve(__dirname, '..', 'backups');
  if (!_ensureBackupDir(backupDir)) {
    return { ok: false, reason: 'backup_dir_create_fail', backupDir };
  }
  const dest = opts.dest
    ? path.resolve(opts.dest)
    : path.join(backupDir, `sportsedge_${_formatStamp()}.db`);

  // Se destino já existe, abortar pra não sobrescrever silenciosamente.
  if (fs.existsSync(dest)) {
    return { ok: false, reason: 'dest_exists', dest };
  }

  // VACUUM INTO requer abrir DB em modo read-write — abre em readonly não funciona.
  // Mas como SQLite suporta múltiplos readers + 1 writer, podemos abrir paralelo
  // ao bot rodando. Risco mínimo de lock se busy_timeout permitir 5s.
  let db;
  try {
    db = new Database(source, { fileMustExist: true });
    db.pragma('busy_timeout = 10000');
    // VACUUM INTO escapa via prepared statement seguro — path em string literal.
    // SQLite não aceita bind em VACUUM INTO; sanitizar pra evitar SQL injection
    // se caller passar dest controlado por user (CLI arg). Aqui aceitamos só
    // chars [\w\-./:\\] (ASCII path safe).
    if (!/^[\w\-./:\\ ]+$/.test(dest)) {
      db.close();
      return { ok: false, reason: 'unsafe_dest_chars', dest };
    }
    // Escape single quotes in path (Windows users).
    const escaped = dest.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escaped}'`);
    // Checkpoint TRUNCATE: força WAL flush + shrink. Sem isso, journal pode
    // crescer entre backups quando journal_size_limit não consegue compactar
    // sozinho (lock contention durante hot loops). Best-effort: se falhar,
    // backup já foi feito, não bloqueia o sucesso.
    try {
      const cp = db.pragma('wal_checkpoint(TRUNCATE)');
      // Retorno: [{busy: 0|1, log: <pages>, checkpointed: <pages>}]
      // Logamos só se não-silent.
      if (!opts.silent && Array.isArray(cp) && cp[0]) {
        console.log(`[backup-db] wal_checkpoint(TRUNCATE) busy=${cp[0].busy} pages_log=${cp[0].log} cp=${cp[0].checkpointed}`);
      }
    } catch (_) { /* best-effort */ }
    db.close();
  } catch (e) {
    if (db) try { db.close(); } catch (_) {}
    return { ok: false, reason: 'vacuum_failed', error: e.message, dest };
  }

  let destStat;
  try { destStat = fs.statSync(dest); }
  catch (e) { return { ok: false, reason: 'dest_stat_fail', error: e.message, dest }; }

  // Retention sweep — só atua no diretório de backups default ou explícito.
  const swept = [];
  try {
    const cutoffMs = Date.now() - keepDays * 86400 * 1000;
    const files = fs.readdirSync(backupDir);
    for (const f of files) {
      if (!/^sportsedge_\d{8}-\d{4}\.db$/.test(f)) continue; // só formato padrão
      const fp = path.join(backupDir, f);
      try {
        const st = fs.statSync(fp);
        if (st.mtimeMs < cutoffMs) {
          fs.unlinkSync(fp);
          swept.push(f);
        }
      } catch (_) {}
    }
  } catch (_) { /* sweep best-effort */ }

  const out = {
    ok: true,
    source,
    dest,
    source_size_bytes: sourceStat.size,
    dest_size_bytes: destStat.size,
    duration_ms: Date.now() - t0,
    swept_count: swept.length,
    swept,
    keep_days: keepDays,
  };

  if (!opts.silent) {
    const compressionPct = sourceStat.size > 0
      ? ((1 - destStat.size / sourceStat.size) * 100).toFixed(1)
      : '0';
    console.log(`[backup-db] ${path.basename(dest)} | ${_humanBytes(destStat.size)} (${compressionPct}% smaller via VACUUM) | ${out.duration_ms}ms${swept.length ? ` | swept ${swept.length} old (>${keepDays}d)` : ''}`);
  }
  return out;
}

// ── CLI ─────────────────────────────────────────────────────────────────
if (require.main === module) {
  const dest = _argVal('dest');
  const keepDays = _argVal('keep');
  const json = _argVal('json');
  runBackup({
    dest: dest === true ? null : dest,
    keepDays,
    silent: !!json,
  }).then(r => {
    if (json) console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }).catch(e => {
    if (json) console.log(JSON.stringify({ ok: false, error: e.message }));
    else console.error('[backup-db] fatal:', e.message);
    process.exit(2);
  });
}

module.exports = { runBackup };
