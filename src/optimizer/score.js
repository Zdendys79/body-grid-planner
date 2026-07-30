// src/optimizer/score.js — Scoring and quality metrics.
// computeFreeSpaceQuality (used by scoreLayout and findBestPlacement) measures
// connectivity of remaining empty cells. computeWorkingSet identifies
// Spinners satisfied by their Repeater requirements. scoreLayout combines
// these into the brute force's final layout ranking.

// Player-tunable weights for scoreLayout's seven signals (Settings modal).
// Each JS context (main thread, each SA worker) holds its own copy — the
// main thread calls setScoreWeights() directly from persisted settings;
// workers receive the current values via the 'init' message, since threads
// don't share memory. See src/ui/settings.js and sa-worker.js.
const DEFAULT_SCORE_WEIGHTS = {
  workingSet:  50000, // per working Spinner
  wirePenalty:  5000, // per auto-routed wire cell (subtracted)
  quality:         4, // per unit of free-neighbour connectivity
  freeBlock:       1, // multiplier on computeFreeBlockBonus's "free" total (any accessible open rectangle)
  busAccess:       1, // multiplier on computeFreeBlockBonus's "bus" total (extra, only for rectangles touching the W/S bus)
  cluster:       100, // per same-type neighbour pair (port-connected pairs get x2)
  amplifier:    8000  // per Power Amplifier <-> Harvester/Salvager port connection
};
let scoreWeights = { ...DEFAULT_SCORE_WEIGHTS };

function setScoreWeights(w) {
  scoreWeights = { ...DEFAULT_SCORE_WEIGHTS, ...(w || {}) };
}

function getScoreWeights() {
  return { ...scoreWeights };
}

function computeFreeSpaceQuality(extraShape, extraRow, extraCol, placements, gridRows, gridCols) {
  const occupied = new Set();
  placements.forEach(p => p.rotatedShape.forEach(([r,c]) => occupied.add(`${p.row+r},${p.col+c}`)));
  addPeripheralReserved(placements, occupied);
  if (extraShape && extraShape.length > 0) {
    extraShape.forEach(([r,c]) => occupied.add(`${extraRow+r},${extraCol+c}`));
  }

  let quality = 0;
  for (let r = 0; r < gridRows; r++) {
    for (let c = 0; c < gridCols; c++) {
      if (occupied.has(`${r},${c}`)) continue;
      let freeNeighbours = 0;
      [[-1,0],[1,0],[0,-1],[0,1]].forEach(([dr,dc]) => {
        const nr = r+dr, nc = c+dc;
        if (nr >= 0 && nr < gridRows && nc >= 0 && nc < gridCols && !occupied.has(`${nr},${nc}`)) {
          freeNeighbours++;
        }
      });
      quality += freeNeighbours;
    }
  }
  return quality;
}

// Returns indices of components whose timing/working conditions are satisfied.
// Spinner needs repeater_2s on any side, OR repeater_4s on 2+ distinct sides.
function computeWorkingSet(placements) {
  const working = new Set();

  const portMap = new Map();
  placements.forEach((p, idx) => {
    p.rotatedPorts.forEach(({ cell, side }) => {
      const key = `${p.row+cell[0]},${p.col+cell[1]},${side}`;
      if (!portMap.has(key)) portMap.set(key, []);
      portMap.get(key).push(idx);
    });
  });

  placements.forEach((p, idx) => {
    if (p.componentId !== 'spinner') return;

    const connected2s = new Set();
    const connected4sBySide = new Map();

    p.rotatedPorts.forEach(({ cell, side }) => {
      const gr = p.row + cell[0], gc = p.col + cell[1];
      const d  = SIDE_DELTA[side];
      const adjKey = `${gr+d.dr},${gc+d.dc},${OPPOSITE[side]}`;
      if (!portMap.has(adjKey)) return;
      portMap.get(adjKey).forEach(adjIdx => {
        const id = placements[adjIdx].componentId;
        if (id === 'repeater_2s') connected2s.add(adjIdx);
        if (id === 'repeater_4s') {
          if (!connected4sBySide.has(side)) connected4sBySide.set(side, new Set());
          connected4sBySide.get(side).add(adjIdx);
        }
      });
    });

    if (connected2s.size >= 1)       { working.add(idx); return; }
    if (connected4sBySide.size >= 2) { working.add(idx); return; }
  });

  return working;
}

// Powered free-block bonus table — escalates with block area so SA prefers
// to leave large open rectangles. The numbers are calibrated so that:
//   - small (2x2) blocks are cheap (200 each) — pure capacity placeholders;
//   - mid (3x3) blocks are valuable (~1 wire = 5000 saved);
//   - large (4x4) blocks dominate (~half a working spinner = 25000).
// Overlap is intentional: a 4x4 powered area at the bus contains nine 2x2
// windows + four 3x3s + one 4x4, all counted, so larger areas scale
// super-linearly without any explicit max-rectangle dedup.
const FREE_BLOCK_BONUS = {
  '2x2':   200,
  '3x2':  1000, '2x3':  1000,
  '3x3':  5000,
  '4x3': 12000, '3x4': 12000,
  '4x4': 25000,
  '5x4': 40000, '4x5': 40000,
  '5x5': 60000,
  '6x4': 60000, '4x6': 60000
};
const FREE_BLOCK_SIZES = [
  [6,4],[4,6],[5,5],[5,4],[4,5],[4,4],[4,3],[3,4],[3,3],[3,2],[2,3],[2,2]
];

// Returns two independently-weighted totals for large, accessible rectangles
// of empty cells (see scoreLayout):
//   free — every accessible window's base bonus. "Accessible" means at
//          least one cell is on the W/S bus OR adjacent to a placed
//          component's port (so a future battery/cluster put there could
//          be powered — with a short wire, in the port-adjacent case).
//   bus  — the SAME base bonus again, but ONLY for windows that touch the
//          W (col=0) or S (row=R-1) bus directly, where the future
//          component could be powered with NO wire at all. Separate from
//          `free` so the two are independently tunable (Settings) instead
//          of one hardcoded multiplier.
function computeFreeBlockBonus(placements, gridRows, gridCols) {
  const rows = gridRows, cols = gridCols;
  // Uint8 grids beat Set lookups by 10-20× in tight SA inner loops.
  const occupied   = new Uint8Array(rows * cols);
  const portTarget = new Uint8Array(rows * cols);

  for (const p of placements) {
    if (p.rotatedShape) {
      for (const [r, c] of p.rotatedShape) {
        const gr = p.row + r, gc = p.col + c;
        if (gr >= 0 && gr < rows && gc >= 0 && gc < cols) occupied[gr * cols + gc] = 1;
      }
    }
    if (p.rotatedPeripheral) {
      const peri = p.rotatedPeripheral;
      const d = SIDE_DELTA[peri.port.side];
      const sR = p.row + peri.port.cell[0] + d.dr;
      const sC = p.col + peri.port.cell[1] + d.dc;
      for (const [r, c] of peri.shape) {
        const gr = sR + r, gc = sC + c;
        if (gr >= 0 && gr < rows && gc >= 0 && gc < cols) occupied[gr * cols + gc] = 1;
      }
    }
    if (p.componentId === 'wire') continue; // wires don't 'power' a free block
    for (const port of (p.rotatedPorts || [])) {
      const gr = p.row + port.cell[0];
      const gc = p.col + port.cell[1];
      const d = SIDE_DELTA[port.side];
      const tr = gr + d.dr, tc = gc + d.dc;
      if (tr >= 0 && tr < rows && tc >= 0 && tc < cols) portTarget[tr * cols + tc] = 1;
    }
  }

  let free = 0;
  let bus  = 0;
  for (const [h, w] of FREE_BLOCK_SIZES) {
    const base = FREE_BLOCK_BONUS[`${h}x${w}`];
    if (!base) continue;
    const maxR = rows - h, maxC = cols - w;
    for (let r = 0; r <= maxR; r++) {
      for (let c = 0; c <= maxC; c++) {
        // 1) All cells of the window must be free.
        let allFree = true;
        for (let dr = 0; dr < h && allFree; dr++) {
          const rowBase = (r + dr) * cols + c;
          for (let dc = 0; dc < w; dc++) {
            if (occupied[rowBase + dc]) { allFree = false; break; }
          }
        }
        if (!allFree) continue;
        // 2) At least one cell must be on a bus or fed by a placed port.
        let powered = false;
        for (let dr = 0; dr < h && !powered; dr++) {
          const cellR = r + dr;
          const onSBus = (cellR === rows - 1);
          for (let dc = 0; dc < w; dc++) {
            const cellC = c + dc;
            if (cellC === 0 || onSBus || portTarget[cellR * cols + cellC]) {
              powered = true; break;
            }
          }
        }
        if (!powered) continue;
        free += base;
        // 3) Windows touching the bus directly ALSO earn the separate bus total.
        const busTouch = (c === 0 || r + h - 1 === rows - 1);
        if (busTouch) bus += base;
      }
    }
  }
  return { free, bus };
}

// Power Amplifier bonus: rewards each port-to-port connection between a
// Power Amplifier and an adjacent Harvester or Salvager, which the
// amplifier boosts in-game. Optional — not required for layout validity
// (unlike Repeater<->Spinner), purely a scoring incentive so SA tries to
// wire amplifiers up to a target when the grid allows it.
const AMPLIFIER_TARGETS = new Set(['harvester', 'salvager']);

function computeAmplifierBonus(placements) {
  const portMap = new Map();
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    if (p.componentId !== 'power_amplifier' && !AMPLIFIER_TARGETS.has(p.componentId)) continue;
    for (const { cell, side } of (p.rotatedPorts || [])) {
      const key = `${p.row + cell[0]},${p.col + cell[1]},${side}`;
      if (!portMap.has(key)) portMap.set(key, []);
      portMap.get(key).push(i);
    }
  }

  let bonus = 0;
  const counted = new Set();
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    if (p.componentId !== 'power_amplifier') continue;
    for (const { cell, side } of (p.rotatedPorts || [])) {
      const gr = p.row + cell[0], gc = p.col + cell[1];
      const d = SIDE_DELTA[side];
      const adjKey = `${gr + d.dr},${gc + d.dc},${OPPOSITE[side]}`;
      if (!portMap.has(adjKey)) continue;
      for (const j of portMap.get(adjKey)) {
        if (!AMPLIFIER_TARGETS.has(placements[j].componentId)) continue;
        const pairKey = `${i},${j}`;
        if (counted.has(pairKey)) continue;
        counted.add(pairKey);
        bonus += scoreWeights.amplifier;
      }
    }
  }
  return bonus;
}

// Aesthetic bonus: same-type components placed next to each other score +100
// per pair; +200 if they are also port-to-port connected.
// Spinners, Repeaters and wires are excluded — their adjacency rules are
// governed by the working-set logic, not by aesthetics.
const CLUSTER_EXCLUDED  = new Set(['spinner', 'repeater_2s', 'repeater_4s', 'wire']);

function computeClusterBonus(placements) {
  // Cell → placement index map for eligible components.
  const cellMap = new Map();
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    if (CLUSTER_EXCLUDED.has(p.componentId)) continue;
    for (const [r, c] of (p.rotatedShape || [])) {
      cellMap.set(`${p.row + r},${p.col + c}`, i);
    }
  }

  // Port-to-port connected pairs (normalised i < j).
  const portConnected = new Set();
  const portMap = new Map();
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    if (CLUSTER_EXCLUDED.has(p.componentId)) continue;
    for (const { cell, side } of (p.rotatedPorts || [])) {
      const key = `${p.row + cell[0]},${p.col + cell[1]},${side}`;
      if (!portMap.has(key)) portMap.set(key, []);
      portMap.get(key).push(i);
    }
  }
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    if (CLUSTER_EXCLUDED.has(p.componentId)) continue;
    for (const { cell, side } of (p.rotatedPorts || [])) {
      const gr = p.row + cell[0], gc = p.col + cell[1];
      const d = SIDE_DELTA[side];
      const adjKey = `${gr + d.dr},${gc + d.dc},${OPPOSITE[side]}`;
      if (!portMap.has(adjKey)) continue;
      for (const j of portMap.get(adjKey)) {
        if (j > i) portConnected.add(`${i},${j}`);
      }
    }
  }

  // Sum bonus for each unique same-type cell-adjacent pair.
  const counted = new Set();
  let bonus = 0;
  const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    if (CLUSTER_EXCLUDED.has(p.componentId)) continue;
    for (const [r, c] of (p.rotatedShape || [])) {
      for (const [dr, dc] of DIRS) {
        const j = cellMap.get(`${p.row + r + dr},${p.col + c + dc}`);
        if (j === undefined || j === i) continue;
        if (placements[j].componentId !== p.componentId) continue;
        const pairKey = i < j ? `${i},${j}` : `${j},${i}`;
        if (counted.has(pairKey)) continue;
        counted.add(pairKey);
        bonus += portConnected.has(i < j ? `${i},${j}` : `${j},${i}`)
          ? scoreWeights.cluster * 2
          : scoreWeights.cluster;
      }
    }
  }
  return bonus;
}

// Final layout score — combines seven signals into one number that SA and
// the synchronous greedy share. Higher is better. The components, in rough
// magnitude order from largest to smallest at default weights:
//   workingSet.size * weights.workingSet   — a working Spinner is the most valuable atom
//   blockBonus.free * weights.freeBlock    — accessible open rectangles, escalates with area
//   blockBonus.bus  * weights.busAccess    — same rectangles, EXTRA reward for touching the
//                                           W/S bus directly (no wire needed there); independent
//                                           of freeBlock so bus proximity can be tuned separately
//   amplifierBonus                         — weights.amplifier per Power Amplifier <->
//                                           Harvester/Salvager port connection; see computeAmplifierBonus
//   wires * weights.wirePenalty            — penalty: every auto-routed wire costs score
//   quality * weights.quality              — fine-grained connectivity of remaining free cells
//   clusterBonus                           — aesthetic: same-type neighbours, weights.cluster
//                                           per pair (x2 if port-connected); see computeClusterBonus
// Weights are player-tunable via Settings — see setScoreWeights above.
function scoreLayout(placements, grid) {
  const wires          = placements.filter(p => p.componentId === 'wire').length;
  const quality        = computeFreeSpaceQuality(null, 0, 0, placements, grid.rows, grid.cols);
  const workingSet     = computeWorkingSet(placements);
  const blockBonus     = computeFreeBlockBonus(placements, grid.rows, grid.cols);
  const amplifierBonus = computeAmplifierBonus(placements);
  const clusterBonus   = computeClusterBonus(placements);
  return quality * scoreWeights.quality
       - wires * scoreWeights.wirePenalty
       + workingSet.size * scoreWeights.workingSet
       + blockBonus.free * scoreWeights.freeBlock
       + blockBonus.bus * scoreWeights.busAccess
       + amplifierBonus
       + clusterBonus;
}
