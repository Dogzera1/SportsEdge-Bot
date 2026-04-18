// lib/esports-runtime-features.js
//
// Constrói o contexto de features em runtime para o predictor treinado,
// puxando de match_results (Elo + forma + H2H + recência) pelo DB.
// Usado por bot.js pollLoL/pollDota/pollValorant/pollCs.

const DAY_MS = 86400000;
const ELO_INIT = 1500;

// Cache curto: Elo state reconstruído uma vez por game, atualizado incrementalmente.
const _eloCache = new Map(); // game → { teams, lastBuildTs, lastMaxResolvedAt }
const ELO_CACHE_TTL = 30 * 60 * 1000; // 30 min

function norm(s) { return String(s || '').toLowerCase().trim(); }

function kFactor(games) {
  const K_BASE = 32, K_MIN = 12, K_SCALE = 50;
  return K_BASE - (K_BASE - K_MIN) * Math.min(1, games / K_SCALE);
}
function eloExpected(a, b) { return 1 / (1 + Math.pow(10, (b - a) / 400)); }

function _buildEloMap(db, game) {
  const rows = db.prepare(`
    SELECT team1, team2, winner, league, resolved_at
    FROM match_results
    WHERE game = ?
      AND team1 IS NOT NULL AND team1 != ''
      AND team2 IS NOT NULL AND team2 != ''
      AND winner IS NOT NULL AND winner != ''
      AND resolved_at IS NOT NULL
    ORDER BY resolved_at ASC
  `).all(game);

  const teams = new Map(); // norm(name) → { elo, eloLeague:Map, games, gamesLeague:Map }
  function getT(name) {
    const k = norm(name);
    if (!teams.has(k)) teams.set(k, {
      displayName: name, elo: ELO_INIT, eloLeague: new Map(),
      games: 0, gamesLeague: new Map(), recent: [],
    });
    return teams.get(k);
  }

  for (const r of rows) {
    const t = new Date(r.resolved_at).getTime();
    const league = r.league || '';
    const w = getT(r.winner);
    const loserName = norm(r.winner) === norm(r.team1) ? r.team2 : r.team1;
    const l = getT(loserName);

    // Overall Elo
    const expW = eloExpected(w.elo, l.elo);
    const kW = kFactor(w.games), kL = kFactor(l.games);
    w.elo += kW * (1 - expW);
    l.elo += kL * (0 - (1 - expW));
    // League Elo
    const wL = w.eloLeague.get(league) || ELO_INIT;
    const lL = l.eloLeague.get(league) || ELO_INIT;
    const expWL = eloExpected(wL, lL);
    const kWL = kFactor(w.gamesLeague.get(league) || 0);
    const kLL = kFactor(l.gamesLeague.get(league) || 0);
    w.eloLeague.set(league, wL + kWL * (1 - expWL));
    l.eloLeague.set(league, lL + kLL * (0 - (1 - expWL)));

    w.games++; l.games++;
    w.gamesLeague.set(league, (w.gamesLeague.get(league) || 0) + 1);
    l.gamesLeague.set(league, (l.gamesLeague.get(league) || 0) + 1);
    // oppElo: Elo do oponente PÓS-update do match atual (proxy de SOS)
    w.recent.push({ t, won: 1, opp: norm(l.displayName), oppElo: l.elo, league });
    l.recent.push({ t, won: 0, opp: norm(w.displayName), oppElo: w.elo, league });
    if (w.recent.length > 40) w.recent.splice(0, w.recent.length - 40);
    if (l.recent.length > 40) l.recent.splice(0, l.recent.length - 40);
  }

  return { teams, lastBuildTs: Date.now(), lastMaxResolvedAt: rows.length ? rows[rows.length - 1].resolved_at : null };
}

function _getEloMap(db, game) {
  const cached = _eloCache.get(game);
  if (cached && (Date.now() - cached.lastBuildTs) < ELO_CACHE_TTL) {
    return cached;
  }
  const m = _buildEloMap(db, game);
  _eloCache.set(game, m);
  return m;
}

function invalidateEloCache(game) {
  if (game) _eloCache.delete(game);
  else _eloCache.clear();
}

// ── League tier classifier (consistente com train) ────────────────────────
function leagueTier(league) {
  const l = String(league || '').toLowerCase();
  if (/lck|lpl|lec|lcs|worlds|msi/.test(l)) return 3;
  if (/lla|cblol|vcs|pcs|ljl/.test(l)) return 2;
  if (/masters|academy|emea|lpl2|pro league|one|major|dpc|ti|riyadh|epl|esl pro/i.test(l)) return 2;
  return 1;
}

function parseBestOf(format, finalScore) {
  if (format) {
    const m = String(format).match(/Bo(\d)/i);
    if (m) return parseInt(m[1], 10) || 1;
  }
  if (finalScore) {
    const m = String(finalScore).match(/Bo(\d)/i);
    if (m) return parseInt(m[1], 10) || 1;
  }
  return 1;
}

/**
 * Classifica o stage do torneio a partir do nome da liga.
 *
 * Stages (ordem de stakes decrescente):
 *   international_final → Worlds/MSI/TI Grand Final (peak stakes)
 *   international       → grupos/playoffs internacionais (Worlds groups, Major groups)
 *   regional_final      → LEC/LCK/LPL/LCS Summer Final etc
 *   playoffs            → bracket regional (quarters, semis)
 *   swiss               → Swiss stage (Worlds, IEM, BLAST) — cada match decide avanço
 *   play_in             → Play-in international (tier inferior; variance alta)
 *   qualifier           → qualifier/promoção/relegation (mixed-tier; ruído)
 *   regular             → fallback (round-robin groups, LCK/LPL/LEC regular split)
 *
 * High-stakes (international/playoffs/final) tendem a ter menos variance —
 * times performam próximo do true skill, menos sandbagging/rotação.
 * Swiss é interessante: equilibrio entre decisive (2-0 avança, 0-2 elimina)
 * e early-round noise (primeira round-robin inside swiss).
 *
 * @param {string} league
 * @returns {'international_final'|'international'|'regional_final'|'playoffs'|'swiss'|'play_in'|'qualifier'|'regular'}
 */
function matchStage(league) {
  const l = String(league || '').toLowerCase();
  if (!l) return 'regular';

  // Internacional: cross-game
  //   LoL: Worlds, MSI, First Stand, Red Bull, MSC
  //   Dota: The International (TI), ESL One, DreamLeague Major, Riyadh Masters, PGL/BLAST Majors
  //   CS: Major (PGL/IEM/BLAST/ESL), IEM Katowice/Cologne, Intel Extreme Masters
  //   Valorant: Champions, Masters (Tokyo/Madrid/etc), LOCK//IN
  const intlPrefix = /\b(worlds|msi|first stand|red bull league|mid[- ]?season|msc|the international|\bti\d*\b|esl one|dreamleague major|riyadh masters|blast.*major|pgl.*major|iem (katowice|cologne|rio|sydney|dallas)|intel extreme masters|major championship|lock[^a-z]{0,3}in|valorant champions|vct masters|masters (tokyo|madrid|shanghai|reykjavik|berlin|bangkok))\b/i.test(l);
  // Quarterfinal/semifinal são PLAYOFFS, não finals — checar primeiro pra não
  // confundir "Quarterfinals" com "Finals".
  const semifinalQuarterish = /\b(semi[-\s]?finals?|quarter[-\s]?finals?|sf|qf|knockout|bracket|gauntlet|last chance)\b/i.test(l);
  // "Grand Final", "Final", "Finals", "Championship Final", "Decider".
  const finalish = !semifinalQuarterish &&
    /\b(grand[-\s]?finals?|finals?|decider|championship)\b/i.test(l);
  // Stages novos (2026-04-18+)
  const swissish = /\b(swiss[-\s]?(stage|round|phase)?|swiss\b)/i.test(l);
  const playInish = /\b(play[-\s]?in|play[-\s]?ins|pi\s+stage|qualification round)\b/i.test(l);
  const qualifierish = /\b(qualifier|qualifying|closed quali|open quali|promotion|relegation|ladder)\b/i.test(l);

  if (intlPrefix) {
    if (finalish) return 'international_final';
    // Swiss/play-in dentro de torneio internacional ainda são internacional stages
    // mas com dinâmica própria — retorna o tag específico
    if (swissish) return 'swiss';
    if (playInish) return 'play_in';
    return 'international';
  }

  if (finalish && /\b(lck|lec|lpl|lcs|cblol|ljl|lla|pcs|vcs|lcp)\b/i.test(l)) {
    return 'regional_final';
  }

  if (finalish || semifinalQuarterish || /playoff/i.test(l)) {
    return 'playoffs';
  }

  // Swiss/play-in/qualifier fora de internacional (ex: IEM Rio Americas, DPC quali)
  if (swissish) return 'swiss';
  if (playInish) return 'play_in';
  if (qualifierish) return 'qualifier';

  return 'regular';
}

/**
 * Multiplier de confidence baseado em stage.
 *
 * Calibração justificada:
 *   international_final × 1.15 — Worlds/MSI/TI final, peak stakes, zero sandbagging
 *   international       × 1.10 — grupos internacionais, stakes altos
 *   regional_final      × 1.08 — LCK/LEC/LPL final, stakes regionais altos
 *   playoffs            × 1.05 — quarters/semis regional
 *   swiss               × 1.06 — cada match decisivo (2-0 avança, 0-2 out)
 *   play_in             × 1.02 — mixed tier; underdog pode ser wildcard
 *   qualifier           × 0.98 — promoção/relegation: motivation mista (promotion-eligible team vs já-classificado)
 *   regular             × 1.00 — baseline
 *
 * Swiss recebe boost quase-playoff porque cada match tem consequência imediata
 * (pra qualifying/elimination bracket). Play-in é mais ruidoso que grupos
 * por causa do gap entre wildcards/seeds.
 */
function stageConfidenceMultiplier(stage) {
  if (stage === 'international_final') return 1.15;
  if (stage === 'international') return 1.10;
  if (stage === 'regional_final') return 1.08;
  if (stage === 'swiss') return 1.06;
  if (stage === 'playoffs') return 1.05;
  if (stage === 'play_in') return 1.02;
  if (stage === 'qualifier') return 0.98;
  return 1.0;
}

/**
 * §5b Stakes context — detecta torneios/matches com motivation anômala
 * (showmatch, preseason, all-star → tanking quase garantido; decider/tiebreaker →
 * peak stakes). Aplicado ADICIONAL ao matchStage.
 *
 * Returns: { category: 'ultra_low'|'low'|'normal'|'high', reason, multiplier }
 *
 * Categorias:
 *   ultra_low (×0.70) — showmatch/exhibition/all-star/charity: resultado puro entertainment
 *   low       (×0.90) — preseason/scrim/warmup: teams não jogando sério
 *   high      (×1.05) — decider/tiebreaker/elimination: stakes amplificados
 *   normal    (×1.00) — fallback
 *
 * Stake multiplier é INDEPENDENTE do stage — stackable. Usage:
 *   finalConf = baseConf × stageMult × stakesMult
 */
function detectStakesContext(league) {
  const l = String(league || '').toLowerCase();
  if (!l) return { category: 'normal', reason: null, multiplier: 1.0 };

  // Ultra-low: nunca apostar com confidence alta, outcome é puro entertainment
  // - Valorant Game Changers exhibitions, LoL Red Bull Solo Q, Dota showmatches, etc.
  const ultraLow = /\b(showmatch|exhibition|all[-\s]?star|charity|gala|fun match|showcase|promotional|one[-\s]?off)\b/i.test(l);
  if (ultraLow) return { category: 'ultra_low', reason: 'showmatch/exhibition/all-star', multiplier: 0.70 };

  // Low: preseason, scrim ou warmup. Teams experimentando rosters/drafts.
  const lowStakes = /\b(preseason|pre[-\s]?season|warm[-\s]?up|scrim|training|bootcamp|test match)\b/i.test(l);
  if (lowStakes) return { category: 'low', reason: 'preseason/warmup', multiplier: 0.90 };

  // High: decider / tiebreaker / direct elimination. Stakes amplificados.
  const highStakes = /\b(decider|tiebreak(er)?|elimination match|do[-\s]?or[-\s]?die|must[-\s]?win|last chance)\b/i.test(l);
  if (highStakes) return { category: 'high', reason: 'decider/tiebreaker/must-win', multiplier: 1.05 };

  return { category: 'normal', reason: null, multiplier: 1.0 };
}

// ── Team stats loader (LoL-only) ─────────────────────────────────────────
// Mapa: <norm(team)> → { season → { split → row } }. Reload TTL 2h.
let _teamStatsCache = null;
let _teamStatsTs = 0;
const TEAM_STATS_TTL = 2 * 60 * 60 * 1000;

function _getTeamStatsMap(db) {
  if (_teamStatsCache && (Date.now() - _teamStatsTs) < TEAM_STATS_TTL) return _teamStatsCache;
  try {
    const rows = db.prepare(`SELECT * FROM team_stats`).all();
    const map = new Map();
    for (const r of rows) {
      const k = norm(r.team);
      if (!map.has(k)) map.set(k, {});
      const e = map.get(k);
      if (!e[r.season]) e[r.season] = {};
      e[r.season][r.split] = r;
    }
    _teamStatsCache = map;
    _teamStatsTs = Date.now();
    return map;
  } catch (e) {
    _teamStatsCache = new Map();
    _teamStatsTs = Date.now();
    return _teamStatsCache;
  }
}

function _seasonSplitForDate(dateMs) {
  const d = new Date(dateMs);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  const season = `S${y - 2010 - 2}`; // 2024→S14, 2025→S15, 2026→S16
  let split = 'ALL';
  if (y >= 2025 && m <= 2) split = 'Winter';
  else if (m >= 1 && m <= 5) split = 'Spring';
  else if (m >= 6 && m <= 8) split = 'Summer';
  return { season, split };
}

function _lookupTeamStats(map, team, season, split) {
  const e = map.get(norm(team));
  if (!e) return null;
  if (e[season]?.[split]) return e[season][split];
  if (e[season]?.ALL) return e[season].ALL;
  const seasons = Object.keys(e).sort().reverse();
  for (const s of seasons) {
    if (e[s].ALL) return e[s].ALL;
    const first = Object.values(e[s])[0];
    if (first) return first;
  }
  return null;
}

function _h2hFromRecent(team1, team2) {
  // Precisa consultar cruzando recent de ambos. Mais simples: query direta DB.
  return null; // handled below
}

function _h2hQuery(db, game, team1, team2) {
  try {
    const rows = db.prepare(`
      SELECT winner, resolved_at
      FROM match_results
      WHERE game = ?
        AND ((lower(team1)=lower(?) AND lower(team2)=lower(?)) OR (lower(team1)=lower(?) AND lower(team2)=lower(?)))
        AND winner IS NOT NULL AND winner != ''
        AND resolved_at >= datetime('now', '-2 years')
      ORDER BY resolved_at DESC
      LIMIT 20
    `).all(game, team1, team2, team2, team1);
    let w1 = 0, w2 = 0;
    for (const r of rows) {
      if (norm(r.winner) === norm(team1)) w1++;
      else if (norm(r.winner) === norm(team2)) w2++;
    }
    return { team1Wins: w1, team2Wins: w2, total: w1 + w2 };
  } catch (e) { return { team1Wins: 0, team2Wins: 0, total: 0 }; }
}

/**
 * Monta contexto de features para predictTrainedEsports.
 * Retorna null se dados insuficientes.
 */
function buildTrainedContext(db, game, match) {
  const team1 = match.team1, team2 = match.team2;
  if (!team1 || !team2) return null;
  const league = match.league || '';
  const tier = leagueTier(league);
  const bestOf = parseBestOf(match.format, match.final_score);

  const { teams } = _getEloMap(db, game);
  const t1 = teams.get(norm(team1));
  const t2 = teams.get(norm(team2));
  if (!t1 || !t2) return null;
  if (t1.games < 3 || t2.games < 3) return null;

  const now = match.time ? new Date(match.time).getTime() : Date.now();
  const last1 = t1.recent.length ? t1.recent[t1.recent.length - 1].t : null;
  const last2 = t2.recent.length ? t2.recent[t2.recent.length - 1].t : null;

  const wr10_1 = winRateLast(t1.recent, 10);
  const wr10_2 = winRateLast(t2.recent, 10);
  const wr20_1 = winRateLast(t1.recent, 20);
  const wr20_2 = winRateLast(t2.recent, 20);

  // Momentum features (match train-esports-model.js / extract-esports-features.js)
  const streak1 = _currentStreak(t1.recent);
  const streak2 = _currentStreak(t2.recent);
  const trend1 = (wr10_1.n >= 5 && wr20_1.n >= 10) ? (wr10_1.pct - wr20_1.pct) : 0;
  const trend2 = (wr10_2.n >= 5 && wr20_2.n >= 10) ? (wr10_2.pct - wr20_2.pct) : 0;

  const mCut = now - 14 * DAY_MS;
  const m14_1 = t1.recent.filter(x => x.t >= mCut).length;
  const m14_2 = t2.recent.filter(x => x.t >= mCut).length;

  // SOS — avg opp Elo dos últimos 5 matches
  const sosOf = (recent, n) => {
    const slice = recent.slice(-n);
    const elos = slice.map(x => x.oppElo).filter(e => Number.isFinite(e));
    if (!elos.length) return null;
    return elos.reduce((a, b) => a + b, 0) / elos.length;
  };
  const sos1 = sosOf(t1.recent, 5);
  const sos2 = sosOf(t2.recent, 5);
  const sosDiff = (sos1 != null && sos2 != null) ? (sos1 - sos2) : 0;

  // Same-league momentum — wins em matches dessa liga nos últimos 365d
  const lcut = now - 365 * DAY_MS;
  const slWins = (recent) => {
    let w = 0, l = 0;
    for (const r of recent) {
      if (r.t < lcut) continue;
      if (norm(r.league) !== norm(league)) continue;
      if (r.won) w++; else l++;
    }
    return { w, l, n: w + l };
  };
  const slw1 = slWins(t1.recent);
  const slw2 = slWins(t2.recent);
  const sameLeagueWinsDiff = slw1.w - slw2.w;
  const slwr1 = slw1.n >= 2 ? slw1.w / slw1.n : null;
  const slwr2 = slw2.n >= 2 ? slw2.w / slw2.n : null;
  const sameLeagueWrDiff = (slwr1 != null && slwr2 != null) ? (slwr1 - slwr2) : 0;

  const h2h = _h2hQuery(db, game, team1, team2);

  // LoL: gol.gg team stats (só se disponíveis)
  let gpmDiff = 0, gdmDiff = 0, gd15Diff = 0, fbRateDiff = 0, ftRateDiff = 0;
  let dpmDiff = 0, kdDiff = 0, teamWrDiff = 0, draPctDiff = 0, nashPctDiff = 0;
  let hasTeamStats = false;
  if (game === 'lol') {
    const tsMap = _getTeamStatsMap(db);
    if (tsMap.size > 0) {
      const { season, split } = _seasonSplitForDate(now);
      const ts1 = _lookupTeamStats(tsMap, team1, season, split);
      const ts2 = _lookupTeamStats(tsMap, team2, season, split);
      if (ts1 && ts2) {
        hasTeamStats = true;
        gpmDiff = (ts1.gpm || 0) - (ts2.gpm || 0);
        gdmDiff = (ts1.gdm || 0) - (ts2.gdm || 0);
        gd15Diff = (ts1.gd_at_15 || 0) - (ts2.gd_at_15 || 0);
        fbRateDiff = (ts1.fb_pct || 0) - (ts2.fb_pct || 0);
        ftRateDiff = (ts1.ft_pct || 0) - (ts2.ft_pct || 0);
        dpmDiff = (ts1.dpm || 0) - (ts2.dpm || 0);
        kdDiff = (ts1.kd_ratio || 0) - (ts2.kd_ratio || 0);
        teamWrDiff = (ts1.winrate || 0) - (ts2.winrate || 0);
        draPctDiff = (ts1.dra_pct || 0) - (ts2.dra_pct || 0);
        nashPctDiff = (ts1.nash_pct || 0) - (ts2.nash_pct || 0);
      }
    }
  }

  // LoL: Oracle's Elixir rolling 60d (só se disponíveis — ≥5 games pre-match cada time)
  let oeGd15Diff = 0, oeObjDiff = 0, oeWrDiff = 0, oeDpmDiff = 0, hasOeStats = false;
  if (game === 'lol') {
    try {
      const { getTeamOEStats } = require('./oracleselixir-features');
      const oe1 = getTeamOEStats(db, team1, { sinceDays: 60, minGames: 5 });
      const oe2 = getTeamOEStats(db, team2, { sinceDays: 60, minGames: 5 });
      if (oe1 && oe2) {
        hasOeStats = true;
        oeGd15Diff = (oe1.avgGdAt15 || 0) - (oe2.avgGdAt15 || 0);
        const obj1 = ((oe1.firstDragonRate || 0) + (oe1.firstBaronRate || 0) + (oe1.firstTowerRate || 0)) / 3;
        const obj2 = ((oe2.firstDragonRate || 0) + (oe2.firstBaronRate || 0) + (oe2.firstTowerRate || 0)) / 3;
        oeObjDiff = obj1 - obj2;
        oeWrDiff = (oe1.winRate || 0.5) - (oe2.winRate || 0.5);
        oeDpmDiff = (oe1.avgDpm || 0) - (oe2.avgDpm || 0);
      }
    } catch (_) { /* no-op — tabela pode não existir em DBs antigos */ }
  }

  // LoL: player-level roster stats (avgKda, maxKda, starPower)
  let avgKdaDiff = 0, maxKdaDiff = 0, starScoreDiff = 0, hasRosterStats = false;
  if (game === 'lol') {
    try {
      const { getTeamRosterStats } = require('./oracleselixir-player-features');
      const r1 = getTeamRosterStats(db, team1, { sinceDays: 60, minGamesPerPlayer: 10 });
      const r2 = getTeamRosterStats(db, team2, { sinceDays: 60, minGamesPerPlayer: 10 });
      if (r1 && r2) {
        hasRosterStats = true;
        avgKdaDiff = r1.avgKda - r2.avgKda;
        maxKdaDiff = r1.maxKda - r2.maxKda;
        const starScore = (sp) => sp === 'dual_carry' ? 2 : sp === 'single_carry' ? 1 : sp === 'balanced' ? 0.5 : 0;
        starScoreDiff = starScore(r1.starPower) - starScore(r2.starPower);
      }
    } catch (_) { /* no-op */ }
  }

  return {
    team1, team2,
    eloOverall1: t1.elo, eloOverall2: t2.elo,
    eloLeague1: t1.eloLeague.get(league) || t1.elo,
    eloLeague2: t2.eloLeague.get(league) || t2.elo,
    games1: t1.games, games2: t2.games,
    winRateDiff10: (wr10_1.n >= 5 && wr10_2.n >= 5) ? (wr10_1.pct - wr10_2.pct) : 0,
    winRateDiff20: (wr20_1.n >= 10 && wr20_2.n >= 10) ? (wr20_1.pct - wr20_2.pct) : 0,
    h2hDiff: h2h.team1Wins - h2h.team2Wins,
    h2hTotal: h2h.total,
    daysSinceLast1: last1 ? Math.round((now - last1) / DAY_MS) : 120,
    daysSinceLast2: last2 ? Math.round((now - last2) / DAY_MS) : 120,
    matchesLast14Diff: m14_1 - m14_2,
    // Momentum (cross-game; usado quando weights expõe ≥21 dims)
    winStreakDiff: streak1 - streak2,
    wrTrendDiff: trend1 - trend2,
    // 1v1 features (MMA/darts/snooker) — supply quando weights expõe ≥24 dims
    sosDiff,
    sameLeagueWinsDiff,
    sameLeagueWrDiff,
    bestOf, leagueTier: tier,
    // gol.gg team stats (LoL only)
    gpmDiff, gdmDiff, gd15Diff, fbRateDiff, ftRateDiff,
    dpmDiff, kdDiff, teamWrDiff, draPctDiff, nashPctDiff, hasTeamStats,
    // Oracle's Elixir rolling (LoL only)
    oeGd15Diff, oeObjDiff, oeWrDiff, oeDpmDiff, hasOeStats,
    // Player-level roster stats (LoL only)
    avgKdaDiff, maxKdaDiff, starScoreDiff, hasRosterStats,
  };
}

function winRateLast(recent, n) {
  const slice = recent.slice(-n);
  if (!slice.length) return { pct: 0.5, n: 0 };
  const wins = slice.filter(x => x.won).length;
  return { pct: wins / slice.length, n: slice.length };
}

// Streak: conta consecutivos W (+n) ou L (-n) no fim da lista recent.
function _currentStreak(recent) {
  if (!recent || !recent.length) return 0;
  const last = recent[recent.length - 1].won;
  let n = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].won === last) n++; else break;
  }
  return last ? n : -n;
}

module.exports = {
  buildTrainedContext,
  invalidateEloCache,
  leagueTier,
  parseBestOf,
  matchStage,
  stageConfidenceMultiplier,
  detectStakesContext,
};
