const https = require('https');
const http = require('http');

function log(level, tag, msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${level}] [${tag}] ${msg}`);
}

function norm(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function safeParse(str, fallback) {
  try { return JSON.parse(str); } catch (_) { return fallback; }
}

function sendJson(res, data, status) {
  res.writeHead(status || 200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
}

function httpGet(targetUrl, headers = {}, _redirects = 0) {
  return new Promise((resolve, reject) => {
    const p = require('url').parse(targetUrl);
    const mod = p.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: p.hostname,
      path: p.path,
      method: 'GET',
      headers: { 'Accept': 'application/json', 'User-Agent': 'FinanceEdge/1.0', ...headers }
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

function fmtDateTime(s) {
  if (!s) return '—';
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch (_) { return s; }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { log, norm, safeParse, sendJson, httpGet, httpsPost, fmtDateTime, sleep };
