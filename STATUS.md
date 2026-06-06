# Idle Directive – Body Optimizer – STATUS

**Date:** 2026-06-06
**Version:** v=93
**URL:** https://idle-directive.zdendys79.website
**GitHub:** https://github.com/Zdendys/idle-directive

---

## Current state

Production. SA + BF run in 1–6 Web Workers, results are streamed to a Top-20 panel with auto-follow, layouts persist in localStorage, user-crafted positions are preserved on Add, carry-and-drop interaction is live, every UI surface and console log is in English.

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
            └── simulatedAnneal → leaf messages → bfResults panel + auto-follow

BRUTE (scheduleBruteForceOpt)
    └── 1..N workers via new Worker('bruteforce-worker.js?v=…')
            ├── partition totalBranches across workers
            ├── per-worker resume state (bfSave v=2)
            └── stream leaf messages on every improvement
```

---

## Known limitations

- The cluster system covers linear Spinner-Repeater chains only. Bent/diagonal arrangements (enhancement #1) must be re-assembled by SA's per-component moves; this is slower for layouts that genuinely need a bend.
- SA workers do not synchronize their bests (enhancement #2). A worker stuck in a low local optimum cannot benefit from another worker's discovery in the same session.
- `bruteforce-worker.js` and `sa-worker.js` URLs in `app.js` are hard-coded with `?v=N` strings; the sed bump script must touch `app.js` as well as the three top-level files, or workers stall on a stale cached blob.

---

## Version history

| Version | Date | Change |
|---|---|---|
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

Total: **21** (after v=92 additions of `metal_scavenger`, `furnace`, `fuser_i`). Authoritative definitions live in `components.json` and must not be edited without explicit user request.

| Category | Components |
|---|---|
| infrastructure | wire |
| power | battery_1x1, battery_1x2, battery_2x2, bio_generator (3×3 self-contained), energy_cells |
| timing | pulser, spinner, repeater_2s, repeater_4s |
| processing | grabber, collector, decomposer, harvester, salvager, metal_scavenger, furnace, fuser_i |
| detection | sensor |
| bio | disposable_biocell, biocell |
