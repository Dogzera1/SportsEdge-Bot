'use strict';

/**
 * dota-roster-detect.js — detecção de stand-in via account_ids observados.
 *
 * Estratégia: aprende o roster "canônico" de cada team observando account_ids
 * em snapshots live (via /opendota-live). Cada observação incrementa contador
 * per-(team_key, account_id). Roster canônico = top-5 account_ids por games_count.
 *
 * Em uma partida nova: se ≥2 dos 5 account_ids atuais NÃO estão no top-5 canônico
 * (ou team tem <5 observados), flag stand-in → downweight confidence.
 *
 * Tabela: dota_team_rosters (migration 029).
 */

const MIN_BASELINE_GAMES = 3;  // team precisa ter ≥3 observações pra baseline confiável
const TOP_N_ROSTER = 5;        // 5 jogadores por time Dota

function _normKey(name) {
  return String(name || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '');
}

/**
 * Registra observação de 5 account_ids num time.
 * Chamar uma vez por live match observation.
 */
function recordRosterObservation(db, teamName, accountIds) {
  if (!db || !teamName || !Array.isArray(accountIds)) return 0;
  const key = _normKey(teamName);
  if (!key) return 0;
  const ids = accountIds
    .map(x => parseInt(x, 10))
    .filter(x => Number.isFinite(x) && x > 0);
  if (!ids.length) return 0;

  try {
    const upsert = db.prepare(`
      INSERT INTO dota_team_rosters (team_key, account_id, games_count, first_seen, last_seen)
      VALUES (?, ?, 1, datetime('now'), datetime('now'))
      ON CONFLICT(team_key, account_id) DO UPDATE SET
        games_count = games_count + 1,
        last_seen = datetime('now')
    `);
    const tx = db.transaction((rows) => { for (const r of rows) upsert.run(r.key, r.id); });
    tx(ids.map(id => ({ key, id })));
    return ids.length;
  } catch (_) { return 0; }
}

/**
 * Retorna os top-N account_ids históricos do team (canônico).
 */
function getCanonicalRoster(db, teamName, topN = TOP_N_ROSTER) {
  if (!db || !teamName) return [];
  const key = _normKey(teamName);
  if (!key) return [];
  try {
    return db.prepare(`
      SELECT account_id, games_count FROM dota_team_rosters
      WHERE team_key = ? ORDER BY games_count DESC, last_seen DESC LIMIT ?
    `).all(key, topN);
  } catch (_) { return []; }
}

/**
 * Dado os 5 account_ids observados agora, retorna:
 *   { standInCount, isStandIn, confidence, canonicalSize, reason }
 *
 * - standInCount: quantos dos 5 NÃO estão no top-5 canônico
 * - isStandIn:    true quando standInCount ≥ 2
 * - confidence:   alta se canonical tem ≥3 games em ≥5 players; baixa se dados rasos
 * - canonicalSize: tamanho do roster canônico observado
 */
function detectStandIn(db, teamName, currentAccountIds) {
  const canonical = getCanonicalRoster(db, teamName, TOP_N_ROSTER);
  const current = (currentAccountIds || [])
    .map(x => parseInt(x, 10))
    .filter(x => Number.isFinite(x) && x > 0);
  if (!current.length) {
    return { standInCount: 0, isStandIn: false, confidence: 'no_data', canonicalSize: canonical.length, reason: 'no_current_accounts' };
  }
  if (canonical.length < TOP_N_ROSTER) {
    return { standInCount: 0, isStandIn: false, confidence: 'insufficient_history', canonicalSize: canonical.length, reason: `canonical<${TOP_N_ROSTER}` };
  }
  // Exige pelo menos min games no top-5 pra confiar na baseline
  const minGames = canonical[TOP_N_ROSTER - 1]?.games_count || 0;
  if (minGames < MIN_BASELINE_GAMES) {
    return { standInCount: 0, isStandIn: false, confidence: 'insufficient_history', canonicalSize: canonical.length, reason: `min_games<${MIN_BASELINE_GAMES}` };
  }
  const canonSet = new Set(canonical.map(r => r.account_id));
  let mismatches = 0;
  for (const id of current) if (!canonSet.has(id)) mismatches++;
  return {
    standInCount: mismatches,
    isStandIn: mismatches >= 2,
    confidence: 'ok',
    canonicalSize: canonical.length,
    reason: mismatches >= 2 ? `${mismatches}/5 not in canonical` : 'match',
  };
}

module.exports = { recordRosterObservation, getCanonicalRoster, detectStandIn };
