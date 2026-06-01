// lib/lol-draft-train.js — pure training functions (no I/O). Consumed by scripts/train-lol-draft-model.js.
const { normalizeChampion } = require('./lol-champions');

function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

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

module.exports = { sigmoid, buildWrTable, buildMatchupMatrix, buildSynergyMatrix, fitLogistic };
