/**
 * financial-ml.js
 * Indicadores técnicos e geração de sinais de trade.
 * RSI, MACD, Bollinger Bands, ATR — sem dependências externas.
 */
const { log } = require('./utils');

// ── Indicadores ──

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
}

function calcEMA(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return parseFloat(ema.toFixed(6));
}

function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  if (emaFast === null || emaSlow === null) return null;
  const macdLine = emaFast - emaSlow;

  // Calcula signal line (EMA do MACD)
  const macdHistory = [];
  for (let i = slow - 1; i < closes.length; i++) {
    const subFast = calcEMA(closes.slice(0, i + 1), fast);
    const subSlow = calcEMA(closes.slice(0, i + 1), slow);
    if (subFast !== null && subSlow !== null) macdHistory.push(subFast - subSlow);
  }
  const signalLine = calcEMA(macdHistory, signal);
  const histogram = signalLine !== null ? parseFloat((macdLine - signalLine).toFixed(6)) : null;

  return {
    macd: parseFloat(macdLine.toFixed(6)),
    signal: signalLine,
    histogram
  };
}

function calcBollingerBands(closes, period = 20, stdDev = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / period;
  const sd = Math.sqrt(variance);
  const upper = mean + stdDev * sd;
  const lower = mean - stdDev * sd;
  const current = closes[closes.length - 1];
  // Posição dentro das bandas: 0 = lower, 0.5 = middle, 1 = upper
  const position = sd > 0 ? parseFloat(((current - lower) / (upper - lower)).toFixed(4)) : 0.5;

  return {
    upper: parseFloat(upper.toFixed(6)),
    middle: parseFloat(mean.toFixed(6)),
    lower: parseFloat(lower.toFixed(6)),
    width: parseFloat((upper - lower).toFixed(6)),
    position
  };
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const { high, low, close: prevClose } = candles[i - 1];
    const { high: h, low: l } = candles[i];
    const tr = Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
    trs.push(tr);
  }
  if (trs.length < period) return null;
  const atr = trs.slice(-period).reduce((a, b) => a + b, 0) / period;
  return parseFloat(atr.toFixed(6));
}

function calcVolumeSMA(volumes, period = 20) {
  if (volumes.length < period) return null;
  const slice = volumes.slice(-period);
  return parseFloat((slice.reduce((a, b) => a + b, 0) / period).toFixed(2));
}

// ── Geração de Sinal ──

/**
 * Analisa candles e retorna sinal de trade.
 * Returns: { direction, confidence, evPct, rsi, macdHist, bbPosition, atr, price, volume, reasons }
 */
function generateSignal(candles, symbol, timeframe = '1h') {
  if (!candles || candles.length < 50) {
    log('WARN', 'ML', `${symbol}: candles insuficientes (${candles?.length || 0})`);
    return null;
  }

  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const currentPrice = closes[closes.length - 1];
  const currentVol = volumes[volumes.length - 1];

  const rsi = calcRSI(closes, 14);
  const macd = calcMACD(closes);
  const bb = calcBollingerBands(closes, 20);
  const atr = calcATR(candles, 14);
  const volSMA = calcVolumeSMA(volumes, 20);

  if (rsi === null || !macd || !bb || atr === null) {
    log('WARN', 'ML', `${symbol}: indicadores insuficientes`);
    return null;
  }

  // Sistema de pontuação: acumula sinais de alta (+) e baixa (-)
  let score = 0;
  const reasons = [];

  // RSI
  if (rsi < 30) { score += 2; reasons.push(`RSI oversold (${rsi})`); }
  else if (rsi < 40) { score += 1; reasons.push(`RSI baixo (${rsi})`); }
  else if (rsi > 70) { score -= 2; reasons.push(`RSI overbought (${rsi})`); }
  else if (rsi > 60) { score -= 1; reasons.push(`RSI alto (${rsi})`); }

  // MACD histogram
  if (macd.histogram !== null) {
    if (macd.histogram > 0 && macd.macd > 0) { score += 2; reasons.push('MACD bullish'); }
    else if (macd.histogram > 0) { score += 1; reasons.push('MACD hist positivo'); }
    else if (macd.histogram < 0 && macd.macd < 0) { score -= 2; reasons.push('MACD bearish'); }
    else if (macd.histogram < 0) { score -= 1; reasons.push('MACD hist negativo'); }
  }

  // Bollinger Bands
  if (bb.position <= 0.1) { score += 2; reasons.push('Preço na BB inferior'); }
  else if (bb.position <= 0.25) { score += 1; reasons.push('Preço abaixo da BB média'); }
  else if (bb.position >= 0.9) { score -= 2; reasons.push('Preço na BB superior'); }
  else if (bb.position >= 0.75) { score -= 1; reasons.push('Preço acima da BB média'); }

  // Volume confirmação
  if (volSMA && currentVol > volSMA * 1.5) {
    const sign = score > 0 ? 1 : -1;
    score += sign * 1;
    reasons.push(`Volume acima da média (${(currentVol / volSMA).toFixed(1)}x)`);
  }

  // Sem sinal claro
  if (Math.abs(score) < 2) return null;

  const direction = score > 0 ? 'long' : 'short';
  const absScore = Math.abs(score);

  let confidence, evPct;
  if (absScore >= 6) { confidence = 'ALTA'; evPct = 8 + absScore; }
  else if (absScore >= 4) { confidence = 'MÉDIA'; evPct = 4 + absScore; }
  else { confidence = 'BAIXA'; evPct = 1 + absScore; }

  log('INFO', 'ML', `${symbol} ${timeframe}: ${direction.toUpperCase()} score=${score} conf=${confidence} ev=${evPct}%`);

  return {
    symbol,
    timeframe,
    direction,
    confidence,
    evPct: parseFloat(evPct.toFixed(2)),
    rsi,
    macdHist: macd.histogram,
    bbPosition: bb.position,
    atr,
    price: parseFloat(currentPrice.toFixed(6)),
    volume: parseFloat(currentVol.toFixed(2)),
    bb,
    macd,
    reasons,
    score
  };
}

module.exports = {
  calcRSI,
  calcEMA,
  calcMACD,
  calcBollingerBands,
  calcATR,
  calcVolumeSMA,
  generateSignal,
};
