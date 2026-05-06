'use strict';

/**
 * polymarket-watcher.js — stub
 *
 * Lib documentada em memory (project_polymarket_predex_2026_05_04) mas o módulo
 * nunca foi implementado. server.js:19246 require()ava em try/catch silencioso,
 * resultando em MODULE_NOT_FOUND a cada /record-tip — feature dead-code.
 *
 * Esse stub provê interface mínima pra silenciar o require sem rodar feature.
 * Quando a impl real existir, expor mesmo shape: {preTipConsensusCheck, ...}.
 *
 * preTipConsensusCheck retorna `null` (sem sinal) — caller já trata null como
 * "sem consensus" e segue normal. POLYMARKET_CONSENSUS_REJECT_CONTRARIAN no-op.
 */

function preTipConsensusCheck(_db, _opts) {
  return null;
}

module.exports = {
  preTipConsensusCheck,
};
