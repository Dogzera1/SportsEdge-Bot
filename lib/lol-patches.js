'use strict';

/**
 * lol-patches.js — lookup de patch LoL pra feature `days_since_patch`.
 *
 * Dataset bootstrapped em data/lol-patch-dates.json (~80 patches 2023-2026).
 * Atualizado via scripts/sync-lol-patch-dates.js (cron opt-in NIGHTLY).
 *
 * Uso (training): const { getDaysSincePatch } = require('./lol-patches');
 *                 const d = getDaysSincePatch(matchTimestampMs);
 *
 * Cap em 60d — patch decay relevância após ~4-6 semanas (literatura ensitics
 * + nossa premissa P1: post-patch window 2-3 sem é ineficiência de mercado).
 */

const fs = require('fs');
const path = require('path');

const JSON_PATH = path.join(__dirname, '..', 'data', 'lol-patch-dates.json');
const DAYS_CAP = 60;
const DAY_MS = 86400000;

let _patches = null; // array sorted by released_at ASC

function loadPatches() {
  if (_patches) return _patches;
  try {
    const raw = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
    const arr = (raw?.patches || [])
      .map(p => ({ version: String(p.version), releasedAtMs: new Date(p.released_at).getTime() }))
      .filter(p => Number.isFinite(p.releasedAtMs))
      .sort((a, b) => a.releasedAtMs - b.releasedAtMs);
    _patches = arr;
  } catch (_) {
    _patches = [];
  }
  return _patches;
}

/**
 * Retorna o patch ativo no timestamp dado (latest released_at ≤ tMs).
 * Retorna null se tMs antes do primeiro patch conhecido.
 */
function getActivePatch(tMs) {
  const arr = loadPatches();
  if (!arr.length || !Number.isFinite(tMs)) return null;
  // Binary search: maior idx com releasedAtMs ≤ tMs
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].releasedAtMs <= tMs) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans >= 0 ? arr[ans] : null;
}

/**
 * Dias desde o último patch antes do timestamp. Cap em DAYS_CAP.
 * Retorna DAYS_CAP se nenhum patch conhecido pré-tMs (assumir velho).
 */
function getDaysSincePatch(tMs) {
  if (!Number.isFinite(tMs)) return DAYS_CAP;
  const p = getActivePatch(tMs);
  if (!p) return DAYS_CAP;
  const d = Math.floor((tMs - p.releasedAtMs) / DAY_MS);
  if (!Number.isFinite(d) || d < 0) return DAYS_CAP;
  return Math.min(DAYS_CAP, d);
}

/**
 * 1 se dentro de janela 14d pós-patch (post-patch boost segundo literatura).
 * 0 caso contrário.
 */
function isPostPatchWindow(tMs, windowDays = 14) {
  const d = getDaysSincePatch(tMs);
  return d <= windowDays ? 1 : 0;
}

/**
 * Append patch novo (idempotente — skip se version já existe).
 * Usado por sync-lol-patch-dates.js. Persiste no JSON e invalida cache.
 */
function addPatch(version, releasedAtIso) {
  const arr = loadPatches();
  const v = String(version);
  if (arr.some(p => p.version === v)) return false;
  const t = new Date(releasedAtIso).getTime();
  if (!Number.isFinite(t)) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
    raw.patches = (raw.patches || []).concat([{ version: v, released_at: releasedAtIso }]);
    fs.writeFileSync(JSON_PATH, JSON.stringify(raw, null, 2) + '\n', 'utf8');
    _patches = null; // invalidate cache
    return true;
  } catch (_) { return false; }
}

function _resetCache() { _patches = null; }

module.exports = {
  loadPatches,
  getActivePatch,
  getDaysSincePatch,
  isPostPatchWindow,
  addPatch,
  _resetCache,
  DAYS_CAP,
};
