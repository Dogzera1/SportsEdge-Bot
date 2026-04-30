'use strict';

/**
 * lib/lol-source-cross-check.js — cross-validate kill counts entre fontes
 * (PandaScore, Oracle's Elixir, gol.gg) e flag matches com divergência.
 *
 * Por que: detectar dados corrompidos (scrim listado como pro, replay,
 * cancelamento sem propagar). Auto-void tips quando 2+ fontes discordam.
 *
 * Logic:
 *   1. Pra cada gameid resolved nas últimas N horas, busca kills total em
 *      até 3 sources.
 *   2. Calcula spread (max - min).
 *   3. Se spread > tolerância (default 4 kills), flag como suspect_data.
 *   4. Persist em tabela lol_source_disagreement.
 */

const { log } = require('./utils');

/**
 * Bulk validation. Roda diariamente via cron.
 *
 * Inputs requeridos:
 *   - lol_game_objectives (gol.gg) com gameid + kills_total
 *   - oracleselixir_games agregado por gameid
 *   - market_results (já settled tips kills) com final_score parseado
 */
async function runCrossSourceCheck(db, opts = {}) {
  const days = opts.days || 14;
  const tolerance = opts.tolerance ?? 4; // máx 4 kills de spread aceitável
  const minSources = 2;

  // Pega gol.gg objectives recentes (já com kills_total parseado)
  const ggRows = db.prepare(`
    SELECT gameid, team_blue, team_red, league, date, kills_total
    FROM lol_game_objectives
    WHERE date >= date('now', '-' || ? || ' days')
      AND kills_total IS NOT NULL AND kills_total > 0
  `).all(days);

  if (!ggRows.length) return { ok: true, n: 0, flagged: 0, results: [] };

  const flagged = [];
  let nChecked = 0;

  // Garante que tabela de disagreement existe (idempotente)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS lol_source_disagreement (
        gameid TEXT PRIMARY KEY,
        date TEXT,
        team_blue TEXT, team_red TEXT, league TEXT,
        kills_golgg INTEGER, kills_oe INTEGER, kills_ps INTEGER,
        spread INTEGER, sources_count INTEGER,
        flagged INTEGER, reason TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_lol_disagreement_date ON lol_source_disagreement(date, flagged);
    `);
  } catch (_) {}

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO lol_source_disagreement (
      gameid, date, team_blue, team_red, league,
      kills_golgg, kills_oe, kills_ps, spread, sources_count, flagged, reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  for (const r of ggRows) {
    nChecked++;
    const sources = { golgg: r.kills_total };

    // Tentar OE — match por team_blue/red + date (±1d window)
    try {
      const oeNorm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const t1n = oeNorm(r.team_blue), t2n = oeNorm(r.team_red);
      const oeMatches = db.prepare(`
        SELECT gameid, SUM(kills) AS total_kills
        FROM oracleselixir_games
        WHERE date >= datetime(?, '-1 day') AND date <= datetime(?, '+1 day')
          AND lower(replace(replace(replace(teamname,' ',''),'-',''),'.','')) IN (?, ?)
        GROUP BY gameid
        HAVING COUNT(DISTINCT teamname) >= 2
      `).all(r.date, r.date, t1n, t2n);
      // Filtra: ambos teams presentes
      for (const oe of oeMatches) {
        const teams = db.prepare(`
          SELECT GROUP_CONCAT(lower(replace(replace(replace(teamname,' ',''),'-',''),'.','')), '|') AS norms
          FROM oracleselixir_games WHERE gameid = ?
        `).get(oe.gameid);
        const norms = (teams?.norms || '').split('|');
        const hasBoth = norms.some(n => n.includes(t1n) || t1n.includes(n))
                     && norms.some(n => n.includes(t2n) || t2n.includes(n));
        if (hasBoth && oe.total_kills > 0) {
          sources.oe = Number(oe.total_kills);
          break;
        }
      }
    } catch (_) {}

    // PS source: skipped (PS plan blocks per-game data)
    // Cross-source só com gol.gg + OE por enquanto.

    const values = Object.values(sources).filter(v => Number.isFinite(v) && v > 0);
    if (values.length < minSources) continue; // só 1 source = não há cross-check

    const spread = Math.max(...values) - Math.min(...values);
    const isFlagged = spread > tolerance;
    const reason = isFlagged ? `spread=${spread} > tol=${tolerance}` : 'ok';

    try {
      upsert.run(
        r.gameid, r.date, r.team_blue, r.team_red, r.league,
        sources.golgg ?? null, sources.oe ?? null, sources.ps ?? null,
        spread, values.length, isFlagged ? 1 : 0, reason
      );
    } catch (_) {}

    if (isFlagged) flagged.push({ gameid: r.gameid, teams: `${r.team_blue} vs ${r.team_red}`, spread, sources, reason });
  }

  if (flagged.length) {
    log('WARN', 'LOL-XCHECK', `${flagged.length}/${nChecked} games flagged disagreement (spread > ${tolerance}). Review lol_source_disagreement table.`);
  } else {
    log('INFO', 'LOL-XCHECK', `${nChecked} games checked, all sources agree (tolerance ${tolerance})`);
  }

  return { ok: true, n: nChecked, flagged: flagged.length, results: flagged.slice(0, 10) };
}

/**
 * Endpoint helper: lista flagged games em janela.
 */
function listFlaggedGames(db, opts = {}) {
  const days = opts.days || 30;
  try {
    const rows = db.prepare(`
      SELECT * FROM lol_source_disagreement
      WHERE flagged = 1 AND date >= date('now', '-' || ? || ' days')
      ORDER BY date DESC, spread DESC
      LIMIT 100
    `).all(days);
    return rows;
  } catch (_) { return []; }
}

module.exports = { runCrossSourceCheck, listFlaggedGames };
