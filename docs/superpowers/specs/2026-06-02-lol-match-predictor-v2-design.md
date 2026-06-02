# Design — LoL Match Predictor v2: hybrid Elo source + Bo3/Bo5 series

**Date:** 2026-06-02
**Status:** approved (user). Display-only; money-path byte-unchanged. Extends the Match Lab predictor.

## Problem / Context

The Match Lab predictor (`lib/lol-match-predict.js`) blends `logit(Elo) + logit(draft)` → isotonic calibration → `P(team1 wins a GAME)`. Two limits surfaced from read-only experiments this session (game-level walk-forward, n=2944–4104):

1. **Elo source.** A clean same-set test showed an Elo **fed by games** (Oracle's Elixir) beats the current Elo **fed by series** (`match_results`): Brier **0.2144 vs 0.2199** on the intersection (n=933), **plus +22% coverage** (1151 vs 940 of 1232 test games — game-feeding knows tier2/3 teams that `match_results` misses). Series history (2022+) did not help; recency dominates.
2. **Granularity vs bet unit.** The predictor is game-level (`level:"game"`), but matches are **Bo3/Bo5 series**. There is no `P(series)` — so the number predicted isn't the number usually bet/analyzed.

Everything else was tested and rejected OOS (draft, form, mastery, MOV, config tuning, player-Elo) — see `project_draft_mastery_2026_06_02`. So the two improvements above are the only non-refuted leads.

**What exists (P3 — reuse):** `createEloSystem` (`lib/elo-rating.js`, side-agnostic `getP`); `predictMatch`; `scripts/backtest-lol-match.js` (walk-forward Brier/logloss/ECE + isotonic PAV); `lib/lol-match-metrics.js`; artifacts `lib/lol-match-{meta,calib}.json`. `oracleselixir_players` (2026, 4104 games) has per-game `side/teamname/result/date/league`.

## Goals

1. **Hybrid Elo source**, validated by backtest (the data picks the winner).
2. **Series probability** layer (Bo3/Bo5) on top of the game predictor, side-neutralized.
3. A **single shared Elo-build function** used by BOTH the backtest and runtime (no train↔serving drift — same discipline as `computeMasteryFeatures`).
4. No new npm deps. No new DB schema (artifacts as JSON, as today).

## Non-goals (YAGNI)

- Does **not** touch `getLolProbability`, EV, Kelly, stake, or tip emission. The predictor is display-only and feeds none of them — money path is byte-unchanged by construction.
- No exact side-selection rules (loser-picks-side varies by league) — series uses neutralized side (decided).
- No draft in the series number (drafts of games 2–5 are unknown — series is team-skill only).
- No live/auto-retraining — the train script runs manually, as today.

## Part (a) — Hybrid temporal Elo

**New `lib/lol-match-elo.js`** → `buildMatchElo(db, { config, source })`, `source ∈ {'hybrid','games','series'}`, returns a bootstrapped Elo system. Shared by the backtest and `predictMatch`.

- **`series`:** `elo.bootstrap(db,'lol',contextFn)` — current behavior; the baseline.
- **`games`:** rate `oracleselixir_players` games only — aggregate the 10 player-rows per gameid → `{blueTeam,redTeam,blueWon,date,league}`, then one `rate(blueTeam, redTeam, margin=1, date, tier)` per game in date order. A small `_rateOeGames(db, elo, { minDate })` helper does this.
- **`hybrid`:** `elo.bootstrap(db,'lol',contextFn,{maxDate:cutoff})` (seed: series strictly before the OE window) + `_rateOeGames(db, elo)` (granular). `cutoff = MIN(date)` of `oracleselixir_players` (computed, not hardcoded). Series ≥ cutoff are **excluded by `maxDate`** → no temporal overlap → **no double-counting** (a series and its games never both count).

To keep it DRY, `elo.bootstrap` gains one optional, backward-compatible param `maxDate` (default null = no upper bound; adds `AND resolved_at < ?` when set) — so `buildMatchElo` reuses the existing `match_results` parse/margin logic for the seed instead of duplicating it, and only the OE-games path (`_rateOeGames`) is new.

**The backtest decides the source.** `scripts/backtest-lol-match.js` re-runs walk-forward with all three sources, prints elo-only OOS Brier for each, and **fits the ship model on the lowest-Brier source**. User chose `hybrid` as the direction; if `hybrid` does not beat `games`-pure OOS, the ship uses `games` (simpler) — evidence wins. The chosen source is recorded in `meta.eloSource`.

**Production:** `_matchLabElo` (in `lol-match-predict.js`) calls `buildMatchElo(db, { source: META.eloSource, config: META.eloConfig })` instead of the inline `match_results` bootstrap.

**Leakage note:** in the backtest, predict-before-rate ordering is preserved; OE games update the Elo only after they are predicted. Same as today.

## Part (b) — Bo3/Bo5 series (side-neutralized)

**Key simplification:** `elo.getP(team1, team2)` is already **side-agnostic** (the blue-side edge lives in the blend *bias*, not the Elo). So `pNeutral = elo.getP(team1, team2, tier).pA` is exactly "P(team1 wins one game, side neutralized)" — no double evaluation needed.

**New `lib/lol-match-series.js`** → `seriesProb(p, bestOf)` pure:
- Bo1 → `p`
- Bo3 → `p²(3 − 2p)`
- Bo5 → `p³(6p² − 15p + 10)`
- (general: P(first to ⌈bestOf/2⌉ wins), `p` constant per game since side is neutralized).

**The series uses only the neutralized Elo — not the draft.** Drafts of games 2–5 are unknown; the draft stays in the *game* number (current game, known draft). The series is pure team skill.

**Wiring:** `predictMatch` adds `seriesNeutralP = elo.getP(team1,team2,tier).pA` (or null when Elo absent) to its return. The endpoint computes `series = { bo1, bo3, bo5 }` via `seriesProb` (all three — cheap, avoids a re-request when the selector changes). When `seriesNeutralP` is null (Elo missing), `series` is null and the UI shows only the game number.

**Series calibration:** `pNeutral` is raw Elo (not the blend's isotonic). The backtest measures series-level ECE; **if** miscalibrated, add a small isotonic block for the series (kept only if it improves OOS, same gate as the game calib). Otherwise ship raw.

## Data flow (display-only)

`/edge` Match Lab → `POST /api/lol-match-analyze` (now with optional `bestOf`, default returns all three) → `predictMatch` (game blend + `seriesNeutralP`) → endpoint computes `series{bo1,bo3,bo5}` → UI shows P(game) and P(series) side by side with a Bo1/Bo3/Bo5 selector. `getLolProbability`/EV/stake: not in this path.

## Components / files

- **Modify** `lib/elo-rating.js` — `bootstrap` gains optional `maxDate` (backward-compatible; adds `resolved_at < ?` when set).
- **Create** `lib/lol-match-elo.js` — `buildMatchElo(db,{config,source})` + `_rateOeGames` (shared Elo build).
- **Create** `lib/lol-match-series.js` — `seriesProb(p, bestOf)` (pure binomial).
- **Modify** `lib/lol-match-predict.js` — `_matchLabElo` uses `buildMatchElo`; `predictMatch` returns `seriesNeutralP`.
- **Modify** `scripts/backtest-lol-match.js` — use `buildMatchElo`; A/B the three sources; fit ship on the winner; series-level validation via `seriesProb`; write `meta.eloSource`.
- **Regenerate** `lib/lol-match-{meta,calib}.json`.
- **Modify** `server.js` `/api/lol-match-analyze` — accept `bestOf`, return `series`.
- **Modify** `public/lol-live-dashboard.html` — Bo1/Bo3/Bo5 selector + game/series side-by-side render.
- **Tests:** `tests/test-lol-match-series.js` (binomial: Bo1=p, Bo3/Bo5 known values, monotonic in p, p=0.5→0.5 for all); extend `tests/test-lol-match-predict.js` (predictMatch returns `seriesNeutralP`; null when Elo absent). `buildMatchElo` exercised by the backtest run.

No migration. No new deps.

## Testing / validation

- **(a)** Backtest prints elo-only OOS Brier for `series`/`games`/`hybrid`; ship fits on the winner. Sanity: `series` reproduces ~0.2200. Expected `games`/`hybrid` ≈ 0.214 + higher coverage.
- **(b)** Series-level backtest: for each `match_results` series in the test window, `pNeutral` as-of (strictly prior), `seriesProb(pNeutral, bestOf from final_score)`, Brier vs the real series winner. Report Brier/ECE; gate any series calibration on OOS gain.
- **Unit:** `seriesProb` exact values (`seriesProb(0.6,3)=0.648`, `seriesProb(0.5,N)=0.5`, monotonic); predictMatch series field.
- **Money-path:** final review greps that no pricing file imports the new libs and `getLolProbability` is byte-unchanged.

## Rollout (sequence a → b)

1. `lib/lol-match-elo.js` + backtest A/B of sources → review Brier/coverage; ship fits on winner; `_matchLabElo` switches. **(a) shippable alone.**
2. `lib/lol-match-series.js` + predictMatch `seriesNeutralP` + endpoint `series` + series-level validation. **(b) on top of (a).**
3. UI selector + side-by-side render.

## Risks

- **(a)** `games`-pure may match or beat `hybrid` → then ship `games` (simpler); the seed adds nothing. Acceptable (user OK'd "evidence wins"). Hybrid's history mainly de-risks cold-start for teams idle in 2026.
- **(a)** OE coverage is 2026-only; `buildMatchElo` hybrid seeds pre-2026 from series so established teams aren't cold-started.
- **(b)** Series number won't beat the closing line (markets re-price series) — display-only, no betting use. The neutralized-side assumption is an approximation but robust (true side-selection varies by league).
- Re-fitting the blend changes the displayed game prob slightly (new Elo) — expected, display-only; money path untouched.
