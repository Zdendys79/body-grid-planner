// src/optimizer/score.js — Scoring and quality metrics.
// computeFreeSpaceQuality (used by scoreLayout and findBestPlacement) measures
// connectivity of remaining empty cells. computeWorkingSet identifies
// Spinners satisfied by their Repeater requirements. scoreLayout combines
// these into the brute force's final layout ranking.

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

// Final layout score (used by brute force to rank candidates):
// working spinners dominate, then wire count is penalised, then quality.
function scoreLayout(placements, grid) {
  const wires      = placements.filter(p => p.componentId === 'wire').length;
  const quality    = computeFreeSpaceQuality(null, 0, 0, placements, grid.rows, grid.cols);
  const workingSet = computeWorkingSet(placements);
  return quality * 4 - wires * 5000 + workingSet.size * 50000;
}
