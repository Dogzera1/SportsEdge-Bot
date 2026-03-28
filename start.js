// ── Railway / Production Launcher ──
// Spawns server.js + bot.js in the same container, sharing the same port.
// Railway sets $PORT automatically; we bridge it to SERVER_PORT so both
// processes agree on which port to use for internal HTTP communication.

const { spawn } = require('child_process');

const PORT = process.env.PORT || process.env.SERVER_PORT || '3000';
process.env.SERVER_PORT = PORT; // ensure both child processes see the same port

const DB_PATH = process.env.DB_PATH || 'sportsedge.db';
process.env.DB_PATH = DB_PATH;

console.log(`[LAUNCHER] PORT=${PORT} | DB=${DB_PATH}`);

function spawnChild(name, file) {
  const child = spawn('node', [file], {
    stdio: 'inherit',
    env: process.env
  });

  child.on('exit', (code, signal) => {
    console.error(`[LAUNCHER] ${name} exited (code=${code} signal=${signal}) — restarting in 3s`);
    setTimeout(() => spawnChild(name, file), 3000);
  });

  child.on('error', (err) => {
    console.error(`[LAUNCHER] ${name} error: ${err.message}`);
  });

  return child;
}

// Server must be up before bot starts connecting to it
const server = spawnChild('server.js', 'server.js');

// Give server 2 seconds to bind its port before starting the bot
setTimeout(() => {
  spawnChild('bot.js', 'bot.js');
}, 2000);

// Keep the launcher process alive and propagate signals
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT',  () => process.exit(0));
