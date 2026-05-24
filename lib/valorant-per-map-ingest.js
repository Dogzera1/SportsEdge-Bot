'use strict';

/**
 * lib/valorant-per-map-ingest.js — popula match_results.result_meta_json com
 * per-map round scores via VLR.gg scraper (lib/vlr).
 * Mirror lib/cs-per-map-ingest mas usando getValorantMatchMapResults() ao
 * invés de HLTV.
 *
 * Estrutura result_meta_json populado (idêntica CS):
 *   {
 *     maps: [
 *       { map: 1, mapName: 'Ascent', rounds_t1: 13, rounds_t2: 11, winner: 'Sentinels' },
 *       ...
 *     ],
 *     source: 'vlr',
 *     ingested_at: '...'
 *   }
 *
 * Settle handler em lib/market-tips-shadow já lê result_meta_json.maps[]
 * agnóstico ao source (HLTV ou VLR) — mesma estrutura.
 */

const { getValorantMatchMapResults } = require('./vlr');
const { log } = require('./utils');

function _normName(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}

async function ingestForMatch(db, mr) {
  if (!mr || !mr.match_id) return { ok: false, reason: 'no_match_row' };
  if (!mr.winner) return { ok: false, reason: 'not_resolved' };

  try {
    if (mr.result_meta_json) {
      const existing = JSON.parse(mr.result_meta_json);
      if (existing?.maps?.length > 0) {
        return { ok: true, source: 'cache', maps_count: existing.maps.length };
      }
    }
  } catch (_) { /* malformed */ }

  let raw;
  try {
    const sentMs = mr.resolved_at ? new Date(mr.resolved_at).getTime() : Date.now();
    raw = await getValorantMatchMapResults(mr.team1, mr.team2, sentMs);
  } catch (e) {
    return { ok: false, reason: `vlr_err: ${e.message}` };
  }
  if (!raw || !Array.isArray(raw.maps) || raw.maps.length === 0) {
    return { ok: false, reason: 'vlr_no_maps' };
  }

  const n1 = _normName(mr.team1);
  const n2 = _normName(mr.team2);
  const vlrT1 = _normName(raw.team1);
  const vlrT2 = _normName(raw.team2);
  // Orientation: VLR team1 == mr.team1?
  let vlrT1IsMrT1;
  if (vlrT1 === n1 || vlrT1.includes(n1) || n1.includes(vlrT1)) vlrT1IsMrT1 = true;
  else if (vlrT2 === n1 || vlrT2.includes(n1) || n1.includes(vlrT2)) vlrT1IsMrT1 = false;
  else { vlrT1IsMrT1 = true; /* fallback assume positional */ }

  const maps = raw.maps
    .filter(m => m.played && m.score)
    .map(m => {
      const sm = String(m.score).match(/^(\d+)\s*-\s*(\d+)$/);
      if (!sm) return null;
      const s1 = parseInt(sm[1], 10);
      const s2 = parseInt(sm[2], 10);
      // VLR score order matches raw.team1 / raw.team2 (left/right). Realign pra mr.team1/team2.
      const rounds_t1 = vlrT1IsMrT1 ? s1 : s2;
      const rounds_t2 = vlrT1IsMrT1 ? s2 : s1;
      return {
        map: m.map,
        mapName: m.mapName,
        rounds_t1,
        rounds_t2,
        winner: m.winner,
      };
    })
    .filter(Boolean);

  if (!maps.length) return { ok: false, reason: 'vlr_parse_empty' };

  const payload = {
    maps,
    source: 'vlr',
    ingested_at: new Date().toISOString(),
  };

  try {
    db.prepare(`UPDATE match_results SET result_meta_json = ? WHERE match_id = ?`)
      .run(JSON.stringify(payload), mr.match_id);
    log('INFO', 'VAL-PERMAP-INGEST', `${mr.team1} vs ${mr.team2} (${mr.match_id}): ingested ${maps.length} maps via VLR (id=${raw.vlrMatchId})`);
    return { ok: true, source: 'vlr', maps_count: maps.length };
  } catch (e) {
    return { ok: false, reason: `db_err: ${e.message}` };
  }
}

async function bulkIngest(db, opts = {}) {
  const days = Math.max(1, Math.min(30, parseInt(opts.days || 14, 10) || 14));
  const limit = Math.max(1, Math.min(200, parseInt(opts.limit || 30, 10) || 30));
  const dryRun = !!opts.dryRun;
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

  const rows = db.prepare(`
    SELECT match_id, game, team1, team2, winner, final_score, resolved_at, result_meta_json
    FROM match_results
    WHERE game = 'valorant'
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
    // Rate-limit VLR scraper: 2s entre calls (mais conservador que HLTV).
    await new Promise(r => setTimeout(r, 2000));
  }

  const _reasonAgg = {};
  for (const e of out.errors) {
    const cat = String(e?.reason || 'unknown').split(':')[0].trim();
    _reasonAgg[cat] = (_reasonAgg[cat] || 0) + 1;
  }
  const _reasonsTop = Object.entries(_reasonAgg).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c, n]) => `${c}=${n}`).join(', ');
  log('INFO', 'VAL-PERMAP-INGEST', `bulk done: examined=${out.examined} ingested=${out.ingested} skipped=${out.skipped} errors=${out.errors.length}${_reasonsTop ? ` | top reasons: ${_reasonsTop}` : ''}`);
  return out;
}

module.exports = {
  ingestForMatch,
  bulkIngest,
};
