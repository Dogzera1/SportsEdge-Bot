// ── Tennis Features v2 ──
// Features experimentais pra Vetor 1 do plano de 14 semanas:
//   - fatigue_minutes_7d     (carga recente, proxy via parse final_score)
//   - matches_last_14d       (volume recente)
//   - days_since_last_match  (recuperação)
//   - is_surface_transition  (primeira vez nesta surface em 21d)
//   - matches_since_transition
//
// Sem look-ahead bias: features computadas SEMPRE com asOfDate = sent_at
// da tip (não usar dados posteriores).
//
// Fonte: tabela match_results (team1, team2, winner, final_score, league, resolved_at).
// Surface inferida via regex em league. Minutes estimados via final_score parse.

const SURFACE_REGEX = {
  clay:  /\b(roland garros|french open|monte ?carlo|madrid|rome|barcelona|hamburg|bastad|umag|kitzb[uü]hel|gstaad|estoril|santiago|rio|buenos aires|cordoba|chile|argentina|geneva|munich|clay)\b/i,
  grass: /\b(wimbledon|halle|queens|stuttgart|eastbourne|mallorca|den bosch|newport|grass)\b/i,
  hard:  /\b(australian open|us open|miami|indian wells|toronto|cincinnati|shanghai|paris masters|atp finals|wta finals|dubai|doha|acapulco|delray|brisbane|adelaide|hard)\b/i,
  carpet: /\bcarpet\b/i,
};

function inferSurface(league) {
  if (!league) return 'unknown';
  const s = String(league).toLowerCase();
  for (const [surface, re] of Object.entries(SURFACE_REGEX)) {
    if (re.test(s)) return surface;
  }
  return 'unknown';
}

// Estima minutos de match a partir de final_score (formato "6-4 6-3" ou "6-4 3-6 7-5")
// Heurística: cada set ~30min default, sets longos (>= 9 games) ~45min, super tiebreaks ~15min
function estimateMatchMinutes(finalScore) {
  if (!finalScore || typeof finalScore !== 'string') return 90; // default Bo3
  const sets = finalScore.match(/\b\d+-\d+\b/g) || [];
  if (!sets.length) return 90;
  let total = 0;
  for (const set of sets) {
    const [a, b] = set.split('-').map(n => parseInt(n, 10));
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const games = a + b;
    if (games >= 13) total += 60;       // tiebreak set, longo
    else if (games >= 9) total += 45;   // set normal
    else total += 30;                   // set rápido
  }
  return total > 0 ? total : 90;
}

// Pega últimos N matches do player até asOfDate (não inclusivo).
function getPlayerRecentMatches(db, playerName, asOfDate, daysWindow = 30, limit = 30) {
  if (!playerName) return [];
  const playerLow = String(playerName).toLowerCase();
  try {
    return db.prepare(`
      SELECT match_id, team1, team2, winner, final_score, league, resolved_at
      FROM match_results
      WHERE (lower(team1) = ? OR lower(team2) = ?)
        AND game = 'tennis'
        AND resolved_at < ?
        AND resolved_at >= datetime(?, ?)
      ORDER BY resolved_at DESC
      LIMIT ?
    `).all(playerLow, playerLow, asOfDate, asOfDate, `-${daysWindow} days`, limit);
  } catch (e) {
    return [];
  }
}

// fatigueIndex: minutos jogados últimos N dias / N (média diária).
// Range típico: 0 (descansado) a 30+ (overplaying — risco lesão).
function fatigueIndex(db, playerName, asOfDate, daysWindow = 7) {
  const matches = getPlayerRecentMatches(db, playerName, asOfDate, daysWindow, 20);
  let totalMin = 0;
  for (const m of matches) totalMin += estimateMatchMinutes(m.final_score);
  return parseFloat((totalMin / daysWindow).toFixed(1));
}

// matchesLast: simples count de matches em janela
function matchesLast(db, playerName, asOfDate, daysWindow = 14) {
  return getPlayerRecentMatches(db, playerName, asOfDate, daysWindow, 30).length;
}

// daysSinceLast: dias desde último match
function daysSinceLast(db, playerName, asOfDate) {
  const matches = getPlayerRecentMatches(db, playerName, asOfDate, 60, 1);
  if (!matches.length) return null;
  const lastTs = new Date(matches[0].resolved_at + 'Z').getTime();
  const asOfTs = new Date(asOfDate + 'Z').getTime();
  if (!Number.isFinite(lastTs) || !Number.isFinite(asOfTs)) return null;
  return Math.max(0, Math.round((asOfTs - lastTs) / 86400000));
}

// surfaceTransition: { is_transition: bool, matches_since_transition: number }
// Compara surface inferida do match atual com surface dos últimos matches do player.
function surfaceTransition(db, playerName, currentLeague, asOfDate, lookbackDays = 21) {
  const currentSurface = inferSurface(currentLeague);
  if (currentSurface === 'unknown') return { is_transition: null, matches_since_transition: null, current_surface: 'unknown' };

  const matches = getPlayerRecentMatches(db, playerName, asOfDate, lookbackDays, 10);
  if (!matches.length) return { is_transition: null, matches_since_transition: null, current_surface: currentSurface };

  let matchesSince = 0;
  let foundCurrentSurface = false;
  for (const m of matches) {
    const s = inferSurface(m.league);
    if (s === currentSurface) {
      foundCurrentSurface = true;
      break;
    }
    matchesSince++;
  }
  return {
    is_transition: !foundCurrentSurface,
    matches_since_transition: foundCurrentSurface ? matchesSince : matches.length, // todos os matches recentes em outra surface
    current_surface: currentSurface,
  };
}

// Recency weight: half-life decay. days_ago=30 → 0.5, days_ago=60 → 0.25
// Usado pra ponderar form histórica.
function recencyWeight(daysAgo, halfLife = 30) {
  if (!Number.isFinite(daysAgo) || daysAgo < 0) return 1;
  return Math.exp(-Math.LN2 * daysAgo / halfLife);
}

// Calcula todas features de uma vez pra um player asOfDate específico.
// Usado tanto no smoke test (offline) quanto no modelo v2 (online).
function computeAllFeatures(db, playerName, currentLeague, asOfDate) {
  const matches7d = matchesLast(db, playerName, asOfDate, 7);
  const matches14d = matchesLast(db, playerName, asOfDate, 14);
  const fatigue = fatigueIndex(db, playerName, asOfDate, 7);
  const daysSince = daysSinceLast(db, playerName, asOfDate);
  const surface = surfaceTransition(db, playerName, currentLeague, asOfDate);
  return {
    fatigue_minutes_avg_7d: fatigue,
    matches_last_7d: matches7d,
    matches_last_14d: matches14d,
    days_since_last_match: daysSince,
    is_surface_transition: surface.is_transition,
    matches_since_transition: surface.matches_since_transition,
    current_surface: surface.current_surface,
  };
}

module.exports = {
  inferSurface,
  estimateMatchMinutes,
  getPlayerRecentMatches,
  fatigueIndex,
  matchesLast,
  daysSinceLast,
  surfaceTransition,
  recencyWeight,
  computeAllFeatures,
};
