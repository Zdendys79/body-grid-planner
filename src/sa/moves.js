// src/sa/moves.js — Neighborhood move operators for Simulated Annealing.
// All operators take the current non-wire placement list and return a NEW
// list (or null if the move can't be applied). Wires are recomputed after
// each accepted move via tryAddWires.

// ── Helpers ─────────────────────────────────────────────────────────────────

function _saHasOverlap(placements) {
  const occupied = new Set();
  for (const p of placements) {
    if (!p.rotatedShape) continue;
    for (const [r, c] of p.rotatedShape) {
      const k = `${p.row+r},${p.col+c}`;
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

  // Build occupied set from all other placements
  const others = placements.filter((_, idx) => idx !== i);
  const occupied = new Set();
  for (const p of others) {
    for (const [r, c] of p.rotatedShape) occupied.add(`${p.row+r},${p.col+c}`);
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
    const next = placements.slice();
    next[i] = replaced;
    return next;
  }
  return null;
}

// Per-worker move bias — settable global. Each worker sets its own profile
// to encourage strategic diversity:
//   - balanced  (default):  even mix of all moves
//   - local:    high shift/rotate (fine-tune near current state)
//   - rotate:   heavy rotate (explore orientations)
//   - swap:     heavy swap (re-pair components)
//   - jump:     heavy relocate (escape local minima)
let saMoveBias = { shift: 0.25, rotate: 0.30, swap: 0.30, relocate: 0.15 };

function setSaMoveBias(profile) {
  switch (profile) {
    case 'local':   saMoveBias = { shift: 0.50, rotate: 0.30, swap: 0.15, relocate: 0.05 }; break;
    case 'rotate':  saMoveBias = { shift: 0.15, rotate: 0.55, swap: 0.20, relocate: 0.10 }; break;
    case 'swap':    saMoveBias = { shift: 0.15, rotate: 0.20, swap: 0.55, relocate: 0.10 }; break;
    case 'jump':    saMoveBias = { shift: 0.10, rotate: 0.15, swap: 0.15, relocate: 0.60 }; break;
    case 'balanced':
    default:        saMoveBias = { shift: 0.25, rotate: 0.30, swap: 0.30, relocate: 0.15 }; break;
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
  return saRelocateMove(placements, grid);
}
