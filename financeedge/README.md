# FinanceEdge - Bot de Trading Cripto

FinanceEdge é um bot de trading automatizado para criptomoedas com foco em gestão de risco, análise técnica e simulação (paper trading). O bot opera via Telegram e inclui um servidor HTTP para monitoramento e controle.

## ✨ Funcionalidades

- **Análise Técnica Automatizada**: Gera sinais de compra/venda baseados em indicadores técnicos (RSI, MACD, Bandas de Bollinger, ATR)
- **Gestão de Risco Avançada**: Kelly Fractionado, circuit breakers, limites de exposição e stop-loss/take-profit dinâmicos
- **Paper Trading**: Simulação completa com slippage e taxas configuráveis
- **Integração Telegram**: Comandos via bot, alertas push e monitoramento em tempo real
- **API REST**: Servidor HTTP com endpoints para monitoramento, análise manual e controle
- **Banco de Dados SQLite**: Armazenamento local de trades, sinais e histórico
- **Multi-exchange**: Suporte a Binance e outras exchanges via CCXT

## 🚀 Instalação

### Pré-requisitos
- Node.js 18+
- SQLite3
- Conta no Telegram (para criar bot via @BotFather)

### Passos

1. **Clone o repositório**
```bash
git clone <seu-repositorio>
cd financeedge
```

2. **Instale dependências**
```bash
npm install
```

3. **Configure as variáveis de ambiente**
```bash
cp .env.example .env
# Edite o arquivo .env com suas configurações
```

4. **Configure o bot do Telegram**
- Crie um bot no Telegram com @BotFather
- Obtenha o token e adicione ao `.env` como `TELEGRAM_TOKEN`
- Inicie uma conversa com o bot e use `/start` para obter seu `chat_id`
- Adicione o `chat_id` ao `.env` como `TELEGRAM_CHAT_ID`

5. **Inicie o bot**
```bash
npm start
# Ou para desenvolvimento:
npm run dev
```

## ⚙️ Configuração

### Variáveis de Ambiente Principais

| Variável | Descrição | Padrão |
|----------|-----------|---------|
| `MODE` | Modo de operação: `paper` ou `real` | `paper` |
| `TELEGRAM_TOKEN` | Token do bot Telegram | - |
| `TELEGRAM_CHAT_ID` | IDs de chat autorizados | - |
| `EXCHANGE_NAME` | Nome da exchange | `binance` |
| `SYMBOLS` | Símbolos monitorados | `BTC/USDT,ETH/USDT` |
| `TIMEFRAME` | Timeframe de análise | `1h` |
| `CYCLE_MIN` | Ciclo de análise (minutos) | `60` |
| `MIN_CONFIDENCE` | Confiança mínima | `MÉDIA` |
| `MIN_EV` | EV mínimo para trade | `3` |

### Configuração de Risco

| Variável | Descrição | Padrão | Nota |
|----------|-----------|---------|------|
| `KELLY_FRACTION` | Fração do Kelly | `0.25` | Usa 25% do Kelly completo |
| `MAX_STAKE_PCT` | Stake máxima por trade | `0.05` | 5% da banca por trade |
| `MIN_STAKE_PCT` | Stake mínima por trade | `0.005` | 0.5% mínimo |
| `STOP_LOSS_PCT` | Stop-loss padrão (fallback) | `0.02` | ⚠️ **OBSOLETO** - Usar ATR |
| `TAKE_PROFIT_MULT` | Multiplicador TP | `2.0` | R:R 2:1 |
| `CIRCUIT_BREAKER_PCT` | Circuit breaker | `0.05` | 5% perda em 24h |
| `MAX_OPEN_TRADES` | Máx. trades abertos | `3` | Limite simultâneo |
| `MAX_TOTAL_EXPOSURE` | Exposição total máxima | `0.15` | 15% da banca total |

**⚠️ IMPORTANTE**: O stop-loss padrão é baseado em **ATR (Average True Range)** dinâmico, não em porcentagem fixa. A variável `STOP_LOSS_PCT` é usada apenas como fallback quando ATR não está disponível.

**Fórmula Stop-Loss**: `SL = EntryPrice ± (ATR × 1.5)`  
**Fórmula Take-Profit**: `TP = EntryPrice ± (ATR × 3.0)` (R:R 2:1)

## 🤖 Comandos do Telegram

- `/start` ou `/ajuda` - Ajuda e mostra seu chat_id
- `/status` - Banca atual, modo e resumo
- `/abertos` - Lista de trades abertos
- `/analise [par]` - Gera sinal para um par (ex: `/analise BTC/USDT`)
- `/sinais` - Últimos sinais gravados
- `/ciclo` - Força uma rodada de análise

## 🌐 API HTTP

O servidor HTTP roda na porta `3001` (configurável) e oferece:

### Endpoints Principais

- `GET /health` - Status do sistema
- `GET /prices` - Preços atuais dos símbolos
- `GET /analyze?symbol=BTC/USDT` - Análise manual
- `GET /signals?limit=20` - Sinais recentes
- `GET /open-trades` - Trades abertos com P&L não realizado
- `GET /trades-history?limit=30` - Histórico de trades
- `GET /roi` - Estatísticas de ROI
- `GET /bankroll` - Status da banca
- `POST /open-trade` - Abre trade manual (paper)
- `POST /close-trade` - Fecha trade manual
- `POST /set-bankroll` - Redefine valor da banca
- `POST /circuit-breaker` - Ativa/desativa circuit breaker

## 🏗️ Arquitetura e Considerações de Engenharia

### Estrutura do Projeto
```
financeedge/
├── bot.js              # Bot principal (Telegram + ciclo de análise)
├── server.js           # Servidor HTTP API (3001)
├── start.js           # Inicializador combinado
├── package.json       # Dependências Node.js
├── .env              # Variáveis de ambiente (NUNCA versionar)
├── .env.example      # Template de configuração
├── financeedge.db    # Banco de dados SQLite (WAL mode)
├── nixpacks.toml     # Configuração de build
├── railway.toml      # Configuração Railway
└── lib/              # Módulos internos
    ├── database.js   # Banco de dados e queries SQLite
    ├── data-engine.js # Integração CCXT com exchanges
    ├── financial-ml.js # Geração de sinais (indicadores técnicos)
    ├── risk-manager.js # Gestão de risco (Kelly, circuit breakers)
    ├── executor.js   # Execução de trades (paper/real)
    └── utils.js      # Utilitários (logs, HTTP, formatação)
```

### Decisões de Arquitetura

#### 1. **SQLite vs PostgreSQL**
- **SQLite**: Adequado para low-frequency trading (1H+), single process
- **WAL Mode**: Habilitado para melhor concorrência (`journal_mode = WAL`)
- **Limitação**: `database is locked` pode ocorrer sob alta carga
- **Recomendação**: Migrar para PostgreSQL se volume de trades aumentar

#### 2. **Concorrência e Idempotência**
- **Single Process**: Bot roda em único processo Node.js
- **Idempotência**: `clientOrderId` único por trade para evitar duplicação
- **Circuit Breakers**: Pausa automática após perdas excessivas (24h)

#### 3. **Latência e Timeframes**
- **Ciclo 60min**: Adequado para swing trading (1H+ timeframes)
- **Latência Railway**: ~200-500ms aceitável para timeframe 1H
- **NÃO adequado** para: Scalping, day trading (<5min timeframes)

#### 4. **Modularidade**
- **Separação de Responsabilidades**: Cada módulo tem função específica
- **Facilidade de Teste**: Módulos podem ser testados isoladamente
- **Extensibilidade**: Nova exchange? Modifique apenas `data-engine.js`

#### 5. **Segurança em Camadas**
1. **API Keys**: Permissões restritas (Trade only, no withdrawal)
2. **Environment Variables**: Configuração sensível fora do código
3. **Circuit Breakers**: Limites automáticos de perda
4. **Input Validation**: Validação de parâmetros em todos os endpoints
5. **Error Boundaries**: Tratamento de erros com fallbacks

## 🔧 Módulos Principais

### `financial-ml.js`
Gera sinais de trading baseados em análise técnica combinada:

#### Indicadores Técnicos
- **RSI** (sobrecompra/sobrevenda) - Filtro: RSI < 30 (long), RSI > 70 (short)
- **MACD** (cruzamento de médias) - Sinal: MACD histogram positivo/negativo
- **Bandas de Bollinger** (posição do preço) - Preço próximo às bandas
- **ATR** (volatilidade) - Para cálculo de stop-loss dinâmico
- **Volume** (confirmação) - Volume acima da média 20 períodos

#### Cálculo de EV (Expected Value)
O EV é calculado como uma **pontuação composta** baseada na convergência de indicadores:

```
EV Score = (RSI_Score + MACD_Score + BB_Score + Volume_Score) × Multiplicador_Confiança
```

**Fatores de Pontuação**:
- RSI em zona extrema: +2 pontos
- MACD com histograma forte: +2 pontos  
- Preço próximo à banda de Bollinger: +1 ponto
- Volume acima da média: +1 ponto
- Múltiplos indicadores alinhados: +1 ponto extra

**Multiplicador de Confiança**:
- ALTA (3+ indicadores): ×1.5
- MÉDIA (2 indicadores): ×1.0
- BAIXA (1 indicador): ×0.5

**⚠️ LIMITAÇÃO**: Este EV é uma **pontuação relativa**, não uma probabilidade matemática baseada em backtest histórico. Use `MIN_EV` como filtro de qualidade, não como garantia de lucro.

### `risk-manager.js`
Implementa gestão de risco quantitativa:

#### Kelly Criterion Fractionado
**Fórmula Completa de Kelly**:
```
f* = (p × (odds - 1) - (1 - p)) / (odds - 1)
onde:
  p = probabilidade de vitória = (EV + 1) / odds
  odds = payoff ratio (ex: 2.0 para R:R 2:1)
  EV = Expected Value em decimal (ex: 0.03 para 3%)
```

**Implementação no Bot**:
- **Kelly Fraction**: Usa apenas 25% do Kelly completo (`KELLY_FRACTION=0.25`)
- **Limites**: Stake entre 0.5% e 5% da banca (`MIN_STAKE_PCT`/`MAX_STAKE_PCT`)
- **Probabilidade Dinâmica**: Baseada na confiança do sinal:
  - ALTA: p estimada = 55% (fraction 0.25)
  - MÉDIA: p estimada = 52.5% (fraction 0.167) 
  - BAIXA: p estimada = 50% (fraction 0.10)

#### Stop-Loss Dinâmico (ATR-based)
**Fórmula**:
```
SL_Distance = ATR × Multiplier (padrão: 1.5)
TP_Distance = SL_Distance × R:R_Ratio (padrão: 2.0)

LONG: StopLoss = Entry - SL_Distance, TakeProfit = Entry + TP_Distance
SHORT: StopLoss = Entry + SL_Distance, TakeProfit = Entry - TP_Distance
```

**Vantagens vs % Fixo**:
- Adapta-se à volatilidade atual do ativo
- Evita stops muito apertados em alta volatilidade
- Evita stops muito largos em baixa volatilidade

#### Circuit Breakers
1. **Perdas Recentes (24h)**: Ativa se perdas > `CIRCUIT_BREAKER_PCT` (5%)
2. **Drawdown Total**: Ativa se drawdown total > 20% da banca inicial
3. **Recuperação Manual**: Requer intervenção via API ou reinício

#### Limites de Exposição
- **Trades Simultâneos**: Máximo `MAX_OPEN_TRADES` (padrão: 3)
- **Exposição Total**: Máximo `MAX_TOTAL_EXPOSURE` (15% da banca)
- **Correlação Implícita**: Limita exposição a ativos correlacionados

#### Value at Risk (VaR) Simplificado
Estimativa paramétrica de perda máxima esperada (95% confiança):
```
VaR_95 = Mean_Returns - 1.645 × StdDev_Returns
```
Usado para monitoramento, não para decisões de trading.

### `executor.js`
Simulação de execução com:
- **Slippage** configurável
- **Taxas** de exchange simuladas
- **Cálculo de P&L** realista

## 🚢 Deploy

### Railway
O projeto inclui configuração para deploy no Railway:
- `railway.toml` - Configuração Railway
- `nixpacks.toml` - Build configuration

```bash
railway up
```

### Docker (opcional)
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3001
CMD ["npm", "start"]
```

## ⚠️ Avisos de Segurança CRÍTICOS

### 🔴 ERRO GRAVE DE SEGURANÇA - PERMISSÕES DE API
**❌ ERRADO**: "Configure chaves com permissão READ-ONLY"
**✅ CORRETO**: Configure chaves com permissão **SPOT TRADING APENAS**, **NUNCA** habilite permissão de SAQUE (Withdrawal)

**Impacto**: Chaves READ-ONLY não permitem executar ordens. O bot não funcionará em modo real.
**Risco**: Se configurar permissão de Trade mas não desmarcar Withdrawal, um vazamento de chave resulta em roubo total dos fundos.

### Passos Seguros para Configurar API Keys:
1. Na exchange (ex: Binance), crie uma nova API Key
2. **HABILITE APENAS**: "Enable Spot & Margin Trading"
3. **DESABILITE COMPLETAMENTE**: "Enable Withdrawals"
4. **OPCIONAL**: Habilite "Enable Reading" para monitoramento
5. **NUNCA** compartilhe ou versiona suas chaves no Git

### ⚠️ Backtesting Obrigatório
**NÃO use este bot com capital real sem backtesting extensivo**. Paper trading é *forward testing* (tempo real). Você precisa de *backtesting* (dados históricos) para validar se a estratégia tem expectativa positiva antes de arriscar capital.

### ⚠️ Limitações do Bot
- **Swing Trade Apenas**: Ciclo de 60min + latência do Railway (~200-500ms) = apenas para timeframe 1H+
- **Indicadores Lagging**: RSI, MACD, Bollinger são baseados em preço passado
- **Sem Detecção de Regime**: Não há filtro de tendência (ex: EMA 200) para evitar trades contra tendência forte

### ⚠️ Monitoramento Essencial
1. **Circuit Breaker**: Ative e monitore perdas recentes (24h)
2. **Logs**: Verifique logs diariamente para erros de API
3. **SQLite WAL**: Banco de dados usa WAL mode para evitar `database is locked`
4. **Idempotência**: Implementado `clientOrderId` para evitar ordens duplicadas

## 📊 Backtesting e Validação (OBRIGATÓRIO)

**⚠️ AVISO CRÍTICO**: Não use este bot com capital real sem backtesting extensivo. Paper trading NÃO substitui backtesting histórico.

### Por que Backtesting é Essencial?
1. **Validação Estatística**: Testa se a estratégia tem expectativa positiva em dados históricos
2. **Drawdown Máximo**: Mede a pior perda consecutiva possível
3. **Shuffle Analysis**: Verifica se resultados não são por overfitting
4. **Regime Detection**: Identifica em quais condições de mercado a estratégia funciona/mal funciona

### Método de Backtesting Recomendado
1. **Baixe dados históricos** (OHLCV) para os símbolos desejados
2. **Execute a estratégia** em cada candle histórico
3. **Calcule métricas**:
   - Win Rate (% de trades lucrativos)
   - Profit Factor (Gross Profit / Gross Loss)
   - Maximum Drawdown (%)
   - Sharpe Ratio (retorno ajustado ao risco)
   - Expectancy = (Win% × AvgWin) - (Loss% × AvgLoss)

### Script de Backtesting (Exemplo)
```javascript
// backtest.js - Esqueleto básico
const { generateSignal } = require('./lib/financial-ml');
const historicalData = loadCSV('btc_1h_2024.csv');

let results = [];
for (let i = 100; i < historicalData.length; i++) {
  const window = historicalData.slice(i-100, i);
  const signal = generateSignal(window, 'BTC/USDT', '1h');
  if (signal) {
    // Simula trade e calcula P&L
    const tradeResult = simulateTrade(signal, historicalData[i+1]);
    results.push(tradeResult);
  }
}
console.log('Backtest Results:', calculateMetrics(results));
```

## 📈 Melhorias Futuras

### 🔴 Alta Prioridade (Pré-requisitos para Trading Real)
- [ ] **Backtesting Engine** - Script automatizado com métricas
- [ ] **Regime Detection** - Filtro de tendência (EMA 200) para evitar trades contra-tendência
- [ ] **Probabilidades Reais** - Substituir EV score por probabilidades baseadas em backtest

### 🟡 Média Prioridade
- [ ] **Otimização de Parâmetros** - Grid search para RSI/MACD thresholds
- [ ] **Order Book Features** - Adicionar profundidade do livro de ordens
- [ ] **Funding Rates** - Para trading de futuros (contango/backwardation)

### 🟢 Baixa Prioridade
- [ ] **Dashboard Web** - Interface visual com gráficos
- [ ] **Alertas Multiplataforma** - Email, SMS, Discord
- [ ] **Integração com mais Exchanges** - Bybit, OKX, Kraken
- [ ] **Estratégias Personalizáveis** - Editor visual de regras

## 📄 Licença

MIT

## 🤝 Contribuição

1. Fork o projeto
2. Crie uma branch (`git checkout -b feature/nova-funcionalidade`)
3. Commit suas mudanças (`git commit -m 'Add nova funcionalidade'`)
4. Push para a branch (`git push origin feature/nova-funcionalidade`)
5. Abra um Pull Request

## 🔍 Diagnóstico e Monitoramento

### Logs do Sistema
O bot usa formatação estruturada de logs:
```
[HH:MM:SS] [LEVEL] [TAG] Mensagem
```

**Exemplos de Logs Saudáveis**:
```
[14:30:01] [INFO] [BOT] Iniciando ciclo de análise (2 símbolos, 1h)
[14:30:15] [INFO] [BOT] BTC/USDT: Sinal LONG | Confiança: ALTA | EV: 4.5%
[14:30:16] [INFO] [BOT] Trade aberto: BTC/USDT LONG @ 65000.50 | stake $500.00
[14:31:00] [INFO] [TG] Alerta enviado para chat 8012415611
```

**Exemplos de Logs Problemáticos**:
```
[14:30:01] [ERROR] [TG] Token Telegram inválido ou revogado (401)
[14:30:15] [WARN] [BOT] ETH/USDT: API Binance timeout
[14:30:30] [WARN] [RISK] Circuit breaker ativado! Perda recente: 6.2%
```

### Endpoints de Debug
Além da API principal, endpoints úteis para diagnóstico:

- `GET /debug-indicators?symbol=BTC/USDT` - Valores atuais de RSI, MACD, Bollinger
- `GET /cache-status` - Status do cache de dados OHLCV
- `GET /db-stats` - Estatísticas do banco de dados (trades, sinais)
- `GET /config` - Configuração atual carregada (sem senhas)

### Monitoramento Diário
**Checklist de Saúde do Bot**:
1. ✅ Logs sem erros de API (Binance/Telegram)
2. ✅ Circuit breaker desativado
3. ✅ Banco de dados acessível
4. ✅ Ciclos rodando no intervalo configurado
5. ✅ Alertas Telegram sendo recebidos

### Tratamento de Erros
O bot implementa:
- **Retry com backoff** para falhas de API
- **Circuit breakers** para perdas excessivas
- **Fallback para dados simulados** quando API falha
- **WAL mode no SQLite** para evitar corrupção de banco

## 📞 Suporte e Troubleshooting

### Problemas Comuns

1. **Bot não responde no Telegram**
   - Verifique `TELEGRAM_TOKEN` no `.env`
   - Use `/start` no chat privado com o bot
   - Confira se `TELEGRAM_CHAT_ID` está correto

2. **Erros de API da Exchange**
   - Verifique conexão com a internet
   - Confira se `EXCHANGE_API_KEY` tem permissão de leitura
   - A exchange pode estar em manutenção

3. **Database is locked**
   - SQLite está em WAL mode para concorrência
   - Reinicie o bot se persistir
   - Considere migrar para PostgreSQL em produção

4. **Sem sinais sendo gerados**
   - Verifique `SYMBOLS` no `.env`
   - Confira `MIN_CONFIDENCE` e `MIN_EV`
   - Use `/analise BTC/USDT` para testar manualmente

### Suporte
Para issues e dúvidas:
- **Issues no GitHub**: Reporte bugs com logs completos
- **Documentação da API**: Consulte endpoints acima
- **Logs do Bot**: Sempre inclua logs ao reportar problemas
- **Backtesting**: Nunca pule esta etapa antes de usar capital real

---

**⚠️ Aviso Legal**: Trading envolve riscos significativos. Este software é fornecido "como está", sem garantias. O autor não se responsabiliza por perdas financeiras. Use por sua conta e risco.