'use strict';

/**
 * lib/cs-per-map-ingest.js — popula match_results.result_meta_json com per-map
 * round scores via HLTV proxy. Habilita settle de handicap_rounds_mapN +
 * total_rounds_mapN markets.
 *
 * Estrutura result_meta_json populado:
 *   {
 *     maps: [
 *       { map: 1, mapName: 'Inferno', rounds_t1: 16, rounds_t2: 12, winner: 'NaVi' },
 *       { map: 2, mapName: 'Mirage',  rounds_t1: 8,  rounds_t2: 16, winner: 'Spirit' },
 *       ...
 *     ],
 *     source: 'hltv',
 *     ingested_at: '2026-05-21T15:30:00Z'
 *   }
 *
 * Strategy: lazy + bulk
 *   - Lazy: handler de settle chama ingestForMatch() se result_meta_json IS NULL
 *   - Bulk: cron/endpoint chama bulkIngest() pra todos CS matches resolved sem meta
 *
 * Idempotent: skip se result_meta_json já tem maps[] populated.
 */

const { getCsMatchMapResults, getHltvMatchId, findHltvFinishedMatchByTeams, namesMatch } = require('./hltv');
const { log } = require('./utils');

/**
 * Ingest per-map rounds para UM match já resolved.
 *
 * @param {Database} db
 * @param {object} mr — row from match_results (deve ter team1, team2, winner, resolved_at)
 * @returns {Promise<{ok:boolean, source?:string, maps_count?:number, reason?:string}>}
 */
async function ingestForMatch(db, mr) {
  if (!mr || !mr.match_id) return { ok: false, reason: 'no_match_row' };
  if (!mr.winner) return { ok: false, reason: 'not_resolved' };

  // Skip se já populado
  try {
    if (mr.result_meta_json) {
      const existing = JSON.parse(mr.result_meta_json);
      if (existing?.maps?.length > 0) {
        return { ok: true, source: 'cache', maps_count: existing.maps.length };
      }
    }
  } catch (_) { /* malformed — re-ingest */ }

  // HLTV match_id pode estar embedded em match_id ('hltv_NNNN') ou precisa lookup.
  // Tentar 3 estratégias em ordem: embedded → getHltvMatchId (live/upcoming) →
  // findHltvFinishedMatchByTeams (scrape /results). Última cobre matches já
  // finished que /api/matches não retorna mais.
  let hltvId = null;
  const m = String(mr.match_id || '').match(/hltv_(\d+)/i);
  if (m) {
    hltvId = m[1];
  } else {
    // Strategy 2: live/upcoming match lookup
    try {
      const r = await getHltvMatchId(mr.team1, mr.team2, mr.resolved_at);
      // getHltvMatchId returns { matchId, live, url, event } object OR null
      if (r && r.matchId) hltvId = String(r.matchId);
    } catch (_) {}
    // Strategy 3: scrape /results pra matches já finished
    if (!hltvId) {
      try {
        const fid = await findHltvFinishedMatchByTeams(mr.team1, mr.team2, mr.resolved_at);
        if (fid) hltvId = String(fid);
      } catch (_) {}
    }
    if (!hltvId) return { ok: false, reason: 'hltv_id_not_found' };
  }

  // Fetch per-map results
  let raw;
  try {
    raw = await getCsMatchMapResults(hltvId);
  } catch (e) {
    return { ok: false, reason: `hltv_err: ${e.message}` };
  }
  if (!raw || !Array.isArray(raw) || raw.length === 0) {
    return { ok: false, reason: 'hltv_no_maps' };
  }

  // Parse rounds_t1/t2 from score "16-12" + alinhar com mr.team1/team2 order.
  // HLTV order may differ (left/right teams). namesMatch tolera fuzzy.
  const maps = raw
    .filter(m => m.played && m.score)
    .map(m => {
      const sm = String(m.score).match(/^(\d+)\s*-\s*(\d+)$/);
      if (!sm) return null;
      const s1 = parseInt(sm[1], 10);
      const s2 = parseInt(sm[2], 10);
      // HLTV winner name → identificar se é mr.team1 ou mr.team2
      let rounds_t1, rounds_t2;
      const winnerIsT1 = m.winner && namesMatch(m.winner, mr.team1);
      const winnerIsT2 = m.winner && namesMatch(m.winner, mr.team2);
      if (winnerIsT1) {
        // mr.team1 venceu — maior score é dele
        rounds_t1 = Math.max(s1, s2);
        rounds_t2 = Math.min(s1, s2);
      } else if (winnerIsT2) {
        rounds_t1 = Math.min(s1, s2);
        rounds_t2 = Math.max(s1, s2);
      } else {
        // Sem winner match — assume HLTV left=team1 order (best-effort)
        rounds_t1 = s1;
        rounds_t2 = s2;
      }
      return {
        map: m.map,
        mapName: m.mapName,
        rounds_t1,
        rounds_t2,
        winner: m.winner,
      };
    })
    .filter(Boolean);

  if (!maps.length) return { ok: false, reason: 'hltv_parse_empty' };

  const payload = {
    maps,
    source: 'hltv',
    ingested_at: new Date().toISOString(),
  };

  try {
    db.prepare(`UPDATE match_results SET result_meta_json = ? WHERE match_id = ?`)
      .run(JSON.stringify(payload), mr.match_id);
    log('INFO', 'CS-PERMAP-INGEST', `${mr.team1} vs ${mr.team2} (${mr.match_id}): ingested ${maps.length} maps via HLTV`);
    return { ok: true, source: 'hltv', maps_count: maps.length };
  } catch (e) {
    return { ok: false, reason: `db_err: ${e.message}` };
  }
}

/**
 * Bulk ingest pra todos CS matches resolved nos últimos N dias sem result_meta_json.
 *
 * @param {Database} db
 * @param {object} opts — { days=14, limit=50, dryRun=false }
 * @returns {Promise<{examined:number, ingested:number, skipped:number, errors:array}>}
 */
async function bulkIngest(db, opts = {}) {
  const days = Math.max(1, Math.min(30, parseInt(opts.days || 14, 10) || 14));
  const limit = Math.max(1, Math.min(200, parseInt(opts.limit || 50, 10) || 50));
  const dryRun = !!opts.dryRun;
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

  // CS uses game='cs2' OR similar. Schema mostra game column.
  const rows = db.prepare(`
    SELECT match_id, game, team1, team2, winner, final_score, resolved_at, result_meta_json
    FROM match_results
    WHERE game IN ('cs', 'cs2', 'counterstrike')
      AND winner IS NOT NULL
      AND resolved_at >= ?
      AND (result_meta_json IS NULL OR result_meta_json NOT LIKE '%"maps":%')
    ORDER BY resolved_at DESC
    LIMIT ?
  `).all(cutoff, limit);

  const out = { examined: rows.length, ingested: 0, skipped: 0, errors: [], samples: [] };

  for (const mr of rows) {
    if (dryRun) {
      out.samples.push({ match_id: mr.match_id, team1: mr.team1, team2: mr.team2, resolved_at: mr.resolved_at });
      continue;
    }
    const r = await ingestForMatch(db, mr);
    if (r.ok) {
      out.ingested++;
      out.samples.push({ match_id: mr.match_id, maps: r.maps_count, source: r.source });
    } else {
      out.skipped++;
      out.errors.push({ match_id: mr.match_id, reason: r.reason });
    }
    // Rate-limit HLTV: 1.5s entre calls
    await new Promise(r => setTimeout(r, 1500));
  }

  log('INFO', 'CS-PERMAP-INGEST', `bulk done: examined=${out.examined} ingested=${out.ingested} skipped=${out.skipped} errors=${out.errors.length}`);
  return out;
}

module.exports = {
  ingestForMatch,
  bulkIngest,
};
