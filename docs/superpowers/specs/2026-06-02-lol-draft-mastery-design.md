# Design — Draft Lab Phase 2: player×champion mastery

**Date:** 2026-06-02
**Status:** approved (user). Display-only; money-path untouched. Evolves the `masteryDiff` placeholder shipped inert in v1.

## Problem / Context

The Draft Lab engine `computeDraftWinProb` (`lib/lol-draft-model.js`) blends three logistic features — champion WR-diff, lane matchups, same-side synergy. A fourth feature, **`masteryDiff` (player×champion proficiency)**, was shipped as a placeholder hardcoded to `0` (`lib/lol-draft-model.js:73`) and is also `0` in the training script's feature vector (`scripts/train-lol-draft-model.js:42`), so its weight `w[4]` was learned as noise. The v1 spec (2026-05-31) already named player-champ mastery as an intended breakdown component; this phase materializes it.

**What already exists (P3 — do NOT rebuild):**
- `oracleselixir_players` (migration 023) — one row per player per game with `playername`, `champion`, `position`, `result`, `kills/deaths/assists`, `golddiffat15`, `dpm`, `date`, `league`, `patch`. Indices `idx_oep_playername(playername,date)`, `idx_oep_champion(champion,patch)`. This is **already the training source** for the draft model.
- `lib/oracleselixir-player-features.js` — player-level infra including `getExpectedRoster(db, team)` (infers a team's 5 starters by position over the last 30d) and `detectRosterSub`.
- `server.js /api/lol-live-draft:5417` — pulls the live draft from Riot lolesports; the `participantMetadata` objects it maps already carry `summonerName` (see `server.js:6650`), but the current `pick()` discards it.
- `lib/lol-draft-train.js` — pure builders (`buildWrTable`, `buildMatchupMatrix`, `buildSynergyMatrix`, `fitLogistic`, `sigmoid`).

**Gap:** the mastery feature is inert, the player names never reach the engine, and the engine has no player×champion artifact to read.

## Goals

1. A real **player×champion mastery** signal feeding `computeDraftWinProb`, combining **two** sub-signals that the logistic arbitrates, both **gated by experience** (sample size):
   - **WR deviation** — how the player's win rate with the champion deviates from the champion's base WR.
   - **Relative performance** — does the player perform *better* with this champion than across their own pool (KDA / gold@15 delta)?
2. **Hybrid name resolution** so the feature works with zero extra typing in the common case.
3. **Honest gating:** retrain with walk-forward A/B (with-mastery vs without); if mastery does not beat the current model OOS, its weights are forced to 0 (prob unchanged) but the breakdown still displays the mastery info.
4. Built entirely from internal data. **No new npm deps. No new DB schema** (mastery as a pre-computed JSON artifact; runtime stays a pure, DB-free function).

## Non-goals (YAGNI)

- Does **not** touch `getLolProbability`, EV, Kelly, stake, or tip emission. The engine is display-only and does not feed the money path, so **the money path is byte-unchanged by construction.** (Note: re-training refits the base weights, so the *display* prob of any draft shifts slightly — that is expected and display-only. The invariant we guarantee/test is that the mastery term contributes nothing when no player names are present, not that the display number equals the pre-Phase-2 value.)
- No live/automatic retraining — the training script runs manually/per-patch like today.
- No per-player UI beyond the mastery rows in the existing breakdown.
- No use of `pro_player_champ_stats` (see Source decision).

## Source decision — why `oracleselixir_players`, not `pro_player_champ_stats`

`pro_player_champ_stats` exists (PandaScore + gol.gg) but is a WR-only aggregate from a different name namespace. `oracleselixir_players` is chosen because: (a) it is **the same source the draft model already trains on** — keeps train↔serving consistent; (b) it carries the per-game performance fields (`kills/deaths/assists`, `golddiffat15`) needed for the relative-performance sub-signal; (c) single namespace avoids cross-source fuzzy-match drift. One source, P3-clean.

## Model design

For a player `i` on champion `c`, with `n_i` = their games on `c` in-window:

- **Experience confidence:** `expConf_i = min(1, n_i / N_FULL)`, `N_FULL = 20`. No games → 0 → mastery neutral.
- **WR sub-signal:** `wrSignal_i = shrunkWR(i,c) − WR_base(c)`, where `shrunkWR` shrinks toward the champion's base WR (prior = champ WR, not 0.5) with the model's existing `shrinkK`.
- **Performance sub-signal:** `perfSignal_i = (KDA_{i,c} − KDA_{i,*})/KDA_SCALE + (gd15_{i,c} − gd15_{i,*})/GD15_SCALE` — delta of the player's KDA and gold@15 *with this champion* vs *their own overall* baseline. `KDA_SCALE≈2`, `GD15_SCALE≈500` are fixed constants whose only job is to put the two deltas on a comparable magnitude; the logistic's learned weight absorbs the final scale, so **no normalization stats are persisted**.

Two game-level features, each modulated by experience:

```
masteryWrDiff   = avg_blue(expConf_i · wrSignal_i)   − avg_red(expConf_i · wrSignal_i)
masteryPerfDiff = avg_blue(expConf_i · perfSignal_i) − avg_red(expConf_i · perfSignal_i)
```

The logistic grows from 3→5 features `[wrDiff, lane, synergy, masteryWr, masteryPerf]` (+bias) and learns each weight. Experience is the modulator ("how much to trust"), not a loose feature; combining WR + performance with the trainer arbitrating means a noisy sub-signal collapses on its own (L2 + the forced-0 gate).

## Artifact + shared feature function

- **New `lib/lol-draft-mastery.json`:** `{ "playerNorm|champ": {wins, n, kdaSum, gd15Sum}, "playerNorm|*": {nAll, kdaAll, gd15All} }`. Filtered to `n ≥ 3` per pair and to players active in ~365d, to bound size. Sparse. Committed seed, regenerable (same pattern as the other draft artifacts).
- **Shared pure function** `computeMasteryFeatures(blueWithPlayers, redWithPlayers, masteryArt, meta) → { masteryWrDiff, masteryPerfDiff, rows[] }` lives in `lib/lol-draft-train.js` and is called by **both** the training script and the runtime engine — single source, no train↔serving divergence.

## Name resolution (hybrid) + data flow (display-only)

Player name precedence, resolved in the **endpoint** (keeps the engine pure): **live `summonerName`** (Riot) › **manual** (UI field) › **auto-inference** `getExpectedRoster(team)` › none → mastery 0.

- `server.js /api/lol-live-draft:5417` — add `player: x.summonerName` to the `pick()` map (the field is already present in `participantMetadata`).
- `server.js` draft-analyze (`:5319`), match-analyze (`:5357`), match-explain predict (`:5531`) — if a slot lacks `player` but a team name is present, infer via `getExpectedRoster`; pass `player` into the draft object.
- `public/lol-live-dashboard.html` (`/edge`) — optional player-name field per slot, auto-filled by the live-draft pull; render the mastery rows in the existing breakdown.

Flow: `/edge` (Match Lab/Draft Lab or live-draft) → endpoint resolves player names → `computeDraftWinProb({blue,red with player}, art)` → `masteryWr/Perf` modulate the prob (if weights > 0) + breakdown shows per-player mastery → UI. `getLolProbability`/EV/stake: not in this path.

## Training + walk-forward A/B

`scripts/train-lol-draft-model.js`:
1. `SELECT` now includes `playername`; build the mastery table via the shared builder.
2. Feature vector uses the real `masteryWrDiff/masteryPerfDiff` (not `0`).
3. Report walk-forward (train on patches `< cut`, test `≥ cut`) **A/B**: Brier/log-loss OOS **with mastery** vs **without** (current baseline).
4. **Forced-0 gate (user's success criterion):** if `Brier_with ≥ Brier_without`, set `w[masteryWr] = w[masteryPerf] = 0` in `lol-draft-meta.json` (prob does not move) but still write `lol-draft-mastery.json` — the breakdown remains informative ("Faker: 71% Azir, n=18, +0.4 KDA vs pool").
5. Write `lol-draft-mastery.json`; `meta.weights` now length 6.

## Error handling / fallback

Best-effort, never breaks analyze: no `player` → `mastery_i = 0`; player/pair below `n ≥ 3` → `0`; **mastery artifact absent (not yet trained) → `masteryWr/Perf = 0` and the old `meta.json` weights → today's behavior exactly**; `getExpectedRoster` null → no inference. **Testable invariant:** with no `player` on any slot, `masteryWrDiff = masteryPerfDiff = 0`, so the mastery terms drop out of `z` (the prob equals the same model evaluated without the mastery terms — verified against the post-train weights, not the pre-Phase-2 number).

## Testing / validation

- **Unit (`tests/test-lol-draft-model.js`):** (a) no players → `masteryWrDiff = masteryPerfDiff = 0` and prob equals the same engine with the mastery terms removed (mastery is inert without names); (b) `expConf`/shrink math (high-n high-WR player → positive `masteryWrDiff`; high relative KDA/gd15 → positive `masteryPerfDiff`); (c) artifact-absent fallback (mastery 0, no throw); (d) name precedence in the endpoint resolver (live > manual > inferred).
- **Walk-forward A/B** in the train script is the go/no-go: mastery weights only stay non-zero if they beat baseline OOS.
- **Live-draft:** assert `summonerName` is extracted into `player`.

## Files touched

`lib/lol-draft-train.js` (mastery builder + shared `computeMasteryFeatures`) · `lib/lol-draft-model.js` (consume player + artifact) · `scripts/train-lol-draft-model.js` (5-feature train + walk-forward A/B + forced-0 gate) · `server.js` (3–4 endpoints: name resolution) · `public/lol-live-dashboard.html` (optional name field + breakdown rows) · `tests/test-lol-draft-model.js`. New artifact `lib/lol-draft-mastery.json`. **No migration.**

## Risks

- The train comment already flags the draft edge as tiny (~0.0024 Brier OOS) and champion WR as carrying ~no OOS signal. Mastery may also fail to beat baseline — in which case the deliverable is "weights 0 + informative breakdown" (approved). Downside is the feature being decorative, **not** the number getting worse; walk-forward A/B decides before shipping.
- Player×champion samples are small; mitigated by shrinkage + experience gating + `n ≥ 3` filter.
- `getExpectedRoster` returns the *expected* starter, which can miss a substitution; live `summonerName` (when present) overrides, and it is display-only regardless.
- Oracle's Elixir player coverage breadth — the train script reports N; verify it is sufficient before relying on the A/B verdict.

## Rollout

1. Shared mastery builder + artifact + train-script A/B → review walk-forward numbers.
2. `lib/lol-draft-model` consume + unit tests.
3. `server.js` name resolution (live-draft `summonerName`, `getExpectedRoster` inference).
4. UI field + breakdown rows.
Each step independently shippable; ends display-only.
