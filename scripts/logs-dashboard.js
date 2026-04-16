#!/usr/bin/env node
/**
 * logs-dashboard.js — Dashboard local para visualizar logs do Railway em tempo real.
 *
 * Uso:
 *   node scripts/logs-dashboard.js [--port 7777] [--service NOME] [--buffer 5000]
 *
 * Requer: `railway login` + `railway link` no diretório do projeto.
 *
 * Endpoints:
 *   GET /            → UI HTML (public/logs.html)
 *   GET /stream      → SSE com novas linhas em tempo real
 *   GET /history     → buffer atual (últimas N linhas) em JSON
 *   GET /restart     → reinicia o subprocesso railway logs
 *   GET /health      → status do subprocesso
 */

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const PORT = parseInt(arg('--port', '7777'), 10);
const SERVICE = arg('--service', null);
const BUFFER_MAX = parseInt(arg('--buffer', '5000'), 10);

const buffer = [];
const clients = new Set();
let child = null;
let childStartedAt = null;
let lastError = null;
let lastLineAt = Date.now();
const STALE_THRESHOLD_MS = parseInt(process.env.STALE_THRESHOLD_MS || String(2 * 60 * 1000), 10); // 2min sem log = morto

function classify(line) {
  const l = String(line || '');
  const lc = l.toLowerCase();
  let level = 'info';
  if (/\b(error|erro|fatal|panic|exception)\b/i.test(l)) level = 'error';
  else if (/\bwarn(ing)?\b/i.test(l)) level = 'warn';
  else if (/\bdebug\b/i.test(l)) level = 'debug';

  let bot = 'system';
  if (/\b(lol|riot|league|lck|lcs|lec|lpl|lcp|esports)\b/i.test(l)) bot = 'lol';
  if (/\bdota\b/i.test(l) || /opendota|steam.?rt|radiant|dire/i.test(l)) bot = 'dota';
  if (/\b(cs2|cs:?go|counter.?strike|hltv)\b/i.test(l) || /\bAUTO-CS\b/.test(l) || /\[CS\]/.test(l)) bot = 'cs';
  if (/\btennis|tenis\b/i.test(l) && !/table.?tennis|tabletennis|tenis.?de.?mesa/i.test(lc)) bot = 'tennis';
  if (/table.?tennis|tabletennis|tenis.?de.?mesa|tt.?match/i.test(lc)) bot = 'tabletennis';
  if (/\bmma|ufc|pfl|bellator|rizin|cagewarriors\b/i.test(l)) bot = 'mma';
  if (/\bsnooker|cuetracker\b/i.test(l)) bot = 'snooker';
  if (/\bdarts?\b/i.test(l)) bot = 'darts';

  let kind = null;
  if (/\bTIP\b|\bAUTO-(LOL|DOTA|TENIS|MMA|DARTS|SNOOKER|TT|CS)\b|envia(da|ndo)/i.test(l)) kind = 'tip';
  if (/livestats|live.?stats|streamlist|window\//i.test(lc)) kind = 'stats';
  if (/calibrat/i.test(lc)) kind = 'calibration';

  // Live match signal — prioridade visual no dashboard
  const isLive = /\bLIVE\b|\bao vivo\b|hasLiveStats=true|state=in_game|isLive:?\s*1|Scorebot|"live":\s*true|\blive PS\b/i.test(l);

  return { level, bot, kind, isLive };
}

function pushLine(raw) {
  const text = String(raw || '').replace(/\r$/, '');
  if (!text.trim()) return;
  const meta = classify(text);
  const entry = {
    t: Date.now(),
    text,
    ...meta,
  };
  buffer.push(entry);
  if (buffer.length > BUFFER_MAX) buffer.splice(0, buffer.length - BUFFER_MAX);
  lastLineAt = Date.now();
  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch (_) { /* ignore */ }
  }
}

function startChild() {
  if (child) {
    try { child.kill(); } catch (_) {}
    child = null;
  }
  const args = ['logs'];
  if (SERVICE) args.push('--service', SERVICE);
  pushLine(`[dashboard] starting: railway ${args.join(' ')}`);
  childStartedAt = Date.now();
  lastError = null;
  try {
    child = spawn('railway', args, { shell: true });
  } catch (e) {
    lastError = String(e?.message || e);
    pushLine(`[dashboard] spawn failed: ${lastError}`);
    return;
  }

  let stdoutBuf = '';
  let stderrBuf = '';
  child.stdout.on('data', d => {
    stdoutBuf += d.toString('utf8');
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() || '';
    for (const ln of lines) pushLine(ln);
  });
  child.stderr.on('data', d => {
    stderrBuf += d.toString('utf8');
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop() || '';
    for (const ln of lines) pushLine(`[stderr] ${ln}`);
  });
  child.on('exit', (code) => {
    pushLine(`[dashboard] railway logs exited code=${code}. Reiniciando em 3s...`);
    child = null;
    setTimeout(startChild, 3000);
  });
  child.on('error', (e) => {
    lastError = String(e?.message || e);
    pushLine(`[dashboard] child error: ${lastError}`);
  });
}

// ─────────────────────────────────────────────────────────
// Status compute — converte buffer em saúde por bot
// ─────────────────────────────────────────────────────────
const SPORTS = [
  { bot: 'lol',         label: 'League of Legends', emoji: '🟦', windowMin: 5,  cycleEverySec: 90 },
  { bot: 'dota',        label: 'Dota 2',            emoji: '🟥', windowMin: 12, cycleEverySec: 360 },
  { bot: 'cs',          label: 'Counter-Strike 2',  emoji: '🔫', windowMin: 12, cycleEverySec: 360 },
  { bot: 'tennis',      label: 'Tênis',             emoji: '🎾', windowMin: 12, cycleEverySec: 300 },
  { bot: 'tabletennis', label: 'Tênis de Mesa',     emoji: '🏓', windowMin: 15, cycleEverySec: 600 },
  { bot: 'mma',         label: 'MMA / Boxe',        emoji: '🥊', windowMin: 12, cycleEverySec: 360 },
  { bot: 'snooker',     label: 'Snooker',           emoji: '🎱', windowMin: 30, cycleEverySec: 1800 },
  { bot: 'darts',       label: 'Darts',             emoji: '🎯', windowMin: 30, cycleEverySec: 1800 },
];

function lineHas(text, re) { return re.test(text); }

function fmtAgo(ms) {
  if (ms == null) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s atrás`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min atrás`;
  return `${Math.floor(m / 60)}h${m % 60}min atrás`;
}

function statusForSport(cfg) {
  const now = Date.now();
  const cutoff = now - cfg.windowMin * 60 * 1000;
  const window = buffer.filter(e => e.bot === cfg.bot && e.t >= cutoff);
  const all = buffer.filter(e => e.bot === cfg.bot);
  const last = all[all.length - 1];

  // métricas comuns
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

  // ─── LoL ───
  if (cfg.bot === 'lol') {
    const liveStatsLines = window.filter(e => /LIVE-STATS.*LoL/i.test(e.text));
    const liveStatsOk = liveStatsLines.filter(e => /hasLiveStats=true/i.test(e.text));
    const liveStatsAttempts = liveStatsLines.length;
    m.liveStatsOk = liveStatsOk.length;
    m.liveStatsAttempts = liveStatsAttempts;
    const lolMatches = window.filter(e => /\/lol-matches fonte=/i.test(e.text));
    m.lolMatches = lolMatches.length;

    if (lolMatches.length === 0) { issues.push('Sem ciclos /lol-matches na janela'); level = 'error'; }
    if (liveStatsAttempts > 0 && liveStatsOk.length === 0) {
      issues.push('Tentou pegar live stats mas nenhuma partida retornou hasLiveStats=true');
      if (level === 'ok') level = 'warn';
    }
    summary = liveStatsOk.length > 0
      ? `${liveStatsOk.length}/${liveStatsAttempts} partidas com live stats · ${lolMatches.length} ciclos · ${tipsSent} tips · ${noTip} sem-edge`
      : `${lolMatches.length} ciclos · ${liveStatsAttempts} consultas live · ${tipsSent} tips · ${noTip} sem-edge`;
  }

  // ─── CS2 ───
  else if (cfg.bot === 'cs') {
    const cyc = window.filter(e => /AUTO-CS|\/cs-matches|Pinnacle CS2/i.test(e.text));
    const lastCount = window.map(e => e.text.match(/\/cs-matches: (\d+) total/)).filter(Boolean).pop();
    m.cycles = cyc.length;
    m.matches = lastCount ? +lastCount[1] : 0;
    if (cyc.length === 0) { issues.push('Sem ciclos AUTO-CS / sem requests /cs-matches na janela'); level = 'warn'; }
    summary = `${cyc.length} ciclos · ${m.matches} partidas · ${tipsSent} tips (shadow)`;
  }

  // ─── Dota ───
  else if (cfg.bot === 'dota') {
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
  }

  // ─── Tennis ───
  else if (cfg.bot === 'tennis') {
    const cyc = window.filter(e => /AUTO-TENIS|\/tennis-matches|tennis|tenis/i.test(e.text));
    m.cycles = cyc.length;
    if (cyc.length === 0) { issues.push('Sem atividade do bot de tênis na janela'); level = 'warn'; }
    summary = `${cyc.length} eventos · ${tipsSent} tips · ${noTip} sem-edge`;
  }

  // ─── MMA ───
  else if (cfg.bot === 'mma') {
    const cyc = window.filter(e => /AUTO-MMA Iniciando/i.test(e.text));
    const lastFights = window.map(e => e.text.match(/(\d+) lutas com odds.*MMA: (\d+) \| Boxe: (\d+)/)).filter(Boolean).pop();
    const espn = window.find(e => /ESPN: \d+ lutas/i.test(e.text));
    m.cycles = cyc.length;
    m.fights = lastFights ? +lastFights[1] : 0;
    m.espn = espn ? +(espn.text.match(/ESPN: (\d+)/)?.[1] || 0) : 0;
    if (cyc.length === 0) { issues.push('Sem ciclos AUTO-MMA na janela'); level = 'error'; }
    if (m.espn === 0 && cyc.length > 0) { issues.push('ESPN retornou 0 lutas (enriquecimento degradado)'); if (level === 'ok') level = 'warn'; }
    summary = `${cyc.length} ciclos · ${m.fights} lutas (MMA+Boxe) · ESPN ${m.espn} · ${tipsSent} tips`;
  }

  // ─── TT ───
  else if (cfg.bot === 'tabletennis') {
    const cyc = window.filter(e => /AUTO-TT|tabletennis|tenis.?de.?mesa/i.test(e.text));
    const matchesLine = window.map(e => e.text.match(/(\d+) partidas TT com odds/)).filter(Boolean).pop();
    m.cycles = cyc.length;
    m.matches = matchesLine ? +matchesLine[1] : 0;
    if (cyc.length === 0) { issues.push('Sem ciclos AUTO-TT na janela'); level = 'warn'; }
    summary = `${cyc.length} eventos · ${m.matches} partidas com odds · ${tipsSent} tips (shadow)`;
  }

  // ─── Snooker / Darts ───
  else {
    if (window.length === 0) { issues.push(`Nenhuma atividade na janela (${cfg.windowMin} min)`); level = 'warn'; }
    summary = `${window.length} eventos · ${tipsSent} tips · ${errors} erros`;
  }

  // erros sempre escalam
  if (errors > 0) {
    issues.unshift(`${errors} erro(s) na janela`);
    level = 'error';
  }

  // staleness
  const lastCycleEntry = [...window].reverse().find(e => /AUTO-|fonte=arush|matches:|matches ?\(/i.test(e.text)) || last;
  const lastAge = lastCycleEntry ? now - lastCycleEntry.t : null;
  if (lastAge != null && lastAge > cfg.cycleEverySec * 1000 * 3) {
    issues.push(`Última atividade há ${fmtAgo(lastAge)} (esperado a cada ~${Math.round(cfg.cycleEverySec/60)}min)`);
    if (level === 'ok') level = 'warn';
  }

  m.liveActivity = liveActivity;
  return {
    bot: cfg.bot,
    label: cfg.label,
    emoji: cfg.emoji,
    windowMin: cfg.windowMin,
    status: level,
    summary: summary || 'Sem dados',
    issues,
    metrics: m,
    hasLive: liveActivity > 0,
    liveCount: liveActivity,
    lastActivity: last?.t || null,
    lastActivityAgo: last ? fmtAgo(now - last.t) : '—',
  };
}

function extractTips(limit = 60) {
  const sent = [];
  const denied = [];
  for (const e of buffer) {
    const t = e.text;
    const isLive = !!e.isLive;
    if (/Tip enviada/i.test(t)) {
      sent.push({ t: e.t, bot: e.bot, isLive, text: t.replace(/^.*?Tip enviada:?\s*/i, '').trim() });
    } else if (/\bSem tip:/i.test(t)) {
      denied.push({ t: e.t, bot: e.bot, isLive, reason: 'sem-edge', text: t.replace(/^.*?Sem tip:\s*/i, '').trim() });
    } else if (/Tip bloqueada/i.test(t)) {
      denied.push({ t: e.t, bot: e.bot, isLive, reason: 'gate', text: t.replace(/^.*?Tip bloqueada:?\s*/i, '').trim() });
    } else if (/Gate sem-dados/i.test(t)) {
      denied.push({ t: e.t, bot: e.bot, isLive, reason: 'sem-dados', text: t.replace(/^.*?Gate sem-dados:\s*/i, '').trim() });
    } else if (/\[RISK\].*?bloqueada/i.test(t) || /RISK.*?: bloqueada/i.test(t)) {
      denied.push({ t: e.t, bot: e.bot, isLive, reason: 'risk', text: t.replace(/^.*?bloqueada\s*/i, 'bloqueada ').trim() });
    } else if (/\[AUTO\].*?BAIXA.*?(rejeit|bloque)/i.test(t)) {
      denied.push({ t: e.t, bot: e.bot, isLive, reason: 'baixa-gate', text: t.replace(/^.*?\[AUTO\]\s*/i, '').trim() });
    }
  }
  // Prioriza live em cima, depois por tempo desc
  const sortLivePriority = (a, b) => {
    if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
    return b.t - a.t;
  };
  return {
    sent: sent.slice(-limit).sort(sortLivePriority),
    denied: denied.slice(-limit).sort(sortLivePriority),
    countsTotal: {
      sent: sent.length,
      sentLive: sent.filter(x => x.isLive).length,
      denied: denied.length,
      deniedLive: denied.filter(x => x.isLive).length,
    },
  };
}

function computeStatus() {
  const now = Date.now();
  const sports = SPORTS.map(statusForSport).sort((a, b) => {
    // live primeiro, depois error/warn, depois ok
    if (a.hasLive !== b.hasLive) return a.hasLive ? -1 : 1;
    const rank = { error: 0, warn: 1, ok: 2 };
    return (rank[a.status] ?? 3) - (rank[b.status] ?? 3);
  });
  const overall = sports.some(s => s.status === 'error') ? 'error'
                : sports.some(s => s.status === 'warn')  ? 'warn'
                : 'ok';
  return {
    now,
    nowIso: new Date(now).toISOString(),
    subprocess: { running: !!child, startedAt: childStartedAt, bufferSize: buffer.length, lastError },
    overall,
    sports,
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/' || url.pathname === '/logs.html') {
    const file = path.join(__dirname, '..', 'public', 'logs.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(500); return res.end('logs.html not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      running: !!child,
      startedAt: childStartedAt,
      bufferSize: buffer.length,
      clients: clients.size,
      service: SERVICE,
      lastError,
    }));
  }
  if (url.pathname === '/history') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(buffer));
  }
  if (url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(computeStatus()));
  }
  if (url.pathname === '/tips') {
    const limit = parseInt(url.searchParams.get('limit') || '60', 10);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(extractTips(limit)));
  }
  if (url.pathname === '/restart') {
    startChild();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (url.pathname === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(':ok\n\n');
    clients.add(res);
    const ka = setInterval(() => { try { res.write(':ka\n\n'); } catch (_) {} }, 15000);
    req.on('close', () => { clearInterval(ka); clients.delete(res); });
    return;
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => {
  console.log(`[logs-dashboard] http://localhost:${PORT}`);
  console.log(`[logs-dashboard] buffer=${BUFFER_MAX} service=${SERVICE || '(default)'} stale_threshold=${STALE_THRESHOLD_MS}ms`);
  startChild();

  // Watchdog: detecta subprocess silent-hung (railway CLI drops stream sem exit event).
  // Se nenhum log chega em STALE_THRESHOLD_MS, força restart.
  setInterval(() => {
    const since = Date.now() - lastLineAt;
    if (since > STALE_THRESHOLD_MS && child) {
      pushLine(`[dashboard] watchdog: sem logs há ${Math.round(since/1000)}s → restart subprocess`);
      lastLineAt = Date.now(); // evita trigger duplo
      startChild();
    }
  }, 30 * 1000);
});
