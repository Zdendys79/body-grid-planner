# Idle Directive – Body Optimizer – STATUS

**Date:** 2026-06-07
**Version:** v=99
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

Total: **21** (incl. `metal_scavenger`, `furnace`, `fuser_i`). Authoritative definitions live in `components.json` and must not be edited without explicit user request.

| Category | Components |
|---|---|
| infrastructure | wire |
| power | battery_1x1, battery_1x2, battery_2x2, bio_generator (3×3 self-contained), energy_cells |
| timing | pulser, spinner, repeater_2s, repeater_4s |
| processing | grabber, collector, decomposer, harvester, salvager, metal_scavenger, furnace, fuser_i |
| detection | sensor |
| bio | disposable_biocell, biocell |
