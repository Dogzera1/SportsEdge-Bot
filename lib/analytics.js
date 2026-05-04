'use strict';

/**
 * lib/analytics.js — DuckDB analytics layer.
 *
 * Cobre patterns DAX-equivalentes (CALCULATE, RANKX, time intelligence, PIVOT)
 * via SQL DuckDB sobre sportsedge.db ATTACHED read-only. Não modifica dados;
 * só agrega.
 *
 * Padrão de uso:
 *   const { query, getConnection } = require('./lib/analytics');
 *   const rows = await query("SELECT ... FROM sd.tips WHERE ...");
 *
 * Boot lazy: conexão criada na primeira chamada e reusada. SQLite extension
 * carregada uma vez via INSTALL+LOAD.
 *
 * Performance: 10-100× SQLite em agregações com window functions. Use pra
 * relatórios que rodam <60s e cabem em RAM. Pra OLTP continue better-sqlite3.
 */

const path = require('path');

let _instancePromise = null;
let _connectionPromise = null;
let _attachedPath = null;

function _coerceValue(v) {
  // BIGINT → Number (sport stats fit in safe int)
  if (typeof v === 'bigint') {
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) return Number(v); // intentional precision loss
    return Number(v);
  }
  // DuckDB DECIMAL/HUGEINT podem vir como string — tenta parsear se for numérico
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return parseFloat(v);
  return v;
}

function _coerceRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const k of Object.keys(row)) out[k] = _coerceValue(row[k]);
  return out;
}

async function _initInstance() {
  if (_instancePromise) return _instancePromise;
  _instancePromise = (async () => {
    const { DuckDBInstance } = require('@duckdb/node-api');
    return await DuckDBInstance.create(':memory:');
  })();
  return _instancePromise;
}

async function getConnection() {
  if (_connectionPromise) return _connectionPromise;
  _connectionPromise = (async () => {
    const inst = await _initInstance();
    const con = await inst.connect();
    // Extensão SQLite só precisa instalar 1×; LOAD a cada conexão.
    try { await con.run("INSTALL sqlite"); } catch (_) { /* já instalado */ }
    await con.run("LOAD sqlite");
    return con;
  })();
  return _connectionPromise;
}

/**
 * Garante que sportsedge.db está ATTACHED como `sd`. Re-attach se path mudar
 * (Railway usa /data/sportsedge.db, local usa ./sportsedge.db).
 */
async function _ensureAttached(dbPath) {
  const target = path.resolve(dbPath || process.env.DB_PATH || 'sportsedge.db');
  if (_attachedPath === target) return;
  const con = await getConnection();
  if (_attachedPath) {
    try { await con.run("DETACH sd"); } catch (_) {}
  }
  // READ_ONLY garante que analytics nunca corrompe data operacional.
  // Path com espaços/barras Windows: SQL string-escape simples (path nosso, não user input).
  const escaped = target.replace(/'/g, "''");
  await con.run(`ATTACH '${escaped}' AS sd (TYPE SQLITE, READ_ONLY)`);
  _attachedPath = target;
}

/**
 * Executa query DuckDB sobre sportsedge.db. Retorna array de rows (objetos
 * com colunas → valores coercidos pra Number quando possível).
 *
 * @param {string} sql — SQL DuckDB; tabelas SQLite ficam em schema `sd.*`
 * @param {object} opts
 * @param {string} [opts.dbPath] — override path
 * @param {number} [opts.timeoutMs=15000] — abort se query exceder
 * @returns {Promise<Array<object>>}
 */
async function query(sql, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 15000;
  await _ensureAttached(opts.dbPath);
  const con = await getConnection();
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`analytics query timeout (${timeoutMs}ms)`)), timeoutMs);
  });
  try {
    const reader = await Promise.race([con.runAndReadAll(sql), timeoutPromise]);
    const rows = reader.getRowObjectsJson();
    return rows.map(_coerceRow);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Convenience: query + retorna 1ª row ou null.
 */
async function queryOne(sql, opts = {}) {
  const rows = await query(sql, opts);
  return rows[0] || null;
}

/**
 * Reset state (testes / re-attach forçado).
 */
async function _reset() {
  _instancePromise = null;
  _connectionPromise = null;
  _attachedPath = null;
}

module.exports = {
  query,
  queryOne,
  getConnection,
  _reset,
};
