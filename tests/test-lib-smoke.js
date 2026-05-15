/**
 * Smoke test — todos arquivos lib/ carregam sem erro e exportam tudo que listam.
 * Pega class de bug:
 *  - orphan export (nome em module.exports sem função definida — caso sofascore-mma 2026-05-14)
 *  - SyntaxError / ReferenceError no top-level (caso _emitSkip TDZ-style em libs novos)
 *  - module.exports = undefined (sem export)
 *
 * NÃO testa comportamento — só shape. Custo trivial, pega regressão estrutural.
 */

const fs = require('fs');
const path = require('path');

module.exports = function runTests(t) {
  const libDir = path.resolve(__dirname, '..', 'lib');
  if (!fs.existsSync(libDir)) {
    t.test('lib/ directory exists', () => t.assert(false, `lib/ not found at ${libDir}`));
    return;
  }

  const files = fs.readdirSync(libDir).filter(f => f.endsWith('.js')).sort();

  for (const file of files) {
    const full = path.join(libDir, file);

    t.test(`lib/${file} loads`, () => {
      try {
        require(full);
      } catch (e) {
        throw new Error(`require failed: ${e.message}`);
      }
    });

    t.test(`lib/${file} exports no orphans`, () => {
      const mod = require(full);
      if (mod === undefined || mod === null) {
        throw new Error('module.exports is undefined/null');
      }
      if (typeof mod !== 'object') return;
      const orphans = Object.entries(mod).filter(([, v]) => v === undefined).map(([k]) => k);
      if (orphans.length > 0) {
        throw new Error(`orphan exports: ${orphans.join(', ')}`);
      }
    });
  }
};
