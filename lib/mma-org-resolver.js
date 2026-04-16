/**
 * mma-org-resolver.js — Resolve a organização (UFC, PFL, Bellator, KSW, Boxing…)
 * e o nome do evento a partir da dupla de lutadores + data.
 *
 * Ordem das fontes:
 *   1) Sofascore (via proxy/direto) — tem cobertura maior, inclui regionais.
 *   2) ESPN scoreboards (UFC / PFL / Bellator / boxing) — fallback pros casos
 *      que o Sofascore não indexa ou que o proxy está indisponível.
 *
 * Retorna `{ org, eventName }` ou `null`.
 */
'use strict';

const https = require('https');
const { safeParse } = require('./utils');
const sofascoreMma = require('./sofascore-mma');

function _norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}
function _lastName(s) {
  const t = String(s || '').trim().split(/\s+/).filter(Boolean);
  return t.length ? t[t.length - 1] : '';
}
function _namesMatch(evName, query) {
  const a = _norm(evName);
  const b = _norm(query);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const la = _norm(_lastName(evName));
  const lb = _norm(_lastName(query));
  return la.length >= 4 && la === lb;
}

function _espnGet(path) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'site.api.espn.com',
      path,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.setTimeout(10000, () => { try { req.destroy(); } catch (_) {} resolve({ status: 0, body: '' }); });
    req.end();
  });
}

function _ymd(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/** Busca nos scoreboards ESPN (UFC/PFL/Bellator/boxing) em ±1 dia da data-alvo. */
async function _espnLookup(f1, f2, dateIso) {
  const base = new Date(dateIso || Date.now());
  if (isNaN(base.getTime())) return null;
  const prev = new Date(base); prev.setUTCDate(prev.getUTCDate() - 1);
  const next = new Date(base); next.setUTCDate(next.getUTCDate() + 1);
  const range = `${_ymd(prev)}-${_ymd(next)}`;

  const sources = [
    { org: 'UFC',      path: `/apis/site/v2/sports/mma/ufc/scoreboard?dates=${range}` },
    { org: 'PFL',      path: `/apis/site/v2/sports/mma/pfl/scoreboard?dates=${range}` },
    { org: 'Bellator', path: `/apis/site/v2/sports/mma/bellator/scoreboard?dates=${range}` },
    { org: 'Boxing',   path: `/apis/site/v2/sports/boxing/scoreboard?dates=${range}` },
  ];

  for (const src of sources) {
    const r = await _espnGet(src.path);
    if (r.status !== 200) continue;
    const json = safeParse(r.body, null);
    const events = Array.isArray(json?.events) ? json.events : [];
    for (const ev of events) {
      const eventName = ev?.name || ev?.shortName || null;
      const comps = ev?.competitions?.[0]?.competitors || [];
      const names = comps.map(c => c?.athlete?.displayName || c?.athlete?.shortName || c?.team?.displayName || '');
      if (names.length < 2) continue;
      const [a, b] = names;
      const matched = (_namesMatch(a, f1) && _namesMatch(b, f2))
                   || (_namesMatch(a, f2) && _namesMatch(b, f1));
      if (matched) return { org: src.org, eventName };
    }
  }
  return null;
}

/**
 * @param {string} f1 nome lutador 1
 * @param {string} f2 nome lutador 2
 * @param {string} dateIso ISO string (use sent_at da tip pro backfill)
 */
async function resolveOrg(f1, f2, dateIso) {
  if (!f1 || !f2) return null;
  try {
    const s = await sofascoreMma.lookupOrg(f1, f2, dateIso).catch(() => null);
    if (s?.org) return { org: s.org, eventName: s.eventName || null };
  } catch (_) {}
  try {
    const e = await _espnLookup(f1, f2, dateIso);
    if (e?.org) return e;
  } catch (_) {}
  return null;
}

module.exports = { resolveOrg };
