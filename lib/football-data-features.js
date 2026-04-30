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
  // xG conversion factor: HST × 0.32 ≈ xG (lit avg pro EPL ~0.30-0.34)
  const xgPerSot = parseFloat(opts.xgPerSot || process.env.XG_PER_SOT || '0.32');
  // Cutoff de data — football_data_csv stora date em formato 'DD/MM/YYYY' OU
  // 'YYYY-MM-DD' dependendo da fonte. Comparação string com cutoff ISO funciona
  // só pra YYYY-MM-DD; pra DD/MM/YYYY usa fallback via SUBSTR rearranjando.
  // Defensivo: filtra in-memory após query pra cobrir ambos formatos sem custo
  // significativo (LIMIT já cap em 40 rows max).
  const cutoffMs = Date.now() - days * 86400000;
  const _parseDate = (s) => {
    if (!s) return NaN;
    // Try ISO first (YYYY-MM-DD)
    let t = Date.parse(s);
    if (Number.isFinite(t)) return t;
    // DD/MM/YYYY → ISO
    const m = String(s).match(/^(\d{2})\/(\d{2})\/(\d{2,4})$/);
    if (m) {
      const yr = m[3].length === 2 ? (Number(m[3]) >= 50 ? `19${m[3]}` : `20${m[3]}`) : m[3];
      t = Date.parse(`${yr}-${m[2]}-${m[1]}`);
    }
    return Number.isFinite(t) ? t : NaN;
  };
  try {
    const allRows = db.prepare(`
      SELECT
        date, home, away, fthg, ftag,
        home_shots, away_shots,
        home_shots_target, away_shots_target
      FROM football_data_csv
      WHERE (lower(replace(replace(replace(home,' ',''),'-',''),'.','')) = ?
          OR lower(replace(replace(replace(away,' ',''),'-',''),'.','')) = ?)
        AND fthg IS NOT NULL
        AND date IS NOT NULL
      ORDER BY date DESC
      LIMIT ?
    `).all(teamN, teamN, Math.min(40, Math.max(5, opts.maxRows ?? 20)));
    const rows = allRows.filter(r => {
      const ts = _parseDate(r.date);
      return !Number.isFinite(ts) || ts >= cutoffMs;
    });
    if (!rows.length) return null;

    let n = 0;
    let goalsFor = 0, goalsAgainst = 0;
    let shotsFor = 0, shotsAgainst = 0;
    let sotFor = 0, sotAgainst = 0;
    let nWithShots = 0;
    for (const r of rows) {
      const isHome = _norm(r.home) === teamN;
      n++;
      const myG = isHome ? Number(r.fthg) : Number(r.ftag);
      const oppG = isHome ? Number(r.ftag) : Number(r.fthg);
      const myS = isHome ? Number(r.home_shots) : Number(r.away_shots);
      const oppS = isHome ? Number(r.away_shots) : Number(r.home_shots);
      const mySot = isHome ? Number(r.home_shots_target) : Number(r.away_shots_target);
      const oppSot = isHome ? Number(r.away_shots_target) : Number(r.home_shots_target);
      goalsFor += myG || 0;
      goalsAgainst += oppG || 0;
      if (Number.isFinite(myS)) { shotsFor += myS; shotsAgainst += oppS || 0; }
      if (Number.isFinite(mySot)) {
        sotFor += mySot;
        sotAgainst += oppSot || 0;
        nWithShots++;
      }
    }
    if (n < 3) return null;
    const goalsForPg = goalsFor / n;
    const goalsAgainstPg = goalsAgainst / n;
    const out = {
      n,
      goals_for_pg: +goalsForPg.toFixed(2),
      goals_against_pg: +goalsAgainstPg.toFixed(2),
      xg_for_pg: null, xg_against_pg: null, finishing_index: null,
    };
    if (nWithShots >= 3) {
      const sotForPg = sotFor / nWithShots;
      const sotAgainstPg = sotAgainst / nWithShots;
      const xgForPg = sotForPg * xgPerSot;
      const xgAgainstPg = sotAgainstPg * xgPerSot;
      out.shots_for_pg = +(shotsFor / nWithShots).toFixed(2);
      out.shots_against_pg = +(shotsAgainst / nWithShots).toFixed(2);
      out.sot_for_pg = +sotForPg.toFixed(2);
      out.sot_against_pg = +sotAgainstPg.toFixed(2);
      out.xg_for_pg = +xgForPg.toFixed(3);
      out.xg_against_pg = +xgAgainstPg.toFixed(3);
      // finishing_index >1 = sobre-performance; <1 = sub-performance vs xG.
      // Cap [0.5, 2.0] pra estabilidade (small sample variance).
      if (xgForPg > 0.1) {
        out.finishing_index = +Math.max(0.5, Math.min(2.0, goalsForPg / xgForPg)).toFixed(3);
      }
      out.n_with_shots = nWithShots;
    }
    return out;
  } catch (e) { return null; }
}

/**
 * Closing odds benchmark: pulls últimas N partidas entre os teams (h2h direto)
 * + média das closing odds (PS = Pinnacle Sharp Closing). Retorna implied prob
 * normalizada (de-juiced).
 */
function getClosingOddsBenchmark(db, home, away, opts = {}) {
  const days = opts.days ?? 1095; // 3 anos default — H2H esfria mas roster/forma muda
  const homeN = _norm(home), awayN = _norm(away);
  if (!homeN || !awayN) return null;
  // Same defensive parse — football_data_csv tem date em DD/MM/YYYY ou ISO.
  const cutoffMs = Date.now() - days * 86400000;
  const _parseDate = (s) => {
    if (!s) return NaN;
    let t = Date.parse(s);
    if (Number.isFinite(t)) return t;
    const m = String(s).match(/^(\d{2})\/(\d{2})\/(\d{2,4})$/);
    if (m) {
      const yr = m[3].length === 2 ? (Number(m[3]) >= 50 ? `19${m[3]}` : `20${m[3]}`) : m[3];
      t = Date.parse(`${yr}-${m[2]}-${m[1]}`);
    }
    return Number.isFinite(t) ? t : NaN;
  };
  try {
    const allRows = db.prepare(`
      SELECT date, home, away, fthg, ftag, ftr, ps_h, ps_d, ps_a
      FROM football_data_csv
      WHERE ((lower(replace(replace(replace(home,' ',''),'-',''),'.','')) = ?
              AND lower(replace(replace(replace(away,' ',''),'-',''),'.','')) = ?)
          OR (lower(replace(replace(replace(home,' ',''),'-',''),'.','')) = ?
              AND lower(replace(replace(replace(away,' ',''),'-',''),'.','')) = ?))
        AND ps_h IS NOT NULL AND ps_d IS NOT NULL AND ps_a IS NOT NULL
      ORDER BY date DESC
      LIMIT 16
    `).all(homeN, awayN, awayN, homeN);
    const rows = allRows.filter(r => {
      const ts = _parseDate(r.date);
      return !Number.isFinite(ts) || ts >= cutoffMs;
    }).slice(0, 8);
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

// Map de nome → code football-data.co.uk
const _LEAGUE_NAME_TO_CODE = {
  'premier league': 'E0', 'epl': 'E0', 'english premier league': 'E0',
  'championship': 'E1', 'efl championship': 'E1',
  'league one': 'E2', 'efl league one': 'E2',
  'la liga': 'SP1', 'laliga': 'SP1', 'la liga 1': 'SP1', 'spain': 'SP1',
  'la liga 2': 'SP2', 'segunda': 'SP2',
  'bundesliga': 'D1', 'bundesliga 1': 'D1', 'germany': 'D1',
  'bundesliga 2': 'D2',
  'serie a': 'I1', 'italy': 'I1',
  'serie b': 'I2',
  'ligue 1': 'F1', 'france': 'F1',
  'ligue 2': 'F2',
  'eredivisie': 'N1', 'netherlands': 'N1',
  'belgium': 'B1', 'jupiler': 'B1',
  'portugal': 'P1', 'primeira liga': 'P1',
  'turkey': 'T1', 'super lig': 'T1',
  'greece': 'G1',
  'scotland': 'SC0', 'scottish premiership': 'SC0',
};

function _resolveLeagueCode(league) {
  if (!league) return null;
  const key = String(league).toLowerCase().trim();
  if (_LEAGUE_NAME_TO_CODE[key]) return _LEAGUE_NAME_TO_CODE[key];
  // Substring match
  for (const k in _LEAGUE_NAME_TO_CODE) {
    if (key.includes(k) || k.includes(key)) return _LEAGUE_NAME_TO_CODE[k];
  }
  // Try as direct code (E0, SP1, etc)
  if (/^[A-Z]{1,3}\d?$/i.test(league)) return String(league).toUpperCase();
  return null;
}

/**
 * League average baselines de football_data_csv.
 * Útil quando trained Poisson params não cobrem a liga.
 */
function getLeagueBaseline(db, league, opts = {}) {
  const code = _resolveLeagueCode(league);
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
      league_name: league,
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
