#!/usr/bin/env node
/**
 * Test runner mínimo (sem dependência de framework).
 * Uso: npm test   (ou: node tests/run.js)
 */

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];

function makeT(suite) {
  return {
    test(name, fn) {
      try {
        fn();
        pass++;
        console.log(`  ✓ ${name}`);
      } catch (e) {
        fail++;
        failures.push(`${suite} → ${name}: ${e.message}`);
        console.log(`  ✗ ${name}\n     ${e.message}`);
      }
    },
    assert(cond, msg) {
      if (!cond) throw new Error(msg || 'assertion failed');
    }
  };
}

const testDir = __dirname;
const files = fs.readdirSync(testDir).filter(f => f.startsWith('test-') && f.endsWith('.js'));

for (const file of files) {
  const suite = file.replace(/^test-|\.js$/g, '');
  console.log(`\n[${suite}]`);
  const mod = require(path.join(testDir, file));
  mod(makeT(suite));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('\nFalhas:');
  failures.forEach(f => console.log(`  - ${f}`));
  process.exit(1);
}
process.exit(0);
