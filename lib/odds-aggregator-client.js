'use strict';

/**
 * odds-aggregator-client.js
 *
 * Cliente do agregador BR de odds (Supabase Postgres + REST API). Lê a view
 * `vw_jogos_publicos` que já agrega snapshots_odds mais recente por (jogo, casa).
 *
 * Schema relevante:
 *   jogo: { id, slug, mandante: { nome, nome_curto, slug }, visitante: { ... },
 *           inicio, status, odds: [ { casa, mercados: { '1x2': {...} }, atualizado_em } ] }
 *
 * Format mapping (Supabase → bot _allOdds):
 *   mercados['1x2']['1'] → h (home)
 *   mercados['1x2']['x'] → d (draw)
 *   mercados['1x2']['2'] → a (away)
 *
 * Env:
 *   SUPABASE_URL              — https://<project>.supabase.co
 *   SUPABASE_ANON_KEY         — anon JWT (read-only via RLS)
 *
 * Uso:
 *   const cli = require('./lib/odds-aggregator-client');
 *   await cli.enrichMatches(footballMatches);  // mutates _allOdds in-place
 */

const https = require('https');
const url = require('url');

// log helper - usa lib/utils.log se disponível, fallback console.warn
let _log;
try { _log = require('./utils').log; } catch (_) { _log = (lvl, tag, msg) => console.warn(`[${lvl}] [${tag}] ${msg}`); }
function log(lvl, tag, msg) { try { _log(lvl, tag, msg); } catch (_) { console.warn(`[${lvl}] [${tag}] ${msg}`); } }

const _cache = { ts: 0, data: [], lastErrorAt: 0, lastErrorMsg: null };
const CACHE_TTL_MS = 5 * 60 * 1000; // 5min — scrapers rodam ~10-30min

function _supabaseUrl() {
  return (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
}

function _supabaseKey() {
  return (process.env.SUPABASE_ANON_KEY || '').trim();
}

function _normTeam(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function _httpGetJson(targetUrl, headers, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const opts = url.parse(targetUrl);
    opts.headers = headers;
    opts.timeout = timeoutMs;
    const req = https.get(opts, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * Busca jogos com odds agregadas. Filtra por janela de tempo (default 14d).
 * Cache 5min em memória.
 */
async function fetchUpcomingJogos({ daysAhead = 14, force = false } = {}) {
  const SU = _supabaseUrl(), SK = _supabaseKey();
  if (!SU || !SK) return null;
  const now = Date.now();
  if (!force && _cache.data.length && (now - _cache.ts) < CACHE_TTL_MS) return _cache.data;
  // Throttle erros — evita spam quando Supabase down
  if (!force && _cache.lastErrorAt && (now - _cache.lastErrorAt) < 60_000) return null;
  const startIso = new Date(now - 6 * 60 * 60 * 1000).toISOString(); // -6h pra cobrir live
  const endIso = new Date(now + daysAhead * 86_400_000).toISOString();
  const target = `${SU}/rest/v1/vw_jogos_publicos?select=*&inicio=gte.${encodeURIComponent(startIso)}&inicio=lt.${encodeURIComponent(endIso)}`;
  const headers = {
    apikey: SK,
    Authorization: `Bearer ${SK}`,
    'User-Agent': 'SportsEdgeBot/1.0',
  };
  try {
    const arr = await _httpGetJson(target, headers, 12000);
    if (Array.isArray(arr)) {
      _cache.data = arr;
      _cache.ts = now;
      _cache.lastErrorAt = 0;
      _cache.lastErrorMsg = null;
      return arr;
    }
    return null;
  } catch (e) {
    _cache.lastErrorAt = now;
    _cache.lastErrorMsg = e.message;
    return null;
  }
}

/**
 * Match jogo Supabase com (team1, team2) do bot. Tenta nome cheio + nome_curto + slug.
 * @returns { jogo, swap } | null
 */
function findJogoByTeams(jogos, team1, team2) {
  if (!Array.isArray(jogos)) return null;
  const t1n = _normTeam(team1), t2n = _normTeam(team2);
  if (!t1n || !t2n) return null;
  for (const j of jogos) {
    const m = j.mandante || {}, v = j.visitante || {};
    const mNames = [m.nome, m.nome_curto, m.slug].filter(Boolean).map(_normTeam);
    const vNames = [v.nome, v.nome_curto, v.slug].filter(Boolean).map(_normTeam);
    const matches = (a, b) => a.some(x => x === b || x.includes(b) || b.includes(x));
    const fwd = matches(mNames, t1n) && matches(vNames, t2n);
    const rev = matches(mNames, t2n) && matches(vNames, t1n);
    if (fwd) return { jogo: j, swap: false };
    if (rev) return { jogo: j, swap: true };
  }
  return null;
}

/**
 * Parse genérico do mercado `1x2` (home/draw/away). Aceita variações:
 *   { '1': x, 'x': y, '2': z } ou { home: x, draw: y, away: z }
 */
function _parse1x2(mercados) {
  const m = mercados?.['1x2'] || mercados?.['1X2'] || mercados?.h2h || mercados?.moneyline_3way;
  if (!m) return null;
  const h = parseFloat(m['1'] ?? m.home ?? m.h ?? m.mandante);
  const d = parseFloat(m['x'] ?? m.X ?? m.draw ?? m.empate ?? m.d);
  const a = parseFloat(m['2'] ?? m.away ?? m.a ?? m.visitante);
  if (!Number.isFinite(h) || !Number.isFinite(a)) return null;
  return { h, d: Number.isFinite(d) ? d : null, a };
}

/**
 * Parse mercado moneyline 2-way (esports). Aceita:
 *   { '1': x, '2': y } ou { team1: x, team2: y } ou { home/away }
 */
function _parseMl(mercados) {
  const m = mercados?.ml || mercados?.moneyline || mercados?.['1x2'] || mercados?.h2h;
  if (!m) return null;
  const t1 = parseFloat(m['1'] ?? m.team1 ?? m.home ?? m.t1 ?? m.mandante);
  const t2 = parseFloat(m['2'] ?? m.team2 ?? m.away ?? m.t2 ?? m.visitante);
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return null;
  return { t1, t2 };
}

/**
 * Parse totais (Over/Under). Procura linha 2.5 (default football).
 * Aceita formatos:
 *   { totals: { over_2_5: x, under_2_5: y } }
 *   { totals: { '2.5': { over: x, under: y } } }
 *   { totals: { linha: 2.5, over: x, under: y } }
 *   { totals: [{ linha: 2.5, over: x, under: y }] }
 *   { over_2_5: x, under_2_5: y } (top-level)
 *   { 'over-under': { over: x, under: y } }     ← scraper user (default linha=2.5)
 *   { 'over_under': { over: x, under: y } }
 */
function _parseOu(mercados, targetLine = 2.5) {
  // Atalho pro formato do scraper user: { 'over-under': { over, under } } sem linha = assume 2.5
  const directOu = mercados?.['over-under'] ?? mercados?.['over_under'] ?? mercados?.['ou'];
  if (directOu && typeof directOu === 'object' && !Array.isArray(directOu)) {
    const ov = parseFloat(directOu.over ?? directOu.acima ?? directOu.o);
    const un = parseFloat(directOu.under ?? directOu.abaixo ?? directOu.u);
    const ln = parseFloat(directOu.linha ?? directOu.line ?? directOu.point ?? targetLine);
    if (Number.isFinite(ov) && Number.isFinite(un) && Math.abs(ln - targetLine) < 0.5) {
      return { over: ov, under: un, point: ln };
    }
  }
  const t = mercados?.totals ?? mercados?.over_under ?? mercados;
  if (!t) return null;
  // Caso 1: array de lines
  if (Array.isArray(t)) {
    for (const item of t) {
      const ln = parseFloat(item?.linha ?? item?.line ?? item?.point);
      if (Math.abs(ln - targetLine) > 0.01) continue;
      const ov = parseFloat(item.over ?? item.acima);
      const un = parseFloat(item.under ?? item.abaixo);
      if (Number.isFinite(ov) && Number.isFinite(un)) return { over: ov, under: un, point: ln };
    }
    return null;
  }
  if (typeof t !== 'object') return null;
  // Caso 2: chaves com line embutido (over_2_5, under_2_5)
  const keyOv = `over_${String(targetLine).replace('.', '_')}`;
  const keyUn = `under_${String(targetLine).replace('.', '_')}`;
  const ov2 = parseFloat(t[keyOv]);
  const un2 = parseFloat(t[keyUn]);
  if (Number.isFinite(ov2) && Number.isFinite(un2)) return { over: ov2, under: un2, point: targetLine };
  // Caso 3: chave string da line
  const lnKey = String(targetLine);
  const inner = t[lnKey] || t[lnKey.replace('.', '_')];
  if (inner && typeof inner === 'object') {
    const ov = parseFloat(inner.over ?? inner.acima);
    const un = parseFloat(inner.under ?? inner.abaixo);
    if (Number.isFinite(ov) && Number.isFinite(un)) return { over: ov, under: un, point: targetLine };
  }
  // Caso 4: linha + over + under planos
  const lnPlain = parseFloat(t.linha ?? t.line ?? t.point);
  if (Math.abs(lnPlain - targetLine) < 0.01) {
    const ov = parseFloat(t.over ?? t.acima);
    const un = parseFloat(t.under ?? t.abaixo);
    if (Number.isFinite(ov) && Number.isFinite(un)) return { over: ov, under: un, point: targetLine };
  }
  return null;
}

/**
 * Converte jogo Supabase pro formato `_allOdds` do bot (1X2 home/draw/away).
 * Aplica swap se mandante=team2 (rev). Football-style ({h,d,a}).
 */
function jogoToAllOdds(jogo, swap = false) {
  const out = [];
  const odds = jogo?.odds || [];
  for (const o of odds) {
    const p = _parse1x2(o.mercados);
    if (!p) continue;
    if (swap) {
      out.push({
        h: String(p.a), d: p.d != null ? String(p.d) : null, a: String(p.h),
        bookmaker: o.casa, _supabase: true, _capturedAt: o.atualizado_em,
      });
    } else {
      out.push({
        h: String(p.h), d: p.d != null ? String(p.d) : null, a: String(p.a),
        bookmaker: o.casa, _supabase: true, _capturedAt: o.atualizado_em,
      });
    }
  }
  return out;
}

/**
 * Converte jogo Supabase pro formato totals (Over/Under 2.5 default).
 * Items: { over, under, point, bookmaker } — destinado a `match.odds.ou25._allOdds`.
 */
function jogoToOu25(jogo, targetLine = 2.5) {
  const out = [];
  const odds = jogo?.odds || [];
  for (const o of odds) {
    const ou = _parseOu(o.mercados, targetLine);
    if (!ou) continue;
    out.push({
      over: String(ou.over), under: String(ou.under), point: ou.point,
      bookmaker: o.casa, _supabase: true, _capturedAt: o.atualizado_em,
    });
  }
  return out;
}

/**
 * Parse BTTS (both teams to score). Aceita:
 *   { btts: { sim: x, nao: y } }       ← scraper user (português)
 *   { btts: { yes: x, no: y } }
 *   { both_teams_score: { sim, nao } }
 */
function _parseBtts(mercados) {
  const m = mercados?.btts ?? mercados?.both_teams_score ?? mercados?.bts;
  if (!m || typeof m !== 'object') return null;
  const yes = parseFloat(m.sim ?? m.yes ?? m.s);
  const no = parseFloat(m.nao ?? m.no ?? m['não']);
  if (!Number.isFinite(yes) || !Number.isFinite(no)) return null;
  return { yes, no };
}

/**
 * Converte jogo Supabase pro formato BTTS.
 * Items: { yes, no, bookmaker } — destinado a `match.odds.btts._allOdds`.
 */
function jogoToBtts(jogo) {
  const out = [];
  const odds = jogo?.odds || [];
  for (const o of odds) {
    const p = _parseBtts(o.mercados);
    if (!p) continue;
    out.push({
      yes: String(p.yes), no: String(p.no),
      bookmaker: o.casa, _supabase: true, _capturedAt: o.atualizado_em,
    });
  }
  return out;
}

/**
 * Converte jogo Supabase pro formato esports moneyline 2-way.
 * Items: { t1, t2, bookmaker } — destinado a `_allOdds` esports (LoL/CS/Val/Dota).
 */
function jogoToEsportsMl(jogo, swap = false) {
  const out = [];
  const odds = jogo?.odds || [];
  for (const o of odds) {
    const p = _parseMl(o.mercados);
    if (!p) continue;
    if (swap) {
      out.push({ t1: String(p.t2), t2: String(p.t1), bookmaker: o.casa, _supabase: true, _capturedAt: o.atualizado_em });
    } else {
      out.push({ t1: String(p.t1), t2: String(p.t2), bookmaker: o.casa, _supabase: true, _capturedAt: o.atualizado_em });
    }
  }
  return out;
}

function _appendUnique(targetArr, items) {
  const seen = new Set(targetArr.map(o => String(o.bookmaker || '').toLowerCase()));
  let added = 0;
  for (const it of items) {
    const key = String(it.bookmaker || '').toLowerCase();
    if (seen.has(key)) continue;
    targetArr.push(it);
    seen.add(key);
    added++;
  }
  return added;
}

function _normTeamSlug(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}

/**
 * Converte jogo Supabase em "match" sintético no formato bot.
 * Usado quando bot não tem o jogo (ex: Brasileirão Serie A não em FOOTBALL_LEAGUES).
 */
function jogoToMatch(jogo) {
  const team1 = jogo.mandante?.nome || jogo.mandante?.slug;
  const team2 = jogo.visitante?.nome || jogo.visitante?.slug;
  if (!team1 || !team2) return null;
  const allOdds = jogoToAllOdds(jogo, false);
  if (!allOdds.length) return null;
  // Pega primeiro book como representativo (cron usa _allOdds, h/d/a só pra display)
  const first = allOdds[0];
  const odds = {
    h: first.h, d: first.d, a: first.a, bookmaker: first.bookmaker,
    _allOdds: allOdds,
  };
  // Totals 2.5 se disponível
  const ou = jogoToOu25(jogo, 2.5);
  if (ou.length) {
    odds.ou25 = { over: ou[0].over, under: ou[0].under, point: ou[0].point, bookmaker: ou[0].bookmaker, _allOdds: ou };
  }
  // BTTS
  const btts = jogoToBtts(jogo);
  if (btts.length) {
    odds.btts = { yes: btts[0].yes, no: btts[0].no, bookmaker: btts[0].bookmaker, _allOdds: btts };
  }
  return {
    id: `agg_${jogo.slug || jogo.id}`,
    game: 'football',
    sport_key: jogo.campeonato_slug || 'soccer_brazil',
    status: jogo.status === 'ao-vivo' ? 'live' : 'upcoming',
    team1, team2,
    league: jogo.campeonato || jogo.campeonato_slug || 'Brasileirão',
    time: jogo.inicio,
    odds,
    _aggregator: true,
  };
}

/**
 * Enrich football matches com odds BR (1X2 + ou25). Mutates `match.odds._allOdds`
 * e `match.odds.ou25._allOdds` quando totals disponíveis.
 * - Append-only: TheOddsAPI prioridade quando overlap
 * - Dedup por bookmaker (case-insensitive)
 * - Skipa matches não-football
 *
 * opts.addMissing=true → injeta jogos do agregador que não estão em matches (ex:
 *   Brasileirão Serie A quando bot não tem na lista FOOTBALL_LEAGUES)
 */
async function enrichMatches(matches, opts = {}) {
  if (!Array.isArray(matches)) return { enriched: 0, totalJogos: 0 };
  // matches.length === 0 ainda OK quando opts.addMissing pra injetar Supabase
  const allJogos = await fetchUpcomingJogos({ daysAhead: 14 });
  if (!allJogos?.length) return { enriched: 0, totalJogos: 0, error: _cache.lastErrorMsg };
  // 2026-04-28: filtra jogos com `atualizado_em` recente. Antes scraper morto
  // por horas vazava odds defasadas pro _allOdds e contaminava EV calc.
  // Default 30min — opt-out via FB_AGG_MAX_AGE_MIN=0.
  const maxAgeMin = parseInt(process.env.FB_AGG_MAX_AGE_MIN || '30', 10);
  const cutoffMs = maxAgeMin > 0 ? (Date.now() - maxAgeMin * 60_000) : 0;
  const jogos = cutoffMs > 0
    ? allJogos.filter(j => {
        const ts = j.atualizado_em || j.updated_at || j.atualizadoEm;
        if (!ts) return true;
        const tMs = Date.parse(ts);
        return !Number.isFinite(tMs) || tMs >= cutoffMs;
      })
    : allJogos;
  const staleSkipped = allJogos.length - jogos.length;
  if (staleSkipped > 0 && staleSkipped >= allJogos.length / 2) {
    log('WARN', 'AGGREGATOR', `${staleSkipped}/${allJogos.length} jogos descartados por staleness (>${maxAgeMin}min) — scraper pode estar atrasado`);
  }
  let enriched1x2 = 0, enrichedOu = 0, injected = 0;
  const matchedJogoIds = new Set();
  for (const m of matches) {
    if (m.game && m.game !== 'football') continue;
    const found = findJogoByTeams(jogos, m.team1, m.team2);
    if (!found) continue;
    matchedJogoIds.add(found.jogo.id || found.jogo.slug);
    if (!m.odds) m.odds = {};
    // 1X2
    const br1x2 = jogoToAllOdds(found.jogo, found.swap);
    if (br1x2.length) {
      if (!Array.isArray(m.odds._allOdds)) m.odds._allOdds = [];
      const added = _appendUnique(m.odds._allOdds, br1x2);
      if (added) enriched1x2++;
    }
    // Totals 2.5
    const brOu = jogoToOu25(found.jogo, 2.5);
    if (brOu.length) {
      if (!m.odds.ou25) {
        const first = brOu[0];
        m.odds.ou25 = { over: first.over, under: first.under, point: first.point, bookmaker: first.bookmaker, _allOdds: [] };
      }
      if (!Array.isArray(m.odds.ou25._allOdds)) m.odds.ou25._allOdds = [];
      const added = _appendUnique(m.odds.ou25._allOdds, brOu);
      if (added) enrichedOu++;
    }
    // BTTS
    const brBtts = jogoToBtts(found.jogo);
    if (brBtts.length) {
      if (!m.odds.btts) {
        const first = brBtts[0];
        m.odds.btts = { yes: first.yes, no: first.no, bookmaker: first.bookmaker, _allOdds: [] };
      }
      if (!Array.isArray(m.odds.btts._allOdds)) m.odds.btts._allOdds = [];
      _appendUnique(m.odds.btts._allOdds, brBtts);
    }
  }
  // Inject jogos BR que não estão em matches (Brasileirão fora de FOOTBALL_LEAGUES).
  // BUG FIX 2026-04-26: filtra por esporte=futebol — view publica tennis também
  // (esporte=tenis) e jogoToMatch hardcoda game='football', vazando jogos de tennis
  // pra /football-matches (ex: Zhang-Qian Wei vs Ikumi Yamazaki aparecendo como
  // football). Tennis tem fluxo próprio via enrichTennisMatches, não inject.
  if (opts.addMissing !== false) {
    for (const j of jogos) {
      const id = j.id || j.slug;
      if (matchedJogoIds.has(id)) continue;
      const esp = String(j.esporte || '').toLowerCase();
      if (esp && esp !== 'futebol' && esp !== 'football') continue;
      // Skipa jogos cancelados/encerrados
      if (j.status === 'encerrado' || j.status === 'cancelado') continue;
      // Skipa jogos muito no futuro (>14d) ou passados (>2h atrás)
      const ts = new Date(j.inicio).getTime();
      if (!Number.isFinite(ts)) continue;
      const ageMs = Date.now() - ts;
      if (ageMs > 2 * 3600 * 1000) continue; // já passou >2h
      const synth = jogoToMatch(j);
      if (synth) {
        matches.push(synth);
        injected++;
      }
    }
  }
  return { enriched: enriched1x2, enrichedOu, injected, totalJogos: jogos.length };
}

/**
 * Enrich tennis matches com odds BR (moneyline 2-way). Format players via team1/team2.
 * Mutates `match.odds._allOdds` items {t1, t2, bookmaker}.
 *
 * Aggregator publica Tennis com `esporte='tenis'`. Match keys são `team1` (player1)
 * e `team2` (player2). Sem draw em tennis = usa parser ML 2-way.
 */
async function enrichTennisMatches(matches) {
  if (!Array.isArray(matches) || !matches.length) return { enriched: 0, totalJogos: 0 };
  const jogos = await fetchUpcomingJogos({ daysAhead: 14 });
  if (!jogos?.length) return { enriched: 0, totalJogos: 0, error: _cache.lastErrorMsg };
  const tnJogos = jogos.filter(j => /tenis|tennis/i.test(String(j.esporte || '')));
  if (!tnJogos.length) return { enriched: 0, totalJogos: 0, totalTennis: 0 };
  let enriched = 0;
  for (const m of matches) {
    const found = findJogoByTeams(tnJogos, m.team1, m.team2);
    if (!found) continue;
    const brMl = jogoToEsportsMl(found.jogo, found.swap);
    if (!brMl.length) continue;
    if (!m.odds) m.odds = {};
    if (!Array.isArray(m.odds._allOdds)) m.odds._allOdds = [];
    const added = _appendUnique(m.odds._allOdds, brMl);
    if (added) enriched++;
  }
  return { enriched, totalJogos: jogos.length, totalTennis: tnJogos.length };
}

/**
 * Enrich esports matches (LoL/CS/Val/Dota) com odds BR (moneyline 2-way).
 * Mutates `match.odds._allOdds` items {t1, t2, bookmaker}.
 * - Aceita matches com `m.game` em ['lol', 'cs', 'cs2', 'valorant', 'dota2', 'dota']
 * - Append-only, dedup por bookmaker
 *
 * Hook futuro: chamar de /lol-matches, /cs-matches, etc após scrapers
 * publicarem mercado `ml` em campeonatos esports.
 */
async function enrichEsportsMatches(matches, opts = {}) {
  if (!Array.isArray(matches) || !matches.length) return { enriched: 0, totalJogos: 0 };
  const jogos = await fetchUpcomingJogos({ daysAhead: 14 });
  if (!jogos?.length) return { enriched: 0, totalJogos: 0, error: _cache.lastErrorMsg };
  // Filtra só jogos esports na view (esporte='esports' ou similar)
  const esJogos = jogos.filter(j => /esport|lol|league of legends|counter|cs2|valorant|dota/i.test(String(j.esporte || j.campeonato || '')));
  if (!esJogos.length) return { enriched: 0, totalJogos: 0, totalEsports: 0 };
  let enriched = 0;
  for (const m of matches) {
    const found = findJogoByTeams(esJogos, m.team1, m.team2);
    if (!found) continue;
    const brMl = jogoToEsportsMl(found.jogo, found.swap);
    if (!brMl.length) continue;
    if (!m.odds) m.odds = {};
    if (!Array.isArray(m.odds._allOdds)) m.odds._allOdds = [];
    const added = _appendUnique(m.odds._allOdds, brMl);
    if (added) enriched++;
  }
  return { enriched, totalJogos: jogos.length, totalEsports: esJogos.length };
}

function getStatus() {
  return {
    cached: _cache.data.length,
    cacheAgeMs: _cache.ts ? (Date.now() - _cache.ts) : null,
    lastErrorMsg: _cache.lastErrorMsg,
    lastErrorAt: _cache.lastErrorAt || null,
    configured: !!(_supabaseUrl() && _supabaseKey()),
  };
}

/**
 * Health snapshot do scraper BR. Chama Supabase REST direto na tabela
 * execucoes_scraper. Retorna por casa: última coleta válida, taxa sucesso-vazio
 * nas últimas 6h, classifica saudável/degradada/morta.
 *
 * Critérios:
 *   morta:     last_success > 24h
 *   degradada: last_success entre 6-24h OU sucesso-vazio rate > 80% nas últimas 6h
 *   saudável:  last_success < 6h E sucesso-vazio rate < 50%
 */
async function fetchScraperHealth() {
  const SU = _supabaseUrl(), SK = _supabaseKey();
  if (!SU || !SK) return null;
  // Janela 24h pra calcular tudo de uma vez
  const sinceIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const target = `${SU}/rest/v1/execucoes_scraper?select=casa_slug,status,iniciado_em,jogos_gravados&iniciado_em=gte.${encodeURIComponent(sinceIso)}&order=iniciado_em.desc`;
  const headers = { apikey: SK, Authorization: `Bearer ${SK}`, 'User-Agent': 'SportsEdgeBot/1.0' };
  let runs;
  try {
    runs = await _httpGetJson(target, headers, 12000);
  } catch (e) { return { error: e.message }; }
  if (!Array.isArray(runs)) return { error: 'unexpected response' };

  const byHouse = new Map();
  for (const r of runs) {
    if (!byHouse.has(r.casa_slug)) byHouse.set(r.casa_slug, []);
    byHouse.get(r.casa_slug).push(r);
  }
  const now = Date.now();
  const houses = [];
  for (const [casa, list] of byHouse) {
    list.sort((a, b) => new Date(b.iniciado_em) - new Date(a.iniciado_em));
    const lastSuccess = list.find(r => r.status === 'sucesso' && (r.jogos_gravados || 0) > 0);
    const lastSuccessAge = lastSuccess
      ? Math.floor((now - new Date(lastSuccess.iniciado_em).getTime()) / 60000) // min
      : null;
    const last6h = list.filter(r => (now - new Date(r.iniciado_em).getTime()) < 6 * 3600 * 1000);
    const empty = last6h.filter(r => r.status === 'sucesso-vazio').length;
    const total6h = last6h.length;
    const emptyRate = total6h ? empty / total6h : 0;
    let state = 'saudavel';
    let reason = null;
    if (lastSuccessAge == null || lastSuccessAge > 24 * 60) {
      state = 'morta';
      reason = lastSuccessAge ? `último sucesso há ${(lastSuccessAge / 60).toFixed(1)}h` : 'nunca teve sucesso registrado em 24h';
    } else if (lastSuccessAge > 6 * 60 || emptyRate > 0.8) {
      state = 'degradada';
      reason = lastSuccessAge > 6 * 60
        ? `último sucesso há ${(lastSuccessAge / 60).toFixed(1)}h`
        : `${(emptyRate * 100).toFixed(0)}% sucesso-vazio em ${total6h} runs/6h`;
    }
    houses.push({ casa, state, reason, lastSuccessMinAgo: lastSuccessAge, runs6h: total6h, emptyRate6h: +emptyRate.toFixed(2) });
  }
  return { houses, fetchedAt: new Date().toISOString() };
}

/**
 * Pull raw snapshots de odds nas últimas N horas. Usado pelo book-bug-finder
 * pra detectar implied sum <100% e cross-market inconsistency.
 */
async function fetchRecentSnapshots({ hoursBack = 1 } = {}) {
  const SU = _supabaseUrl(), SK = _supabaseKey();
  if (!SU || !SK) return null;
  const sinceIso = new Date(Date.now() - hoursBack * 3600 * 1000).toISOString();
  const target = `${SU}/rest/v1/snapshots_odds?select=casa_slug,jogo_id,coletado_em,mercados&coletado_em=gte.${encodeURIComponent(sinceIso)}&order=coletado_em.desc&limit=2000`;
  const headers = { apikey: SK, Authorization: `Bearer ${SK}`, 'User-Agent': 'SportsEdgeBot/1.0' };
  try {
    return await _httpGetJson(target, headers, 12000);
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * Surface oportunidades BR ativas AGORA: super-odds cross-book usando latest
 * snapshot per (jogo, casa) e mediana de outros books como referência.
 * Diferente do super-odd-detector cron (que persiste histórico) — este é
 * snapshot pontual sem dependência de cron.
 *
 * @param {object} opts
 * @param {number} [opts.minRatio=1.10] — mínimo book/mediana
 * @param {number} [opts.minBooks=3]    — exige pelo menos N books pra calcular mediana
 * @returns {Promise<Array<oportunidades>>}
 */
async function fetchActiveEdgesBr({ minRatio = 1.10, minBooks = 3, hoursBack = 2 } = {}) {
  const SU = _supabaseUrl(), SK = _supabaseKey();
  if (!SU || !SK) return null;
  const sinceIso = new Date(Date.now() - hoursBack * 3600 * 1000).toISOString();
  // Query latest snapshot per (jogo, casa) + jogo info + nomes
  const url = `${SU}/rest/v1/rpc/br_active_edges_v1`;
  const headers = { apikey: SK, Authorization: `Bearer ${SK}`, 'User-Agent': 'SportsEdgeBot/1.0', 'Content-Type': 'application/json' };
  // RPC pode não existir; cai pra pull bruto + agregação client-side.
  try {
    const rpcRes = await _httpPostJson(url, headers, { p_min_ratio: minRatio, p_min_books: minBooks, p_since: sinceIso }, 12000);
    if (Array.isArray(rpcRes)) return rpcRes;
  } catch (_) {}
  // Fallback: pull snapshots + jogos + agrega no JS
  return _aggregateActiveEdgesClient({ sinceIso, minRatio, minBooks });
}

function _httpPostJson(targetUrl, headers, body, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const opts = url.parse(targetUrl);
    opts.method = 'POST';
    opts.headers = headers;
    opts.timeout = timeoutMs;
    const req = https.request(opts, (res) => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${b.slice(0, 200)}`));
        try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function _aggregateActiveEdgesClient({ sinceIso, minRatio, minBooks }) {
  const SU = _supabaseUrl(), SK = _supabaseKey();
  const headers = { apikey: SK, Authorization: `Bearer ${SK}`, 'User-Agent': 'SportsEdgeBot/1.0' };
  // Pull snapshots
  const snapsUrl = `${SU}/rest/v1/snapshots_odds?select=casa_slug,jogo_id,coletado_em,mercados&coletado_em=gte.${encodeURIComponent(sinceIso)}&order=coletado_em.desc&limit=3000`;
  const snaps = await _httpGetJson(snapsUrl, headers, 15000).catch(() => null);
  if (!Array.isArray(snaps)) return [];
  // Pull jogos (apenas futuros) pra resolver nomes
  const nowIso = new Date().toISOString();
  const jogosUrl = `${SU}/rest/v1/vw_jogos_publicos?select=*&inicio=gte.${encodeURIComponent(nowIso)}`;
  const jogos = await _httpGetJson(jogosUrl, headers, 12000).catch(() => null);
  const jogoById = new Map();
  for (const j of (jogos || [])) jogoById.set(j.id || j.slug, j);
  // Latest snapshot per (jogo, casa)
  const latest = new Map();
  for (const s of snaps) {
    const k = `${s.jogo_id}|${s.casa_slug}`;
    if (!latest.has(k)) latest.set(k, s);
  }
  // Group por jogo + side (1x2: h/d/a; ou: over/under)
  const sideExtractors = [
    { market: '1x2', side: 'h', label: 'home', get: m => parseFloat(m?.['1x2']?.['1']) },
    { market: '1x2', side: 'd', label: 'draw', get: m => parseFloat(m?.['1x2']?.['x']) },
    { market: '1x2', side: 'a', label: 'away', get: m => parseFloat(m?.['1x2']?.['2']) },
    { market: 'ou', side: 'over', label: 'over 2.5', get: m => parseFloat(m?.['over-under']?.over) },
    { market: 'ou', side: 'under', label: 'under 2.5', get: m => parseFloat(m?.['over-under']?.under) },
  ];
  const byJogo = new Map();
  for (const [k, snap] of latest) {
    if (!byJogo.has(snap.jogo_id)) byJogo.set(snap.jogo_id, []);
    byJogo.get(snap.jogo_id).push(snap);
  }
  const edges = [];
  const median = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  for (const [jogoId, snapList] of byJogo) {
    if (snapList.length < minBooks) continue;
    for (const sd of sideExtractors) {
      const odds = snapList.map(s => ({ casa: s.casa_slug, odd: sd.get(s.mercados) })).filter(x => Number.isFinite(x.odd) && x.odd > 1);
      if (odds.length < minBooks) continue;
      // Pra cada casa, leave-one-out median
      for (const target of odds) {
        if (target.odd < 1.5 || target.odd > 8) continue; // restrito a faixa apostável
        const others = odds.filter(o => o.casa !== target.casa).map(o => o.odd);
        if (others.length < minBooks - 1) continue;
        const med = median(others);
        if (!med || med <= 1) continue;
        const ratio = target.odd / med;
        if (ratio < minRatio) continue;
        const j = jogoById.get(jogoId) || {};
        const evPct = +((target.odd * (1 / med) - 1) * 100).toFixed(2);
        edges.push({
          jogo_id: jogoId,
          mandante: j.mandante?.nome || null,
          visitante: j.visitante?.nome || null,
          campeonato: j.campeonato_slug || null,
          inicio: j.inicio || null,
          market: sd.market, side: sd.side, label: sd.label,
          casa: target.casa, odd_outlier: +target.odd.toFixed(3),
          odd_mediana: +med.toFixed(3),
          ratio: +ratio.toFixed(3),
          ev_estimado_pct: evPct,
          n_books: odds.length,
        });
      }
    }
  }
  edges.sort((a, b) => b.ratio - a.ratio);
  return edges;
}

module.exports = {
  fetchUpcomingJogos,
  findJogoByTeams,
  jogoToAllOdds,
  jogoToOu25,
  jogoToBtts,
  jogoToEsportsMl,
  jogoToMatch,
  enrichMatches,
  enrichEsportsMatches,
  enrichTennisMatches,
  getStatus,
  fetchScraperHealth,
  fetchRecentSnapshots,
  fetchActiveEdgesBr,
  // Helpers de parse expostos pra testes
  _parse1x2,
  _parseMl,
  _parseOu,
  _parseBtts,
};
