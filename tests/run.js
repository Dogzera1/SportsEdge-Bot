#!/usr/bin/env node
/**
 * Test runner mínimo (sem dependência de framework).
 * Uso: npm test   (ou: node tests/run.js)
 */

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];

// 2026-05-15: runner sync por default (preserva tests com setup/teardown inline
// entre t.test calls como banca-delta + log-ring-buffer). Suporta async opcional:
// se fn() retornar Promise, t.test retorna Promise que mod async pode awaitar.
// Pattern pra integration tests: module.exports = async function(t) { await t.test(...) }
function makeT(suite) {
  return {
    test(name, fn) {
      let r;
      try {
        r = fn();
      } catch (e) {
        fail++;
        failures.push(`${suite} → ${name}: ${e.message}`);
        console.log(`  ✗ ${name}\n     ${e.message}`);
        return;
      }
      // Sync test: fn já retornou. Marca pass agora.
      if (!r || typeof r.then !== 'function') {
        pass++;
        console.log(`  ✓ ${name}`);
        return;
      }
      // Async test: retorna Promise. Caller (mod async) pode awaitar pra bloquear.
      return r.then(
        () => { pass++; console.log(`  ✓ ${name}`); },
        (e) => {
          fail++;
          failures.push(`${suite} → ${name}: ${e.message}`);
          console.log(`  ✗ ${name}\n     ${e.message}`);
        }
      );
    },
    assert(cond, msg) {
      if (!cond) throw new Error(msg || 'assertion failed');
    }
  };
}

async function main() {
  const testDir = __dirname;
  // 2026-05-06: ordering determinístico — readdir order varia entre OS,
  // importante quando algum test depende de ordem (DB state etc).
  const files = fs.readdirSync(testDir)
    .filter(f => f.startsWith('test-') && f.endsWith('.js'))
    .sort();

  for (const file of files) {
    const suite = file.replace(/^test-|\.js$/g, '');
    console.log(`\n[${suite}]`);
    const mod = require(path.join(testDir, file));
    if (typeof mod !== 'function') {
      console.log(`  (skipped — uses node:test runner, run directly via 'node --test ${file}')`);
      continue;
    }
    // mod pode ser sync (chama t.test inline, ignora retorno) ou async (await t.test).
    // await mod() funciona pros dois: sync retorna undefined → await é no-op.
    await mod(makeT(suite));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('\nFalhas:');
    failures.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  }
  process.exit(0);
}

main().catch(e => {
  console.error('Runner crashed:', e);
  process.exit(2);
});
