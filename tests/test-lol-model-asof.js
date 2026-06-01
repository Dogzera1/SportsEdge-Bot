'use strict';
const assert = require('assert');
const Database = require('better-sqlite3');
const path = require('path');
const lm = require('../lib/lol-model');

const db = new Database(path.join(__dirname, '..', 'sportsedge.db'), { readonly: true });

// 1) sub-modelos agora são exportados
assert.strictEqual(typeof lm._formSubModel, 'function', '_formSubModel deve ser exportado');
assert.strictEqual(typeof lm._eloSubModel, 'function', '_eloSubModel deve ser exportado');

// 2) _formSubModel sem asOfDate == com asOfDate=null (comportamento atual preservado)
const a = lm._formSubModel(db, 'T1', 'Gen.G', null);
const b = lm._formSubModel(db, 'T1', 'Gen.G', null, null);
assert.deepStrictEqual({ pA: a.pA, conf: a.confidence }, { pA: b.pA, conf: b.confidence },
  'default asOfDate deve preservar o comportamento');

// 3) asOfDate no passado distante => menos/zero dados de form (confidence <= atual)
const past = lm._formSubModel(db, 'T1', 'Gen.G', null, '2022-02-01 00:00:00');
assert.ok(past.confidence <= a.confidence + 1e-9, 'as-of passado não pode ter mais form que agora');

db.close();
console.log('OK test-lol-model-asof');
