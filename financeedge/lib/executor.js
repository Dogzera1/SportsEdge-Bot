/**
 * executor.js
 * Paper Trading: simula execução com slippage + fees.
 * Modo real (future): integração API Binance.
 */
const { log } = require('./utils');

const PAPER_SLIPPAGE = parseFloat(process.env.PAPER_SLIPPAGE || '0.001'); // 0.1%
const PAPER_FEE_RATE = parseFloat(process.env.PAPER_FEE_RATE || '0.001'); // 0.1% maker/taker

/**
 * Simula abertura de trade em paper mode.
 * Aplica slippage no entry price.
 */
function paperOpen(signal, stakeUsdt, stopLoss, takeProfit) {
  const { symbol, direction, price, timeframe } = signal;
  const slippage = direction === 'long'
    ? price * (1 + PAPER_SLIPPAGE)
    : price * (1 - PAPER_SLIPPAGE);

  const entryFee = stakeUsdt * PAPER_FEE_RATE;
  const effectiveStake = stakeUsdt - entryFee;

  return {
    symbol,
    direction,
    entryPrice: parseFloat(slippage.toFixed(6)),
    stopLoss,
    takeProfit,
    stakeUsdt: parseFloat(effectiveStake.toFixed(4)),
    feesEntry: parseFloat(entryFee.toFixed(4)),
    timeframe,
    mode: 'paper',
    openedAt: new Date().toISOString(),
  };
}

/**
 * Simula fechamento de trade.
 * Calcula P&L incluindo fees e slippage de saída.
 */
function paperClose(trade, exitPrice) {
  const slippage = trade.direction === 'long'
    ? exitPrice * (1 - PAPER_SLIPPAGE)
    : exitPrice * (1 + PAPER_SLIPPAGE);

  const exitFee = trade.stakeUsdt * PAPER_FEE_RATE;
  const effectiveExit = parseFloat(slippage.toFixed(6));

  let pnlPct;
  if (trade.direction === 'long') {
    pnlPct = (effectiveExit - trade.entryPrice) / trade.entryPrice;
  } else {
    pnlPct = (trade.entryPrice - effectiveExit) / trade.entryPrice;
  }

  const pnlUsdt = parseFloat((trade.stakeUsdt * pnlPct - exitFee).toFixed(4));
  const totalFees = parseFloat(((trade.feesEntry || 0) + exitFee).toFixed(4));
  const result = pnlUsdt >= 0 ? 'win' : 'loss';

  return {
    exitPrice: effectiveExit,
    pnlUsdt,
    pnlPct: parseFloat((pnlPct * 100).toFixed(4)),
    feesUsdt: totalFees,
    result,
    closedAt: new Date().toISOString(),
  };
}

/**
 * Verifica se trade atingiu stop-loss ou take-profit.
 * candle = { high, low, close }
 */
function checkStopTakeProfit(trade, candle) {
  const { stopLoss, takeProfit, direction, entryPrice } = trade;
  if (!stopLoss || !candle) return null;

  if (direction === 'long') {
    if (candle.low <= stopLoss) {
      return { triggered: 'stop_loss', exitPrice: stopLoss };
    }
    if (takeProfit && candle.high >= takeProfit) {
      return { triggered: 'take_profit', exitPrice: takeProfit };
    }
  } else {
    if (candle.high >= stopLoss) {
      return { triggered: 'stop_loss', exitPrice: stopLoss };
    }
    if (takeProfit && candle.low <= takeProfit) {
      return { triggered: 'take_profit', exitPrice: takeProfit };
    }
  }
  return null;
}

/**
 * Calcula P&L não realizado de um trade aberto.
 */
function calcUnrealizedPnL(trade, currentPrice) {
  let pnlPct;
  if (trade.direction === 'long') {
    pnlPct = (currentPrice - trade.entry_price) / trade.entry_price;
  } else {
    pnlPct = (trade.entry_price - currentPrice) / trade.entry_price;
  }
  const pnlUsdt = parseFloat((trade.stake_usdt * pnlPct).toFixed(4));
  return { pnlUsdt, pnlPct: parseFloat((pnlPct * 100).toFixed(4)) };
}

module.exports = {
  paperOpen,
  paperClose,
  checkStopTakeProfit,
  calcUnrealizedPnL,
  PAPER_SLIPPAGE,
  PAPER_FEE_RATE,
};
