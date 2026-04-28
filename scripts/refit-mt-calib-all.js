#!/usr/bin/env node
'use strict';

/**
 * refit-mt-calib-all.js — refit calib MT genérico para múltiplos sports.
 * Replica lógica de refit-tennis-markov-calib-inline mas itera sobre sports
 * que tenham n>=MIN_N settled em market_tips_shadow.
 *
 * Uso:
 *   node scripts/refit-mt-calib-all.js --src=tips.json [--dry-run]
 *   node scripts/refit-mt-calib-all.js --remote=https://prod.up.railway.app
 *   node scripts/refit-mt-calib-all.js --sports=tennis,football
 *
 * Output: lib/<sport>-mt-calib.json (tennis mantém tennis-markov-calib.json
 * por compat com bot.js).
 *
 * Sports cobertos: tennis (handicapGames, totalGames), football (totals, btts),
 * lol/cs2/dota2/valorant (handicap, total) — só fita quando n>=MIN_N.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  const a = argv[i];
  return a.includes('=') ? a.split('=').slice(1).join('=') : argv[i + 1];
}

const SRC = arg('src', null);
const REMOTE = arg('remote', null);
const SPORTS = String(arg('sports', 'tennis,football,lol,cs2,dota2,valorant')).split(',').map(s => s.trim()).filter(Boolean);
const DRY = argv.includes('--dry-run');
const VIG = parseFloat(arg('vig', '0.025'));
const ALPHA = parseFloat(arg('alpha', '8'));
const MIN_BIN = parseInt(arg('min-bin', '6'), 10);
const MIN_N = parseInt(arg('min-n', '20'), 10);

// Markets default por sport
const SPORT_MARKETS = {
  tennis:   ['handicapGames', 'totalGames'],
  football: ['totals', 'btts'],
  lol:      ['handicap', 'total'],
  cs2:      ['handicap', 'total'],
  dota2:    ['handicap', 'total'],
  valorant: ['handicap', 'total'],
};

// Output paths (tennis usa nome legacy)
function outPath(sport) {
  if (sport === 'tennis') return path.join(__dirname, '..', 'lib', 'tennis-markov-calib.json');
  return path.join(__dirname, '..', 'lib', `${sport}-mt-calib.json`);
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    lib.get(url, { rejectUnauthorized: false, headers: { 'user-agent': 'mt-calib-refit' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function loadTipsForSport(sport) {
  if (SRC && !REMOTE) {
    const j = JSON.parse(fs.readFileSync(SRC, 'utf8'));
    return (j.tips || []).filter(t => t.sport === sport);
  }
  if (REMOTE) {
    const url = `${REMOTE.replace(/\/$/, '')}/market-tips-recent?sport=${encodeURIComponent(sport)}&days=90&limit=2000&dedup=0&status=all&includeVoid=0`;
    const j = await fetchUrl(url);
    return j.tips || [];
  }
  throw new Error('--src or --remote required');
}

function pav(bins) {
  const out = bins.map(b => ({ ...b }));
  for (let pass = 0; pass < 1000; pass++) {
    let changed = false;
    for (let i = 0; i < out.length - 1; i++) {
      if (out[i].pSmoothed > out[i + 1].pSmoothed) {
        const wA = out[i].n, wB = out[i + 1].n;
        const pooled = (out[i].pSmoothed * wA + out[i + 1].pSmoothed * wB) / (wA + wB);
        out[i].pSmoothed = pooled;
        out[i + 1].pSmoothed = pooled;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return out;
}

function fitMarket(tips, marketName) {
  const lst = tips.filter(t => t.market === marketName && (t.result === 'win' || t.result === 'loss')
    && Number.isFinite(t.p_model) && t.p_model > 0 && t.p_model < 1);
  if (lst.length < MIN_N) return { skipped: true, reason: `n=${lst.length} < ${MIN_N}` };

  // Edges adaptativas: range observado dos p_model dividido em ~7-8 quantis
  const ps = lst.map(t => t.p_model).sort((a, b) => a - b);
  const pMin = Math.max(0.05, ps[0] - 0.02);
  const pMax = Math.min(0.99, ps[ps.length - 1] + 0.02);
  const numBins = Math.min(8, Math.max(4, Math.floor(lst.length / 12)));
  const edges = [pMin];
  for (let i = 1; i < numBins; i++) {
    const idx = Math.floor((i / numBins) * (ps.length - 1));
    edges.push(ps[idx]);
  }
  edges.push(pMax + 0.001);

  let bins = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i], hi = edges[i + 1];
    const sub = lst.filter(t => t.p_model >= lo && t.p_model < hi);
    if (!sub.length) continue;
    const wins = sub.filter(t => t.result === 'win').length;
    const closes = sub.filter(t => t.close_odd).map(t => t.close_odd);
    const priorP = closes.length
      ? Math.min(0.95, Math.max(0.05, (1 - VIG) / (closes.reduce((a, b) => a + b, 0) / closes.length)))
      : 0.5;
    const rawP = wins / sub.length;
    const smoothedP = (wins + ALPHA * priorP) / (sub.length + ALPHA);
    const mid = sub.reduce((a, t) => a + t.p_model, 0) / sub.length;
    bins.push({ lo, hi, mid, n: sub.length, wins, rawP, priorP, pSmoothed: smoothedP });
  }
  if (!bins.length) return { skipped: true, reason: 'no_bins' };

  // Pool small bins (n<MIN_BIN)
  for (let iter = 0; iter < 200; iter++) {
    let smallIdx = -1;
    for (let i = 0; i < bins.length; i++) if (bins[i].n < MIN_BIN && bins.length > 2) { smallIdx = i; break; }
    if (smallIdx < 0) break;
    const left = smallIdx > 0 ? bins[smallIdx - 1] : null;
    const right = smallIdx < bins.length - 1 ? bins[smallIdx + 1] : null;
    const target = !left ? smallIdx + 1 : !right ? smallIdx - 1 : (left.n <= right.n ? smallIdx - 1 : smallIdx + 1);
    const a = bins[Math.min(smallIdx, target)], b = bins[Math.max(smallIdx, target)];
    const totalN = a.n + b.n, totalW = a.wins + b.wins;
    const wPriorAvg = (a.priorP * a.n + b.priorP * b.n) / totalN;
    const wMid = (a.mid * a.n + b.mid * b.n) / totalN;
    const smoothed = (totalW + ALPHA * wPriorAvg) / (totalN + ALPHA);
    bins.splice(Math.min(smallIdx, target), 2, {
      lo: a.lo, hi: b.hi, mid: wMid, n: totalN, wins: totalW,
      rawP: totalW / totalN, priorP: wPriorAvg, pSmoothed: smoothed,
    });
  }

  const calibrated = pav(bins);
  return {
    bins: calibrated.map(b => ({
      lo: +b.lo.toFixed(4), hi: +b.hi.toFixed(4), mid: +b.mid.toFixed(4),
      n: b.n, wins: b.wins,
      rawP: +b.rawP.toFixed(4), priorP: +b.priorP.toFixed(4),
      pCalib: +b.pSmoothed.toFixed(4),
    })),
    coverage: [bins[0].lo, bins[bins.length - 1].hi],
    nTotal: lst.length,
  };
}

(async () => {
  const summary = [];
  for (const sport of SPORTS) {
    const markets = SPORT_MARKETS[sport];
    if (!markets) { console.log(`[${sport}] sport não reconhecido`); continue; }
    let tips;
    try { tips = await loadTipsForSport(sport); }
    catch (e) { console.log(`[${sport}] fetch error: ${e.message}`); continue; }
    if (!tips.length) { console.log(`[${sport}] sem tips`); continue; }

    const calibByMarket = {};
    for (const m of markets) {
      const c = fitMarket(tips, m);
      if (c.skipped) {
        console.log(`[${sport}/${m}] skipped (${c.reason})`);
        continue;
      }
      calibByMarket[m] = c;
      console.log(`[${sport}/${m}] fitted n=${c.nTotal} ${c.bins.length} bins coverage=[${c.coverage[0].toFixed(3)}, ${c.coverage[1].toFixed(3)}]`);
    }

    if (!Object.keys(calibByMarket).length) {
      summary.push({ sport, status: 'no_fits' });
      continue;
    }

    const out = {
      version: 1,
      sport,
      fittedAt: new Date().toISOString(),
      method: 'pav_with_beta_smoothing',
      target: 'outcome (win/loss)',
      prior: { source: 'p_implied_close', vig: VIG, alpha: ALPHA },
      minBin: MIN_BIN,
      nSamples: tips.filter(t => t.result === 'win' || t.result === 'loss').length,
      markets: calibByMarket,
    };
    if (DRY) {
      summary.push({ sport, status: 'dry-run', markets: Object.keys(calibByMarket) });
    } else {
      fs.writeFileSync(outPath(sport), JSON.stringify(out, null, 2));
      summary.push({ sport, status: 'saved', path: outPath(sport), markets: Object.keys(calibByMarket) });
    }
  }
  console.log('\n=== SUMMARY ===');
  for (const s of summary) console.log(JSON.stringify(s));
})();
