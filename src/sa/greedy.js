// src/sa/greedy.js — Build the SA initial state via greedy placement.
//
// The user's current grid state may be dense and invalid (Re-Optimize gone wrong
// or hand-placed). Using it directly as SA seed often leaves SA stuck — moves
// can't break overlaps and dense grids reject everything. So instead we
// reconstruct a valid layout from scratch using the same greedy algorithm as
// the RE-OPTIMIZE button: findBestPlacement with energy-aware scoring.
//
// Returns non-wire placements only (SA operates on those; wires are computed
// at cost-evaluation time via tryAddWires).

const _SA_REP_IDS = new Set(['repeater_2s', 'repeater_4s']);

function _saComponentOrder(ids) {
  const bioOnlySet = new Set(
    componentLib
      .filter(d => d.energyPorts.length === 0 && (d.bioPorts || []).length > 0)
      .map(d => d.id)
  );
  const spinnerSet = new Set(['spinner', 'pulser']);

  const bioOnly  = ids.filter(id => bioOnlySet.has(id));
  const reps     = ids.filter(id => _SA_REP_IDS.has(id));
  const spinners = ids.filter(id => spinnerSet.has(id));
  const others   = ids.filter(id => !bioOnlySet.has(id) && !_SA_REP_IDS.has(id) && !spinnerSet.has(id));

  // Interleave Rep → Spin → Rep → Spin — pairs Repeaters with Spinners as
  // they're placed, satisfying the adjacency constraint inline.
  const interleaved = [];
  while (reps.length || spinners.length) {
    if (reps.length)     interleaved.push(reps.shift());
    if (spinners.length) interleaved.push(spinners.shift());
  }
  return [...others, ...interleaved, ...bioOnly];
}

function buildGreedyInitial(componentIds, grid, prefilledPlacements = []) {
  const ordered = _saComponentOrder([...componentIds]);
  const wireDef = componentLib.find(d => d.id === 'wire');
  const fakeState = {
    grid: { ...grid },
    placements: prefilledPlacements.slice(),
    nextId: prefilledPlacements.length + 1
  };

  for (const id of ordered) {
    const def = componentLib.find(d => d.id === id);
    if (!def) continue;
    const result = findBestPlacement(def, fakeState);
    if (!result) {
      // findBestPlacement is constraint-aware; if it fails, try any geometric fit
      const anyFit = _saFindAnyFit(def, fakeState);
      if (!anyFit) continue;
      fakeState.placements.push({
        id: fakeState.nextId++, componentId: id,
        row: anyFit.row, col: anyFit.col, rotation: anyFit.rotation,
        rotatedShape: anyFit.rotatedShape,
        rotatedPorts: anyFit.rotatedPorts,
        rotatedBioPorts: anyFit.rotatedBioPorts,
        rotatedPeripheral: anyFit.rotatedPeripheral
      });
      continue;
    }

    // Add wire path produced by findBestPlacement
    (result.wirePath || []).forEach(([r, c]) => {
      if (!wireDef) return;
      fakeState.placements.push({
        id: fakeState.nextId++, componentId: 'wire',
        row: r, col: c, rotation: 0,
        rotatedShape: [[0,0]],
        rotatedPorts: wireDef.energyPorts.map(p => ({ cell: [...p.cell], side: p.side })),
        rotatedBioPorts: [],
        rotatedPeripheral: null, autoPlaced: true
      });
    });
    fakeState.placements.push({
      id: fakeState.nextId++, componentId: id,
      row: result.row, col: result.col, rotation: result.rotation,
      rotatedShape: result.rotatedShape, rotatedPorts: result.rotatedPorts,
      rotatedBioPorts: result.rotatedBioPorts || [],
      rotatedPeripheral: result.rotatedPeripheral
    });
  }

  // SA wants non-wires only — it'll rebuild wires every cost evaluation
  return fakeState.placements.filter(p => p.componentId !== 'wire');
}

// Fallback: place a component at any non-overlapping position with any rotation
function _saFindAnyFit(def, state) {
  const occupiedMap = getOccupiedMap(state.placements);
  for (const deg of getUniqueDegs(def)) {
    const { shape, energyPorts, bioPorts } = rotateComponent(def, deg);
    const bounds = getBounds(shape);
    if (bounds.height > state.grid.rows || bounds.width > state.grid.cols) continue;
    for (let row = 0; row <= state.grid.rows - bounds.height; row++) {
      for (let col = 0; col <= state.grid.cols - bounds.width; col++) {
        if (hasOverlap(shape, row, col, occupiedMap)) continue;
        return {
          row, col, rotation: deg,
          rotatedShape: shape,
          rotatedPorts: energyPorts,
          rotatedBioPorts: bioPorts,
          rotatedPeripheral: buildRotatedPeri(def, deg)
        };
      }
    }
  }
  return null;
}

// Apply N random valid moves to give workers structurally diverse starting points.
// Each worker calls perturbInitial(state, N) where N depends on workerId.
function perturbInitial(initial, grid, perturbCount) {
  let current = initial.map(p => ({ ...p }));
  let applied = 0;
  let attempts = 0;
  while (applied < perturbCount && attempts < perturbCount * 50) {
    attempts++;
    const next = saGenerateMove(current, grid);
    if (next) { current = next; applied++; }
  }
  return current;
}

// Two-phase seed: pack a shell along the bus-free N+E edges first, then
// greedily fill the interior with the remaining components. This is the
// user's idea — the shell creates an outer scaffold whose inward-facing
// ports become the connection points for the interior. Greedy fill then
// uses findBestPlacement (with the shell as obstacles), so interior
// components naturally cluster near the W/S bus.
function buildShellThenGreedy(nonWireIds, grid) {
  const { shellPlacements, remaining } = packShell(nonWireIds, grid);
  // Shell components were placed by packShell — bring them in as prefilled
  // and greedy-place the rest with shell visible as obstacles.
  const all = buildGreedyInitial(remaining, grid, shellPlacements);
  return all;
}
