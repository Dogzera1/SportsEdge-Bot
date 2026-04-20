'use strict';
// Football Poisson trained model — usa params derivados de match_results (ligas target).
// Params salvos em /data/football-poisson-params.json (persistente). Sem arquivo = modelo inativo.

const fs = require('fs');
const path = require('path');

let _cached = null;
let _cachedAt = 0;
const TTL_MS = 30 * 60 * 1000;

function _paramsPath() {
  const dbPath = (process.env.DB_PATH || 'sportsedge.db').trim();
  return path.join(path.dirname(path.resolve(dbPath)), 'football-poisson-params.json');
}

function _load() {
  try {
    const p = _paramsPath();
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

function getParams() {
  const now = Date.now();
  if (_cached && (now - _cachedAt) < TTL_MS) return _cached;
  _cached = _load();
  _cachedAt = now;
  return _cached;
}

function hasTrainedFootballModel() {
  const p = getParams();
  return !!(p && p.leagues && Object.keys(p.leagues).length > 0);
}

// Normaliza nome pra lookup em params.teams
function _norm(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function _findTeam(teams, name) {
  if (!teams || !name) return null;
  const n = _norm(name);
  // Direct match
  for (const k in teams) {
    if (_norm(k) === n) return { key: k, team: teams[k] };
  }
  // Substring
  for (const k in teams) {
    const kn = _norm(k);
    if (kn.includes(n) || n.includes(kn)) return { key: k, team: teams[k] };
  }
  return null;
}

function _findLeague(leagues, leagueName) {
  if (!leagues || !leagueName) return null;
  const n = String(leagueName).toLowerCase();
  // Exact match
  for (const k in leagues) {
    if (k.toLowerCase() === n) return { key: k, league: leagues[k] };
  }
  // Substring
  for (const k in leagues) {
    if (k.toLowerCase().includes(n) || n.includes(k.toLowerCase())) return { key: k, league: leagues[k] };
  }
  // Token match: verifica se TODAS as palavras significativas de uma side
  // aparecem na outra. Trata "La Liga 2 - Spain" ≈ "Spain Segunda",
  // "Serie B - Italy" ≈ "Italy Serie B", "League 1" ≈ "England League One".
  // 'a'/'b' NÃO são stop (podem ser "Serie A" vs "Serie B" — divisão crítica).
  const STOP = new Set(['the', 'of', 'and', '-', '/', '(', ')', 'liga', 'league']);
  const SYN = { '1': ['one', 'primeira', 'premier'], '2': ['two', 'segunda', 'second', 'ii'],
                '3': ['three', 'tercera', 'third'], 'la': ['la'], 'série': ['serie'] };
  const toks = (s) => s.toLowerCase().replace(/[^a-z0-9à-ú\s]/g, ' ').split(/\s+/)
    .map(t => t.replace('á','a').replace('é','e').replace('í','i').replace('ó','o').replace('ú','u'))
    .filter(t => t && !STOP.has(t));
  const expand = (t) => (SYN[t] || [t]).concat([t]);
  const queryToks = toks(n);
  for (const k in leagues) {
    const keyToks = toks(k);
    if (!keyToks.length || !queryToks.length) continue;
    // Key ⊆ Query OR Query ⊆ Key (com sinonímia)
    const matches = (a, b) => a.every(t => {
      const expanded = expand(t);
      return b.some(bt => expanded.includes(bt) || expand(bt).includes(t));
    });
    if (matches(keyToks, queryToks) || matches(queryToks, keyToks)) {
      return { key: k, league: leagues[k] };
    }
  }
  return null;
}

// Poisson PMF truncada (até maxGoals)
function _poissonMatrix(lamH, lamA, maxGoals = 8) {
  const mat = [];
  const pmfH = [], pmfA = [];
  let facT = 1;
  for (let k = 0; k <= maxGoals; k++) {
    if (k > 0) facT *= k;
    pmfH[k] = Math.exp(-lamH) * Math.pow(lamH, k) / facT;
  }
  facT = 1;
  for (let k = 0; k <= maxGoals; k++) {
    if (k > 0) facT *= k;
    pmfA[k] = Math.exp(-lamA) * Math.pow(lamA, k) / facT;
  }
  let sH = 0, sA = 0;
  for (let k = 0; k <= maxGoals; k++) { sH += pmfH[k]; sA += pmfA[k]; }
  for (let k = 0; k <= maxGoals; k++) { pmfH[k] /= sH; pmfA[k] /= sA; }
  for (let i = 0; i <= maxGoals; i++) { mat[i] = []; for (let j = 0; j <= maxGoals; j++) mat[i][j] = pmfH[i] * pmfA[j]; }
  return mat;
}

/**
 * Predict 1X2 for a football match using trained Poisson params.
 * Returns null if model inactive or teams/league not found.
 */
function predictFootball({ teamHome, teamAway, league }) {
  const params = getParams();
  if (!params) return null;
  const leagueInfo = _findLeague(params.leagues, league);
  if (!leagueInfo) return null;
  const lp = leagueInfo.league;
  const th = _findTeam(params.teams, teamHome);
  const ta = _findTeam(params.teams, teamAway);
  if (!th || !ta) return null;

  // Poisson lambdas usando attack/defense strengths
  const lamH = lp.avg_home_goals * th.team.attack_home * ta.team.defense_away;
  const lamA = lp.avg_away_goals * ta.team.attack_away * th.team.defense_home;
  const mat = _poissonMatrix(Math.max(0.1, Math.min(6, lamH)), Math.max(0.1, Math.min(6, lamA)), 8);

  let pH = 0, pD = 0, pA = 0;
  for (let i = 0; i < mat.length; i++) {
    for (let j = 0; j < mat[i].length; j++) {
      if (i > j) pH += mat[i][j];
      else if (i === j) pD += mat[i][j];
      else pA += mat[i][j];
    }
  }
  // Normaliza (devido a truncagem)
  const total = pH + pD + pA;
  if (total > 0) { pH /= total; pD /= total; pA /= total; }

  return {
    pH: +pH.toFixed(4),
    pD: +pD.toFixed(4),
    pA: +pA.toFixed(4),
    lamH: +lamH.toFixed(3),
    lamA: +lamA.toFixed(3),
    source: 'trained_poisson',
    league_key: leagueInfo.key,
    team_home_key: th.key,
    team_away_key: ta.key,
    confidence: Math.min(0.9, 0.5 + (th.team.home_games + ta.team.away_games) / 200),
  };
}

module.exports = {
  hasTrainedFootballModel,
  predictFootball,
  getParams,
  _findLeague, _findTeam, // exported for testing
};
