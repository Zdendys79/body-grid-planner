// src/sa/moves.js — Neighborhood move operators for Simulated Annealing.
// All operators take the current non-wire placement list and return a NEW
// list (or null if the move can't be applied). Wires are recomputed after
// each accepted move via tryAddWires.

// ── Helpers ─────────────────────────────────────────────────────────────────

// Absolute grid cells occupied by a placement's peripheral (e.g. Biocell for
// Bio Generator). Empty array if the component has no peripheral.
function _saPeripheralCells(p) {
  if (!p.rotatedPeripheral) return [];
  const peri = p.rotatedPeripheral;
  const d = SIDE_DELTA[peri.port.side];
  const startR = p.row + peri.port.cell[0] + d.dr;
  const startC = p.col + peri.port.cell[1] + d.dc;
  return peri.shape.map(([r, c]) => [startR + r, startC + c]);
}

function _saHasOverlap(placements) {
  const occupied = new Set();
  for (const p of placements) {
    if (!p.rotatedShape) continue;
    for (const [r, c] of p.rotatedShape) {
      const k = `${p.row+r},${p.col+c}`;
      if (occupied.has(k)) return true;
      occupied.add(k);
    }
    // Peripheral cells (e.g. Biocell) also reserve their space
    for (const [gr, gc] of _saPeripheralCells(p)) {
      const k = `${gr},${gc}`;
      if (occupied.has(k)) return true;
      occupied.add(k);
    }
  }
  return false;
}

function _saFitsInGrid(p, grid) {
  for (const [r, c] of p.rotatedShape) {
    const gr = p.row + r, gc = p.col + c;
    if (gr < 0 || gr >= grid.rows || gc < 0 || gc >= grid.cols) return false;
  }
  // Peripheral must also fit — otherwise auto-placed Biocell ends up off-grid
  for (const [gr, gc] of _saPeripheralCells(p)) {
    if (gr < 0 || gr >= grid.rows || gc < 0 || gc >= grid.cols) return false;
  }
  return true;
}

function _saMakePlacement(id, row, col, rotation) {
  const def = componentLib.find(d => d.id === id);
  if (!def) return null;
  const { shape, energyPorts, bioPorts } = rotateComponent(def, rotation);
  return {
    componentId: id, row, col, rotation,
    rotatedShape: shape,
    rotatedPorts: energyPorts,
    rotatedBioPorts: bioPorts,
    rotatedPeripheral: buildRotatedPeri(def, rotation)
  };
}

function _saRandomInt(n) { return Math.floor(Math.random() * n); }

// ── Move operators ─────────────────────────────────────────────────────────

// SWAP — exchange positions of two components, keeping each one's rotation.
function saSwapMove(placements, grid) {
  if (placements.length < 2) return null;
  const i = _saRandomInt(placements.length);
  let j = _saRandomInt(placements.length);
  while (j === i) j = _saRandomInt(placements.length);

  const a = placements[i], b = placements[j];
  const newA = _saMakePlacement(a.componentId, b.row, b.col, a.rotation);
  const newB = _saMakePlacement(b.componentId, a.row, a.col, b.rotation);
  if (!newA || !newB) return null;
  if (!_saFitsInGrid(newA, grid) || !_saFitsInGrid(newB, grid)) return null;

  const next = placements.slice();
  next[i] = newA;
  next[j] = newB;
  if (_saHasOverlap(next)) return null;
  return next;
}

// ROTATE — try the next geometrically distinct rotation of one component.
function saRotateMove(placements, grid) {
  if (placements.length === 0) return null;
  const i = _saRandomInt(placements.length);
  const target = placements[i];
  const def = componentLib.find(d => d.id === target.componentId);
  if (!def) return null;
  const uniqueDegs = getUniqueDegs(def);
  if (uniqueDegs.length < 2) return null;

  const otherDegs = uniqueDegs.filter(d => d !== target.rotation);
  const newRot = otherDegs[_saRandomInt(otherDegs.length)];
  const replaced = _saMakePlacement(target.componentId, target.row, target.col, newRot);
  if (!replaced || !_saFitsInGrid(replaced, grid)) return null;

  const next = placements.slice();
  next[i] = replaced;
  if (_saHasOverlap(next)) return null;
  return next;
}

// SHIFT — translate one component by 1 cell in a random direction.
function saShiftMove(placements, grid) {
  if (placements.length === 0) return null;
  const i = _saRandomInt(placements.length);
  const target = placements[i];
  const deltas = [[-1,0],[1,0],[0,-1],[0,1]];
  const [dr, dc] = deltas[_saRandomInt(4)];
  const moved = _saMakePlacement(target.componentId, target.row + dr, target.col + dc, target.rotation);
  if (!moved || !_saFitsInGrid(moved, grid)) return null;

  const next = placements.slice();
  next[i] = moved;
  if (_saHasOverlap(next)) return null;
  return next;
}

// RELOCATE — remove one component and re-insert at a random valid position with a random rotation.
function saRelocateMove(placements, grid) {
  if (placements.length === 0) return null;
  const i = _saRandomInt(placements.length);
  const target = placements[i];
  const def = componentLib.find(d => d.id === target.componentId);
  if (!def) return null;

  // Build occupied set from all other placements (shape AND peripheral cells)
  const others = placements.filter((_, idx) => idx !== i);
  const occupied = new Set();
  for (const p of others) {
    for (const [r, c] of p.rotatedShape) occupied.add(`${p.row+r},${p.col+c}`);
    for (const [gr, gc] of _saPeripheralCells(p)) occupied.add(`${gr},${gc}`);
  }

  const degs = getUniqueDegs(def);
  // Up to N tries (random sampling)
  for (let tries = 0; tries < 30; tries++) {
    const deg = degs[_saRandomInt(degs.length)];
    const { shape } = rotateComponent(def, deg);
    const bounds = getBounds(shape);
    if (bounds.height > grid.rows || bounds.width > grid.cols) continue;
    const row = _saRandomInt(grid.rows - bounds.height + 1);
    const col = _saRandomInt(grid.cols - bounds.width + 1);
    let overlap = false;
    for (const [r, c] of shape) {
      if (occupied.has(`${row+r},${col+c}`)) { overlap = true; break; }
    }
    if (overlap) continue;
    const replaced = _saMakePlacement(target.componentId, row, col, deg);
    if (!replaced) continue;
    // _saMakePlacement attaches rotatedPeripheral; verify peripheral fits in
    // grid AND doesn't overlap any other placement's cells.
    if (!_saFitsInGrid(replaced, grid)) continue;
    let periOverlap = false;
    for (const [gr, gc] of _saPeripheralCells(replaced)) {
      if (occupied.has(`${gr},${gc}`)) { periOverlap = true; break; }
    }
    if (periOverlap) continue;
    const next = placements.slice();
    next[i] = replaced;
    return next;
  }
  return null;
}

// ── Chain moves — Spinner+Repeater chains as atomic groups ─────────────────
//
// SA's per-component moves can drift a chain apart one move at a time, and
// re-assembling it requires a long chain of accepted moves at decreasing T.
// Chain moves treat a connected S-R subgraph as a single object and translate
// or rotate the whole thing in one accepted step. Critical for tight layouts
// where a chain needs to land against a specific edge of the grid.

const _CHAIN_IDS = new Set(['spinner', 'repeater_2s', 'repeater_4s']);

// Build adjacency over port-touching Spinners and Repeaters; return list of
// connected components, each as an array of placement indices.
function _saFindChains(placements) {
  const cellOwner = new Map();
  placements.forEach((p, idx) => {
    if (!_CHAIN_IDS.has(p.componentId)) return;
    for (const [r, c] of p.rotatedShape) cellOwner.set(`${p.row + r},${p.col + c}`, idx);
  });

  const neighbors = new Map();
  placements.forEach((p, idx) => {
    if (!_CHAIN_IDS.has(p.componentId)) return;
    if (!neighbors.has(idx)) neighbors.set(idx, new Set());
    for (const port of (p.rotatedPorts || [])) {
      const gr = p.row + port.cell[0];
      const gc = p.col + port.cell[1];
      const d = SIDE_DELTA[port.side];
      const k = `${gr + d.dr},${gc + d.dc}`;
      const adj = cellOwner.get(k);
      if (adj !== undefined && adj !== idx) {
        neighbors.get(idx).add(adj);
        if (!neighbors.has(adj)) neighbors.set(adj, new Set());
        neighbors.get(adj).add(idx);
      }
    }
  });

  const visited = new Set();
  const chains = [];
  for (const start of neighbors.keys()) {
    if (visited.has(start)) continue;
    const stack = [start];
    const comp = [];
    while (stack.length > 0) {
      const j = stack.pop();
      if (visited.has(j)) continue;
      visited.add(j);
      comp.push(j);
      for (const n of (neighbors.get(j) || [])) if (!visited.has(n)) stack.push(n);
    }
    if (comp.length >= 2) chains.push(comp);
  }
  return chains;
}

// Compute the chain's bounding box from its placements' shape cells.
function _saChainBbox(placements, chain) {
  let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
  for (const idx of chain) {
    const p = placements[idx];
    for (const [r, c] of p.rotatedShape) {
      const gr = p.row + r, gc = p.col + c;
      if (gr < minR) minR = gr;
      if (gr > maxR) maxR = gr;
      if (gc < minC) minC = gc;
      if (gc > maxC) maxC = gc;
    }
  }
  return { minR, maxR, minC, maxC };
}

// TRANSLATE — shift the entire chain by (dr, dc).
function saChainTranslate(placements, grid) {
  const chains = _saFindChains(placements);
  if (chains.length === 0) return null;
  const chain = chains[_saRandomInt(chains.length)];
  const chainSet = new Set(chain);

  // Try shifts of magnitudes 1..4 in random directions
  const deltas = [];
  for (let mag = 1; mag <= 4; mag++) {
    deltas.push([-mag, 0], [mag, 0], [0, -mag], [0, mag]);
  }
  // Shuffle so the order of attempted directions is random per call
  for (let i = deltas.length - 1; i > 0; i--) {
    const j = _saRandomInt(i + 1);
    [deltas[i], deltas[j]] = [deltas[j], deltas[i]];
  }

  for (const [dr, dc] of deltas) {
    const next = placements.slice();
    let ok = true;
    for (const idx of chain) {
      const p = placements[idx];
      const moved = { ...p, row: p.row + dr, col: p.col + dc };
      if (!_saFitsInGrid(moved, grid)) { ok = false; break; }
      next[idx] = moved;
    }
    if (!ok) continue;
    if (_saHasOverlap(next)) continue;
    return next;
  }
  return null;
}

// ROTATE — rotate the entire chain by 90/180/270 around its bbox top-left.
// Each component's anchor and rotation update so the rotated-shape cells
// match the cells produced by rotating the chain as a unit.
function saChainRotate(placements, grid) {
  const chains = _saFindChains(placements);
  if (chains.length === 0) return null;
  const chain = chains[_saRandomInt(chains.length)];
  const { minR, maxR, minC, maxC } = _saChainBbox(placements, chain);

  const angle = [90, 180, 270][_saRandomInt(3)];
  // Rotation around bbox top-left so output stays in non-negative offsets.
  // After the transform, we shift the result to keep the chain inside the grid.
  const transform = (gr, gc) => {
    if (angle === 90)  return [minR + (gc - minC),     minC + (maxR - gr)];
    if (angle === 180) return [minR + (maxR - gr),     minC + (maxC - gc)];
    return                  [minR + (maxC - gc),       minC + (gr - minR)];
  };

  const next = placements.slice();
  for (const idx of chain) {
    const p = placements[idx];
    const def = componentLib.find(d => d.id === p.componentId);
    if (!def) return null;
    const transformed = p.rotatedShape.map(([r, c]) => transform(p.row + r, p.col + c));
    const newAnchorR = Math.min(...transformed.map(([r]) => r));
    const newAnchorC = Math.min(...transformed.map(([, c]) => c));
    const newRot = (p.rotation + angle) % 360;
    const rotated = rotateComponent(def, newRot);
    const movedP = {
      ...p,
      row: newAnchorR,
      col: newAnchorC,
      rotation: newRot,
      rotatedShape: rotated.shape,
      rotatedPorts: rotated.energyPorts,
      rotatedBioPorts: rotated.bioPorts,
      rotatedPeripheral: buildRotatedPeri(def, newRot)
    };
    if (!_saFitsInGrid(movedP, grid)) return null;
    next[idx] = movedP;
  }
  if (_saHasOverlap(next)) return null;
  return next;
}

// Per-worker move bias — settable global. Each worker sets its own profile
// to encourage strategic diversity:
//   - balanced  (default):  even mix of all moves
//   - local:    high shift/rotate (fine-tune near current state)
//   - rotate:   heavy rotate (explore orientations)
//   - swap:     heavy swap (re-pair components)
//   - jump:     heavy relocate (escape local minima)
let saMoveBias = { shift: 0.22, rotate: 0.27, swap: 0.27, relocate: 0.14, chain: 0.10 };

function setSaMoveBias(profile) {
  switch (profile) {
    case 'local':   saMoveBias = { shift: 0.45, rotate: 0.27, swap: 0.13, relocate: 0.05, chain: 0.10 }; break;
    case 'rotate':  saMoveBias = { shift: 0.13, rotate: 0.50, swap: 0.17, relocate: 0.10, chain: 0.10 }; break;
    case 'swap':    saMoveBias = { shift: 0.13, rotate: 0.17, swap: 0.50, relocate: 0.10, chain: 0.10 }; break;
    case 'jump':    saMoveBias = { shift: 0.07, rotate: 0.13, swap: 0.13, relocate: 0.47, chain: 0.20 }; break;
    case 'balanced':
    default:        saMoveBias = { shift: 0.22, rotate: 0.27, swap: 0.27, relocate: 0.14, chain: 0.10 }; break;
  }
}

// Main move generator — picks a random operator with weighted probability.
function saGenerateMove(placements, grid) {
  const r = Math.random();
  let cum = saMoveBias.shift;
  if (r < cum) return saShiftMove(placements, grid);
  cum += saMoveBias.rotate;
  if (r < cum) return saRotateMove(placements, grid);
  cum += saMoveBias.swap;
  if (r < cum) return saSwapMove(placements, grid);
  cum += saMoveBias.relocate;
  if (r < cum) return saRelocateMove(placements, grid);
  // Chain moves — half translate, half rotate
  return Math.random() < 0.5 ? saChainTranslate(placements, grid) : saChainRotate(placements, grid);
}
