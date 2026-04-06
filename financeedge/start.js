require('dotenv').config({ override: true });
const { spawn } = require('child_process');
const path = require('path');

const SERVER_PORT = process.env.SERVER_PORT || process.env.PORT || 3001;
process.env.SERVER_PORT = String(SERVER_PORT);

function spawnProcess(script, label) {
  const child = spawn(process.execPath, [path.join(__dirname, script)], {
    stdio: 'inherit',
    env: { ...process.env }
  });
  child.on('error', e => console.error(`[${label}] Erro ao iniciar: ${e.message}`));
  child.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      console.error(`[${label}] Encerrado com código ${code} — reiniciando em 5s`);
      setTimeout(() => spawnProcess(script, label), 5000);
    }
  });
  return child;
}

console.log(`[START] FinanceEdge iniciando | porta=${SERVER_PORT}`);
spawnProcess('server.js', 'SERVER');

// Bot inicia 3s depois do server
setTimeout(() => {
  spawnProcess('bot.js', 'BOT');
}, 3000);
