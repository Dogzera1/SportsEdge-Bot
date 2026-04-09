// ── Railway / Production Launcher ──
// Spawns server.js + bot.js in the same container, sharing the same port.
// Railway sets $PORT automatically; we bridge it to SERVER_PORT so both
// processes agree on which port to use for internal HTTP communication.

const { spawn } = require('child_process');

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
function spawnChild(name, file) {
  const child = spawn('node', [file], {
    stdio: 'inherit',
    env: process.env
  });

  child.on('exit', (code, signal) => {
    _crashCount[name] = (_crashCount[name] || 0) + 1;
    // Backoff exponencial: 3s, 6s, 12s, 24s, max 60s
    const delay = Math.min(3000 * Math.pow(2, Math.min(_crashCount[name] - 1, 4)), 60000);
    console.error(`[LAUNCHER] ${name} exited (code=${code} signal=${signal}) — restart #${_crashCount[name]} em ${delay/1000}s`);
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
  const srv = spawn('node', ['server.js'], { stdio: 'inherit', env });

  // Só inicia bot quando server ficou vivo alguns segundos
  if (botStartTimer) clearTimeout(botStartTimer);
  botStartTimer = setTimeout(() => startBotOnce(), 3000);

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
