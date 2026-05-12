'use strict';

/**
 * news-impact.js — cache in-memory de news alerts por (sport, team_norm).
 *
 * News monitor (cron 15min via lib/agents-extended.runNewsMonitor) classifica
 * RSS items em critical (cancelled/postponed/withdrawal/forfeit/DQ/ban) ou
 * warning (injury/sick/stand-in/sub/roster change). Esse módulo expõe lookup
 * O(1) pra pre-emission gate em /record-tip consultar antes de gravar tip.
 *
 * Fecha gap "News é alert-only, não alimenta decisão de tip" — antes só DM admin.
 *
 * P2-compliance: news é causa REAL (notícia publicada por fonte), tip é real,
 * ação em real é OK. Não confundir com shadow data (que não dispara ação).
 *
 * TTL: 3h pós pub_ts (ou 3h pós agora se sem pub_ts). Notícias velhas perdem
 * relevância — match já tá rolando, info já está price-in.
 *
 * Uso (cache populate):
 *   const { updateImpactFromAlerts } = require('./news-impact');
 *   updateImpactFromAlerts(result.alerts);
 *
 * Uso (gate consume):
 *   const { getImpact } = require('./news-impact');
 *   const impact = getImpact('lol', 'T1', 'GenG');  // { severity, title, source, pub_ts, expiresAt } | null
 *   if (impact?.severity === 'critical') return skip;
 */

const TTL_MS = 3 * 60 * 60 * 1000; // 3h
const _impactByKey = new Map(); // key = `${sport}::${team_norm}` → { severity, title, source, pub_ts, expiresAt }

function _normTeam(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
}

function _key(sport, teamNorm) {
  return `${String(sport || '').toLowerCase()}::${teamNorm}`;
}

function _sweep() {
  const now = Date.now();
  for (const [k, v] of _impactByKey) {
    if (v.expiresAt <= now) _impactByKey.delete(k);
  }
}

function updateImpactFromAlerts(alerts) {
  if (!Array.isArray(alerts) || !alerts.length) return 0;
  _sweep();
  let upserts = 0;
  for (const a of alerts) {
    if (!a?.severity || !a?.sport) continue;
    if (!['critical', 'warning'].includes(a.severity)) continue;
    const teams = Array.isArray(a.affected_teams) ? a.affected_teams : [];
    if (!teams.length) continue;
    const baseTs = Number.isFinite(a.pub_ts) ? a.pub_ts : Date.now();
    const expiresAt = baseTs + TTL_MS;
    if (expiresAt <= Date.now()) continue; // já expirado
    for (const teamRaw of teams) {
      const teamNorm = _normTeam(teamRaw);
      if (!teamNorm || teamNorm.length < 3) continue;
      const k = _key(a.sport, teamNorm);
      const existing = _impactByKey.get(k);
      // Upsert: mantém mais severo (critical > warning), e mais recente em tie.
      if (existing) {
        const sevRank = (s) => s === 'critical' ? 2 : s === 'warning' ? 1 : 0;
        if (sevRank(a.severity) < sevRank(existing.severity)) continue;
        if (sevRank(a.severity) === sevRank(existing.severity) && baseTs <= existing.pub_ts) continue;
      }
      _impactByKey.set(k, {
        severity: a.severity,
        title: a.title || '',
        source: a.source || '',
        pub_ts: baseTs,
        expiresAt,
      });
      upserts++;
    }
  }
  return upserts;
}

function getImpact(sport, ...teamNames) {
  if (!sport) return null;
  _sweep();
  // Mapeia esports legacy → bucket único 'esports' usado nas sources Google News
  const sportLow = String(sport).toLowerCase();
  const sportsToCheck = ['lol', 'dota2', 'valorant'].includes(sportLow)
    ? [sportLow, 'esports']
    : [sportLow];
  let worst = null;
  const sevRank = (s) => s === 'critical' ? 2 : s === 'warning' ? 1 : 0;
  for (const team of teamNames) {
    const teamNorm = _normTeam(team);
    if (!teamNorm || teamNorm.length < 3) continue;
    for (const sp of sportsToCheck) {
      const hit = _impactByKey.get(_key(sp, teamNorm));
      if (!hit) continue;
      if (!worst || sevRank(hit.severity) > sevRank(worst.severity)) {
        worst = { ...hit, team: teamNorm, sport: sp };
      }
    }
  }
  return worst;
}

function getStats() {
  _sweep();
  const byS = {};
  for (const [k, v] of _impactByKey) {
    const [sport] = k.split('::');
    byS[sport] = byS[sport] || { critical: 0, warning: 0 };
    byS[sport][v.severity]++;
  }
  return { total_entries: _impactByKey.size, by_sport: byS };
}

function _clear() {
  _impactByKey.clear();
}

module.exports = { updateImpactFromAlerts, getImpact, getStats, _clear, _normTeam };
