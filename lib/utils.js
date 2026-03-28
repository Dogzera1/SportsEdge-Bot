const https = require('https');
const http = require('http');

function log(level, tag, msg, data) {
  const ts = new Date().toISOString().slice(11, 19);
  const line = `[${ts}] [${level}] [${tag}] ${msg}`;
  console.log(line, data !== undefined ? (typeof data === 'object' ? JSON.stringify(data) : data) : '');
}

function calcKelly(evStr, oddsStr) {
  const ev = parseFloat(String(evStr).replace('%', '').replace('+', '')) / 100;
  const odds = parseFloat(String(oddsStr).replace(',', '.'));
  if (!ev || ev <= 0 || !odds || odds <= 1) return '1u';
  const f_quarter = (ev / (odds - 1)) * 0.25;
  const stake = Math.max(0.5, Math.min(4, Math.round(f_quarter * 100 * 2) / 2));
  return `${stake}u`;
}

function norm(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function httpGet(targetUrl, headers = {}, _redirects = 0) {
  return new Promise((resolve, reject) => {
    const p = require('url').parse(targetUrl);
    const mod = p.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: p.hostname,
      path: p.path,
      method: 'GET',
      headers: { 'Accept': 'text/html,application/json', 'User-Agent': 'Mozilla/5.0', ...headers }
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && _redirects < 5) {
        const loc = res.headers.location;
        const next = loc.startsWith('http') ? loc : `${p.protocol}//${p.hostname}${loc}`;
        res.resume();
        resolve(httpGet(next, headers, _redirects + 1));
        return;
      }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Timeout')));
    req.end();
  });
}

function httpsPost(targetUrl, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const p = require('url').parse(targetUrl);
    const s = typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request({
      hostname: p.hostname,
      path: p.path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s), ...headers }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.write(s);
    req.end();
  });
}

function safeParse(str, fallback) {
  try { return JSON.parse(str); } catch(_) { return fallback; }
}

function sendJson(res, data, status) {
  res.writeHead(status || 200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
}

function fmtDate(s) {
  if (!s) return '—';
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch(_) { return s; }
}

function fmtDateTime(s) {
  if (!s) return '—';
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch(_) { return s; }
}

function fuzzyName(a, b) {
  const n = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const na = n(a), nb = n(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 3 && (na.includes(nb) || nb.includes(na))) return true;
  const al = String(a).trim().split(/\s+/).pop();
  const bl = String(b).trim().split(/\s+/).pop();
  return n(al).length >= 4 && n(al) === n(bl);
}

// ── The Odds API monthly budget tracker (shared across server + scrapers) ──
const ODDS_MONTHLY_BUDGET = 450; // 500 free tier - 50 buffer
let _oddsReqCount = 0;
let _oddsReqMonth = new Date().getMonth();

function oddsApiAllowed(tag) {
  const now = new Date();
  if (now.getMonth() !== _oddsReqMonth) { _oddsReqCount = 0; _oddsReqMonth = now.getMonth(); }
  if (_oddsReqCount >= ODDS_MONTHLY_BUDGET) {
    log('WARN', tag || 'ODDS', `Limite mensal atingido (${_oddsReqCount}/${ODDS_MONTHLY_BUDGET}). Usando cache.`);
    return false;
  }
  _oddsReqCount++;
  if (_oddsReqCount % 10 === 0 || _oddsReqCount >= ODDS_MONTHLY_BUDGET - 50) {
    log('INFO', tag || 'ODDS', `Quota The Odds API: ${_oddsReqCount}/${ODDS_MONTHLY_BUDGET} no mês`);
  }
  return true;
}

module.exports = { log, calcKelly, norm, httpGet, httpsPost, safeParse, sendJson, fmtDate, fmtDateTime, fuzzyName, oddsApiAllowed };