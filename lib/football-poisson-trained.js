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

function invalidateCache() {
  _cached = null;
  _cachedAt = 0;
}

function hasTrainedFootballModel() {
  const p = getParams();
  return !!(p && p.leagues && Object.keys(p.leagues).length > 0);
}

// Normaliza nome pra lookup em params.teams. NFD strip acentos antes de
// remover non-alphanum: "Alavés"/"Atlético"/"Sevilla F.C." viram alaves/
// atletico/sevillafc consistentemente. Sem isso, _norm("Alavés")="alavs"
// não batia com fd "Alaves" → trained=false em Spain top-tier.
// Stopwords removidos: "de", "da", "do", "of", "the", "ac", "fc", "cf",
// "club", "esports". Reconcilia "Atlético de Madrid" ↔ "Atletico Madrid"
// e "FC Barcelona" ↔ "Barcelona" sem alias dedicado.
function _norm(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\b(de|da|do|of|the|ac|fc|cf|club|esports)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// 2026-05-02: aliases pra reconciliar feed live (Pinnacle/TheOddsAPI nome
// completo) com football-data.co.uk (abreviação histórica). Sem isso ~30%
// dos jogos top-5 EU caíam em trained=false e iam pra path heurístico.
// Lista cobre os casos vistos em log audit + variantes comuns.
// Cada entry: feed_norm → fd_norm. _findTeam tenta match direto primeiro,
// depois alias forward+reverse, depois substring fallback.
const _TEAM_ALIASES = {
  // Premier League
  nottinghamforest: 'nottmforest',
  nottmforest: 'nottinghamforest',
  wolverhampton: 'wolves',
  wolves: 'wolverhampton',
  manchestercity: 'mancity',
  mancity: 'manchestercity',
  manchesterunited: 'manunited',
  manunited: 'manchesterunited',
  manchesterutd: 'manunited',
  newcastleunited: 'newcastle',
  newcastle: 'newcastleunited',
  westhamunited: 'westham',
  westham: 'westhamunited',
  leedsunited: 'leeds',
  leeds: 'leedsunited',
  brightonhoveunited: 'brighton',
  brightonhovealbion: 'brighton',
  tottenhamhotspur: 'tottenham',
  tottenham: 'spurs',
  spurs: 'tottenham',
  // La Liga
  athleticbilbao: 'athbilbao',
  athbilbao: 'athleticbilbao',
  athleticclub: 'athbilbao',
  atleticomadrid: 'athmadrid',
  athmadrid: 'atleticomadrid',
  atleticodemadrid: 'athmadrid',
  espanyol: 'espanol',
  espanol: 'espanyol',
  realmadrid: 'realmadrid',
  realsociedad: 'sociedad',
  sociedad: 'realsociedad',
  realbetis: 'betis',
  betis: 'realbetis',
  rayovallecano: 'vallecano',
  vallecano: 'rayovallecano',
  // Serie A (Italia)
  internazionale: 'inter',
  inter: 'internazionale',
  asroma: 'roma',
  roma: 'asroma',
  acmilan: 'milan',
  milan: 'acmilan',
  juventus: 'juventus',
  // Bundesliga
  bayernmunich: 'bayernmunchen',
  bayernmunchen: 'bayernmunich',
  borussiadortmund: 'dortmund',
  dortmund: 'borussiadortmund',
  bayerleverkusen: 'leverkusen',
  leverkusen: 'bayerleverkusen',
  rbleipzig: 'leipzig',
  leipzig: 'rbleipzig',
  eintrachtfrankfurt: 'efrankfurt',
  efrankfurt: 'eintrachtfrankfurt',
  // Ligue 1
  parissg: 'parissg',
  parissaintgermain: 'parissg',
  psg: 'parissg',
  olympiquemarseille: 'marseille',
  marseille: 'olympiquemarseille',
  olympiquelyonnais: 'lyon',
  lyon: 'olympiquelyonnais',
  asmonaco: 'monaco',
  monaco: 'asmonaco',
};

function _findTeam(teams, name) {
  if (!teams || !name) return null;
  const n = _norm(name);
  // Direct match
  for (const k in teams) {
    if (_norm(k) === n) return { key: k, team: teams[k] };
  }
  // Alias match: feed name → fd name OU fd name → feed name
  const alias = _TEAM_ALIASES[n];
  if (alias) {
    for (const k in teams) {
      if (_norm(k) === alias) return { key: k, team: teams[k] };
    }
  }
  // Reverse alias: o team key (de fd) pode ter alias→feed; tenta lookup por valor.
  for (const k in teams) {
    const kn = _norm(k);
    if (_TEAM_ALIASES[kn] === n) return { key: k, team: teams[k] };
  }
  // Substring fallback
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
  // Token match: verifica se TODAS as palavras significativas de uma side
  // aparecem na outra. Trata "La Liga 2 - Spain" ≈ "Spain Segunda",
  // "Serie B - Italy" ≈ "Italy Serie B", "League 1" ≈ "England League One".
  // 'a'/'b' NÃO são stop (podem ser "Serie A" vs "Serie B" — divisão crítica).
  // 2026-04-28: substring loop removido — bypassava country guard
  // (query "Premier League" casava "Russia Premier League" via includes()
  // antes do token match rejeitar). Token match cobre os casos legítimos do
  // substring loop (mesma direção via expand()) sem o leak cross-país.
  const STOP = new Set(['the', 'of', 'and', '-', '/', '(', ')', 'liga', 'league']);
  const SYN = { '1': ['one', 'primeira', 'premier'], '2': ['two', 'segunda', 'second', 'ii'],
                '3': ['three', 'tercera', 'third'], 'la': ['la'], 'série': ['serie'] };
  const toks = (s) => s.toLowerCase().replace(/[^a-z0-9à-ú\s]/g, ' ').split(/\s+/)
    .map(t => t.replace('á','a').replace('é','e').replace('í','i').replace('ó','o').replace('ú','u'))
    .filter(t => t && !STOP.has(t));
  const expand = (t) => (SYN[t] || [t]).concat([t]);
  const queryToks = toks(n);
  // Guarda anti-ambigüidade: se query só tem tokens puro-digit após STOP
  // (ex: "League 1" → ['1']), o match sinonímico ('1'→'premier') gera falsos positivos
  // cross-liga ("League 1" virava match com "Ireland Premier Division"). Exige ≥1
  // token não-digit pra proceder com fuzzy match. Sem country/nome específico na
  // query, retornar null é mais seguro que adivinhar liga errada.
  const hasNonDigitQuery = queryToks.some(t => !/^\d+$/.test(t));
  if (!hasNonDigitQuery) return null;
  // Country guard: ex "Premier League" (toks=['premier']) casava com
  // "Ireland Premier Division" (toks=['ireland','premier','division']) via
  // direção query⊂key. Se key tem país e query não menciona país nem outro
  // discriminador, rejeita — adivinhar liga errada é pior que não adivinhar.
  const COUNTRY_TOKENS = new Set([
    'ireland','england','scotland','wales','spain','italy','france','germany',
    'netherlands','holland','portugal','brazil','japan','usa','mexico','china',
    'sweden','norway','finland','denmark','poland','russia','romania','turkey',
    'greece','austria','belgium','switzerland','argentina','colombia','chile',
    'peru','ecuador','uruguay','paraguay','bolivia','korea','indonesia',
    'thailand','australia','israel','serbia','croatia','hungary','slovakia',
    'slovenia','bulgaria','ukraine','iceland','cyprus','malta','luxembourg',
    'czech','estonia','latvia','lithuania','moldova','albania','macedonia',
    'kazakhstan','azerbaijan','georgia','armenia','singapore','malaysia',
    'vietnam','india','iran','iraq','egypt','morocco','tunisia','algeria',
    'south','north','saudi','qatar','uae','bahrain',
    'brasil','espanha','italia','franca','alemanha',
    // Endonyms / variantes de país. 'cymru' (Galês) escapava → Premier
    // League casava "Cymru Premier" como key sem country guard. Adicionados
    // pra fechar essa classe de leak.
    'cymru','welsh','eire','espana','deutschland','nederland','suomi','sverige',
    'norge','danmark','polska','rossiya','ellada','magyar','bharat','nippon',
  ]);
  const queryCountries = queryToks.filter(t => COUNTRY_TOKENS.has(t));
  const queryNonCountryToks = queryToks.filter(t => !COUNTRY_TOKENS.has(t));
  for (const k in leagues) {
    const keyToks = toks(k);
    if (!keyToks.length || !queryToks.length) continue;
    const keyCountries = keyToks.filter(t => COUNTRY_TOKENS.has(t));
    // Guard 1: ambos especificam país — devem concordar (evita Spain↔Italy)
    if (queryCountries.length && keyCountries.length) {
      if (!queryCountries.some(c => keyCountries.includes(c))) continue;
    }
    // Guard 2: key tem país, query não — exige ≥2 tokens não-country na query
    // (evita "Premier League" → "Ireland Premier Division")
    if (keyCountries.length && !queryCountries.length && queryNonCountryToks.length < 2) continue;
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

/**
 * Extrai probabilidades de mercados secundários a partir da Poisson matrix.
 * Reusa a mesma matrix do 1X2 — sem custo extra.
 *
 * Mercados retornados:
 *   btts.yes / btts.no                          — both teams to score
 *   ou[N].over / ou[N].under (N = 0.5, 1.5, 2.5, 3.5, 4.5)
 *   ah[L].home / ah[L].away (L = -1.5, -0.5, 0.5, 1.5)
 *     com pushVoid pra linhas inteiras (push = aposta volta)
 *   dc.h_d / dc.d_a / dc.h_a                    — double chance
 *   ouHome[N].over / ouHome[N].under            — gols mandante
 *   ouAway[N].over / ouAway[N].under            — gols visitante
 *
 * AH com linhas fracionárias (.5) são "win/loss only" — push impossível.
 * AH inteiras (-1, 0, +1) suportadas via pushVoid (volta stake).
 */
function _extractMarkets(mat) {
  const N = mat.length;
  // Marginais (gols home, gols away)
  const pmfH = new Array(N).fill(0);
  const pmfA = new Array(N).fill(0);
  let pBttsYes = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      pmfH[i] += mat[i][j];
      pmfA[j] += mat[i][j];
      if (i >= 1 && j >= 1) pBttsYes += mat[i][j];
    }
  }
  const pBttsNo = 1 - pBttsYes;
  // OU totals
  const ou = {};
  for (const line of [0.5, 1.5, 2.5, 3.5, 4.5]) {
    const thresh = Math.floor(line); // > thresh wins for over
    let pOver = 0;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        if ((i + j) > thresh) pOver += mat[i][j];
      }
    }
    ou[line.toFixed(1)] = { over: +pOver.toFixed(4), under: +(1 - pOver).toFixed(4) };
  }
  // Asian Handicap — só linhas .5 (sem push)
  const ah = {};
  for (const line of [-1.5, -0.5, 0.5, 1.5]) {
    let pHome = 0;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        if ((i + line) > j) pHome += mat[i][j];
      }
    }
    ah[line.toFixed(1)] = { home: +pHome.toFixed(4), away: +(1 - pHome).toFixed(4) };
  }
  // Double chance
  let pH = 0, pD = 0, pA = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      if (i > j) pH += mat[i][j];
      else if (i === j) pD += mat[i][j];
      else pA += mat[i][j];
    }
  }
  const dc = {
    h_d: +(pH + pD).toFixed(4),
    d_a: +(pD + pA).toFixed(4),
    h_a: +(pH + pA).toFixed(4),
  };
  // Team totals (gols home/away separadamente)
  const ouHome = {}, ouAway = {};
  for (const line of [0.5, 1.5, 2.5]) {
    const thresh = Math.floor(line);
    let pH_over = 0, pA_over = 0;
    for (let k = thresh + 1; k < N; k++) {
      pH_over += pmfH[k];
      pA_over += pmfA[k];
    }
    ouHome[line.toFixed(1)] = { over: +pH_over.toFixed(4), under: +(1 - pH_over).toFixed(4) };
    ouAway[line.toFixed(1)] = { over: +pA_over.toFixed(4), under: +(1 - pA_over).toFixed(4) };
  }
  return {
    btts: { yes: +pBttsYes.toFixed(4), no: +pBttsNo.toFixed(4) },
    ou, ah, dc, ouHome, ouAway,
  };
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

  // ── Dixon-Coles low-score correction ──
  // Modelo Poisson independente subestima 0-0 e 1-1 (ties baixos correlacionam
  // empiricamente: ambos times conservadores) e superestima 1-0/0-1 (mismatches
  // 1-0 são menos comuns que o Poisson prevê).
  // ρ default -0.10 (default empírico Dixon-Coles 1997 leagues europeias).
  // Ajuste τ(i,j,λH,λA,ρ) aplicado APENAS aos 4 quadrantes.
  // Ref: https://www.math.ku.dk/~rolf/teaching/thesis/DixonColes.pdf
  const rho = parseFloat(process.env.FB_DC_RHO ?? '-0.10');
  if (Number.isFinite(rho) && rho !== 0) {
    const tau00 = 1 - lamH * lamA * rho;
    const tau01 = 1 + lamH * rho;
    const tau10 = 1 + lamA * rho;
    const tau11 = 1 - rho;
    mat[0][0] *= tau00;
    if (mat[0][1] != null) mat[0][1] *= tau01;
    if (mat[1][0] != null) mat[1][0] *= tau10;
    if (mat[1][1] != null) mat[1][1] *= tau11;
    // Renormalizar matrix pra somar 1
    let total = 0;
    for (let i = 0; i <= maxGoals; i++) for (let j = 0; j <= maxGoals; j++) total += mat[i][j];
    if (total > 0) {
      for (let i = 0; i <= maxGoals; i++) for (let j = 0; j <= maxGoals; j++) mat[i][j] /= total;
    }
  }
  return mat;
}

/**
 * Predict 1X2 for a football match using trained Poisson params.
 * Returns null if model inactive or teams/league not found.
 */
function predictFootball({ teamHome, teamAway, league, db }) {
  const params = getParams();
  if (!params) return null;
  const leagueInfo = _findLeague(params.leagues, league);
  if (!leagueInfo) return null;
  const lp = leagueInfo.league;
  const th = _findTeam(params.teams, teamHome);
  const ta = _findTeam(params.teams, teamAway);
  if (!th || !ta) return null;
  // 2026-04-29: features adicionais de football_data_csv (closing odds + h2h
  // record) pra detectar divergence model vs sharp market.
  let fdFeatures = null;
  if (db && process.env.FB_USE_FD_CSV !== 'false') {
    try {
      const { getClosingOddsBenchmark, getShotXgForm } = require('./football-data-features');
      fdFeatures = {
        market: getClosingOddsBenchmark(db, teamHome, teamAway),
        home_form: getShotXgForm(db, teamHome, { days: 90 }),
        away_form: getShotXgForm(db, teamAway, { days: 90 }),
      };
    } catch (_) { /* opcional */ }
  }

  // Poisson lambdas usando attack/defense strengths + form boost
  // Form factor: PPG recente normalizado pro baseline 1.5. Scale leve:
  //   form=3.0 (5 wins) → factor 1.20
  //   form=1.5 (baseline) → factor 1.00
  //   form=0.0 (5 losses) → factor 0.80
  // 2026-04-28: clamp [0.85, 1.15]. Antes form_ppg outlier (bug import com
  // gol-grande contra time fraco → ppg=4.5+) podia gerar formFactor>1.4 que
  // multiplicava defesa rival → λ saturava em 6 sem sinal real. Pior:
  // ppg>5.25 fazia (2-form)<0 → defenseAdj negativo → matrix degenerada.
  const formFactor = (ppg) => Math.max(0.85, Math.min(1.15, 1 + (ppg - 1.5) * 0.133));
  const hForm = th.team.form_ppg != null ? formFactor(th.team.form_ppg) : 1;
  const aForm = ta.team.form_ppg != null ? formFactor(ta.team.form_ppg) : 1;
  // Rest factor: <3 dias = fadiga (-5%), 3-6 dias = normal, 7+ dias = fresh (+3%)
  const restFactor = (daysToMatch) => {
    if (!Number.isFinite(daysToMatch) || daysToMatch <= 0) return 1;
    if (daysToMatch < 3) return 0.95;
    if (daysToMatch < 7) return 1.0;
    return 1.03;
  };
  const matchTs = Date.now();
  const hRest = th.team.last_match_ts ? (matchTs - th.team.last_match_ts) / 86400000 : 7;
  const aRest = ta.team.last_match_ts ? (matchTs - ta.team.last_match_ts) / 86400000 : 7;
  const hRestF = restFactor(hRest);
  const aRestF = restFactor(aRest);
  // Home team bom form + rest boosta seu attack e reduz vulnerabilidade defensiva
  const attackHomeAdj = th.team.attack_home * hForm * hRestF;
  const defenseHomeAdj = th.team.defense_home * (2 - hForm) / hRestF;
  const attackAwayAdj = ta.team.attack_away * aForm * aRestF;
  const defenseAwayAdj = ta.team.defense_away * (2 - aForm) / aRestF;
  let lamH = lp.avg_home_goals * attackHomeAdj * defenseAwayAdj;
  let lamA = lp.avg_away_goals * attackAwayAdj * defenseHomeAdj;

  // 2026-04-30: xG blend — football_data_csv tem shots/SoT por match. Convert
  // p/ xG proxy (SoT × 0.32) e blend com λ Poisson. Motivação: λ vem de gols
  // realizados (forma + ataque/defesa de gols). xG é signal mais limpo —
  // captura criação de chance independente da finishing variance. Blend
  // 15% xG + 85% λ original; regressão pra mean reduz over/under-performance
  // de finishing (lit shows ~70% reverte em 10-15 jogos).
  // Cap [0.85, 1.15] no ratio pra estabilidade. Skip se n_with_shots<3.
  // Opt-out: FB_XG_BLEND_DISABLED=true.
  let xgBlendH = 1.0, xgBlendA = 1.0;
  if (fdFeatures && !/^(1|true|yes)$/i.test(String(process.env.FB_XG_BLEND_DISABLED || ''))) {
    const blendW = parseFloat(process.env.FB_XG_BLEND_WEIGHT ?? '0.15');
    const _xgRatio = (form, leagueAvg) => {
      if (!form || !Number.isFinite(form.xg_for_pg) || form.xg_for_pg <= 0) return null;
      if (!Number.isFinite(leagueAvg) || leagueAvg <= 0) return null;
      if (!Number.isFinite(form.n_with_shots) || form.n_with_shots < 3) return null;
      const r = form.xg_for_pg / leagueAvg;
      return Math.max(0.5, Math.min(2.0, r));
    };
    const rH = _xgRatio(fdFeatures.home_form, lp.avg_home_goals);
    const rA = _xgRatio(fdFeatures.away_form, lp.avg_away_goals);
    if (rH != null) {
      const blended = (1 - blendW) + blendW * rH;
      xgBlendH = Math.max(0.85, Math.min(1.15, blended));
      lamH = lamH * xgBlendH;
    }
    if (rA != null) {
      const blended = (1 - blendW) + blendW * rA;
      xgBlendA = Math.max(0.85, Math.min(1.15, blended));
      lamA = lamA * xgBlendA;
    }
  }

  // H2H factor — quando temos record de confrontos diretos, ajusta lambda
  // suavemente. Cap ±10% (h2h n>=3 garantido pelo trainer).
  // Sinal: avg_total_goals do par vs (lamH+lamA) atual. Se par é high-scoring
  // historicamente, boosta levemente. Vice-versa.
  let h2hFactor = 1.0, h2hKey = null;
  if (params.h2h) {
    const _norm2 = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const h1 = _norm2(teamHome), h2 = _norm2(teamAway);
    const [a, b] = h1 < h2 ? [h1, h2] : [h2, h1];
    h2hKey = `${a}__${b}`;
    const h2h = params.h2h[h2hKey];
    if (h2h && h2h.n >= 3) {
      const baselineGoals = lamH + lamA;
      const h2hGoals = h2h.avg_total_goals;
      const ratio = h2hGoals / Math.max(0.5, baselineGoals);
      // Blend leve: 85% baseline + 15% H2H ratio. Cap ±10%.
      const blendWeight = parseFloat(process.env.FB_H2H_BLEND_WEIGHT ?? '0.15');
      const factor = 1 - blendWeight + blendWeight * ratio;
      h2hFactor = Math.max(0.90, Math.min(1.10, factor));
      lamH = lamH * h2hFactor;
      lamA = lamA * h2hFactor;
    }
  }
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

  // Mercados secundários (BTTS, OU múltiplas linhas, AH, DC, team totals)
  // derivados da mesma matrix — sem custo extra.
  const markets = _extractMarkets(mat);

  // 2026-04-29: market divergence vs Pinnacle closing odds (sharp ref).
  // Suspect = max diff > 10pp → confidence reduzido.
  let marketDivergence = null;
  if (fdFeatures?.market) {
    try {
      const { getMarketDivergence } = require('./football-data-features');
      marketDivergence = getMarketDivergence({ pH, pD, pA }, fdFeatures.market);
    } catch (_) {}
  }

  let confidence = Math.min(0.9, 0.5 + (th.team.home_games + ta.team.away_games) / 200);
  if (marketDivergence?.suspect) {
    // Sharp money discorda forte → reduz confidence em 30%.
    confidence = Math.max(0.20, confidence * 0.70);
  }

  return {
    pH: +pH.toFixed(4),
    pD: +pD.toFixed(4),
    pA: +pA.toFixed(4),
    lamH: +lamH.toFixed(3),
    lamA: +lamA.toFixed(3),
    home_form_ppg: th.team.form_ppg,
    away_form_ppg: ta.team.form_ppg,
    home_form_factor: +hForm.toFixed(3),
    away_form_factor: +aForm.toFixed(3),
    home_rest_days: +hRest.toFixed(1),
    away_rest_days: +aRest.toFixed(1),
    home_rest_factor: +hRestF.toFixed(3),
    away_rest_factor: +aRestF.toFixed(3),
    h2h_factor: +h2hFactor.toFixed(3),
    h2h_key: h2hKey,
    xg_blend_home: +xgBlendH.toFixed(3),
    xg_blend_away: +xgBlendA.toFixed(3),
    markets,  // { btts, ou:{0.5..4.5}, ah:{-1.5..1.5}, dc, ouHome, ouAway }
    fd_features: fdFeatures, // closing odds benchmark + recent form
    market_divergence: marketDivergence, // model vs sharp closing
    source: 'trained_poisson_v4_h2h',
    league_key: leagueInfo.key,
    team_home_key: th.key,
    team_away_key: ta.key,
    confidence,
  };
}

module.exports = {
  hasTrainedFootballModel,
  predictFootball,
  getParams,
  invalidateCache,
  _findLeague, _findTeam, // exported for testing
};
