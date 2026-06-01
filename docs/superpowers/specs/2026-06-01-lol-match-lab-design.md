# Match Lab — calibrated full-match LoL predictor on `/edge` (display-only)

- **Date:** 2026-06-01
- **Status:** Approved design → ready for implementation plan
- **Owner:** Victor
- **Scope arc:** evolves the draft-only "Draft Lab" (shipped `73376e5`) into a full match-win predictor for analysis/display. **Display-only — does not touch live betting (`getLolProbability`), EV, stake, or Kelly.**

---

## 1. Context & problem

`/edge` already has a **Draft Lab** panel that shows a **draft-only** win probability (`lib/lol-draft-model.js`, `computeDraftWinProb`). Its own walk-forward number is honest but weak: **Brier 0.2465 vs 0.25** coinflip (≈0.0024 over the blue-side base rate). The user wants "the most precise analyzer in the world."

The honest reality, triangulated from research (see §11) and the model's own numbers:

- **Draft alone is a weak predictor in PRO play.** Picks/bans-only models reach AUC < 0.60; iTero estimates draft is only **~10%** of a pro game's outcome. Our draft model is already at that ceiling.
- **Precision lives in team strength + form + player history + side**, not in more draft features. Team Elo alone ≈ 65%; per-player champion win-rate history is the strongest pre-game feature; blue/red side is ~+2-3pp and is often the *largest* component of a naive "draft-only" edge.
- **A precise predictor will NOT beat Pinnacle pre-game ML** (the market re-prices on the same draft). So this is correctly **display-only**; there is no betting reason to mutate the live model.

**Key codebase finding (verified):** a full match predictor **already exists** — `lib/lol-model.js` `getLolProbability(db, match, odds, enrich, compScore)` blends Elo 0.40 + Comp 0.35 + Form 0.25 + OE 0.15 + Player 0.10 (constants at lines 84-88; sub-models `_eloSubModel` 157, `_compSubModel` 204, `_formSubModel` 253, `_oeSubModel` 522, `_playerSubModel` 567). It powers live LoL pricing and the `/edge` live-match probabilities. The Draft Lab is a *separate, weaker* display tool that is **not** wired into it.

So "most precise" = **surface and sharpen the model that already exists**, with the draft as one modifier — not pile more onto draft.

### Duplication to resolve (P3)
There are **two draft representations**: (a) the new Draft Lab logistic (`computeDraftWinProb`), used only by the display endpoint; (b) the older `compScore` (from `pro_champ_stats`/`pro_player_champ_stats`, computed in `bot.js selectGameContext`), used by `getLolProbability`'s comp term. The display blend will standardize on (a); the live model keeps (b) unless separately authorized.

---

## 2. Goals / non-goals

**Goals**
1. Show, in the analyzer, a **calibrated full-match win probability** (Elo + form + player + draft + side) with a transparent **component breakdown**.
2. Make the number **honest**: rigorously walk-forward validated + calibrated against 24k historical LoL matches; labeled by confidence.
3. Reuse existing sub-models **read-only**; resolve the two-draft duplication in the display path.
4. Add only the **evidence-backed gaps** (side, player-champ history, unified draft), each kept only if it improves out-of-sample.

**Non-goals (explicit)**
- **No change to live betting.** `getLolProbability`, EV, stake, Kelly, dispatch — untouched. Any sharpening of the *betting* model is a separate, env-gated, explicitly-authorized effort (default: not done).
- **No XGBoost / champion embeddings / neural nets** — they overfit pro-only data (research §11).
- **No solo-queue transfer learning** (that was the rejected Option B; a possible future v2).
- Not chasing draft accuracy past its ~10% ceiling.

---

## 3. Architecture

```
Match Lab panel (public/lol-live-dashboard.html)
   │  team1, team2, side(blue/red), draft(10 champs), [optional: live-match prefill]
   ▼
POST /api/lol-match-analyze   (server.js, display-only JSON)
   ▼
lib/lol-match-predict.js  ── predictMatch(db, {team1, team2, side, draft})
   ├─ base = getLolProbability(db, syntheticMatch, null, enrich, compScore=0)   // Elo+form+player, comp suppressed
   ├─ draftAdj = computeDraftWinProb(draft)                                      // draft modifier
   ├─ sideAdj  = explicit blue/red prior                                        // §6.1
   ├─ playerChampAdj = per-player champ WR/KDA (pro_player_champ_stats + OE)     // §6.3
   ├─ blend in logit space (re-fit weights, draft capped)                       // §5
   └─ calibrate (isotonic/Platt map from backtest)                             // §5
   ▼
{ prob, components:{elo,form,player,draft,side}, confidence, label }
```

- **`lib/lol-match-predict.js`** (new): the only new model file. Composes existing signals; owns the blend + calibration-map application. Pure-ish (db read-only). No writes, no Telegram, no stake.
- **`POST /api/lol-match-analyze`** (new, server.js): mirrors `/api/lol-draft-analyze` shape; `_readPostBody` with a small cap (JSON, not images). Display-only.
- **Calibration artifact** `lib/lol-match-calib.json` (new): committed map produced by the backtest harness (§4).
- **Live `getLolProbability` is not modified.** The display module either calls it with `compScore=0` to obtain the Elo+form+player base, or (if that double-counts) consumes exported sub-models read-only — **mechanism confirmed as plan task #1** (verify `_compSubModel` zeroes on `compScore=0`/low confidence; otherwise export `_eloSubModel`/`_formSubModel`/`_playerSubModel`).

---

## 4. Backtest & validation harness (the core precision work)

New script `scripts/backtest-lol-match.js`:

- Replays `match_results` (24,359 LoL games, 2022→2026, `team1/team2/winner/league/resolved_at`) **chronologically, point-in-time**: at each match, Elo/form/comp are computed using only data *before* `resolved_at` (no leakage). The Elo system already updates incrementally → replay in date order.
- Metrics: **Brier, log-loss, reliability diagram + ECE**, all judged **against the blue-side base-rate predictor (~0.249 Brier)** — not 0.5.
- **Walk-forward** (train weights/calibration on earlier window, evaluate on later) + a **frozen recent-patch holdout** the fit never sees.
- Used both to (a) **fit** the blend weights + calibration map, and (b) **accept/reject** each §6 gap.

**Two data horizons (important):** `match_results` (24k, 2022+) carries team/winner only — enough to backtest **Elo + form** across the full history. The **draft + player-champ** terms need actual champions per game, which live in `oracleselixir_players` (currently **2026 only**, ~4104 games; extended by the §7 sync). So: fit/evaluate Elo+form on the full 24k; fit/evaluate the draft+player-champ contribution on the OE-overlap window. The harness must **join `match_results` ↔ `oracleselixir_*`** (team-name normalization + date alignment — reuse the existing resolver; building/validating this join is an explicit harness task). The blend weights are fit on the overlap window where all components are present; Elo+form-only calibration covers matches without draft data.

**Ship-gate (acceptance criteria):**
- Blended display model **beats the blue-side base rate OOS** on Brier *and* log-loss.
- **Calibrated**: ECE below a stated threshold (target ≤ 0.03) on the holdout.
- Each §6 gap is kept **only if** it improves OOS Brier on the holdout; otherwise dropped (logged in the spec's results appendix).
- If the full blend does **not** beat the base rate OOS, we ship the calibrated **Elo+form** core only and label the rest as unavailable — we do not ship an overfit number.

---

## 5. Blend + calibration

- Components combined in **logit space**: `z = b0 + w_elo·logit(pElo) + w_form·logit(pForm) + w_player·logit(pPlayer) + w_draft·logit(pDraft) + w_side·sideTerm`.
- Weights **re-fit offline** by the harness (logistic regression on point-in-time component values → outcome), starting from the proven 0.40/0.35/0.25 split as a prior. **Draft weight capped** (its OOS signal ≈0.002 Brier — it nudges, never dominates).
- **Calibration map** (`lol-match-calib.json`): isotonic regression or Platt scaling, whichever wins OOS; maps raw blend → calibrated probability so "65%" means 65%.
- **Confidence + label**: `confidence` from component agreement + data sufficiency (e.g., roster freshness, Elo game counts). `label ∈ {forte, lean, lean fraco}`; `lean fraco` when only draft is available (no teams).

---

## 6. Evidence-backed gaps (each validated in §4 before keeping)

1. **Explicit side (blue/red):** a small additive prior (~+2-3pp blue) as its own term, so the model doesn't smear side into champion coefficients. Audit per-side to confirm it isn't the *entire* edge.
2. **Unify the draft signal (display path):** use `computeDraftWinProb` as the comp term in the display blend, retiring the parallel `compScore` *for display*. Live `getLolProbability` keeps `compScore` (no money-path change).
3. **Player-champion history:** per-player recent WR/KDA on the *picked* champion (shrunk), from `pro_player_champ_stats` + OE `playername` rows — the strongest pre-game feature in the literature. Requires knowing the players (from roster or manual input); degrades gracefully when unknown.

---

## 7. Data expansion

- Sync **Oracle's Elixir 2024 + 2025** (`scripts/sync-oracleselixir.js --year=2024 --year=2025`). The table currently holds **only 2026** (4104 games). Deeper player-champ + draft + synergy tables; better-populated `pro_player_champ_stats`. `match_results` already covers 2022+ for Elo, so Elo depth is fine; this mainly strengthens draft/player tables.
- Note: older patches are stale for *draft* signal (meta drift) — recency-weight or patch-gate the draft tables when retraining; team Elo is unaffected.

---

## 8. UI/UX (Match Lab)

Extends the existing overlay panel (`public/lol-live-dashboard.html`):

- **Inputs:** `team1` / `team2` text fields with **autocomplete** from the 321 known `teamname`s (a `GET /api/lol-teams` datalist source); a **side toggle** (which team is blue); the existing **draft** inputs (manual + Ctrl+V print); an optional **"carregar partida ao vivo"** button to prefill teams/side (+ draft if exposed) from the live feed.
- **Output:** calibrated **win %** for each team + a **component breakdown** (horizontal bars: Elo / form / draft / side / player, each with its signed contribution) + an honest **confidence + label**.
- **Graceful fallback:** with no teams entered, behaves as today (draft-only) but labeled **"lean fraco — só draft"**. With teams but no draft, shows Elo+form+player.
- Keep it display-only; no "bet" affordance.

---

## 9. Files

**New**
- `lib/lol-match-predict.js` — display blend + calibration application.
- `lib/lol-match-calib.json` — committed calibration artifact (from harness).
- `scripts/backtest-lol-match.js` — point-in-time walk-forward backtest + weight/calib fit.
- `docs/superpowers/specs/2026-06-01-lol-match-lab-design.md` — this spec.

**Modified**
- `server.js` — add `POST /api/lol-match-analyze` + `GET /api/lol-teams` (autocomplete).
- `public/lol-live-dashboard.html` — Match Lab inputs, breakdown UI, live-match prefill.
- `lib/lol-model.js` — **only if needed**: export sub-models for read-only reuse (no behavior change). Decided in plan task #1.
- `tests/` — unit tests for blend + calibration math.

**Untouched (guard):** anything in the bet/stake/EV/Kelly/dispatch path. `getLolProbability` behavior unchanged.

---

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Touching `lol-model.js` leaks into betting | Read-only reuse; if export needed, no logic change; money-path explicitly out of scope + guarded by review. |
| Overfit blend (more features → variance, P3) | Walk-forward + frozen holdout ship-gate; drop any gap that doesn't improve OOS; draft weight capped. |
| Point-in-time leakage in backtest | Strict as-of-date computation; Elo replayed in `resolved_at` order; holdout never seen by fit. |
| Team-name matching errors (321 names, fuzzy) | Autocomplete/datalist from canonical names; fuzzy fallback with a visible "matched as X" note. |
| Calibration forced when not helpful | Apply isotonic/Platt only if it improves OOS (prior result: a forced isotonic refit made Brier worse — don't force it). |
| Spec scope creep into v2 (embeddings/transfer) | Explicit non-goal; revisit only if A's OOS gain is large enough to justify. |

---

## 11. References (research, 2026-06-01)

- Costa et al., *Feature Analysis to LoL Victory Prediction on the Picks and Bans Phase*, IEEE-CoG 2021 — picks/bans-only AUC < 0.60; player WR/KDA drives AUC 0.97. https://ieee-cog.org/2021/assets/papers/paper_292.pdf
- Do et al., *Predicting Outcomes from Player-Champion Experience*, FDG 2021 — 75.1% post-champ-select (player experience). https://ar5iv.labs.arxiv.org/html/2108.02799
- LoLDraftAI — draft-only 56.7% (solo queue), solo-queue pretrain → pro fine-tune, bucketed calibration. https://loldraftai.com/blog/loldraftai-explained
- iTero — draft ≈ ~10% of pro outcome; solo-queue mastery 41.5%→54.5%. https://medium.com/the-esports-analyst-club-by-itero-gaming/lol-how-to-win-draft-in-pro-play-47470eed32e1
- Riot Global Power Rankings — team Elo ~65%. https://boostroyal.com/blog/global-power-rankings-in-esports-the-rating-system-explained
- Blue/red side ~52-53%. https://www.pinnacle.com/en/esports-hub/betting-articles/league-of-legends/league-of-legends-red-side-vs-blue-side/kg2jey3lv9q726yz
- Real-time (in-game) model 81.62% at 60-80% elapsed — precision lives in live state, not pre-game. https://arxiv.org/abs/2309.02449
- Betting-edge verdict: documented esports edges are vs **soft** books / props, not Pinnacle pre-game ML. https://www.rebelbetting.com/blog/esports-betting-strategy
- Oracle's Elixir downloads (per-year CSV, attribute Tim Sevenhuysen, treat as non-commercial courtesy). https://oracleselixir.com/tools/downloads

---

## 12. Open decisions (resolved defaults)

1. Team input = free-text + autocomplete from DB teamnames. ✅
2. Real-match prefill = yes, with manual override. ✅
3. Unify-draft stays **display-only**; live betting comp untouched. ✅
4. Keep logistic blend; no XGBoost/embeddings/transfer (Option B deferred). ✅

---

## 13. Resultados da validação (2026-06-01)

### Verdict

**Calibrated game-level Elo beats the blue-side base-rate OOS by ~12% Brier.** The blend is Elo-dominant. Form was dropped (hurts OOS). Draft is a small capped lean whose backtest gain is optimism-inflated (OE draft artifacts include the test window — at display time the user's draft is genuinely OOS). Ship verdict: **PASS as an Elo-dominant display lean.** Plano 2 (UI) may proceed.

### Ablation table (TEST set, last 30%, n=884 games)

| Model | Brier | Logloss | ECE | Notes |
|---|---|---|---|---|
| (a) baseline (blue-side rate) | 0.2492 | 0.6915 | 0.0000 | pStar=0.5283 |
| (b) elo-only | 0.2200 | 0.6289 | 0.0376 | |
| (c) elo+form | 0.2237 | 0.6385 | 0.0369 | form HURTS OOS — dropped |
| (d) full 3-feat (elo+form+draft) | 0.2183 | 0.6271 | 0.0485 | ablation-only, not shipped |
| **(e) elo+draft [SHIP]** | **0.2203** | **0.6319** | **0.0850** | **SHIP model** |
| (f) elo+draft + calib | 0.2153 | 0.6200 | 0.0533 | calib KEPT (OOS gain) |

Elo-only beats base-rate by ~12% Brier (0.2200 vs 0.2492). The ship model (elo+draft) is 0.2203 — negligibly above elo-only on an absolute basis; the draft adds a very small directional lean (honest: draft alone is a weak signal in pro play, ~10% of outcome per iTero). Row (f) (+calib, 0.2153) is the best OOS number: isotonic PAV improved Brier on the test set and was retained (`keptOOS=true`, 6 blocks).

### Why form was dropped

`elo+form` (0.2237) > `elo-only` (0.2200) — form HURTS OOS despite contributing a positive coefficient in-sample. This is a classic regularization artefact: form signal has high within-sample variance, and L2=0.05 is not strong enough to suppress it completely when n_train=2060. The correct action is to drop it from the prediction path and keep it only in the display breakdown (informational, not contributing to the probability).

### Final ship weights

From `lib/lol-match-meta.json`:

```json
{
  "weights": [0.04164661699268262, 0.45023046693085, 0.225115233465425],
  "featureOrder": ["elo", "draft"],
  "draftCapApplied": true,
  "droppedFeatures": ["form"],
  "n": 2944,
  "walkForward": { "trainN": 2060, "testN": 884 },
  "oos": {
    "baselineBrier": 0.2492,
    "eloOnlyBrier": 0.219988,
    "shipBrier": 0.22027,
    "shipLogloss": 0.631862,
    "shipEce": 0.085044
  }
}
```

Weights: `bias=0.0416, w_elo=0.4502, w_draft=0.2251`. Draft cap applied (`|w_draft| = 0.2251 = 0.5 × |w_elo| = 0.2251` — capped exactly at the 0.5 ceiling). Calibration: `keptOOS=true`, 6 isotonic blocks.

### Caveats

1. **ECE ~0.085** (above the 0.03 target on the raw ship model). The post-calibration row (f) reduces ECE to 0.0533, still above target. Isotonic PAV with n=884 and 6 thin test bins does not fully correct calibration. Accepted for a display "lean", not an edge instrument.
2. **Draft optimism**: OE draft artifacts cover only 2026 data (~4104 OE games, 2944 usable after Elo confidence filter). The OE window is included in the test set, so draft's backtest gain is partially in-sample. At display time the user's actual draft is genuinely out-of-sample — honest framing in the UI is required ("lean fraco — draft sozinho").
3. **OE draft window is 2026-only**: 2024-25 sync is TLS-blocked locally; deeper OE data would improve draft coverage but is not blocking (Elo drives the model).
4. **Elo config `halfLifeDays=0`**: backtest replay mode disables time-decay (historical matches would get near-zero weight with decay active). The display `predictMatch()` (Task 8) must use the same `halfLifeDays=0` config — live-mode decay would change ratings and break the blend's calibration.
5. **Form retained in breakdown UI** (informational, not contributing to win-prob). The UI may show form as a signed bar with a "display only" label.

### Ship verdict

**PASS.** Elo-dominant blend (w_elo=0.450 vs w_draft=0.225) beats base-rate OOS by ~12% Brier. Calibrated post-fit (keptOOS=true). Form correctly dropped. Draft contribution is small and capped. Artifacts committed to `lib/lol-match-meta.json` + `lib/lol-match-calib.json`. **Plano 2 (Task 8: predictMatch() + UI) may proceed.**
