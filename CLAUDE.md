# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Language

All code, variable names, comments, and text in every `.md` file must be in **English**. Czech is used for conversation only.

## What this is

A static single-page app for optimizing component placement on the body/inventory grid in the indie game IDLE_DIRECTIVE. No build step, no package manager. All code runs in the browser; the SA optimizer runs in Web Workers.

**Live URL:** `https://body-grid-planner.zdendys79.website`
**Files served from:** `/var/www/html/body_grid_planner/`

## Syntax check

Before committing any `.js` change:
```bash
node --check app.js
node --check renderer.js
node --check optimizer.js
node --check sa-worker.js
node --check src/constants.js
# ...etc. for every touched file
```

There is no bundler, linter config, or test suite.

## Cache buster — critical

Every script loaded in `index.html`, every `importScripts(...)` call in `sa-worker.js`, and the `new Worker('sa-worker.js?v=N')` URL in `app.js` **must all share the same `?v=N`**. After any code change, bump the version number in all three places. The current version is the number in `sa-worker.js` line 1–30.

## Architecture

| File | Role |
|---|---|
| `index.html` | HTML shell + all `<script>` tags with `?v=N` cache busters |
| `styles.css` | All CSS: layout, color tokens, modals, carry-mode |
| `components.json` | **Authoritative** component definitions (shape, ports, colors). Never edit without explicit request |
| `app.js` | Entry point: global state, `init`, carry-mode interaction, SA dispatcher, Top-20 results panel, `stopOptimization` |
| `renderer.js` | SVG grid renderer — cells, ports, glow, glyphs |
| `optimizer.js` | `findBestPlacement` (wire-aware greedy) and `findAnyPlacement` (geometry-only fallback) |
| `sa-worker.js` | Web Worker entry point; loads all `src/*` modules via `importScripts` |
| `src/constants.js` | `STATE_KEY`, `SETTINGS_KEY`, `MAX_THREADS` |
| `src/optimizer/rotation.js` | Shape + port rotation, `getUniqueDegs` |
| `src/optimizer/bus.js` | `computePoweredSet`, `findWirePath`, `SIDE_DELTA`, `OPPOSITE` |
| `src/optimizer/placement.js` | Overlap, bounds, peripheral reservation checks |
| `src/optimizer/score.js` | `scoreLayout` — the single number SA and greedy both optimize |
| `src/optimizer/validate.js` | `isLayoutValid`, `tryAddWires` |
| `src/sa/shell.js` | Shell-packing heuristic used as SA seed |
| `src/sa/moves.js` | All SA move types + worker bias profiles |
| `src/sa/clusters.js` | Pre-baked linear Spinner-Repeater cluster atoms |
| `src/sa/greedy.js` | Greedy seed builders and `perturbInitial` |
| `src/sa/annealer.js` | Metropolis acceptance loop (`simulatedAnneal`) |
| `src/ui/settings.js` | Settings modal: thread-count slider, system reset |
| `src/ui/export.js` | Cross-machine base64 layout transfer, save-modal handlers |

`src/*` modules are loaded only in `sa-worker.js` (not in `index.html`) because the main thread needs `optimizer.js` + `renderer.js` + `app.js`; workers need the full `src/` stack.

## Key invariants

- **`stopOptimization()` must be called** before any layout-mutating action (add/remove/expand/import/carry-drop/delete). It bumps `bgOptId` so stale worker messages self-discard, and it terminates running SA workers.
- **`components.json` is sacred** — ports, shapes, and colors define game correctness. Debug connectivity bugs via `computePoweredSet` / `computeWorkingSet`, not by editing component definitions.
- **Adding a component never rearranges existing placements.** `findBestPlacement` / `findAnyPlacement` only places the new one. Rearrangement is the explicit RE-OPTIMIZE button only.
- **Layout validity** (`isLayoutValid`) requires: every energy-bearing component is powered, every Spinner is working (if any Repeater exists), every Repeater is port-adjacent to at least one Spinner or Pulser.
- **`scoreLayout` signals** (biggest first): `workingSet × 50000` → `computeFreeBlockBonus` (powered free rectangles, super-linear) → `wires × −5000` → `quality × 4`.

## Coordinate system

`rows × cols`, `(0,0)` = top-left. **Bus** = left edge (W, col 0) and bottom edge (S, row R-1). A port at col 0 facing W, or at row R-1 facing S, is powered for free.

## SA worker protocol

```
Main → Worker:
  {type:'init', componentLib}               → 'ready'
  {type:'start', nonWireIds, grid, options, workerId}
  {type:'stop'}
Worker → Main:
  {type:'ready'}
  {type:'progress', workerId, iter, T, currentCost, bestCost, bestValidCost, elapsedMs}
  {type:'leaf', workerId, layout, score, isFirst}   ← valid layout improvement
  {type:'stopped', workerId}
  {type:'error', message}
```

## Deployment

No deploy script — a `git push` to `origin/main` triggers the remote hook which copies files to the Apache document root. Verify via cache-buster version in browser devtools network tab after push.
