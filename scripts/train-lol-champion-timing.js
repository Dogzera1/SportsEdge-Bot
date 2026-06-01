'use strict';
/**
 * Builds lib/lol-champion-timing.json from oracleselixir_players.
 * Display-only artifact for the Match Lab game-profile (phase/scaling). No npm dep.
 *
 *  byChampRole["champ|role"] = { golddiff15, xpdiff15, csdiff15, n }   (MEASURED early)
 *  scaling["champ"]          = { index, wrShort, wrLong, nShort, nLong } (ESTIMATED late)
 *  expectedLen["champ"]      = avg gamelength (seconds)
 *
 * Usage: node scripts/train-lol-champion-timing.js
 */
const fs = require('fs');
const path = require('path');
const { normalizeChampion, normalizeRole } = require('../lib/lol-champions');

const SHRINK_K = 10;     // empirical-Bayes strength
const SHRINK_PRIOR = 0.5;

function shrinkRate(wins, n, k = SHRINK_K, prior = SHRINK_PRIOR) {
  return (wins + k * prior) / (n + k);
}

function percentile(sortedAsc, q) {
  if (!sortedAsc.length) return 0;
  const i = Math.min(sortedAsc.length - 1, Math.floor(q * sortedAsc.length));
  return sortedAsc[i];
}

function aggregateTiming(rows) {
  const gls = rows.map(r => r.gamelength).filter(x => x > 0).sort((a, b) => a - b);
  const p33 = percentile(gls, 0.33);
  const p66 = percentile(gls, 0.66);

  const crAcc = {}, scAcc = {}, elAcc = {};
  for (const r of rows) {
    const champ = normalizeChampion(r.champion);
    if (!champ) continue;
    const role = normalizeRole(r.position);

    const crk = champ + '|' + role;
    if (!crAcc[crk]) crAcc[crk] = { g: 0, x: 0, c: 0, n: 0 };
    if (r.golddiffat15 != null) {
      crAcc[crk].g += r.golddiffat15;
      crAcc[crk].x += (r.xpdiffat15 || 0);
      crAcc[crk].c += (r.csdiffat15 || 0);
      crAcc[crk].n++;
    }

    if (!scAcc[champ]) scAcc[champ] = { ws: 0, ns: 0, wl: 0, nl: 0 };
    if (r.gamelength > 0) {
      if (r.gamelength < p33) { scAcc[champ].ns++; if (r.result === 1) scAcc[champ].ws++; }
      else if (r.gamelength > p66) { scAcc[champ].nl++; if (r.result === 1) scAcc[champ].wl++; }
    }

    if (!elAcc[champ]) elAcc[champ] = { s: 0, n: 0 };
    if (r.gamelength > 0) { elAcc[champ].s += r.gamelength; elAcc[champ].n++; }
  }

  const byChampRole = {};
  for (const k in crAcc) {
    const a = crAcc[k];
    if (a.n > 0) byChampRole[k] = {
      golddiff15: +(a.g / a.n).toFixed(1),
      xpdiff15: +(a.x / a.n).toFixed(1),
      csdiff15: +(a.c / a.n).toFixed(1),
      n: a.n,
    };
  }
  const scaling = {};
  for (const c in scAcc) {
    const a = scAcc[c];
    const wrS = shrinkRate(a.ws, a.ns);
    const wrL = shrinkRate(a.wl, a.nl);
    scaling[c] = { index: +(wrL - wrS).toFixed(3), wrShort: +wrS.toFixed(3), wrLong: +wrL.toFixed(3), nShort: a.ns, nLong: a.nl };
  }
  const expectedLen = {};
  for (const c in elAcc) { const a = elAcc[c]; expectedLen[c] = a.n ? Math.round(a.s / a.n) : 0; }

  return { meta: { rows: rows.length, p33, p66, minCellN: 20, generatedAt: new Date().toISOString() }, byChampRole, scaling, expectedLen };
}

if (require.main === module) {
  const Database = require('better-sqlite3');
  const db = new Database(path.join(__dirname, '..', 'sportsedge.db'), { readonly: true });
  const rows = db.prepare(
    `SELECT champion, position, gamelength, result, golddiffat15, xpdiffat15, csdiffat15
       FROM oracleselixir_players
      WHERE champion IS NOT NULL AND length(champion) > 0`
  ).all();
  db.close();
  const art = aggregateTiming(rows);
  const dest = path.join(__dirname, '..', 'lib', 'lol-champion-timing.json');
  fs.writeFileSync(dest, JSON.stringify(art, null, 0));
  console.log(`wrote ${dest}: ${Object.keys(art.byChampRole).length} champ|role cells, ${Object.keys(art.scaling).length} champs`);
}

module.exports = { shrinkRate, percentile, aggregateTiming };
