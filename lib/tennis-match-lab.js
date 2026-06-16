'use strict';
/**
 * tennis-match-lab.js — Display-only Tennis match analyzer for the /edge "Tennis Lab".
 * REUSES the production tennis model read-only (getTennisProbability ML ensemble for the
 * headline + the Markov engine for the markets). Does NOT build a parallel model (P3 —
 * tennis already has one). Money-path airtight: only read-only/pure functions; never
 * scanTennisMarkets / stake / Kelly / tips. fairOdd = 1/p, edge = p*odd-1 computed inline.
 */
const { getTennisProbability, detectSurface, tournamentTier } = require('./tennis-model');
const { priceTennisMatch, extractServeProbs, solvePointProbs, handicapGamesProb,
        estimateTennisAces, estimateTennisDoubleFaults } = require('./tennis-markov-model');
const { applyMarkovCalib } = require('./tennis-markov-calib');
const { getPlayerServeProfile, getPlayerRankInfo } = require('./tennis-player-stats');

// SPW médio ATP/WTA por superfície (ref. Sackmann) — ancora solvePointProbs no fallback.
const SPW_AVG = { hard: 0.637, clay: 0.611, grass: 0.662, indoor: 0.648 };

// getPlayerServeProfile retorna firstInPct/firstWonPct/secondWonPct em FRAÇÃO (0-1);
// serveSubModel/extractServeProbs querem ...Pct em PERCENT (0-100) + .games. Adapta.
function _serveStatsFromProfile(prof) {
  if (!prof || prof.firstInPct == null || prof.firstWonPct == null || prof.secondWonPct == null) return null;
  const spw = prof.firstInPct * prof.firstWonPct + (1 - prof.firstInPct) * prof.secondWonPct; // 0-1
  return {
    firstServePct: prof.firstInPct * 100,
    firstServePointsPct: prof.firstWonPct * 100,
    secondServePointsPct: prof.secondWonPct * 100,
    games: prof.matches,   // serveSubModel exige >= 2 (getPlayerServeProfile já garante >= 5)
    spw,                   // consumido pelo trained model (enrich.serveStats.spw)
  };
}

// P(total > line) a partir do pdf {games:prob}.
function _pOverFromPdf(pdf, line) {
  if (!pdf) return 0;
  let s = 0;
  for (const [k, v] of Object.entries(pdf)) if (Number(k) > line) s += v;
  return s;
}

const _clampP = (p) => Math.max(1e-6, Math.min(1 - 1e-6, p));
const _fairOdd = (p) => +(1 / _clampP(p)).toFixed(2);
const _edge = (p, odd) => (typeof odd === 'number' && odd > 1) ? +((p * odd) - 1).toFixed(3) : null;

function analyzeTennisMatch(db, { player1, player2, surface, bestOf, league = '', bookOdds = {}, iters = 15000 } = {}) {
  bestOf = bestOf === 5 ? 5 : 3;
  const surf = (surface && String(surface).toLowerCase()) || detectSurface(league) || 'hard';
  const tier = tournamentTier(league);
  const format = bestOf >= 5 ? 'bo5' : 'bo3';

  if (!player1 || !player2) {
    return {
      ok: true,
      headline: { probP1: 0.5, probP2: 0.5, label: 'lean fraco', confidence: 0, method: 'none', surface: surf, tier, bestOf, markovProbP1: null, divergence: null, divergenceFlag: false },
      factors: [], serve: null, markets: {}, quality: { notes: ['informe os dois jogadores'] },
    };
  }

  const prof1 = getPlayerServeProfile(db, player1, { surface: surf });
  const prof2 = getPlayerServeProfile(db, player2, { surface: surf });
  const rank1 = getPlayerRankInfo(db, player1);
  const rank2 = getPlayerRankInfo(db, player2);
  const ss1 = _serveStatsFromProfile(prof1);
  const ss2 = _serveStatsFromProfile(prof2);

  const enrich = {
    serveStats1: ss1, serveStats2: ss2,
    ranking1: rank1 ? { rank: rank1.latestRank } : undefined,
    ranking2: rank2 ? { rank: rank2.latestRank } : undefined,
  };
  const pred = getTennisProbability(db, { team1: player1, team2: player2, league, time: Date.now() }, null, enrich, surf);
  const probP1 = pred.modelP1;

  let serveInfo;
  const sp = extractServeProbs(ss1, ss2, { surface: surf });
  if (sp) {
    serveInfo = { p1Serve: +sp.p1Serve.toFixed(4), p2Serve: +sp.p2Serve.toFixed(4), method: sp.method, source: 'profiles' };
  } else {
    const solved = solvePointProbs(probP1, SPW_AVG[surf] || 0.637, bestOf);
    serveInfo = { p1Serve: +solved.p1Serve.toFixed(4), p2Serve: +solved.p2Serve.toFixed(4), method: 'solved', source: 'solved' };
  }

  const mk = priceTennisMatch({ p1Serve: serveInfo.p1Serve, p2Serve: serveInfo.p2Serve, bestOf, iters });
  const markovProbP1 = mk.pMatch;
  const divergence = +Math.abs(probP1 - markovProbP1).toFixed(4);
  const calibOpts = { tier: tier || undefined, format };

  const ml = {
    probP1: +probP1.toFixed(4), probP2: +pred.modelP2.toFixed(4),
    fairOddP1: _fairOdd(probP1), fairOddP2: _fairOdd(pred.modelP2),
    edgeP1: _edge(probP1, bookOdds.mlP1), edgeP2: _edge(pred.modelP2, bookOdds.mlP2),
  };

  const HG_LINES = bestOf >= 5 ? [-6.5, -4.5, -2.5, 2.5, 4.5, 6.5] : [-5.5, -3.5, -1.5, 1.5, 3.5, 5.5];
  const bookHg = (bookOdds.handicap && typeof bookOdds.handicap === 'object') ? bookOdds.handicap : {};
  const handicapGames = HG_LINES.map((line) => {
    const pHomeRaw = handicapGamesProb(mk.gamesMarginPdf, line);
    if (pHomeRaw == null) return null;
    const pHome = applyMarkovCalib(pHomeRaw, 'handicapGames', { ...calibOpts, side: 'home' });
    return { line, side: 'home', prob: +pHome.toFixed(4), fairOdd: _fairOdd(pHome), edge: _edge(pHome, bookHg[String(line)]) };
  }).filter(Boolean);

  const base = Math.round(mk.totalGamesAvg);
  const TG_LINES = [base - 2.5, base - 1.5, base - 0.5, base + 0.5, base + 1.5, base + 2.5].filter(l => l > 0);
  const bookOver = (bookOdds.totalOver && typeof bookOdds.totalOver === 'object') ? bookOdds.totalOver : {};
  const bookUnder = (bookOdds.totalUnder && typeof bookOdds.totalUnder === 'object') ? bookOdds.totalUnder : {};
  const totalGames = TG_LINES.map((line) => {
    const pOverRaw = _pOverFromPdf(mk.totalGamesPdf, line);
    const pOver = applyMarkovCalib(pOverRaw, 'totalGames', { ...calibOpts, side: 'over' });
    const pUnder = applyMarkovCalib(1 - pOverRaw, 'totalGames', { ...calibOpts, side: 'under' });
    return {
      line, pOver: +pOver.toFixed(4), pUnder: +pUnder.toFixed(4),
      fairOddOver: _fairOdd(pOver), fairOddUnder: _fairOdd(pUnder),
      edgeOver: _edge(pOver, bookOver[String(line)]), edgeUnder: _edge(pUnder, bookUnder[String(line)]),
    };
  });

  const setBetting = Object.entries(mk.setDist)
    .map(([score, p]) => ({ score, prob: +p.toFixed(4), fairOdd: _fairOdd(p) }))
    .sort((a, b) => b.prob - a.prob);

  const tiebreak = {
    pMatchHasTiebreak: mk.pTiebreakMatch, pFirstSetTiebreak: mk.pTiebreakFirstSet,
    fairOddYes: _fairOdd(mk.pTiebreakMatch), fairOddNo: _fairOdd(1 - mk.pTiebreakMatch),
  };
  const straightSets = { prob: mk.pStraightSets, fairOdd: _fairOdd(mk.pStraightSets) };

  let aces = null, doubleFaults = null;
  if (prof1 && prof2 && prof1.acePerMatchAvg != null && prof2.acePerMatchAvg != null) {
    const a = estimateTennisAces({ acesPerMatch1: prof1.acePerMatchAvg, acesPerMatch2: prof2.acePerMatchAvg, bestOf, surface: surf });
    if (a) aces = { totalAvg: a.totalAcesAvg, lines: Object.entries(a.pOver).map(([line, p]) => ({ line: +line, pOver: p, fairOddOver: _fairOdd(p) })) };
  }
  if (prof1 && prof2 && prof1.dfPerMatchAvg != null && prof2.dfPerMatchAvg != null) {
    const d = estimateTennisDoubleFaults({ dfPerMatch1: prof1.dfPerMatchAvg, dfPerMatch2: prof2.dfPerMatchAvg, bestOf, surface: surf });
    if (d) doubleFaults = { totalAvg: d.totalDfAvg, lines: Object.entries(d.pOver).map(([line, p]) => ({ line: +line, pOver: p, fairOddOver: _fairOdd(p) })) };
  }

  const found1 = !!(pred._elo && pred._elo.found1);
  const found2 = !!(pred._elo && pred._elo.found2);
  const conf = pred.confidence;
  let label;
  if (!found1 && !found2) label = 'lean fraco';
  else if (conf >= 0.55 && Math.abs(probP1 - 0.5) >= 0.10) label = 'forte';
  else label = 'lean';

  const notes = [];
  if (!found1) notes.push(`${player1}: pouco/zero histórico no Elo`);
  if (!found2) notes.push(`${player2}: pouco/zero histórico no Elo`);
  if (serveInfo.source === 'solved') notes.push('sem perfil de saque — games/sets estimados a partir do headline');
  if (!aces) notes.push('aces: dados de saque insuficientes');
  if (!doubleFaults) notes.push('double faults: dados insuficientes');

  return {
    ok: true,
    headline: {
      probP1: +probP1.toFixed(4), probP2: +pred.modelP2.toFixed(4),
      label, confidence: +conf.toFixed(2), method: pred.method, surface: surf, tier, bestOf,
      markovProbP1: +markovProbP1.toFixed(4), divergence, divergenceFlag: divergence > 0.05,
    },
    factors: pred.factors || [],
    serve: serveInfo,
    markets: { ml, handicapGames, totalGames, setBetting, tiebreak, straightSets, aces, doubleFaults },
    quality: { eloFound1: found1, eloFound2: found2, hasServe1: !!ss1, hasServe2: !!ss2, hasRank1: !!rank1, hasRank2: !!rank2, notes },
  };
}

module.exports = { analyzeTennisMatch, _serveStatsFromProfile, _pOverFromPdf };
