// lib/lol-draft-train.js — pure training functions (no I/O). Consumed by scripts/train-lol-draft-model.js.
const { normalizeChampion } = require('./lol-champions');

function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

// Mastery feature params (shared train↔serving). Fixed constants; the logistic weight
// absorbs the final scale, so no normalization stats are persisted.
const MASTERY = { N_FULL: 20, MIN_N: 3, KDA_SCALE: 2, GD15_SCALE: 500 };

function normPlayerName(s) {
  return String(s || '').toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, '').trim();
}

// { "player|champ": {wins,n,kSum,dSum,aSum,gd15Sum,gd15N}, "player|*": {nAll,kAll,dAll,aAll,gd15All,gd15N} }
// player|champ pairs below MASTERY.MIN_N are pruned to bound artifact size; baselines kept.
function buildMasteryTable(rows) {
  const m = {};
  for (const r of rows) {
    const pl = normPlayerName(r.playername); if (!pl) continue;
    const c = normalizeChampion(r.champion); if (!c) continue;
    const k = r.kills || 0, d = r.deaths || 0, a = r.assists || 0;
    const hasGd = Number.isFinite(r.golddiffat15);
    const pc = (m[`${pl}|${c}`] = m[`${pl}|${c}`] || { wins: 0, n: 0, kSum: 0, dSum: 0, aSum: 0, gd15Sum: 0, gd15N: 0 });
    pc.wins += r.result ? 1 : 0; pc.n += 1; pc.kSum += k; pc.dSum += d; pc.aSum += a;
    if (hasGd) { pc.gd15Sum += r.golddiffat15; pc.gd15N += 1; }
    const b = (m[`${pl}|*`] = m[`${pl}|*`] || { nAll: 0, kAll: 0, dAll: 0, aAll: 0, gd15All: 0, gd15N: 0 });
    b.nAll += 1; b.kAll += k; b.dAll += d; b.aAll += a;
    if (hasGd) { b.gd15All += r.golddiffat15; b.gd15N += 1; }
  }
  for (const key of Object.keys(m)) {
    if (!key.endsWith('|*') && m[key].n < MASTERY.MIN_N) delete m[key];
  }
  return m;
}

function buildWrTable(rows) {
  const wr = {};
  for (const r of rows) {
    const c = normalizeChampion(r.champion); if (!c) continue;
    const role = String(r.position || '').toLowerCase();
    const key = `${c}|${role}`;
    (wr[key] = wr[key] || { wins: 0, n: 0 });
    wr[key].wins += r.result ? 1 : 0; wr[key].n += 1;
  }
  return wr;
}

function _gamesBy(rows) {
  const games = new Map();
  for (const r of rows) {
    if (!games.has(r.gameid)) games.set(r.gameid, []);
    games.get(r.gameid).push(r);
  }
  return games;
}

function buildMatchupMatrix(rows) {
  const m = {};
  for (const [, players] of _gamesBy(rows)) {
    const blue = players.filter(p => String(p.side).toLowerCase() === 'blue');
    const red = players.filter(p => String(p.side).toLowerCase() === 'red');
    for (const b of blue) {
      const role = String(b.position || '').toLowerCase();
      const opp = red.find(p => String(p.position || '').toLowerCase() === role);
      if (!opp) continue;
      const bc = normalizeChampion(b.champion), rc = normalizeChampion(opp.champion);
      if (!bc || !rc) continue;
      m[role] = m[role] || {}; m[role][bc] = m[role][bc] || {};
      const cell = (m[role][bc][rc] = m[role][bc][rc] || { wins: 0, n: 0 });
      cell.wins += b.result ? 1 : 0; cell.n += 1;
    }
  }
  return m;
}

function buildSynergyMatrix(rows) {
  const s = {};
  for (const [, players] of _gamesBy(rows)) {
    for (const side of ['blue', 'red']) {
      const champs = players.filter(p => String(p.side).toLowerCase() === side)
        .map(p => ({ c: normalizeChampion(p.champion), r: p.result })).filter(x => x.c);
      for (let i = 0; i < champs.length; i++) for (let j = i + 1; j < champs.length; j++) {
        const key = [champs[i].c, champs[j].c].sort().join('|');
        const cell = (s[key] = s[key] || { wins: 0, n: 0 });
        cell.wins += champs[i].r ? 1 : 0; cell.n += 1;
      }
    }
  }
  return s;
}

function fitLogistic(samples, opts = {}) {
  const lr = opts.lr ?? 0.1, epochs = opts.epochs ?? 300, l2 = opts.l2 ?? 0.0001;
  const dim = (samples[0]?.x.length || 4) + 1;
  let w = new Array(dim).fill(0);
  for (let e = 0; e < epochs; e++) {
    const grad = new Array(dim).fill(0);
    for (const s of samples) {
      const z = w[0] + s.x.reduce((a, xi, i) => a + xi * w[i + 1], 0);
      const err = sigmoid(z) - s.y;
      grad[0] += err;
      for (let i = 0; i < s.x.length; i++) grad[i + 1] += err * s.x[i];
    }
    for (let i = 0; i < dim; i++) {
      const reg = i === 0 ? 0 : l2 * w[i];
      w[i] -= lr * (grad[i] / samples.length + reg);
    }
  }
  return w;
}

module.exports = { sigmoid, buildWrTable, buildMatchupMatrix, buildSynergyMatrix, fitLogistic,
  MASTERY, normPlayerName, buildMasteryTable };
