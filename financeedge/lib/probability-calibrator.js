/**
 * probability-calibrator.js
 * Calibração de probabilidades baseada em backtest histórico.
 * Substitui o EV score por probabilidades reais.
 */

const fs = require('fs');
const path = require('path');
const { log } = require('./utils');

class ProbabilityCalibrator {
  constructor() {
    this.probabilities = new Map(); // symbol -> { conditionHash -> { wins, losses, probability } }
    this.minSamples = 50; // mínimo de amostras para considerar probabilidade confiável
    this.decayFactor = 0.95; // fator de decaimento para amostras antigas
    this.loadFromFile();
  }

  /**
   * Gera hash único para uma condição de trade
   */
  generateConditionHash(signal) {
    // Baseado nos indicadores técnicos
    const features = {
      rsiZone: this.getRSIZone(signal.rsi),
      macdSignal: this.getMACDSignal(signal.macdHist),
      bbPosition: this.getBBPosition(signal.bbPosition),
      regime: signal.regime || 'unknown',
      volumeSignal: signal.volume > signal.volSMA ? 'high' : 'normal'
    };

    return JSON.stringify(features);
  }

  getRSIZone(rsi) {
    const RSI_OVERSOLD = parseInt(process.env.RSI_OVERSOLD) || 30;
    const RSI_OVERBOUGHT = parseInt(process.env.RSI_OVERBOUGHT) || 70;

    if (rsi < RSI_OVERSOLD) return 'oversold';
    if (rsi < RSI_OVERSOLD + 10) return 'low';
    if (rsi > RSI_OVERBOUGHT) return 'overbought';
    if (rsi > RSI_OVERBOUGHT - 10) return 'high';
    return 'neutral';
  }

  getMACDSignal(histogram) {
    if (!histogram) return 'neutral';
    if (histogram > 0) return 'bullish';
    return 'bearish';
  }

  getBBPosition(position) {
    const bbLowerThreshold = 0.1;
    const bbUpperThreshold = 0.9;
    const bbMidLowerThreshold = 0.25;
    const bbMidUpperThreshold = 0.75;

    if (position <= bbLowerThreshold) return 'lower_band';
    if (position <= bbMidLowerThreshold) return 'below_middle';
    if (position >= bbUpperThreshold) return 'upper_band';
    if (position >= bbMidUpperThreshold) return 'above_middle';
    return 'middle';
  }

  /**
   * Atualiza probabilidade com resultado de trade
   */
  updateProbability(signal, result) {
    const hash = this.generateConditionHash(signal);
    const symbol = signal.symbol;

    if (!this.probabilities.has(symbol)) {
      this.probabilities.set(symbol, new Map());
    }

    const symbolProbs = this.probabilities.get(symbol);
    if (!symbolProbs.has(hash)) {
      symbolProbs.set(hash, { wins: 0, losses: 0, probability: 0.5 });
    }

    const prob = symbolProbs.get(hash);

    // Aplica decaimento para amostras antigas
    prob.wins *= this.decayFactor;
    prob.losses *= this.decayFactor;

    // Adiciona nova amostra
    if (result === 'win') {
      prob.wins += 1;
    } else {
      prob.losses += 1;
    }

    // Calcula nova probabilidade
    const total = prob.wins + prob.losses;
    if (total > 0) {
      prob.probability = prob.wins / total;
    }

    // Salva periodicamente
    if (Math.random() < 0.1) { // 10% chance de salvar a cada update
      this.saveToFile();
    }

    return prob.probability;
  }

  /**
   * Obtém probabilidade estimada para um sinal
   */
  getProbability(signal) {
    const hash = this.generateConditionHash(signal);
    const symbol = signal.symbol;

    if (!this.probabilities.has(symbol)) {
      return 0.5; // Probabilidade neutra se não houver dados
    }

    const symbolProbs = this.probabilities.get(symbol);
    if (!symbolProbs.has(hash)) {
      return 0.5; // Probabilidade neutra se condição não vista
    }

    const prob = symbolProbs.get(hash);
    const totalSamples = prob.wins + prob.losses;

    if (totalSamples < this.minSamples) {
      // Interpola entre probabilidade observada e neutra baseada no número de amostras
      const weight = totalSamples / this.minSamples;
      return weight * prob.probability + (1 - weight) * 0.5;
    }

    return prob.probability;
  }

  /**
   * Calcula EV real baseado em probabilidade e odds
   */
  calculateRealEV(probability, odds) {
    // EV = (probability * (odds - 1)) - (1 - probability)
    return (probability * (odds - 1)) - (1 - probability);
  }

  /**
   * Substitui o EV score por EV real
   */
  getRealEV(signal, odds = 2.0) {
    const probability = this.getProbability(signal);
    const realEV = this.calculateRealEV(probability, odds);

    // Converte para porcentagem
    const evPct = realEV * 100;

    // Ajusta confiança baseada no número de amostras
    const hash = this.generateConditionHash(signal);
    const symbol = signal.symbol;
    let confidence = 'BAIXA';

    if (this.probabilities.has(symbol)) {
      const symbolProbs = this.probabilities.get(symbol);
      if (symbolProbs.has(hash)) {
        const prob = symbolProbs.get(hash);
        const totalSamples = prob.wins + prob.losses;

        if (totalSamples >= 100) confidence = 'ALTA';
        else if (totalSamples >= 30) confidence = 'MÉDIA';
      }
    }

    return {
      probability: parseFloat(probability.toFixed(4)),
      evPct: parseFloat(evPct.toFixed(2)),
      confidence,
      realEV: parseFloat(realEV.toFixed(4))
    };
  }

  /**
   * Executa backtesting para calibrar probabilidades iniciais
   */
  async calibrateFromBacktest(symbol, historicalData, timeframe = '1h') {
    log('INFO', 'PROB', `Calibrando probabilidades para ${symbol} (${historicalData.length} candles)`);

    const { generateSignal } = require('./financial-ml');
    let calibrated = 0;

    // Janela deslizante
    const lookback = Math.min(100, historicalData.length - 10);

    for (let i = lookback; i < historicalData.length - 1; i++) {
      const window = historicalData.slice(i - lookback, i);

      try {
        const signal = generateSignal(window, symbol, timeframe);

        if (signal) {
          // Simula trade simples (próximo candle)
          const entryCandle = historicalData[i];
          const exitCandle = historicalData[i + 1];

          let result = 'loss';
          if (signal.direction === 'long') {
            if (exitCandle.close > entryCandle.close) result = 'win';
          } else {
            if (exitCandle.close < entryCandle.close) result = 'win';
          }

          this.updateProbability(signal, result);
          calibrated++;
        }
      } catch (error) {
        // Ignora erros individuais
      }
    }

    log('INFO', 'PROB', `Calibração concluída: ${calibrated} sinais processados para ${symbol}`);
    this.saveToFile();
    return calibrated;
  }

  /**
   * Persistência em arquivo
   */
  saveToFile() {
    try {
      const data = {};
      for (const [symbol, symbolProbs] of this.probabilities) {
        data[symbol] = {};
        for (const [hash, prob] of symbolProbs) {
          data[symbol][hash] = prob;
        }
      }

      fs.writeFileSync(
        path.join(__dirname, '..', 'probability-cache.json'),
        JSON.stringify(data, null, 2)
      );
    } catch (error) {
      log('ERROR', 'PROB', `Erro ao salvar probabilidades: ${error.message}`);
    }
  }

  loadFromFile() {
    try {
      const filePath = path.join(__dirname, '..', 'probability-cache.json');
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        for (const [symbol, symbolProbs] of Object.entries(data)) {
          const map = new Map();
          for (const [hash, prob] of Object.entries(symbolProbs)) {
            map.set(hash, prob);
          }
          this.probabilities.set(symbol, map);
        }

        log('INFO', 'PROB', `Probabilidades carregadas: ${this.probabilities.size} símbolos`);
      }
    } catch (error) {
      log('ERROR', 'PROB', `Erro ao carregar probabilidades: ${error.message}`);
    }
  }

  /**
   * Estatísticas do calibrador
   */
  getStats() {
    let totalConditions = 0;
    let totalSamples = 0;
    let avgSamples = 0;

    for (const symbolProbs of this.probabilities.values()) {
      totalConditions += symbolProbs.size;
      for (const prob of symbolProbs.values()) {
        totalSamples += prob.wins + prob.losses;
      }
    }

    if (totalConditions > 0) {
      avgSamples = totalSamples / totalConditions;
    }

    return {
      symbols: this.probabilities.size,
      totalConditions,
      totalSamples,
      avgSamples: parseFloat(avgSamples.toFixed(1))
    };
  }
}

module.exports = new ProbabilityCalibrator();