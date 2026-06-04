# Idle Directive – Body Optimizer – STATUS

**Date:** 2026-06-04
**Version:** v=90
**URL:** https://idle-directive.zdendys79.website
**GitHub:** https://github.com/Zdendys/idle-directive

---

## Enhancement ideas

### ✅ saChainMove (v=89) — chain translate + rotate as an atomic group

Implemented in `src/sa/moves.js`. `_saFindChains` detects connected components of port-touching Spinners and Repeaters (BFS over adjacency). `saChainTranslate` shifts the whole chain by 1–4 cells in a random direction. `saChainRotate` rotates the chain by 90/180/270° around the bbox top-left (each component + its anchor rotate consistently). Wired into `saGenerateMove` as the `chain` category with weight 0.10 (balanced/swap/rotate/local), 0.20 (jump). Chain rotation leverages the fact that the component rotation logic is shape-wise equivalent to the chain rotation transform (90 CW on the bbox = 90 CW on each shape with the anchor shifted).

### Enhancement ideas (not implemented yet)

### 1. Bent/diagonal cluster variants for Spinner-Repeater chains

`src/sa/clusters.js` currently defines only the **linear** I-shape chain (`buildClusterDef('A', n)` = horizontal `S-R₂-S-R₂-…`, in 4 rotations via `_precomputeRotationVariants`). With these atomic clusters SA can only place "straight" shapes; bent/diagonal arrangements have to be assembled from individual components via `shift/swap/relocate` moves — orders of magnitude slower.

Proposal: add more `buildClusterDef` variants with identical outer ports `(2,0) W` + `(2,4) E` but different inner geometry:

- `A_L_n` — L-shape (R₂ extends perpendicularly one row down → 4h × 5w)
- `A_diag_up_n` — diagonal step-up (S bottom-left, S top-right → 5h × 5w)
- `A_diag_down_n` — diagonal step-down (mirror of diag_up)

Each new variant requires its own `_internalPlacements` array and goes through `_precomputeRotationVariants` → 4 rotations per variant. Total +12 cluster variants for `n=2`.

Benefit: SA can atomically place "L at the top edge + I inside" or "two diagonals in the corners" instead of converging on these configurations via dozens of individual moves.

### 2. Island migration — cross-worker sync of the best layout

Currently SA workers are independent islands: `bestValidLayout` is per-worker, the main thread collects leaves but does not broadcast them back. A stuck worker (e.g., at score 75k while another is at 100k) keeps going from its local maximum.

Proposal: every N iterations (e.g., 1000) the main thread broadcasts the current `bfResults[0].layout` to all workers as `{type:'migrate', layout, score}`. If a worker has `bestValidCost > globalCost`, it swaps its `current` + `best` for the global best and reheats T back to ~50% of `tStart`. Each worker still carries its per-worker `WORKER_PROFILES` (move bias + perturb), so it explores a **different path** from the same start.

Trade-off:
- ✅ Faster convergence to the global optimum
- ⚠️ Risk of premature convergence (everyone in one basin)
- ⚠️ Requires broadcast logic in `scheduleAnnealOpt` + a `migrate` handler in sa-worker

Implementation size: ~80 LOC, low-risk (no scoring changes).

---

## v=53–62 — Multi-worker brute force + modularization

### v=53 — Phase 2 Multi-worker
- `scheduleBruteForceOpt` spawns `N = getThreadCount()` workers, each takes a `[branchStart, branchEnd)` slice of `totalBranches`
- `bfSaveStateV2` format captures per-worker state for resume
- Reset moved into the Settings modal as "System reset" (danger style)
- Glassmorphism modal styling

### v=54–62 — Modularization (refactor steps 1–9)
Completely broke up the monolithic app.js (~1900 lines) + duplicate worker (~600 lines) into a logical layout:

```
src/
  constants.js                — STATE_KEY, BF_SAVE_KEY, SETTINGS_KEY, MAX_THREADS, _SIDE_IDX
  optimizer/
    rotation.js                — rotateSide/rotateCoord/rotateComponent/rotatePeriShape
                                 getBounds, getUniqueDegs (+ cache)
    bus.js                     — SIDE_DELTA, OPPOSITE, computePoweredSet, findWirePath
                                 wouldConnectToComponent/Bus, wouldBePowered
    placement.js               — getOccupiedMap, hasOverlap, fitsInGrid
                                 addPeripheralReserved
    score.js                   — computeFreeSpaceQuality, computeWorkingSet, scoreLayout
    validate.js                — isLayoutValid, tryAddWires
  bruteforce/
    generator.js               — bruteForcePlacements (shared between main + worker)
    save.js                    — bfSaveState, bfSaveStateV2, bfLoadSave, bfClearSave
                                 export/import bundle, _bfEncode/Decode, _computeBranchRanges
  ui/
    settings.js                — loadSettings/saveSettings/getThreadCount/openSettings…
```

**Benefits:**
- No code duplication between main and worker (they share `src/`)
- Clear API boundaries
- Easy unit-testing (each module on its own)
- IDE navigation + jump-to-definition

**Big refactor commit:** step 7 (`generator.js`) — −862/+438 lines (the shared generator removed two copies).

### Dependency rules (script load order)
1. `src/constants.js` (no dependencies)
2. `src/optimizer/rotation.js` (no dependencies)
3. `src/optimizer/bus.js` (no dependencies — defines SIDE_DELTA, OPPOSITE)
4. `src/optimizer/placement.js` (depends on bus.js: SIDE_DELTA for addPeripheralReserved)
5. `src/optimizer/score.js` (depends on bus.js, placement.js)
6. `src/optimizer/validate.js` (depends on bus.js, score.js)
7. `src/bruteforce/generator.js` (depends on all optimizer/* + constants)
8. `src/bruteforce/save.js` (no optimizer dependencies, but needs the state.js object)
9. `src/ui/settings.js` (needs SETTINGS_KEY, MAX_THREADS)
10. `optimizer.js`, `renderer.js` (legacy — remaining non-extracted functions: scorePositionAndCompact, buildRotatedPeri, findBestPlacement, etc.)
11. `app.js` (entry point + state, init, scheduleBruteForceOpt)

## v=52 — Settings overlay

- **⚙ icon** next to the "BODY OPTIMIZER" title → opens a settings modal
- **Thread count** for brute force (slider 1–6, default `min(hardwareConcurrency, 6)`)
- **Max is 6** even if the HW has more — to not overload the target machine
- Value persisted in `localStorage['app_settings']`, read via `getThreadCount()` — ready for Phase 2 (multi-worker dispatcher)
- **Export/Import moved** from the main panel into the settings modal
- **Glassmorphism modal**: `backdrop-filter: blur(10px) saturate(140%)`, semi-transparent background, fade-in animation, slight scale-up of content

## v=51 — Export bundle = layout + BF save

Export always includes the layout; the BF save is added if it exists. Import overwrites the layout and optionally restores the BF save (auto-restart of the worker). Backward-compatible with the v=49/50 legacy format (BF save only).

## v=50 — Repeater must have a target (Spinner or Pulser)

- **New validation rule** in `isLayoutValid` (app.js and worker): every placed Repeater must have a port match with at least one Spinner or Pulser
- **Placement-time pruning**: `targetCoverKeyCount: Map<int, count>` keeps the union of Spinner + Pulser cover keys; a Repeater without a match is rejected immediately after pushPlacement (before canReachBus)
- **Pulser tracking**: new `pushPulserTracking` / `popPulserTracking` update `targetCoverKeyCount`
- **Helper `computeCoverKeys`** shared by Spinner and Pulser
- The Spinner-Rep coverage counter (Opt #2) is unchanged

## v=49 — Save state export/import

- **Export button** in the left panel → modal with base64-encoded save state
- **Import button** → paste a string → validation → resume on the target machine
- Use case: server (4 cores) → desktop (24 threads) without losing progress
- On layout mismatch the dialog offers to overwrite the current layout with the layout from the save
- String format: `base64(utf8(JSON))` — typically ~10-15 KB for a 35-component search

---

## TODO: Brute force parallelization (Web Workers)

**Motivation:** Brute force for 35-40 components runs for days. The depth-1 branch search space is 800-3000 independent branches — an ideal candidate for parallelization.

**Implementation plan in phases:**

### Phase 1 — Refactor into worker (1 thread, control case) ✅ DONE (v=48)
- ✅ `bruteforce-worker.js` created with `importScripts('optimizer.js?v=48')`
- ✅ Worker carries its own copy of `bruteForcePlacements`, `isLayoutValid`, `tryAddWires`, `scoreLayout`, `getUniqueDegs`
- ✅ Main thread: `scheduleBruteForceOpt` creates a `Worker`, sends `{type:'init', componentLib}` → `{type:'start', nonWireIds, grid, resumePath, resumeStats}`
- ✅ Worker sends: `progress` (every second), `leaf` (better layout), `done`, `stopped`
- ✅ `currentBfWorker` module-level state for terminate on layout change or new scheduleBruteForceOpt
- ✅ Resume works through the worker — main passes `resumePath` in the `start` message
- ✅ Save works — main on a 60s tick in the `progress` message saves `path` + stats
- ✅ `bfClearSave()` kills the running worker on layout/grid change
- ✅ Auto-resume on page load (init detects a saved state, calls scheduleBruteForceOpt)
- **Bonus speedup ~2×** — worker has a 50ms batch deadline (vs. 8ms in main with UI sync), higher CPU utilization.

### Phase 2 — N workers, naive partitioning
- `navigator.hardwareConcurrency` reports the core count (typically 4-16)
- Main splits `totalBranches` (depth-1) evenly: each worker gets a `[start, end)` range
- Workers run independently, send the best-found layout
- Main aggregates and shows the globally best result
- **Expected speedup: 5-7× on 8 cores** (linear with messaging overhead).

### Phase 3 — Shared bestScore (optional, advanced)
- `SharedArrayBuffer + Atomics` for a global bestScore across workers
- Workers use the shared best to prune branches they cannot beat
- Requires COOP+COEP HTTP headers and `crossOriginIsolated` (Apache configuration needed)

### What adapts
- **Resume** — per-worker state or aggregated snapshot. The save format must contain a per-worker path.
- **UI progress** — sum the progress across all workers.
- **Timings** — aggregate from workers via messages.

### What stays
- Prunings #1-#5 work per-worker (state is local).
- Bus reachability works per-worker.
- Cell-budget works per-worker.

---

## Current state: WORKING

### What shipped in v=22

**Major optimizer refactor** — artificial cluster system removed, hard constraints added.

#### Removed (was unnecessarily complex)
- `buildSpinnerClusters` — template generator for clusters
- `placeClusterAt` — placer of cluster templates
- `runClusterOptimization` — cluster phase of the background optimizer
- `removeUsed` + `greedyFillRemaining` — cluster-phase helpers

#### Added / fixed

**optimizer.js:**
- Hard constraint #1 — Spinner must have free adjacent cells for pending Repeaters
- Hard constraint #2 — Repeater MUST connect to a non-working Spinner (if one exists)
- Reservation of peripheral slots in `occupiedMap` (sentinel -1) — fix for the biocell bug

**app.js:**
- `isLayoutValid` — validates the full layout (powering + Spinner working state)
- `scheduleBackgroundOpt` — simplified: only ordering sampling + `isLayoutValid` filter
- `ensureComponentOrder` — order fixed: Rep BEFORE Spin (used to be reversed)
- `generateClusterOrdering` — fixed: Repeaters pushed BEFORE their Spinner
- `debugLayoutStatus` — debug helper with console.group output
- Reference `generateRepFirstOrdering` → `generateClusterOrdering` fixed

---

## Optimizer architecture (after the refactor)

```
addComponent / optimizeAll
    └── findBestPlacement (greedy, hard constraints)
            ├── Hard: Spinner must have room for Repeaters
            └── Hard: Repeater must go to a non-working Spinner

scheduleBackgroundOpt (async batched)
    ├── N ≤ 7: allPermutations (N!)
    └── N > 7: 800× generateClusterOrdering + ensureComponentOrder
            └── runOptimizationOnCopy
                    └── isLayoutValid → discards invalid
                            └── scoreLayout → stores the best
```

---

## Known limitations

- Background optimizer may not find a valid layout if the grid is too small
  (proper message: "no room found — expand body")
- For N > 7 components: 800 samples may not cover the optimal order (stochastic)

---

## Version history (recent)

| Version | Date | Change |
|---|---|---|
| v=22 | 2026-06-03 | Cluster system removed, hard constraints, Rep→Spin order fix |
| v=21 | 2026-06-03 | Debug logging, biocell reservation fix, Repeater hard constraint |
| v=20 | earlier | Cluster template system (replaced) |
