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

/**
 * Runtime gate: dado um par de teams, verifica se há disagreement flagged
 * recente em qualquer dos teams (gol.gg ↔ OE divergem nos últimos N dias).
 * Use antes de emitir tip kills — dados ruins → modelo enganado.
 *
 * Retorna { blocked: bool, reason?, evidence? }.
 */
function hasRecentSourceDisagreement(db, team1, team2, opts = {}) {
  const days = opts.days ?? 7;
  // Sinal forte (ambos os times no mesmo flagged game) bloqueia com qualquer spread > tolerance.
  // Sinal fraco (um dos times num flagged game contra terceiro) só bloqueia se spread for severo,
  // pra evitar sequestrar matches futuros do time por 7d com base num único outlier moderado.
  const _envWeak = Number(process.env.LOL_KILLS_XCHECK_WEAK_MIN_SPREAD);
  const weakMinSpread = Number.isFinite(opts.weakMinSpread) ? opts.weakMinSpread
    : (Number.isFinite(_envWeak) ? _envWeak : 20);
  if (!db || !team1 || !team2) return { blocked: false };
  try {
    const _norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const t1n = _norm(team1), t2n = _norm(team2);
    if (!t1n || !t2n) return { blocked: false };
    const rows = db.prepare(`
      SELECT gameid, date, team_blue, team_red, spread, kills_golgg, kills_oe, reason
      FROM lol_source_disagreement
      WHERE flagged = 1
        AND date >= date('now', '-' || ? || ' days')
      LIMIT 200
    `).all(days);
    let weakHit = null;
    for (const r of rows) {
      const bn = _norm(r.team_blue), rn = _norm(r.team_red);
      const t1HitB = bn === t1n || bn.includes(t1n) || t1n.includes(bn);
      const t1HitR = rn === t1n || rn.includes(t1n) || t1n.includes(rn);
      const t2HitB = bn === t2n || bn.includes(t2n) || t2n.includes(bn);
      const t2HitR = rn === t2n || rn.includes(t2n) || t2n.includes(rn);
      if ((t1HitB && t2HitR) || (t1HitR && t2HitB)) {
        return {
          blocked: true,
          reason: `cross-source disagreement game ${r.gameid} (${r.date}): golgg=${r.kills_golgg} vs OE=${r.kills_oe} spread=${r.spread}`,
          evidence: r,
        };
      }
      // Sinal fraco: rastreia o pior spread encontrado, decide depois do loop.
      if ((t1HitB || t1HitR || t2HitB || t2HitR) && (!weakHit || r.spread > weakHit.spread)) {
        weakHit = { row: r, side: t1HitB || t1HitR ? team1 : team2 };
      }
    }
    if (weakHit && weakHit.row.spread >= weakMinSpread) {
      return {
        blocked: true,
        reason: `team ${weakHit.side} teve game flagged ${weakHit.row.gameid} (${weakHit.row.date}): spread=${weakHit.row.spread} ≥ ${weakMinSpread}`,
        evidence: weakHit.row,
      };
    }
    return { blocked: false };
  } catch (_) { return { blocked: false }; }
}

module.exports = { runCrossSourceCheck, listFlaggedGames, hasRecentSourceDisagreement };
