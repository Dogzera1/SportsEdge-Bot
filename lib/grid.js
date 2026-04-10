/**
 * Cliente mínimo GRID (Central Data + Series State) para enriquecer LoL.
 * Docs: https://api-op.grid.gg/central-data/graphql — chave em x-api-key.
 * Open Access pode não incluir LoL; com chave contratual os dados aparecem.
 */
const https = require('https');
const { norm, log } = require('./utils');

const GRID_CENTRAL = (process.env.GRID_GRAPHQL_URL || 'https://api-op.grid.gg/central-data/graphql').trim();
const GRID_SERIES_STATE = (process.env.GRID_SERIES_STATE_URL || 'https://api-op.grid.gg/live-data-feed/series-state/graphql').trim();

const _gridEnrichCache = new Map();
const GRID_CACHE_TTL_MS = Math.max(60_000, parseInt(process.env.GRID_ENRICH_CACHE_MS || '3600000', 10) || 3600000);

function _gqlEscape(str) {
  return String(str || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function _httpsJsonPost(urlStr, headers, bodyObj) {
  const u = new URL(urlStr);
  const data = JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 0, json: JSON.parse(b) });
          } catch (_) {
            resolve({ status: res.statusCode || 0, json: null, raw: b });
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(Math.max(5000, parseInt(process.env.GRID_HTTP_TIMEOUT_MS || '25000', 10) || 25000), () => {
      req.destroy(new Error('GRID timeout'));
    });
    req.write(data);
    req.end();
  });
}

async function _gridCentral(apiKey, query, variables) {
  const r = await _httpsJsonPost(GRID_CENTRAL, { 'x-api-key': apiKey }, { query, variables });
  if (r.status !== 200 || !r.json) {
    return { ok: false, error: `HTTP ${r.status}`, raw: r.raw };
  }
  if (r.json.errors?.length) {
    return { ok: false, error: r.json.errors.map((e) => e.message).join('; ') };
  }
  return { ok: true, data: r.json.data };
}

async function _gridSeriesState(apiKey, seriesId) {
  const query = `query GridSeriesState($id: ID!) {
    seriesState(id: $id) {
      id
      finished
      started
      teams {
        id
        name
        won
        score
      }
    }
  }`;
  const r = await _httpsJsonPost(GRID_SERIES_STATE, { 'x-api-key': apiKey }, {
    query,
    variables: { id: String(seriesId) },
  });
  if (r.status !== 200 || !r.json) return null;
  if (r.json.errors?.length) return null;
  return r.json.data?.seriesState || null;
}

function _nameHitsTeam(gridName, ourName) {
  const g = norm(gridName || '');
  const t = norm(ourName || '');
  if (!g || !t) return false;
  if (g === t) return true;
  if (g.includes(t) || t.includes(g)) return true;
  const tg = t.replace(/\s+/g, '');
  const gg = g.replace(/\s+/g, '');
  if (tg.length >= 4 && (gg.includes(tg) || tg.includes(gg))) return true;
  return false;
}

function _teamFromNodeTeams(teamsArr, ourName) {
  if (!Array.isArray(teamsArr)) return null;
  for (const row of teamsArr) {
    const bi = row?.baseInfo || row;
    const n = bi?.name || row?.name;
    const id = bi?.id || row?.id;
    if (_nameHitsTeam(n, ourName)) return { id: id != null ? String(id) : null, name: n };
  }
  return null;
}

function _winnerNameFromState(state) {
  const teams = state?.teams;
  if (!Array.isArray(teams)) return null;
  const w = teams.find((t) => t && (t.won === true || t.won === 'true'));
  if (w?.name) return w.name;
  const byScore = teams.filter((t) => t && t.score != null);
  if (byScore.length >= 2) {
    const sorted = [...byScore].sort((a, b) => (parseFloat(b.score) || 0) - (parseFloat(a.score) || 0));
    return sorted[0]?.name || null;
  }
  return null;
}

async function _fetchAllSeriesPages(apiKey, gteIso, lteIso, titleId, maxPages, first) {
  const pages = [];
  let after = null;
  const queryWithTitle = `query GridAllSeries($gte: String!, $lte: String!, $first: Int!, $after: String, $titleId: Int!) {
    allSeries(
      filter: {
        startTimeScheduled: { gte: $gte, lte: $lte }
        titleId: { equals: $titleId }
      }
      first: $first
      after: $after
      orderBy: StartTimeScheduled
    ) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          startTimeScheduled
          teams { baseInfo { id name } }
          tournament { name id }
        }
      }
    }
  }`;
  const queryNoTitle = `query GridAllSeriesNoTitle($gte: String!, $lte: String!, $first: Int!, $after: String) {
    allSeries(
      filter: { startTimeScheduled: { gte: $gte, lte: $lte } }
      first: $first
      after: $after
      orderBy: StartTimeScheduled
    ) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          startTimeScheduled
          teams { baseInfo { id name } }
          tournament { name id }
        }
      }
    }
  }`;

  for (let p = 0; p < maxPages; p++) {
    let res = await _gridCentral(apiKey, queryWithTitle, {
      gte: gteIso,
      lte: lteIso,
      first,
      after,
      titleId,
    });
    if (!res.ok && titleId != null) {
      res = await _gridCentral(apiKey, queryNoTitle, { gte: gteIso, lte: lteIso, first, after });
    }
    if (!res.ok) {
      log('WARN', 'GRID', `allSeries falhou: ${res.error}`);
      break;
    }
    const conn = res.data?.allSeries;
    const edges = conn?.edges || [];
    pages.push(...edges);
    const pi = conn?.pageInfo;
    if (!pi?.hasNextPage || !pi?.endCursor) break;
    after = pi.endCursor;
  }
  return pages;
}

/**
 * @param {string} apiKey
 * @param {string} team1
 * @param {string} team2
 * @param {{ daysBack?: number, daysForward?: number, maxPages?: number, firstPerPage?: number, maxStateCalls?: number, titleId?: number }} opts
 */
async function fetchGridEnrichForMatch(apiKey, team1, team2, opts = {}) {
  const defDaysBack = parseInt(process.env.GRID_DAYS_BACK || '120', 10) || 120;
  const defDaysFwd = parseInt(process.env.GRID_DAYS_FORWARD || '2', 10) || 2;
  const defMaxPages = parseInt(process.env.GRID_MAX_PAGES || '8', 10) || 8;
  const defFirst = parseInt(process.env.GRID_FIRST_PER_PAGE || '40', 10) || 40;
  const defStateCalls = parseInt(process.env.GRID_MAX_STATE_CALLS || '22', 10) || 22;
  const defTitleId = parseInt(process.env.GRID_LOL_TITLE_ID || '3', 10) || 3;

  const daysBack = Math.min(365, Math.max(14, opts.daysBack ?? defDaysBack));
  const daysForward = Math.min(14, Math.max(0, opts.daysForward ?? defDaysFwd));
  const maxPages = Math.min(20, Math.max(1, opts.maxPages ?? defMaxPages));
  const firstPerPage = Math.min(80, Math.max(20, opts.firstPerPage ?? defFirst));
  const maxStateCalls = Math.min(40, Math.max(0, opts.maxStateCalls ?? defStateCalls));
  const titleId = opts.titleId ?? defTitleId;

  const now = Date.now();
  const gte = new Date(now - daysBack * 86400000).toISOString();
  const lte = new Date(now + daysForward * 86400000).toISOString();

  const cacheKey = `enrich:${norm(team1)}|${norm(team2)}|${Math.floor(now / GRID_CACHE_TTL_MS)}`;
  if (_gridEnrichCache.has(cacheKey)) return _gridEnrichCache.get(cacheKey);

  const empty = {
    ok: false,
    source: 'grid',
    h2h: null,
    form1: null,
    form2: null,
    seriesSample: 0,
    stateCalls: 0,
    error: null,
  };

  if (!apiKey || !team1 || !team2) {
    _gridEnrichCache.set(cacheKey, empty);
    return empty;
  }

  const edges = await _fetchAllSeriesPages(apiKey, gte, lte, titleId, maxPages, firstPerPage);
  if (!edges.length) {
    const out = { ...empty, error: 'nenhuma série no período' };
    _gridEnrichCache.set(cacheKey, out);
    return out;
  }

  const nodes = [];
  const seen = new Set();
  for (const e of edges) {
    const n = e?.node;
    if (!n?.id || seen.has(n.id)) continue;
    seen.add(n.id);
    nodes.push(n);
  }
  nodes.sort((a, b) => {
    const ta = new Date(a.startTimeScheduled || 0).getTime();
    const tb = new Date(b.startTimeScheduled || 0).getTime();
    return tb - ta;
  });

  const pairIds = [];
  const t1Ids = [];
  const t2Ids = [];
  for (const n of nodes) {
    const teams = n.teams;
    const a = _teamFromNodeTeams(teams, team1);
    const b = _teamFromNodeTeams(teams, team2);
    if (a && b) pairIds.push(String(n.id));
    else if (a) t1Ids.push(String(n.id));
    else if (b) t2Ids.push(String(n.id));
  }

  const stateIds = [];
  const addIds = (arr, cap) => {
    for (const id of arr) {
      if (stateIds.length >= maxStateCalls) break;
      if (!stateIds.includes(id)) stateIds.push(id);
      if (stateIds.length >= cap) break;
    }
  };
  addIds(pairIds, maxStateCalls);
  const remaining = maxStateCalls - stateIds.length;
  if (remaining > 0) addIds(t1Ids, stateIds.length + Math.ceil(remaining / 2));
  if (maxStateCalls - stateIds.length > 0) addIds(t2Ids, maxStateCalls);

  const stateById = new Map();
  let stateCalls = 0;
  for (const sid of stateIds) {
    if (stateCalls >= maxStateCalls) break;
    const st = await _gridSeriesState(apiKey, sid);
    stateCalls++;
    if (st) stateById.set(sid, st);
    const gap = Math.max(0, parseInt(process.env.GRID_STATE_CALL_GAP_MS || '120', 10) || 120);
    if (gap && stateCalls < stateIds.length) await new Promise((r) => setTimeout(r, gap));
  }

  let h2hT1 = 0;
  let h2hT2 = 0;
  let h2hDraw = 0;
  for (const sid of pairIds) {
    const st = stateById.get(sid);
    if (!st || st.finished === false) continue;
    const wn = _winnerNameFromState(st);
    if (!wn) continue;
    if (_nameHitsTeam(wn, team1) && !_nameHitsTeam(wn, team2)) h2hT1++;
    else if (_nameHitsTeam(wn, team2) && !_nameHitsTeam(wn, team1)) h2hT2++;
    else if (norm(wn) === 'draw' || norm(wn) === 'tie') h2hDraw++;
  }

  function formFromIds(ids, teamName, capGames) {
    let w = 0;
    let l = 0;
    let used = 0;
    for (const sid of ids) {
      if (used >= capGames) break;
      const st = stateById.get(sid);
      if (!st || st.finished === false) continue;
      const wn = _winnerNameFromState(st);
      if (!wn) continue;
      const won = _nameHitsTeam(wn, teamName);
      const lost = !won && !_nameHitsTeam(wn, teamName);
      if (!won && !lost) continue;
      used++;
      if (won) w++;
      else l++;
    }
    const total = w + l;
    if (total < 1) return null;
    return {
      wins: w,
      losses: l,
      winRate: Math.round((w / total) * 1000) / 10,
      streak: '—',
      recent: [],
      source: 'grid',
    };
  }

  const formCap = Math.max(3, parseInt(process.env.GRID_FORM_MAX_GAMES || '10', 10) || 10);
  const form1 = formFromIds(t1Ids, team1, formCap);
  const form2 = formFromIds(t2Ids, team2, formCap);

  const h2hTotal = h2hT1 + h2hT2 + h2hDraw;
  const h2h =
    h2hTotal > 0
      ? {
          t1Wins: h2hT1,
          t2Wins: h2hT2,
          draws: h2hDraw,
          totalMatches: h2hTotal,
          totalGames: h2hTotal,
          source: 'grid',
        }
      : null;

  const out = {
    ok: true,
    source: 'grid',
    h2h,
    form1,
    form2,
    seriesListed: nodes.length,
    stateCalls,
    error: null,
  };
  _gridEnrichCache.set(cacheKey, out);
  if (process.env.LOG_GRID_ENRICH === 'true') {
    log('INFO', 'GRID', `enrich ${team1} vs ${team2}: séries=${nodes.length} states=${stateCalls} h2h=${h2h ? `${h2hT1}-${h2hT2}` : '—'}`);
  }
  return out;
}

module.exports = {
  fetchGridEnrichForMatch,
  GRID_CENTRAL,
  GRID_SERIES_STATE,
};
