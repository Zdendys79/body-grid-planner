# Body Grid Planner

Web app for optimizing component placement on a body grid. Independent fan project for the indie game **IDLE_DIRECTIVE** by [kevinfu510](https://kevinfu510.itch.io/) — see Help → About the game & credits in the app for details.

**URL:** `https://body-grid-planner.zdendys79.website`
**Files:** `/var/www/html/body_grid_planner/`
**GitHub:** `https://github.com/Zdendys79/body-grid-planner`

---

## What it does

Place power-, processing- and bio-components on a finite rectangular grid so that:

- every energy component is powered (port-to-port chain that reaches a bus edge),
- every Spinner has its required Repeater adjacency,
- every Repeater is wired to at least one Spinner or Pulser,
- wires are routed automatically (and minimized),
- free-space connectivity is maximized for future additions.

Solver: **SMART (Simulated Annealing)** — runs in 1–6 Web Workers and keeps searching until you press STOP. Small layouts (10–20 components) typically improve within seconds. Mid-size layouts (25–35) may need a few minutes to settle. **Dense grids with 35+ components, or layouts that are already near optimum, can run for hours without a significant improvement** — that's normal SA behaviour, not a bug. The Top-20 panel streams every improvement as soon as a worker finds it, so you can watch progress live and stop whenever you're satisfied.

**Tip:** leave a little free space on the grid. A grid packed to 95 %+ leaves SA almost no room to swap or shift components, so it gets stuck in the local minimum your seed started in. Expanding the body by one step (▣ EXPAND BODY SPACE) often unlocks dramatically better layouts.

A separate **RE-OPTIMIZE LAYOUT** button runs a synchronous single-pass greedy when you want a deterministic tidy-up — 1–2 seconds regardless of component count.

## Privacy

This tool **sends nothing to any server** and **collects no information about you**. It loads the page from Apache once, then everything — your layout, the Top-20 results panel, the thread-count setting, the RE-OPTIMIZE debug stats — lives in your browser's `localStorage` and never leaves your machine. No analytics, no cookies, no tracking pixels, no third-party scripts. The optimizer's Web Workers run locally in your browser. Clearing your browser's site data wipes everything.

---

## Architecture

| File / Dir | Role |
|---|---|
| `index.html` | HTML shell; script tags carry the `?v=N` cache buster |
| `styles.css` | Layout, color tokens, modal + carry-mode CSS |
| `components.json` | Component definitions (shape, ports, colors) — **authoritative**, never edit without an explicit request |
| `app.js` | Entry point: state, init, carry-mode, SA dispatcher, results panel, `stopOptimization` helper |
| `renderer.js` | SVG grid renderer (cells, ports, glow, glyphs) |
| `optimizer.js` | `findBestPlacement` (greedy + hard constraints + the four `getXConnectionBonus` amplifier-family helpers) and `findAnyPlacement` (geometry only) |
| `sa-worker.js` | SA worker entry; loads `src/*` via `importScripts` |
| `src/constants.js` | `STATE_KEY`, `SETTINGS_KEY`, `MAX_THREADS` |
| `src/optimizer/rotation.js` | `rotateComponent`, `rotateCoord`, `rotateSide`, `getUniqueDegs` (shape + port aware) |
| `src/optimizer/bus.js` | `SIDE_DELTA`, `OPPOSITE`, `computePoweredSet`, `findWirePath` |
| `src/optimizer/placement.js` | `getOccupiedMap`, `hasOverlap`, `fitsInGrid`, `addPeripheralReserved` |
| `src/optimizer/score.js` | `computeFreeSpaceQuality`, `computeWorkingSet`, `scoreLayout` |
| `src/optimizer/validate.js` | `isLayoutValid`, `tryAddWires` |
| `src/sa/shell.js` | Shell-packing heuristic for the SA seed |
| `src/sa/moves.js` | `saShiftMove`/`saRotateMove`/`saSwapMove`/`saRelocateMove`/`saChainTranslate`/`saChainRotate` + bias profiles |
| `src/sa/clusters.js` | Spinner-Repeater chain pre-baking (`buildClusterDef`, `_precomputeRotationVariants`) |
| `src/sa/greedy.js` | `buildShellThenGreedy`, `buildGreedyInitial`, `perturbInitial` |
| `src/sa/annealer.js` | Main `simulatedAnneal` loop with Metropolis acceptance |
| `src/ui/settings.js` | Settings modal: thread-count slider, `scoreLayout` weight tuning with live per-signal % bars, system reset |
| `src/ui/export.js` | Cross-machine layout transfer (base64 bundle), save-modal handlers |
| `src/ui/debug-stats.js` | Local RE-OPTIMIZE before/after stats (v=123), exported as a base64 bundle via the same save-modal |

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
- every Repeater is port-adjacent to at least one Spinner or Pulser,
- every Biocell / Disposable Biocell (v=144) is port-adjacent to a Bio Generator (`bio_generator` or `bio_generator_ii`). They have normal electrical ports — not a separate `bioPorts` concept, which turned out not to correspond to any real game mechanic — but only function plugged directly into a generator.

### `findBestPlacement`
Greedy scorer for a single new component, used by both "add one component" and RE-OPTIMIZE (which calls it once per component in priority order):
1. Reserves cells already occupied by other components **and** by their peripherals.
2. Tries every unique rotation × every grid position.
3. Hard rejects: Spinner without room for its Repeater, Repeater without a non-working Spinner target, Biocell/Disposable Biocell not port-adjacent to a Bio Generator.
4. Scores ports against the bus, computes a wire path back to a powered cell, ranks by `quality − wires + workingBonus + amplifierBonus`. Four `getXConnectionBonus` helpers (v=120 for Power Amplifier, v=147 for the other three) each mirror their `computeXBonus` counterpart in `scoreLayout` — same weights, same port-matching logic — so RE-OPTIMIZE and SMART agree on the incentive to connect: `getAmplifierConnectionBonus` (Power Amplifier↔Harvester/Salvager), `getBatteryAmplifierConnectionBonus` (Battery Amplifier↔any battery, area-scaled), `getEnergyAmplifierConnectionBonus` (Energy Amplifier↔Bio Generator/Energy Cells/Spinner/Pulser, per-target weight), `getConcentratorConnectionBonus` (Concentrator↔Energy Cells, counted per distinct connected block — v=148, see below).

If no wire-aware position fits, `findAnyPlacement` falls back to any non-overlapping geometric fit (no wire routing). Existing components are **never** rearranged when adding a new one — that is the role of the explicit RE-OPTIMIZE button. After placement, `addComponent` (v=125) re-runs `tryAddWires` over the whole layout — `findBestPlacement` only wires up the component just added, so this catches any other already-placed component that's now one hop from power thanks to the addition. Positions are never touched, only auto-placed wire cells are added.

### Carry-mode interaction
Click a placed component to lift it (wires drop). Mouse moves the ghost (pixel-precise within ±5 px of cell center, otherwise grid-snapped). `R` rotates through unique orientations. Click on the grid to drop; bounds + collision (including peripherals) are validated, wires recompute. `Delete` key or the floating 🗑 button discards the carried component and recomputes wires for the rest. `Esc` cancels and restores the original position with wires.

### scoreLayout signals
`scoreLayout` is the single number SA and the synchronous greedy share. Ten contributions (thirteen weights — the Energy Amplifier bonus alone splits into four), biggest first at default weights, all player-tunable in Settings → "Layout scoring weights" (v=117), persisted in `localStorage[SETTINGS_KEY]`, reset via a dedicated button:
- `workingSet.size × weights.workingSet` (default 2650000) — every working Spinner is the most valuable atom.
- `computeBatteryAmplifierBonus` (v=135) — `weights.batteryAmplifier` (default 1000000) per port-to-port connection between a Battery Amplifier and an adjacent battery (any `battery_*` id except itself), **multiplied by that battery's cell count** — a 4-cell battery is worth 4× a 1-cell one. Optional, purely an SA incentive.
- `computeEnergyAmplifierBonus` (v=136, split into per-target weights v=137) returns per-target-type connection counts between an Energy Amplifier and an adjacent energy producer, each with its own weight (default 3000000 each) so the four producer types can be valued independently: `weights.energyAmpBioGen` (Bio Generator / Bio Generator (II)), `weights.energyAmpEnergyCells` (Energy Cells), `weights.energyAmpSpinner` (Spinner — independent of its separate Repeater working-set requirement), `weights.energyAmpPulser` (Pulser). Flat per connection, not scaled by size. Optional, purely an SA incentive.
- `computeAmplifierBonus` (v=119) — `weights.amplifier` (default 4000000) per port-to-port connection between a Power Amplifier and an adjacent Harvester or Salvager. Optional, unlike Repeater↔Spinner — not required for layout validity, purely an SA incentive.
- `computeConcentratorBonus` (v=140) — `weights.concentrator` (default 3000000) per port-to-port connection between a Concentrator and an adjacent Energy Cells block. Flat per connection, but — unlike the other amplifiers — counted **per port**, not per component pair: the Concentrator's 8 outward ports can land 2 simultaneous connections against the same Energy Cells block, and both score. Optional, purely an SA incentive.
- `computeFreeBlockBonus` (v=128) returns two independently-weighted totals from the same per-window scan over every all-free rectangle of selected sizes (table escalates 200 for 2×2 → 25000 for 4×4 → 60000 for 5×5; overlap is intentional so larger free areas grow super-linearly without explicit max-rectangle dedup):
  - `.free × weights.freeBlock` (default multiplier 1) — every window that's accessible: at least one cell on the W/S bus **or** fed by a placed component's port.
  - `.bus × weights.busAccess` (default multiplier 1) — the SAME base bonus again, but only for windows that touch the W (col 0) or S (row R−1) bus **directly**, where a future component needs no wire at all. Separate from `freeBlock` so bus proximity can be valued independently instead of via one hardcoded ×2 multiplier (pre-v=128 behaviour).
- `wires × −weights.wirePenalty` (default 5000) — penalty per auto-routed wire cell.
- `quality × weights.quality` (default 15000) — per-cell free-neighbour count, fine-grained connectivity of remaining free cells.
- `computeClusterBonus` (v=107) — `weights.cluster` (default 50000) per same-type neighbour pair, doubled if also port-to-port connected. Spinners, Repeaters and wires are excluded.

`setScoreWeights`/`getScoreWeights` (`src/optimizer/score.js`) hold the live values each JS context reads. The main thread sets them directly from persisted settings; each SA worker gets its own copy via the `init` message's `scoreWeights` field, since threads share no memory.

### SA (Simulated Annealing) pipeline
Per worker:
1. **Seed.** Accept the user layout if it is structurally sane (in bounds, no overlap). Otherwise run a multi-strategy chain: cluster-substituted shell+greedy → no-cluster shell+greedy → pure greedy. First strategy that places all components wins; if none does, the worker posts an error.
2. **Perturb.** Worker-specific perturbation count (0–25 random moves) to spread the population.
3. **Anneal.** Metropolis acceptance with worker-specific cooling rate and restart-after threshold. `tStart`/`tEnd` (v=141) are computed from the current dominant score weight (`scheduleAnnealOpt` in `app.js`) rather than hardcoded, so the Metropolis acceptance `exp(-delta/T)` stays meaningful whatever the weights are tuned to — a temperature scaled for small weights makes `exp(-delta/T)` collapse to ~0 for any real move once weights are large, turning SA into pure hill-climbing that can't escape local optima. Best valid layouts stream out as `leaf` messages.

### Cluster system (SA only)
Spinner-Repeater chains are pre-baked as synthetic components (`cluster_An` = n Spinners + (n-1) `repeater_2s`, linear horizontal). All 4 rotations are precomputed via `_precomputeRotationVariants`, so SA's relocate-move places clusters as atoms and never needs to rebuild adjacency.

### saChainMove
For workers that operate on individual S+R (no clusters) `saChainTranslate` / `saChainRotate` detect connected Spinner-Repeater subgraphs via port adjacency BFS and move the whole chain as a unit. Weight is 10% of moves in most profiles, 20% in the `jump` profile.

---

## Design notes (parked, not implemented)

### Battery (1x3) vs Battery (2x2) efficiency

Raw game capacity density favors 2x2 (750/cell/level vs 667/cell/level for 1x3), but `components.json` carries no `capacity` field — `scoreLayout` only sees geometry (ports, wires, free space), not in-game capacity value. Under that geometric scoring, 1x3 comes out well ahead in practice:

- 1x3 has ports on both short ends (W+E) — a row of them chains port-to-port for free, no wires needed between units.
- 2x2 has a single corner port — each unit can connect to only one neighbor, so chaining more than one requires a wire per junction (`wires × −5000` in `scoreLayout`), which dwarfs the 12% raw density advantage.
- The aesthetic cluster bonus (v=107, same-type neighbours +100) also stacks along a 1x3 row but not around isolated 2x2s.

Net: SA will favor 1x3 chains over 2x2 farms by a wider margin than the raw capacity numbers alone suggest. Not acted on — `capacity`/`level` could be added to `components.json` and scored directly if this ever needs to be modeled precisely instead of via geometric proxies.

---

## Running locally (without a web server)

Download or clone the repository and open `index.html` directly in your browser — no server required.

Two pre-generated files (`components-data.js`, `sa-worker-bundle.js`) make this possible: they inline the component definitions and the full SA worker code so the browser never needs to `fetch()` or spawn a Worker from a `file://` URL.

After any change to source files, regenerate them with:

```bash
node build.js
```

Files that trigger a rebuild:

| Changed file | Rebuild needed |
|---|---|
| `components.json` | yes |
| `src/*.js`, `optimizer.js`, `sa-worker.js` | yes |
| `app.js`, `renderer.js`, `styles.css`, `index.html` | no |

The generated files are committed to the repository, so end users who just download the ZIP can open `index.html` immediately without running anything.

---

## Cache buster

Every script in `index.html`, the worker `importScripts` call and the `new Worker('sa-worker.js?v=N')` URL in `app.js` must carry the same `?v=N` after any code change. The sed bump script touches: `index.html`, `sa-worker.js`, `app.js`.

Current version: **v=150**

---

## Development rules

- `components.json` is authoritative — never edit ports, shape or colors without an explicit user request.
- Debug connectivity bugs by inspecting `computePoweredSet` / `computeWorkingSet` output for the failing layout, not by tweaking port definitions.
- Layout validation belongs in `isLayoutValid`, not in scoring tricks.
- Adding a component must not rearrange existing placements (user-crafted layouts are sacred).
- When changing the SA protocol, bump the cache buster and update the worker URL version in `app.js`.
- Run `node --check` on any touched `.js` before committing — the syntax errors surface late otherwise.
