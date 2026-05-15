'use strict';

/**
 * cron-stagger.js — Deterministic minute-level cron stagger.
 *
 * Audit Sprint 4 #1 (2026-05-15): bot.js tem 5 crons firing em 4h UTC
 * (db_backup, db_integrity, bankroll_reconcile, readiness_retention,
 * threshold_auto_apply) + 4 em 12h UTC + 5 em 14h UTC. Em Railway 512MB
 * cap, simultaneous heavy crons risk OOM (memory peak coincide).
 *
 * Pattern atual cada cron usa:
 *   if (now.getUTCHours() !== hourUtc) return;
 *   const today = now.toISOString().slice(0, 10);
 *   if (_lastXDay === today) return;
 *   _lastXDay = today;
 *   // ... do work ...
 *
 * Fire window é hourUtc:00-hourUtc:59. setInterval fires a cada 60s,
 * cron pega o primeiro tick após hour boundary. Crons sharing hour
 * disparam dentro de ~60s window — daí o stampede.
 *
 * Fix: este helper deriva targetMinute determinístico do cronName via hash.
 * Cada cron firea em SEU minuto específico (0-49). Distribuição:
 *   bankroll_reconcile → minute X (deterministic)
 *   db_integrity       → minute Y
 *   db_backup          → minute Z
 *   etc.
 * Spread ≥ 1 min entre quaisquer dois crons ↔ no simultaneous spike.
 *
 * Opt-out: CRON_STAGGER=false reverte pra legacy (instant fire em hour).
 */

/**
 * Hash determinístico de cronName → minute 0-49 (deixa 10min end-buffer
 * pro caso de cron lento que estoura no fim da hora — minute 50-59
 * livre pra recovery sem competir com next hour).
 *
 * @param {string} cronName
 * @returns {number} minute 0-49
 */
function getStaggerMinute(cronName) {
  let hash = 0;
  const s = String(cronName || '');
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash) + s.charCodeAt(i);
    hash |= 0; // force int32
  }
  return Math.abs(hash) % 50;
}

/**
 * @param {string} cronName — identifier único do cron (ex: 'bankroll_reconcile')
 * @param {number} hourUtc — hora UTC alvo (0-23)
 * @param {Date} now — momento atual (injected pra testabilidade)
 * @returns {boolean} true se cron deve rodar agora
 */
function shouldRunDaily(cronName, hourUtc, now) {
  if (!(now instanceof Date)) now = new Date();
  if (now.getUTCHours() !== hourUtc) return false;
  // Opt-out: legacy behavior (instant fire em hour boundary)
  if (/^(0|false|no)$/i.test(String(process.env.CRON_STAGGER ?? 'true'))) {
    return true;
  }
  const targetMin = getStaggerMinute(cronName);
  // Fire window: minute >= targetMin (caller's _lastXDay guard previne re-run)
  return now.getUTCMinutes() >= targetMin;
}

module.exports = { getStaggerMinute, shouldRunDaily };
