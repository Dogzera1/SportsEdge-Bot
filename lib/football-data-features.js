'use strict';

/**
 * lib/football-data-features.js — features derivadas de football_data_csv
 * pra alimentar Poisson model.
 *
 * Public API:
 *   getShotXgForm(db, team, opts)        — xG proxy via shots × 0.32 conversion
 *   getClosingOddsBenchmark(db, home, away) — mercado consensus retroativo
 *   getMarketDivergence(modelP, marketP)  — diff %, pra confidence adjustment
 *
 * xG proxy: HST (shots on target) × 0.32 ≈ xG (lit avg conversion 30-32%).
 * Útil pra detectar times com under-/over-performance (goals != xG).
 */

const _norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Shot-based xG form per team, últimos N dias.
 * Retorna { n, xg_for_pg, xg_against_pg, goals_for_pg, finishing_index }.
 *   finishing_index = goals_for / xg_for ; >1 = sobre-performance, <1 = sub.
 */
function getShotXgForm(db, team, opts = {}) {
  const days = opts.days ?? 60;
  if (!team) return null;
  const teamN = _norm(team);
  try {
    const rows = db.prepare(`
      SELECT
        date,
        home, away,
        fthg, ftag,
        b365_h, b365_d, b365_a,
        ps_h, ps_d, ps_a
      FROM football_data_csv
      WHERE (lower(replace(replace(replace(home,' ',''),'-',''),'.','')) = ?
          OR lower(replace(replace(replace(away,' ',''),'-',''),'.','')) = ?)
        AND fthg IS NOT NULL
        AND date IS NOT NULL
      ORDER BY date DESC
      LIMIT ?
    `).all(teamN, teamN, Math.min(40, Math.max(5, opts.maxRows ?? 20)));
    if (!rows.length) return null;

    // Pega HS/AS/HST/AST se schema tem (added in v2 maybe)
    let n = 0;
    let goalsFor = 0, goalsAgainst = 0;
    let shotsFor = 0, shotsAgainst = 0; // se disponível
    let sotFor = 0, sotAgainst = 0;
    for (const r of rows) {
      const isHome = _norm(r.home) === teamN;
      n++;
      if (isHome) {
        goalsFor += Number(r.fthg) || 0;
        goalsAgainst += Number(r.ftag) || 0;
      } else {
        goalsFor += Number(r.ftag) || 0;
        goalsAgainst += Number(r.fthg) || 0;
      }
    }
    if (n < 3) return null;
    const goalsForPg = goalsFor / n;
    const goalsAgainstPg = goalsAgainst / n;
    return {
      n,
      goals_for_pg: +goalsForPg.toFixed(2),
      goals_against_pg: +goalsAgainstPg.toFixed(2),
      // Shot-based xG seria HST*0.32. Sem HST nas cols atuais → null.
      // TODO: extender schema pra incluir HS/AS/HST/AST.
      xg_for_pg: null,
      xg_against_pg: null,
      finishing_index: null,
    };
  } catch (e) { return null; }
}

/**
 * Closing odds benchmark: pulls últimas N partidas entre os teams (h2h direto)
 * + média das closing odds (PS = Pinnacle Sharp Closing). Retorna implied prob
 * normalizada (de-juiced).
 */
function getClosingOddsBenchmark(db, home, away, opts = {}) {
  const days = opts.days ?? 365;
  const homeN = _norm(home), awayN = _norm(away);
  if (!homeN || !awayN) return null;
  try {
    const rows = db.prepare(`
      SELECT date, home, away, fthg, ftag, ftr, ps_h, ps_d, ps_a
      FROM football_data_csv
      WHERE ((lower(replace(replace(replace(home,' ',''),'-',''),'.','')) = ?
              AND lower(replace(replace(replace(away,' ',''),'-',''),'.','')) = ?)
          OR (lower(replace(replace(replace(home,' ',''),'-',''),'.','')) = ?
              AND lower(replace(replace(replace(away,' ',''),'-',''),'.','')) = ?))
        AND ps_h IS NOT NULL AND ps_d IS NOT NULL AND ps_a IS NOT NULL
      ORDER BY date DESC
      LIMIT 8
    `).all(homeN, awayN, awayN, homeN);
    if (!rows.length) return null;

    let sumPH = 0, sumPD = 0, sumPA = 0;
    let nValid = 0;
    let h2hHomeWins = 0, h2hAwayWins = 0, h2hDraws = 0;
    for (const r of rows) {
      const oH = Number(r.ps_h), oD = Number(r.ps_d), oA = Number(r.ps_a);
      if (!Number.isFinite(oH) || oH <= 1 || !Number.isFinite(oD) || !Number.isFinite(oA)) continue;
      // Implied probs + normaliza (de-juice)
      const iH = 1 / oH, iD = 1 / oD, iA = 1 / oA;
      const sum = iH + iD + iA;
      if (sum <= 0) continue;
      // Se row é "team-roles flipped" (away virou home no histórico), inverte
      const isFlipped = _norm(r.home) === awayN;
      const pH = (isFlipped ? iA : iH) / sum;
      const pD = iD / sum;
      const pA = (isFlipped ? iH : iA) / sum;
      sumPH += pH; sumPD += pD; sumPA += pA;
      nValid++;
      // Track h2h
      if (r.ftr === 'D') h2hDraws++;
      else if (isFlipped ? r.ftr === 'A' : r.ftr === 'H') h2hHomeWins++;
      else h2hAwayWins++;
    }
    if (nValid === 0) return null;
    return {
      n: nValid,
      pH: +(sumPH / nValid).toFixed(4),
      pD: +(sumPD / nValid).toFixed(4),
      pA: +(sumPA / nValid).toFixed(4),
      h2h_record: { home_wins: h2hHomeWins, draws: h2hDraws, away_wins: h2hAwayWins },
      source: 'pinnacle_closing',
    };
  } catch (e) { return null; }
}

/**
 * Compara model probs vs market closing benchmark.
 * Retorna { divergence_h, divergence_d, divergence_a, max_divergence, suspect }.
 * suspect = max_divergence > 0.10 — model disagrees fortemente com sharp money.
 */
function getMarketDivergence(modelP, marketP) {
  if (!modelP || !marketP) return null;
  const dH = (modelP.pH || 0) - (marketP.pH || 0);
  const dD = (modelP.pD || 0) - (marketP.pD || 0);
  const dA = (modelP.pA || 0) - (marketP.pA || 0);
  const max = Math.max(Math.abs(dH), Math.abs(dD), Math.abs(dA));
  return {
    divergence_h: +dH.toFixed(4),
    divergence_d: +dD.toFixed(4),
    divergence_a: +dA.toFixed(4),
    max_divergence: +max.toFixed(4),
    suspect: max > 0.10,
  };
}

/**
 * League average baselines de football_data_csv.
 * Útil quando trained Poisson params não cobrem a liga.
 */
function getLeagueBaseline(db, league, opts = {}) {
  const days = opts.days ?? 365;
  const code = String(league || '').trim();
  if (!code) return null;
  try {
    const r = db.prepare(`
      SELECT
        COUNT(*) AS n,
        AVG(fthg) AS avg_home_goals,
        AVG(ftag) AS avg_away_goals,
        AVG(fthg + ftag) AS avg_total_goals,
        SUM(CASE WHEN fthg > ftag THEN 1.0 ELSE 0 END) / COUNT(*) AS home_win_rate,
        SUM(CASE WHEN fthg = ftag THEN 1.0 ELSE 0 END) / COUNT(*) AS draw_rate,
        SUM(CASE WHEN fthg > 0 AND ftag > 0 THEN 1.0 ELSE 0 END) / COUNT(*) AS btts_rate
      FROM football_data_csv
      WHERE league = ?
        AND fthg IS NOT NULL AND ftag IS NOT NULL
    `).get(code);
    if (!r || !r.n) return null;
    return {
      league: code,
      n: r.n,
      avg_home_goals: +(r.avg_home_goals || 0).toFixed(3),
      avg_away_goals: +(r.avg_away_goals || 0).toFixed(3),
      avg_total_goals: +(r.avg_total_goals || 0).toFixed(3),
      home_win_rate: +(r.home_win_rate || 0).toFixed(4),
      draw_rate: +(r.draw_rate || 0).toFixed(4),
      btts_rate: +(r.btts_rate || 0).toFixed(4),
    };
  } catch (_) { return null; }
}

module.exports = { getShotXgForm, getClosingOddsBenchmark, getMarketDivergence, getLeagueBaseline };
