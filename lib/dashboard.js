/**
 * lib/dashboard.js — Lógica do dashboard embutido no server.js principal.
 *
 * Exporta:
 *   - classify(text)         → {level, bot, kind, isLive}
 *   - getClassifiedBuffer()  → buffer completo, classificado lazy
 *   - computeStatus()        → saúde por bot
 *   - extractTips(limit)     → tips enviadas/negadas
 *   - extractLiveMatches()   → partidas live no log buffer
 *   - runLiveScout(base)     → snapshot das partidas live via /live-snapshot
 *   - runFeedMedic(base)     → saúde de fontes externas
 *   - runRoiAnalyst(db,days) → ROI/Brier/calibração das tips
 */

const http = require('http');
const https = require('https');
const { getLogBuffer } = require('./utils');

// ─────────────────────────────────────────────────────────
// Classificação de linhas — copiado de scripts/logs-dashboard.js
// ─────────────────────────────────────────────────────────
function classify(textRaw) {
  const l = String(textRaw || '');
  const lc = l.toLowerCase();
  let level = 'info';
  if (/\b(error|erro|fatal|panic|exception)\b/i.test(l)) level = 'error';
  else if (/\bwarn(ing)?\b/i.test(l)) level = 'warn';
  else if (/\bdebug\b/i.test(l)) level = 'debug';

  let bot = 'system';
  if (/\b(lol|riot|league|lck|lcs|lec|lpl|lcp|esports)\b/i.test(l)) bot = 'lol';
  else if (/\[LOL-MODEL\]|\[LIVE-STATS\]|\[LIVE-GAME\]|\[LIVE-ODDS\]|\[PANDASCORE\]|\[GOLGG\]|\[GRID\]|\[LOL-SLUG\]|\[AUTO\]\s+(Analisando|Esports\s+upcoming|Liga\s+principal|LoL:|Tip\s+aprovada|Sem\s+tip|Upcoming|Odds\s+stale|Pr[ée]-filtro\s+ML|Draft|DeepSeek|IA\s+(em|sem))/i.test(l)) bot = 'lol';
  if (/\bdota\b/i.test(l) || /opendota|steam.?rt|radiant|dire/i.test(l)) bot = 'dota';
  if (/\b(cs2|cs:?go|counter.?strike|hltv)\b/i.test(l) || /\bAUTO-CS\b/.test(l) || /\[CS\]/.test(l)) bot = 'cs';
  if (/\btennis|tenis\b/i.test(l) && !/table.?tennis|tabletennis|tenis.?de.?mesa/i.test(lc)) bot = 'tennis';
  if (/table.?tennis|tabletennis|tenis.?de.?mesa|tt.?match/i.test(lc)) bot = 'tabletennis';
  if (/\bmma|ufc|pfl|bellator|rizin|cagewarriors\b/i.test(l)) bot = 'mma';
  if (/\bfootball|futebol|AUTO-FOOTBALL|football-matches\b/i.test(l)) bot = 'football';
  if (/\bsnooker|cuetracker\b/i.test(l)) bot = 'snooker';
  if (/\bdarts?\b/i.test(l)) bot = 'darts';
  if (/\bvalorant\b/i.test(l) || /\bAUTO-VAL\b/.test(l) || /\[VAL-|\[VLR-|VCT|VCL\b/i.test(l)) bot = 'valorant';

  let kind = null;
  if (/\bTIP\b|\bAUTO-(LOL|DOTA|TENIS|MMA|DARTS|SNOOKER|TT|CS|FOOTBALL|VAL)\b|envia(da|ndo)/i.test(l)) kind = 'tip';
  if (/livestats|live.?stats|streamlist|window\//i.test(lc)) kind = 'stats';
  if (/calibrat/i.test(lc)) kind = 'calibration';

  const isLive = /\bLIVE\b|\bao vivo\b|\[AO VIVO\]|hasLiveStats=true|state=in_game|isLive:?\s*1|Scorebot|"live":\s*true|\blive PS\b/i.test(l);

  return { level, bot, kind, isLive };
}

// Buffer classificado (reaproveita level/tag do log original, enriquece com bot/isLive)
function getClassifiedBuffer() {
  return getLogBuffer().map(e => {
    const meta = classify(e.text);
    return {
      t: e.t,
      text: e.text,
      level: e.level || meta.level,
      tag: e.tag || null,
      bot: meta.bot,
      kind: meta.kind,
      isLive: meta.isLive,
    };
  });
}

// ─────────────────────────────────────────────────────────
// Status por bot
// ─────────────────────────────────────────────────────────
const SPORTS = [
  { bot: 'lol',         label: 'League of Legends', emoji: '🟦', windowMin: 5,  cycleEverySec: 90 },
  { bot: 'dota',        label: 'Dota 2',            emoji: '🟥', windowMin: 12, cycleEverySec: 360 },
  { bot: 'cs',          label: 'Counter-Strike 2',  emoji: '🔫', windowMin: 12, cycleEverySec: 360 },
  { bot: 'tennis',      label: 'Tênis',             emoji: '🎾', windowMin: 12, cycleEverySec: 300 },
  { bot: 'tabletennis', label: 'Tênis de Mesa',     emoji: '🏓', windowMin: 15, cycleEverySec: 600 },
  { bot: 'mma',         label: 'MMA / Boxe',        emoji: '🥊', windowMin: 12, cycleEverySec: 360 },
  { bot: 'football',    label: 'Futebol',           emoji: '⚽', windowMin: 15, cycleEverySec: 900 },
  { bot: 'snooker',     label: 'Snooker',           emoji: '🎱', windowMin: 30, cycleEverySec: 1800 },
  { bot: 'darts',       label: 'Darts',             emoji: '🎯', windowMin: 30, cycleEverySec: 1800 },
];

function fmtAgo(ms) {
  if (ms == null) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s atrás`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min atrás`;
  return `${Math.floor(m / 60)}h${m % 60}min atrás`;
}

function statusForSport(buffer, cfg) {
  const now = Date.now();
  const cutoff = now - cfg.windowMin * 60 * 1000;
  const window = buffer.filter(e => e.bot === cfg.bot && e.t >= cutoff);
  const all = buffer.filter(e => e.bot === cfg.bot);
  const last = all[all.length - 1];

  const cycles = window.filter(e => /AUTO-(LOL|DOTA|MMA|TENIS|TT|SNOOKER|DARTS|CS)|Iniciando verifica|\/lol-matches|\/dota-matches|\/tennis-matches|\/mma-matches|\/snooker-matches|\/darts-matches|\/tabletennis-matches|\/cs-matches/i.test(e.text)).length;
  const liveActivity = window.filter(e => e.isLive).length;
  const errors = window.filter(e => e.level === 'error' || /\[stderr\]|ECONN|ETIMEDOUT|ENOTFOUND|fail(ed)?|exception/i.test(e.text)).length;
  const warns  = window.filter(e => e.level === 'warn').length;
  const tipsSent = window.filter(e => /tip\s+enviad|TIP-\d|Tip enviada/i.test(e.text)).length;
  const noTip    = window.filter(e => /Sem tip:/i.test(e.text)).length;

  const issues = [];
  let level = 'ok';
  let summary = '';
  const m = { cycles, errors, warns, tipsSent, noTip };

  if (cfg.bot === 'lol') {
    const liveStatsLines = window.filter(e => /LIVE-STATS.*LoL/i.test(e.text));
    const liveStatsOk = liveStatsLines.filter(e => /hasLiveStats=true/i.test(e.text));
    m.liveStatsOk = liveStatsOk.length;
    m.liveStatsAttempts = liveStatsLines.length;
    const lolMatches = window.filter(e => /\/lol-matches fonte=/i.test(e.text));
    m.lolMatches = lolMatches.length;
    if (lolMatches.length === 0) { issues.push('Sem ciclos /lol-matches na janela'); level = 'error'; }
    if (liveStatsLines.length > 0 && liveStatsOk.length === 0) {
      issues.push('Tentou pegar live stats mas nenhuma partida retornou hasLiveStats=true');
      if (level === 'ok') level = 'warn';
    }
    summary = liveStatsOk.length > 0
      ? `${liveStatsOk.length}/${liveStatsLines.length} partidas com live stats · ${lolMatches.length} ciclos · ${tipsSent} tips · ${noTip} sem-edge`
      : `${lolMatches.length} ciclos · ${liveStatsLines.length} consultas live · ${tipsSent} tips · ${noTip} sem-edge`;
  } else if (cfg.bot === 'cs') {
    const cyc = window.filter(e => /AUTO-CS|\/cs-matches|Pinnacle CS2/i.test(e.text));
    const lastCount = window.map(e => e.text.match(/\/cs-matches: (\d+) total/)).filter(Boolean).pop();
    m.cycles = cyc.length;
    m.matches = lastCount ? +lastCount[1] : 0;
    if (cyc.length === 0) { issues.push('Sem ciclos AUTO-CS / sem requests /cs-matches na janela'); level = 'warn'; }
    summary = `${cyc.length} ciclos · ${m.matches} partidas · ${tipsSent} tips (shadow)`;
  } else if (cfg.bot === 'dota') {
    const cyc = window.filter(e => /AUTO-DOTA Iniciando|\/dota-matches/i.test(e.text));
    const liveCount = window.filter(e => /\/dota-matches: \d+ total \(\d+ live PS/i.test(e.text)).map(e => {
      const mt = e.text.match(/(\d+) total \((\d+) live PS, (\d+) odds/);
      return mt ? { total: +mt[1], live: +mt[2], odds: +mt[3] } : null;
    }).filter(Boolean);
    const lastCount = liveCount[liveCount.length - 1] || { total: 0, live: 0, odds: 0 };
    const noOdds = window.filter(e => /Sem odds ao vivo/i.test(e.text)).length;
    const steamOk = window.filter(e => /Steam.?RT|realtime|radiant_lead/i.test(e.text)).length;
    m.cycles = cyc.length;
    m.liveMatches = lastCount.live;
    m.liveOdds = lastCount.odds;
    m.steamRT = steamOk;
    m.noOddsLines = noOdds;
    if (cyc.length === 0) { issues.push('Sem ciclos AUTO-DOTA na janela'); level = 'error'; }
    if (lastCount.live > 0 && lastCount.odds === 0) {
      issues.push(`${lastCount.live} partida(s) ao vivo mas sem odds Pinnacle/Odds-API → sem tip possível`);
      if (level === 'ok') level = 'warn';
    }
    summary = `${cyc.length} ciclos · ${lastCount.live} live · ${lastCount.odds} com odds · ${tipsSent} tips`;
  } else if (cfg.bot === 'tennis') {
    const cyc = window.filter(e => /AUTO-TENIS|\/tennis-matches|tennis|tenis/i.test(e.text));
    m.cycles = cyc.length;
    if (cyc.length === 0) { issues.push('Sem atividade do bot de tênis na janela'); level = 'warn'; }
    summary = `${cyc.length} eventos · ${tipsSent} tips · ${noTip} sem-edge`;
  } else if (cfg.bot === 'mma') {
    const cyc = window.filter(e => /AUTO-MMA Iniciando/i.test(e.text));
    const lastFights = window.map(e => e.text.match(/(\d+) lutas com odds.*MMA: (\d+) \| Boxe: (\d+)/)).filter(Boolean).pop();
    const espn = window.find(e => /ESPN: \d+ lutas/i.test(e.text));
    m.cycles = cyc.length;
    m.fights = lastFights ? +lastFights[1] : 0;
    m.espn = espn ? +(espn.text.match(/ESPN: (\d+)/)?.[1] || 0) : 0;
    if (cyc.length === 0) { issues.push('Sem ciclos AUTO-MMA na janela'); level = 'error'; }
    if (m.espn === 0 && cyc.length > 0) { issues.push('ESPN retornou 0 lutas (enriquecimento degradado)'); if (level === 'ok') level = 'warn'; }
    summary = `${cyc.length} ciclos · ${m.fights} lutas (MMA+Boxe) · ESPN ${m.espn} · ${tipsSent} tips`;
  } else if (cfg.bot === 'tabletennis') {
    const cyc = window.filter(e => /AUTO-TT|tabletennis|tenis.?de.?mesa/i.test(e.text));
    const matchesLine = window.map(e => e.text.match(/(\d+) partidas TT com odds/)).filter(Boolean).pop();
    m.cycles = cyc.length;
    m.matches = matchesLine ? +matchesLine[1] : 0;
    if (cyc.length === 0) { issues.push('Sem ciclos AUTO-TT na janela'); level = 'warn'; }
    summary = `${cyc.length} eventos · ${m.matches} partidas com odds · ${tipsSent} tips (shadow)`;
  } else if (cfg.bot === 'football') {
    const cyc = window.filter(e => /AUTO-FOOTBALL|\/football-matches/i.test(e.text));
    const lastCount = window.map(e => e.text.match(/(\d+) partidas futebol com odds/)).filter(Boolean).pop();
    m.cycles = cyc.length;
    m.matches = lastCount ? +lastCount[1] : 0;
    if (cyc.length === 0) { issues.push('Sem ciclos AUTO-FOOTBALL na janela'); level = 'warn'; }
    summary = `${cyc.length} ciclos · ${m.matches} partidas · ${tipsSent} tips`;
  } else {
    if (window.length === 0) { issues.push(`Nenhuma atividade na janela (${cfg.windowMin} min)`); level = 'warn'; }
    summary = `${window.length} eventos · ${tipsSent} tips · ${errors} erros`;
  }

  if (errors > 0) {
    issues.unshift(`${errors} erro(s) na janela`);
    level = 'error';
  }

  const lastCycleEntry = [...window].reverse().find(e => /AUTO-|fonte=arush|matches:|matches ?\(/i.test(e.text)) || last;
  const lastAge = lastCycleEntry ? now - lastCycleEntry.t : null;
  if (lastAge != null && lastAge > cfg.cycleEverySec * 1000 * 3) {
    issues.push(`Última atividade há ${fmtAgo(lastAge)} (esperado a cada ~${Math.round(cfg.cycleEverySec/60)}min)`);
    if (level === 'ok') level = 'warn';
  }

  m.liveActivity = liveActivity;
  return {
    bot: cfg.bot, label: cfg.label, emoji: cfg.emoji, windowMin: cfg.windowMin,
    status: level, summary: summary || 'Sem dados', issues, metrics: m,
    hasLive: liveActivity > 0, liveCount: liveActivity,
    lastActivity: last?.t || null, lastActivityAgo: last ? fmtAgo(now - last.t) : '—',
  };
}

function computeStatus() {
  const buffer = getClassifiedBuffer();
  const now = Date.now();
  const sports = SPORTS.map(cfg => statusForSport(buffer, cfg)).sort((a, b) => {
    if (a.hasLive !== b.hasLive) return a.hasLive ? -1 : 1;
    const rank = { error: 0, warn: 1, ok: 2 };
    return (rank[a.status] ?? 3) - (rank[b.status] ?? 3);
  });
  const overall = sports.some(s => s.status === 'error') ? 'error'
                : sports.some(s => s.status === 'warn')  ? 'warn'
                : 'ok';
  return {
    now, nowIso: new Date(now).toISOString(),
    subprocess: { running: true, startedAt: null, bufferSize: buffer.length, lastError: null },
    overall, sports,
  };
}

function extractTips(limit = 60) {
  const buffer = getClassifiedBuffer();
  const sent = [], denied = [];
  for (const e of buffer) {
    const t = e.text;
    const isLive = !!e.isLive;
    const stripPrefix = s => s.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*\[[A-Z]+\]\s*\[[^\]]+\]\s*/, '').trim();
    if (/Tip enviada/i.test(t)) {
      sent.push({ t: e.t, bot: e.bot, isLive, text: t.replace(/^.*?Tip enviada:?\s*/i, '').trim() });
    } else if (/\bSem tip:/i.test(t)) {
      denied.push({ t: e.t, bot: e.bot, isLive, reason: 'sem-edge', text: t.replace(/^.*?Sem tip:\s*/i, '').trim() });
    } else if (/Tip bloqueada/i.test(t)) {
      denied.push({ t: e.t, bot: e.bot, isLive, reason: 'gate', text: t.replace(/^.*?Tip bloqueada:?\s*/i, '').trim() });
    } else if (/Gate sem-dados/i.test(t)) {
      denied.push({ t: e.t, bot: e.bot, isLive, reason: 'sem-dados', text: t.replace(/^.*?Gate sem-dados:\s*/i, '').trim() });
    } else if (/Gate EV sanity.*rejeitado/i.test(t)) {
      denied.push({ t: e.t, bot: e.bot, isLive, reason: 'ev-sanity', text: stripPrefix(t) });
    } else if (/\[RISK\].*?bloqueada/i.test(t) || /RISK.*?: bloqueada/i.test(t)) {
      denied.push({ t: e.t, bot: e.bot, isLive, reason: 'risk', text: t.replace(/^.*?bloqueada\s*/i, 'bloqueada ').trim() });
    } else if (/BAIXA rejeitada/i.test(t)) {
      denied.push({ t: e.t, bot: e.bot, isLive, reason: 'baixa-gate', text: stripPrefix(t) });
    } else if (/Fallback.*rejeitado/i.test(t)) {
      denied.push({ t: e.t, bot: e.bot, isLive, reason: 'fallback', text: stripPrefix(t) });
    } else if (/Tip rejeitada\b|Tip com odd inválida rejeitada|Tip com EV inválido rejeitada|Tip sem time rejeitada/i.test(t)) {
      denied.push({ t: e.t, bot: e.bot, isLive, reason: 'invalid', text: stripPrefix(t) });
    }
  }
  const sortLivePriority = (a, b) => {
    if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
    return b.t - a.t;
  };
  return {
    sent: sent.slice(-limit).sort(sortLivePriority),
    denied: denied.slice(-limit).sort(sortLivePriority),
    countsTotal: {
      sent: sent.length, sentLive: sent.filter(x => x.isLive).length,
      denied: denied.length, deniedLive: denied.filter(x => x.isLive).length,
    },
  };
}

function extractLiveMatches() {
  const buffer = getClassifiedBuffer();
  const now = Date.now();
  const WINDOW = 20 * 60 * 1000;
  const cutoff = now - WINDOW;
  const recent = buffer.filter(e => e.t >= cutoff);
  const vsRe = /(?:^|[\s|:])([A-Z0-9][A-Za-z0-9 .'\-&!]+?)\s+vs\.?\s+([A-Z0-9][A-Za-z0-9 .'\-&!]+?)(?:\s*[\|—\-@(:→\n]|$)/;
  const matches = new Map();

  for (const e of recent) {
    if (e.bot === 'system') continue;
    const text = e.text;
    const isLiveLine = e.isLive || /\bLIVE\b|ao vivo|live PS|status=live|isLive/i.test(text);
    const m = text.match(vsRe);
    if (!m) continue;
    const t1 = m[1].trim(), t2 = m[2].trim();
    if (t1.length < 2 || t2.length < 2) continue;
    if (/^\d+$/.test(t1) || /^\d+$/.test(t2)) continue;
    const key = `${e.bot}|${t1.toLowerCase()}|${t2.toLowerCase()}`;
    const existing = matches.get(key);
    let status = 'upcoming';
    if (isLiveLine) status = 'live';
    else if (/draft|pick.?ban|champselect/i.test(text)) status = 'draft';
    else if (/finish|termin|ended|resolved/i.test(text)) status = 'finished';
    let activity = 'analyzing';
    if (/Tip enviada/i.test(text)) activity = 'tip_sent';
    else if (/Sem tip:|Sem edge|edge insuficiente|EV baixo|BAIXA rejeit/i.test(text)) activity = 'no_edge';
    else if (/Odds stale/i.test(text)) activity = 'stale_odds';
    else if (/LIVE-STATS|live.?stats|hasLiveStats/i.test(text)) activity = 'live_stats';
    else if (/Analisando:|sinais=/i.test(text)) activity = 'deep_analysis';
    else if (/Gate|bloqueada|rejeit/i.test(text)) activity = 'blocked';
    if (!existing || e.t > existing.lastSeen) {
      matches.set(key, {
        sport: e.bot, team1: existing?.team1 || t1, team2: existing?.team2 || t2,
        status: (existing?.status === 'live' && status !== 'finished') ? 'live' : status,
        activity, lastSeen: e.t, firstSeen: existing?.firstSeen || e.t,
        tipSent: existing?.tipSent || activity === 'tip_sent',
        liveStats: existing?.liveStats || activity === 'live_stats',
        mentions: (existing?.mentions || 0) + 1,
      });
    } else if (existing) {
      if (activity === 'tip_sent') existing.tipSent = true;
      if (activity === 'live_stats') existing.liveStats = true;
      if (status === 'live') existing.status = 'live';
      existing.mentions++;
    }
  }
  const result = [...matches.values()]
    .filter(m => m.status === 'live' || m.status === 'draft' || (now - m.lastSeen < 10 * 60 * 1000))
    .sort((a, b) => {
      const rank = { live: 0, draft: 1, upcoming: 2, finished: 3 };
      const ra = rank[a.status] ?? 9, rb = rank[b.status] ?? 9;
      if (ra !== rb) return ra - rb;
      return b.lastSeen - a.lastSeen;
    });
  return {
    matches: result,
    liveCount: result.filter(m => m.status === 'live').length,
    totalTracked: result.length,
    windowMin: Math.round(WINDOW / 60000),
  };
}

// ─────────────────────────────────────────────────────────
// HTTP helper pra agents (com timeout)
// ─────────────────────────────────────────────────────────
function agentHttpGet(targetUrl, timeoutMs = 5000, extraHeaders = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    try {
      const u = new URL(targetUrl);
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.get({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + (u.search || ''),
        headers: { 'User-Agent': 'SportsEdge-Dashboard/1.0', 'Accept': 'application/json,*/*', ...extraHeaders },
        timeout: timeoutMs,
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { if (body.length < 2_000_000) body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body, latency: Date.now() - start }));
      });
      req.on('error', (e) => resolve({ status: 0, error: e.message, latency: Date.now() - start }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout', latency: Date.now() - start }); });
    } catch (e) {
      resolve({ status: 0, error: e.message, latency: Date.now() - start });
    }
  });
}

// ─────────────────────────────────────────────────────────
// Agents
// ─────────────────────────────────────────────────────────
async function runLiveScout(serverBase) {
  const r = await agentHttpGet(`${serverBase}/live-snapshot`, 15000);
  if (r.status !== 200) {
    return { ok: false, error: `snapshot: HTTP ${r.status}${r.error ? ' ' + r.error : ''}`, latency: r.latency };
  }
  let snap;
  try { snap = JSON.parse(r.body); } catch (e) { return { ok: false, error: 'parse: ' + e.message }; }

  const gaps = [];
  const out = { generatedAt: snap.generatedAt, latency: r.latency, sports: {} };
  for (const sport of ['lol', 'dota', 'cs', 'valorant', 'tennis']) {
    const rows = snap.sports?.[sport] || [];
    out.sports[sport] = rows.map(m => {
      const s = m.liveStats || {};
      const flags = [];
      if (String(m.matchId || '').startsWith('ps_') && s.reason === 'no_gameids') flags.push('no_gameids_in_ps');
      if (s.reason === 'stats_disabled') flags.push('stats_disabled');
      if (s.available === false && s.gameState === 'in_progress') flags.push('live_sem_frames');
      if (sport === 'tennis' && s.reason === 'no_sofascore_match') flags.push('sofascore_missing');
      const delay = s.summary?.dataDelay ?? null;
      if (sport === 'lol' && delay != null && delay > 600 && m.league && !/LPL/i.test(m.league)) flags.push(`delay_alto_${delay}s`);
      if (flags.length) gaps.push({ sport, matchId: m.matchId, teams: `${m.team1} vs ${m.team2}`, flags });
      return {
        matchId: m.matchId, league: m.league, teams: `${m.team1} vs ${m.team2}`,
        score: m.score, format: m.format,
        gameNumber: s.gameNumber, gameState: s.gameState,
        available: !!s.available, reason: s.reason || null, delay,
        summary: s.summary || null, hasPinnacle: !!m.pinnacle, flags,
      };
    });
  }
  for (const sport of Object.keys(out.sports)) {
    const byPair = new Map();
    for (const m of out.sports[sport]) {
      const [a, b] = m.teams.split(' vs ').map(x => (x || '').toLowerCase().replace(/[^a-z0-9]/g, ''));
      const key = [a, b].sort().join('|');
      if (byPair.has(key)) gaps.push({ sport, matchId: m.matchId, teams: m.teams, flags: ['duplicata_invertida'] });
      else byPair.set(key, m.matchId);
    }
  }

  // ── Coverage audit ──
  // Compara universo live (Sofascore) com o que o bot monitora.
  // Detecta automaticamente partidas que o sistema está deixando de fora.
  out.coverage = {};
  try {
    const coverage = await _checkTennisCoverage(out.sports.tennis || []);
    if (coverage) {
      out.coverage.tennis = coverage;
      for (const miss of coverage.missing) {
        gaps.push({ sport: 'tennis', teams: `${miss.home} vs ${miss.away}`, flags: [`coverage_missing:${miss.reason || 'unknown'}`], league: miss.league, sofaId: miss.sofaId });
      }
    }
  } catch (_) {}

  out.gaps = gaps;
  out.totalLive = Object.values(out.sports).reduce((a, arr) => a + arr.length, 0);
  return { ok: true, ...out };
}

// Audita cobertura do bot vs Sofascore (universo de partidas live ATP/WTA/challengers/ITF).
// Retorna { sofaTotal, botCovered, missing: [{home,away,league,sofaId,reason}] }.
// Reason tenta explicar por que o bot não pegou (sem odds Pinnacle, doubles, ITF de baixo volume).
async function _checkTennisCoverage(botTennisRows) {
  const r = await agentHttpGet('https://www.sofascore.com/api/v1/sport/tennis/events/live', 8000, {
    'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json',
  });
  if (r.status !== 200) return null;
  let data;
  try { data = JSON.parse(r.body); } catch (_) { return null; }
  const events = Array.isArray(data.events) ? data.events : [];

  // Filtra doubles (não monitoramos) — nomes com " / " indicam dupla
  const singles = events.filter(e => {
    const h = String(e.homeTeam?.name || '');
    const a = String(e.awayTeam?.name || '');
    return !h.includes(' / ') && !a.includes(' / ');
  });

  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
  const botPairs = new Set();
  for (const m of botTennisRows) {
    const [a, b] = (m.teams || '').split(' vs ').map(norm);
    if (a && b) botPairs.add([a, b].sort().join('|'));
  }

  const classifyReason = (ev) => {
    const tour = String(ev.tournament?.name || '').toLowerCase();
    const cat  = String(ev.tournament?.category?.name || '').toLowerCase();
    if (/itf/.test(cat) || /itf/.test(tour)) return 'itf_sem_pinnacle';
    if (/challenger/.test(tour) || /challenger/.test(cat)) return 'challenger_sem_odds';
    // ATP/WTA principal: esperamos cobertura. Ausência é bug de enriquecimento.
    if (/atp|wta/.test(cat)) return 'atp_wta_sem_odds_flag';
    return 'sem_odds_matched';
  };

  const missing = [];
  for (const ev of singles) {
    const h = norm(ev.homeTeam?.name);
    const a = norm(ev.awayTeam?.name);
    if (!h || !a) continue;
    const key = [h, a].sort().join('|');
    if (botPairs.has(key)) continue;
    missing.push({
      home: ev.homeTeam?.name,
      away: ev.awayTeam?.name,
      league: `${ev.tournament?.category?.name || ''} ${ev.tournament?.name || ''}`.trim(),
      sofaId: ev.id,
      reason: classifyReason(ev),
    });
  }

  return {
    sofaTotal: singles.length,
    sofaDoubles: events.length - singles.length,
    botCovered: botTennisRows.length,
    missingCount: missing.length,
    missing: missing.slice(0, 25), // cap pra não explodir payload
    missingTruncated: missing.length > 25,
  };
}

async function runFeedMedic(serverBase) {
  const RIOT_KEY = process.env.LOL_API_KEY || process.env.NEXT_PUBLIC_LOL_API || '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
  const riotHeaders = { 'x-api-key': RIOT_KEY };
  const targets = [
    { id: 'riot_schedule', label: 'Riot getSchedule', url: 'https://esports-api.lolesports.com/persisted/gw/getSchedule?hl=en-US', headers: riotHeaders },
    { id: 'riot_live_en',  label: 'Riot getLive (en-US)', url: 'https://esports-api.lolesports.com/persisted/gw/getLive?hl=en-US', headers: riotHeaders },
    { id: 'riot_live_zh',  label: 'Riot getLive (zh-CN)', url: 'https://esports-api.lolesports.com/persisted/gw/getLive?hl=zh-CN', headers: riotHeaders },
    { id: 'vlr',           label: 'VLR.gg /matches', url: 'https://www.vlr.gg/matches' },
    { id: 'server_local',  label: 'server.js local', url: `${serverBase}/lol-matches` },
  ];
  const results = await Promise.all(targets.map(async t => {
    const r = await agentHttpGet(t.url, 8000, t.headers || {});
    return { id: t.id, label: t.label, status: r.status, latency: r.latency, error: r.error || null, bytes: r.body?.length || 0 };
  }));
  const buffer = getClassifiedBuffer();
  const recent = buffer.slice(-1000);
  const pinnacleLine = [...recent].reverse().find(e => /Pinnacle LoL:/i.test(e.text));
  const odssApiLine  = [...recent].reverse().find(e => /Quota The Odds API/i.test(e.text));
  const espnMmaLine  = [...recent].reverse().find(e => /ESPN-MMA.*lutas carregadas/i.test(e.text));
  const backoffLine  = [...recent].reverse().find(e => /backoff .* ativado|backoff ativo/i.test(e.text));
  return {
    ok: true, at: Date.now(), feeds: results,
    logDerived: {
      pinnacle: pinnacleLine ? { text: pinnacleLine.text, at: pinnacleLine.t } : null,
      oddsApi:  odssApiLine  ? { text: odssApiLine.text,  at: odssApiLine.t }  : null,
      espnMma:  espnMmaLine  ? { text: espnMmaLine.text,  at: espnMmaLine.t }  : null,
      backoff:  backoffLine  ? { text: backoffLine.text,  at: backoffLine.t }  : null,
    },
  };
}

function runRoiAnalyst(db, days) {
  if (!db) return { ok: false, error: 'db indisponível' };
  const daysN = Math.max(1, Math.min(365, parseInt(days || '30', 10)));
  const cutoff = `-${daysN} days`;
  const base = `
    SELECT sport, participant1, participant2, odds, ev, stake, stake_reais, profit_reais,
           confidence, result, is_live, settled_at, sent_at, market_type
    FROM tips
    WHERE settled_at IS NOT NULL
      AND result IN ('win','loss','push')
      AND settled_at >= datetime('now', ?)`;
  let rows;
  try { rows = db.prepare(base).all(cutoff); }
  catch (e) { return { ok: false, error: 'query: ' + e.message }; }

  const agg = (items) => {
    const settled = items.filter(x => x.result !== 'push');
    const totalStake = settled.reduce((a, x) => a + (Number(x.stake_reais ?? x.stake) || 0), 0);
    const totalProfit = settled.reduce((a, x) => a + (Number(x.profit_reais) || 0), 0);
    const wins = settled.filter(x => x.result === 'win').length;
    const hitRate = settled.length ? wins / settled.length : null;
    const roi = totalStake > 0 ? totalProfit / totalStake : null;
    const brierEntries = settled.filter(x => Number(x.odds) > 1).map(x => {
      const pImp = 1 / Number(x.odds);
      const hit = x.result === 'win' ? 1 : 0;
      return (pImp - hit) ** 2;
    });
    const brier = brierEntries.length ? brierEntries.reduce((a, b) => a + b, 0) / brierEntries.length : null;
    return { n: items.length, settled: settled.length, wins, hitRate, roi, totalStake, totalProfit, brier };
  };

  const bySportMap = {};
  for (const r of rows) (bySportMap[r.sport] = bySportMap[r.sport] || []).push(r);
  const bySport = Object.entries(bySportMap).map(([sport, arr]) => ({ sport, ...agg(arr) }))
    .sort((a, b) => (b.n || 0) - (a.n || 0));

  const isNumericConf = rows.some(r => Number.isFinite(Number(r.confidence)) && String(r.confidence).trim() !== '');
  let byBucket;
  if (isNumericConf) {
    const buckets = [
      { key: '<55%', min: 0, max: 0.55 },
      { key: '55-65', min: 0.55, max: 0.65 },
      { key: '65-75', min: 0.65, max: 0.75 },
      { key: '75%+', min: 0.75, max: 1.01 },
    ];
    byBucket = buckets.map(b => {
      const items = rows.filter(x => { const c = Number(x.confidence); return Number.isFinite(c) && c >= b.min && c < b.max; });
      return { bucket: b.key, ...agg(items) };
    });
  } else {
    const order = ['ALTA', 'MÉDIA', 'MEDIA', 'BAIXA'];
    const seen = new Set(rows.map(r => String(r.confidence || '').trim().toUpperCase()));
    byBucket = order.filter(k => seen.has(k)).map(k => {
      const items = rows.filter(x => String(x.confidence || '').trim().toUpperCase() === k);
      return { bucket: k, ...agg(items) };
    });
  }

  // Breakdown por market_type (ML-série vs MAP1/MAP2/... vs HANDICAP)
  const byMarketMap = {};
  for (const r of rows) {
    const mt = String(r.market_type || 'ML').toUpperCase();
    (byMarketMap[mt] = byMarketMap[mt] || []).push(r);
  }
  const byMarket = Object.entries(byMarketMap).map(([market, arr]) => ({ market, ...agg(arr) }))
    .sort((a, b) => (b.n || 0) - (a.n || 0));

  const leaks = [];
  for (const s of bySport) if (s.roi != null && s.roi < -0.10 && s.settled >= 5) leaks.push({ kind: 'sport', key: s.sport, roi: s.roi, n: s.settled });
  for (const b of byBucket) if (b.roi != null && b.roi < -0.10 && b.settled >= 5) leaks.push({ kind: 'bucket', key: b.bucket, roi: b.roi, n: b.settled });
  for (const m of byMarket) if (m.roi != null && m.roi < -0.10 && m.settled >= 5) leaks.push({ kind: 'market', key: m.market, roi: m.roi, n: m.settled });

  return { ok: true, days: daysN, windowCutoff: cutoff, total: agg(rows), bySport, byBucket, byMarket, leaks };
}

// ── Agent: Weekly Review ──
// Ritual semanal de portfólio: cruza ROI Matrix + CLV Decay + auto-shadow status
// e gera vereditos acionáveis (cortar, escalar, observar). Substitui o ritual manual
// "abrir dashboard toda segunda".
async function runWeeklyReview(serverBase) {
  const out = {
    at: Date.now(),
    portfolio: { verdes: [], amarelos: [], vermelhos: [], no_data: [] },
    trends: { clv_subindo: [], clv_caindo: [], clv_estavel: [] },
    auto_shadow_active: [],
    new_data_this_week: [],
    actions: [],
  };

  // 1) ROI matrix 30d (baseline) e 7d (recente, pra detectar shifts)
  const [m30Res, m7Res] = await Promise.allSettled([
    agentHttpGet(`${serverBase}/roi-matrix?days=30`, 15000),
    agentHttpGet(`${serverBase}/roi-matrix?days=7`, 15000),
  ]);
  let matrix30 = null, matrix7 = null;
  try { matrix30 = m30Res.status === 'fulfilled' ? JSON.parse(m30Res.value.body || '{}') : null; } catch (_) {}
  try { matrix7 = m7Res.status === 'fulfilled' ? JSON.parse(m7Res.value.body || '{}') : null; } catch (_) {}
  if (!matrix30?.matrix) return { ok: false, error: 'roi-matrix indisponível' };

  const bucketKey = b => `${b.sport}|${b.phase}|${b.tier}`;
  const map7 = new Map();
  if (matrix7?.matrix) for (const b of matrix7.matrix) map7.set(bucketKey(b), b);

  for (const b of matrix30.matrix) {
    const key = bucketKey(b);
    const item = {
      key,
      sport: b.sport, phase: b.phase, tier: b.tier,
      n: b.n, hitRate: b.hitRate, roi: b.roi,
      profit_reais: b.profit_reais,
      clv_avg: b.clv_avg, clv_n: b.clv_n,
      brier: b.brier, avg_ev: b.avg_ev,
      health: b.health,
    };
    if (b.health === 'verde' || b.health === 'verde_sem_clv') out.portfolio.verdes.push(item);
    else if (b.health === 'vermelho' || b.health === 'vermelho_sem_clv') out.portfolio.vermelhos.push(item);
    else if (b.health === 'amarelo' || b.health === 'amarelo_sem_clv') out.portfolio.amarelos.push(item);
    else out.portfolio.no_data.push(item);

    // Buckets que ganharam tips na última semana — sinaliza atividade
    const recent = map7.get(key);
    if (recent && recent.n >= 5) out.new_data_this_week.push({ key, n_7d: recent.n, roi_7d: recent.roi, clv_7d: recent.clv_avg });
  }

  // 2) CLV decay por sport (detecta tendência)
  const sports = [...new Set(matrix30.matrix.map(b => b.sport))];
  const clvByDay = {};
  await Promise.all(sports.map(async sport => {
    try {
      const r = await agentHttpGet(`${serverBase}/clv-decay?sport=${encodeURIComponent(sport)}&days=30`, 12000);
      const data = r?.body ? JSON.parse(r.body) : null;
      if (data?.rolling7?.length >= 14) clvByDay[sport] = data;
    } catch (_) {}
  }));

  for (const [sport, data] of Object.entries(clvByDay)) {
    const series = data.rolling7.filter(s => s.rolling7_clv != null);
    if (series.length < 7) continue;
    const recent = series.slice(-7);
    const prior = series.slice(-14, -7);
    if (!recent.length || !prior.length) continue;
    const avgRecent = recent.reduce((a, s) => a + s.rolling7_clv, 0) / recent.length;
    const avgPrior = prior.reduce((a, s) => a + s.rolling7_clv, 0) / prior.length;
    const delta = avgRecent - avgPrior;
    const summary = { sport, clv_recent: parseFloat(avgRecent.toFixed(2)), clv_prior: parseFloat(avgPrior.toFixed(2)), delta: parseFloat(delta.toFixed(2)) };
    if (delta > 0.5) out.trends.clv_subindo.push(summary);
    else if (delta < -0.5) out.trends.clv_caindo.push(summary);
    else out.trends.clv_estavel.push(summary);
  }

  // 3) Auto-shadow: detecta no log buffer flips recentes
  const buffer = getClassifiedBuffer();
  const recentLogs = buffer.slice(-2000);
  const flipLogs = recentLogs.filter(e => /AUTO-SHADOW.*FLIP→SHADOW/i.test(e.text || ''));
  for (const fl of flipLogs.slice(-10)) {
    const m = (fl.text || '').match(/AUTO-SHADOW.*FLIP.*?(\w+):/i);
    out.auto_shadow_active.push({
      sport: m ? m[1] : '?',
      at: fl.t,
      text: (fl.text || '').slice(0, 200),
    });
  }

  // 4) Vereditos acionáveis
  // Vermelho com n≥30 e CLV negativo: cut candidate
  for (const b of out.portfolio.vermelhos) {
    if (b.n >= 30 && b.clv_avg != null && b.clv_avg < -1) {
      out.actions.push({
        priority: 'HIGH',
        action: 'CUT',
        target: b.key,
        reason: `n=${b.n} | ROI ${b.roi}% | CLV ${b.clv_avg}% (n=${b.clv_n}). Mercado nos bate há semanas.`,
        suggestion: `Setar shadow no .env: ${b.sport.toUpperCase()}_SHADOW=true`,
      });
    } else if (b.n >= 10 && b.n < 30) {
      out.actions.push({
        priority: 'MED',
        action: 'WATCH',
        target: b.key,
        reason: `n=${b.n} (small sample). Aguardar n>=30 antes de cortar.`,
      });
    }
  }
  // Verde com n≥30 e CLV positivo: scale candidate
  for (const b of out.portfolio.verdes) {
    if (b.n >= 30 && b.clv_avg != null && b.clv_avg > 1) {
      out.actions.push({
        priority: 'HIGH',
        action: 'SCALE',
        target: b.key,
        reason: `n=${b.n} | ROI +${b.roi}% | CLV +${b.clv_avg}% (n=${b.clv_n}). Edge sustentado.`,
        suggestion: `Aumentar Kelly fraction ou poll interval pra esse bucket.`,
      });
    }
  }
  // CLV cai >1pp em 7d: alerta antes de virar vermelho
  for (const t of out.trends.clv_caindo) {
    if (t.delta < -1.0) {
      out.actions.push({
        priority: 'MED',
        action: 'ALERT',
        target: `${t.sport} (CLV decay)`,
        reason: `CLV rolling 7d caiu de ${t.clv_prior}% pra ${t.clv_recent}% (Δ ${t.delta}pp). Edge degradando.`,
      });
    }
  }
  // CLV sobe forte: oportunidade
  for (const t of out.trends.clv_subindo) {
    if (t.delta > 1.5) {
      out.actions.push({
        priority: 'INFO',
        action: 'EXPLORE',
        target: `${t.sport} (CLV improving)`,
        reason: `CLV rolling 7d subiu de ${t.clv_prior}% pra ${t.clv_recent}% (Δ +${t.delta}pp). Modelo melhorando ou mercado cedendo.`,
      });
    }
  }
  // Sem dados após 14d: liga inativa ou volume muito baixo
  for (const b of out.portfolio.no_data) {
    if (b.n === 0) continue;
    out.actions.push({
      priority: 'LOW',
      action: 'NO_DATA',
      target: b.key,
      reason: `Apenas n=${b.n} em 30d. Volume baixo demais pra decidir.`,
    });
  }
  // Sort by priority
  const prioOrder = { HIGH: 0, MED: 1, INFO: 2, LOW: 3 };
  out.actions.sort((a, b) => (prioOrder[a.priority] || 9) - (prioOrder[b.priority] || 9));

  // Resumo executivo
  out.summary = {
    total_buckets: matrix30.matrix.length,
    verdes: out.portfolio.verdes.length,
    amarelos: out.portfolio.amarelos.length,
    vermelhos: out.portfolio.vermelhos.length,
    no_data: out.portfolio.no_data.length,
    cuts_recommended: out.actions.filter(a => a.action === 'CUT').length,
    scales_recommended: out.actions.filter(a => a.action === 'SCALE').length,
    auto_shadowed: out.auto_shadow_active.length,
    clv_subindo: out.trends.clv_subindo.length,
    clv_caindo: out.trends.clv_caindo.length,
  };
  out.ok = true;
  return out;
}

// ── Agent: Health Sentinel ──
// Detecta anomalias passivas no sistema: loops travados, polls silenciosos,
// caches vazios inesperadamente, endpoints degradados, settlements parados.
// Output usado pelo Auto-Healer pra decidir quais fixes aplicar.
async function runHealthSentinel(serverBase, db) {
  const out = { at: Date.now(), anomalies: [], healthy: [], summary: {} };
  const buffer = getClassifiedBuffer();
  const recent = buffer.slice(-3000);
  const now = Date.now();

  // Helper: pega último log que match regex
  const lastLog = (re) => {
    for (let i = recent.length - 1; i >= 0; i--) {
      if (re.test(recent[i].text || '')) return recent[i];
    }
    return null;
  };

  // 1) MUTEX STALE — runAutoAnalysis travado >5min E log fresco (<2min).
  // Janela curta evita falso positivo: se log é antigo, mutex provavelmente já liberou
  // (auto-healer faria skip com "não está locked", gerando alerta confuso).
  const mutexLog = lastLog(/Análise anterior ainda em curso \((\d+)s\)/);
  if (mutexLog) {
    const m = (mutexLog.text || '').match(/em curso \((\d+)s\)/);
    const ageS = m ? parseInt(m[1], 10) : 0;
    const sinceLog = (now - mutexLog.t) / 1000;
    if (ageS > 300 && sinceLog < 120) {
      out.anomalies.push({
        id: 'mutex_stale',
        severity: 'critical',
        detail: `runAutoAnalysis travado há ${ageS}s (limite stale 900s)`,
        at: mutexLog.t,
        actionable: true,
      });
    }
  }

  // 2) POLL SILENT — usa heartbeats diretos (markPollHeartbeat) em vez de grep no log buffer.
  // Buffer evicta logs antigos quando sistema busy → falso positivo crônico.
  // Heartbeat in-memory é confiável.
  const { getPollHeartbeats } = require('./utils');
  const heartbeats = getPollHeartbeats();
  const POLL_THRESHOLDS = {
    lol:      { intervalLive: 300000, intervalIdle: 600000 },
    dota:     { intervalLive: 180000, intervalIdle: 900000 },
    cs:       { intervalLive: 180000, intervalIdle: 600000 },
    valorant: { intervalLive: 180000, intervalIdle: 600000 },
    tennis:   { intervalLive: 600000, intervalIdle: 1800000 },
    mma:      { intervalLive: 600000, intervalIdle: 1800000 },
    darts:    { intervalLive: 240000, intervalIdle: 1200000 },
    snooker:  { intervalLive: 240000, intervalIdle: 1200000 },
    tt:       { intervalLive: 600000, intervalIdle: 1800000 },
    football: { intervalLive: 600000, intervalIdle: 1800000 },
  };
  // Boot grace: durante 10min após boot, polls podem não ter rodado ainda — não flagga.
  // Heurística: se NENHUM heartbeat existe, sistema acabou de subir.
  const anyHeartbeat = Object.values(heartbeats).some(h => h?.lastTs);
  const oldestHeartbeat = anyHeartbeat ? Math.min(...Object.values(heartbeats).map(h => h.lastTs).filter(Boolean)) : 0;
  const bootGraceMs = 10 * 60 * 1000;
  for (const [sport, thr] of Object.entries(POLL_THRESHOLDS)) {
    const id = `poll_silent_${sport}`;
    const hb = heartbeats[sport];
    if (!hb || !hb.lastTs) {
      // Sem heartbeat: só flagga se sistema já tem outros polls rodando há tempo (>boot grace)
      if (anyHeartbeat && (now - oldestHeartbeat) > bootGraceMs) {
        out.anomalies.push({
          id, severity: 'warning',
          detail: `poll ${sport} nunca executou (boot há ${Math.round((now - oldestHeartbeat)/60000)}min)`,
          actionable: true,
        });
      }
      continue;
    }
    const ageMs = now - hb.lastTs;
    const threshold = (hb.hadLive ? thr.intervalLive : thr.intervalIdle) * 3;
    if (ageMs > threshold) {
      out.anomalies.push({
        id, severity: ageMs > threshold * 2 ? 'critical' : 'warning',
        detail: `poll ${sport} sem heartbeat há ${Math.round(ageMs / 60000)}min (threshold ${Math.round(threshold / 60000)}min, mode=${hb.hadLive ? 'live' : 'idle'})`,
        at: hb.lastTs, last_count: hb.count,
        actionable: true,
      });
    } else {
      out.healthy.push({ id, ageMin: Math.round(ageMs / 60000), count: hb.count, mode: hb.hadLive ? 'live' : 'idle' });
    }
  }

  // 3) ENDPOINTS LENTOS — testa /lol-matches, /dota-matches, /odds (baseline ~300ms)
  const ENDPOINT_BASELINE_MS = 800;
  const endpoints = ['/lol-matches', '/dota-matches', '/valorant-matches', '/cs-matches'];
  for (const ep of endpoints) {
    const r = await agentHttpGet(`${serverBase}${ep}`, 8000).catch(() => null);
    if (!r || r.status !== 200) {
      out.anomalies.push({
        id: `endpoint_down_${ep.replace(/[^a-z]/g, '')}`, severity: 'critical',
        detail: `${ep} HTTP ${r?.status || 'timeout'}`, actionable: false,
      });
    } else if (r.latency > ENDPOINT_BASELINE_MS) {
      out.anomalies.push({
        id: `endpoint_slow_${ep.replace(/[^a-z]/g, '')}`, severity: 'warning',
        detail: `${ep} latency ${r.latency}ms (>${ENDPOINT_BASELINE_MS}ms baseline)`,
        actionable: false,
      });
    }
  }

  // 4) DB LOCKED — múltiplos SQLITE_BUSY em 5min
  const dbLockCount = recent.filter(l => /SQLITE_BUSY|database is locked/i.test(l.text || '') && (now - l.t) < 5 * 60 * 1000).length;
  if (dbLockCount >= 3) {
    out.anomalies.push({
      id: 'db_locked_repeated', severity: 'critical',
      detail: `${dbLockCount} SQLITE_BUSY nos últimos 5min`,
      actionable: false,
    });
  }

  // 5) AI BACKOFF LONGO — DeepSeek backoff ativo >2h
  const backoffLog = lastLog(/DeepSeek 429: backoff (\d+)min ativado/);
  if (backoffLog) {
    const m = (backoffLog.text || '').match(/backoff (\d+)min/);
    const minutes = m ? parseInt(m[1], 10) : 0;
    const expiresAt = backoffLog.t + (minutes * 60 * 1000);
    if (now < expiresAt && (expiresAt - now) > 2 * 60 * 60 * 1000) {
      out.anomalies.push({
        id: 'ai_backoff_long', severity: 'warning',
        detail: `DeepSeek backoff ativo há ${Math.round((now - backoffLog.t) / 60000)}min (expira em ${Math.round((expiresAt - now) / 60000)}min)`,
        at: backoffLog.t, actionable: true,
      });
    }
  }

  // 6) TIP RATE CAIU — sport com >5 tips/dia historico, agora 0 nas últimas 24h
  if (db) {
    try {
      const recent24h = db.prepare(`
        SELECT sport, COUNT(*) as n FROM tips
        WHERE sent_at >= datetime('now', '-1 day')
          AND (archived IS NULL OR archived = 0)
        GROUP BY sport
      `).all();
      const baseline = db.prepare(`
        SELECT sport, COUNT(*) * 1.0 / 14 as daily_avg FROM tips
        WHERE sent_at BETWEEN datetime('now', '-15 days') AND datetime('now', '-1 day')
          AND (archived IS NULL OR archived = 0)
        GROUP BY sport
      `).all();
      const recentMap = new Map(recent24h.map(r => [r.sport, r.n]));
      for (const b of baseline) {
        if (b.daily_avg < 1) continue;
        const recentN = recentMap.get(b.sport) || 0;
        if (recentN === 0 && b.daily_avg >= 1) {
          out.anomalies.push({
            id: `tip_rate_zero_${b.sport}`, severity: 'warning',
            detail: `${b.sport}: 0 tips em 24h (baseline ${b.daily_avg.toFixed(1)}/dia em 14d)`,
            actionable: false,
          });
        }
      }
    } catch (_) {}
  }

  // 7) SETTLEMENT PARADO — tips com result=NULL há >48h.
  // Threshold maior (48h vs 24h) e count maior (5 vs 3) — alguns sports tem matches
  // multi-dia (MMA cards, tennis Slams) onde 24h é cedo demais pra settlement.
  if (db) {
    try {
      const stale = db.prepare(`
        SELECT sport, COUNT(*) as n FROM tips
        WHERE result IS NULL
          AND sent_at < datetime('now', '-48 hours')
          AND (archived IS NULL OR archived = 0)
        GROUP BY sport
      `).all();
      for (const s of stale) {
        if (s.n >= 5) {
          out.anomalies.push({
            id: `settlement_stale_${s.sport}`, severity: 'warning',
            detail: `${s.sport}: ${s.n} tips pending há >48h (settlement não pegou)`,
            actionable: false,
          });
        }
      }
    } catch (_) {}
  }

  out.summary = {
    total_anomalies: out.anomalies.length,
    critical: out.anomalies.filter(a => a.severity === 'critical').length,
    warning: out.anomalies.filter(a => a.severity === 'warning').length,
    actionable: out.anomalies.filter(a => a.actionable).length,
    healthy_checks: out.healthy.length,
  };
  out.ok = true;
  return out;
}

module.exports = {
  classify, getClassifiedBuffer,
  computeStatus, extractTips, extractLiveMatches,
  runLiveScout, runFeedMedic, runRoiAnalyst,
  runWeeklyReview, runHealthSentinel,
};
