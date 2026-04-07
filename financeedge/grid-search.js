/**
 * grid-search.js
 * Otimização de parâmetros via grid search para estratégia de trading.
 * Testa combinações de parâmetros em dados históricos para encontrar configuração ótima.
 */

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');
const { runBacktest, calculateMetrics } = require('./backtest');

// Espaço de busca de parâmetros
const PARAM_GRID = {
  // RSI thresholds
  rsiOversold: [25, 30, 35],
  rsiOverbought: [65, 70, 75],

  // MACD periods
  macdFast: [8, 12, 16],
  macdSlow: [20, 26, 32],
  macdSignal: [7, 9, 11],

  // Bollinger Bands
  bbPeriod: [15, 20, 25],
  bbStdDev: [1.5, 2.0, 2.5],

  // ATR multipliers para stop-loss/take-profit
  atrSlMultiplier: [1.0, 1.5, 2.0],
  atrTpMultiplier: [2.0, 3.0, 4.0],

  // Kelly fraction
  kellyFraction: [0.1, 0.25, 0.5],

  // Filtros
  minConfidence: ['BAIXA', 'MÉDIA', 'ALTA'],
  minEvPct: [1, 3, 5]
};

/**
 * Gera todas as combinações de parâmetros do grid.
 */
function* generateParameterCombinations() {
  const keys = Object.keys(PARAM_GRID);
  const indices = new Array(keys.length).fill(0);

  while (true) {
    // Cria combinação atual
    const combination = {};
    for (let i = 0; i < keys.length; i++) {
      combination[keys[i]] = PARAM_GRID[keys[i]][indices[i]];
    }
    yield combination;

    // Avança para próxima combinação (contador baseado em múltiplas bases)
    let carry = 1;
    for (let i = 0; i < keys.length && carry > 0; i++) {
      indices[i] += carry;
      if (indices[i] >= PARAM_GRID[keys[i]].length) {
        indices[i] = 0;
        carry = 1;
      } else {
        carry = 0;
      }
    }

    // Se todos os índices voltaram a zero, terminou
    if (carry === 1) break;
  }
}

/**
 * Aplica parâmetros ao ambiente para backtesting.
 */
function applyParameters(params) {
  // Sobrescreve variáveis de ambiente temporariamente
  process.env.RSI_OVERSOLD = params.rsiOversold.toString();
  process.env.RSI_OVERBOUGHT = params.rsiOverbought.toString();
  process.env.MACD_FAST = params.macdFast.toString();
  process.env.MACD_SLOW = params.macdSlow.toString();
  process.env.MACD_SIGNAL = params.macdSignal.toString();
  process.env.BB_PERIOD = params.bbPeriod.toString();
  process.env.BB_STDDEV = params.bbStdDev.toString();
  process.env.ATR_SL_MULTIPLIER = params.atrSlMultiplier.toString();
  process.env.ATR_TP_MULTIPLIER = params.atrTpMultiplier.toString();
  process.env.KELLY_FRACTION = params.kellyFraction.toString();
  process.env.MIN_CONFIDENCE = params.minConfidence;
  process.env.MIN_EV = params.minEvPct.toString();
}

/**
 * Avalia conjunto de parâmetros via backtesting.
 */
async function evaluateParameters(dataFile, params) {
  console.log(`🧪 Testando parâmetros: ${JSON.stringify(params).substring(0, 100)}...`);

  // Aplica parâmetros
  applyParameters(params);

  try {
    // Executa backtest com parâmetros atuais
    const metrics = await runBacktest(dataFile);

    // Score composto para otimização (prioriza múltiplos fatores)
    const score = calculateParameterScore(metrics, params);

    return {
      params,
      metrics,
      score: parseFloat(score.toFixed(4)),
      timestamp: Date.now()
    };
  } catch (error) {
    console.error(`❌ Erro ao avaliar parâmetros: ${error.message}`);
    return {
      params,
      error: error.message,
      score: -Infinity,
      timestamp: Date.now()
    };
  }
}

/**
 * Calcula score composto para otimização.
 * Balanceia múltiplas métricas: profit factor, win rate, drawdown, Sharpe ratio.
 */
function calculateParameterScore(metrics, params) {
  if (metrics.totalTrades === 0) return -1000;

  // Pesos para diferentes métricas
  const weights = {
    profitFactor: 0.35,
    winRate: 0.25,
    sharpeRatio: 0.20,
    maxDrawdownPct: -0.15, // negativo - queremos minimizar drawdown
    expectancy: 0.05
  };

  // Normaliza métricas
  const normalized = {
    profitFactor: Math.min(metrics.profitFactor / 5, 1), // Cap em 5
    winRate: metrics.winRate / 100, // 0-1
    sharpeRatio: Math.min(metrics.sharpeRatio / 2, 1), // Cap em 2
    maxDrawdownPct: metrics.maxDrawdownPct / 100, // 0-1
    expectancy: Math.min(metrics.expectancy / 100, 1) // Cap em 100
  };

  // Penaliza poucos trades
  const tradePenalty = metrics.totalTrades < 10 ? 0.5 : 1.0;

  // Calcula score ponderado
  let score = 0;
  for (const [metric, weight] of Object.entries(weights)) {
    score += normalized[metric] * weight;
  }

  // Penalidade por complexidade excessiva (evita overfitting)
  const complexityPenalty = calculateComplexityPenalty(params);

  return score * tradePenalty * complexityPenalty;
}

/**
 * Penaliza parâmetros muito específicos/complexos para evitar overfitting.
 */
function calculateComplexityPenalty(params) {
  let penalty = 1.0;

  // Penaliza valores extremos de RSI
  if (params.rsiOversold < 25 || params.rsiOverbought > 75) penalty *= 0.9;

  // Penaliza períodos muito curtos/longos
  if (params.macdFast < 8 || params.macdSlow > 32) penalty *= 0.9;
  if (params.bbPeriod < 15 || params.bbPeriod > 25) penalty *= 0.9;

  // Penaliza multiplicadores extremos de ATR
  if (params.atrSlMultiplier < 1.0 || params.atrSlMultiplier > 2.0) penalty *= 0.9;
  if (params.atrTpMultiplier < 2.0 || params.atrTpMultiplier > 4.0) penalty *= 0.9;

  // Penaliza Kelly fraction muito alta
  if (params.kellyFraction > 0.5) penalty *= 0.8;

  return penalty;
}

/**
 * Executa grid search completo.
 */
async function runGridSearch(dataFile, maxCombinations = 50) {
  console.log('🔍 Iniciando grid search...');
  console.log(`📊 Espaço de busca: ${Object.keys(PARAM_GRID).length} dimensões`);

  const generator = generateParameterCombinations();
  const results = [];
  let count = 0;

  for (const params of generator) {
    if (count >= maxCombinations) {
      console.log(`⏹️  Limite de ${maxCombinations} combinações atingido`);
      break;
    }

    const result = await evaluateParameters(dataFile, params);
    results.push(result);

    // Progresso
    count++;
    const progress = ((count / maxCombinations) * 100).toFixed(1);
    console.log(`⏳ Progresso: ${progress}% (${count}/${maxCombinations}) | Score atual: ${result.score.toFixed(4)}`);

    // Salva checkpoint a cada 10 combinações
    if (count % 10 === 0) {
      saveCheckpoint(results, count);
    }
  }

  console.log('✅ Grid search concluído!');

  // Ordena resultados por score
  results.sort((a, b) => b.score - a.score);

  // Relatório dos melhores parâmetros
  console.log('\n' + '='.repeat(70));
  console.log('🏆 MELHORES PARÂMETROS ENCONTRADOS');
  console.log('='.repeat(70));

  const topN = Math.min(5, results.length);
  for (let i = 0; i < topN; i++) {
    const result = results[i];
    if (result.error) continue;

    console.log(`\n#${i + 1} Score: ${result.score.toFixed(4)}`);
    console.log(`  RSI: ${result.params.rsiOversold}/${result.params.rsiOverbought}`);
    console.log(`  MACD: ${result.params.macdFast}/${result.params.macdSlow}/${result.params.macdSignal}`);
    console.log(`  BB: ${result.params.bbPeriod} period, ${result.params.bbStdDev} std dev`);
    console.log(`  ATR SL/TP: ${result.params.atrSlMultiplier}x/${result.params.atrTpMultiplier}x`);
    console.log(`  Kelly: ${result.params.kellyFraction}`);
    console.log(`  Filtros: ${result.params.minConfidence} conf, ${result.params.minEvPct}% EV`);
    console.log(`  Métricas: ${result.metrics.totalTrades} trades, WR ${result.metrics.winRate}%, PF ${result.metrics.profitFactor}`);
  }

  // Salva resultados completos
  saveResults(results);

  return results;
}

/**
 * Salva checkpoint durante execução.
 */
function saveCheckpoint(results, count) {
  const checkpointFile = `grid_search_checkpoint_${Date.now()}.json`;
  const data = {
    timestamp: Date.now(),
    count,
    results: results.map(r => ({
      params: r.params,
      score: r.score,
      error: r.error,
      metrics: r.metrics ? {
        totalTrades: r.metrics.totalTrades,
        winRate: r.metrics.winRate,
        profitFactor: r.metrics.profitFactor,
        totalPnlPct: r.metrics.totalPnlPct,
        maxDrawdownPct: r.metrics.maxDrawdownPct,
        sharpeRatio: r.metrics.sharpeRatio
      } : null
    }))
  };

  fs.writeFileSync(checkpointFile, JSON.stringify(data, null, 2));
  console.log(`💾 Checkpoint salvo: ${checkpointFile}`);
}

/**
 * Salva resultados finais.
 */
function saveResults(results) {
  const resultsFile = `grid_search_results_${Date.now()}.json`;

  const data = {
    timestamp: Date.now(),
    totalCombinations: results.length,
    paramGrid: PARAM_GRID,
    results: results.map(r => ({
      params: r.params,
      score: r.score,
      error: r.error,
      timestamp: r.timestamp,
      metrics: r.metrics
    }))
  };

  fs.writeFileSync(resultsFile, JSON.stringify(data, null, 2));
  console.log(`\n💾 Resultados completos salvos em: ${resultsFile}`);

  // Também salva os melhores parâmetros em formato de .env
  const bestResult = results.filter(r => !r.error)[0];
  if (bestResult) {
    const envFile = 'optimized_params.env';
    const envContent = Object.entries(bestResult.params)
      .map(([key, value]) => `${key.toUpperCase()}=${value}`)
      .join('\n');

    fs.writeFileSync(envFile, envContent);
    console.log(`⚙️  Parâmetros otimizados salvos em: ${envFile}`);
  }
}

// Execução
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('Uso: node grid-search.js <arquivo_csv> [max_combinações]');
    console.log('Exemplo: node grid-search.js btc_1h_2024.csv 50');
    console.log('\nFormato CSV esperado: timestamp,open,high,low,close,volume');
    process.exit(1);
  }

  const dataFile = args[0];
  const maxCombinations = args[1] ? parseInt(args[1]) : 50;

  runGridSearch(dataFile, maxCombinations).catch(error => {
    console.error('❌ Erro no grid search:', error);
    process.exit(1);
  });
}

module.exports = {
  runGridSearch,
  generateParameterCombinations,
  evaluateParameters,
  calculateParameterScore,
  PARAM_GRID
};