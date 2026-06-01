# Match Lab — Plano 2: Surfacing (endpoint + UI no /edge)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Plugar o `predictMatch()` validado (Plano 1) na UI: um endpoint display-only + a evolução do painel Draft Lab → **Match Lab** (inputs de time + autocomplete + lado + draft → win% calibrado com breakdown), no `/edge`.

**Architecture:** `POST /api/lol-match-analyze` (chama `predictMatch`) + `GET /api/lol-teams` (autocomplete) no `server.js`; UI estende o overlay Draft Lab existente em `public/lol-live-dashboard.html`. Display-only — nada de stake/EV/Kelly. Spec §8: `docs/superpowers/specs/2026-06-01-lol-match-lab-design.md`.

**Gate:** Plano 1 passou o ship-gate (Elo calibrado bate base-rate OOS −13,6%). `predictMatch` existe e está testado.

**Money-path guard:** `predictMatch` é display-only; o endpoint só lê DB + retorna JSON; nenhuma escrita, nenhum stake. `getLolProbability` intocado.

---

## Estrutura de arquivos

**Modificar**
- `server.js` — add `POST /api/lol-match-analyze` + `GET /api/lol-teams` (perto do `/api/lol-draft-analyze`, ~linha 5314).
- `public/lol-live-dashboard.html` — team inputs + datalist autocomplete + ação "Analisar partida" + render do breakdown de match (estende o overlay Draft Lab).

**Intocado:** qualquer path de bet/stake/EV/Kelly; `getLolProbability`; `lib/lol-match-predict.js` (já pronto — só consumir).

---

### Task 1: Endpoints (server.js)

**Files:** Modify `server.js`

- [ ] **Step 1: Achar o handle de db + o pattern dos endpoints LoL**

Ler `server.js` ~5314-5340 (`/api/lol-draft-analyze`) pra ver: como `_readPostBody`/`safeParse`/`sendJson` são usados, e como os endpoints acessam o `db` (handle better-sqlite3 — `predictMatch(db, …)` precisa dele; achar o mesmo `db` que outros endpoints usam, ex: o que `_formSubModel`/queries usam).

- [ ] **Step 2: Adicionar `POST /api/lol-match-analyze`** (logo após o bloco `/api/lol-draft-analyze`)

```javascript
  // Match Lab — full match predictor (display-only). Calls predictMatch (Elo+capped-draft, calibrated).
  if (p === '/api/lol-match-analyze' && req.method === 'POST') {
    _readPostBody(req, res, (body) => {
      if (body == null) return;
      try {
        const json = safeParse(body, null);
        const { predictMatch } = require('./lib/lol-match-predict');
        const draft = (Array.isArray(json?.blue) && Array.isArray(json?.red) && json.blue.length && json.red.length)
          ? { blue: json.blue.slice(0, 5), red: json.red.slice(0, 5) } : null;
        const out = predictMatch(db, {
          team1: json?.team1 || null,
          team2: json?.team2 || null,
          side: json?.side === 'red' ? 'red' : 'blue',
          draft,
          league: json?.league || null,
        });
        sendJson(res, { ok: true, ...out });
      } catch (e) {
        log('WARN', 'MATCH-LAB', `match-analyze err: ${e.message}`);
        sendJson(res, { ok: false, error: 'match_analyze_failed' }, 500);
      }
    });
    return;
  }
```
(Use the SAME `db` handle the surrounding endpoints use. If draft-analyze didn't need `db`, find the handle other DB-querying endpoints use — it's a module-scope `db`.)

- [ ] **Step 3: Adicionar `GET /api/lol-teams`** (autocomplete — distinct team names from the Elo universe + OE)

```javascript
  // Match Lab — team-name autocomplete (datalist source). Display-only.
  if (p === '/api/lol-teams' && req.method === 'GET') {
    try {
      const set = new Set();
      for (const r of db.prepare(`SELECT DISTINCT team1 t FROM match_results WHERE game='lol' AND team1 IS NOT NULL AND team1!=''
                                   UNION SELECT DISTINCT team2 t FROM match_results WHERE game='lol' AND team2 IS NOT NULL AND team2!=''`).all()) set.add(r.t);
      try { for (const r of db.prepare(`SELECT DISTINCT teamname t FROM oracleselixir_players WHERE teamname IS NOT NULL AND teamname!=''`).all()) set.add(r.t); } catch (_) {}
      sendJson(res, { ok: true, teams: [...set].sort((a, b) => a.localeCompare(b)) });
    } catch (e) {
      sendJson(res, { ok: false, error: 'teams_failed' }, 500);
    }
    return;
  }
```

- [ ] **Step 4: Syntax + smoke local**

Run: `node -c server.js`
Then start the server on a test port if feasible, or rely on the deploy smoke. Minimum: `node -c server.js` passes; the suite stays green: `node tests/run-all.js 2>&1 | tail -3` (or `npm test`). Expected ≥912 passed.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat(match-lab): POST /api/lol-match-analyze + GET /api/lol-teams (display-only)"
```

---

### Task 2: Match Lab UI (extends the Draft Lab overlay)

**Files:** Modify `public/lol-live-dashboard.html`

Context (verified): the overlay `#draftLab` has `#dlBlueTeam`/`#dlRedTeam` columns (labels "Blue Side"/"Red Side"); `buildPicks('dlBlueTeam','blue')`/`buildPicks('dlRedTeam','red')` inject the 5 role inputs `dl_${side}_${ROLE}`; `dlAnalyze()` posts to `/api/lol-draft-analyze`; `dlRenderResult(data)` renders the draft result. The print upload (`dlSubmitPrintFile`, Ctrl+V) prefills the role inputs.

- [ ] **Step 1: Ler o painel + dlAnalyze + dlRenderResult + buildPicks**

Read `public/lol-live-dashboard.html` around the `#draftLab` panel markup (~1294-1325), `buildPicks` (~1900-1917), `dlAnalyze` and `dlRenderResult` (~1939+) to learn the exact structure before editing.

- [ ] **Step 2: Team-name inputs + datalist autocomplete**

Add a team-name `<input>` to each side column (inside `#dlBlueTeam`/`#dlRedTeam`, above the role picks — either in the markup or appended by `buildPicks`). Wire a shared `<datalist id="dlTeamList">` populated once on load from `GET /api/lol-teams`. Inputs: `id="dl_blueTeam"` (blue side team), `id="dl_redTeam"` (red side team), each `list="dlTeamList"`, placeholder "Time (blue/red)".

```javascript
// on load (near startPolling): populate the datalist once
fetch('/api/lol-teams').then(r=>r.json()).then(d=>{
  if (!d.ok) return; const dl = document.getElementById('dlTeamList'); if (!dl) return;
  dl.innerHTML = ''; for (const t of d.teams) { const o=document.createElement('option'); o.value=t; dl.appendChild(o); }
}).catch(()=>{});
```

- [ ] **Step 3: "Analisar partida" — chama /api/lol-match-analyze**

Add a primary button **"Analisar partida"** (next to "Analisar draft") that gathers blue team / red team + the draft (the 10 role inputs, same collection `dlAnalyze` uses) and POSTs to `/api/lol-match-analyze`:

```javascript
async function dlAnalyzeMatch() {
  const team1 = (document.getElementById('dl_blueTeam')?.value || '').trim() || null; // blue = team1
  const team2 = (document.getElementById('dl_redTeam')?.value || '').trim() || null;
  const draft = dlCollectDraft(); // reuse whatever dlAnalyze uses to read the 10 champ inputs → {blue:[{champion,role}],red:[...]} or null
  const btn = document.getElementById('dlAnalyzeMatchBtn'); if (btn){ btn.disabled=true; btn.textContent='…'; }
  try {
    const r = await fetch('/api/lol-match-analyze', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ team1, team2, side:'blue', blue: draft?.blue, red: draft?.red }) });
    const data = await r.json();
    if (!data.ok) { dlSetError(data.error || 'Erro'); return; }
    dlRenderMatchResult(data, team1, team2);
  } catch(e){ dlSetError('Falha: '+e.message); }
  finally { if (btn){ btn.disabled=false; btn.textContent='Analisar partida'; } }
}
```
(If a helper that reads the 10 champ inputs into `{blue,red}` doesn't exist as a separate fn, factor the reading logic out of `dlAnalyze` into `dlCollectDraft()` and reuse in both — DRY.)

- [ ] **Step 4: Render do breakdown de match**

```javascript
function dlRenderMatchResult(data, team1, team2) {
  const root = document.getElementById('dlResult'); root.innerHTML=''; root.classList.add('visible');
  const pct = (x)=> (x==null?'—':(x*100).toFixed(1)+'%');
  // headline: P(team1) vs P(team2)
  root.appendChild(el('div', { class:'dl-prob-bar-wrap' },
    el('div', { class:'dl-bar-blue', style:`width:${(data.prob*100).toFixed(1)}%` }),
    el('div', { class:'dl-bar-red',  style:`width:${((1-data.prob)*100).toFixed(1)}%` })));
  root.appendChild(el('div', { class:'dl-subtitle' },
    `${team1||'Blue'} ${pct(data.prob)} · ${team2||'Red'} ${pct(1-data.prob)} — ${data.label} (conf ${pct(data.confidence)})`));
  // breakdown: elo + draft components (P blue)
  const c = data.components||{};
  const rows = [];
  if (c.elo)   rows.push(['Elo (P blue)', pct(c.elo.pBlue), `conf ${pct(c.elo.confidence)}`]);
  if (c.draft) rows.push(['Draft (P blue)', pct(c.draft.pBlue), 'lean pequeno']);
  for (const [k,v,note] of rows) root.appendChild(el('div', { class:'dl-comp-row' },
    el('span',{class:'dl-comp-k'},k), el('span',{class:'dl-comp-v'},v), el('span',{class:'dl-comp-note'},note)));
  if (!c.elo) root.appendChild(el('div', { class:'dl-paste-hint' }, 'sem times → lean fraco (só draft). Preencha os times pra usar o Elo.'));
}
```
(Reuse existing `el()` helper + `.dl-prob-bar-wrap`/`.dl-bar-blue`/`.dl-bar-red` styles already in the panel. Add minimal CSS for `.dl-comp-row/k/v/note` if needed, matching the panel's mono style.)

- [ ] **Step 5: Botão no markup**

Add `<button class="btn primary" id="dlAnalyzeMatchBtn" onclick="dlAnalyzeMatch()">Analisar partida</button>` in `.dl-actions` (keep "Analisar draft" as the draft-only fallback). Update the subtitle to "análise de partida — times + lado + draft".

- [ ] **Step 6: Validate**

vm-syntax-check the inline script (extract `<script>` blocks, `new vm.Script(b)` each — the prior tasks used this). Confirm the new symbols present (`dlAnalyzeMatch`, `dl_blueTeam`, `/api/lol-match-analyze`, `dlTeamList`). `node -c server.js` (unchanged but cheap).

- [ ] **Step 7: Commit**

```bash
git add public/lol-live-dashboard.html
git commit -m "feat(match-lab): Match Lab UI — team inputs + autocomplete + match breakdown on /edge"
```

---

## Definition of Done (Plano 2)
- [ ] `POST /api/lol-match-analyze` + `GET /api/lol-teams` live in server.js; suite green.
- [ ] Match Lab UI: team inputs + datalist autocomplete + "Analisar partida" → calibrated win% + Elo/draft breakdown; draft-only fallback preserved; Ctrl+V print still prefills.
- [ ] Display-only; `getLolProbability`/betting untouched.
- [ ] (after merge) deploy smoke: `/edge` Match Lab renders; `POST /api/lol-match-analyze` with two real teams returns a sane win% + breakdown.

## Self-review (writing-plans)
- **Cobertura spec §8:** team inputs (Task 2.2) + autocomplete (2.2) + side (implícito blue/red cols) + breakdown (2.4) + draft-only fallback (2.4) + endpoint (Task 1). Live-match prefill = deferred nice-to-have (não bloqueia).
- **Placeholders:** `dlCollectDraft` = factor-out explícito do leitor de inputs do `dlAnalyze` (escopo claro, Step 3). `db` handle = Task 1 Step 1 localiza.
- **Consistência:** endpoint retorna o shape do `predictMatch` (`{prob, probBlue, components:{elo,draft}, confidence, label}`) — consumido igual no `dlRenderMatchResult`.
