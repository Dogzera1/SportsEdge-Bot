'use strict';
/**
 * dota-draft-parse.js — Display-only helpers for the Dota Lab print-parse (vision OCR).
 * Pure vision prompt + hero-name normalizer. No HTTP/stake/EV — display-only by construction.
 * Mirrors the role of lib/lol-champions.js (normalizeChampion) for the Dota domain.
 */

// Vision prompt: a Dota 2 draft (pick screen) OR an in-game scoreboard.
const PROMPT =
  'This image is a Dota 2 draft (hero pick screen) OR a live in-game scoreboard. '
  + 'Return ONLY compact JSON, no prose: '
  + '{"teams":{"blue":"<team name or null>","red":"<team name or null>"},"blue":[{"hero":"<name>","player":"<player name or null>"}],"red":[...]} '
  + 'with exactly 5 entries per team. '
  + 'The Radiant team is "blue"; the Dire team is "red". On a scoreboard, Radiant is the top/left (green) side and Dire is the bottom/right (red) side; in a pick screen Radiant is on the left. '
  + 'For "teams", read the team names from a broadcast/tournament overlay or the scoreboard header (one per side); use null if not shown. '
  + 'Identify each hero from its portrait icon AND its name text. Use the official English Dota 2 hero name '
  + '(e.g. "Anti-Mage", "Nature\'s Prophet", "Queen of Pain", "Outworld Destroyer"); never use nicknames or abbreviations '
  + '(not "AM", "QoP", "Furion", "Wisp") and never guess a hero from a position/lane. '
  + 'For "player": each scoreboard row has TWO separate texts — the hero name AND the human player handle (a person nickname, '
  + 'often with a short team tag, e.g. "Tundra.Nine", "OG ATF"). Put that handle in "player"; it is NOT the hero name — '
  + 'never copy the hero name into "player". If no separate human handle is visible, use null. '
  + 'CRITICAL: read all text exactly as shown — never translate or invent a team, player, or hero name. '
  + 'If any single value is not clearly legible, use null for that value instead of guessing.';

function buildDotaPrintPrompt() {
  return PROMPT;
}

// Hero-name lookup cache (~30min, same pattern as dota-hero-features). Keyed module-level,
// not per-db; prod has a single db. Tests call _invalidateHeroCache() before swapping the stub.
const CACHE_TTL = 30 * 60 * 1000;
let _cache = null; // { exact: Map<lowerName, canonical>, loose: Map<looseKey, canonical|null> }
let _cacheTs = 0;

function _looseKey(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function _load(db) {
  const now = Date.now();
  if (_cache && (now - _cacheTs) < CACHE_TTL) return _cache;
  const exact = new Map();
  const loose = new Map();
  try {
    const rows = db.prepare(
      "SELECT DISTINCT localized_name FROM dota_hero_stats WHERE localized_name IS NOT NULL AND localized_name != ''"
    ).all();
    for (const r of rows) {
      const name = r.localized_name;
      const ex = String(name).toLowerCase().trim();
      if (!ex) continue;
      if (!exact.has(ex)) exact.set(ex, name);
      const lk = _looseKey(name);
      if (!lk) continue;
      if (loose.has(lk) && loose.get(lk) !== name) loose.set(lk, null); // distinct heroes collide -> ambiguous
      else if (!loose.has(lk)) loose.set(lk, name);
    }
  } catch (_) { /* table missing (boot/test) — empty maps, normalizeHeroName returns null */ }
  _cache = { exact, loose };
  _cacheTs = now;
  return _cache;
}

/**
 * Resolve a vision-read hero name to the canonical dota_hero_stats.localized_name, or null.
 * The model matches heroes by exact (lowercased) name, so a mismatch silently falls to neutral WR.
 */
function normalizeHeroName(db, raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  const { exact, loose } = _load(db);
  const ex = s.toLowerCase();
  if (exact.has(ex)) return exact.get(ex);
  const lk = _looseKey(s);
  if (lk && loose.has(lk)) return loose.get(lk); // null if ambiguous
  return null;
}

function _invalidateHeroCache() { _cache = null; _cacheTs = 0; }

module.exports = { buildDotaPrintPrompt, normalizeHeroName, _invalidateHeroCache };
