/**
 * bot-mem-heartbeat.js — TDD coverage
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

module.exports = function(t) {
  // Setup: temp DB_PATH so snapshot writes to temp dir
  const tempDir = path.join(os.tmpdir(), `bot-mem-ht-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const tempDb = path.join(tempDir, 'sportsedge.db');
  process.env.DB_PATH = tempDb;
  // Clear module cache pra pegar novo DB_PATH
  delete require.cache[require.resolve('../lib/bot-mem-heartbeat')];

  const { writeBotMemSnapshot, readBotMemSnapshot } = require('../lib/bot-mem-heartbeat');
  const snapshotPath = path.join(tempDir, '_bot_mem_snapshot.json');

  t.test('writeBotMemSnapshot: cria arquivo com schema correto', () => {
    writeBotMemSnapshot();
    t.assert(fs.existsSync(snapshotPath), 'snapshot file should exist');
    const data = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    t.assert(typeof data.ts === 'string', 'ts is string');
    t.assert(typeof data.uptime_s === 'number', 'uptime_s number');
    t.assert(data.memoryMb && typeof data.memoryMb.rss === 'number', 'rss in memoryMb');
    t.assert(typeof data.memoryMb.heap_used === 'number', 'heap_used number');
    t.assert(typeof data.memCritical === 'boolean', 'memCritical bool');
  });

  t.test('writeBotMemSnapshot: v8 stats incluído', () => {
    writeBotMemSnapshot();
    const data = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    t.assert(data.v8, 'v8 stats present');
    t.assert(typeof data.v8.heap_size_limit_mb === 'number', 'v8 heap_size_limit');
    t.assert(typeof data.v8.native_contexts === 'number', 'v8 native_contexts');
  });

  t.test('readBotMemSnapshot: retorna null se ausente', () => {
    try { fs.unlinkSync(snapshotPath); } catch (_) {}
    const r = readBotMemSnapshot();
    t.assert(r === null, 'expect null when file missing');
  });

  t.test('readBotMemSnapshot: inclui _ageMs', () => {
    writeBotMemSnapshot();
    const r = readBotMemSnapshot();
    t.assert(r !== null, 'snapshot read');
    t.assert(typeof r._ageMs === 'number' && r._ageMs >= 0, '_ageMs >= 0');
    t.assert(r._ageMs < 5000, '_ageMs < 5s (fresh)');
  });

  t.test('readBotMemSnapshot: JSON corrupto retorna null', () => {
    fs.writeFileSync(snapshotPath, '{not valid');
    const r = readBotMemSnapshot();
    t.assert(r === null, 'corrupt JSON returns null');
  });

  // Cleanup
  process.on('exit', () => {
    try { fs.unlinkSync(snapshotPath); } catch (_) {}
    try { fs.rmdirSync(tempDir); } catch (_) {}
    delete process.env.DB_PATH;
  });
};
