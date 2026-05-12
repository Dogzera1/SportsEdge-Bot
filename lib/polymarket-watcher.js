'use strict';

/**
 * polymarket-watcher.js — stub
 *
 * @DORMANT 2026-05-12
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
 *
 * Decisão 2026-05-12 (audit "corrija gaps"): NÃO implementar full agora.
 * Razões:
 *   - Cobertura esports/tennis em Polymarket é fraca (sport-specific markets
 *     dispersos, IDs não padronizados — match com nossas tips dá miss > hit).
 *   - Custo dev alto (~5-7 dias): CLOB API auth, market discovery, normalização
 *     event names, multi-wallet aggregation, realized PnL pipe.
 *   - ROI duvidoso vs alternativas mais baratas (gates já existentes + news).
 * Plano: revisitar em 30 dias se Polymarket lançar API mais estruturada de
 * sports markets OR se demanda específica aparecer. Por enquanto stub safe.
 *
 * Pra remover completamente: deletar require em server.js (linha ~19246) +
 * deletar este file. Marker DORMANT facilita cron overfeaturing-audit detectar.
 */

function preTipConsensusCheck(_db, _opts) {
  return null;
}

module.exports = {
  preTipConsensusCheck,
};
