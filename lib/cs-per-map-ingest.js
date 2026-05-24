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

const { getCsMatchMapResults, getHltvMatchId, findHltvFinishedMatchByTeams, findHltvFinishedMatchByTeamPages, namesMatch } = require('./hltv');
const { fetchCsMatchMapStats } = require('./pandascore-cs-stats');
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

  // 2026-05-21 Plan C: PandaScore PRIMARY (API JSON, sem CF block).
  // PS match_id format: 'cs2_ps_<N>' OR 'csgo_ps_<N>' OR raw 'hltv_<N>'.
  // Strategy:
  //   1. PandaScore (API JSON, mais confiável)
  //   2. HLTV embedded ID (match_id LIKE 'hltv_%')
  //   3. HLTV live lookup (getHltvMatchId)
  //   4. HLTV finished scrape (findHltvFinishedMatchByTeams)
  // Para each strategy, return on first success.
  let maps = null;
  let source = null;
  let resolvedTeam1 = mr.team1;
  let resolvedTeam2 = mr.team2;

  // Strategy 1: PandaScore (preferido — sem scraping)
  const psMatch = String(mr.match_id || '').match(/^(?:cs2|csgo|cs)_ps_(\d+)$/i);
  if (psMatch) {
    try {
      const psRes = await fetchCsMatchMapStats(psMatch[1]);
      if (psRes.ok && psRes.maps?.length > 0) {
        // PS já alinha results por team_id (rounds_t1 = mr.team1's rounds via opponents[0])
        // Mas mr.team1 ordering pode differ de PS opponents[0] (e.g., quando match_results
        // foi populado por outro source). Realign via namesMatch.
        const psT1Match = namesMatch(psRes.team1, mr.team1);
        const psT1IsMrT1 = psT1Match;
        maps = psRes.maps.map(g => ({
          map: g.map,
          mapName: g.mapName,
          rounds_t1: psT1IsMrT1 ? g.rounds_t1 : g.rounds_t2,
          rounds_t2: psT1IsMrT1 ? g.rounds_t2 : g.rounds_t1,
          winner: g.winner,
          length_s: g.length_s,
        }));
        source = 'pandascore';
      }
    } catch (_) {}
  }

  // Strategy 2-4: HLTV fallback (apenas se PS não funcionou)
  if (!maps) {
    let hltvId = null;
    const hltvEmbed = String(mr.match_id || '').match(/hltv_(\d+)/i);
    if (hltvEmbed) {
      hltvId = hltvEmbed[1];
    } else {
      try {
        const r = await getHltvMatchId(mr.team1, mr.team2, mr.resolved_at);
        if (r && r.matchId) hltvId = String(r.matchId);
      } catch (_) {}
      if (!hltvId) {
        try {
          const fid = await findHltvFinishedMatchByTeams(mr.team1, mr.team2, mr.resolved_at);
          if (fid) hltvId = String(fid);
        } catch (_) {}
      }
      // Strategy 5 (NEW 2026-05-21): team page lookup via findTeamId + parseTeamRecent.
      // /search e /team/{id}/{slug} são NÃO bloqueados (vs /results CF-block).
      // Match score se disponível pra refinar candidates.
      if (!hltvId) {
        try {
          // Extract series score do final_score "Bo3 2-1" → "2-1"
          const fsMatch = String(mr.final_score || '').match(/(\d+\s*[-–]\s*\d+)/);
          const seriesScore = fsMatch ? fsMatch[1].replace(/\s/g, '').replace('–', '-') : null;
          const fid = await findHltvFinishedMatchByTeamPages(mr.team1, mr.team2, mr.resolved_at, seriesScore);
          if (fid) hltvId = String(fid);
        } catch (_) {}
      }
    }
    if (hltvId) {
      let raw;
      try {
        raw = await getCsMatchMapResults(hltvId);
      } catch (e) {
        return { ok: false, reason: `hltv_err: ${e.message}` };
      }
      if (raw && Array.isArray(raw) && raw.length > 0) {
        maps = raw
          .filter(m => m.played && m.score)
          .map(m => {
            const sm = String(m.score).match(/^(\d+)\s*-\s*(\d+)$/);
            if (!sm) return null;
            const s1 = parseInt(sm[1], 10);
            const s2 = parseInt(sm[2], 10);
            let rounds_t1, rounds_t2;
            const winnerIsT1 = m.winner && namesMatch(m.winner, mr.team1);
            const winnerIsT2 = m.winner && namesMatch(m.winner, mr.team2);
            if (winnerIsT1) { rounds_t1 = Math.max(s1, s2); rounds_t2 = Math.min(s1, s2); }
            else if (winnerIsT2) { rounds_t1 = Math.min(s1, s2); rounds_t2 = Math.max(s1, s2); }
            else { rounds_t1 = s1; rounds_t2 = s2; }
            return { map: m.map, mapName: m.mapName, rounds_t1, rounds_t2, winner: m.winner };
          })
          .filter(Boolean);
        if (maps.length) source = 'hltv';
      }
    }
  }

  if (!maps || !maps.length) return { ok: false, reason: 'no_source_data_available' };

  const payload = {
    maps,
    source,
    ingested_at: new Date().toISOString(),
  };

  try {
    db.prepare(`UPDATE match_results SET result_meta_json = ? WHERE match_id = ?`)
      .run(JSON.stringify(payload), mr.match_id);
    // 2026-05-21: propaga result_meta_json pra OUTRAS rows do mesmo match
    // (cs2_ps_* da PandaScore tem mesmo match real mas match_id diferente).
    // Settle handler busca por match_id direto, então copy garante per-map data
    // disponível pro tip independente do source row. Match por team1+team2 +
    // resolved_at ±1d window.
    const propaCount = db.prepare(`
      UPDATE match_results
      SET result_meta_json = ?
      WHERE game IN ('cs', 'cs2', 'counterstrike')
        AND match_id != ?
        AND (result_meta_json IS NULL OR result_meta_json NOT LIKE '%"maps":%')
        AND lower(team1) = lower(?) AND lower(team2) = lower(?)
        AND ABS(julianday(resolved_at) - julianday(?)) < 1.0
    `).run(JSON.stringify(payload), mr.match_id, mr.team1, mr.team2, mr.resolved_at);
    // Tentativa simétrica (team1↔team2 swap em alguns sources)
    const propaCountSwap = db.prepare(`
      UPDATE match_results
      SET result_meta_json = ?
      WHERE game IN ('cs', 'cs2', 'counterstrike')
        AND match_id != ?
        AND (result_meta_json IS NULL OR result_meta_json NOT LIKE '%"maps":%')
        AND lower(team1) = lower(?) AND lower(team2) = lower(?)
        AND ABS(julianday(resolved_at) - julianday(?)) < 1.0
    `).run(JSON.stringify(payload), mr.match_id, mr.team2, mr.team1, mr.resolved_at);
    const totalProp = (propaCount?.changes || 0) + (propaCountSwap?.changes || 0);
    log('INFO', 'CS-PERMAP-INGEST', `${mr.team1} vs ${mr.team2} (${mr.match_id}): ingested ${maps.length} maps via ${source}${totalProp ? ` (+propagated ${totalProp} cross-rows)` : ''}`);
    return { ok: true, source, maps_count: maps.length, propagated: totalProp };
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
  // 2026-05-21: PRIORITIZE hltv_* rows (têm matchId direto extraível) — populated
  // pelo cron syncHltvResults (lib/hltv-results-sync). cs2_ps_* rows precisam lookup
  // findHltvFinishedMatchByTeams que tem sido instável (CF block). Buscar hltv_*
  // PRIMEIRO, depois propagar result_meta_json pra cs2_ps_* rows com teams+date match.
  const rows = db.prepare(`
    SELECT match_id, game, team1, team2, winner, final_score, resolved_at, result_meta_json
    FROM match_results
    WHERE game IN ('cs', 'cs2', 'counterstrike')
      AND winner IS NOT NULL
      AND resolved_at >= ?
      AND (result_meta_json IS NULL OR result_meta_json NOT LIKE '%"maps":%')
    ORDER BY
      CASE WHEN match_id LIKE 'hltv_%' THEN 0 ELSE 1 END,
      resolved_at DESC
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

  const _reasonAgg = {};
  for (const e of out.errors) {
    const cat = String(e?.reason || 'unknown').split(':')[0].trim();
    _reasonAgg[cat] = (_reasonAgg[cat] || 0) + 1;
  }
  const _reasonsTop = Object.entries(_reasonAgg).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c, n]) => `${c}=${n}`).join(', ');
  log('INFO', 'CS-PERMAP-INGEST', `bulk done: examined=${out.examined} ingested=${out.ingested} skipped=${out.skipped} errors=${out.errors.length}${_reasonsTop ? ` | top reasons: ${_reasonsTop}` : ''}`);
  return out;
}

module.exports = {
  ingestForMatch,
  bulkIngest,
};
