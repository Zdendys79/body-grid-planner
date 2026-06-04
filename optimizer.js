// optimizer.js – Idle Directive Body Optimizer
// Rotation helpers (rotateSide/rotateCoord/rotateComponent/rotatePeriShape/getBounds/getUniqueDegs)
// moved to src/optimizer/rotation.js — loaded before this file.

const SIDE_DELTA = { N:{dr:-1,dc:0}, S:{dr:1,dc:0}, E:{dr:0,dc:1}, W:{dr:0,dc:-1} };
const OPPOSITE   = { N:'S', S:'N', E:'W', W:'E' };

function getOccupiedMap(placements) {
  const map = new Map();
  placements.forEach((p, idx) => {
    p.rotatedShape.forEach(([r,c]) => map.set(`${p.row+r},${p.col+c}`, idx));
  });
  return map;
}

function hasOverlap(shape, row, col, occupiedMap) {
  return shape.some(([r,c]) => occupiedMap.has(`${row+r},${col+c}`));
}

function fitsInGrid(shape, row, col, gridRows, gridCols) {
  return shape.every(([r,c]) => {
    const gr = row+r, gc = col+c;
    return gr >= 0 && gr < gridRows && gc >= 0 && gc < gridCols;
  });
}

function wouldConnectToBioPort(bioPorts, row, col, placements) {
  const bioPortMap = new Map();
  placements.forEach((p, idx) => {
    (p.rotatedBioPorts || []).forEach(({ cell, side }) => {
      const key = `${p.row+cell[0]},${p.col+cell[1]},${side}`;
      if (!bioPortMap.has(key)) bioPortMap.set(key, []);
      bioPortMap.get(key).push(idx);
    });
  });
  for (const { cell, side } of bioPorts) {
    const gr = row + cell[0], gc = col + cell[1];
    const d = SIDE_DELTA[side];
    const adjKey = `${gr+d.dr},${gc+d.dc},${OPPOSITE[side]}`;
    if (bioPortMap.has(adjKey)) return true;
  }
  return false;
}

// BFS from buses to find all powered placement indices
function computePoweredSet(placements, gridRows, gridCols) {
  // Map: "r,c,side" -> [placement indices]
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

  // Bio port connections: placements with a bio port adjacent to another's bio port are active
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

// Free space quality: sum of free-neighbor counts across all empty cells.
// Higher value = more connected remaining space = better future placements.
// Empty cell value: 0 if no free neighbours, +1 per free neighbour (max 4).
function addPeripheralReserved(placements, occupied) {
  placements.forEach(p => {
    if (!p.rotatedPeripheral) return;
    const peri = p.rotatedPeripheral;
    const d = SIDE_DELTA[peri.port.side];
    const startR = p.row + peri.port.cell[0] + d.dr;
    const startC = p.col + peri.port.cell[1] + d.dc;
    // Reserve peripheral shape cells
    peri.shape.forEach(([r, c]) => occupied.add(`${startR + r},${startC + c}`));
    // Reserve one extra cell in same direction (for 2-cell-tall Biocell)
    occupied.add(`${startR + d.dr},${startC + d.dc}`);
  });
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

// Compact spatial score: shared edges + position bias (no energy, no quality – those are in findBestPlacement)
function scorePositionAndCompact(shape, row, col, occupiedMap, gridRows, gridCols) {
  let score = 0;
  const shapeRows = shape.map(([r]) => r);
  const shapeCols = shape.map(([,c]) => c);

  shape.forEach(([r,c]) => {
    const gr = row+r, gc = col+c;
    [[-1,0],[1,0],[0,-1],[0,1]].forEach(([dr,dc]) => {
      const nr = gr+dr, nc = gc+dc;
      if (nr < 0 || nr >= gridRows || nc < 0 || nc >= gridCols) score += 5;
      else if (occupiedMap.has(`${nr},${nc}`)) score += 25;
    });
  });

  const avgRow = row + (Math.max(...shapeRows) + Math.min(...shapeRows)) / 2;
  const avgCol = col + (Math.max(...shapeCols) + Math.min(...shapeCols)) / 2;
  score -= (avgCol * 3 + (gridRows - 1 - avgRow));

  return score;
}

function buildRotatedPeri(compDef, deg) {
  if (!compDef.peripheral) return null;
  const mainMaxR = Math.max(...compDef.shape.map(([r]) => r));
  const mainMaxC = Math.max(...compDef.shape.map(([,c]) => c));

  // Rotate port cell and side
  const rotCell = rotateCoord(compDef.peripheral.port.cell[0], compDef.peripheral.port.cell[1], mainMaxR, mainMaxC, deg);
  const rotSide = rotateSide(compDef.peripheral.port.side, deg);

  // Normalise using the same offset applied to the main shape
  const rotatedMain = compDef.shape.map(([r,c]) => rotateCoord(r, c, mainMaxR, mainMaxC, deg));
  const minR = Math.min(...rotatedMain.map(([r]) => r));
  const minC = Math.min(...rotatedMain.map(([,c]) => c));

  return {
    port:    { cell: [rotCell[0]-minR, rotCell[1]-minC], side: rotSide },
    shape:   rotatePeriShape(compDef.peripheral.shape, deg),
    color:   compDef.peripheral.color,
    bgColor: compDef.peripheral.bgColor,
    name:    compDef.peripheral.name
  };
}

// Wire-shape stub used for temporary quality calculations
function wireStub(r, c) { return { rotatedShape: [[0,0]], row: r, col: c }; }

// Returns indices of components whose timing/working conditions are satisfied.
// Currently: Spinner needs repeater_2s on any side, OR repeater_4s on 2+ distinct sides.
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

// Extra placement bonus for repeaters connecting to their valid targets (spinner, pulser).
// Repeaters are only useful adjacent to these two component types.
function getRepeaterTargetBonus(compDef, energyPorts, row, col, placements) {
  if (compDef.id !== 'repeater_2s' && compDef.id !== 'repeater_4s') return 0;

  const TARGET_IDS = new Set(['spinner', 'pulser']);

  const portMap = new Map();
  placements.forEach((p, idx) => {
    p.rotatedPorts.forEach(({ cell, side }) => {
      const key = `${p.row+cell[0]},${p.col+cell[1]},${side}`;
      if (!portMap.has(key)) portMap.set(key, []);
      portMap.get(key).push(idx);
    });
  });

  let bonus = 0;
  let targetsConnected = 0;

  placements.forEach((sp) => {
    if (!TARGET_IDS.has(sp.componentId)) return;
    let touchesThisTarget = false;

    sp.rotatedPorts.forEach(({ cell: sc, side: ss }) => {
      const sGr = sp.row + sc[0], sGc = sp.col + sc[1];
      energyPorts.forEach(({ cell: ec, side: es }) => {
        const eGr = row + ec[0], eGc = col + ec[1];
        const ed  = SIDE_DELTA[es];
        if (eGr+ed.dr === sGr && eGc+ed.dc === sGc && OPPOSITE[es] === ss) {
          bonus += 1500;
          touchesThisTarget = true;
          // Extra bonus if completing the 4s pair on the opposite side of spinner/pulser
          if (compDef.id === 'repeater_4s') {
            const otherSideHas4s = sp.rotatedPorts.some(({ cell: oc, side: os }) => {
              if (os === ss) return false;
              const oGr = sp.row + oc[0], oGc = sp.col + oc[1];
              const od  = SIDE_DELTA[os];
              const adjKey = `${oGr+od.dr},${oGc+od.dc},${OPPOSITE[os]}`;
              return portMap.has(adjKey) &&
                     portMap.get(adjKey).some(i => placements[i].componentId === 'repeater_4s');
            });
            if (otherSideHas4s) bonus += 2000;
          }
        }
      });
    });

    if (touchesThisTarget) targetsConnected++;
  });

  // Bonus for one repeater serving two targets simultaneously (minimises repeater count)
  if (targetsConnected >= 2) bonus += 3000;

  return bonus;
}

// Bonus for Spinner/Pulser placed where both port-adjacent cells are free and in-bounds.
// Encourages the optimizer to leave space for Repeaters on BOTH sides.
function getSpinnerAccessibilityBonus(compDef, energyPorts, row, col, occupiedMap, grid) {
  if (compDef.id !== 'spinner' && compDef.id !== 'pulser') return 0;
  let accessible = 0;
  for (const { cell, side } of energyPorts) {
    const gr = row + cell[0], gc = col + cell[1];
    const d  = SIDE_DELTA[side];
    const ar = gr + d.dr, ac = gc + d.dc;
    if (ar >= 0 && ar < grid.rows && ac >= 0 && ac < grid.cols && !occupiedMap.has(`${ar},${ac}`)) {
      accessible++;
    }
  }
  return accessible >= 2 ? 3000 : 0;
}

function findBestPlacement(compDef, state, pendingIds = []) {
  const { grid, placements } = state;
  const poweredSet = computePoweredSet(placements, grid.rows, grid.cols);
  const occupiedMap = getOccupiedMap(placements);

  // Reserve peripheral slots (biocell etc.) — sentinel -1 means "reserved, not a real component"
  placements.forEach(p => {
    if (!p.rotatedPeripheral) return;
    const peri = p.rotatedPeripheral;
    const d    = SIDE_DELTA[peri.port.side];
    const sR   = p.row + peri.port.cell[0] + d.dr;
    const sC   = p.col + peri.port.cell[1] + d.dc;
    peri.shape.forEach(([r, c]) => { const k = `${sR+r},${sC+c}`; if (!occupiedMap.has(k)) occupiedMap.set(k, -1); });
    const ek = `${sR+d.dr},${sC+d.dc}`; if (!occupiedMap.has(ek)) occupiedMap.set(ek, -1);
  });

  const isWire = compDef.id === 'wire';
  const isRepeater = compDef.id === 'repeater_4s' || compDef.id === 'repeater_2s';

  // Pre-compute unworking Spinner ports for the Repeater hard constraint.
  // Collected once — placements don't change during the search loop.
  let unworkingSpinnerPorts = [];
  if (isRepeater) {
    const ws = computeWorkingSet(placements);
    placements.forEach((p, i) => {
      if (p.componentId !== 'spinner' || ws.has(i)) return;
      p.rotatedPorts.forEach(({ cell, side }) => {
        unworkingSpinnerPorts.push({ gr: p.row + cell[0], gc: p.col + cell[1], side });
      });
    });
  }

  let bestScore = -Infinity;
  let bestResult = null;

  const isBioOnly = compDef.energyPorts.length === 0 && (compDef.bioPorts || []).length > 0;

  for (const deg of [0, 90, 180, 270]) {
    const { shape, energyPorts, bioPorts } = rotateComponent(compDef, deg);
    const bounds = getBounds(shape);
    if (bounds.height > grid.rows || bounds.width > grid.cols) continue;

    const rotPeri = buildRotatedPeri(compDef, deg);

    for (let row = 0; row <= grid.rows - bounds.height; row++) {
      for (let col = 0; col <= grid.cols - bounds.width; col++) {
        if (hasOverlap(shape, row, col, occupiedMap)) continue;
        if (!fitsInGrid(shape, row, col, grid.rows, grid.cols)) continue;

        // ── Hard constraint: Repeater — pokud existuje nefunkční Spinner, Repeater se
        //    k němu MUSÍ připojit. Jinak pozice zamítnuta (není to bonus, je to podmínka).
        if (isRepeater && unworkingSpinnerPorts.length > 0) {
          const connects = unworkingSpinnerPorts.some(({ gr, gc, side }) =>
            energyPorts.some(({ cell, side: es }) => {
              const eGr = row + cell[0], eGc = col + cell[1];
              const d   = SIDE_DELTA[es];
              return eGr + d.dr === gr && eGc + d.dc === gc && OPPOSITE[es] === side;
            })
          );
          if (!connects) continue;
        }

        // ── Hard constraint: Spinner ONLY — feasibility check for pending Repeaters ──
        // Checks not just free slots but whether Spinner CAN ever become functional.
        // Example: with pending4s=1 and no adjacent 4s yet, adj4sSides+pending4s=1 < 2
        //          → impossible to reach working state → reject this position.
        // Pulser: Repeaters are optional (connect if port is free, not mandatory)
        if (compDef.id === 'spinner') {
          const pending4s = pendingIds.filter(id => id === 'repeater_4s').length;
          const pending2s = pendingIds.filter(id => id === 'repeater_2s').length;
          if (pending4s > 0 || pending2s > 0) {
            let adj4sSideSet = new Set(), hasAdj2s = false, accessible = 0;
            for (const { cell, side } of energyPorts) {
              const gr = row + cell[0], gc = col + cell[1];
              const d  = SIDE_DELTA[side];
              const ar = gr + d.dr, ac = gc + d.dc;
              if (ar < 0 || ar >= grid.rows || ac < 0 || ac >= grid.cols) continue;
              for (const pp of placements) {
                for (const { cell: pc, side: ps } of (pp.rotatedPorts || [])) {
                  if (pp.row + pc[0] === ar && pp.col + pc[1] === ac && ps === OPPOSITE[side]) {
                    if (pp.componentId === 'repeater_4s') adj4sSideSet.add(side);
                    if (pp.componentId === 'repeater_2s') hasAdj2s = true;
                  }
                }
              }
              if (!occupiedMap.has(`${ar},${ac}`)) accessible++;
            }
            if (!hasAdj2s && adj4sSideSet.size < 2) {
              const canWork2s = pending2s > 0;
              const canWork4s = adj4sSideSet.size + pending4s >= 2;
              if (!canWork2s && !canWork4s) continue; // structurally impossible
              const neededFree = canWork2s ? 1 : Math.max(0, 2 - adj4sSideSet.size);
              if (accessible < neededFree) continue;
            }
          }
        }

        // ── Energy/bio connection priority ────────────────────────────────
        let energyBonus = 0;
        let wirePath    = [];

        if (isBioOnly) {
          // Bio-only components (biocell, disposable biocell) must connect to a bio port
          if (!wouldConnectToBioPort(bioPorts, row, col, placements)) continue;
          energyBonus = 2000;
        } else if (wouldConnectToComponent(energyPorts, row, col, placements, poweredSet)) {
          energyBonus = 2000;
        } else if (wouldConnectToBus(energyPorts, row, col, grid.rows, grid.cols)) {
          energyBonus = 1000;
        } else if (isWire) {
          energyBonus = 0; // wires may be placed anywhere; will receive power transitively
        } else if (compDef.id === 'spinner' || compDef.id === 'pulser') {
          energyBonus = 0; // powered by adjacent Repeaters placed after them
        } else {
          const path = findWirePath(shape, energyPorts, row, col, state);
          if (path === null) continue; // no power path → skip this position
          wirePath    = path;
          // Wire count is top priority: penalty >> max possible quality gain
          energyBonus = 800 - wirePath.length * 5000;
        }

        // ── Free space quality AFTER placing component + wires ────────────
        // Temporarily add wire stubs so quality reflects final occupied state
        const tempPlacements = wirePath.length > 0
          ? [...placements, ...wirePath.map(([r,c]) => wireStub(r, c))]
          : placements;
        const quality = computeFreeSpaceQuality(shape, row, col, tempPlacements, grid.rows, grid.cols);

        // ── Compact + position ────────────────────────────────────────────
        const spatial = scorePositionAndCompact(shape, row, col, occupiedMap, grid.rows, grid.cols);

        // ── Peripheral edge bonus ─────────────────────────────────────────
        let periBonus = 0;
        if (rotPeri) {
          const gr = row + rotPeri.port.cell[0], gc = col + rotPeri.port.cell[1];
          const s  = rotPeri.port.side;
          if ((s === 'E' && gc === grid.cols - 1) || (s === 'W' && gc === 0) ||
              (s === 'N' && gr === 0)             || (s === 'S' && gr === grid.rows - 1)) {
            periBonus = 600;
          }
        }

        // ── Repeater target bonus (spinner / pulser adjacency) ───────────
        const repeaterBonus = getRepeaterTargetBonus(compDef, energyPorts, row, col, placements);

        // ── Spinner/Pulser accessibility bonus ────────────────────────────
        // Prefers positions where BOTH port sides have free adjacent cells for Repeaters
        const spinnerBonus = getSpinnerAccessibilityBonus(compDef, energyPorts, row, col, occupiedMap, grid);

        // ── Total score ───────────────────────────────────────────────────
        const score = energyBonus + quality * 4 + spatial + periBonus + repeaterBonus + spinnerBonus;

        if (score > bestScore) {
          bestScore = score;
          bestResult = {
            row, col, rotation: deg,
            rotatedShape: shape, rotatedPorts: energyPorts,
            rotatedBioPorts: bioPorts,
            rotatedPeripheral: rotPeri,
            wirePath
          };
        }
      }
    }
  }

  return bestResult;
}

// Find the shortest path of wire cells needed to connect a component (at row,col) to power.
// Returns [{r,c}, ...] of cells where wires must be placed, or null if unreachable.
function findWirePath(rotatedShape, rotatedPorts, row, col, state) {
  const { grid, placements } = state;
  const poweredSet = computePoweredSet(placements, grid.rows, grid.cols);

  // Occupied = existing components + peripheral reserved slots + the component being placed
  const occupied = new Set();
  placements.forEach(p => p.rotatedShape.forEach(([r,c]) => occupied.add(`${p.row+r},${p.col+c}`)));
  addPeripheralReserved(placements, occupied);
  rotatedShape.forEach(([r,c]) => occupied.add(`${row+r},${col+c}`));

  // Power frontier: empty cells where a wire would be immediately powered
  const powerFrontier = new Set();
  // Left bus – any empty cell in col 0 can be powered via W port
  for (let r = 0; r < grid.rows; r++) {
    const k = `${r},0`;
    if (!occupied.has(k)) powerFrontier.add(k);
  }
  // Bottom bus – any empty cell in last row can be powered via S port
  for (let c = 0; c < grid.cols; c++) {
    const k = `${grid.rows-1},${c}`;
    if (!occupied.has(k)) powerFrontier.add(k);
  }
  // Empty cells adjacent (outward) to powered component ports
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

  // Target frontier: empty cells adjacent (outward) to the component's ports
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

  // Quick check: a target-frontier cell that is also a power-frontier cell needs just 1 wire
  for (const t of targetFrontier) {
    if (powerFrontier.has(t)) return [t.split(',').map(Number)];
  }

  // BFS: from target frontier outward toward power frontier
  const visited = new Map(); // key -> parent key (null for start nodes)
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
        // Reconstruct path from power frontier cell back to target frontier cell
        const path = [k];
        let p = visited.get(k);
        while (p !== null) { path.push(p); p = visited.get(p); }
        return path.map(s => s.split(',').map(Number));
      }

      queue.push(k);
    }
  }

  return null; // no path exists
}
