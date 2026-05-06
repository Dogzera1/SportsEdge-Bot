'use strict';

// Regression test pra ring buffer de logs (round 10 perf fix).
// Antes: _logBuffer.push(...) + shift() = O(n) realloc.
// Agora: modular index, O(1) write + correct ordering em getLogBuffer().

module.exports = function (t) {
  // Re-require utils com env override pra buffer pequeno (testar overflow rápido)
  delete require.cache[require.resolve('../lib/utils')];
  process.env.LOG_BUFFER_MAX = '5';
  const utils = require('../lib/utils');

  // Push 3 → buffer não cheio
  t.test('push 3, getLogBuffer returns 3 in order', () => {
    utils.log('INFO', 'TEST', 'a');
    utils.log('INFO', 'TEST', 'b');
    utils.log('INFO', 'TEST', 'c');
    const b = utils.getLogBuffer();
    t.assert(b.length === 3, `expected 3 entries, got ${b.length}`);
    t.assert(/a/.test(b[0].text), `first should contain 'a': ${b[0].text}`);
    t.assert(/c/.test(b[2].text), `last should contain 'c': ${b[2].text}`);
  });

  // Push 7 → buffer cheio (5), oldest 2 evicted
  t.test('push 7 with cap=5, get 5 newest in order', () => {
    delete require.cache[require.resolve('../lib/utils')];
    const utils2 = require('../lib/utils');
    for (let i = 0; i < 7; i++) {
      utils2.log('INFO', 'TEST', `msg${i}`);
    }
    const b = utils2.getLogBuffer();
    t.assert(b.length === 5, `expected 5 entries (cap), got ${b.length}`);
    t.assert(/msg2/.test(b[0].text), `oldest should be msg2 (msg0/1 evicted): ${b[0].text}`);
    t.assert(/msg6/.test(b[4].text), `newest should be msg6: ${b[4].text}`);
  });

  // Reset env pra não afetar outros tests
  delete require.cache[require.resolve('../lib/utils')];
  delete process.env.LOG_BUFFER_MAX;
};
