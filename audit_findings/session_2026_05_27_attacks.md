# Session 2026-05-27 — Root-cause attacks (5 commits + 1 reverted)

## Goal
"tornar o bot com tips edge" — sustained +5% real ROI 14d. Data-bound, not achievable in single session. Path established.

## Commits shipped (chronological)

| Hash | Type | Target | Status |
|---|---|---|---|
| `bedc226` | revert | Tennis calib v3 (atp_main.formats.bo5) | Restored from ATTACK 1 catastrophe |
| `d7a9b8f` | calib | LoL TOTAL UNDER bin[0] split (identity 0.30-0.55) | Deployed |
| `c4e590c` | calib | Tennis tier_quali_or_early HG flat-cap pCalib=0.369 | Deployed — addresses biggest documented leak (-59.87u/28d) |
| `90c4b99` | calib | LoL TOTAL UNDER bin[3] unmerge pCalib 0.6202→0.527 | Deployed |
| `7cdd23f` | feat | Val tier classifier + validation script | Deployed — enables val per-tier diagnose |

Reverted: ATTACK 1 (`mt-refit-calib` live with stratify=tier_side) — POST ROI -16.8% vs PRE -6.4%, nuked atp_main.formats.bo5. Lesson: endpoint OVERWRITES, never run live refit without snapshot.

## State per sport

### Tennis (only sport in REAL)
- **Real 7d ROI baseline 2026-05-27**: -22.3% (n=78)
- Fixes active: calib v3 atp_main.formats.bo5 (commit 0bf85f) + tier_quali_or_early HG flat-cap (c4e590c)
- Expected trajectory: rolling 7d window dilutes pre-fix tips over 5-7 days
- Earliest edge confirmation: +7d (03/06)
- mt-disabled (defensive): tennis|handicapGames|home, tennis|totalDoubleFaults, tennis|totalGames|under

### LoL (SHADOW=true)
- Real 7d: n=9 ROI -52.6% (pre-flip residual)
- Shadow 28d: n=109 ROI +6.5% verdict PROMOTE (but calib bin defects taint)
- Fixes active: bin[0] identity split + bin[3] unmerge
- Edge candidate: LCK n=36 ROI +36% IC95 lo 44.9%
- Path to edge: validate shadow ROI 7d post fixes → re-enable LCK via env hierarchy
- Blocker: LoL TOTAL flat OVER side bins still have calib_gap +67pp (mt-shadow-by-ev) — needs sides.over.bins addition (future attack)

### Valorant (SHADOW=true)
- Real 7d: minimal (n=0 post-flip)
- Shadow 28d: n=71 ML side ROI -17.3% gap -20.9pp **LEAK CONFIRMED** (INVESTIGATE_LEAK verdict)
- Val MT shadow d90: only n=3 — leak is ML side, not MT
- Classifier added (`tier2_franchised`/`tier3_challengers`/etc) — per-tier diagnose unlocked
- Path to edge: ATTACK 4 — `lib/valorant-ml.js` region/tier-aware (currently flat Elo)
- Memory confirms: Challengers Spain -100%, EMEA -34%, Pacific -38% in earlier audit

### CS, Dota2, Football, Basket, Darts, MMA
- All in SHADOW=true since 26/05
- Volume building gradually
- Re-enable criteria (per shadow-readiness PROMOTE verdict): N≥30 per cell + IC95 inf > 0 + calib_gap ≤ 5pp + CLV samples ≥ 10
- Football d28 verdict PROMOTE but P1 granular reveals la_liga sub-leak (-73%) — don't re-enable overall

## User actions pending (out of scope for me)

1. **`KELLY_LOL_ALTA=0.5`** (Railway env) — fix inversion ALTA(0.2) < MEDIA(0.5). env-audit flags this. Without fix, future LoL re-enable replicates leak.
2. **DELETE `TENNIS_CALIB_FORMAT_DISABLED`** (Railway env) — kill switch unnecessary post bedc226 redeploy.

## Validation timeline

| Date | Action | Expected metric |
|---|---|---|
| 2026-05-28 | Run `node scripts/validate-attacks-24h.js` | tier_quali HG emit count drop visible; tennis 7d ROI marginal improvement |
| 2026-05-30 | Re-check tennis BO5 post RG R2/R3 settled | calib v3 effect measurable |
| 2026-06-03 | 7d full window post-fixes | tennis 7d ROI ≥ -5% if working |
| 2026-06-10 | 14d window | Hook clear if ≥ +5% sustained |

## Next attacks (deferred, plan for next session)

### ATTACK 4 — Val ML region/tier awareness (~50 lines + tests)
- `lib/valorant-ml.js` is Elo flat, no tier/region adjustment
- Add `_classifyValRegion(eventName)` → 'pacific'|'emea'|'americas'|'challengers'|'other'
- Add `_applyTierShrink(modelP, tier)`:
  - 'challengers' → shrink modelP toward 0.5 by 50%
  - 'emea'/'pacific' → shrink 20%
  - 'americas'/'other' → no shrink
- Validate via shadow 14d
- Pre-condition: ATTACKs 2+3 validated (so val refactor doesn't compound risk)

### ATTACK 7 — LoL TOTAL flat OVER side bins
- mt-shadow-by-ev shows OVER side calib_gap +67pp (massive)
- Add `sides.over.bins` to `markets.total` in `lib/lol-mt-calib.json`
- Use observed hit_rate per EV bucket as pCalib
- Lower priority than ATTACK 4 (lol in shadow vs val also shadow but bigger sample n=82)

### ATTACK 8 — Tennis atp_challenger HG re-fit
- atp_challenger HG shadow n=13 ROI -50%, IC95 wide
- Current calib pCalib 0.27-0.38 already conservative
- May need bin granularity reduction (n=208 in bin[0] dominates)
- Defer until tier_quali validation complete (avoid compounding)

## Architectural debt (P3+P4 backlog)

1. **3 paralelos tier classifiers** (lib/league-tier, lib/mt-tier-classifier, inline patterns) — unify in next refactor cycle
2. **mt-refit-calib endpoint lacks**:
   - Dry-run mode with per-cell ROI eval (not just Brier/ECE)
   - Snapshot+rollback path
   - Merge mode (preserves untouched cells)
3. **No /admin/calib-apply** — can't probe pCalib outputs without emit. Add debug endpoint.

## Lessons learned

- **Endpoint OVERWRITES are dangerous.** `mt-refit-calib` without dry_run wrote full file, nuking previous additions. Always git-snapshot before.
- **dry-run skipped ROI eval.** Brier-only acceptance led to ATTACK 1 catastrophe (-10pp ROI worse, accepted because Brier improved).
- **Surgical JSON edits via Edit+commit+push beat endpoint live writes.** Git is the real source of truth.
- **P1 granularity matters.** Football overall PROMOTE verdict was P1-violator — overall +11.5% masked la_liga -73% sub-leak.
