#!/usr/bin/env node
'use strict';

/**
 * fit-tennis-markov-calibration.js
 *
 * Fit calibração isotônica (PAV + Beta smoothing) sobre p_markov pré-jogo
 * usando market_tips_shadow tennis settled. Target = outcome (win/loss),
 * com prior toward p_implied_close (Pinnacle close devigado approx).
 *
 * Saída: lib/tennis-markov-calib.json
 *   {
 *     version, fittedAt, nSamples,
 *     markets: {
 *       handicapGames: { bins: [{lo, hi, mid, pCalib, n, raw}], coverage: [pMin, pMax] },
 *       totalGames:    { ... }
 *     }
 *   }
 *
 * Backtest comparativo (pré vs pós calib) impresso ao final.
 *
 * Uso:
 *   node scripts/fit-tennis-markov-calibration.js
 *   node scripts/fit-tennis-markov-calibration.js --src=tmp_tn_full.json
 *   node scripts/fit-tennis-markov-calibration.js --remote=https://...up.railway.app --days=90
 *   node scripts/fit-tennis-markov-calibration.js --dry-run    # nao salva
 *   node scripts/fit-tennis-markov-calibration.js --min-bin=8  # min size por bin
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  const a = argv[i];
  return a.includes('=') ? a.split('=').slice(1).join('=') : argv[i + 1];
}
const SRC = arg('src', null);
const REMOTE = arg('remote', null);
const DB_PATH_ARG = arg('db', null);
const DAYS = parseInt(arg('days', '90'), 10);
const DRY = argv.includes('--dry-run');
const MIN_BIN = parseInt(arg('min-bin', '6'), 10);
const ALPHA = parseFloat(arg('alpha', '8'));
const VIG = parseFloat(arg('vig', '0.025'));
const OUT_PATH = path.resolve(__dirname, '..', 'lib', 'tennis-markov-calib.json');

const MIN_EV = 4;

function fetchRemote(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false, headers: { 'user-agent': 'fit-markov-calib' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function loadTips() {
  if (REMOTE) {
    const url = `${REMOTE.replace(/\/$/, '')}/market-tips-recent?sport=tennis&days=${DAYS}&limit=1000&status=all&dedup=0&includeVoid=0`;
    console.log(`[fetch] ${url}`);
    const j = await fetchRemote(url);
    return j.tips || [];
  }
  // DB local (cron path em prod)
  const dbPath = DB_PATH_ARG || (!SRC && process.env.DB_PATH) || null;
  if (dbPath || (!SRC && fs.existsSync(path.resolve(__dirname, '..', 'sportsedge.db')))) {
    const Database = require('better-sqlite3');
    const fullDb = dbPath ? path.resolve(dbPath) : path.resolve(__dirname, '..', 'sportsedge.db');
    console.log(`[db] ${fullDb}`);
    const db = new Database(fullDb, { readonly: true });
    const rows = db.prepare(`
      SELECT id, sport, market, side, line, p_model, odd, close_odd, clv_pct, result,
             stake_units, profit_units, ev_pct, is_live, created_at
      FROM market_tips_shadow
      WHERE sport = 'tennis'
        AND created_at >= datetime('now', '-${DAYS} days')
    `).all();
    db.close();
    return rows;
  }
  const file = SRC || 'tmp_tn_full.json';
  console.log(`[load] ${file}`);
  const j = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  return j.tips || [];
}

// ── PAV (Pool Adjacent Violators) ───────────────────────────────
function pav(bins) {
  // bins ja ordenados por mid asc; campo .pSmoothed sera ajustado pra monotone increasing.
  const out = bins.map(b => ({ ...b }));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < out.length - 1; i++) {
      if (out[i].pSmoothed > out[i + 1].pSmoothed) {
        const wA = out[i].n, wB = out[i + 1].n;
        const pooled = (out[i].pSmoothed * wA + out[i + 1].pSmoothed * wB) / (wA + wB);
        out[i].pSmoothed = pooled;
        out[i + 1].pSmoothed = pooled;
        changed = true;
      }
    }
  }
  return out;
}

// ── ECE (expected calibration error) ─────────────────────────────
function ece(samples /* [{p, y}] */) {
  if (!samples.length) return null;
  const buckets = 10;
  let sumErr = 0;
  for (let b = 0; b < buckets; b++) {
    const lo = b / buckets, hi = (b + 1) / buckets;
    const sub = samples.filter(s => s.p >= lo && s.p < hi || (b === buckets - 1 && s.p === 1));
    if (!sub.length) continue;
    const avgP = sub.reduce((a, s) => a + s.p, 0) / sub.length;
    const avgY = sub.reduce((a, s) => a + s.y, 0) / sub.length;
    sumErr += Math.abs(avgP - avgY) * (sub.length / samples.length);
  }
  return sumErr;
}

function brier(samples) {
  if (!samples.length) return null;
  return samples.reduce((a, s) => a + (s.p - s.y) ** 2, 0) / samples.length;
}

function fitMarket(tips, marketName) {
  const lst = tips.filter(t => t.market === marketName && (t.result === 'win' || t.result === 'loss'));
  if (lst.length < 12) {
    console.log(`[${marketName}] insufficient sample (n=${lst.length}) — skipping`);
    return null;
  }

  // Bins: mais finos onde há volume (0.65-0.85), grossos nas pontas.
  const edges = [0.30, 0.55, 0.65, 0.70, 0.75, 0.80, 0.85, 0.92, 1.001];
  const bins = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i], hi = edges[i + 1];
    const sub = lst.filter(t => t.p_model >= lo && t.p_model < hi);
    if (!sub.length) continue;
    const wins = sub.filter(t => t.result === 'win').length;
    const closes = sub.filter(t => t.close_odd).map(t => t.close_odd);
    const priorP = closes.length ? Math.min(0.95, Math.max(0.05, (1 - VIG) / (closes.reduce((a, b) => a + b, 0) / closes.length))) : 0.5;
    const rawP = wins / sub.length;
    // Beta smoothing toward priorP (prior strength = ALPHA pseudo-counts)
    const smoothedP = (wins + ALPHA * priorP) / (sub.length + ALPHA);
    const mid = sub.reduce((a, t) => a + t.p_model, 0) / sub.length;
    bins.push({ lo, hi, mid, n: sub.length, wins, rawP, priorP, pSmoothed: smoothedP });
  }

  // Pool bins com n < MIN_BIN com vizinho mais próximo
  let merged = [...bins];
  let i = 0;
  while (i < merged.length) {
    if (merged[i].n < MIN_BIN && merged.length > 2) {
      // merge com vizinho de menor n
      const left = i > 0 ? merged[i - 1] : null;
      const right = i < merged.length - 1 ? merged[i + 1] : null;
      const target = !left ? i + 1 : !right ? i - 1 : (left.n <= right.n ? i - 1 : i + 1);
      const a = merged[Math.min(i, target)], b = merged[Math.max(i, target)];
      const totalN = a.n + b.n;
      const totalW = a.wins + b.wins;
      const wPriorAvg = (a.priorP * a.n + b.priorP * b.n) / totalN;
      const wMid = (a.mid * a.n + b.mid * b.n) / totalN;
      const smoothed = (totalW + ALPHA * wPriorAvg) / (totalN + ALPHA);
      const merge = {
        lo: a.lo, hi: b.hi, mid: wMid, n: totalN, wins: totalW,
        rawP: totalW / totalN, priorP: wPriorAvg, pSmoothed: smoothed,
      };
      merged.splice(Math.min(i, target), 2, merge);
      i = 0;
    } else i++;
  }

  // Aplica PAV pra forçar monotonicidade
  const calibrated = pav(merged);

  return {
    bins: calibrated.map(b => ({
      lo: +b.lo.toFixed(4),
      hi: +b.hi.toFixed(4),
      mid: +b.mid.toFixed(4),
      n: b.n,
      wins: b.wins,
      rawP: +b.rawP.toFixed(4),
      priorP: +b.priorP.toFixed(4),
      pCalib: +b.pSmoothed.toFixed(4),
    })),
    coverage: [merged[0].lo, merged[merged.length - 1].hi],
    nTotal: lst.length,
  };
}

// ── Apply calib ─────────────────────────────────────────────────
function applyCalib(pRaw, marketBins) {
  if (!marketBins || !marketBins.length) return pRaw;
  if (pRaw <= marketBins[0].mid) return marketBins[0].pCalib;
  if (pRaw >= marketBins[marketBins.length - 1].mid) return marketBins[marketBins.length - 1].pCalib;
  for (let i = 0; i < marketBins.length - 1; i++) {
    const a = marketBins[i], b = marketBins[i + 1];
    if (pRaw >= a.mid && pRaw <= b.mid) {
      const t = (pRaw - a.mid) / (b.mid - a.mid);
      return a.pCalib + t * (b.pCalib - a.pCalib);
    }
  }
  return pRaw;
}

// ── Backtest pre vs pos ─────────────────────────────────────────
function backtest(tips, calibByMarket) {
  const results = { pre: { tips: [], }, post: { tips: [] } };
  for (const t of tips) {
    if (t.result !== 'win' && t.result !== 'loss') continue;
    if (!Number.isFinite(t.p_model) || !Number.isFinite(t.odd)) continue;
    const pCalib = applyCalib(t.p_model, calibByMarket[t.market]?.bins || null);
    const evRaw = (t.p_model * t.odd - 1) * 100;
    const evCalib = (pCalib * t.odd - 1) * 100;
    const passRaw = evRaw >= MIN_EV && t.p_model < 0.95 && t.odd >= 1.5;
    const passCalib = evCalib >= MIN_EV && pCalib < 0.95 && t.odd >= 1.5;
    const profit = t.result === 'win' ? (t.odd - 1) : -1;
    if (passRaw) results.pre.tips.push({ ...t, ev: evRaw, p: t.p_model, profit });
    if (passCalib) results.post.tips.push({ ...t, ev: evCalib, p: pCalib, pRaw: t.p_model, profit });
  }
  function summarize(label, list) {
    if (!list.length) return { label, n: 0 };
    const wins = list.filter(t => t.result === 'win').length;
    const profit = list.reduce((a, t) => a + t.profit, 0);
    const stake = list.length;
    const clvN = list.filter(t => t.clv_pct != null).length;
    const clvSum = list.filter(t => t.clv_pct != null).reduce((a, t) => a + t.clv_pct, 0);
    const samples = list.map(t => ({ p: t.p, y: t.result === 'win' ? 1 : 0 }));
    return {
      label, n: list.length, wins,
      hit: +(wins / list.length * 100).toFixed(1),
      profit: +profit.toFixed(2),
      roi: +(profit / stake * 100).toFixed(1),
      avgP: +(list.reduce((a, t) => a + t.p, 0) / list.length).toFixed(3),
      avgEV: +(list.reduce((a, t) => a + t.ev, 0) / list.length).toFixed(1),
      avgClv: clvN ? +(clvSum / clvN).toFixed(2) : null,
      brier: +brier(samples).toFixed(4),
      ece: +ece(samples).toFixed(4),
    };
  }
  return {
    pre: summarize('PRE  (raw)', results.pre.tips),
    post: summarize('POST (calib)', results.post.tips),
  };
}

(async () => {
  const tips = await loadTips();
  const settled = tips.filter(t => t.result === 'win' || t.result === 'loss').length;
  console.log(`[loaded] ${tips.length} tips total (${settled} settled)`);

  // Skip refit se sample não cresceu o suficiente desde último fit
  const minNewSamples = parseInt(arg('min-new-samples', '0'), 10);
  if (minNewSamples > 0 && fs.existsSync(OUT_PATH)) {
    try {
      const existing = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
      const delta = settled - (existing.nSamples || 0);
      if (delta < minNewSamples) {
        console.log(`[skip] sample grew only ${delta} (< ${minNewSamples}); keeping existing fit`);
        process.exit(0);
      }
      console.log(`[refit] sample +${delta} since last fit`);
    } catch {}
  }

  const calibByMarket = {};
  for (const m of ['handicapGames', 'totalGames']) {
    const c = fitMarket(tips, m);
    if (c) calibByMarket[m] = c;
  }

  if (!Object.keys(calibByMarket).length) {
    console.error('[abort] no market with sufficient samples');
    process.exit(1);
  }

  console.log('\n=== CALIBRATION TABLE ===');
  for (const [m, c] of Object.entries(calibByMarket)) {
    console.log(`\n${m} (n_total=${c.nTotal}, ${c.bins.length} bins):`);
    console.log('  ' + 'mid'.padStart(6) + '  ' + 'n'.padStart(4) + '  ' + 'rawP'.padStart(6) + '  ' + 'prior'.padStart(6) + '  ' + 'CALIB'.padStart(6) + '  ' + 'shift'.padStart(7));
    for (const b of c.bins) {
      const shift = b.pCalib - b.mid;
      const shiftStr = (shift >= 0 ? '+' : '') + shift.toFixed(3);
      console.log('  ' + b.mid.toFixed(3).padStart(6) + '  ' + String(b.n).padStart(4) + '  ' + b.rawP.toFixed(3).padStart(6) + '  ' + b.priorP.toFixed(3).padStart(6) + '  ' + b.pCalib.toFixed(3).padStart(6) + '  ' + shiftStr.padStart(7));
    }
  }

  console.log('\n=== BACKTEST (settled tips, gate evCurrent>=4 & p<0.95 & odd>=1.5) ===');
  const bt = backtest(tips, calibByMarket);
  for (const r of [bt.pre, bt.post]) {
    if (!r.n) { console.log(`${r.label}: 0 tips`); continue; }
    const clvStr = r.avgClv == null ? '—' : (r.avgClv >= 0 ? '+' : '') + r.avgClv + '%';
    console.log(`${r.label.padEnd(13)} n=${String(r.n).padStart(3)}  hit=${r.hit}%  ROI=${r.roi >= 0 ? '+' : ''}${r.roi}%  P&L=${r.profit >= 0 ? '+' : ''}${r.profit}u  avgP=${r.avgP}  avgEV=${r.avgEV}%  avgCLV=${clvStr}  Brier=${r.brier}  ECE=${r.ece}`);
  }

  if (DRY) {
    console.log('\n[dry-run] not saving');
    return;
  }

  // Validação: ECE post nao deve piorar > 30% vs pre
  const pre = bt.pre, post = bt.post;
  if (post.n === 0) {
    console.error('[ABORT] post-calib produces 0 tips — calibration too aggressive');
    process.exit(1);
  }
  if (post.ece > pre.ece * 1.30) {
    console.error(`[ABORT] post ECE (${post.ece}) >30% pior que pre (${pre.ece})`);
    process.exit(1);
  }

  const payload = {
    version: 1,
    fittedAt: new Date().toISOString(),
    method: 'pav_with_beta_smoothing',
    target: 'outcome (win/loss)',
    prior: { source: 'p_implied_close', vig: VIG, alpha: ALPHA },
    minBin: MIN_BIN,
    nSamples: tips.filter(t => t.result === 'win' || t.result === 'loss').length,
    markets: calibByMarket,
    backtest: bt,
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2));
  console.log(`\n[saved] ${OUT_PATH}`);
})().catch(e => { console.error(e); process.exit(1); });
