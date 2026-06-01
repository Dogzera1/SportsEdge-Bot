# Design — Draft Lab: draft-only win probability on `/edge`

**Date:** 2026-05-31
**Status:** approved direction (user). v1 = display-only; phased promotion into live model gated + deferred.

## Problem / Context

The `/edge` LoL Live Edge Terminal (`public/lol-live-dashboard.html`, served by server.js:36357) shows live in-play edges (Riot livestats + model + Pinnacle EV). The user wants it to **also** be a **draft analysis platform**: given a champion draft, show each team's **win probability based only on the draft**, plus an option to **paste a screenshot** when the system has no API access to the draft.

**What already exists (P3 — do NOT rebuild):**
- `collectGameContext` (bot.js:10048) reads the 10 champions per team from the live feed (`blueTeam/redTeam.players[].champion`), detects draft completeness, and computes `compScore = blueAvg − redAvg` (pp advantage for blue by pro champion WR).
- `_compSubModel` (lib/lol-model.js:204) maps `compScore` → win prob (logit `compScore*0.04`, confidence `|compScore|/15`); DB fallback uses `pro_champ_stats` when ≥20 fresh champs.
- Tables `pro_champ_stats` (champion, role, wins, total, patch) and `pro_player_champ_stats` (player, champion, ...) are populated (PandaScore sync + gol.gg seed/merge).
- `oracleselixir_games` (migration 358) stores **`pick1..5` + `ban1..5` per side + `result` + `patch` + `league` + per-game stats** for every pro game — full drafts + outcomes, internal. Already used in prod (kills resolution server.js:18441), so populated.
- Claude vision is integrated (`/claude` path + `image/png|jpeg` handling server.js:36329); code already knows "DeepSeek não suporta imagem direta" and has an `ocrText` ingestion path (server.js:37610).

**Gap:** the current draft signal is a single avg-WR-diff number, blended into `getLolProbability`. There is no standalone draft-only probability, no lane/synergy/counter breakdown, no UI surface, and no manual/screenshot input path.

## Goals

1. **Standalone draft-only win probability** (blue vs red) computed from the draft alone, surfaced on `/edge`.
2. **Rich, interpretable breakdown** (hybrid): a trained engine produces the number; component analysis (per-lane matchups, synergies, counters, WR-diff, player-champ mastery) explains *why*, with sample-size shrinkage and exposed confidence.
3. **Three input paths:** (a) automatic from the live feed when the match is covered; (b) manual champion picker; (c) screenshot → Claude vision → pre-fill → **mandatory user confirmation** → analyze.
4. Built **entirely from internal data** (`oracleselixir_games` + `pro_*_stats`). **No new npm deps. No new DB schema** (model artifacts as JSON, mirroring `lol-weights.json`).

## Non-goals (v1 — YAGNI)

- Does **not** touch live pricing, EV, Kelly, or tip emission. Display/decision-support only.
- No ban/pick recommendations, no draft simulator, no tier lists, no multi-patch comparison UI.
- No live/automatic retraining — the training script is run manually/cron per patch.

## Architecture (isolated units)

1. **`lib/lol-draft-model.js`** (new, pure) — the engine.
   `computeDraftWinProb(draft, { patch, league }) → { prob, confidence, breakdown: { laneMatchups[], synergies[], counters[], wrDiff, mastery } }`
   where `draft = { blue: [{champion, role, player?}×5], red: [...×5], bans? }`. No side effects; fully unit-testable. Reads the JSON artifacts (loaded once, cached in memory).

2. **Model artifacts (new JSON, no schema migration; `/data`-persisted like calib):**
   - `lib/lol-draft-weights.json` — logistic regression coefficients (final-number engine), with per-patch calibration.
   - `lib/lol-draft-matchups.json` — champ-vs-champ matrix **by role** → `{wins, n}` (lane counters).
   - `lib/lol-draft-synergy.json` — same-side champ-pair matrix → `{wins, n}` (synergy).
   Matrices are sparse (only observed pairs). Committed seed + regenerable to `/data` in prod.

3. **`scripts/train-lol-draft-model.js`** (new, offline) — reads `oracleselixir_games` (+ joins `oracleselixir_players` for champion↔role alignment, since `pick1..5` order is not a guaranteed role map), builds the matchup/synergy matrices with shrinkage, fits the logistic engine, writes the three JSON artifacts. Walk-forward eval baked in (see Testing).

4. **`POST /api/lol-draft-analyze`** (new endpoint) — `{ champs (10), sides, roles?, patch?, matchId? }` → `{ prob, confidence, breakdown }`. Thin wrapper over `lib/lol-draft-model`. Public (the dashboard JS calls it, like `/api/lol-live-dashboard`).

5. **Print parse** — reuses the existing Claude vision integration. `POST` image → Claude returns `{ champs, sides, roles, confidence }` → returned to the front for **mandatory confirmation/edit** before any analyze call. Never auto-computes from an unconfirmed parse. Because this triggers a paid Claude call from a public page, the endpoint is **rate-limited (per-IP) + size-capped**, and reuses the existing `TENNIS_AI_DAILY_CAP`-style daily cap pattern to prevent cost abuse.

6. **UI** — a new "Draft Lab" section in `public/lol-live-dashboard.html`, following the ANTE//LIVE design system. Works **even with no live match** (analyze any draft): champion pickers (searchable, 10 slots, 2 sides, role tags), a "📷 colar print" upload, and the prob + breakdown render (lane-by-lane deltas, synergy/counter highlights, confidence meter).

## Model design (hybrid + shrinkage)

- **Final number:** logistic regression on `oracleselixir_games`. Features: Σ per-lane matchup deltas, synergy scores (blue−red), champion WR-diff, player-champ mastery (from `pro_player_champ_stats`). Calibrated per patch.
- **Breakdown (parallel, interpretable):** each component computed from the matrices and **shrunk by sample size** — prior = champion base WR; a matchup with n=3 contributes ~nothing, n=200 contributes fully. Panel confidence is a function of the relevant n's.
- **Graceful degradation:** thin data → collapses toward WR-diff with low confidence (honest, never fabricates an edge — same spirit as the `/edge` "blind" banner). **Roles are optional input**: the feed/vision usually provides them, but if absent, the lane-matchup component is omitted (number falls back to WR-diff + synergy) and confidence is lowered.
- **Champion-name normalization:** a canonical-key layer maps feed / vision / Oracle's Elixir / Data Dragon spellings (e.g., Wukong↔MonkeyKing, "Nunu & Willump", "Renata Glasc") to one key. Shared helper; required so all sources join.

## Data flow

- **Feed path:** match in `status==='draft'` → `collectGameContext` already extracts champs → `lib/lol-draft-model` → panel.
- **Manual path:** user picks champs/sides/roles → `/api/lol-draft-analyze` → panel.
- **Print path:** upload → Claude vision → parsed draft → **user confirms/edits** → `/api/lol-draft-analyze` → panel.

## Testing / validation

- **Walk-forward backtest** in `scripts/train-lol-draft-model.js`: train on patches ≤N, test on N+1. Report Brier, ECE, log-loss vs the current WR-diff baseline (`compScore`). The rich model must beat baseline OOS to be considered useful.
- **Unit tests** for `lib/lol-draft-model`: shrinkage math, breakdown assembly, edge cases (new champion with no data, incomplete draft, unknown name → normalization miss).
- **Parse:** validated against real broadcast screenshots; the mandatory confirm step is the safety net for vision errors.

## Phase 2 — promote into the live model (deferred, gated)

Feeding the draft prob into `getLolProbability` (reinforce/replace `_compSubModel`) is **out of v1**. Gate before any promotion: walk-forward holdout beating baseline, per-patch calibration, explicit env flag, and **user authorization** — it is money-path (SAGRADO) and LoL is currently in shadow.

## Rollout

1. Train script + artifacts (committed seed) → walk-forward numbers reviewed.
2. `lib/lol-draft-model` + unit tests.
3. `/api/lol-draft-analyze` + print-parse endpoint.
4. UI panel.
Each step is independently shippable; v1 ends display-only.

## Risks / prerequisites

- **Confirm `oracleselixir_games` coverage in prod** (years/leagues) before training — strongly implied populated (kills-resolution uses it); verify breadth.
- **Sparsity** of pro matchup/synergy → mitigated by shrinkage + exposed confidence; rich edge may be modest for off-meta picks.
- **Vision cost/accuracy:** 1 Claude call per print, user-triggered (not automatic); confirm step covers misreads.
- **No new deps, no schema migration.** Artifacts persist via `/data` (like calib).
