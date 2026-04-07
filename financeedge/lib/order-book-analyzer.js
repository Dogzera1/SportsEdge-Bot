/**
 * order-book-analyzer.js
 * Análise do order book para melhorar sinais de trading.
 * Extrai features de bid/ask spread, liquidez, imbalance, etc.
 */

const { log } = require('./utils');

class OrderBookAnalyzer {
  constructor() {
    this.minDepth = 10; // Níveis mínimos para análise
    this.spreadThreshold = 0.001; // 0.1% spread máximo para boa liquidez
  }

  /**
   * Analisa order book e extrai features.
   * @param {Object} orderBook - { bids: [[price, volume]], asks: [[price, volume]] }
   * @param {string} symbol - Símbolo do par (ex: BTC/USDT)
   * @returns {Object} Features do order book
   */
  analyze(orderBook, symbol) {
    if (!orderBook || !orderBook.bids || !orderBook.asks) {
      log('WARN', 'ORDERBOOK', `${symbol}: Order book inválido`);
      return null;
    }

    const bids = orderBook.bids.slice(0, this.minDepth);
    const asks = orderBook.asks.slice(0, this.minDepth);

    if (bids.length < this.minDepth || asks.length < this.minDepth) {
      log('WARN', 'ORDERBOOK', `${symbol}: Profundidade insuficiente (${bids.length}/${asks.length})`);
      return null;
    }

    // Preços de referência
    const bestBid = parseFloat(bids[0][0]);
    const bestAsk = parseFloat(asks[0][0]);
    const midPrice = (bestBid + bestAsk) / 2;

    // 1. Spread relativo
    const spread = bestAsk - bestBid;
    const spreadPct = (spread / midPrice) * 100;

    // 2. Liquidez nos níveis
    const bidLiquidity = this.calculateLiquidity(bids, bestBid, 0.01); // 1% do preço
    const askLiquidity = this.calculateLiquidity(asks, bestAsk, 0.01);
    const totalLiquidity = bidLiquidity + askLiquidity;

    // 3. Imbalance (desequilíbrio entre compra/venda)
    const imbalance = this.calculateImbalance(bids, asks);

    // 4. Pressão de compra/venda
    const pressure = this.calculatePressure(bids, asks);

    // 5. Profundidade relativa
    const depthScore = this.calculateDepthScore(bids, asks, midPrice);

    // 6. Volume concentração
    const concentration = this.calculateConcentration(bids, asks);

    // 7. Wall detection (grandes ordens)
    const walls = this.detectWalls(bids, asks, midPrice);

    const features = {
      symbol,
      timestamp: Date.now(),
      bestBid,
      bestAsk,
      midPrice,
      spread,
      spreadPct: parseFloat(spreadPct.toFixed(4)),
      bidLiquidity: parseFloat(bidLiquidity.toFixed(2)),
      askLiquidity: parseFloat(askLiquidity.toFixed(2)),
      totalLiquidity: parseFloat(totalLiquidity.toFixed(2)),
      imbalance: parseFloat(imbalance.toFixed(4)),
      pressure: parseFloat(pressure.toFixed(4)),
      depthScore: parseFloat(depthScore.toFixed(4)),
      concentration: parseFloat(concentration.toFixed(4)),
      hasBidWall: walls.hasBidWall,
      hasAskWall: walls.hasAskWall,
      bidWallSize: walls.bidWallSize,
      askWallSize: walls.askWallSize,
      wallDistancePct: walls.wallDistancePct
    };

    // Classificação de liquidez
    features.liquidityClass = this.classifyLiquidity(features);
    features.spreadClass = this.classifySpread(features.spreadPct);
    features.imbalanceClass = this.classifyImbalance(features.imbalance);

    log('DEBUG', 'ORDERBOOK', `${symbol}: spread=${features.spreadPct}% imbalance=${features.imbalance} liquidity=${features.liquidityClass}`);

    return features;
  }

  /**
   * Calcula liquidez dentro de uma faixa de preço.
   */
  calculateLiquidity(orders, referencePrice, rangePct) {
    const range = referencePrice * rangePct;
    const lowerBound = referencePrice - range;
    const upperBound = referencePrice + range;

    let liquidity = 0;
    for (const [price, volume] of orders) {
      const p = parseFloat(price);
      const v = parseFloat(volume);
      if (p >= lowerBound && p <= upperBound) {
        liquidity += v * p; // Volume em quote currency
      }
    }

    return liquidity;
  }

  /**
   * Calcula imbalance entre compra e venda.
   * Retorna valor entre -1 (forte venda) e +1 (forte compra).
   */
  calculateImbalance(bids, asks) {
    const bidVolume = bids.reduce((sum, [_, vol]) => sum + parseFloat(vol), 0);
    const askVolume = asks.reduce((sum, [_, vol]) => sum + parseFloat(vol), 0);
    const totalVolume = bidVolume + askVolume;

    if (totalVolume === 0) return 0;
    return (bidVolume - askVolume) / totalVolume;
  }

  /**
   * Calcula pressão de compra/venda baseada na inclinação do order book.
   */
  calculatePressure(bids, asks) {
    // Pressão positiva = mais volume perto do best bid
    // Pressão negativa = mais volume perto do best ask

    const bidPressure = this.calculateWeightedPressure(bids, true);
    const askPressure = this.calculateWeightedPressure(asks, false);

    return bidPressure - askPressure; // -1 a +1
  }

  calculateWeightedPressure(orders, isBid) {
    if (orders.length === 0) return 0;

    let totalWeighted = 0;
    let totalVolume = 0;

    for (let i = 0; i < orders.length; i++) {
      const [price, volume] = orders[i];
      const p = parseFloat(price);
      const v = parseFloat(volume);

      // Peso decresce com a distância do topo
      const weight = 1 - (i / orders.length);
      totalWeighted += v * weight;
      totalVolume += v;
    }

    if (totalVolume === 0) return 0;
    return totalWeighted / totalVolume;
  }

  /**
   * Calcula score de profundidade (quão profundo é o order book).
   */
  calculateDepthScore(bids, asks, midPrice) {
    const bidDepth = this.calculateEffectiveDepth(bids, midPrice, -0.02); // 2% abaixo
    const askDepth = this.calculateEffectiveDepth(asks, midPrice, 0.02); // 2% acima

    // Normaliza para 0-1
    const maxExpected = midPrice * 0.02 * 1000; // Estimativa
    const score = Math.min((bidDepth + askDepth) / (2 * maxExpected), 1);

    return score;
  }

  calculateEffectiveDepth(orders, referencePrice, targetPct) {
    const targetPrice = referencePrice * (1 + targetPct);
    let depth = 0;

    for (const [price, volume] of orders) {
      const p = parseFloat(price);
      const v = parseFloat(volume);

      if ((targetPct < 0 && p <= targetPrice) || (targetPct > 0 && p >= targetPrice)) {
        depth += v * p;
      }
    }

    return depth;
  }

  /**
   * Calcula concentração de volume (quão concentrado está o volume).
   */
  calculateConcentration(bids, asks) {
    const totalBids = bids.length;
    const totalAsks = asks.length;

    if (totalBids === 0 || totalAsks === 0) return 0;

    // Volume nos top 3 níveis vs total
    const topBidVolume = bids.slice(0, 3).reduce((sum, [_, vol]) => sum + parseFloat(vol), 0);
    const topAskVolume = asks.slice(0, 3).reduce((sum, [_, vol]) => sum + parseFloat(vol), 0);
    const totalBidVolume = bids.reduce((sum, [_, vol]) => sum + parseFloat(vol), 0);
    const totalAskVolume = asks.reduce((sum, [_, vol]) => sum + parseFloat(vol), 0);

    const bidConcentration = totalBidVolume > 0 ? topBidVolume / totalBidVolume : 0;
    const askConcentration = totalAskVolume > 0 ? topAskVolume / totalAskVolume : 0;

    return (bidConcentration + askConcentration) / 2;
  }

  /**
   * Detecta walls (grandes ordens) no order book.
   */
  detectWalls(bids, asks, midPrice) {
    const avgBidSize = this.calculateAverageSize(bids);
    const avgAskSize = this.calculateAverageSize(asks);

    const bidWalls = this.findWalls(bids, avgBidSize * 5); // 5x maior que média
    const askWalls = this.findWalls(asks, avgAskSize * 5);

    const hasBidWall = bidWalls.length > 0;
    const hasAskWall = askWalls.length > 0;

    let bidWallSize = 0;
    let askWallSize = 0;
    let wallDistancePct = 0;

    if (hasBidWall) {
      const wall = bidWalls[0]; // Maior wall
      bidWallSize = wall.size;
      wallDistancePct = ((midPrice - wall.price) / midPrice) * 100;
    } else if (hasAskWall) {
      const wall = askWalls[0];
      askWallSize = wall.size;
      wallDistancePct = ((wall.price - midPrice) / midPrice) * 100;
    }

    return {
      hasBidWall,
      hasAskWall,
      bidWallSize: parseFloat(bidWallSize.toFixed(2)),
      askWallSize: parseFloat(askWallSize.toFixed(2)),
      wallDistancePct: parseFloat(wallDistancePct.toFixed(2))
    };
  }

  calculateAverageSize(orders) {
    if (orders.length === 0) return 0;
    const total = orders.reduce((sum, [_, vol]) => sum + parseFloat(vol), 0);
    return total / orders.length;
  }

  findWalls(orders, threshold) {
    const walls = [];
    for (const [price, volume] of orders) {
      const v = parseFloat(volume);
      if (v > threshold) {
        walls.push({ price: parseFloat(price), size: v });
      }
    }
    // Ordena por tamanho (maior primeiro)
    walls.sort((a, b) => b.size - a.size);
    return walls;
  }

  /**
   * Classifica liquidez.
   */
  classifyLiquidity(features) {
    const { totalLiquidity, spreadPct } = features;

    if (totalLiquidity > 100000 && spreadPct < 0.05) return 'ALTA';
    if (totalLiquidity > 10000 && spreadPct < 0.1) return 'MÉDIA';
    if (totalLiquidity > 1000 && spreadPct < 0.2) return 'BAIXA';
    return 'MUITO_BAIXA';
  }

  /**
   * Classifica spread.
   */
  classifySpread(spreadPct) {
    if (spreadPct < 0.05) return 'MUITO_BAIXO';
    if (spreadPct < 0.1) return 'BAIXO';
    if (spreadPct < 0.2) return 'MODERADO';
    return 'ALTO';
  }

  /**
   * Classifica imbalance.
   */
  classifyImbalance(imbalance) {
    if (imbalance > 0.3) return 'FORTE_COMPRA';
    if (imbalance > 0.1) return 'COMPRA';
    if (imbalance < -0.3) return 'FORTE_VENDA';
    if (imbalance < -0.1) return 'VENDA';
    return 'EQUILIBRADO';
  }

  /**
   * Gera sinal baseado no order book.
   */
  generateSignal(orderBookFeatures, priceTrend = 'neutral') {
    if (!orderBookFeatures) return null;

    let score = 0;
    const reasons = [];

    // Spread baixo é bom para execução
    if (orderBookFeatures.spreadClass === 'MUITO_BAIXO') {
      score += 1;
      reasons.push('Spread muito baixo');
    } else if (orderBookFeatures.spreadClass === 'ALTO') {
      score -= 1;
      reasons.push('Spread alto');
    }

    // Imbalance forte pode indicar direção
    if (orderBookFeatures.imbalanceClass === 'FORTE_COMPRA') {
      score += 2;
      reasons.push('Forte imbalance de compra');
    } else if (orderBookFeatures.imbalanceClass === 'COMPRA') {
      score += 1;
      reasons.push('Imbalance de compra');
    } else if (orderBookFeatures.imbalanceClass === 'FORTE_VENDA') {
      score -= 2;
      reasons.push('Forte imbalance de venda');
    } else if (orderBookFeatures.imbalanceClass === 'VENDA') {
      score -= 1;
      reasons.push('Imbalance de venda');
    }

    // Walls podem atuar como suporte/resistência
    if (orderBookFeatures.hasBidWall && orderBookFeatures.wallDistancePct < 1) {
      score += 1;
      reasons.push(`Wall de compra a ${orderBookFeatures.wallDistancePct.toFixed(2)}%`);
    }
    if (orderBookFeatures.hasAskWall && orderBookFeatures.wallDistancePct < 1) {
      score -= 1;
      reasons.push(`Wall de venda a ${orderBookFeatures.wallDistancePct.toFixed(2)}%`);
    }

    // Pressão positiva/negativa
    if (orderBookFeatures.pressure > 0.2) {
      score += 1;
      reasons.push('Pressão de compra no book');
    } else if (orderBookFeatures.pressure < -0.2) {
      score -= 1;
      reasons.push('Pressão de venda no book');
    }

    // Conflito com tendência de preço
    if (priceTrend === 'bullish' && score < -1) {
      score = Math.max(score, -1); // Limita sinal short em tendência bullish
      reasons.push('Conflito com tendência bullish');
    } else if (priceTrend === 'bearish' && score > 1) {
      score = Math.min(score, 1); // Limita sinal long em tendência bearish
      reasons.push('Conflito com tendência bearish');
    }

    if (Math.abs(score) < 1) return null;

    return {
      direction: score > 0 ? 'long' : 'short',
      score: parseFloat(score.toFixed(2)),
      confidence: Math.min(Math.abs(score) / 3, 1),
      reasons,
      features: orderBookFeatures
    };
  }

  /**
   * Combina sinal do order book com sinal técnico.
   */
  combineSignals(techSignal, orderBookSignal, weight = 0.3) {
    if (!techSignal) return orderBookSignal;
    if (!orderBookSignal) return techSignal;

    // Ajusta confiança baseada no order book
    let adjustedConfidence = techSignal.confidence;
    let adjustedEvPct = techSignal.evPct;

    if (orderBookSignal.direction === techSignal.direction) {
      // Confirmação: aumenta confiança
      adjustedConfidence = Math.min(techSignal.confidence + weight, 1);
      adjustedEvPct = techSignal.evPct * (1 + weight);
      techSignal.reasons.push(`Order book confirma ${techSignal.direction}`);
    } else {
      // Conflito: reduz confiança
      adjustedConfidence = techSignal.confidence * (1 - weight);
      adjustedEvPct = techSignal.evPct * (1 - weight);
      techSignal.reasons.push(`Order book conflita (sugere ${orderBookSignal.direction})`);
    }

    // Adiciona razões do order book
    techSignal.reasons.push(...orderBookSignal.reasons.map(r => `[OB] ${r}`));

    return {
      ...techSignal,
      confidence: parseFloat(adjustedConfidence.toFixed(3)),
      evPct: parseFloat(adjustedEvPct.toFixed(2)),
      orderBookScore: orderBookSignal.score,
      orderBookConfidence: orderBookSignal.confidence
    };
  }
}

module.exports = new OrderBookAnalyzer();