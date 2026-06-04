// src/optimizer/validate.js — Layout validation and wire-bridging.
// Shared by main thread and worker. Reads `componentLib` as a global
// (defined in app.js or set on worker init).

// Returns true if layout is fully valid:
//   - every energy component is powered (connected to bus/powered chain)
//   - every Spinner has required Repeaters adjacent (only when Repeaters exist)
//   - every Repeater connects (port-match) to at least one Spinner OR Pulser
//   - Pulsers do not require Repeaters
function isLayoutValid(placements, grid) {
  const poweredSet  = computePoweredSet(placements, grid.rows, grid.cols);
  const workingSet  = computeWorkingSet(placements);
  const hasRepeaters = placements.some(p =>
    p.componentId === 'repeater_4s' || p.componentId === 'repeater_2s'
  );

  // Pre-build set of Spinner+Pulser port keys for Repeater "useful-target" check
  let targetPortKeys = null;
  if (hasRepeaters) {
    targetPortKeys = new Set();
    for (const p of placements) {
      if (p.componentId !== 'spinner' && p.componentId !== 'pulser') continue;
      for (const port of (p.rotatedPorts || [])) {
        targetPortKeys.add(`${p.row+port.cell[0]},${p.col+port.cell[1]},${port.side}`);
      }
    }
  }

  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    if (p.componentId === 'wire') continue;
    const def = componentLib.find(d => d.id === p.componentId);
    if (!def) continue;
    if (def.energyPorts.length > 0 && !poweredSet.has(i)) return false;
    if (p.componentId === 'spinner' && hasRepeaters && !workingSet.has(i)) return false;
    if (p.componentId === 'repeater_2s' || p.componentId === 'repeater_4s') {
      let connected = false;
      for (const port of (p.rotatedPorts || [])) {
        const gr = p.row + port.cell[0], gc = p.col + port.cell[1];
        const d = SIDE_DELTA[port.side];
        const adjKey = `${gr + d.dr},${gc + d.dc},${OPPOSITE[port.side]}`;
        if (targetPortKeys.has(adjKey)) { connected = true; break; }
      }
      if (!connected) return false;
    }
  }
  return true;
}

// For each unpowered energy component in a brute-force candidate layout, tries
// to find a wire path connecting it to the bus or an already-powered component.
// Returns the layout augmented with wires, or null if any component can't be
// connected.
function tryAddWires(placements, grid) {
  const wireDef = componentLib.find(d => d.id === 'wire');
  if (!wireDef) return null;

  // Work on a copy so we don't mutate the generator's array
  let current = placements.map((p, i) => ({ ...p, id: i + 1 }));

  // Each iteration powers one more component; loop until all are powered or we give up
  const maxIter = placements.filter(p => {
    const def = componentLib.find(d => d.id === p.componentId);
    return def && def.energyPorts.length > 0;
  }).length + 1;

  for (let iter = 0; iter < maxIter; iter++) {
    const poweredSet = computePoweredSet(current, grid.rows, grid.cols);
    let foundUnpowered = false;

    for (let i = 0; i < current.length; i++) {
      const p = current[i];
      if (p.componentId === 'wire') continue;
      const def = componentLib.find(d => d.id === p.componentId);
      if (!def || def.energyPorts.length === 0) continue;
      if (poweredSet.has(i)) continue;

      foundUnpowered = true;
      const path = findWirePath(p.rotatedShape, p.rotatedPorts, p.row, p.col, { grid, placements: current });
      if (!path || path.length === 0) return null;

      path.forEach(([r, c]) => {
        current.push({
          id: current.length + 1,
          componentId: 'wire',
          row: r, col: c, rotation: 0,
          rotatedShape: [[0, 0]],
          rotatedPorts: wireDef.energyPorts.map(ep => ({ cell: [...ep.cell], side: ep.side })),
          rotatedBioPorts: [],
          rotatedPeripheral: null,
          autoPlaced: true
        });
      });
      break;
    }

    if (!foundUnpowered) return current;
  }

  return null;
}
