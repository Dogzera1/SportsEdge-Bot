# Design — Leak fix: edge-shrink + Shin devig + soft-vs-sharp +EV

**Date:** 2026-05-29
**Status:** approved direction (user: Both-sequenced; revive BR scraper). Build Path 1 + Path 2 engine this session; data-fit + show numbers before any prod stake knob.

## Problem

The bot is **flat/dormant**, not hemorrhaging: real book (is_shadow=0) 30d = R$177 staked, −0.35% ROI. Months of defensive shadowing throttled real betting to ~R$6/day. The strategy is **model-vs-sharp** (`EV = pModel × Pinnacle_odd − 1`) — trying to beat a near-efficient book.

**Root cause (exact):** in `lib/tennis-market-scanner.js`, EV uses `pModel × RAW odd` (scanner.js:31-34, applied 253/265). The devigged **fair** probability (`dj.pA/pB`) is computed but only stored for display — **it never anchors the edge**. So model overconfidence inflates EV unchecked, and the `minEv≥8` gate selects the model's worst calls. Confirmed: corr(model-EV, realized-ROI) tennis −0.48, totalGames −0.82; lol 30+ EV bucket −49%.

Only CLV-confirmed (directional) edge is tennis HANDICAP_GAMES (NEG_away/away); its CLV *magnitude* (+20-33%) is a capture artifact (thin handicap line-matching), so treat the edge as modest/uncertain.

## Goals
1. Stop the EV gate from selecting model errors (adverse selection) — at its source, P2-compliant (cause fix).
2. Improve the fair-prob estimate feeding every edge calc (devig method).
3. Make per-segment Kelly actually apply (cut no-edge POS_home; stop boosting the adverse-selected high-EV tail).
4. Stand up the research-backed profit engine (+EV vs soft books) — reusing existing detectors — ready to go live when the soft-book feed returns.

## Non-goals
- No change to sacred caps (MAX_KELLY_FRAC=0.10, KELLY_PRODUCT_CAP=0.15, MT_MIN_ODD, etc.).
- No new cron, no parallel detector (P3). Extend existing code.
- No reliance on the inflated tennis CLV magnitude for sizing.

## Path 1 — make model-vs-sharp honest (all default no-op via env)

**Fix A — Edge-shrink (anchor EV to the fair line).** New helper `_applyEdgeShrink(pModel, pFair, market)`: `p_used = pFair + shrink·(pModel − pFair)`, guard `pFair` null → return `pModel`. Insert at every tennis-scanner EV site where both `pModel` and the devigged fair prob are in scope (HG: scanner.js:249-253 + 265 away; totalGames + aces similarly). Store `p_used` as `pModel`. Env hierarchy `TENNIS_<MARKET>_EDGE_SHRINK` > `TENNIS_MT_EDGE_SHRINK` > **default 1.0 (no-op = current behavior)**. shrink=0 ⇒ pure market follower (no bets); shrink∈(0,1) ⇒ overconfident high-EV picks shrink most.

**Fix B — devig method configurable, can force Shin.** `_dej` (scanner.js:36-39) currently `devigEnsemble(a,b)` (auto: Shin when |o1−o2|≥1.5 else power). Make method env-driven `TENNIS_MT_DEVIG_METHOD` (default `'auto'` = no-op); allow `'shin'`. lib/devig.js already implements Shin/power/multiplicative.

**Fix C — fix the gold-override Kelly bypass.** bot.js:19996-20012: the `EV≥15` "gold" path overrides `_kellyBaseFrac` with a flat 0.15, **discarding the dir/side mult** → `KELLY_TENNIS_HG_POS_HOME` cut is ignored on EV≥15 picks. Apply `hgDirSideMult` on top of the gold frac (or exclude POS_home from `_isHgGoldSegment`). Also reconsider boosting by EV≥15 at all (high-EV = adverse-selected). Env-guarded; default preserves current unless cut env set.

### Validation of Fix A (the stake-affecting one)
Data-fit `shrink` per segment (sport × market × tier × side) from the **shadow research universe** (P2: shadow→cause/calibration) maximizing realized ROI/CLV, with a **frozen holdout** (FROZEN_HOLDOUT_DAYS). Default conservative (e.g. 0.5) where n<min. Produce a script `scripts/fit-edge-shrink.js` (OLAP/admin, read-only) that outputs per-segment optimal shrink + backtested PRE/POST ROI/CLV/Brier. **Show the user these numbers before any prod env is set.**

## Path 2 — soft-vs-sharp +EV (build now, dark until feed live)

Extend `detectSuperOdd` (super-odd-detector.js:57 — already devigs sharp + computes `EV=soft×fair−1`) with: (1) a static EV-threshold return, (2) a **freshness re-check** on the soft entry's `_capturedAt` (the staleness gap — nothing re-checks it at emit time today). Route qualifying signals through the existing emit path (`_tryEmitPinnacleFollowTip`-style → `serverPost('/record-tip')`, which applies MAX_STAKE_UNITS + portfolio Kelly + shadow gating server-side). Invoke inside the existing `runStaleLineCron` per-side blocks (bot.js:30036/30200/30263) where `pin`/`others` are already split. Env opt-in `SOFT_VS_SHARP_ENABLED` (default off). Unit-tested with mock odds; emits real only when feed fresh + EV≥threshold + not shadowed.

## Testing
- TDD per fix: `_applyEdgeShrink` math (shrink 0/0.5/1, null fair), devig method routing, gold-override mult application, soft-vs-sharp EV + freshness gate, emit-path reuse (mock serverPost).
- `node -c bot.js && node -c server.js`; full existing suite (844 tests) green.
- Devil's-advocate review before claiming any fix works.

## Rollout
1. Ship code (all no-op by default) — zero behavior change on deploy.
2. Run fit script → review per-segment shrink numbers with user.
3. Enable shrink per-segment via env (most-leaky segments first), monitor real ROI/CLV.
4. Path 2 stays `SOFT_VS_SHARP_ENABLED=off` until user's BR scraper is back + freshness validated on real soft data.

## Risks
- Tennis edge may be ~0 after artifact correction → Path 1 ceiling is "stop losing," real upside is Path 2.
- Soft books limit winners (Path 2 binding constraint) — accept as modeled, diversify.
- Fit on shadow could overfit → frozen holdout + conservative default mitigate.
