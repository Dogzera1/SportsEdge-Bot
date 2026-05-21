# Spec — Tip messages com slang BR + path unificado

**Data:** 2026-05-21
**Escopo:** Fase 1 — apenas os 13 emit blocks de tips reais (ML/handicap) em `bot.js`. Mensagens de SETTLE (resultado win/loss/void) e MT (market tips via `recordMarketTipAsRegular`) ficam fora.
**Risco financeiro:** zero — só texto Telegram. Não toca `record-tip`, Kelly, EV, stake.

---

## 1. Problema atual

Cada esporte tem seu próprio `const tipMsg = \`...\``  inline em `bot.js`, somando 13 blocos:

| # | Linha | Contexto |
|---|---|---|
| 1 | 3816 | Esports LIVE (LoL/CS/Dota/Val) |
| 2 | 4305 | Esports PRÉ Bo1 |
| 3 | 10286 | Esports outro path |
| 4 | 17564 | Dota2 dedicado |
| 5 | 18509 | MMA |
| 6 | 20140 | Tennis |
| 7 | 21460 | Football |
| 8 | 21943 | TableTennis |
| 9 | 22975 | CS |
| 10 | 23795 | Valorant |
| 11 | 24133 | Darts |
| 12 | 24396 | Snooker |
| 13 | 24830 | Basket |

**Problemas:** duplicação, drift de formatação entre sports, impossibilidade de mudar 1 coisa em 1 lugar, tom genérico ("⚠️ Aposte com responsabilidade") em todos.

---

## 2. Solução

### 2.1 `lib/tipster-slang.js` (NOVO, ~80 LoC)

Library de frases em pt-BR de tipster culture, com seleção determinística por seed.

```js
function pickSlang(context, seed) → string
// context ∈ { 'header_alta', 'header_media', 'header_baixa', 'header_live',
//             'conf_alta', 'conf_media', 'conf_baixa',
//             'footer' }
// seed = string (matchId) → hash estável → mesmo match sempre mesma frase
```

**Pools** (todos no nível "casual mas profissional"):

- **header_alta** — `STAKE CHEIA`, `VALOR NA CARA`, `OLHO ABERTO AQUI`, `CLOSER DA RODADA`
- **header_media** — `OLHO VIVO NA LINHA`, `MANDA COM CABEÇA`, `LINHA FAZ SENTIDO`
- **header_baixa** — `VAI DE SAFETY`, `STAKE REDUZIDA`, `RESPEITA A BANCA`
- **header_live** — `AO VIVO 🔴`, `CASA AINDA NÃO MOVEU`, `LINHA FRESCA`
- **conf_alta** — `valor batendo na cara`, `linha pediu`, `tá maduro`
- **conf_media** — `bate, mas com fé`, `linha tem sentido`, `analise pediu`
- **conf_baixa** — `vai de safety`, `stake reduzido por precaução`, `respeita a banca`
- **footer** — 4-5 variações preservando `+18` e `responsabilidade`:
  - `Forra é a que bate. Jogue com cabeça e respeite a banca. +18 — aposte com responsabilidade.`
  - `Bilhete na mão, fé no processo. +18 — aposte com responsabilidade.`
  - `Olho na linha, mão na banca. +18 — jogo responsável.`
  - `Aposta é maratona, não tiro curto. +18 — aposte com responsabilidade.`
  - `Linha aberta, banca protegida. +18 — jogo responsável.`

**Nota importante:** `chumbo grosso` = loss context → **reservado pra Fase 2 (settle messages)**, não aparece em emissão.

**Seed determinístico:** Hash simples (`fnv1a`) da string `${seed}|${context}` → mod pool.length. Garante:
- Mesma tip enviada em retry mostra mesma frase
- Tips diferentes mostram frases diferentes
- Sem dependência de RNG global

### 2.2 `lib/tip-message-builder.js` (NOVO, ~180 LoC)

```js
function buildTipMessage(opts) → string
```

**Assinatura `opts`:**
```js
{
  sport: 'tennis' | 'football' | 'lol' | 'cs' | 'dota2' | 'valorant'
       | 'mma' | 'basket' | 'darts' | 'snooker' | 'tabletennis',
  marketType: 'ML' | 'HANDICAP' | 'TOTAL' | ...,  // só pra label
  match: { team1, team2, league },
  pick: string,              // jogador/time escolhido
  odd: string | number,
  ev: string | number,       // já formatado (sem %)
  stake: string,             // já passou por formatStakeWithReais externa
  conf: 'ALTA' | 'MÉDIA' | 'BAIXA',
  isLive: boolean,
  // opcionais:
  minTake?: string,
  reason?: string,           // why explanation
  lineShopText?: string,     // já formatado por formatLineShopDM
  extraNotes?: string[],     // linhas extra (surface, format, org)
  modelSource?: string,      // label "trained"/"markov" etc — só log, não no DM
  matchTime?: string,        // BRT
  liveScoreLine?: string,    // tennis live placar
  imminentNote?: string,     // esports pré bo1
  kellyLabel?: string,       // esports
  seed?: string,             // matchId — default = team1+team2
}
```

**Output (template ordenado):**
```
{SPORT_ICON} 💰 *TIP {SPORT_LABEL} — {HEADER_SLANG}* {LIVE_FLAG}
*{team1}* vs *{team2}*
📋 {league}{TIER_BADGE}
{SPORT_SPECIFIC_LINE}  ← surface tennis, format Bo1, org MMA
{matchTime ? `🕐 ${matchTime} (BRT)` : ''}
{liveScoreLine || ''}

{reason ? `🧠 Por quê: _${reason}_` : ''}

🎯 Aposta: *{pick}*{marketType !== 'ML' ? ` ${marketType}` : ''} @ *{odd}*
{minTake ? `📉 Odd mínima: *${minTake}*` : ''}
{lineShopText || ''}
📈 EV: *+{ev}%*
💵 Stake: *{stake}*{kellyLabel ? ` _(${kellyLabel})_` : ''}
{CONF_EMOJI} Confiança: *{conf}* — _{CONF_SLANG}_

{extraNotes.join('\n')}
{imminentNote || ''}

⚠️ _{FOOTER_SLANG}_
```

**Decisões implementadas:**

1. `HEADER_SLANG` vem de `pickSlang('header_{conf|live}', seed)`
2. `CONF_SLANG` vem de `pickSlang('conf_{conf}', seed)`
3. `FOOTER_SLANG` vem de `pickSlang('footer', seed)`
4. `LIVE_FLAG` = `'(AO VIVO 🔴)'` se isLive, senão ''
5. `SPORT_ICON` + `SPORT_LABEL` via map interno:
   - tennis: 🎾 TÊNIS
   - football: ⚽ FUTEBOL
   - lol: 🎮 LOL (ou ${gameIcon} se passado em opts)
   - cs: 🔫 CS
   - dota2: 🛡️ DOTA2
   - valorant: 🎯 VALORANT
   - mma: 🥊 MMA
   - basket: 🏀 BASKET
   - darts: 🎯 DARTS
   - snooker: 🎱 SNOOKER
   - tabletennis: 🏓 TT
6. **Números intactos:** `odd`, `ev`, `stake`, `minTake` saem do template literal como strings já formatadas externamente. Helper não converte/arredonda.

### 2.3 Refactor `bot.js` (13 blocos)

Cada `const tipMsg = \`...\`` longo → chamada compacta:

**Antes (tennis, bot.js:20128-20140):**
```js
const tipMsg = `🎾 💰 *TIP TÊNIS${isLiveTennis ? ' (AO VIVO 🔴)' : ''}*\n` +
  `*${match.team1}* vs *${match.team2}*\n` +
  `📋 ${match.league}${grandSlamBadge}\n` +
  `${surfaceEmoji} ${surface.charAt(0).toUpperCase() + surface.slice(1)} | 🕐 ${matchTime} (BRT)\n` +
  liveScoreLine + '\n' +
  whyLineTennis +
  `🎯 Aposta: *${tipPlayer}* @ *${tipOdd}*\n` +
  minTakeLine +
  _bookTennis +
  `📈 EV: *+${tipEV}%* | De-juice: ${tipPlayer === match.team1 ? fairP1 : fairP2}%\n` +
  `💵 Stake: *${formatStakeWithReais('tennis', String(tipStake).replace(/u+$/i, ''))}*\n` +
  `${confEmoji} Confiança: *${tipConf}*\n\n` +
  `⚠️ _Aposte com responsabilidade._`;
```

**Depois:**
```js
const tipMsg = buildTipMessage({
  sport: 'tennis', marketType: 'ML',
  match: { team1: match.team1, team2: match.team2, league: match.league },
  pick: tipPlayer, odd: tipOdd, ev: tipEV,
  stake: formatStakeWithReais('tennis', String(tipStake).replace(/u+$/i, '')),
  conf: tipConf, isLive: isLiveTennis,
  minTake: minTakeOdds, reason: tipReasonTennis,
  lineShopText: _bookTennis, matchTime, liveScoreLine,
  extraNotes: [
    `${surfaceEmoji} ${surface.charAt(0).toUpperCase() + surface.slice(1)}`,
    grandSlamBadge ? `🏆 ${grandSlamBadge.trim()}` : null,
  ].filter(Boolean),
  seed: String(match.id || match.team1 + match.team2),
});
```

**De-juice info** (que aparece em algumas tips como linha extra `EV +X% | De-juice Y%`) — vou preservar via campo `extraInfoOnEvLine` opcional, OR mover pra extraNotes.

Cada bloco perde 8-15 linhas → ganha ~3 linhas. Net delta: **-150 a -250 LoC em bot.js**.

---

## 3. Testes (TDD)

### `tests/test-tipster-slang.js`
- `pickSlang('header_alta', 'seed1')` retorna string do pool
- `pickSlang('header_alta', 'seed1')` 2× retorna mesma string (determinismo)
- `pickSlang('header_alta', 'seed2')` ≠ `pickSlang('header_alta', 'seed1')` (na maioria — depende do hash)
- Pool inválido → erro ou fallback safe
- Seed vazio/undefined → fallback safe (não throw)

### `tests/test-tip-message-builder.js`
- Tennis ML render → contém `🎾`, `TÊNIS`, team1, team2, EV, stake, `+18`
- Football ML render → contém `⚽`, `FUTEBOL`
- LoL ML LIVE → contém `AO VIVO 🔴`
- LoL ML pré Bo1 com extraNotes → linha extra aparece
- minTake undefined → linha não aparece (não imprime "undefined")
- reason undefined → linha "Por quê" não aparece
- Números (odd, EV, stake) saem intactos (regex match exato)
- Seed determinístico → 2 builds idênticos = string igual
- Markdown válido (`*...*`, `_..._` balanceados) — smoke check

---

## 4. Validação manual

Após implementar:
1. `node -c bot.js && node -c lib/tip-message-builder.js && node -c lib/tipster-slang.js`
2. `node tests/test-tipster-slang.js` (deve passar)
3. `node tests/test-tip-message-builder.js` (deve passar)
4. Render 1 exemplo de cada sport em script de smoke (console.log) → leitura visual

---

## 5. Arquivos afetados

| Arquivo | Tipo | LoC |
|---|---|---|
| `lib/tipster-slang.js` | NOVO | +80 |
| `lib/tip-message-builder.js` | NOVO | +180 |
| `tests/test-tipster-slang.js` | NOVO | +60 |
| `tests/test-tip-message-builder.js` | NOVO | +100 |
| `bot.js` | refactor 13 blocks | -150 a -250 |

**Net delta:** redução ~50-150 linhas no codebase produtivo (excluindo tests).

---

## 6. Não-objetivos (Fase 1)

- Não toca `recordMarketTipAsRegular` (MT path — Fase 2)
- Não toca mensagens de settle (`✅ Tip ganha`, `❌ Tip perdida`) — Fase 2
- Não adiciona digestes ou outras mensagens admin
- Não muda `sendDM`, `_buildTipBetButton`, `formatStakeWithReais`
- Não adiciona dependências npm
- Não adiciona envs novas

---

## 7. Compliance CLAUDE.md

| Princípio | Compliance |
|---|---|
| **P1 — Granularidade** | ✅ Helper aceita marketType/tier/conf — flexível |
| **P2 — Shadow=causa** | N/A — só texto, não decide nada |
| **P3 — Anti-overfeaturing** | ✅ Helper UNIFICA 13 duplicações, não adiciona |
| **P4 — Otimização** | ✅ Reduz LoC, elimina drift |
| **P5 — Cross-sport** | ✅ Helper é cross-sport por construção |
| **Dinheiro sagrado** | ✅ Não toca Kelly/EV/stake/odds — só texto |
| **Pre-flight** | ✅ Spec aprovada antes de implementar |

---

## 8. Commit plan

1 commit principal:
```
feat(tip-messages): unifica 13 emit paths via lib/tip-message-builder + slang BR

- lib/tipster-slang.js: pools determinísticos por seed (header/conf/footer)
- lib/tip-message-builder.js: helper buildTipMessage(opts) cross-sport
- bot.js: refactor 13 emit blocks (ML/handicap) — -150 a -250 LoC
- tests: cobertura snapshot + determinismo

Fase 1 — apenas emissão. Settle messages (chumbo grosso etc) = Fase 2.
Zero risco financeiro: não toca Kelly/EV/stake/odds.
```
