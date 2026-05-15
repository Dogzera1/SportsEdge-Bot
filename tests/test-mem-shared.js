/**
 * Sprint 4 #2 — Cross-process memory shared signal
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { writeMemState, isAnyProcessCritical, listProcessStates } = require('../lib/mem-shared');

module.exports = function(t) {
  // Setup: isolated temp dir per test run pra não poluir repo
  const tempDir = path.join(os.tmpdir(), `mem-shared-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(tempDir, { recursive: true });
  process.env.MEM_SHARED_DIR = tempDir;

  function cleanFiles() {
    for (const f of fs.readdirSync(tempDir)) {
      try { fs.unlinkSync(path.join(tempDir, f)); } catch (_) {}
    }
  }

  t.test('writeMemState: persiste estado em arquivo', () => {
    cleanFiles();
    writeMemState('test-proc', true, 450);
    const filePath = path.join(tempDir, '_mem_critical_test-proc.json');
    t.assert(fs.existsSync(filePath), 'file should exist');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    t.assert(data.critical === true, 'critical flag persisted');
    t.assert(data.rssMb === 450, 'rss persisted');
    t.assert(typeof data.ts === 'number', 'ts is number');
  });

  t.test('isAnyProcessCritical: true quando ao menos 1 process crítico', () => {
    cleanFiles();
    writeMemState('proc-a', false, 200);
    writeMemState('proc-b', true, 450);
    writeMemState('proc-c', false, 300);
    t.assert(isAnyProcessCritical() === true, 'should detect proc-b critical');
  });

  t.test('isAnyProcessCritical: false quando nenhum crítico', () => {
    cleanFiles();
    writeMemState('proc-a', false, 200);
    writeMemState('proc-b', false, 300);
    t.assert(isAnyProcessCritical() === false, 'all fine → false');
  });

  t.test('isAnyProcessCritical: false quando dir vazio', () => {
    cleanFiles();
    t.assert(isAnyProcessCritical() === false, 'no files → false');
  });

  t.test('isAnyProcessCritical: ignora state stale (timestamp old)', () => {
    cleanFiles();
    // Escreve state crítico, depois manualmente modifica ts pra > 60s atrás
    writeMemState('proc-stale', true, 450);
    const fp = path.join(tempDir, '_mem_critical_proc-stale.json');
    const s = JSON.parse(fs.readFileSync(fp, 'utf8'));
    s.ts = Date.now() - 120 * 1000; // 2min atrás
    fs.writeFileSync(fp, JSON.stringify(s));
    t.assert(isAnyProcessCritical(60000) === false, 'stale state should be ignored');
  });

  t.test('isAnyProcessCritical: state recente passa o filter', () => {
    cleanFiles();
    writeMemState('proc-recent', true, 450);
    t.assert(isAnyProcessCritical(60000) === true, 'recent state should pass');
  });

  t.test('writeMemState: sanitiza nome com chars perigosos (path traversal block)', () => {
    cleanFiles();
    writeMemState('../etc/passwd', true, 450);
    // Sanitization replaces /, ., etc com _ — confere arquivo dentro do tempDir
    const files = fs.readdirSync(tempDir);
    t.assert(files.length === 1, `expected 1 file, got ${files.length}: ${files.join(',')}`);
    t.assert(/^_mem_critical_.*\.json$/.test(files[0]), `filename pattern: ${files[0]}`);
    t.assert(!files[0].includes('/') && !files[0].includes('..'), 'no path traversal chars in filename');
  });

  t.test('listProcessStates: enumera todos com idade calculada', () => {
    cleanFiles();
    writeMemState('a', true, 100);
    writeMemState('b', false, 200);
    const list = listProcessStates();
    t.assert(list.length === 2, `expected 2 states, got ${list.length}`);
    const a = list.find(s => s.name === 'a');
    t.assert(a && a.critical === true && a.rssMb === 100, 'a state correct');
    t.assert(list.every(s => typeof s.ageMs === 'number' && s.ageMs >= 0), 'all have ageMs');
  });

  t.test('JSON corrupto não crash isAnyProcessCritical', () => {
    cleanFiles();
    fs.writeFileSync(path.join(tempDir, '_mem_critical_corrupt.json'), '{not json');
    writeMemState('good', true, 450);
    // Não deve crashar; deve retornar true por causa do 'good'
    t.assert(isAnyProcessCritical() === true, 'corrupt file should be skipped, good detected');
  });

  // Cleanup teardown
  process.on('exit', () => {
    try {
      for (const f of fs.readdirSync(tempDir)) {
        try { fs.unlinkSync(path.join(tempDir, f)); } catch (_) {}
      }
      fs.rmdirSync(tempDir);
    } catch (_) {}
    delete process.env.MEM_SHARED_DIR;
  });
};
