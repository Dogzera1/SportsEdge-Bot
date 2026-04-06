/**
 * risk-manager.js
 * Kelly Fraccionado, Stop-Loss, VaR e circuit breakers.
 */
const { log } = require('./utils');

const CONFIG = {
  // Kelly: usa no máximo 25% do valor calculado
  kellyFraction: parseFloat(process.env.KELLY_FRACTION || '0.25'),
  // Stake máxima por trade: % da banca
  maxStakePct: parseFloat(process.env.MAX_STAKE_PCT || '0.05'),    // 5% da banca
  minStakePct: parseFloat(process.env.MIN_STAKE_PCT || '0.005'),   // 0.5% mínimo
  // Stop-loss padrão por trade
  stopLossPct: parseFloat(process.env.STOP_LOSS_PCT || '0.02'),    // 2% do entry
  // Take-profit padrão (R:R mínimo 2:1)
  takeProfitMult: parseFloat(process.env.TAKE_PROFIT_MULT || '2.0'),
  // Circuit breaker: para o bot se perder X% em 24h
  circuitBreakerPct: parseFloat(process.env.CIRCUIT_BREAKER_PCT || '0.05'), // 5% em 24h
  // Máximo de trades abertos simultâneos
  maxOpenTrades: parseInt(process.env.MAX_OPEN_TRADES || '3'),
  // Exposição total máxima correlacionada (% da banca)
  maxTotalExposure: parseFloat(process.env.MAX_TOTAL_EXPOSURE || '0.15'),
};

/**
 * Kelly Completo com fração de segurança.
 * f* = EV / (odds - 1)   onde EV = probabilidade_esperada - 1/odds
 * Retorna stake como % da banca.
 */
function calcKelly(evPct, odds, fraction = CONFIG.kellyFraction) {
  const ev = evPct / 100;
  if (!ev || ev <= 0 || !odds || odds <= 1) return 0;
  const b = odds - 1;
  // Kelly completo: f* = (p*b - q) / b = EV / b
  const kellyFull = ev / b;
  const kellyFrac = kellyFull * fraction;
  const clamped = Math.max(CONFIG.minStakePct, Math.min(CONFIG.maxStakePct, kellyFrac));
  return parseFloat(clamped.toFixed(4));
}

/**
 * Calcula stake em USDT com base na banca atual.
 */
function calcStakeUsdt(bankrollUsdt, evPct, odds, confidenceLevel) {
  const fractionMap = { 'ALTA': 0.25, 'MÉDIA': 0.167, 'BAIXA': 0.10 };
  const fraction = fractionMap[confidenceLevel] || CONFIG.kellyFraction;
  const stakePct = calcKelly(evPct, odds, fraction);
  const stakeUsdt = parseFloat((bankrollUsdt * stakePct).toFixed(2));
  return { stakeUsdt, stakePct, kellyFraction: fraction };
}

/**
 * Calcula stop-loss e take-profit baseado em ATR.
 * ATR-based: mais adaptativo à volatilidade atual.
 */
function calcStopTakeProfit(entryPrice, direction, atr, multiplierSL = 1.5, rrRatio = 2.0) {
  if (!atr || atr <= 0) {
    // Fallback: % fixo
    const slPct = CONFIG.stopLossPct;
    const tpPct = slPct * rrRatio;
    if (direction === 'long') {
      return {
        stopLoss: parseFloat((entryPrice * (1 - slPct)).toFixed(6)),
        takeProfit: parseFloat((entryPrice * (1 + tpPct)).toFixed(6)),
      };
    } else {
      return {
        stopLoss: parseFloat((entryPrice * (1 + slPct)).toFixed(6)),
        takeProfit: parseFloat((entryPrice * (1 - tpPct)).toFixed(6)),
      };
    }
  }

  const slDistance = atr * multiplierSL;
  const tpDistance = slDistance * rrRatio;

  if (direction === 'long') {
    return {
      stopLoss: parseFloat((entryPrice - slDistance).toFixed(6)),
      takeProfit: parseFloat((entryPrice + tpDistance).toFixed(6)),
    };
  } else {
    return {
      stopLoss: parseFloat((entryPrice + slDistance).toFixed(6)),
      takeProfit: parseFloat((entryPrice - tpDistance).toFixed(6)),
    };
  }
}

/**
 * Verifica se novo trade passa nas travas de segurança.
 */
function checkRiskGuards(bankrollUsdt, openTradesCount, stakeUsdt, totalExposureUsdt) {
  const errors = [];

  if (openTradesCount >= CONFIG.maxOpenTrades) {
    errors.push(`Limite de ${CONFIG.maxOpenTrades} trades abertos atingido`);
  }

  const stakePct = stakeUsdt / bankrollUsdt;
  if (stakePct > CONFIG.maxStakePct) {
    errors.push(`Stake ${(stakePct * 100).toFixed(1)}% excede máximo ${(CONFIG.maxStakePct * 100).toFixed(1)}%`);
  }

  const totalExposurePct = (totalExposureUsdt + stakeUsdt) / bankrollUsdt;
  if (totalExposurePct > CONFIG.maxTotalExposure) {
    errors.push(`Exposição total ${(totalExposurePct * 100).toFixed(1)}% excede máximo ${(CONFIG.maxTotalExposure * 100).toFixed(1)}%`);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Circuit breaker: verifica se perdas recentes ativaram o freio.
 * Retorna true se o bot deve PARAR de operar.
 */
function checkCircuitBreaker(bankrollUsdt, initialBankrollUsdt, recentLossesUsdt = 0) {
  const drawdownPct = recentLossesUsdt / bankrollUsdt;
  if (drawdownPct >= CONFIG.circuitBreakerPct) {
    log('WARN', 'RISK', `🚨 Circuit breaker ativado! Perda recente: ${(drawdownPct * 100).toFixed(1)}%`);
    return true;
  }
  const totalDrawdownPct = 1 - (bankrollUsdt / initialBankrollUsdt);
  if (totalDrawdownPct >= 0.20) {
    log('WARN', 'RISK', `🚨 Drawdown total acima de 20%! Banca: $${bankrollUsdt.toFixed(2)}`);
    return true;
  }
  return false;
}

/**
 * VaR simplificado (paramétrico) — estimativa de perda máxima esperada.
 * Usa desvio padrão dos retornos recentes com z-score 95%.
 */
function calcVaR(returns, confidenceLevel = 0.95) {
  if (!returns || returns.length < 10) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  const zScore = confidenceLevel === 0.99 ? 2.326 : 1.645; // 95% ou 99%
  const var95 = mean - zScore * stdDev;
  return parseFloat(var95.toFixed(4));
}

module.exports = {
  CONFIG,
  calcKelly,
  calcStakeUsdt,
  calcStopTakeProfit,
  checkRiskGuards,
  checkCircuitBreaker,
  calcVaR,
};
