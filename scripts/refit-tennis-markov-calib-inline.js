#!/usr/bin/env node
'use strict';

/**
 * refit-tennis-markov-calib-inline.js — versão simplificada do fit-tennis-markov-calibration
 * que evita travar (script principal hang em loops desconhecidos). Lógica idêntica:
 * PAV + Beta smoothing toward p_implied_close.
 *
 * Uso:
 *   node scripts/refit-tennis-markov-calib-inline.js --src=.tmp_tn_calib.json [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  const a = argv[i];
  return a.includes('=') ? a.split('=').slice(1).join('=') : argv[i + 1];
}

const SRC = arg('src', '.tmp_tn_calib.json');
const DRY = argv.includes('--dry-run');
const VIG = parseFloat(arg('vig', '0.025'));
const ALPHA = parseFloat(arg('alpha', '8'));
const MIN_BIN = parseInt(arg('min-bin', '6'), 10);
const OUT_PATH = path.join(__dirname, '..', 'lib', 'tennis-markov-calib.json');

const j = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const tips = (j.tips || []).filter(t => t.market && Number.isFinite(t.p_model));
const settled = tips.filter(t => t.result === 'win' || t.result === 'loss');
console.log(`[load] ${tips.length} total / ${settled.length} settled`);

function pav(bins) {
  const out = bins.map(b => ({ ...b }));
  let safetyIters = 0;
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
    safetyIters = pass + 1;
    if (!changed) break;
  }
  return out;
}

function fitMarket(marketName) {
  const lst = settled.filter(t => t.market === marketName);
  if (lst.length < 12) {
    console.log(`[${marketName}] insufficient (n=${lst.length})`);
    return null;
  }
  const edges = [0.30, 0.55, 0.65, 0.70, 0.75, 0.80, 0.85, 0.92, 1.001];
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
  if (!bins.length) return null;

  // Pool small bins (n<MIN_BIN) iterativamente. Loop com guard de iteração explícito.
  for (let iter = 0; iter < 200; iter++) {
    let smallIdx = -1;
    for (let i = 0; i < bins.length; i++) {
      if (bins[i].n < MIN_BIN && bins.length > 2) { smallIdx = i; break; }
    }
    if (smallIdx < 0) break;
    const left = smallIdx > 0 ? bins[smallIdx - 1] : null;
    const right = smallIdx < bins.length - 1 ? bins[smallIdx + 1] : null;
    const target = !left ? smallIdx + 1 : !right ? smallIdx - 1 : (left.n <= right.n ? smallIdx - 1 : smallIdx + 1);
    const a = bins[Math.min(smallIdx, target)], b = bins[Math.max(smallIdx, target)];
    const totalN = a.n + b.n;
    const totalW = a.wins + b.wins;
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

function applyCalib(p, bins) {
  if (!bins || !bins.length) return p;
  if (p <= bins[0].mid) return bins[0].pCalib;
  if (p >= bins[bins.length - 1].mid) return bins[bins.length - 1].pCalib;
  for (let i = 0; i < bins.length - 1; i++) {
    const a = bins[i], b = bins[i + 1];
    if (p >= a.mid && p <= b.mid) {
      const t = (p - a.mid) / (b.mid - a.mid);
      return a.pCalib + t * (b.pCalib - a.pCalib);
    }
  }
  return p;
}

function brierEce(samples) {
  const N = samples.length || 1;
  const brier = samples.reduce((a, s) => a + (s.p - s.y) ** 2, 0) / N;
  let ece = 0;
  for (let b = 0; b < 10; b++) {
    const lo = b / 10, hi = (b + 1) / 10;
    const sub = samples.filter(s => s.p >= lo && (s.p < hi || (b === 9 && s.p <= 1)));
    if (!sub.length) continue;
    const ap = sub.reduce((a, s) => a + s.p, 0) / sub.length;
    const ay = sub.reduce((a, s) => a + s.y, 0) / sub.length;
    ece += Math.abs(ap - ay) * (sub.length / N);
  }
  return { brier: +brier.toFixed(4), ece: +ece.toFixed(4) };
}

function backtest(calib) {
  const pre = [], post = [];
  for (const t of settled) {
    if (!Number.isFinite(t.odd) || t.odd <= 1) continue;
    const pCalib = applyCalib(t.p_model, calib[t.market]?.bins);
    const evRaw = (t.p_model * t.odd - 1) * 100;
    const evC = (pCalib * t.odd - 1) * 100;
    const profit = t.result === 'win' ? (t.odd - 1) : -1;
    if (evRaw >= 4 && t.p_model < 0.95 && t.odd >= 1.5) pre.push({ p: t.p_model, y: t.result === 'win' ? 1 : 0, profit });
    if (evC >= 4 && pCalib < 0.95 && t.odd >= 1.5) post.push({ p: pCalib, y: t.result === 'win' ? 1 : 0, profit });
  }
  function summ(label, lst) {
    if (!lst.length) return { label, n: 0 };
    const wins = lst.filter(s => s.y === 1).length;
    const profit = lst.reduce((a, s) => a + s.profit, 0);
    const m = brierEce(lst);
    return {
      label, n: lst.length, wins,
      hit: +(wins / lst.length * 100).toFixed(1),
      profit: +profit.toFixed(2),
      roi: +(profit / lst.length * 100).toFixed(1),
      brier: m.brier, ece: m.ece,
    };
  }
  return { pre: summ('PRE  (raw)', pre), post: summ('POST (calib)', post) };
}

const calib = {};
for (const m of ['handicapGames', 'totalGames']) {
  const c = fitMarket(m);
  if (c) calib[m] = c;
}
if (!Object.keys(calib).length) { console.error('No fits'); process.exit(1); }

console.log('\n=== CALIBRATION TABLE ===');
for (const [m, c] of Object.entries(calib)) {
  console.log(`\n${m} (n=${c.nTotal}, ${c.bins.length} bins):`);
  console.log('  ' + 'mid'.padStart(6) + '  ' + 'n'.padStart(4) + '  rawP   prior  CALIB  shift');
  for (const b of c.bins) {
    const shift = b.pCalib - b.mid;
    console.log('  ' + b.mid.toFixed(3).padStart(6) + '  ' + String(b.n).padStart(4) + '  ' +
      b.rawP.toFixed(3) + '  ' + b.priorP.toFixed(3) + '  ' + b.pCalib.toFixed(3) + '  ' +
      (shift >= 0 ? '+' : '') + shift.toFixed(3));
  }
}

console.log('\n=== BACKTEST ===');
const bt = backtest(calib);
console.log(`${bt.pre.label}: n=${bt.pre.n} hit=${bt.pre.hit}% ROI=${bt.pre.roi}% Brier=${bt.pre.brier} ECE=${bt.pre.ece}`);
console.log(`${bt.post.label}: n=${bt.post.n} hit=${bt.post.hit}% ROI=${bt.post.roi}% Brier=${bt.post.brier} ECE=${bt.post.ece}`);

if (DRY) { console.log('\n[dry-run] not saving'); process.exit(0); }

const out = {
  version: 1,
  fittedAt: new Date().toISOString(),
  method: 'pav_with_beta_smoothing',
  target: 'outcome (win/loss)',
  prior: { source: 'p_implied_close', vig: VIG, alpha: ALPHA },
  minBin: MIN_BIN,
  nSamples: settled.length,
  markets: calib,
};
fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
console.log(`\n[saved] ${OUT_PATH}`);
