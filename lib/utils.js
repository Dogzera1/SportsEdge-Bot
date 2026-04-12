const https = require('https');
const http = require('http');

function log(level, tag, msg, data) {
  const ts = new Date().toISOString().slice(11, 19);
  const line = `[${ts}] [${level}] [${tag}] ${msg}`;
  console.log(line, data !== undefined ? (typeof data === 'object' ? JSON.stringify(data) : data) : '');
}

function _envInt(name, def) {
  const v = process.env[name];
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function _isRetryableError(err) {
  const code = err && (err.code || err.errno);
  if (code && ['ECONNRESET', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED'].includes(String(code))) return true;
  const msg = String(err && err.message || '');
  return /timeout|timed out|socket hang up/i.test(msg);
}

function _isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

async function fetchWithRetry(tag, fn, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? _envInt('AI_RETRY_ATTEMPTS', 4);
  const baseDelayMs = opts.baseDelayMs ?? _envInt('AI_RETRY_BASE_DELAY_MS', 500);
  const maxDelayMs = opts.maxDelayMs ?? _envInt('AI_RETRY_MAX_DELAY_MS', 8000);
  const jitter = opts.jitter ?? (process.env.AI_RETRY_JITTER || 'full');

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const r = await fn();
      const st = r && r.status;
      if (!Number.isFinite(st) || !_isRetryableStatus(st) || attempt === maxAttempts) return r;

      const exp = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)));
      const wait = jitter === 'none'
        ? exp
        : jitter === 'equal'
          ? (exp / 2) + Math.floor(Math.random() * (exp / 2))
          : Math.floor(Math.random() * exp); // full jitter
      log('WARN', tag || 'RETRY', `retry status=${st} attempt=${attempt}/${maxAttempts} wait=${wait}ms`);
      await _sleep(wait);
      continue;
    } catch (e) {
      lastErr = e;
      const retryable = _isRetryableError(e);
      if (!retryable || attempt === maxAttempts) throw e;

      const exp = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)));
      const wait = jitter === 'none'
        ? exp
        : jitter === 'equal'
          ? (exp / 2) + Math.floor(Math.random() * (exp / 2))
          : Math.floor(Math.random() * exp);
      log('WARN', tag || 'RETRY', `retry error=${e.code || e.message} attempt=${attempt}/${maxAttempts} wait=${wait}ms`);
      await _sleep(wait);
    }
  }
  if (lastErr) throw lastErr;
}

const _circuitBreakers = new Map();

function _cbDefaultsForProvider(provider) {
  const up = String(provider || '').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  return {
    failureThreshold: _envInt(`AI_CB_${up}_FAILURE_THRESHOLD`, _envInt('AI_CB_FAILURE_THRESHOLD', 5)),
    openMs: _envInt(`AI_CB_${up}_OPEN_MS`, _envInt('AI_CB_OPEN_MS', 2 * 60 * 1000)),
    halfOpenMaxConcurrent: _envInt(`AI_CB_${up}_HALFOPEN_MAX_CONCURRENT`, _envInt('AI_CB_HALFOPEN_MAX_CONCURRENT', 1)),
  };
}

function _getCircuitBreaker(provider) {
  const key = String(provider || 'default');
  if (_circuitBreakers.has(key)) return _circuitBreakers.get(key);

  const cfg = _cbDefaultsForProvider(key);
  const br = {
    provider: key,
    state: 'CLOSED', // CLOSED | OPEN | HALF_OPEN
    failures: 0,
    openUntil: 0,
    halfOpenInFlight: 0,
    cfg
  };
  _circuitBreakers.set(key, br);
  return br;
}

function _cbLogState(br, nextState, why) {
  if (br.state === nextState) return;
  log('WARN', 'AI_CB', `${br.provider} ${br.state} -> ${nextState}${why ? ` (${why})` : ''}`);
}

function _cbAllow(br) {
  const now = Date.now();
  if (br.state === 'OPEN') {
    if (now < br.openUntil) return { ok: false, state: br.state, retryAfterMs: br.openUntil - now };
    _cbLogState(br, 'HALF_OPEN', 'cooldown');
    br.state = 'HALF_OPEN';
    br.halfOpenInFlight = 0;
  }
  if (br.state === 'HALF_OPEN') {
    if (br.halfOpenInFlight >= br.cfg.halfOpenMaxConcurrent) return { ok: false, state: br.state };
    br.halfOpenInFlight++;
    return { ok: true, state: br.state };
  }
  return { ok: true, state: br.state };
}

function _cbSuccess(br) {
  if (br.state === 'HALF_OPEN') br.halfOpenInFlight = Math.max(0, br.halfOpenInFlight - 1);
  br.failures = 0;
  br.openUntil = 0;
  _cbLogState(br, 'CLOSED', 'success');
  br.state = 'CLOSED';
}

function _cbFailure(br, why) {
  if (br.state === 'HALF_OPEN') br.halfOpenInFlight = Math.max(0, br.halfOpenInFlight - 1);
  br.failures++;
  if (br.failures >= br.cfg.failureThreshold) {
    br.openUntil = Date.now() + br.cfg.openMs;
    _cbLogState(br, 'OPEN', why || `failures=${br.failures}`);
    br.state = 'OPEN';
  }
}

function calcKelly(evStr, oddsStr) {
  return calcKellyFraction(evStr, oddsStr, 0.25);
}

// Versão com fração configurável: 0.25 = ¼ Kelly, ~0.167 = ⅙ Kelly, 0.10 = 1/10 Kelly
function calcKellyFraction(evStr, oddsStr, fraction) {
  const ev = parseFloat(String(evStr).replace('%', '').replace('+', '')) / 100;
  const odds = parseFloat(String(oddsStr).replace(',', '.'));
  if (!ev || ev <= 0 || !odds || odds <= 1) return '0.5u';
  const frac = fraction != null ? fraction : 0.25;
  // Kelly completo: f* = (p*odds - 1) / (odds - 1) = (b*p - q) / b
  // p derivado do EV (aproximação quando p do modelo não está disponível)
  const p = (ev + 1) / odds;
  return _applyKelly(p, odds, frac);
}

// Versão que recebe p diretamente do modelo ML (evita circularidade EV→p→Kelly)
// Usar quando mlResult.modelP1/modelP2 estiver disponível
function calcKellyWithP(pDirect, oddsStr, fraction) {
  const p = parseFloat(pDirect);
  const odds = parseFloat(String(oddsStr).replace(',', '.'));
  if (!p || p <= 0 || p >= 1 || !odds || odds <= 1) return '0.5u';
  const frac = fraction != null ? fraction : 0.25;
  return _applyKelly(p, odds, frac);
}

// Fator de calibração global do Kelly — ajuste fino baseado em ROI histórico
// LOL_KELLY_CAL=0.8 reduz todas as stakes em 20% (conservador após drawdown)
// LOL_KELLY_CAL=1.2 aumenta em 20% (agressivo após ROI positivo confirmado)
const _kellyCal = Math.max(0.3, Math.min(2.0, parseFloat(process.env.LOL_KELLY_CAL ?? '1.0') || 1.0));

function _applyKelly(p, odds, frac) {
  const kellyFull = (p * (odds - 1) - (1 - p)) / (odds - 1);
  // Kelly negativo ou zero = sem value → não apostar
  if (kellyFull <= 0) return '0u';
  const kellyStake = kellyFull * frac * _kellyCal;
  // Max 4u (ALTA ¼ Kelly), 3u (MÉDIA ⅙ Kelly), 1.5u (BAIXA 1/10 Kelly)
  const maxStake = frac >= 0.25 ? 4 : frac >= 0.15 ? 3 : 1.5;
  // Mínimo 0.5u só quando Kelly é positivo
  const stake = Math.max(0.5, Math.min(maxStake, Math.round(kellyStake * 100 * 2) / 2));
  return `${stake}u`;
}

function norm(s) {
  return String(s).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos (á→a, é→e, etc.)
    .replace(/[^a-z0-9]/g, '');
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
    const to = _envInt('HTTP_GET_TIMEOUT_MS', 30000);
    req.setTimeout(to, () => req.destroy(new Error('Timeout')));
    req.end();
  });
}

// ── HTTP cache (TTL + in-flight dedupe) ──
const _httpCache = new Map(); // cacheKey -> { exp, value }
const _httpInFlight = new Map(); // cacheKey -> Promise

const _metricsLite = {
  httpCache: { hits: 0, misses: 0, sets: 0, evictions: 0 },
  http429ByProvider: {}, // provider -> count
  http429LastAt: {}, // provider -> iso
};

function _inc429(provider) {
  const k = String(provider || 'unknown');
  _metricsLite.http429ByProvider[k] = (_metricsLite.http429ByProvider[k] || 0) + 1;
  _metricsLite.http429LastAt[k] = new Date().toISOString();
}

function _hasSensitiveHeader(headers) {
  const h = headers && typeof headers === 'object' ? headers : {};
  const keys = Object.keys(h).map(k => String(k || '').toLowerCase());
  const sensitive = new Set([
    'authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
    'x-claude-key',
    'x-rapidapi-key',
    'x-rapidapi-host',
    'proxy-authorization'
  ]);
  return keys.some(k => sensitive.has(k));
}

function _cacheSweep(maxEntries) {
  if (_httpCache.size <= maxEntries) return;
  const now = Date.now();
  // 1) remove expirados
  for (const [k, v] of _httpCache.entries()) {
    if (!v || v.exp <= now) {
      _httpCache.delete(k);
      _metricsLite.httpCache.evictions++;
    }
  }
  if (_httpCache.size <= maxEntries) return;
  // 2) remove aleatórios (mantém simples)
  const over = _httpCache.size - maxEntries;
  let i = 0;
  for (const k of _httpCache.keys()) {
    _httpCache.delete(k);
    _metricsLite.httpCache.evictions++;
    i++;
    if (i >= over) break;
  }
}

async function cachedHttpGet(targetUrl, opts = {}) {
  const url = String(targetUrl || '');
  const headers = opts.headers || {};
  const provider = opts.provider || opts.tag || 'http';

  // Segurança: não cachear se headers sensíveis (variam por credencial/usuário)
  if (_hasSensitiveHeader(headers)) {
    const r = await httpGet(url, headers);
    if (r && r.status === 429) _inc429(provider);
    return r;
  }

  const ttlMs = Number.isFinite(opts.ttlMs)
    ? opts.ttlMs
    : _envInt('HTTP_CACHE_DEFAULT_TTL_MS', 0);
  const maxEntries = _envInt('HTTP_CACHE_MAX_ENTRIES', 500);

  // TTL 0 -> sem cache persistente, mas ainda dedupe in-flight (simultâneas)
  const cacheKey = String(opts.cacheKey || url);
  const now = Date.now();

  // 1. Check cache persistente
  if (ttlMs > 0) {
    const hit = _httpCache.get(cacheKey);
    if (hit && hit.exp > now) {
      _metricsLite.httpCache.hits++;
      return hit.value;
    }
  }

  // 2. Check in-flight (uma requisição idêntica já está no cabo)
  if (_httpInFlight.has(cacheKey)) {
    log('DEBUG', 'NET', `Deduplicando requisição in-flight: ${cacheKey.slice(0, 100)}...`);
    return _httpInFlight.get(cacheKey);
  }

  _metricsLite.httpCache.misses++;

  const p = (async () => {
    try {
      const r = await httpGet(url, headers);
      if (r && r.status === 429) _inc429(provider);
      if (ttlMs > 0 && r && r.status === 200) {
        _httpCache.set(cacheKey, { exp: now + ttlMs, value: r });
        _metricsLite.httpCache.sets++;
        _cacheSweep(maxEntries);
      }
      return r;
    } finally {
      // Pequeno delay antes de deletar do in-flight para garantir que micro-bursts sequenciais 
      // ainda peguem o resultado do cache no hit persistente logo acima.
      setTimeout(() => _httpInFlight.delete(cacheKey), 1000);
    }
  })();

  _httpInFlight.set(cacheKey, p);
  return p;
}

function httpsPost(targetUrl, body, headers = {}, timeoutMs) {
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
    const to = timeoutMs != null ? timeoutMs : _envInt('AI_HTTP_TIMEOUT_MS', 20000);
    req.setTimeout(to, () => req.destroy(Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' })));
    req.write(s);
    req.end();
  });
}

async function aiPost(provider, targetUrl, body, headers = {}, opts = {}) {
  const br = _getCircuitBreaker(provider);
  const gate = _cbAllow(br);
  if (!gate.ok) {
    const e = new Error(`Circuit breaker ${provider} ${gate.state}`);
    e.status = 503;
    e.code = 'CIRCUIT_OPEN';
    e.provider = provider;
    if (gate.retryAfterMs != null) e.retryAfterMs = gate.retryAfterMs;
    log('WARN', 'AI_CB', `${provider} deny state=${gate.state} retryAfterMs=${gate.retryAfterMs ?? '-'}`);
    throw e;
  }

  try {
    const r = await fetchWithRetry(`AI_${String(provider).toUpperCase()}`, () =>
      httpsPost(targetUrl, body, headers, opts.timeoutMs),
      opts.retry
    );
    if (r && r.status === 429) _inc429(`ai:${provider}`);
    if (r && _isRetryableStatus(r.status)) _cbFailure(br, `status=${r.status}`);
    else _cbSuccess(br);
    return r;
  } catch (e) {
    if (_isRetryableError(e) || _isRetryableStatus(e && e.status)) _cbFailure(br, e.code || e.message);
    else _cbFailure(br, 'error');
    throw e;
  }
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

function fmtDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
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

// ── The Odds API monthly budget (MMA/tênis/futebol) ──
// Padrão 450 ≈ tier free 500 req/mês com margem. Planos pagos: THE_ODDS_MONTHLY_BUDGET=20000 (etc.)
function oddsMonthlyBudget() {
  const raw = process.env.THE_ODDS_MONTHLY_BUDGET || process.env.ODDS_MONTHLY_BUDGET;
  const n = raw != null && String(raw).trim() !== '' ? parseInt(String(raw), 10) : NaN;
  if (Number.isFinite(n) && n >= 1) return Math.min(500000, n);
  return 450;
}

let _oddsReqCount = 0;
let _oddsReqMonthKey = ''; // YYYY-MM para reset correto virada de ano
let _oddsLimitLastLogTs = 0;

function oddsMonthKey(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function oddsApiAllowed(tag) {
  const now = new Date();
  const mk = oddsMonthKey(now);
  if (mk !== _oddsReqMonthKey) { _oddsReqCount = 0; _oddsReqMonthKey = mk; }
  const cap = oddsMonthlyBudget();
  if (_oddsReqCount >= cap) {
    const ts = Date.now();
    if (ts - _oddsLimitLastLogTs > 60 * 1000) {
      _oddsLimitLastLogTs = ts;
      log('WARN', tag || 'ODDS', `Limite mensal atingido (${_oddsReqCount}/${cap}). Usando cache.`);
    }
    return false;
  }
  _oddsReqCount++;
  if (_oddsReqCount % 10 === 0 || _oddsReqCount >= cap - 50) {
    log('INFO', tag || 'ODDS', `Quota The Odds API: ${_oddsReqCount}/${cap} no mês`);
  }
  return true;
}

// Verifica quota sem incrementar (para lógica de fallback)
function oddsApiPeek() {
  const now = new Date();
  const mk = oddsMonthKey(now);
  if (mk !== _oddsReqMonthKey) return true;
  return _oddsReqCount < oddsMonthlyBudget();
}

function getMetricsLite() {
  return {
    httpCache: { ..._metricsLite.httpCache, size: _httpCache.size, inFlight: _httpInFlight.size },
    http429ByProvider: { ..._metricsLite.http429ByProvider },
    http429LastAt: { ..._metricsLite.http429LastAt },
  };
}

module.exports = { log, calcKelly, calcKellyFraction, calcKellyWithP, norm, httpGet, cachedHttpGet, httpsPost, fetchWithRetry, aiPost, safeParse, sendJson, fmtDate, fmtDateTime, fmtDuration, fuzzyName, oddsApiAllowed, oddsApiPeek, getMetricsLite };