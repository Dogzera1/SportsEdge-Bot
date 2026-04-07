# SportsEdge Bot

Bot autônomo de Telegram para análise automática de apostas esportivas, baseado em Valor Esperado (EV) e Kelly Criterion, alimentado por IA (DeepSeek ou Claude).

> **Status (Abril 2026 — Patch 26.5):** Sistema multi-esporte — **LoL Esports**, **MMA**, **Tênis** e **Futebol** operacionais. Cada esporte roda em bot Telegram independente (token separado). Odds via **OddsPapi v4** (esports) e **The Odds API** (futebol/MMA/tênis). Futebol usa **API-Football** para dados de forma, H2H e standings. MMA e Tênis usam **ESPN API** (gratuita) para records de lutadores e rankings ATP/WTA. Todos os esportes passam por pré-filtro ML antes de chamar a IA. Settlement automático em todos os esportes.
>
> **Produção (Railway):** No boot, `start.js` imprime `[LAUNCHER] PORT=… | DB=…` e sobe **dois** processos (`server.js` depois `bot.js`). Logs típicos: sync OddsPapi em lotes, `Force-fetch live` para torneios ao vivo, partidas LoL com `odds: X/Y` e lista `sem match` quando o slug OddsPapi não casa com o par Riot/PandaScore. Resposta **HTTP 429** da OddsPapi ativa **backoff de 2 horas** (nenhum fetch/re-fetch até expirar — ver `/debug-odds`). Sem `CLAUDE_API_KEY`, o sistema usa só **DeepSeek** (fallback Claude desligado).

---

## Arquitetura

```
┌──────────────────────────────────────────────┐
│                  start.js                    │
│       spawna server + bot com                │
│       auto-restart em falha                  │
└──────────┬───────────────────────────────────┘
           │
┌──────────▼───────────────────────────────────┐
│           bot.js — Telegram Bot              │
│                                              │
│  Esports (LoL):                              │
│  • Auto-análise ao vivo (ciclo de 6 min)     │
│  • Auto-análise pré-jogo (upcoming <=24h)    │
│  • Alertas de draft e line movement          │
│  • Patch meta auto-fetch (ddragon, 14d)      │
│                                              │
│  MMA:                                        │
│  • Loop independente a cada 6h               │
│  • ESPN scoreboard + athlete search fallback │
│  • ML pré-filtro (record ESPN → win rate)    │
│  • Análise DeepSeek com P modelo no prompt   │
│                                              │
│  Tênis:                                      │
│  • Loop independente a cada 20 min           │
│  • ESPN rankings ATP/WTA + form do torneio   │
│  • ML pré-filtro (ranking → probabilidade)   │
│  • Análise DeepSeek com P modelo no prompt   │
│                                              │
│  Futebol:                                    │
│  • Loop independente a cada 6h               │
│  • Fixtures pré-carregadas em batch (1 call) │
│  • Dados reais: forma, H2H, standings        │
│    via API-Football (lib/football-api.js)    │
│  • ML com dados reais (lib/football-ml.js)   │
│  • Settlement via fixture ID API-Football    │
│                                              │
│  Todos os esportes:                          │
│  • Fair Odds calculadas pelo modelo ML       │
│  • Settlement automático a cada 30 min       │
│  • Bots Telegram independentes por esporte   │
└──────────┬───────────────────────────────────┘
           │ HTTP localhost:PORT
┌──────────▼───────────────────────────────────┐
│         server.js — API Aggregator           │
│                                              │
│  Fontes de partidas:                         │
│    Riot / LoL Esports API + PandaScore       │
│    The Odds API (MMA / Tênis / Futebol)      │
│                                              │
│  Odds:                                       │
│    OddsPapi v4 — 1xBet (esports round-robin) │
│    The Odds API — EU (MMA/Tênis/Futebol)     │
│                                              │
│  Análise IA:                                 │
│    DeepSeek (deepseek-chat) — padrão         │
│    Anthropic Claude — fallback               │
│    Pré-filtro ML local (lib/ml.js)           │
│    Pré-filtro ML futebol (lib/football-ml.js)│
│                                              │
│  Dados gratuitos externos:                   │
│    ESPN API — MMA records + rankings tênis   │
│                                              │
│  sportsedge.db (SQLite via volume Railway)   │
│  users | events | matches | tips             │
│  odds_history | match_results | api_usage    │
│  pro_champ_stats | pro_player_champ_stats    │
│  synced_matches                              │
└──────────────────────────────────────────────┘
```

---

## Pré-requisitos

- Node.js 18+
- Bot Telegram criado via [@BotFather](https://t.me/BotFather) — um por esporte ativo
- Chave **DeepSeek API** (recomendado) ou **Anthropic Claude API**
- Chave da LoL Esports API (Riot Games) — esports
- Token PandaScore — torneios fora da Riot (schedules + stats + sync de resultados pro) — esports
- Chave OddsPapi — odds esports LoL via 1xBet ([oddspapi.io](https://oddspapi.io), plano free: 250 req/mês) — esports
- Chave **The Odds API** — odds para futebol, MMA e tênis
- Chave **API-Football** (`api-sports.io`) — dados de forma, H2H e standings para futebol (free tier: 100 req/dia)
- **ESPN API** — gratuita, sem chave; usada automaticamente para MMA e Tênis

---

## Configuração (`.env`)

```env
# ── Telegram — um token por esporte ──
TELEGRAM_TOKEN_ESPORTS=seu_token_bot
TELEGRAM_TOKEN_MMA=seu_token_mma        # opcional
TELEGRAM_TOKEN_TENNIS=seu_token_tennis  # opcional
TELEGRAM_TOKEN_FOOTBALL=seu_token_fb    # opcional

# ── APIs de IA (pelo menos uma obrigatória) ──
DEEPSEEK_API_KEY=sk-...                 # DeepSeek (recomendado — mais barato)
CLAUDE_API_KEY=sk-ant-api03-...         # Anthropic Claude (fallback)

# ── APIs de dados — esports ──
LOL_API_KEY=sua_chave_lol               # LoL Esports API (Riot Games)
ODDS_API_KEY=sua_chave_oddspapi         # OddsPapi v4 (aceita: ODDSPAPI_KEY, ODDS_PAPI_KEY, ESPORTS_ODDS_KEY)
PANDASCORE_TOKEN=seu_token              # PandaScore (obrigatório para sync de stats pro)

# ── APIs de dados — futebol/MMA/tênis ──
THE_ODDS_API_KEY=sua_chave              # The Odds API (odds para futebol, MMA, tênis)
API_SPORTS_KEY=sua_chave               # API-Football / api-sports.io (forma, H2H, standings, settlement)
                                        # Alias aceito: APIFOOTBALL_KEY
# Nota: ESPN API é gratuita e sem chave — MMA e Tênis usam automaticamente

# ── Servidor ──
SERVER_PORT=8080
DB_PATH=/data/sportsedge.db            # Railway: volume montado em /data
                                        # Local: use sportsedge.db

# ── Admin ──
ADMIN_USER_IDS=123456789,987654321      # IDs numéricos Telegram (obtenha via @userinfobot)
                                        # Admin é inscrito automaticamente a cada boot
ADMIN_KEY=sua_chave_admin               # Opcional (recomendado): protege rotas admin do `server.js` (header `x-admin-key`)

# ── Risk Manager global (cross-sport) ──
GLOBAL_RISK_PCT=0.10                    # Exposição máxima global (tips pendentes) vs banca total (padrão 10%)
SPORT_RISK_PCT=0.20                     # Exposição máxima por esporte vs banca do esporte (padrão 20%)

# ── Feature flags ──
ESPORTS_ENABLED=true
MMA_ENABLED=true                        # false por padrão se token ausente
TENNIS_ENABLED=true
FOOTBALL_ENABLED=true

# ── Futebol — configuração ──
FOOTBALL_LEAGUES=soccer_brazil_serie_b,soccer_brazil_serie_c  # ligas a monitorar (The Odds API keys)
FOOTBALL_EV_THRESHOLD=5.0              # EV mínimo % para emitir tip (padrão: 5.0)
FOOTBALL_DRAW_MIN_ODDS=2.80            # Odds mínimas para tip de empate (padrão: 2.80)

# Ligas disponíveis para FOOTBALL_LEAGUES:
#   soccer_brazil_campeonato     — Brasileirão Série A
#   soccer_brazil_serie_b        — Série B
#   soccer_brazil_serie_c        — Série C
#   soccer_argentina_primera     — Primera División
#   soccer_spain_segunda_division
#   soccer_germany_3liga
#   soccer_england_league1
#   soccer_england_league2
#   soccer_usa_mls
#   soccer_chile_primera_division
#   soccer_colombia_primera_a
#   soccer_uruguay_primera_division

# ── OddsPapi — ajuste fino (opcional) ──
ODDSPAPI_BATCH_SIZE=3                   # Torneios por requisição (padrão: 3)
ESPORTS_ODDS_TTL_H=3                    # Horas entre ciclos round-robin (padrão: 3h)
ODDSPAPI_BOOTSTRAP=true                 # Após deploy: busca vários lotes seguidos p/ encher cache (cuidado: +requisições)
ODDSPAPI_BOOTSTRAP_MS=2500              # Intervalo mínimo entre lotes no bootstrap (ms, padrão 2500)
ODDSPAPI_ESPORTS_SPORT_ID=18            # sportId LoL na OddsPapi (padrão 18)
ODDSPAPI_FORCE_COOLDOWN_S=300           # Cooldown do `force=1` por par de times (s) — reduz risco de 429

# ── LoL — ligas extras além da whitelist interna ──
LOL_EXTRA_LEAGUES=slug1,slug2           # opcional, separado por vírgula

# ── Meta LoL (atualizado automaticamente a cada 14 dias via ddragon) ──
LOL_PATCH_META=Patch 26.X — descrição do meta atual
PATCH_META_DATE=YYYY-MM-DD

# ── Análise pré-jogo — controle de rigidez (opcional) ──
LOL_PREGAME_BLOCK_BO3=true             # true = só analisa Bo3/Bo5 após Game 1 (draft conhecido)
                                        # false = analisa upcoming sem restrição de draft

# ── Thresholds de tip LoL (opcional — valores padrão se omitidos) ──
LOL_EV_THRESHOLD=5                      # EV mínimo % para emitir tip (padrão: 5)
LOL_PINNACLE_MARGIN=8                   # Mínimo de edge em pontos percentuais (pp) necessário para considerar uma aposta (padrão: 8)
LOL_NO_ODDS_CONVICTION=70              # Confiança mínima % para tip sem odds de mercado (padrão: 70)
LOL_MIN_ODDS=1.50                       # Gate pós-IA: odd mínima (padrão 1.50)
LOL_MAX_ODDS=4.00                       # Gate pós-IA: odd máxima (padrão 4.00)
LOL_HIGH_ODDS=3.00                      # Acima disso exige EV extra (LOL_HIGH_ODDS_EV_BONUS, padrão +3pp)
```

---

## Iniciando

```bash
npm install
npm start           # inicia servidor + bot via start.js

# Ou separadamente (servidor DEVE iniciar antes)
npm run server      # node server.js
npm run bot         # node bot.js
```

### Deploy no Railway

1. Push para o repositório GitHub vinculado ao Railway
2. Configure as variáveis de ambiente no painel **Variables**
3. Para persistência do banco entre redeploys: crie um Volume e defina `DB_PATH=/data/sportsedge.db`
4. O `start.js` gerencia os dois processos com auto-restart em falha; primeira linha útil nos logs: `[LAUNCHER] PORT=… | DB=…`
5. Configure `ADMIN_USER_IDS` com seu ID do Telegram — o admin é inscrito automaticamente a cada boot
6. O `railway.toml` já está configurado com healthcheck TCP e restart policy `on_failure`
7. **OddsPapi:** `ODDSPAPI_BOOTSTRAP=true` acelera o cache no primeiro minuto após deploy, mas soma muitas chamadas — combinado com `Force-fetch live` e re-fetch &lt;2h pode aproximar o **rate limit** do plano; em 429 o servidor entra em **backoff 2h** (odds ficam stale ou ausentes para pares sem match).

> **Nota DB_PATH no Railway:** se a variável aparecer com artefatos (`=/data/...` ou tab no prefixo), o sistema sanitiza automaticamente antes de abrir o banco.

#### Decodificação rápida dos logs (produção)

| Log | Significado |
|-----|-------------|
| `[BOOT] ENV: CLAUDE_API_KEY=❌ AUSENTE` | Só **DeepSeek** entra no `/claude`; Claude desligado até configurar a chave. |
| `[BOOT] … tips existentes carregadas` | Histórico de tips por esporte reidratado do SQLite. |
| `[BOOT] Sports carregados: […]` | Esportes habilitados e se cada um tem token Telegram. |
| `[BOOT] X usuários carregados do DB` | Usuários persistidos no SQLite reidratados em memória. |
| `[BOOT] Total: X usuários com notificações ativas` | Contagem de inscritos ativos no momento do boot. |
| `[BOOT] Admin XXXXXXXXX inscrito em: esports, mma, …` | Admin da `ADMIN_USER_IDS` inscrito automaticamente em todos os esportes ativos. |
| `[ESPN-MMA] N lutas carregadas da ESPN` | Scoreboard UFC atual carregado do ESPN (cache 1h). |
| `[ESPN-TENNIS] Rankings: ATP N \| WTA N` | Rankings ATP/WTA carregados do ESPN (top 150 por tour, cache 3h). |
| `[PATCH] Meta manual configurado (Nd) — auto-detect ignorado (ddragon: X.Y)` | `LOL_PATCH_META` fixo no `.env`; `Nd` = dias desde a data configurada; versão ddragon exibida mas ignorada. |
| `[ODDS] Torneios ativos via sportId=18: N` | OddsPapi retornou lista dinâmica de torneios com fixtures futuras/upcoming/live; isso define quantos lotes \(M\) o round-robin terá. |
| `[ODDS] Buscando odds: lote N/M` | Ciclo OddsPapi (round-robin); no deploy, bootstrap pode enfileirar vários lotes. |
| `[ODDS] Bootstrap concluído — ~N entradas` | Cache esports aquecido após sequência de lotes. |
| `[LOL] … odds: A/B \| sem match: slugs` | **A** partidas com par no cache OddsPapi; slugs listados = nomes que não casaram (ver aliases `/debug-match-odds`). |
| `[SYNC] pro_champ_stats vazio mas … synced` | Inconsistência DB → **resync completo** PandaScore (detalhe na secção sync). |
| `[SYNC] Pro stats: … 0 champs, 0 player` | PandaScore não retornou picks detalhados (ou faltou `include` no request). Sem isso, comp/meta do ML fica fraco até o próximo sync bem-sucedido. |
| `[AUTO] Analisando: X vs Y \| sinais=N/6 \| evThreshold=X% \| mlEdge=Y.Ypp` | Pré-jogo/live LoL: sinais ML disponíveis, threshold adaptativo de EV e edge do modelo vs mercado. |
| `[AUTO] Sem tip: X vs Y → IA sem edge \| P(X)=N% P(Y)=M% \| EV(X)=+N% \| Sinais:N/6 \| mlEdge=Y.Ypp` | IA ou gates não aprovaram tip; inclui probabilidades estimadas, EV e edge ML. |
| `[AUTO] Gate odds … [min, max]` | Odd sugerida fora de `LOL_MIN_ODDS` / `LOL_MAX_ODDS` (padrão 1.50–4.00; em produção pode aparecer como `[1.4, 8]` se você configurou esses envs). |
| `[AUTO] Tip bloqueada: X vs Y \| P(X)=N% … \| EV=+N% \| Sinais:N/6 \| mlEdge=Y.Ypp` | Tip chegou a todos os gates mas foi bloqueada (ex.: odd fora do range); resumo completo no log. |
| `[AUTO-MMA] Gate odds … 1.40–5.00` | Odd da tip MMA fora da faixa fixa no código. |
| `[AUTO-MMA] Records: A=…(ESPN) \| B=…(Wiki)` | Record MMA obtido via ESPN quando possível; fallback alternativo pode aparecer como `Wiki` em alguns nomes/falhas de busca. |
| `[AUTO-MMA] Gate semana … luta futura` | Confiança não-alta em luta distante → descartada. |
| `[AUTO-MMA] Ignorando luta sem data válida` | Evento na lista sem data parseável. |
| `[AUTO-FOOTBALL] … [sem dados]` | Fixture/API-Football não deu forma/H2H/standings (odds-only ou não encontrado). |
| `[AUTO-TENNIS] … [ESPN+]` | Indicador de superfície/torneio vindo do contexto ESPN. |
| `[AUTO] Análise anterior ainda em curso — pulando ciclo` | Proteção anti-concorrência: evita dois loops de análise rodando ao mesmo tempo (pula iteração quando ainda há análise em andamento). |
| `429 — backoff 2h ativado` | OddsPapi rate limit → 2h sem fetch (ver secção **Rate limit**). |
| Dois blocos `[LOL] getLive` no mesmo segundo | Várias chamadas HTTP ao servidor em paralelo (ex.: fair odds + auto) podem disparar **dois** force-fetch OddsPapi — aumenta risco de **429**. |

---

## Interface do Bot

O bot opera em **modo totalmente automático**. O usuário interage pelos botões do menu:

| Botão / Comando | Função |
|---|---|
| `Notificações` | Ativa/desativa recebimento de tips automáticas por DM |
| `Tracking` | Exibe ROI, win rate, profit, calibração, split ao vivo vs pré-jogo |
| `Próximas` | Lista partidas ao vivo e próximas com odds quando disponíveis |
| `⚖️ Fair Odds` | Exibe odds calculadas pelo modelo ML do sistema para todas as partidas com odds disponíveis |
| `Ajuda` | Explica como o bot funciona |

### Comandos Admin

| Comando | Função |
|---|---|
| `/stats` | ROI total, calibração por confiança (ALTA/MÉDIA/BAIXA), histórico de tips |
| `/users` | Status do banco de dados |
| `/pending` | Tips pendentes de settlement |
| `/settle` | Força settlement imediato |
| `/refresh-open` | Reanalisa tips pendentes e atualiza `current_odds/current_ev` (notificação enviada 1x por tip) |
| `/slugs` | Slugs de liga reconhecidos + desconhecidos vistos (diagnóstico) |
| `/lolraw` | Dump do schedule Riot por liga (diagnóstico) |

---

## Sistema de Fair Odds

Cada esporte exibe fair odds calculadas pelo **próprio modelo de análise do sistema** — não apenas o de-juice (remoção da margem da bookie). A diferença entre a fair odd do modelo e a odd da bookie é o **edge em pp**.

| Esporte | Fonte dos dados | Método |
|---------|----------------|--------|
| LoL Esports | Forma recente + H2H (banco local, 45 dias) | Prior bayesiano logístico |
| MMA | ESPN scoreboard (carta atual) + ESPN athlete search (fallback) | Win rate do record histórico |
| Tênis | ESPN rankings ATP/WTA | Modelo Elo-log por ranking |
| Futebol | API-Football (forma, H2H, standings) | `calcFootballScore` com Poisson |

**Exibição por partida:**
```
🥊 [UFC 314] Khamzat Chimaev vs Sean Strickland
  🏷️ Bookie: 1.45 / 2.85  (margem: 6.2%)
  🤖 Modelo (ESPN record): 1.52 / 2.68
  📊 P: 65.8% / 34.2% | Edge: +3.1pp / -3.1pp
```

- Se não há dados de enriquecimento disponíveis, exibe `(sem dados — apenas de-juice)` com transparência
- Para LoL, mostra **todas** as partidas com odds (upcoming, live e draft)

---

## Ciclos Automáticos

| Ciclo | Intervalo | Descrição |
|---|---|---|
| Auto-análise | 6 min | Analisa partidas `live` e `upcoming` nas próximas 24h |
| Re-análise ao vivo | 10 min | Re-analisa a mesma partida ao vivo enquanto sem tip enviada |
| Re-análise pré-jogo | 30 min | Re-tenta partidas upcoming que ainda não têm odds |
| Re-análise sem edge | 2× cooldown | Partidas sem edge têm cooldown dobrado para economizar tokens |
| Notificação ao vivo | 1 min | Avisa sobre draft iniciado e partida ao vivo |
| Line movement | 30 min | Alerta se odds mudaram >= 10% desde o último snapshot |
| Settlement | 30 min | Resolve tips pendentes (LoL via Riot/PandaScore, Futebol via API-Football, MMA/Tênis via ESPN) |
| Sync pro stats | 12h (+ boot) | Busca até 400 partidas pro (últimos 45 dias) via PandaScore → popula WR de campeões, jogadores, forma e H2H |
| Patch meta auto-fetch | 14 dias | Busca versão atual no ddragon e atualiza `LOL_PATCH_META` automaticamente |
| Patch meta stale alert | 24h | Avisa admins se patch meta não foi atualizado há mais de 14 dias |
| Fetch de odds | 3h (configurável) | Round-robin: busca 1 lote de 3 torneios por ciclo |
| Re-fetch urgente | Sob demanda | Se partida começa em < 2h e odds têm > 2h, força re-fetch imediato |
| Cache fixtures futebol | 6h | Pré-carrega todas as fixtures da semana em batch (2-4 chamadas) |
| Cache ESPN MMA | 1h | Scoreboard de lutas da carta atual do UFC |
| Cache ESPN atletas | 6h | Records individuais buscados via athlete search |
| Cache ESPN tênis | 3h | Rankings ATP/WTA (150 por tour) |
| Reanálise tips em andamento | 10 min | Atualiza `current_odds/current_ev` no DB e no dashboard (notifica Telegram 1x por tip) |

---

## Sistema de ML — Sinais

O pré-filtro ML (`lib/ml.js`) calcula um edge score baseado em até 4 fatores. Qualquer fator disponível incrementa o `factorCount` — se nenhum dado estiver disponível, a partida passa diretamente para a IA.

| Fator | Fonte | Peso | Justificativa | Disponível quando |
|-------|-------|------|---------------|-------------------|
| Forma recente (win rate diferencial) | `match_results` (últimos 45 dias) | dinâmico (padrão 0.25) | Forma recente é preditor moderado, mas sujeito a variação | Após sync pro stats |
| H2H (histórico direto) | `match_results` (últimos 45 dias) | dinâmico (padrão 0.30) | H2H é forte preditor em esports, especialmente em matchups específicos | Após sync pro stats |
| Comp/meta score (WR médio dos campeões em pro play) | `pro_champ_stats` | dinâmico (padrão 0.35) | Composição é fator mais importante no LoL competitivo | Draft disponível + sync feito |
| Live stats | Riot/PandaScore ao vivo | extra `factorCount` | Dados ao vivo atualizam probabilidade em tempo real | Partida ao vivo |

Os pesos dinâmicos ficam em `ml_factor_weights` e são recalculados semanalmente (com base na acurácia recente por fator, **janela 45 dias**). Veja `GET /ml-weights` no dashboard.

**Threshold mínimo:** Quando compScore está disponível, edge mínimo de 3pp é exigido. Justificativa: composições conhecidas reduzem incerteza, permitindo threshold mais baixo para edge significativo.

O comp score considera o WR médio dos campeões escolhidos em pro play (não solo queue). Positivo = blue/t1 favorecido. Mínimo de 4 entradas em `/champ-winrates` para ativar.

### Fontes de Enriquecimento por Esporte

| Esporte | Win rate | H2H | Extra |
|---------|----------|-----|-------|
| LoL | DB local (PandaScore sync) | DB local | Composições, live stats |
| MMA | ESPN scoreboard → athlete search fallback | — | Categoria, rounds |
| Tênis | ESPN ranking ATP/WTA (modelo Elo-log) | — | Superfície, form do torneio |
| Futebol | API-Football (últimos 10 jogos) | API-Football | Standings, cansaço, Poisson |

**MMA — ESPN Athlete Search:**
Quando o lutador não está na carta atual do ESPN (`/mma/ufc/scoreboard`), o sistema busca individualmente via `/apis/site/v2/sports/mma/ufc/athletes?search={nome}`. O record "W-L-D" é convertido em win rate e usado como prior no modelo.

**Tênis — Ranking Elo-log:**
`P(1 vence) = 1 / (1 + √(rank1/rank2))` — ex: ranking #5 vs #50 → ~76% favorito.

### Saída do Modelo (`esportsPreFilter`)

```javascript
{
  pass: true,           // se deve chamar a IA
  direction: 't1',      // direção com maior edge
  score: 9.3,           // edge máximo em pp
  t1Edge: 9.3,          // edge de t1 sobre mercado de-juiced
  t2Edge: -9.3,
  modelP1: 0.621,       // probabilidade estimada pelo modelo (0-1)
  modelP2: 0.379,
  impliedP1: 0.528,     // probabilidade de-juiced do mercado
  impliedP2: 0.472,
  factorCount: 2        // quantos fatores foram usados
}
```

### Uso das Probabilidades do Modelo no Prompt da IA

Quando `factorCount > 0`, o prompt enviado à IA inclui as probabilidades do modelo como referência principal de "fair odds" — em vez do simples de-juice da bookie:

```
P modelo do sistema (forma+H2H): T1=62.1% | Gen.G=37.9%
P de-juiced bookie: T1=52.8% | Gen.G=47.2%

Referência do modelo: T1=62.1% | Gen.G=37.9% [De-juice bookie: T1=52.8% | Gen.G=47.2%]
Sua P estimada deve superar a P do modelo em ≥8pp E EV ≥ +5%.
```

Isso evita que a IA compare sua estimativa contra a odd da bookie (que inclui viés da casa) e a force a ter uma visão genuinamente diferente do modelo para justificar uma tip.

### Sync de Dados Pro (PandaScore)

No boot e a cada 12h, o sistema busca até **400 partidas finalizadas** dos últimos 45 dias via PandaScore e extrai:
- **`match_results`** — resultados para forma recente e H2H (filtrado a 45 dias)
- **`pro_champ_stats`** — WR de cada campeão por role em pro play
- **`pro_player_champ_stats`** — WR de cada jogador com campeões específicos

Partidas já sincronizadas são rastreadas em `synced_matches` para evitar double-counting.

**Recuperação de inconsistência:** se `pro_champ_stats` estiver vazio mas existirem muitas linhas em `synced_matches`, o sync loga aviso e **força resync completo** das partidas PandaScore (evita estado “marcado como sync” sem dados de campeão/jogador).

**Nota:** após coletar centenas de partidas, é possível ver no log `Pro stats: … resultados, 0 champs, 0 player+champ` se o payload não trouxer picks detalhados — nesse caso forma/H2H ainda podem existir via `match_results`, mas o fator **comp/meta** do ML fica sem dados até o próximo sync bem-sucedido.

### Busca Fuzzy de Form/H2H (LoL)

O endpoint `/team-form` tenta duas estratégias em sequência:
1. **Match exato** (case-insensitive): `lower(team1) = lower(?)`
2. **Match parcial** (LIKE): `lower(team1) LIKE lower('%nome%')` — captura divergências entre Riot API e PandaScore

Janela: **últimos 45 dias** em ambos os casos (alinhado com a janela de sync do PandaScore).

Ex: busca por `"paiN Gaming"` encontra `"paiN Gaming Academy"` no DB se o exato falhar.

---

## Sistema de Odds — OddsPapi Round-Robin

Com 250 req/mês no plano free (~8 req/dia), as odds são buscadas em ciclos de 3h. Cada ciclo cobre **um lote diferente** de torneios, ciclando pelos 6 lotes. Todos os torneios são cobertos em ~18h.

### Ordem dos Lotes

| Lote | Ligas cobertas | Quando busca |
|------|----------------|--------------|
| 1 | LCS, LEC, LCK | Startup |
| 2 | Prime League (DE), Hellenic Legends League (GR), Road of Legends (PT) | +3h |
| 3 | LIT/LES (IT/ES), Finnish Pro League, EMEA Masters | +6h |
| 4 | CBLOL (BR), NACL, LPL (CN) | +9h |
| 5 | LCK CL, LCP (APAC), LRN | +12h |
| 6 | LRS, Esports World Cup | +15h |

O cursor do round-robin é visível em `/debug-odds` no campo `roundRobin`.

### Re-fetch Urgente (< 2h)

Se uma partida está programada para começar em menos de 2 horas e as odds no cache têm mais de 2 horas, o sistema força um re-fetch imediato antes de passar as odds para análise, garantindo dados frescos no momento crítico.

### Rate limit (HTTP 429)

Se a OddsPapi retornar **429**, o servidor define backoff de **2 horas** (`ESPORTS_BACKOFF_TTL` em `server.js`), loga `429 — backoff 2h ativado` e passa a logar `Em backoff — aguardando` / `Force-fetch ignorado (backoff ativo)` em chamadas subsequentes. Nesse período não há atualização de cache esports; use `GET /debug-odds` para ver `backoffRemainingSeconds`. Evite disparar muitas requisições no boot (bootstrap + dois processos competindo) se o plano for limitado.

### Matching de Times

A OddsPapi v4 não retorna nomes de times nos campos padrão — os nomes estão embutidos na URL de fixture do bookmaker (ex: `315638638-cloud9-lyon-gaming`). O sistema extrai o "combined slug" da URL, normaliza (minúsculo, sem caracteres especiais) e usa correspondência de substring. Um dicionário de aliases cobre variações de nome:

```
"BNK FEARX" → norm "bnkfearx" → alias key "fearx" → encontra "fearxhanjinbrion"
"Gen.G Esports" → norm "gengesports" → alias key "geng" → variante "gen" → encontra "gengktrolster"
```

---

## Sistema de Análise IA

### Provedor de IA

O bot usa **DeepSeek** (`deepseek-chat`) como provedor padrão por ser significativamente mais barato que Claude. Se `DEEPSEEK_API_KEY` não estiver configurado, cai automaticamente para **Anthropic Claude**. O endpoint `/claude` em `server.js` funciona como proxy unificado para ambos, normalizando o formato de resposta.

### Fluxo Completo

```
1. Ciclo detecta partida elegível (live ou upcoming <= 24h)
   |
2. Re-fetch urgente de odds (se partida começa em < 2h e odds > 2h antigas)
   |
3. Coleta em paralelo:
   |-- Odds do cache OddsPapi (via /odds?team1=X&team2=Y)
   |-- Contexto ao vivo: composições, gold, kills, dragões,
   |   barões, torres (Riot API ou PandaScore)
   |-- WR de campeões em pro play (pro_champ_stats)
   |-- WR de jogadores com campeões específicos (pro_player_champ_stats)
   |-- Forma recente dos times (últimas partidas — 45 dias)
   |-- Histórico H2H (últimos 45 dias)
   |-- Movimentação de linha (variação de odds)
   |
4. Pré-filtro ML local (lib/ml.js)
   -> Fatores: forma, H2H, comp/meta score, live stats
   -> Retorna: modelP1, modelP2, t1Edge, t2Edge, factorCount
   -> Se sem edge matemático com compScore disponível: pula a IA (economiza créditos)
   |
5. Prompt compacto para DeepSeek/Claude (max 600 tokens de resposta):
   |-- P do modelo do sistema como referência de "fair odd" (quando factorCount > 0)
   |-- P de-juiced da bookie como referência secundária
   |-- WR de campeões e jogadores visível no contexto
   |-- Threshold de edge: P estimada deve superar P modelo em ≥8pp
   |
6. IA retorna:
   |-- TIP_ML:[time]@[odd]|EV:[%]|STAKE:[u]|CONF:[ALTA/MÉDIA/BAIXA]
   |
7. Gates pós-IA:
   |-- Gate 0: rejeita se não há odds reais disponíveis
   |-- Gate 2: rejeita odds fora de [LOL_MIN_ODDS, LOL_MAX_ODDS] (padrão [1.50, 4.00]); acima de LOL_HIGH_ODDS (3.00) exige EV extra
   |-- Gate 3 (consenso ML×IA): ML diverge da IA com score > 8pp → rebaixa ALTA→MÉDIA→BAIXA
   |-- Gate 4 (EV adaptativo): rejeita se EV < threshold por confiança (ver tabela abaixo)
   |
8. Se TIP_ML aprovada em todos os gates: envia DM a todos os inscritos
   |
9. Registra no banco SQLite + marca tipSent=true (evita duplicatas após redeploy)
   Partidas sem edge têm cooldown dobrado no próximo ciclo
```

### Níveis de Confiança e Thresholds de EV

O sistema opera com **três níveis de confiança**. O threshold de EV mínimo é **adaptativo** — quanto mais sinais disponíveis, menor o threshold exigido (mais dados = mais confiança na estimativa).

| Confiança | Sinais exigidos | EV mínimo (6 sinais → ≤1 sinal) | Kelly | Stake máx | Emoji |
|-----------|----------------|----------------------------------|-------|-----------|-------|
| 🟢 ALTA   | ≥ 2 sinais     | 2% → 7%                          | ¼ Kelly | 4u | 🟢 |
| 🟡 MÉDIA  | ≥ 1 sinal      | 1% → 5.5%                        | ⅙ Kelly | 3u | 🟡 |
| 🔵 BAIXA  | Nenhum         | 0.5% → 4%                        | 1/10 Kelly | 1.5u | 🔵 |

**Threshold adaptativo por quantidade de sinais** (`LOL_EV_THRESHOLD=5` padrão):

| Sinais disponíveis | ALTA | MÉDIA | BAIXA |
|--------------------|------|-------|-------|
| 6 sinais | 2% | 1% | 0.5% |
| 5 sinais | 3% | 1.5% | 0.5% |
| 4 sinais | 4% | 2.5% | 1% |
| 3 sinais | 5% | 3.5% | 2% |
| 2 sinais | 6% | 4.5% | 3% |
| ≤1 sinal | 7% | 5.5% | 4% |

Tips BAIXA sempre exibem aviso: _"Tip de confiança BAIXA — stake reduzido. Aposte com cautela."_

### Tipos de Tips

| Tipo | Dispara quando | Dados usados | Label na mensagem |
|------|---------------|--------------|-------------------|
| Ao vivo | `status = live` | Composições + Gold + KDA + Objetivos + WR champs/players (~90s delay) | `TIP ML AUTOMÁTICA` |
| Pré-jogo | `upcoming` com odds reais | Draft (se disponível) + Forma + H2H + WR champs/players + odds | `TIP PRÉ-JOGO ESPORTS` |

Uma tip por partida — o flag `tipSent` é salvo no banco e recarregado no boot, evitando duplicatas após redeploy.

> **Upcoming sem odds:** partidas pré-jogo sem odds reais disponíveis não recebem análise de fair odds nem tips estimadas. A análise só roda quando há mercado real disponível.

### Proteções Anti-Viés

| Proteção | Mecanismo |
|---|---|
| "Sem edge" é resposta válida | Instrução explícita no prompt para não forçar recomendação |
| Gate 0: sem odds reais | Odds estimadas → rejeição automática |
| Gate 2: odds fora da zona | Odd < `LOL_MIN_ODDS` (1.50) ou > `LOL_MAX_ODDS` (4.00) → rejeição. Odds acima de `LOL_HIGH_ODDS` (3.00) não são rejeitadas mas exigem EV extra (`LOL_HIGH_ODDS_EV_BONUS`, padrão +3pp). |
| Gate 3: consenso ML×IA | ML diverge da IA com score > 8pp → rebaixa confiança (ALTA→MÉDIA→BAIXA) |
| Gate 4: EV mínimo adaptativo | EV abaixo do threshold por nível de confiança e quantidade de sinais → rejeição |
| Comparação contra modelo ML | P estimada deve superar o modelo (forma+H2H) em ≥LOL_PINNACLE_MARGIN pp — não só o de-juice |
| Line movement | Instrução para ajustar probabilidade 2-3pp na direção do mercado quando linha se mover |
| Alto fluxo | Jogos com <15 min ou objetivo maior recente (Baron, Elder) → confiança máxima BAIXA |
| Form/H2H limitados a 45 dias | Resultados antigos (outro meta/patch) não contam para cálculo de edge |

### Kelly Criterion

```
f* = (p × (odds - 1) - (1 - p)) / (odds - 1)

Fonte de p (em ordem de prioridade):
  1. modelP1/modelP2 do esportsPreFilter() — quando factorCount > 0 (LoL)
  2. p = (EV + 1) / odds — derivado do EV da IA (fallback quando sem dados ML)

ALTA:  stake = clamp(f* × 0.25,  0.5u, 4u)   ¼ Kelly
MÉDIA: stake = clamp(f* × 0.167, 0.5u, 3u)   ⅙ Kelly
BAIXA: stake = clamp(f* × 0.10,  0.5u, 1.5u) 1/10 Kelly

Arredondado a 0.5u
```

---

## Cobertura de Ligas

### Partidas (Riot API + PandaScore)

| Tier | Ligas |
|------|-------|
| T1 — Global | Worlds, MSI |
| T1 — Regionais | LCS, LCK, LEC, LPL, CBLOL, LLA, PCS, LCO, VCS, LJL, LCP |
| T2 — Europa | EMEA Masters, LFL, NLC, Prime League (DE), Hellenic Legends League (GR), LIT (IT), LES (ES), Road of Legends (PT), Finnish Pro League, EBL |
| T2 — Americas | LTA Norte, LTA Sul, NACL, Circuito Desafiante |
| T2 — Asia | LCK CL, LDL, LRN, LRS |
| EWC | Esports World Cup e qualificatórias |

Ligas adicionais podem ser habilitadas via `LOL_EXTRA_LEAGUES` no `.env`.

### Deduplicação Riot + PandaScore

Quando o mesmo confronto aparece em ambas as fontes, o sistema prioriza os dados da Riot API (stats ao vivo mais completos) e descarta a entrada duplicada do PandaScore, evitando análises duplicadas.

### Stats ao Vivo (LoL)

- Gold total por time com trajetória por minuto
- Torres, dragões (com tipos), barões, inibidores, kills
- KDA, gold e função (TOP/JGL/MID/ADC/SUP) por jogador
- WR do jogador com o campeão atual em pro play
- ~90s de delay na API oficial da Riot
- PandaScore como fonte alternativa para torneios não transmitidos pela Riot

---

## Settlement Automático

| Esporte | Fonte | Endpoint | Frequência |
|---------|-------|----------|-----------|
| LoL (Riot) | LoL Esports API | `/match-result` | 30 min |
| LoL (PandaScore) | PandaScore | `/ps-result` (prefixo `ps_`) | 30 min |
| Futebol | API-Football | `/football-result` (prefixo `fb_`) | 30 min |
| MMA | ESPN (`/apis/site/v2/sports/mma/ufc/scoreboard`) | `bot.js` settlement loop | 30 min |
| Tênis | ESPN (`/apis/site/v2/sports/tennis/{atp\|wta}/scoreboard`) | `bot.js` settlement loop | 30 min |

O settlement itera pelas tips não resolvidas e detecta o endpoint correto pelo prefixo do `matchId`:
- Sem prefixo → Riot API (`/match-result`)
- `ps_` → PandaScore (`/ps-result`)
- `fb_` → API-Football (`/football-result`) — resolve apenas se status `FT`, `AET` ou `PEN`

**Futebol — mercados especiais:**
- `1X2_D` (empate): vence se `winner = "Draw"`
- `OVER_2.5` / `UNDER_2.5`: calculado pelo placar final (gols totais > ou < 2.5)

---

## Rotas do Servidor

### Partidas e Odds

| Rota | Descrição |
|------|-----------|
| `GET /lol-matches` | Combina Riot API + PandaScore; inclui odds quando disponíveis no cache |
| `GET /mma-matches` | Lutas MMA próximas com odds (The Odds API) |
| `GET /tennis-matches` | Partidas de tênis próximas com odds (The Odds API) |
| `GET /football-matches` | Partidas de futebol próximas 7 dias com odds H2H + Over/Under (The Odds API) |
| `GET /odds?team1=X&team2=Y[&force=1]` | Busca odds do cache; `force=1` ignora TTL e força re-fetch |
| `GET /live-gameids?matchId=X` | IDs dos games em andamento numa série Riot |
| `GET /live-game?gameId=X` | Stats ao vivo: gold, torres, dragões, kills, players |
| `GET /ps-compositions?matchId=ps_X` | Composições e stats via PandaScore (prefix `ps_`) |
| `GET /match-result?matchId=X&game=X` | Resultado final de uma partida (Riot) |
| `GET /ps-result?matchId=X` | Resultado final de uma partida (PandaScore) |
| `GET /football-result?fixtureId=X` | Resultado final de uma partida de futebol (API-Football) |

### Tips e Banco

| Rota | Descrição |
|------|-----------|
| `POST /record-tip` | Registrar tip no banco |
| `POST /settle` | Liquidar tip por match_id, sport e winner |
| `GET /unsettled-tips` | Tips aguardando resultado |
| `GET /tips-history` | Histórico de tips com filtros |
| `GET /roi` | ROI total, calibração por confiança, split ao vivo/pré-jogo |
| `GET /risk-snapshot` | Snapshot global de risco (banca + exposição pendente por esporte) — usado pelo Global Risk Manager |
| `GET /team-form?team=X&game=X` | Forma recente do time (exato → fuzzy LIKE, últimos 45 dias via SQL) |
| `GET /h2h?team1=X&team2=Y&game=X` | Histórico H2H (exato → fuzzy LIKE, últimos 45 dias via SQL) |
| `GET /odds-movement` | Variação de odds nas últimas 24h |
| `GET /db-status` | Contagem de registros por tabela |
| `GET /users` | Listar usuários |
| `POST /save-user` | Criar/atualizar usuário |
| `POST /claude` | Proxy unificado para DeepSeek ou Claude (auto-detecta pela key disponível) |

### Pro Stats (ML)

| Rota | Descrição |
|------|-----------|
| `GET /champ-winrates?champs=Corki,Azir&roles=mid,mid` | WR de campeões em pro play (mínimo 5 jogos) |
| `GET /player-champ-stats?players=Faker,Chovy&champs=Azir,Orianna` | WR de jogadores com campeões específicos (mínimo 3 jogos) |
| `POST /sync-pro-stats` | Força sync manual de stats pro via PandaScore |

### Diagnóstico

| Rota | O que retorna |
|------|--------------|
| `GET /health` | Saúde do serviço + métricas-lite (inclui contadores de 429 e cache HTTP) |
| `GET /metrics-lite` | Métricas-lite (cache HTTP, 429 por provedor) |
| `GET /lol-role-impact` | Impacto médio por role (gol.gg) — via `scripts/sync-golgg-role-impact.js` |
| `GET /debug-odds` | Cache completo de odds: slugs, TTL, backoff restante, estado do round-robin (`cursor`, `nextBatch`, `totalBatches`, `nextTids`, `cycleCompletesIn`) |
| `GET /debug-teams` | Todos os times do schedule (Riot + PandaScore) com `team1norm`, `team2norm`, `hasOdds` e `league` — permite identificar mismatches de nome |
| `GET /debug-match-odds?team1=X&team2=Y` | Testa matching de odds para um par específico, mostrando variantes e aliases verificados |
| `GET /lol-slugs` | Slugs de liga reconhecidos na whitelist + slugs desconhecidos vistos no schedule |
| `GET /lol-raw` | Dump bruto do schedule Riot por liga |

---

## Banco de Dados (`sportsedge.db`)

| Tabela | Conteúdo |
|--------|---------|
| `users` | user_id, username, subscribed, sport_prefs (JSON array) |
| `events` | Torneios/eventos com sport = 'esports' |
| `matches` | Confrontos com resultado pós-jogo |
| `tips` | Tips: odds, EV, stake, confidence, resultado, isLive, clv_odds, open_odds |
| `odds_history` | Snapshots de odds (14 dias) para detecção de line movement |
| `match_results` | Resultados pro (últimos 45 dias) para forma recente e H2H |
| `pro_champ_stats` | WR de campeões por role em pro play (acumulado via sync PandaScore) |
| `pro_player_champ_stats` | WR de jogadores com campeões específicos em pro play |
| `synced_matches` | IDs de partidas já sincronizadas (evita double-count no sync) |
| `api_usage` | Contador de uso por provedor de IA e mês |

---

## Estrutura de Arquivos

```
lol betting/
├── server.js           # Servidor HTTP: odds, partidas, banco, endpoints, proxy IA, sync pro stats
├── bot.js              # Bot Telegram: polling, análise automática, tips, patch meta, fair odds
├── start.js            # Launcher: spawna server + bot com auto-restart
├── sync-form.js        # Script avulso: sync histórico de partidas (forma/H2H) sem o servidor rodando
├── railway.toml        # Deploy Railway (healthcheck TCP, restart on_failure)
├── package.json
├── .env                # Credenciais (nunca commitar)
├── sportsedge.db       # SQLite (criado automaticamente; path via DB_PATH)
└── lib/
    ├── database.js     # Schema SQLite, statements (exato + fuzzy LIKE), path resolution
    ├── ml.js           # Pré-filtro ML esports (forma, H2H, comp score) — retorna modelP1/P2
    ├── football-api.js # Wrapper API-Football: forma, H2H, standings, batch fixture cache
    ├── football-ml.js  # Pré-filtro ML futebol: 1X2 + Over/Under via Poisson simplificado
    ├── sports.js       # Registry de esportes (tokens, feature flags)
    └── utils.js        # log, calcKelly, calcKellyFraction, norm, fmtDate, httpGet, safeParse
```

### Sync manual de histórico

Para popular a tabela `match_results` com os últimos 45 dias sem precisar do servidor rodando:

```bash
node sync-form.js           # sync incremental (pula já sincronizados)
node sync-form.js --force   # re-sincroniza tudo
```

---

## Bot de Futebol

### Fluxo de Análise

```
1. /football-matches (The Odds API) — partidas próximas 7 dias com odds H2H + Over/Under
   |
2. Gate básico: odds válidas (1 < H,D,A ≤ 5), nenhuma odd > 5.0 nas extremas
   |
3. Se API_SPORTS_KEY disponível → pré-carrega TODAS as fixtures em batch uma vez por loop:
   |-- getUpcomingFixturesCached() → 2-4 chamadas API para semana inteira (cache 6h)
   |-- findInBatch() → busca local, sem chamada extra por partida
   |-- Por fixture encontrada: getTeamForm() × 2, getH2H(), getStandingsCached(),
   |   getDaysSinceLastMatch() × 2  (em Promise.all — uma rodada em paralelo)
   |
4. calcFootballScore() com dados reais:
   |-- Modelo Poisson simplificado → P(Over 2.5)
   |-- Pesos: forma (35%), forma casa/fora (30%), H2H (20%), posição (10%), cansaço (5%)
   |-- EV calculado para cada mercado (1X2_H, 1X2_D, 1X2_A, OVER_2.5, UNDER_2.5)
   |-- Se pass = false (EV < threshold) → pula IA (economiza tokens)
   |
5. Prompt para DeepSeek com contexto completo:
   |-- Odds reais + P modelo + P de-juiced
   |-- Forma (5 jogos: "WDLWW"), médias de gols, posição na tabela
   |-- H2H resumido (últimos 5 confrontos)
   |-- Saída do modelo quantitativo (probs modelo vs mercado, best EV)
   |
6. Gates pós-IA: odds [1.30, 6.00], EV ≥ threshold, draw odds ≥ DRAW_MIN_ODDS
   |
7. Tip enviada com forma exibida na mensagem
   |
8. matchId gravado como fb_<fixtureId> → permite settlement automático via API-Football
```

### Quota API-Football (free: 100 req/dia)

**Antes (por partida):** ~4-6 chamadas/fixture × N fixtures = 40-60+ req por loop
**Agora (batch):** `getUpcomingFixturesCached()` faz 2-4 chamadas para semana inteira, com cache 6h. Por fixture com dados: 2×form + H2H + standings (cache 12h) = ~3 chamadas. **Total estimado: 4 + 3×N fixtures por ciclo**, muito abaixo do limite de 100/dia.

### ML Futebol (`lib/football-ml.js`)

| Fator | Peso | Fonte |
|-------|------|-------|
| Forma geral (últimos 5) | 20% | `getTeamForm` |
| Forma em casa / fora | 15% cada | `getTeamForm` |
| H2H (últimos 5) | 20% | `getH2H` |
| Posição na tabela | 10% | `getStandings` |
| Cansaço (dias descanso) | 5% | `getDaysSinceLastMatch` |
| Over 2.5 (Poisson) | independente | médias de gols |

Home advantage por liga (ex: Série A +8pp, Série B +9pp, MLS +4pp).
Deslocamento máximo em relação ao mercado: ±15pp.

### Ligas Suportadas

Configuradas via `FOOTBALL_LEAGUES` (separadas por vírgula):

| Chave The Odds API | Liga | ID API-Football |
|--------------------|------|----------------|
| `soccer_brazil_campeonato` | Brasileirão Série A | 71 |
| `soccer_brazil_serie_b` | Série B | 72 |
| `soccer_brazil_serie_c` | Série C | 73 |
| `soccer_argentina_primera` | Primera División | 11 |
| `soccer_england_league1` | League One | 41 |
| `soccer_england_league2` | League Two | 42 |
| `soccer_germany_3liga` | 3. Liga | 80 |
| `soccer_spain_segunda_division` | Segunda División | 141 |
| `soccer_usa_mls` | MLS | 253 |
| `soccer_chile_primera_division` | Primera División | 265 |
| `soccer_colombia_primera_a` | Liga BetPlay | 239 |
| `soccer_uruguay_primera_division` | Primera División | 268 |

---

## Fontes de Dados

| Fonte | Uso | Custo |
|-------|-----|-------|
| `esports-api.lolesports.com` | Calendário oficial LoL, séries, placar | Gratuito |
| `feed.lolesports.com` | Stats ao vivo LoL (~90s de delay) | Gratuito |
| `esports.lolesports.com/persisted2` | Composições e detalhes do draft | Gratuito |
| PandaScore API | Torneios não-Riot: schedules, compositions, stats, resultados, sync de champ/player WR | Pago |
| OddsPapi v4 (`api.oddspapi.io/v4`) | Odds 1xBet para LoL (sportId=18), round-robin por lote | Free: 250 req/mês |
| The Odds API (`api.the-odds-api.com/v4`) | Odds H2H + Over/Under para futebol, MMA e tênis (regiões EU) | Free: 500 req/mês |
| API-Football (`v3.football.api-sports.io`) | Forma, H2H, standings e resultados de futebol | Free: 100 req/dia |
| ESPN API (`site.api.espn.com`) | Records MMA (scoreboard + athlete search), rankings ATP/WTA, form do torneio | **Gratuito, sem chave** |
| DeepSeek API (`api.deepseek.com`) | Análise de matchup — padrão (mais barato) | Pago por token |
| Anthropic Claude (`api.anthropic.com`) | Análise de matchup — fallback | Pago por token |
| ddragon (`ddragon.leagueoflegends.com`) | Versão atual do patch para atualização automática do meta | Gratuito |

---

## Troubleshooting e Erros Comuns

### Problemas de Banco de Dados
- **`syntax error` ao criar tabelas**: Verifique se o SQLite está funcionando. O sistema cria automaticamente tabelas faltantes no boot.
- **`no such table`**: Execute manualmente `DROP TABLE nome_tabela` e reinicie para recriação automática.
- **Perda de conexão com DB**: Railway pode reatribuir `DATABASE_URL`. O sistema fallback para `sportsedge.db` local.

### Problemas de Odds
- **`sem match` nos logs**: Nomes de times não casam entre Riot/PandaScore e OddsPapi. Use `/debug-match-odds` para investigar.
- **HTTP 429 da OddsPapi**: Backoff de 2 horas ativado automaticamente. Verifique `/debug-odds` para tempo restante.
- **Odds desatualizadas**: Round-robin pode levar vários ciclos para cobrir todos os torneios. Verifique `cursor` em `/debug-odds`.

### Problemas de IA
- **`Failed to parse AI response`**: A IA não seguiu o formato esperado. Verifique o prompt e contexto enviado.
- **Timeout da API**: DeepSeek/Claude pode demorar. Timeout configurado para 45 segundos.
- **EV calculado incorretamente**: Verifique fórmula Kelly corrigida: `f* = (p × (odds - 1) - (1 - p)) / (odds - 1)` onde `p = (EV + 1) / odds`.

### Problemas de Settlement
- **Tips não settled**: Verifique se a API de resultados está funcionando (ESPN para MMA/Tênis, API-Football para futebol).
- **Winner não detectado**: Nomes podem não casar exatamente. O sistema usa fuzzy matching.
- **Banca não atualizada**: Verifique `bankroll` table e `updateTipFinanceiro`.

### Problemas de Performance
- **Alta memória**: SQLite em WAL mode, conexões persistentes. Reinicie se necessário.
- **Ciclos lentos**: Verifique número de partidas sendo analisadas. Limites configuráveis por esporte.
- **Logs excessivos**: Ajuste `LOG_LEVEL` no `.env`.

### Calibração e Métricas
- **Brier Score/Log Loss incorretos**: Verifique cálculo de probabilidade: `p = (1 + ev/100) / odds` onde `ev` é porcentagem.
- **CLV negativo**: Modelo pode não ter edge real ou variance alta.
- **Win rate abaixo do esperado**: Verifique thresholds de EV e gates de confiança.

---

## Segurança

- Todas as credenciais via `.env` — nunca hardcoded
- `.env` e `*.db` no `.gitignore`
- Comandos admin protegidos por whitelist `ADMIN_USER_IDS`
- Usuários que bloqueiam o bot removidos automaticamente (erro 403)
- API key da IA transmitida via header, nunca no body
- OddsPapi key aceita múltiplas variáveis: `ODDS_API_KEY`, `ODDSPAPI_KEY`, `ODDS_PAPI_KEY`, `ESPORTS_ODDS_KEY`
- `DB_PATH` sanitizado automaticamente (trim + remoção de artefatos `=` do Railway)
