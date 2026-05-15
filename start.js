// ── Railway / Production Launcher ──
// Spawns server.js + bot.js in the same container, sharing the same port.
// Railway sets $PORT automatically; we bridge it to SERVER_PORT so both
// processes agree on which port to use for internal HTTP communication.

const { spawn } = require('child_process');
const http = require('http');

// Buffer de linhas pra mandar ao /logs/ingest do server (batched)
const _pendingLines = [];
let _flushTimer = null;
function scheduleIngestFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(flushIngest, 500);
  _flushTimer.unref?.();
}
function flushIngest() {
  _flushTimer = null;
  if (!_pendingLines.length) return;
  const lines = _pendingLines.splice(0, _pendingLines.length);
  const payload = JSON.stringify({ lines });
  const req = http.request({
    host: '127.0.0.1',
    port: process.env.SERVER_PORT || process.env.PORT || 3000,
    path: '/logs/ingest',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    timeout: 4000,
  }, (res) => { res.resume(); });
  req.on('error', () => { /* server pode estar reiniciando; descarta */ });
  req.on('timeout', () => req.destroy());
  req.write(payload); req.end();
}
function pipeLineToServer(raw) {
  const line = String(raw || '').replace(/\r$/, '');
  if (!line.trim()) return;
  _pendingLines.push(line);
  if (_pendingLines.length >= 40) flushIngest();
  else scheduleIngestFlush();
}

let PORT = process.env.PORT || process.env.SERVER_PORT || '3000';
process.env.SERVER_PORT = String(PORT); // keep in sync
// Em dev local, algumas máquinas já tem PORT=3000 setado no ambiente.
// Mantém ambos alinhados para que server.js use a porta correta.
process.env.PORT = String(PORT);

// Alinha com server.js: Railway às vezes cola "=/path" ou tabs no env
const DB_PATH = (process.env.DB_PATH || 'sportsedge.db')
  .trim()
  .replace(/^[\s=]+/, '')
  .trim() || 'sportsedge.db';
process.env.DB_PATH = DB_PATH;

console.log(`[LAUNCHER] PORT=${PORT} | DB=${DB_PATH}`);

const _crashCount = {};
const _spawnTs = {};

// 2026-05-14: launcher heartbeat persisted file pra diagnose container restarts.
// Antes _writeChildExit só rodava em child.on('exit'), mas se container morre
// (Railway recycle / Linux OOM kill nível root), launcher também morre sem
// rodar exit handler. Heartbeat 30s persiste {pid, mem_mb, children, ts} em disco.
// Boot subsequente lê e correlaciona pra detectar parent kill.
function _writeLauncherHeartbeat() {
  try {
    const fs = require('fs');
    const path = require('path');
    const dbDir = path.dirname(path.isAbsolute(DB_PATH) ? DB_PATH : path.resolve(DB_PATH));
    const out = path.join(dbDir, 'launcher_heartbeat.json');
    const mem = process.memoryUsage();
    const payload = {
      ts: new Date().toISOString(),
      pid: process.pid,
      uptime_s: Math.round(process.uptime()),
      rss_mb: Math.round(mem.rss / 1024 / 1024),
      heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
      children: Object.fromEntries(
        Object.entries(_spawnTs).map(([name, ts]) => [
          name,
          { spawn_ts: ts, uptime_s: Math.round((Date.now() - ts) / 1000), crash_count: _crashCount[name] || 0 }
        ])
      ),
    };
    fs.writeFileSync(out, JSON.stringify(payload));
  } catch (_) {}
}
setInterval(_writeLauncherHeartbeat, 30_000).unref();
// Inicial logo após launcher subir
setTimeout(_writeLauncherHeartbeat, 5_000).unref?.();

// 2026-05-01: persiste exit signature do child em disco. Se SIGKILL/OOM (sem
// grace period), o próprio child não tem chance de escrever last_exit_*.json,
// mas o launcher captura via 'exit' event e persiste {code, signal, uptime_ms}.
// Boot subsequente do server lê e correlaciona.
function _writeChildExit(name, code, signal, uptimeMs) {
  try {
    const fs = require('fs');
    const path = require('path');
    const dbDir = path.dirname(path.isAbsolute(DB_PATH) ? DB_PATH : path.resolve(DB_PATH));
    const out = path.join(dbDir, `last_child_exit_${name.replace(/\W+/g,'_')}.json`);
    const payload = { name, code, signal, uptime_ms: uptimeMs, at: new Date().toISOString() };
    fs.writeFileSync(out, JSON.stringify(payload));
  } catch (_) {}
}

// 2026-05-15 audit P0: restart loop 50 boots/24h root cause = V8 default
// heap_size_limit ~4GB (unbounded vs Railway 512MB cap). Bot.js grew
// ~46 MB/h até container OOM @ ~3-5h uptime. SIGKILL pre exit handler.
// Last OOM snapshot 07:04Z mostrou bot RSS 383 MB.
// Fix: cap heap explicit per process. V8 GCs aggressive at cap → throws
// "JavaScript heap OOM" gracefully (catchable) BEFORE container OOM SIGKILL.
// Budget Railway 512 MB: launcher 50 + server cap 150 = ~200 RSS +
// bot cap 180 = ~260 RSS = ~500 total. Env tunável.
const BOT_HEAP_MB = parseInt(process.env.BOT_HEAP_MB || '180', 10);
const SERVER_HEAP_MB = parseInt(process.env.SERVER_HEAP_MB || '150', 10);
console.log(`[LAUNCHER] heap caps: bot=${BOT_HEAP_MB}MB server=${SERVER_HEAP_MB}MB (Railway 512 cap)`);

function spawnChild(name, file) {
  // Captura stdout/stderr via pipe pra espelhar no Railway console E ingerir no buffer do server.
  const child = spawn('node', [`--max-old-space-size=${BOT_HEAP_MB}`, file], {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: process.env
  });
  _spawnTs[name] = Date.now();

  let outBuf = '', errBuf = '';
  child.stdout.on('data', d => {
    outBuf += d.toString('utf8');
    const parts = outBuf.split('\n');
    outBuf = parts.pop() || '';
    for (const ln of parts) {
      process.stdout.write(ln + '\n');
      pipeLineToServer(ln);
    }
  });
  child.stderr.on('data', d => {
    errBuf += d.toString('utf8');
    const parts = errBuf.split('\n');
    errBuf = parts.pop() || '';
    for (const ln of parts) {
      process.stderr.write(ln + '\n');
      pipeLineToServer(ln);
    }
  });

  child.on('exit', (code, signal) => {
    _crashCount[name] = (_crashCount[name] || 0) + 1;
    const uptimeMs = Date.now() - (_spawnTs[name] || Date.now());
    _writeChildExit(name, code, signal, uptimeMs);
    // Backoff exponencial: 3s, 6s, 12s, 24s, max 60s
    const delay = Math.min(3000 * Math.pow(2, Math.min(_crashCount[name] - 1, 4)), 60000);
    console.error(`[LAUNCHER] ${name} exited (code=${code} signal=${signal} uptime=${Math.round(uptimeMs/1000)}s) — restart #${_crashCount[name]} em ${delay/1000}s`);
    setTimeout(() => spawnChild(name, file), delay);
  });

  child.on('error', (err) => {
    console.error(`[LAUNCHER] ${name} error: ${err.message}`);
  });

  return child;
}

let botStarted = false;
let serverStartTs = 0;
let serverRestarts = 0;
let botStartTimer = null;

function startBotOnce() {
  if (botStarted) return;
  botStarted = true;
  spawnChild('bot.js', 'bot.js');
}

function spawnServerWithPortRetry() {
  serverStartTs = Date.now();
  // Sempre passa PORT+SERVER_PORT para o child (evita usar valor "antigo")
  const env = { ...process.env, PORT: String(PORT), SERVER_PORT: String(PORT) };
  const srv = spawn('node', [`--max-old-space-size=${SERVER_HEAP_MB}`, 'server.js'], { stdio: 'inherit', env });

  // 2026-05-06: bot spawn delay 3s→10s. Antes, com server crashing+port-retry,
  // bot subia em 3s com env stale (PORT/SERVER_PORT do parent já mutado mid-flight),
  // e logs ingest falhavam silenciosamente. 10s dá tempo do server estabilizar.
  if (botStartTimer) clearTimeout(botStartTimer);
  botStartTimer = setTimeout(() => startBotOnce(), 10000);

  srv.on('exit', (code, signal) => {
    const ranMs = Date.now() - serverStartTs;
    const portN = parseInt(String(PORT), 10);
    const canBumpPort =
      Number.isFinite(portN) &&
      ranMs < 8000 && // falhou rápido → provável bind
      serverRestarts < 25;

    // Se porta ocupada localmente, tenta próxima porta automaticamente
    if (canBumpPort && code === 1) {
      serverRestarts++;
      const next = String(portN + 1);
      PORT = next;
      process.env.SERVER_PORT = next;
      process.env.PORT = next;
      console.error(`[LAUNCHER] server.js saiu rápido (code=1). Tentando PORT=${next}...`);
      setTimeout(() => spawnServerWithPortRetry(), 800);
      return;
    }

    console.error(`[LAUNCHER] server.js exited (code=${code} signal=${signal}) — restarting in 3s`);
    setTimeout(() => spawnServerWithPortRetry(), 3000);
  });

  srv.on('error', (err) => {
    console.error(`[LAUNCHER] server.js error: ${err.message}`);
  });

  return srv;
}

// Server first
spawnServerWithPortRetry();
// Bot inicia via timer após server ficar vivo

// Keep the launcher process alive and propagate signals
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT',  () => process.exit(0));
