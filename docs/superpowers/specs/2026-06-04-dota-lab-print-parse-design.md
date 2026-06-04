# Dota Lab — colar/ler o draft por print com IA (vision)

**Data:** 2026-06-04
**Tipo:** feature display-only (espelha o print-parse do Draft Lab de LoL para o Dota Lab)
**Abordagem escolhida:** B — endpoint Dota novo espelhado, sem refatorar o path LoL existente.

---

## Objetivo

Adicionar ao **Dota Lab** (`/edge`, overlay `#dotaLab`) a opção de **colar/enviar um print** (draft pick-screen ou scoreboard in-game) e **ler com IA** (Claude Sonnet vision), pré-preenchendo os campos do painel — exatamente como o Draft Lab de LoL já faz (`/api/lol-draft-parse-print` + `dlSubmitPrintFile`/`Ctrl+V`).

A **análise** já existe no Dota Lab (win% por Elo calibrado + força de draft por WR + Análise da IA via `/api/dota-match-analyze` e `/api/dota-match-explain`). **Nada de análise nova** — esta feature só adiciona o **input por print** que alimenta a análise existente.

### Escopo de extração (decidido com o user)
O print preenche **times + 5 heróis + jogadores por lado**. O jogador é **display/conferência apenas**: o modelo Dota usa só Elo (times) + WR de heróis (`predictMatch` em `lib/dota-match-predict.js`); não há maestria de jogador (≠ LoL Phase 2). O nick **não** é enviado ao `analyze` nem ao prompt da IA (evita a IA narrar jogador fora do cutoff/patch).

---

## O que muda / o que NÃO muda

**Muda:**
- Novo lib `lib/dota-draft-parse.js` (prompt de vision + normalização de herói).
- Novo endpoint `POST /api/dota-draft-parse-print` (server.js).
- `public/lol-live-dashboard.html`: bloco de print no `#dotaLab`, slots herói+jogador, handlers de upload/paste.
- Novo teste `tests/test-dota-draft-parse.js`.

**NÃO muda (garantias):**
- `/api/lol-draft-parse-print` e todo o path do Draft Lab de LoL — **byte-unchanged** (Abordagem B não toca o LoL).
- Money-path: `bot.js`, `lib/scanner*`, `lib/market-tip-processor`, `lib/dota-map-model` (money-path live de Dota) — **zero referências novas**. `predictMatch`/`dota-match-explain` já são display-only e não mudam.
- Schema do DB, dependências npm, crons, envs SAGRADAS — nenhuma alteração.

---

## Componente 1 — `lib/dota-draft-parse.js` (novo, puro/testável)

Espelha o papel de `lib/lol-champions.js` (que tem `normalizeChampion`) para o domínio Dota. Sem dependências de `res`/HTTP — funções puras + acesso de leitura ao `db`.

### `buildDotaPrintPrompt()` → string
Prompt de vision adaptado ao Dota 2. Pontos obrigatórios:
- A imagem é um **draft (pick screen)** OU um **scoreboard in-game** de Dota 2.
- Retornar **APENAS** JSON compacto, sem prosa:
  `{"teams":{"blue":"<nome ou null>","red":"<nome ou null>"},"blue":[{"hero":"<nome>","player":"<nick ou null>"}],"red":[...]}`
  com exatamente **5 entradas por lado**.
- **Mapeamento de lado:** `Radiant` → `blue`, `Dire` → `red`. Em scoreboard, Radiant fica em cima/à esquerda (verde) e Dire embaixo/à direita (vermelho). Em pick-screen, Radiant à esquerda.
- **Nome do herói:** nome **oficial em inglês** do Dota 2 lido do ícone/retrato + texto (ex.: `Anti-Mage`, `Nature's Prophet`, `Queen of Pain`, `Outworld Destroyer`). **Nunca** usar apelidos/abreviações (não `AM`, `QoP`, `Furion`, `Wisp`). Não deduzir herói por posição/lane.
- **`player`:** nick humano do jogador (pode vir com tag de time, ex.: `Tundra.Nine`, `OG ATF`). É um texto **separado** do nome do herói — nunca copiar o nome do herói para `player`. Se não houver nick legível, `null`.
- **Anti-alucinação:** ler todo texto exatamente como aparece; se um valor não for claramente legível, usar `null` em vez de chutar.

### `normalizeHeroName(db, raw)` → string|null
Casa o nome lido pela IA contra `dota_hero_stats.localized_name`. **Necessário** porque o modelo casa herói por nome exato (`getTeamDraftStrength`/`_loadMetaMap` em `lib/dota-hero-features.js` usa `localized_name.toLowerCase().trim()`); sem normalização, qualquer variação cai no WR neutro 0.5 silenciosamente.

Algoritmo (data-driven, sem dicionário hardcoded de apelidos — P3):
1. Carregar `SELECT localized_name FROM dota_hero_stats WHERE localized_name IS NOT NULL AND localized_name != ''` (cache in-memory ~30min, padrão do `_loadMetaMap`). Sem filtro `pro_pick` (queremos todos os heróis).
2. **Match exato:** `raw.toLowerCase().trim()` === `localized_name.toLowerCase().trim()` → retorna o `localized_name` canônico.
3. **Match "loose":** reduzir ambos a `[a-z0-9]+` minúsculo (remove hífen/apóstrofo/espaço/pontuação) e comparar. Se houver correspondência **única**, retorna o canônico. (`"antimage"`→`Anti-Mage`, `"natures prophet"`→`Nature's Prophet`.)
4. Senão `null` (apelido não-oficial como `QoP`/`Furion` cai aqui; a IA é instruída a não usá-los, e o user revisa).

Decisão consciente: **não** montar tabela de apelidos (custo de manutenção por patch, P3). A combinação prompt-explícito + match loose cobre o caso real; o resto o user corrige no input (já é `needsConfirmation`).

---

## Componente 2 — `POST /api/dota-draft-parse-print` (server.js)

Inserir junto aos demais endpoints do Dota Lab (server.js ~5526) ou adjacente ao `/api/lol-draft-parse-print` (~5595). Espelha o esqueleto do endpoint LoL:

1. `_readPostBody(req, res, cb, 2000000)` — eleva o default de 64KB para 2MB (igual ao LoL).
2. Gate `ANTHROPIC_API_KEY` ausente → `503 {error:'vision_disabled'}`.
3. Valida `imageBase64` como data-URL `image/(png|jpeg|webp)`; `b64.length > 7000000` → `413 {error:'image_too_large'}`.
4. **Cap diário COMPARTILHADO** com o LoL: mesmo `global._draftVisionDayMap` + `ANTHROPIC_VISION_DAILY_CAP` (default 50), reservado **antes** da chamada paga. Justificativa: é a mesma API Anthropic paga; compartilhar a quota é o comportamento conservador de custo.
5. `aiPost('anthropic', …, { model:'claude-sonnet-4-5', max_tokens:1024, image+text })`, `timeoutMs:30000`, `retry.maxAttempts:2`. `stmts.incrApiUsage('anthropic', …)`.
6. Extrair texto, `safeParse` do primeiro `{…}`. Se falhar → `502 {error:'parse_failed', raw}`.
7. Normalizar cada lado:
   `tag(arr) = arr.map(e => ({ hero: e.hero, player: stripPlayerTeamTag(e.player), key: normalizeHeroName(db, e.hero) }))`
   (reusa `stripPlayerTeamTag` de `lib/lol-champions` — best-effort, jogador é display).
8. Responder `{ ok:true, teams:{blue,red}|null, blue:[…], red:[…], needsConfirmation:true }`.

`log('WARN','DOTA-LAB', …)` no catch (helper existente; sem logging novo paralelo).

---

## Componente 3 — Front-end (`public/lol-live-dashboard.html`)

### Markup — bloco de print no `#dotaLab`
Espelha o do Draft Lab (~linhas 1418–1425): botão `📷 enviar print` + `<input type="file" id="dotaPrintInput" accept="image/*" style="display:none" onchange="dotaParsePrint(this)">` + `<div class="dl-print-msg" id="dotaPrintMsg">` (reusa a classe `.dl-print-msg` existente). Atualizar o subtítulo do painel para mencionar o print.

### Slots herói + jogador (`initDotaLab`)
Hoje cada lado tem 5 inputs `.dota-hero`. Passa a criar, por slot, um wrapper `.dota-slot` com **[input `.dota-hero`] + [input `.dota-player` placeholder "jogador"]**. CSS mínimo novo `.dota-slot` (herói + nick lado a lado).
- `dotaCollect()` **inalterado no envio**: continua coletando só `.dota-hero` para `team1/team2/blue/red`. Jogador não é coletado para `analyze`/`explain`.

### Upload/paste
- `dotaSubmitPrintFile(file)`: reusa `dlDownscaleToDataUrl(file)` (genérico — já faz upscale até 2.5x de prints pequenos + JPEG 0.92) → `POST /api/dota-draft-parse-print {imageBase64}` → prefill:
  - heróis: i-ésimo `.dota-hero` recebe `key || hero` (canônico quando reconhecido; senão o texto lido, para o user corrigir).
  - jogadores: i-ésimo `.dota-player` recebe `player`.
  - times: `#dota_blueTeam`/`#dota_redTeam` recebem `teams.blue`/`teams.red`.
  - Mensagens de status/erro espelham o LoL (503 → "indisponível (ANTHROPIC_API_KEY)", `image_too_large`/`body_too_large` → "recorte e tente de novo", etc.) via **helpers próprios** `dotaSetPrintMsg`/`dotaSetError` escrevendo em `#dotaPrintMsg` (não reutilizar os `dlSet*` do LoL, que escrevem no DOM do `#draftLab` — manter os dois painéis desacoplados).
- `dotaParsePrint(input)`: chama `dotaSubmitPrintFile(input.files[0])` e reseta `input.value`.
- **Paste:** estender o listener `document` existente (~2532). Hoje só age com `#draftLab` aberto. Passa a rotear: `#dotaLab.open` → `dotaSubmitPrintFile`; senão `#draftLab.open` → `dlSubmitPrintFile`. Os dois nunca abrem juntos (`toggleDotaLab`/`toggleDraftLab` fecham um ao abrir o outro).

---

## Garantias e princípios

- **Money-path airtight (P-money/CRÍTICO):** feature 100% display-only. O endpoint só lê o print, chama vision e devolve nomes; `predictMatch` (já display-only) não muda. Verificação: `grep` confirmando que `dota-draft-parse` e o novo endpoint não são importados por `bot.js`/`scanner`/`market-tip-processor`/`dota-map-model`.
- **P1 (granularidade):** não aplicável a decisão de stake (display-only); não introduz agregação que mascare tier.
- **P2 (shadow=causa):** não toca tips/shadow/real; nenhuma decisão de sintoma.
- **P3 (anti-overfeaturing):** verificado que **não existe** `normalizeHero`/parse de print de Dota (grep). A duplicação do esqueleto de vision (~20 linhas) é consciente e anotada como follow-up P4 (extrair `visionParseDraft` comum cobrindo LoL+Dota numa próxima). Cap/quota é **compartilhado** (não cria env nova).
- **P5 (cross-sport):** esta é uma feature paralela **consciente** (Dota Lab espelha Draft Lab), não um bug propagado. A lógica de negócio fica isolada em lib testável justamente para conter a classe de bug que a duplicação criaria.
- **Custo:** protegido pelo `ANTHROPIC_VISION_DAILY_CAP` compartilhado (default 50/dia/IP). Sem dep npm nova.

---

## Testes (TDD)

`tests/test-dota-draft-parse.js` (espelha `tests/test-lol-player-tag.js`), usando um `db` stub/cópia com algumas linhas de `dota_hero_stats`:
- `normalizeHeroName`: match exato (`"Anti-Mage"`→`Anti-Mage`), variação loose (`"antimage"`/`"anti mage"`→`Anti-Mage`; `"natures prophet"`→`Nature's Prophet`), desconhecido/apelido (`"QoP"`,`"Furion"`,`""`,`null`→`null`), case-insensitive.
- `buildDotaPrintPrompt`: smoke (retorna string não-vazia exigindo JSON com `hero`/`player`/`teams` e citando Radiant/Dire).

Roda no pre-commit hook (suíte ~986 testes). Não testar getters/wrappers triviais.

---

## Fora de escopo (YAGNI)

- Embutir jogador no modelo/prob (Dota não tem maestria; e seria money-path).
- Dicionário de apelidos de heróis (match loose + prompt cobrem; manutenção por patch não compensa).
- Renomear labels "Blue/Red" → "Radiant/Dire" na UI do Dota Lab (mapeamento é feito no parse; renomear é UX à parte não pedida).
- Pré-preencher draft a partir de uma partida live do feed (não há feed live de Dota ingerido — `dota_live_snapshots` n=0).
- Refatorar `/api/lol-draft-parse-print` para o helper comum (Abordagem A) — anotado P4.
