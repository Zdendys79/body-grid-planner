// src/optimizer/bus.js — Power propagation and wire pathfinding.
// Direction constants (SIDE_DELTA, OPPOSITE), BFS from buses to powered set,
// and findWirePath used by tryAddWires + the main-thread placement logic.

const SIDE_DELTA = { N:{dr:-1,dc:0}, S:{dr:1,dc:0}, E:{dr:0,dc:1}, W:{dr:0,dc:-1} };
const OPPOSITE   = { N:'S', S:'N', E:'W', W:'E' };

// BFS from buses to find all powered placement indices
function computePoweredSet(placements, gridRows, gridCols) {
  const portMap = new Map();
  placements.forEach((p, idx) => {
    p.rotatedPorts.forEach(({ cell, side }) => {
      const key = `${p.row+cell[0]},${p.col+cell[1]},${side}`;
      if (!portMap.has(key)) portMap.set(key, []);
      portMap.get(key).push(idx);
    });
  });

  const powered = new Set();
  const queue = [];

  // Seed: ports directly touching a bus
  placements.forEach((p, idx) => {
    p.rotatedPorts.forEach(({ cell, side }) => {
      const gr = p.row + cell[0], gc = p.col + cell[1];
      const onBus = (side === 'W' && gc === 0) || (side === 'S' && gr === gridRows - 1);
      if (onBus && !powered.has(idx)) {
        powered.add(idx);
        queue.push(idx);
      }
    });
  });

  // BFS: propagate through port-to-port connections
  while (queue.length) {
    const idx = queue.shift();
    const p = placements[idx];
    p.rotatedPorts.forEach(({ cell, side }) => {
      const gr = p.row + cell[0], gc = p.col + cell[1];
      const d = SIDE_DELTA[side];
      const adjKey = `${gr+d.dr},${gc+d.dc},${OPPOSITE[side]}`;
      if (portMap.has(adjKey)) {
        portMap.get(adjKey).forEach(adjIdx => {
          if (!powered.has(adjIdx)) {
            powered.add(adjIdx);
            queue.push(adjIdx);
          }
        });
      }
    });
  }

  // Bio port connections: bio-port-adjacent placements share power
  const bioPortMap = new Map();
  placements.forEach((p, idx) => {
    (p.rotatedBioPorts || []).forEach(({ cell, side }) => {
      const key = `${p.row+cell[0]},${p.col+cell[1]},${side}`;
      if (!bioPortMap.has(key)) bioPortMap.set(key, []);
      bioPortMap.get(key).push(idx);
    });
  });
  placements.forEach((p, idx) => {
    (p.rotatedBioPorts || []).forEach(({ cell, side }) => {
      const gr = p.row + cell[0], gc = p.col + cell[1];
      const d = SIDE_DELTA[side];
      const adjKey = `${gr+d.dr},${gc+d.dc},${OPPOSITE[side]}`;
      if (bioPortMap.has(adjKey)) {
        powered.add(idx);
        bioPortMap.get(adjKey).forEach(adjIdx => powered.add(adjIdx));
      }
    });
  });

  return powered;
}

// Priority 1: check connection to another powered component's port
function wouldConnectToComponent(rotatedPorts, row, col, placements, poweredSet) {
  const poweredPortKeys = new Set();
  placements.forEach((p, idx) => {
    if (!poweredSet.has(idx)) return;
    p.rotatedPorts.forEach(({ cell, side }) => {
      poweredPortKeys.add(`${p.row+cell[0]},${p.col+cell[1]},${side}`);
    });
  });
  for (const { cell, side } of rotatedPorts) {
    const gr = row + cell[0], gc = col + cell[1];
    const d = SIDE_DELTA[side];
    if (poweredPortKeys.has(`${gr+d.dr},${gc+d.dc},${OPPOSITE[side]}`)) return true;
  }
  return false;
}

// Priority 2: check direct bus connection
function wouldConnectToBus(rotatedPorts, row, col, gridRows, gridCols) {
  for (const { cell, side } of rotatedPorts) {
    const gr = row + cell[0], gc = col + cell[1];
    if ((side === 'W' && gc === 0) || (side === 'S' && gr === gridRows - 1)) return true;
  }
  return false;
}

// Combined check used by addComponent
function wouldBePowered(rotatedPorts, row, col, placements, poweredSet, gridRows, gridCols) {
  return wouldConnectToBus(rotatedPorts, row, col, gridRows, gridCols) ||
         wouldConnectToComponent(rotatedPorts, row, col, placements, poweredSet);
}

// findWirePath: BFS through free cells from the placement's port frontier
// outward toward power frontier (bus edge or existing powered-component port).
// Returns the cell sequence for the wire chain, or null if unreachable.
function findWirePath(rotatedShape, rotatedPorts, row, col, state) {
  const { grid, placements } = state;
  const poweredSet = computePoweredSet(placements, grid.rows, grid.cols);

  const occupied = new Set();
  placements.forEach(p => p.rotatedShape.forEach(([r,c]) => occupied.add(`${p.row+r},${p.col+c}`)));
  addPeripheralReserved(placements, occupied);
  rotatedShape.forEach(([r,c]) => occupied.add(`${row+r},${col+c}`));

  // Power frontier: empty cells where a wire would be immediately powered
  const powerFrontier = new Set();
  for (let r = 0; r < grid.rows; r++) {
    const k = `${r},0`;
    if (!occupied.has(k)) powerFrontier.add(k);
  }
  for (let c = 0; c < grid.cols; c++) {
    const k = `${grid.rows-1},${c}`;
    if (!occupied.has(k)) powerFrontier.add(k);
  }
  placements.forEach((p, idx) => {
    if (!poweredSet.has(idx)) return;
    p.rotatedPorts.forEach(({ cell, side }) => {
      const gr = p.row + cell[0], gc = p.col + cell[1];
      const d = SIDE_DELTA[side];
      const ar = gr + d.dr, ac = gc + d.dc;
      if (ar >= 0 && ar < grid.rows && ac >= 0 && ac < grid.cols) {
        const k = `${ar},${ac}`;
        if (!occupied.has(k)) powerFrontier.add(k);
      }
    });
  });

  // Target frontier: empty cells adjacent (outward) to the new component's ports
  const targetFrontier = new Set();
  for (const { cell, side } of rotatedPorts) {
    const gr = row + cell[0], gc = col + cell[1];
    const d = SIDE_DELTA[side];
    const ar = gr + d.dr, ac = gc + d.dc;
    if (ar >= 0 && ar < grid.rows && ac >= 0 && ac < grid.cols) {
      const k = `${ar},${ac}`;
      if (!occupied.has(k)) targetFrontier.add(k);
    }
  }

  if (targetFrontier.size === 0) return null;

  // Quick check: target-frontier cell that is also a power-frontier cell needs just 1 wire
  for (const t of targetFrontier) {
    if (powerFrontier.has(t)) return [t.split(',').map(Number)];
  }

  // BFS: from target frontier outward toward power frontier
  const visited = new Map();
  const queue = [];
  for (const t of targetFrontier) { visited.set(t, null); queue.push(t); }

  while (queue.length > 0) {
    const current = queue.shift();
    const [r, c] = current.split(',').map(Number);

    for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const nr = r+dr, nc = c+dc;
      if (nr < 0 || nr >= grid.rows || nc < 0 || nc >= grid.cols) continue;
      const k = `${nr},${nc}`;
      if (occupied.has(k) || visited.has(k)) continue;

      visited.set(k, current);

      if (powerFrontier.has(k)) {
        const path = [k];
        let p = visited.get(k);
        while (p !== null) { path.push(p); p = visited.get(p); }
        return path.map(s => s.split(',').map(Number));
      }

      queue.push(k);
    }
  }

  return null;
}
