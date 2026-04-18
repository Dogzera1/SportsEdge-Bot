#!/usr/bin/env node
'use strict';

// scripts/rerun-railway-pending.js
//
// Puxa tips pendentes da Railway, roda modelos treinados localmente, e POSTa
// updates de model_p1/p2 + current_ev + current_confidence via
// /admin/apply-trained-predictions.
//
// Uso:
//   node scripts/rerun-railway-pending.js                    # dry-run
//   node scripts/rerun-railway-pending.js --apply            # grava na prod
//   node scripts/rerun-railway-pending.js --sports tennis    # só tennis
//
// Env: ADMIN_KEY precisa bater com o server prod (x-admin-key header).

require('dotenv').config({ override: true });
const path = require('path');
const https = require('https');
const { URL } = require('url');
const initDatabase = require('../lib/database');
const { predictTrainedEsports, hasTrainedModel } = require('../lib/esports-model-trained');
const { buildTrainedContext } = require('../lib/esports-runtime-features');
const { predictTrainedTennis, hasTrainedModel: hasTrainedTennis } = require('../lib/tennis-model-trained');
const { getTennisElo, extractSurface } = require('../lib/tennis-ml');

const DB_PATH = (process.env.DB_PATH || path.join(__dirname, '../sportsedge.db')).trim().replace(/^=+/, '');
const RAILWAY_BASE = (process.env.RAILWAY_BASE || 'https://sportsedge-bot-production.up.railway.app').replace(/\/+$/, '');
const ADMIN_KEY = (process.env.ADMIN_KEY || '').trim();

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
function argVal(n, d) {
  const i = argv.findIndex(a => a === `--${n}` || a.startsWith(`--${n}=`));
  if (i < 0) return d;
  const a = argv[i];
  return a.includes('=') ? a.split('=').slice(1).join('=') : argv[i + 1];
}
const SPORTS = argVal('sports', 'esports,tennis,dota,cs,valorant').split(',').map(s => s.trim());

const { db } = initDatabase(DB_PATH);
const SPORT_TO_GAME = { esports: 'lol', lol: 'lol', dota: 'dota2', dota2: 'dota2', cs: 'cs2', cs2: 'cs2', valorant: 'valorant' };

function getJson(url) {
  return new Promise((res, rej) => {
    https.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}

function postJson(url, payload) {
  return new Promise((res, rej) => {
    const data = JSON.stringify(payload);
    const u = new URL(url);
    const req = https.request({
      host: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'x-admin-key': ADMIN_KEY,
      },
    }, r => {
      let b = '';
      r.on('data', c => b += c);
      r.on('end', () => { try { res({ status: r.statusCode, body: JSON.parse(b) }); } catch (e) { res({ status: r.statusCode, body: b }); } });
    });
    req.on('error', rej);
    req.write(data);
    req.end();
  });
}

function predictNew(sport, t) {
  const odds = parseFloat(t.odds) || 0;
  if (!odds) return null;
  if (sport === 'tennis') {
    if (!hasTrainedTennis()) return null;
    const league = t.event_name || '';
    const surface = extractSurface(league);
    const elo = getTennisElo(db, t.participant1, t.participant2, surface, 0.5, 0.5);
    if (!elo || !elo.found1 || !elo.found2) return null;
    return predictTrainedTennis({
      eloOverall1: elo.eloOverall1 || elo.elo1, eloOverall2: elo.eloOverall2 || elo.elo2,
      eloSurface1: elo.eloSurface1 || elo.elo1, eloSurface2: elo.eloSurface2 || elo.elo2,
      gamesSurface1: elo.surfMatches1, gamesSurface2: elo.surfMatches2,
      surface,
      bestOf: /grand slam|wimbledon|us open|roland|australian/i.test(league) ? 5 : 3,
    });
  }
  const game = SPORT_TO_GAME[sport];
  if (!game || !hasTrainedModel(game)) return null;
  const match = { team1: t.participant1, team2: t.participant2, league: t.event_name || '', format: 'Bo3' };
  const ctx = buildTrainedContext(db, game, match);
  if (!ctx) return null;
  return predictTrainedEsports(game, ctx);
}

async function main() {
  if (APPLY && !ADMIN_KEY) { console.error('ADMIN_KEY não configurado no .env local'); process.exit(1); }
  console.log(`[rerun-railway] base=${RAILWAY_BASE} | apply=${APPLY} | sports=${SPORTS.join(',')}`);

  const updates = [];
  const summary = {};

  for (const sport of SPORTS) {
    const url = `${RAILWAY_BASE}/tips-history?limit=200&sport=${encodeURIComponent(sport)}`;
    const tips = await getJson(url).catch(() => []);
    if (!Array.isArray(tips)) continue;
    const pending = tips.filter(t => t.result === null || t.result === 'pending');
    console.log(`\n── ${sport.toUpperCase()} — pending=${pending.length} ──`);
    if (!pending.length) continue;

    const sv = { evaluated: 0, skipped: 0, mantem: 0, enfraq: 0, neg: 0 };
    for (const t of pending) {
      const pred = predictNew(sport, t);
      if (!pred) { sv.skipped++; continue; }
      const odds = parseFloat(t.odds);
      const pickSide = t.tip_participant === t.participant1 ? 'p1' : 'p2';
      const oldPpick = pickSide === 'p1' ? (t.model_p1 || 0.5) : (t.model_p2 || 0.5);
      const newPpick = pickSide === 'p1' ? pred.p1 : pred.p2;
      const newEV = +((newPpick * odds - 1) * 100).toFixed(2);
      const oldEV = +((oldPpick * odds - 1) * 100).toFixed(2);
      const verdict = newEV >= 5 ? 'mantém' : newEV >= 0 ? 'enfraq' : 'neg';
      sv.evaluated++;
      if (verdict === 'mantém') sv.mantem++;
      else if (verdict === 'enfraq') sv.enfraq++;
      else sv.neg++;

      console.log(`  #${t.id} ${t.tip_participant.slice(0,22).padEnd(24)} odd=${odds} oldP=${(oldPpick*100).toFixed(1)}% → newP=${(newPpick*100).toFixed(1)}% | oldEV=${oldEV}% → newEV=${newEV}% ${verdict}`);

      updates.push({
        id: t.id,
        model_p1: pred.p1, model_p2: pred.p2,
        current_ev: newEV,
        current_confidence: pred.confidence,
      });
    }
    summary[sport] = sv;
  }

  console.log(`\n══ Resumo ══`);
  for (const [s, v] of Object.entries(summary)) {
    console.log(`  ${s.padEnd(10)} eval=${v.evaluated} skip=${v.skipped} mantém=${v.mantem} enfraqueceu=${v.enfraq} negativo=${v.neg}`);
  }
  console.log(`\n[rerun-railway] total updates: ${updates.length}`);

  if (!APPLY) {
    console.log(`[rerun-railway] DRY-RUN (use --apply pra gravar na prod)`);
    return;
  }
  if (!updates.length) return;

  console.log(`[rerun-railway] POST /admin/apply-trained-predictions...`);
  const r = await postJson(`${RAILWAY_BASE}/admin/apply-trained-predictions`, { updates });
  console.log(`[rerun-railway] status=${r.status} response=${JSON.stringify(r.body)}`);
}

main().catch(e => { console.error('fatal:', e.message); process.exit(1); });
