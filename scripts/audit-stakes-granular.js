#!/usr/bin/env node
'use strict';

/**
 * audit-stakes-granular.js
 *
 * Audita stakes em tips reais (não-shadow, não-archived) agrupando por:
 *   - sport
 *   - sport × confidence
 *   - sport × market_type
 *   - sport × EV bucket
 *   - sport × tier (LoL/Dota/CS/Val via league_tier)
 *
 * Compara avg stake observada vs esperada (Kelly base × sport_mult × tier_mult).
 * Flagga divergências:
 *   - Floor 0.5u violado
 *   - Cap MAX_STAKE_UNITS excedido
 *   - Conf BAIXA com stake > 1.5u (deveria ser 1/10 Kelly)
 *   - Conf ALTA com stake < 1.5u (deveria ser 1/4 Kelly)
 *
 * Uso:
 *   BASE=https://sportsedge-bot-production.up.railway.app \
 *   ADMIN_KEY=xxx \
 *   node scripts/audit-stakes-granular.js
 *
 *   ou local:
 *   DB_PATH=./sportsedge.db node scripts/audit-stakes-granular.js --local
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const argv = process.argv.slice(2);
const isLocal = argv.includes('--local');
const asJson = argv.includes('--json');
const BASE = process.env.BASE || '';
const KEY = process.env.ADMIN_KEY || '';
const DAYS = parseInt(process.env.DAYS || '30', 10);

// ── HTTP helper ─────────────────────────────────────────────────────────────
function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const opts = { headers: { 'x-admin-key': KEY, 'accept': 'application/json' } };
    lib.get(url, opts, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`Invalid JSON: ${body.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

// ── Stake parsing ────────────────────────────────────────────────────────────
function parseStakeU(s) {
  if (s == null) return 0;
  const c = String(s).replace(/u/gi, '').replace(',', '.').trim();
  const n = parseFloat(c);
  return Number.isFinite(n) ? n : 0;
}

function evBucket(ev) {
  const n = parseFloat(String(ev || '').replace(/[%+]/g, ''));
  if (!Number.isFinite(n)) return 'unknown';
  if (n < 3) return '<3%';
  if (n < 5) return '3-5%';
  if (n < 8) return '5-8%';
  if (n < 12) return '8-12%';
  if (n < 18) return '12-18%';
  if (n < 25) return '18-25%';
  return '>25%';
}

function oddBucket(odd) {
  const n = parseFloat(odd);
  if (!Number.isFinite(n)) return 'unknown';
  if (n < 1.40) return '<1.40';
  if (n < 1.70) return '1.40-1.70';
  if (n < 2.20) return '1.70-2.20';
  if (n < 3.00) return '2.20-3.00';
  if (n < 5.00) return '3.00-5.00';
  return '>5.00';
}

// ── Expected stakes (do código) ──────────────────────────────────────────────
const KELLY_BASE = { ALTA: 1 / 4, 'MÉDIA': 1 / 6, MEDIA: 1 / 6, BAIXA: 1 / 10 };
const SPORT_MULT = {
  lol: 1.00, esports: 1.00, cs: 1.00, cs2: 1.00,
  dota2: 0.20, // memo Kelly cut 2026-04-23
  valorant: 0.85,
  tennis: 1.00,
  football: 1.00,
  mma: 0.85,
  darts: 0.85,
  snooker: 0.85,
  basket: 1.00,
  tabletennis: 0.70,
};
// Espera-se uma stake típica em "1u" base + multipliers — pra checar avg, use range.
function expectedStakeRange(sport, confidence) {
  const sp = String(sport || '').toLowerCase();
  const cf = String(confidence || '').toUpperCase().replace('Á', 'A');
  const k = KELLY_BASE[cf] || KELLY_BASE.BAIXA;
  const m = SPORT_MULT[sp] || 1.0;
  const baseStake = k * m * 5; // approximação: Kelly fraction × sport_mult × scale
  return {
    expected: +(baseStake * 100).toFixed(0) / 100,
    minExpected: +(baseStake * 0.5).toFixed(2),
    maxExpected: +(baseStake * 2.0).toFixed(2),
  };
}

// ── Data fetch ──────────────────────────────────────────────────────────────
async function fetchTips() {
  if (isLocal) {
    const Database = require('better-sqlite3');
    const dbPath = process.env.DB_PATH || path.resolve(__dirname, '..', 'sportsedge.db');
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare(`
      SELECT id, sport, market_type, tip_participant, odds, ev, stake, confidence,
             result, profit_reais, stake_reais, clv_odds, sent_at, event_name,
             is_shadow, archived
      FROM tips
      WHERE COALESCE(is_shadow,0) = 0
        AND (archived IS NULL OR archived = 0)
        AND sent_at >= datetime('now', '-' || ? || ' days')
      ORDER BY sent_at DESC
    `).all(DAYS);
    db.close();
    return rows;
  }
  if (!BASE || !KEY) {
    throw new Error('BASE and ADMIN_KEY env vars required (or use --local)');
  }
  // Em prod: agrega tips real (settled + pending) per sport via /admin/sport-detail
  // + tips_history settled. Endpoint admin/tips-recent não existe; combina source.
  const sports = ['lol','dota2','cs','valorant','tennis','football','mma','basket'];
  const all = [];
  for (const sp of sports) {
    try {
      const r = await httpGetJson(`${BASE}/tips-history?sport=${sp}&limit=500&filter=all`);
      const rows = Array.isArray(r) ? r : (r.tips || r.rows || []);
      all.push(...rows);
    } catch (_) {}
  }
  // Deduplica por id
  const seen = new Set();
  return all.filter(t => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}

// ── Aggregator ──────────────────────────────────────────────────────────────
function aggregate(tips, ...keyFns) {
  const groups = new Map();
  for (const t of tips) {
    const key = keyFns.map(fn => fn(t) ?? '?').join(' | ');
    if (!groups.has(key)) {
      groups.set(key, { key, n: 0, w: 0, l: 0, v: 0, pend: 0, stakes: [], evs: [], odds: [], staked: 0, profit: 0, clvSum: 0, clvN: 0 });
    }
    const g = groups.get(key);
    g.n++;
    if (t.result === 'win') g.w++;
    else if (t.result === 'loss') g.l++;
    else if (t.result === 'void') g.v++;
    else g.pend++;
    g.stakes.push(parseStakeU(t.stake));
    const evN = parseFloat(String(t.ev || '').replace(/[%+]/g, ''));
    if (Number.isFinite(evN)) g.evs.push(evN);
    const oN = parseFloat(t.odds);
    if (Number.isFinite(oN)) g.odds.push(oN);
    g.staked += Number(t.stake_reais) || 0;
    g.profit += Number(t.profit_reais) || 0;
    if (t.clv_odds && oN > 1) {
      const clvPct = (oN / Number(t.clv_odds) - 1) * 100;
      if (Number.isFinite(clvPct)) { g.clvSum += clvPct; g.clvN++; }
    }
  }
  const out = [];
  for (const g of groups.values()) {
    const stakes = g.stakes.sort((a, b) => a - b);
    const settled = g.w + g.l;
    out.push({
      key: g.key,
      n: g.n,
      settled,
      pend: g.pend,
      voids: g.v,
      avg_u: stakes.length ? +(stakes.reduce((a, b) => a + b, 0) / stakes.length).toFixed(2) : 0,
      med_u: stakes.length ? stakes[Math.floor(stakes.length / 2)] : 0,
      min_u: stakes.length ? stakes[0] : 0,
      max_u: stakes.length ? stakes[stakes.length - 1] : 0,
      avg_ev: g.evs.length ? +(g.evs.reduce((a, b) => a + b, 0) / g.evs.length).toFixed(1) : 0,
      avg_odd: g.odds.length ? +(g.odds.reduce((a, b) => a + b, 0) / g.odds.length).toFixed(2) : 0,
      hit_pct: settled ? +((g.w / settled) * 100).toFixed(1) : 0,
      roi_pct: g.staked > 0 ? +((g.profit / g.staked) * 100).toFixed(1) : null,
      avg_clv_pct: g.clvN ? +(g.clvSum / g.clvN).toFixed(2) : null,
      total_staked: +g.staked.toFixed(2),
      total_profit: +g.profit.toFixed(2),
    });
  }
  return out.sort((a, b) => b.n - a.n);
}

function fmtTable(rows, headers) {
  if (!rows.length) return '(vazio)';
  const cols = headers || Object.keys(rows[0]);
  const widths = {};
  for (const c of cols) {
    widths[c] = Math.max(c.length, ...rows.map(r => String(r[c] ?? '').length));
  }
  const sep = cols.map(c => '─'.repeat(widths[c])).join('─┼─');
  const hdr = cols.map(c => c.padEnd(widths[c])).join(' │ ');
  const lines = rows.map(r => cols.map(c => String(r[c] ?? '').padEnd(widths[c])).join(' │ '));
  return `${hdr}\n${sep}\n${lines.join('\n')}`;
}

// ── Anomalias ───────────────────────────────────────────────────────────────
function flagAnomalies(tips) {
  const anomalies = [];
  for (const t of tips) {
    const stakeU = parseStakeU(t.stake);
    const sport = String(t.sport || '').toLowerCase();
    const conf = String(t.confidence || '').toUpperCase().replace('Á', 'A');
    // 1. Floor violado
    if (stakeU > 0 && stakeU < 0.5) {
      anomalies.push({ id: t.id, type: 'floor_violated', stake: stakeU, sport, conf });
    }
    // 2. Cap excedido (assume MAX_STAKE_UNITS=5 default)
    const cap = parseFloat(process.env.MAX_STAKE_UNITS || '5');
    if (stakeU > cap) {
      anomalies.push({ id: t.id, type: 'cap_exceeded', stake: stakeU, cap, sport, conf });
    }
    // 3. Conf inconsistency
    if (conf === 'BAIXA' && stakeU > 1.5) {
      anomalies.push({ id: t.id, type: 'baixa_high_stake', stake: stakeU, sport, conf });
    }
    if (conf === 'ALTA' && stakeU < 1.5 && stakeU > 0) {
      anomalies.push({ id: t.id, type: 'alta_low_stake', stake: stakeU, sport, conf });
    }
    // 4. Dota2 cut respect
    if (sport === 'dota2' && stakeU > 1.5) {
      anomalies.push({ id: t.id, type: 'dota_cut_violated', stake: stakeU, expected_max: '<=1.5u', conf });
    }
  }
  return anomalies;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const tips = await fetchTips();
  if (!tips.length) {
    console.log('Nenhuma tip real encontrada na janela.');
    if (isLocal) console.log('(DB local: tente sem --local apontando pra prod)');
    process.exit(0);
  }

  const out = {
    window_days: DAYS,
    n_tips: tips.length,
    by_sport: aggregate(tips, t => t.sport),
    by_sport_conf: aggregate(tips, t => t.sport, t => (t.confidence || '?').toUpperCase().replace('Á', 'A')),
    by_sport_market: aggregate(tips, t => t.sport, t => (t.market_type || 'ML').toUpperCase()),
    by_sport_ev_bucket: aggregate(tips, t => t.sport, t => evBucket(t.ev)),
    by_sport_odd_bucket: aggregate(tips, t => t.sport, t => oddBucket(t.odds)),
    anomalies: flagAnomalies(tips),
  };

  if (asJson) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log(`\n=== AUDIT STAKES (${out.n_tips} tips reais nos últimos ${out.window_days}d) ===\n`);
  const cols = ['key', 'n', 'settled', 'pend', 'avg_u', 'med_u', 'min_u', 'max_u', 'avg_ev', 'avg_odd', 'hit_pct', 'roi_pct', 'avg_clv_pct', 'total_staked', 'total_profit'];

  console.log('▼ POR SPORT');
  console.log(fmtTable(out.by_sport, cols));

  console.log('\n▼ POR SPORT × CONFIDENCE');
  console.log(fmtTable(out.by_sport_conf, cols));

  console.log('\n▼ POR SPORT × MARKET');
  console.log(fmtTable(out.by_sport_market, cols));

  console.log('\n▼ POR SPORT × EV BUCKET');
  console.log(fmtTable(out.by_sport_ev_bucket, cols));

  console.log('\n▼ POR SPORT × ODD BUCKET');
  console.log(fmtTable(out.by_sport_odd_bucket, cols));

  console.log(`\n▼ ANOMALIAS (${out.anomalies.length})`);
  if (out.anomalies.length) {
    const anomCols = ['id', 'type', 'stake', 'sport', 'conf'];
    console.log(fmtTable(out.anomalies.slice(0, 30), anomCols));
    if (out.anomalies.length > 30) console.log(`... +${out.anomalies.length - 30} mais`);
  } else {
    console.log('(nenhuma)');
  }

  console.log('\n▼ RECOMENDAÇÕES');
  // Diagnóstico baseado nos agg
  const lines = [];
  for (const row of out.by_sport_conf) {
    const [sport, conf] = row.key.split(' | ');
    const exp = expectedStakeRange(sport, conf);
    if (row.avg_u < exp.minExpected || row.avg_u > exp.maxExpected) {
      lines.push(`⚠ ${row.key}: avg=${row.avg_u}u (esperado ${exp.minExpected}-${exp.maxExpected}u; n=${row.n})`);
    }
  }
  if (lines.length) lines.forEach(l => console.log(l));
  else console.log('✓ Stakes alinhadas com expected per-(sport,conf).');
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
