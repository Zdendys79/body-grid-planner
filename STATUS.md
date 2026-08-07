# Body Grid Planner – STATUS

**Date:** 2026-08-07
**Version:** v=157
**URL:** https://body-grid-planner.zdendys79.website
**GitHub:** https://github.com/Zdendys79/body-grid-planner

---

## Current state

Production. SA runs in 1–6 Web Workers, results are streamed to a Top-20 panel with auto-follow, layouts persist in localStorage, user-crafted positions are preserved on Add, carry-and-drop interaction is live (with a trash button + Delete key to discard from carry), every UI surface and console log is in English. Brute force was retired in v=94 — SMART (SA) is the sole optimizer; the explicit RE-OPTIMIZE button covers the deterministic-greedy use case. SA scoring now also rewards powered free rectangles (v=96) so SMART prefers layouts that keep open space against the W/S bus for future batteries / clusters.

---

## Enhancement ideas (parked)

### 1. Bent / diagonal cluster variants for Spinner-Repeater chains

`src/sa/clusters.js` currently defines only the **linear** I-shape chain (`buildClusterDef('A', n)` = horizontal `S-R₂-S-R₂-…`, in 4 rotations via `_precomputeRotationVariants`). With these atomic clusters SA can only place "straight" shapes; bent/diagonal arrangements have to be assembled from individual components via `shift/swap/relocate` moves — orders of magnitude slower.

Proposal: add more `buildClusterDef` variants with identical outer ports `(2,0) W` + `(2,4) E` but different inner geometry:

- `A_L_n` — L-shape (R₂ extends perpendicularly one row down → 4h × 5w)
- `A_diag_up_n` — diagonal step-up (S bottom-left, S top-right → 5h × 5w)
- `A_diag_down_n` — diagonal step-down (mirror of diag_up)

Each new variant needs its own `_internalPlacements` array and goes through `_precomputeRotationVariants` → 4 rotations per variant. Total +12 cluster variants for `n=2`.

Benefit: SA can atomically place "L at the top edge + I inside" or "two diagonals in the corners" instead of converging on these configurations via dozens of individual moves.

### 2. Island migration — cross-worker sync of the best layout

SA workers are independent islands today: `bestValidLayout` is per-worker, the main thread collects leaves but does not broadcast them back. A stuck worker (e.g., at score 75k while another is at 100k) keeps going from its local maximum.

Proposal: every N iterations (e.g., 1000) the main thread broadcasts the current `bfResults[0].layout` to all workers as `{type:'migrate', layout, score}`. If a worker has `bestValidCost > globalCost`, it swaps its `current` + `best` for the global best and reheats T back to ~50 % of `tStart`. Each worker still carries its `WORKER_PROFILES` (move bias + perturb), so it explores a **different path** from the same start.

Trade-off:
- ✅ Faster convergence to the global optimum
- ⚠️ Risk of premature convergence (everyone in one basin)
- ⚠️ Requires broadcast logic in `scheduleAnnealOpt` + a `migrate` handler in `sa-worker`

Implementation size: ~80 LOC, low-risk (no scoring changes). Needs the worker's `simulatedAnneal` loop to yield periodically so queued `migrate` messages can be processed.

---

## Optimizer architecture

```
Add component (addComponent)
    ├── findBestPlacement (wire-aware, port-on-bus bonus)
    │       └── existing components unchanged
    └── (fallback) findAnyPlacement — geometric fit only, no wires
            └── existing components still unchanged
                    └── (last resort) error: "no room — expand body"

Re-Optimize (optimizeAll)
    └── ensureComponentOrder → findBestPlacement per id
            └── rollback if any component is skipped or final layout invalid

SMART (scheduleAnnealOpt)
    └── 1..N workers via new Worker('sa-worker.js?v=…')
            ├── seed: user state (if sane) or multi-strategy greedy chain
            ├── perturb: 0..25 moves per WORKER_PROFILES
            └── simulatedAnneal → leaf messages → optResults panel + auto-follow
```

Any layout-mutating action (add/remove/expand/import/drop/delete) calls `stopOptimization()` first — it bumps `bgOptId` so in-flight worker messages drop themselves on arrival and terminates any active SA workers.

### scoreLayout signals (v=96)

`scoreLayout(placements, grid)` aggregates four signals, biggest first:

| Signal | Magnitude | Source |
|---|---|---|
| `workingSet.size × 50000` | per working Spinner | `computeWorkingSet` |
| `computeFreeBlockBonus` | super-linear in block area, ×2 at bus | windowed sweep over Uint8Array occupied/portTarget grids |
| `wires × −5000` | penalty per auto-routed wire cell | `tryAddWires` |
| `quality × 4` | per free-cell-pair connectivity | `computeFreeSpaceQuality` |

The free-block table escalates 200 (2×2) → 25000 (4×4) → 60000 (5×5), doubled when the window touches the W bus (col 0) or S bus (row R−1). Windows overlap on purpose: a 4×4 powered area at the bus is counted as one 4×4 + four 3×3 + nine 2×2, so total bonus scales quadratically with free-block size without explicit max-rectangle dedup.

### Carry interaction (v=85, refined v=97)

Click a placed component to lift it; the ghost follows the cursor pixel-by-pixel within ±5 SVG units of a cell centre and snap-aligns outside that zone. Wires drop and are recomputed on a valid placement. Controls while carrying:

| Action | Result |
|---|---|
| Move mouse | Ghost follows cell-by-cell |
| `R` key | Rotate to next geometrically distinct orientation |
| Click on grid | Drop at current cell (bounds + collision validated) |
| `Delete` key OR floating 🗑 button | Remove the carried component, recompute wires for the rest |
| `Esc` key | Cancel, restore original position + wires |

---

## Known limitations

- The cluster system covers linear Spinner-Repeater chains only. Bent/diagonal arrangements (enhancement #1) must be re-assembled by SA's per-component moves; this is slower for layouts that genuinely need a bend.
- SA workers do not synchronize their bests (enhancement #2). A worker stuck in a low local optimum cannot benefit from another worker's discovery in the same session.
- The `sa-worker.js` URL in `app.js` is hard-coded with `?v=N`; the sed bump script must touch `app.js` as well as `index.html` and `sa-worker.js`, or workers stall on a stale cached blob.

---

## Version history

| Version | Date | Change |
|---|---|---|
| v=157 | 2026-08-07 | New component: Bio Core — 10-cell shape (1-cell neck + 3x3 base), W+E both on the neck cell (0,0). Energy generator: added to `BIO_GENERATOR_IDS` (validate.js) so Biocell/Disposable Biocell can plug into it like Bio Generator (I)/(II), and to `ENERGY_AMPLIFIER_TARGETS` + the `bioGen` weight category (score.js, optimizer.js) so Energy Amplifier gets a bonus connecting to it. UNLIKE Bio Generator (I)/(II), Bio Core has its own hard requirement in the opposite direction too — confirmed by the user in-game: a Bio Core not port-adjacent to a Biocell/Disposable Biocell is invalid (new `hasBioCores`/`biocellPortKeys` check in `isLayoutValid`, mirroring the existing Biocell-needs-generator check but reversed). No placement-time hard constraint added on the Bio Core side (would create a chicken-and-egg ordering conflict with Biocell's own existing-generator-seeking constraint) — enforced only at final validity, same as the Repeater/Spinner mutual requirement already is |
| v=156 | 2026-08-06 | Cosmetic renames: "Fuser (I)" → "Fuser", "Metal Scavenger" → "Scrap Scavenger". Bugfix: Scrap Scavenger's W port was on the wrong row — moved from (1,0) to (0,0) per user's corrected in-game shape reference (`=SSS / SSS`, connector on the top row) |
| v=155 | 2026-08-06 | New component: Cultivator — 8-cell notched shape (3x3 bounding box missing (1,0)), W port on (0,0), S port on (2,0). No special placement rules. |
| v=154 | 2026-08-03 | Per user request: went beyond v=153's optional chain-move for pin/amplifier groups to a HARD permanent merge. New `mergeConnectedGroupsIntoBlocks`/`buildMergedBlockDef` in `src/sa/clusters.js` detect Upgrader pin-groups and amplifier-family clusters (Concentrator + connected Energy Cells etc., via the v=153 detectors) in the user's own layout at SA-seed time and freeze each into ONE synthetic cluster-like placement (reusing the existing `_isCluster`/`_internalPlacements`/`expandClustersInPlacements` contract built for Spinner-Repeater clusters) — SA's move set then sees a single atom per group and can only shift/rotate/relocate/swap it as a whole, so no move can ever break its internal connections (stronger guarantee than the v=153 chain-move, which only optionally moved a group together some of the time). Wired into `sa-worker.js`'s user-seed path only (the fallback from-scratch greedy path has no existing arrangement to derive blocks from — same scope boundary as pinning itself). Found and fixed a real bug during verification: the merge/expand round-trip silently dropped `pinTag`/`pinnedTags` on internal members (3 separate spots — `buildMergedBlockDef`, `_precomputeRotationVariants`, `expandClusterPlacement` — none carried the fields through), which would have made every pinned Upgrader register as invalid the instant its merged block got expanded back for scoring. Verified on the user's reported layout: 24 components merge into 18 atoms (2× 3-member Upgrader-pin blocks, 1× 3-member Power-Amplifier/Harvester/Salvager block); a full SA run found a genuine improvement (score 46096880 → 48120640) while keeping every merged group's connections intact throughout |
| v=153 | 2026-08-03 | Generalized SA's chain-move mechanism (`src/sa/moves.js`) from Spinner/Repeater-only to any "move together" group, per user request. `_saFindAllGroups` now concatenates 3 detectors: `_saFindChains` (existing, Spinner/Repeater), new `_saFindPinGroups` (Upgrader + its pinned target(s), identity-based via pinTag/pinnedTags — direct fix for the v=151/152 exploration problem, since a fully-pinned Upgrader has no free port and no single-piece move can relocate it without breaking the pin), and new `_saFindAmplifierGroups` (Power/Battery/Energy Amplifier or Concentrator + its currently port-connected target(s), adjacency-scanned via the same pairing rules as `computeXBonus`/`getXConnectionBonus`, addresses "don't let SA carelessly break up an already-maximal Concentrator+6xEnergyCells cluster"). `saChainTranslate`/`saChainRotate` are unchanged mechanically — they already operated generically on any index list, just fed from the wider `_saFindAllGroups` now instead of only `_saFindChains`. Verified: group detection finds the right members and excludes unrelated components; group translate/rotate preserves every internal port connection exactly (concentratorBonus and Upgrader pin validity both unchanged after a group move, confirmed by direct test) — a rotate CAN incidentally lose bus contact if the group happens to sit right at the grid edge (rotation changes port sides), same pre-existing behavior chain moves already had for Spinner/Repeater, self-corrects via the normal cost penalty. Re-ran the v=152 mobility benchmark on the user's reported layout: 21/24 components moved from their starting position within ~6000 iterations, up from 16/24 before (now including 3 of the pin-tagged targets, up from 2) |
| v=152 | 2026-08-03 | SA profiling (user report: SMART barely moved anything on a 24-component layout with 2 fully-pinned Upgraders). Instrumented every SA sub-function on the user's exact export: `tryAddWires`+`computePoweredSet` dominate (65-70%/45% of wall time respectively) — pre-existing architecture cost (O(components) BFS passes per call), not caused by Upgrader; the new `_upgraderPinsOk`/`_upgraderPortAssignmentOk` check itself is negligible (~0.3-0.4%). Found and fixed one real redundancy: `simulatedAnneal`'s accepted-move leaf-check recomputed `tryAddWires`+`isLayoutValid`+`scoreLayout` from scratch even though `saComputeCost` (renamed internals: new `saComputeCostDetailed`) had just computed the exact same three things one line earlier — every accepted move paid for the single most expensive call chain twice. Fixed by having the annealer reuse `saComputeCostDetailed`'s `{wired, valid, score}` instead of recomputing. Isolated testing could NOT reproduce a severe freeze from pinning itself (a synthetic run on the reported layout moved 16/24 components, including both Upgraders, within ~4000 iterations) — real-world slowness may be the browser/6-worker environment, or the reduced acceptance rate around fully-pinned components (both ports pinned = no free port = any single-piece move breaks it) needing more iterations than usual to find a fit; a coordinated "move pinned group together" SA move (mirroring the existing Spinner/Repeater chain-move) was proposed as a follow-up but not implemented this pass |
| v=151 | 2026-08-03 | New component: Upgrader (2x2, W ports at (0,0)+(1,0), no scoring bonus of its own) with a new "instance pinning" mechanic — it must stay port-adjacent to the EXACT same component instance(s) it was manually connected to, across any RE-OPTIMIZE/SMART run, even after rotation/relocation, and must never pick up an unintended connection to some other component the user didn't choose. Pins are created ONLY by direct user action (addComponent, carry-drop — never by the optimizer itself) via a new `pinTag`/`pinnedTags` field pair threaded through every placement pipeline: persistence (saveState/loadState, export/import bundle), RE-OPTIMIZE (`ensureComponentOrder` now carries `{componentId,pinTag,pinnedTags}` tuples instead of bare strings, with a new `_hoistPinnedTargets` pass that places pin targets before their Upgrader; `findBestPlacement` gained an `upgraderPinnedTags` param enforcing the hard adjacency constraint via a new shared `_upgraderPortAssignmentOk` in `src/optimizer/validate.js`), and SMART (`sa-worker.js`'s user-seed reconstruction carries the fields through; `src/sa/moves.js`'s `_saMakePlacement` was silently dropping them on every relocate/rotate/swap — fixed by passing the source placement through). `isLayoutValid` enforces the pin as a hard constraint per-port (each port is independently either pinned-and-must-match or free-and-must-not-touch-anything-real) and exempts a fully unpinned Upgrader from the "must be powered" requirement, since it only relays power through an active pin. Known scope limit: SA's from-scratch fallback seed path (used only when the current layout isn't valid enough to seed from) does not carry pin data — RE-OPTIMIZE and SMART-from-a-valid-layout (the common cases) are fully covered |
| v=150 | 2026-08-03 | Real bug, exposed by v=149's aggressive wirePenalty/freeBlock retune: user reported RE-OPTIMIZE on 10x Energy Cells + 2x Concentrator produced a degenerate straight double-row hugging the W bus, with both Concentrators stranded at the end connecting to only 1 block each (concentratorBonus 3000000) instead of clustering (12000000+). Root cause: `ensureComponentOrder` (app.js) / `_saComponentOrder` (src/sa/greedy.js) placed all 10 Energy Cells greedily BEFORE either Concentrator — with no amplifier yet to connect to, each Energy Cells block's own greedy score reduces to bus-adjacency/wire-avoidance, and v=149's much heavier wirePenalty made that pull strong enough to line every block up on the bus before any Concentrator got a chance to claim central real estate. Same starvation pattern as the v=146 Biocell/Repeater-Spinner ordering fix, just for the amplifier family. Fix: new shared `AMPLIFIER_TYPE_IDS` (power_amplifier/battery_amplifier/energy_amplifier/concentrator) in `src/optimizer/score.js`, placed FIRST in both ordering functions, before their targets. Verified on the exact reported component set: score 18656720→23801760, concentratorBonus 3000000→12000000, 0 wires either way |
| v=149 | 2026-08-03 | Weight retune, not a bug fix: user reported a real layout (10x Energy Cells + 2x Concentrator, exported/analyzed directly) where SA kept 5 auto-routed wires instead of relocating the whole cluster to touch the bus wire-free. Verified computationally that the wire-free alternative genuinely scores *lower* under default weights (loses ~2.5M on `freeBlock`/`busAccess` from fragmenting open space near the bus corner, far more than the ~25000 saved on `wirePenalty`) — even pushing `wirePenalty` to 20x default couldn't flip it. Not a bug: SA's choice was mathematically optimal, humans just find fewer wires more intuitive. Per explicit user request, retuned defaults anyway: `wirePenalty` 5000→100000, `freeBlock` 1→0.2, so SA now weighs "fewer wires" much more heavily against "more open space" in general (still doesn't change this specific worst-case export, which genuinely has no better wire-free arrangement, but shifts the balance for less extreme layouts) |
| v=148 | 2026-08-03 | Real fix for the Concentrator issue @Konsolka originally reported (GitHub issue #2) — my v=143 "comment-only" dismissal was wrong. `computeConcentratorBonus` (`score.js`) and `getConcentratorConnectionBonus` (`optimizer.js`) counted the bonus PER PORT-PAIR instead of per distinct connected block, so 4 blocks each double-porting (8 port-pairs) tied 6 single-porting blocks (also 8 port-pairs) — SA had zero incentive to prefer the 6-block layout and settled for the simpler 4-block one every time, exactly what Konsolka's screenshot showed. Both functions now dedup by `(concentrator, target)` pair like the other 3 amplifier-family bonuses, so each distinct connected Energy Cells block scores once regardless of how many of its own ports touch the Concentrator — verified via test: 4 double-porting blocks now score 4×weight vs 6 single-porting blocks at 6×weight (previously both scored 8×weight, tied). Also fixed the same missing per-pair dedup (latent, never manifested) in the other 3 `getXConnectionBonus` functions in `optimizer.js`, and corrected the Concentrator weight's Settings hint text |
| v=147 | 2026-08-02 | `findBestPlacement` (RE-OPTIMIZE + SA's initial greedy seed) was missing scoring for 3 of the 4 amplifier-family bonuses — only Power Amplifier had a `getAmplifierConnectionBonus`; Battery Amplifier, Energy Amplifier, and Concentrator had zero incentive to connect to their targets outside of SMART's full `scoreLayout` search. Added `getBatteryAmplifierConnectionBonus`, `getEnergyAmplifierConnectionBonus`, `getConcentratorConnectionBonus` mirroring the existing pattern (and their `computeXBonus` counterparts in `score.js`), wired into `findBestPlacement`'s scoring cascade. Verified all 3 now connect correctly via direct tests |
| v=146 | 2026-08-02 | Greedy placement ordering fix (`ensureComponentOrder` in `app.js`, `_saComponentOrder` in `src/sa/greedy.js`): Biocell/Disposable Biocell now placed right after "other" components (their Bio Generator included) but BEFORE the Repeater/Spinner interleave, not after everything. An unrelated Repeater/Spinner could previously grab a Biocell's one valid connector cell first, starving it into the constraint-blind geometry-only fallback. Verified fixed against the adversarial case found while testing v=144/145; confirmed the residual Spinner/Repeater validity gap in that same test is pre-existing and unrelated (reproduces identically with no bio components present at all) |
| v=145 | 2026-08-02 | Full removal of the dead `bioPorts`/`rotatedBioPorts` mechanism (11 files: `components.json`, `rotation.js`, `bus.js`, `validate.js`, `optimizer.js`, `renderer.js`, `app.js`, `sa-worker.js`, `src/sa/{shell,clusters,moves,greedy}.js`) — no component populates it since v=144's Biocell rework, so it was pure dead weight. Also fixed the same `energyPorts.length===0` bio-only heuristic bug in `src/sa/greedy.js`'s `_saComponentOrder` (SA's own greedy seed builder) that was already fixed in `app.js`'s `ensureComponentOrder` for RE-OPTIMIZE — now both explicitly order Biocells after their Bio Generator via `BIOCELL_IDS` |
| v=144 | 2026-08-02 | Reworked Bio Generator mechanic: the `bioPorts` concept didn't correspond to a real game mechanic — a Biocell can plug into ANY port of a Bio Generator, not one dedicated bio-only port. Bio Generator (I)/(II) redrawn without an integrated Biocell cell (new shapes/ports); Biocell/Disposable Biocell converted to normal `energyPorts` and un-hidden as regular placeable components, but with a new hard validity constraint (`isLayoutValid`, `findBestPlacement`): must be port-adjacent to a Bio Generator (any tier) to be valid, same shape as the Repeater↔Spinner/Pulser constraint. `scheduleAnnealOpt` no longer excludes them from SA's component set |
| v=143 | 2026-08-02 | Comment-only fix (GitHub issue #2): `computeConcentratorBonus`'s doc comment wrongly claimed only 4 of the Concentrator's 8 ports could ever connect to Energy Cells. Verified via test that the actual scoring logic already correctly counts all 8 (Energy Cells rotated 90/270 exposes N/S ports too) — no functional bug, comment corrected |
| v=142 | 2026-08-01 | Bugfix (regression from v=141): `const w = getScoreWeights()` shadowed the outer `w` (the Worker instance) inside the same `onmessage` block — `w.postMessage({type:'start',...})` then threw `TypeError: w.postMessage is not a function` uncaught, silently preventing SMART from ever actually starting (button flipped to running, status bar stayed silent, no worker received the start message). Renamed to `weights` |
| v=141 | 2026-08-01 | Bugfix: SA temperature schedule (`tStart`/`tEnd` in `scheduleAnnealOpt`, `app.js`) was still calibrated for the pre-v=130 weight scale (workingSet 50000) — after weights were retuned to the millions, `exp(-delta/T)` collapsed to ~0 for any real move even at the hottest temperature, so SA degenerated into pure hill-climbing and could never escape the first local optimum. `tStart`/`tEnd` now derive from the current dominant weight at SMART start time, so this self-corrects if weights are retuned again |
| v=140 | 2026-08-01 | New component: Concentrator — 2x2 block with ports on all 8 outward sides (N/W/N/E/S/W/S/E on its 4 corners). New `computeConcentratorBonus` (default 3000000/connection) rewards each port-to-port link to an Energy Cells block — counted per port (not per component pair), so two simultaneous links to the same block each score. New "Concentrator bonus" weight slider in Settings |
| v=139 | 2026-08-01 | Bugfix: `tryAddWires` (`src/optimizer/validate.js`) gave up entirely if the FIRST unpowered component in placement order had no free cell for a wire, even when a LATER unpowered component had a valid path whose wiring would have powered the first one for free via direct port propagation. Now tries every still-unpowered component each pass before declaring the layout unwireable |
| v=138 | 2026-08-01 | New component: Resource Scanner — 6-cell T-shape (single cell stalk atop a 5-wide base), N port on (0,2). No scoring bonus wired up yet (unlike the amplifiers) — component data only |
| v=137 | 2026-08-01 | `weights.energyAmplifier` split into 4 independently-tunable per-target weights (`energyAmpBioGen`, `energyAmpEnergyCells`, `energyAmpSpinner`, `energyAmpPulser`) — Pulser added as a 4th Energy Amplifier target alongside Bio Generator/Energy Cells/Spinner. `computeEnergyAmplifierBonus` now returns per-category counts instead of one flat total |
| v=136 | 2026-08-01 | New component: Energy Amplifier — 3-cell vertical shape, W+E both on (2,0). New `computeEnergyAmplifierBonus` (default 3000000/connection, flat, not size-scaled) rewards port-connecting it to a Bio Generator, Bio Generator (II), Energy Cells, or Spinner. New "Energy Amplifier bonus" weight slider in Settings, grouped with the other amplifier bonuses |
| v=135 | 2026-07-30 | `scoreLayout`: new Battery Amplifier bonus (`computeBatteryAmplifierBonus`, default 1000000/connection) rewards port-connecting a Battery Amplifier to any battery, MULTIPLIED by the connected battery's cell count — bigger batteries score proportionally more. New "Battery Amplifier bonus" weight slider in Settings, grouped with Working Spinner / Amplifier bonus |
| v=134 | 2026-07-30 | New component: Battery Amplifier — 3-cell L-shape (2 cells top row + 1 below the right cell), W+E both on (1,1) |
| v=133 | 2026-07-30 | Bugfix: Import layout silently did nothing after the confirm dialog — `applyImportLayout` (`src/ui/export.js`) called `bfResultsClear()`, a stale pre-v=94 function name that no longer exists, throwing a ReferenceError before `saveState`/`renderAll`/modal-close ran. Fixed to `optResultsClear()` |
| v=132 | 2026-07-30 | Bio Generator biocell rendering generalized from id-hardcoded to data-driven (`components.json` `biocellCells` field, `renderer.js` `_biocellSet`) — Bio Generator (II) now gets the same distinct biocell cell styling as (I); icon centering offset only applies when the shape actually has a bounding-box notch (I does, II doesn't) |
| v=131 | 2026-07-30 | New component: Bio Generator (II) — 3x3 solid block, Biocell integrated in right column (visual-only distinction, not yet in the renderer), W on (2,0), E on (2,2) |
| v=130 | 2026-07-30 | `DEFAULT_SCORE_WEIGHTS` retuned: workingSet 50000→2650000, amplifier 8000→4000000, quality 4→15000, cluster 100→50000 (wirePenalty/freeBlock/busAccess unchanged). Slider steps in Settings scaled to match the new magnitudes |
| v=129 | 2026-07-30 | "Layout scoring weights" now built dynamically (`renderWeightList`/`updateWeightBars` in settings.js): each row gets a live fill bar showing its % share of the current layout's total score (`computeWeightContributions`, magnitude-based so wirePenalty's subtraction still reads meaningfully). Working Spinner + Amplifier bonus grouped together in a visually distinct box |
| v=128 | 2026-07-29 | `computeFreeBlockBonus` now returns `{free, bus}` instead of one combined total — the old hardcoded ×2 bus multiplier is replaced by a separate, independently-tunable `busAccess` weight in Settings, decoupled from the general `freeBlock` free-space weight |
| v=127 | 2026-07-29 | Decomposer (II) shape corrected: top row is (0,0)+(0,1) (was (0,1)+(0,2)); W port moved to (0,0), E to (0,1) |
| v=126 | 2026-07-29 | New component: Decomposer (II) — 2x4 offset block, W on (0,1), E on (0,2); original Decomposer renamed to Decomposer (I) (id unchanged) |
| v=125 | 2026-07-29 | `startAnneal` clears prior Top-20 results on every fresh SMART start (was preserved across runs). `addComponent` now re-scans the whole layout with `tryAddWires` after placing the new component, so previously-stranded unpowered components that are now one hop from power (e.g. a Battery dropped next to them) get wired too — `findBestPlacement` only wired the newly added component itself |
| v=124 | 2026-07-29 | SMART and STOP merged into one toggle button (`toggleAnneal`, `updateAnnealButton`); changing a Layout scoring weight (or resetting) now also auto-stops an in-progress SMART search, same as editing the layout — button flips back to idle and must be explicitly restarted |
| v=123 | 2026-07-29 | New `src/ui/debug-stats.js`: every RE-OPTIMIZE run records a local before/after score (last 50, `localStorage[REOPT_STATS_KEY]`) — Settings → "RE-OPTIMIZE debug stats" exports them as the same kind of base64 string as layout export. Never sent anywhere, per the privacy promise |
| v=122 | 2026-07-29 | New component: Battery (3x2) — 2×3 solid block, E ports on (0,2) and (1,2) |
| v=121 | 2026-07-29 | `components.json`: reordered Battery (1x3) before Battery (2x2) in the power category |
| v=120 | 2026-07-29 | RE-OPTIMIZE LAYOUT (`findBestPlacement`) now also rewards Power Amplifier <-> Harvester/Salvager port connections (`getAmplifierConnectionBonus`, reads live `scoreWeights.amplifier`) — previously only SMART (SA) considered this bonus |
| v=119 | 2026-07-29 | `scoreLayout`: new Power Amplifier bonus (`computeAmplifierBonus`, default 8000/connection) rewards port-connecting a Power Amplifier to a Harvester or Salvager — optional, not a validity requirement. New "Amplifier bonus" weight slider in Settings |
| v=118 | 2026-07-29 | `expandBody`: skip the 13×12 step (game itself jumps straight from 11×11 to 15×12 once cols hit their 12 cap) |
| v=117 | 2026-07-29 | Settings: player-tunable `scoreLayout` weights (working Spinner, wire penalty, quality, free-block bonus multiplier, aesthetic clustering) with `[?]` hover hints and a reset-to-defaults button. Weights persist in `localStorage[SETTINGS_KEY]`; SA workers receive them via the `init` message |
| v=116 | 2026-07-29 | Settings/Help "About" text updated for the 29 July 2026 Steam release (was still saying "demo, full release scheduled") — added a Steam purchase recommendation, kept the itch.io demo link |
| v=115 | 2026-07-29 | H1 now shows the app version (`v${APP_VERSION}`), derived at runtime from `app.js`'s own `?v=N` cache-buster via `document.currentScript` — no separate version string to maintain |
| v=114 | 2026-07-29 | New component: Power Amplifier — 2x2, W on bottom-left, E+S on bottom-right |
| v=113 | 2026-07-29 | New component: Collector (II) — 1×3 vertical, W+E on middle cell; original Collector renamed to Collector (I) (id unchanged) |
| v=112 | 2026-07-29 | New component: Furnace (II) — 4×3 solid block, W+S on bottom-left corner, E+S on bottom-right corner; original Furnace renamed to Furnace (I) (id unchanged) |
| v=111 | 2026-07-29 | Progress bar: iteration count in scientific notation (`1.23e+5`), elapsed time as `M:SS`/`H:MM:SS` instead of decimal minutes |
| v=110 | 2026-07-29 | New component: Battery (1x3) — 1×3 shape, W/E ports on short sides (`=BBB=`) |
| v=109 | 2026-06-19 | `expandBody`: new rows added at top (matching game behaviour) — all components shift down by `deltaRows`, wires recomputed |
| v=108 | 2026-06-18 | `file://` support: `build.js` generates `components-data.js` + `sa-worker-bundle.js`; app uses Blob worker + inline JSON, no web server needed |
| v=107 | 2026-06-18 | `scoreLayout`: aesthetic cluster bonus — same-type neighbours +100, port-connected +200 (spinners/repeaters/wires excluded) |
| v=106 | 2026-06-18 | `expandBody` fixed: both axes step to next odd number above `max(rows,cols)` — 3×4 → 5×5 → 7×7 → … → 19×12; level label formula aligned |
| v=99 | 2026-06-07 | Bio Generator visual: BIOCELL labels in cells (0,0) and (1,0), lower-alpha fills + suppressed bridges to body, ☘ glyph offset down ~1/3 cell |
| v=98 | 2026-06-07 | `expandBody` logs old → new dims + warns when at max; `optimizeAll` logs grid; defensive maxRows/maxCols coercion on init for legacy persisted state |
| v=97 | 2026-06-07 | Carry mode: floating 🗑 Delete button + `Delete` key remove the picked-up component and recompute wires |
| v=96 | 2026-06-07 | `scoreLayout` adds powered free-block bonus — escalates 200 (2×2) → 60000 (5×5), ×2 multiplier when block touches W or S bus |
| v=95 | 2026-06-06 | Renamed `bfResults*`/`bfAutoFollowTop`/`BF_RESULTS_KEY`/`#bf-results`/`#bf-progress`/`bfEl` → `opt*` equivalents now that BF is gone |
| v=94 | 2026-06-06 | Brute force completely removed (~1500 LOC); `src/bruteforce/` deleted; layout export/import extracted to `src/ui/export.js`; new `stopOptimization()` helper |
| v=93 | 2026-06-06 | Component icons 3× larger on left panel + grid (font-size 13→36 inline, 15→45 placed list, 15→45 SVG) |
| v=92 | 2026-06-05 | `addComponent` no longer triggers full layout rearrangement on fallback — only `findAnyPlacement` is tried |
| v=91 | 2026-06-05 | All Czech text translated to English (code, console logs, UI labels, README, STATUS) |
| v=90 | 2026-06-05 | Worker URL versions in `app.js` were stale (v=64 / v=53); bumped + sed pattern now touches `app.js` |
| v=89 | 2026-06-05 | `saChainTranslate` + `saChainRotate` atomic chain moves implemented in `src/sa/moves.js` |
| v=88 | 2026-06-05 | Bio Generator: peripheral merged into 3×3 body shape, biocell reservation dropped |
| v=87 | 2026-06-05 | Modal: removed nested `backdrop-filter`, fixes Firefox paste freeze in import dialog |
| v=86 | 2026-06-05 | Export/Import auto-closes settings modal before opening save modal |
| v=85 | 2026-06-05 | Drag-and-drop replaced with click-to-pick-up / carry / click-to-drop, R rotates, Esc cancels |
| v=84 | 2026-06-04 | `tryRotatePlacement` ignores wires in overlap check + recomputes via `tryAddWires` on success |
| v=83 | 2026-06-04 | Peripheral bounds + overlap validated in every SA placement check |
| v=82 | 2026-06-04 | sa-worker: accept structurally sane user seed + multi-strategy greedy fallback chain |
| v=81 | 2026-06-04 | `addBfResult` rejects leaves with mismatched component set + greedy logs dropped IDs |
| v=80 | 2026-06-04 | `getUniqueDegs` now keys by shape + ports, so square components with directional ports get 4 rotations |
| v=79 | 2026-06-04 | bfResults validated against current component set on load; cleared when set changes |
| v=78 | 2026-06-04 | Drag: remove wires at drag start, recompute via `tryAddWires` on drop |
| v=62 | 2026-06-04 | Modularization complete; monolithic `app.js` + duplicate worker split into `src/*` modules |
| v=53 | 2026-06-04 | Multi-worker brute force, `bfSaveStateV2` format, glassmorphism modals |
| v=52 | 2026-06-04 | Settings modal: thread-count slider, export/import moved off main panel |
| v=51 | 2026-06-03 | Export bundle = layout + BF save |
| v=50 | 2026-06-03 | Repeater hard constraint: must port-match a Spinner or Pulser |
| v=49 | 2026-06-03 | Save state export/import via base64 string |
| v=48 | 2026-06-03 | Brute force moved into a dedicated `bruteforce-worker.js` |
| v=22 | 2026-06-03 | Artificial cluster system removed; hard constraints + `isLayoutValid` introduced |

---

## Components

Total: **32** (incl. `metal_scavenger`, `furnace`, `furnace_ii`, `fuser_i`). Authoritative definitions live in `components.json` and must not be edited without explicit user request.

| Category | Components |
|---|---|
| infrastructure | wire |
| power | battery_1x1, battery_1x2, battery_1x3, battery_2x2, battery_3x2, battery_amplifier, bio_generator, bio_generator_ii, concentrator, energy_amplifier, energy_cells, power_amplifier |
| timing | pulser, spinner, repeater_2s, repeater_4s |
| processing | grabber, collector (I), collector_ii (II), decomposer (I), decomposer_ii (II), harvester, salvager, metal_scavenger, resource_scanner, furnace (I), furnace_ii (II), fuser_i |
| detection | sensor |
| bio | disposable_biocell, biocell |
