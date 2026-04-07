/**
 * calibrate-probabilities.js
 * Script para calibrar probabilidades iniciais usando backtest histórico.
 */

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');
const probabilityCalibrator = require('./lib/probability-calibrator');

async function calibrateFromFile(dataFile, symbol = 'BTC/USDT', timeframe = '1h') {
  console.log('🔧 Calibrando probabilidades...');
  console.log(`📊 Arquivo: ${dataFile}`);
  console.log(`📈 Símbolo: ${symbol} | Timeframe: ${timeframe}`);

  // Carrega dados históricos
  if (!fs.existsSync(dataFile)) {
    console.error(`❌ Arquivo não encontrado: ${dataFile}`);
    process.exit(1);
  }

  const content = fs.readFileSync(dataFile, 'utf8');
  const lines = content.trim().split('\n');
  const historicalData = [];

  // Pula header se existir
  let startIdx = lines[0].includes('timestamp') ? 1 : 0;

  for (let i = startIdx; i < lines.length; i++) {
    const parts = lines[i].trim().split(',');
    if (parts.length < 6) continue;

    historicalData.push({
      ts: parseInt(parts[0]),
      open: parseFloat(parts[1]),
      high: parseFloat(parts[2]),
      low: parseFloat(parts[3]),
      close: parseFloat(parts[4]),
      volume: parseFloat(parts[5])
    });
  }

  console.log(`📊 Carregados ${historicalData.length} candles`);

  if (historicalData.length < 200) {
    console.warn(`⚠️  Dados insuficientes para calibração robusta (mínimo recomendado: 200 candles)`);
  }

  // Executa calibração
  const calibrated = await probabilityCalibrator.calibrateFromBacktest(
    symbol,
    historicalData,
    timeframe
  );

  // Mostra estatísticas
  const stats = probabilityCalibrator.getStats();
  console.log('\n📈 Estatísticas da Calibração:');
  console.log(`   Símbolos: ${stats.symbols}`);
  console.log(`   Condições únicas: ${stats.totalConditions}`);
  console.log(`   Amostras totais: ${stats.totalSamples}`);
  console.log(`   Média amostras/condição: ${stats.avgSamples}`);

  console.log(`\n✅ Calibração concluída: ${calibrated} sinais processados`);
  console.log(`💾 Probabilidades salvas em probability-cache.json`);

  // Exemplo de algumas probabilidades calibradas
  console.log('\n🔍 Exemplos de probabilidades calibradas:');

  // Pega algumas condições aleatórias para mostrar
  const symbolProbs = probabilityCalibrator.probabilities.get(symbol);
  if (symbolProbs) {
    let count = 0;
    for (const [hash, prob] of symbolProbs) {
      if (count >= 5) break;

      const features = JSON.parse(hash);
      console.log(`   ${features.rsiZone} | ${features.macdSignal} | ${features.bbPosition}`);
      console.log(`     Probabilidade: ${(prob.probability * 100).toFixed(1)}%`);
      console.log(`     Amostras: ${Math.round(prob.wins + prob.losses)} (${Math.round(prob.wins)}W/${Math.round(prob.losses)}L)`);
      console.log('');
      count++;
    }
  }

  return calibrated;
}

// Execução
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Uso: node calibrate-probabilities.js <arquivo_csv> [símbolo] [timeframe]');
    console.log('Exemplo: node calibrate-probabilities.js btc_1h_2024.csv BTC/USDT 1h');
    console.log('\nFormato CSV esperado: timestamp,open,high,low,close,volume');
    process.exit(1);
  }

  const dataFile = args[0];
  const symbol = args[1] || 'BTC/USDT';
  const timeframe = args[2] || '1h';

  calibrateFromFile(dataFile, symbol, timeframe).catch(error => {
    console.error('❌ Erro na calibração:', error);
    process.exit(1);
  });
}

module.exports = { calibrateFromFile };