# Idle Directive – Body Optimizer

Web app for optimizing component placement on a body grid.

**URL:** `https://idle-directive.zdendys79.website`
**Files:** `/var/www/html/idle_directive/`
**GitHub:** `https://github.com/Zdendys/idle-directive`

---

## What it does

Place power-, processing- and bio-components on a finite rectangular grid so that:

- every energy component is powered (port-to-port chain that reaches a bus edge),
- every Spinner has its required Repeater adjacency,
- every Repeater is wired to at least one Spinner or Pulser,
- wires are routed automatically (and minimized),
- free-space connectivity is maximized for future additions.

Two solvers reach a valid layout:

- **SMART (Simulated Annealing)** — primary, ~10 seconds for a 35-component grid.
- **BRUTE (depth-first search)** — exhaustive, hours-to-days for ≥ 20 components.

Both run in Web Workers (up to 6 threads, configurable). Results stream into a Top-20 panel and the best one snaps onto the grid via "auto-follow".

---

## Architecture

| File / Dir | Role |
|---|---|
| `index.html` | HTML shell; script tags carry the `?v=N` cache buster |
| `styles.css` | Layout, color tokens, modal + carry-mode CSS |
| `components.json` | Component definitions (shape, ports, colors) — **authoritative**, never edit without an explicit request |
| `app.js` | Entry point: state, init, carry-mode interaction, SA/BF dispatchers, result panel, modals |
| `renderer.js` | SVG grid renderer (cells, ports, glow, glyphs) |
| `optimizer.js` | Legacy module with `findBestPlacement` (greedy, hard-constraint-aware) and `findAnyPlacement` (geometry only) |
| `bruteforce-worker.js` | BF worker entry; loads `src/*` via `importScripts` |
| `sa-worker.js` | SA worker entry; same loader pattern |
| `src/constants.js` | localStorage keys, MAX_THREADS, side index |
| `src/optimizer/rotation.js` | `rotateComponent`, `rotateCoord`, `rotateSide`, `getUniqueDegs` (shape + port aware) |
| `src/optimizer/bus.js` | `SIDE_DELTA`, `OPPOSITE`, `computePoweredSet`, `findWirePath` |
| `src/optimizer/placement.js` | `getOccupiedMap`, `hasOverlap`, `fitsInGrid`, `addPeripheralReserved` |
| `src/optimizer/score.js` | `computeFreeSpaceQuality`, `computeWorkingSet`, `scoreLayout` |
| `src/optimizer/validate.js` | `isLayoutValid`, `tryAddWires` |
| `src/bruteforce/generator.js` | Shared `bruteForcePlacements` (DFS with prunings) |
| `src/bruteforce/save.js` | v=2 multi-worker save format, export/import bundle (base64) |
| `src/sa/shell.js` | Shell-packing heuristic for the SA seed |
| `src/sa/moves.js` | `saShiftMove`/`saRotateMove`/`saSwapMove`/`saRelocateMove`/`saChainTranslate`/`saChainRotate` + bias profiles |
| `src/sa/clusters.js` | Spinner-Repeater chain pre-baking (`buildClusterDef`, `_precomputeRotationVariants`) |
| `src/sa/greedy.js` | `buildShellThenGreedy`, `buildGreedyInitial`, `perturbInitial` |
| `src/sa/annealer.js` | Main `simulatedAnneal` loop with Metropolis acceptance |
| `src/ui/settings.js` | Settings modal: thread-count slider, export/import buttons, system reset |

---

## Key concepts

### Coordinate system
Grid `rows × cols`, (0,0) = top-left corner.
**Bus:** the W edge (left of col 0) and the S edge (below row R-1). Components with a W port at col 0 or an S port at row R-1 are powered for free.

### Powering — `computePoweredSet`
BFS rooted at the buses, walking port-to-port: a port at `(r,c)` facing `side` looks at `(r+dr, c+dc)` for a port facing `OPPOSITE(side)`.

### Spinner working state — `computeWorkingSet`
A Spinner is working if:
- it has an adjacent `repeater_2s` on **any** side, **or**
- it has an adjacent `repeater_4s` on **at least 2 distinct** sides.

Pulsers do not require Repeaters.

### Layout validity — `isLayoutValid`
A layout is valid when **all** of:
- every energy-bearing component is powered,
- every Spinner is working (if any Repeater exists in the layout),
- every Repeater is port-adjacent to at least one Spinner or Pulser.

### `findBestPlacement`
Greedy scorer for a single new component:
1. Reserves cells already occupied by other components **and** by their peripherals.
2. Tries every unique rotation × every grid position.
3. Hard rejects: Spinner without room for its Repeater, Repeater without a non-working Spinner target.
4. Scores ports against the bus, computes a wire path back to a powered cell, ranks by `quality − wires + workingBonus`.

If no wire-aware position fits, `findAnyPlacement` falls back to any non-overlapping geometric fit (no wire routing). Existing components are **never** rearranged when adding a new one — that is the role of the explicit RE-OPTIMIZE button.

### Carry-mode interaction
Click a placed component to lift it (wires drop). Mouse moves the ghost (pixel-precise within ±5 px of cell center, otherwise grid-snapped). `R` rotates through unique orientations. Click again to drop; bounds + collision (including peripherals) are validated, wires recompute. `Esc` cancels and restores the original position with wires.

### SA (Simulated Annealing) pipeline
Per worker:
1. **Seed.** Accept the user layout if it is structurally sane (in bounds, no overlap). Otherwise run a multi-strategy chain: cluster-substituted shell+greedy → no-cluster shell+greedy → pure greedy. First strategy that places all components wins; if none does, the worker posts an error.
2. **Perturb.** Worker-specific perturbation count (0–25 random moves) to spread the population.
3. **Anneal.** Metropolis acceptance with worker-specific cooling rate and restart-after threshold. Best valid layouts stream out as `leaf` messages.

### Brute force pipeline
DFS over depth-1 branch slices, distributed across N workers. Prunings: occupancy, peripheral reservation, cell budget, bus reachability (BFS), unique rotations only, Repeater→target match. Resume is persisted as `bfSave` v=2 (per-worker `branchRange` + `currentBranchIdx` + `path`).

### Cluster system (SA only)
Spinner-Repeater chains are pre-baked as synthetic components (`cluster_An` = n Spinners + (n-1) `repeater_2s`, linear horizontal). All 4 rotations are precomputed via `_precomputeRotationVariants`, so SA's relocate-move places clusters as atoms and never needs to rebuild adjacency.

### saChainMove
For workers that operate on individual S+R (no clusters) `saChainTranslate` / `saChainRotate` detect connected Spinner-Repeater subgraphs via port adjacency BFS and move the whole chain as a unit. Weight is 10% of moves in most profiles, 20% in the `jump` profile.

---

## Cache buster

Every script in `index.html`, both worker `importScripts` calls and the two `new Worker('…?v=N')` URLs in `app.js` must carry the same `?v=N` after any code change. The sed bump script touches: `index.html`, `bruteforce-worker.js`, `sa-worker.js`, `app.js`.

Current version: **v=93**

---

## Development rules

- `components.json` is authoritative — never edit ports, shape or colors without an explicit user request.
- Debug connectivity bugs by inspecting `computePoweredSet` / `computeWorkingSet` output for the failing layout, not by tweaking port definitions.
- Layout validation belongs in `isLayoutValid`, not in scoring tricks.
- Adding a component must not rearrange existing placements (user-crafted layouts are sacred).
- When changing the SA or BF protocol, bump the cache buster and update worker URL versions in `app.js`.
- Run `node --check` on any touched `.js` before committing — the syntax errors surface late otherwise.
