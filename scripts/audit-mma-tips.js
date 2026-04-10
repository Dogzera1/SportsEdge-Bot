#!/usr/bin/env node
/**
 * Reexecuta o pré-filtro ML (esportsPreFilter) e gates numéricos (odds/EV)
 * sobre tips MMA já gravadas. Odds: /mma-matches ao vivo; fallback sintético.
 *
 * Uso: node scripts/audit-mma-tips.js
 * Env: DB_PATH, SERVER (default localhost), SERVER_PORT|PORT (default 3000)
 */
require('dotenv').config({ override: true });
const http = require('http');
const https = require('https');
const path = require('path');
const initDatabase = require('../lib/database');
const { esportsPreFilter } = require('../lib/ml');

const DB_PATH = path.resolve(process.cwd(), (process.env.DB_PATH || 'sportsedge.db').trim().replace(/^=+/, ''));
const SERVER = process.env.SERVER || '127.0.0.1';
const PORT = parseInt(process.env.SERVER_PORT || process.env.PORT || '3000', 10) || 3000;
const SYNTH_OR = parseFloat(process.env.MMA_AUDIT_SYNTH_OVERROUND || '1.06') || 1.06;

function safeParse(s, fb) {
  try {
    return JSON.parse(s);
  } catch (_) {
    return fb;
  }
}

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function mmaRecordToEnrich(record1, record2) {
  function parse(rec) {
    const parts = String(rec || '0-0').split('-').map(n => parseInt(n, 10) || 0);
    const wins = parts[0] || 0;
    const losses = parts[1] || 0;
    const draws = parts[2] || 0;
    const total = wins + losses + draws;
    return { wins, losses, winRate: total > 0 ? Math.round((wins / total) * 100) : 50 };
  }
  return {
    form1: parse(record1),
    form2: parse(record2),
    h2h: { t1Wins: 0, t2Wins: 0, totalMatches: 0 },
    oddsMovement: null
  };
}

function findEspnFight(espnFights, team1, team2) {
  const n1 = normName(team1);
  const n2 = normName(team2);
  return espnFights.find(f => {
    const e1 = normName(f.name1);
    const e2 = normName(f.name2);
    const fwd = (e1.includes(n1) || n1.includes(e1)) && (e2.includes(n2) || n2.includes(e2));
    const rev = (e1.includes(n2) || n2.includes(e1)) && (e2.includes(n1) || n1.includes(e2));
    return fwd || rev;
  }) || null;
}

function fetchEspnMmaFights() {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'site.api.espn.com',
        path: '/apis/site/v2/sports/mma/ufc/scoreboard',
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }
      },
      res => {
        let d = '';
        res.on('data', c => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      }
    );
    req.on('error', reject);
    req.setTimeout(12000, () => req.destroy(new Error('ESPN timeout')));
    req.end();
  }).then(r => {
    if (r.status !== 200) return [];
    const json = safeParse(r.body, {});
    const fights = [];
    for (const event of json.events || []) {
      for (const comp of event.competitions || []) {
        const comps = comp.competitors || [];
        if (comps.length < 2) continue;
        const f1 = comps.find(c => c.order === 1) || comps[0];
        const f2 = comps.find(c => c.order === 2) || comps[1];
        const rec = c => (c.records || []).find(x => x.name === 'overall')?.summary || '';
        const athleteName = a => a?.fullName || a?.displayName || a?.shortName || '';
        fights.push({
          name1: athleteName(f1.athlete) || f1.displayName || f1.name || '',
          name2: athleteName(f2.athlete) || f2.displayName || f2.name || '',
          record1: rec(f1),
          record2: rec(f2),
          weightClass: comp.type?.abbreviation || comp.type?.text || '',
          rounds: comp.format?.regulation?.periods || 3
        });
      }
    }
    return fights;
  });
}

function serverGetMmaMatches() {
  return new Promise((resolve, reject) => {
    http.get(
      { hostname: SERVER, port: PORT, path: '/mma-matches?sport=mma', timeout: 20000 },
      res => {
        let d = '';
        res.on('data', c => (d += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(e);
          }
        });
      }
    ).on('error', reject);
  });
}

function stripMmaId(raw) {
  let s = String(raw || '').trim();
  if (s.startsWith('mma_')) s = s.slice(4);
  return s;
}

function fuzzyFightMatch(tip, fights) {
  const mid = stripMmaId(tip.match_id);
  let f = fights.find(x => x && String(x.id) === mid);
  if (f) return f;
  const n1 = normName(tip.participant1);
  const n2 = normName(tip.participant2);
  f = fights.find(x => {
    const a1 = normName(x.team1);
    const a2 = normName(x.team2);
    return (a1 === n1 && a2 === n2) || (a1 === n2 && a2 === n1);
  });
  if (f) return f;
  return fights.find(x => {
    const a1 = normName(x.team1);
    const a2 = normName(x.team2);
    const fwd = (a1.includes(n1) || n1.includes(a1)) && (a2.includes(n2) || n2.includes(a2));
    const rev = (a1.includes(n2) || n2.includes(a1)) && (a2.includes(n1) || n2.includes(a2));
    return fwd || rev;
  }) || null;
}

function syntheticOddsFromTip(tip) {
  const op = parseFloat(tip.odds);
  if (!Number.isFinite(op) || op <= 1) return null;
  const invPick = 1 / op;
  const invOther = SYNTH_OR - invPick;
  if (invOther <= 0.01) return null;
  const other = 1 / invOther;
  const pickIsT1 = normName(tip.tip_participant) === normName(tip.participant1);
  return pickIsT1
    ? { t1: String(op.toFixed(2)), t2: String(other.toFixed(2)), bookmaker: 'synthetic', _synthetic: true }
    : { t1: String(other.toFixed(2)), t2: String(op.toFixed(2)), bookmaker: 'synthetic', _synthetic: true };
}

function isBoxingTip(tip) {
  return /\bbox(e|ing)?\b/i.test(String(tip.event_name || ''));
}

function main() {
  const { db, stmts } = initDatabase(DB_PATH);
  const rows = db.prepare(`SELECT * FROM tips WHERE sport = 'mma' ORDER BY datetime(sent_at) DESC`).all();

  return Promise.all([fetchEspnMmaFights().catch(() => []), serverGetMmaMatches().catch(() => [])]).then(
    ([espnFights, mmaMatches]) => {
      const fights = Array.isArray(mmaMatches) ? mmaMatches : [];
      const out = [];

      for (const tip of rows) {
        const boxing = isBoxingTip(tip);
        const fight = fuzzyFightMatch(tip, fights);
        let odds = fight?.odds?.t1 && fight?.odds?.t2
          ? { t1: String(fight.odds.t1), t2: String(fight.odds.t2), bookmaker: fight.odds.bookmaker || 'api' }
          : syntheticOddsFromTip(tip);

        const oddsSource = fight?.odds?.t1 ? 'mma-matches' : odds?._synthetic ? 'synthetic' : 'none';
        if (odds?._synthetic) delete odds._synthetic;

        const matchObj = fight
          ? { team1: fight.team1, team2: fight.team2, id: fight.id, league: fight.league, game: fight.game }
          : { team1: tip.participant1, team2: tip.participant2, id: tip.match_id, league: tip.event_name, game: boxing ? 'boxing' : 'mma' };

        let mmaEnrich = { form1: null, form2: null, h2h: null, oddsMovement: null };
        if (!boxing) {
          const espn = findEspnFight(espnFights, tip.participant1, tip.participant2);
          let rec1 = '';
          let rec2 = '';
          if (espn) {
            rec1 = normName(espn.name1).includes(normName(tip.participant1)) ? espn.record1 : espn.record2;
            rec2 = normName(espn.name1).includes(normName(tip.participant1)) ? espn.record2 : espn.record1;
          }
          const hasEspnRecord = !!(rec1 || rec2);
          if (hasEspnRecord) mmaEnrich = mmaRecordToEnrich(rec1, rec2);
        }

        let ml = { pass: false, score: 0, factorCount: 0 };
        if (odds && odds.t1 && odds.t2) {
          ml = esportsPreFilter(matchObj, odds, mmaEnrich, false, '', null, stmts);
        }

        const tipOdd = parseFloat(tip.odds);
        const tipEv = parseFloat(tip.ev);
        const oddsGate = Number.isFinite(tipOdd) && tipOdd >= 1.4 && tipOdd <= 5.0;
        const evGate = Number.isFinite(tipEv) && tipEv >= 5.0;

        const wouldPassPipeline = !!(
          odds &&
          ml.pass &&
          oddsGate &&
          evGate
        );

        out.push({
          id: tip.id,
          sent_at: tip.sent_at,
          lutadores: `${tip.participant1} vs ${tip.participant2}`,
          pick: tip.tip_participant,
          odds_gravada: tip.odds,
          ev_gravado: tip.ev,
          conf: tip.confidence,
          result: tip.result || 'open',
          odds_fonte: oddsSource,
          ml_pass: ml.pass,
          ml_edge_pp: ml.score != null ? Number(ml.score.toFixed(2)) : null,
          ml_factors: ml.factorCount,
          gate_odds_1p40_5: oddsGate,
          gate_ev_5: evGate,
          boxing,
          passaria_filtro_hoje: wouldPassPipeline,
          nota: !fight ? 'luta fora do feed /mma-matches (odds sintéticas)' : ''
        });
      }

      const pass = out.filter(x => x.passaria_filtro_hoje).length;
      const fail = out.length - pass;
      console.log(JSON.stringify({ total: out.length, passaria_hoje: pass, nao_passaria: fail, tips: out }, null, 2));
    }
  );
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
