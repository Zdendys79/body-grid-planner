// optimizer.js – Idle Directive Body Optimizer
// Rotation helpers moved to src/optimizer/rotation.js.
// Placement helpers moved to src/optimizer/placement.js.
// Bus/power/wire helpers (SIDE_DELTA, OPPOSITE, computePoweredSet, findWirePath,
// wouldConnectToComponent, wouldConnectToBus, wouldBePowered) moved to src/optimizer/bus.js.

// getOccupiedMap, hasOverlap, fitsInGrid moved to src/optimizer/placement.js

// Biocell / Disposable Biocell have normal electrical ports but only
// function when plugged directly into a Bio Generator (any tier) — a hard
// placement constraint, same shape as the Repeater<->Spinner/Pulser one.
// BIOCELL_IDS / BIO_GENERATOR_IDS are defined once in src/optimizer/validate.js
// (loaded before this file in both index.html and the worker bundle).
function wouldConnectToBioGenerator(energyPorts, row, col, placements) {
  for (const { cell, side } of energyPorts) {
    const gr = row + cell[0], gc = col + cell[1];
    const d = SIDE_DELTA[side];
    const ar = gr + d.dr, ac = gc + d.dc;
    for (const pp of placements) {
      if (!BIO_GENERATOR_IDS.has(pp.componentId)) continue;
      for (const { cell: pc, side: ps } of (pp.rotatedPorts || [])) {
        if (pp.row + pc[0] === ar && pp.col + pc[1] === ac && ps === OPPOSITE[side]) return true;
      }
    }
  }
  return false;
}

// computePoweredSet, wouldConnect*, wouldBePowered moved to src/optimizer/bus.js
// addPeripheralReserved moved to src/optimizer/placement.js

// computeFreeSpaceQuality moved to src/optimizer/score.js

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

// computeWorkingSet moved to src/optimizer/score.js

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

// Bonus for connecting a Power Amplifier to a Harvester/Salvager (or the
// reverse: placing a Harvester/Salvager next to an already-placed
// Amplifier). Same relationship computeAmplifierBonus rewards in
// src/optimizer/score.js for SMART — kept here too so RE-OPTIMIZE's
// one-component-at-a-time greedy also tries to make the connection.
// Reads the live scoreWeights.amplifier so both paths agree on magnitude.
const AMPLIFIER_TARGET_IDS = new Set(['harvester', 'salvager']);

function getAmplifierConnectionBonus(compDef, energyPorts, row, col, placements) {
  const isAmplifier = compDef.id === 'power_amplifier';
  const isTarget = AMPLIFIER_TARGET_IDS.has(compDef.id);
  if (!isAmplifier && !isTarget) return 0;

  let bonus = 0;
  const counted = new Set();
  for (const { cell, side } of energyPorts) {
    const gr = row + cell[0], gc = col + cell[1];
    const d  = SIDE_DELTA[side];
    const ar = gr + d.dr, ac = gc + d.dc;
    for (let j = 0; j < placements.length; j++) {
      const pp = placements[j];
      const isMatch = isAmplifier
        ? AMPLIFIER_TARGET_IDS.has(pp.componentId)
        : pp.componentId === 'power_amplifier';
      if (!isMatch || counted.has(j)) continue;
      const connects = pp.rotatedPorts.some(({ cell: pc, side: ps }) =>
        pp.row + pc[0] === ar && pp.col + pc[1] === ac && ps === OPPOSITE[side]
      );
      if (connects) { counted.add(j); bonus += scoreWeights.amplifier; }
    }
  }
  return bonus;
}

// Same idea as getAmplifierConnectionBonus, for the other three amplifier-
// family components (each mirroring its computeXBonus in
// src/optimizer/score.js, used by SA's scoreLayout) — without these,
// RE-OPTIMIZE and SA's initial greedy seed never even try to place these
// near their targets; only SMART's later move-based search would find the
// connection. AMPLIFIER_TARGET_IDS-style sets (_isBatteryTarget,
// ENERGY_AMPLIFIER_TARGETS, CONCENTRATOR_TARGETS) are defined once in
// src/optimizer/score.js (loaded before this file).

// Battery Amplifier <-> any battery, bonus scaled by the battery's cell
// count — same area-scaling as computeBatteryAmplifierBonus.
function getBatteryAmplifierConnectionBonus(compDef, energyPorts, row, col, placements, shape) {
  const isAmplifier = compDef.id === 'battery_amplifier';
  const isTarget = _isBatteryTarget(compDef.id);
  if (!isAmplifier && !isTarget) return 0;

  let bonus = 0;
  const counted = new Set();
  for (const { cell, side } of energyPorts) {
    const gr = row + cell[0], gc = col + cell[1];
    const d  = SIDE_DELTA[side];
    const ar = gr + d.dr, ac = gc + d.dc;
    for (let j = 0; j < placements.length; j++) {
      const pp = placements[j];
      const isMatch = isAmplifier
        ? _isBatteryTarget(pp.componentId)
        : pp.componentId === 'battery_amplifier';
      if (!isMatch || counted.has(j)) continue;
      const connects = pp.rotatedPorts.some(({ cell: pc, side: ps }) =>
        pp.row + pc[0] === ar && pp.col + pc[1] === ac && ps === OPPOSITE[side]
      );
      if (connects) {
        counted.add(j);
        const area = isAmplifier ? pp.rotatedShape.length : shape.length;
        bonus += scoreWeights.batteryAmplifier * area;
      }
    }
  }
  return bonus;
}

// Energy Amplifier <-> Bio Generator/Energy Cells/Spinner/Pulser, one
// weight per target type (energyAmpBioGen/EnergyCells/Spinner/Pulser).
function _energyAmpWeightFor(id) {
  if (id === 'bio_generator' || id === 'bio_generator_ii') return scoreWeights.energyAmpBioGen;
  if (id === 'energy_cells') return scoreWeights.energyAmpEnergyCells;
  if (id === 'spinner') return scoreWeights.energyAmpSpinner;
  if (id === 'pulser') return scoreWeights.energyAmpPulser;
  return 0;
}

function getEnergyAmplifierConnectionBonus(compDef, energyPorts, row, col, placements) {
  const isAmplifier = compDef.id === 'energy_amplifier';
  const isTarget = ENERGY_AMPLIFIER_TARGETS.has(compDef.id);
  if (!isAmplifier && !isTarget) return 0;

  let bonus = 0;
  const counted = new Set();
  for (const { cell, side } of energyPorts) {
    const gr = row + cell[0], gc = col + cell[1];
    const d  = SIDE_DELTA[side];
    const ar = gr + d.dr, ac = gc + d.dc;
    for (let j = 0; j < placements.length; j++) {
      const pp = placements[j];
      const isMatch = isAmplifier
        ? ENERGY_AMPLIFIER_TARGETS.has(pp.componentId)
        : pp.componentId === 'energy_amplifier';
      if (!isMatch || counted.has(j)) continue;
      const connects = pp.rotatedPorts.some(({ cell: pc, side: ps }) =>
        pp.row + pc[0] === ar && pp.col + pc[1] === ac && ps === OPPOSITE[side]
      );
      if (connects) { counted.add(j); bonus += _energyAmpWeightFor(isAmplifier ? pp.componentId : compDef.id); }
    }
  }
  return bonus;
}

// Concentrator <-> Energy Cells, counted per DISTINCT connected block (same
// pairing rule as the other 3 amplifier-family bonuses, and as
// computeConcentratorBonus in src/optimizer/score.js). A block touching the
// Concentrator via 2 of its own ports still counts once — otherwise 4
// double-porting blocks (8 port-pairs) score the same as 6 single-porting
// ones (6 port-pairs) instead of losing to them, which made SA settle for
// fewer, denser-wired blocks instead of maximizing distinct connections.
function getConcentratorConnectionBonus(compDef, energyPorts, row, col, placements) {
  const isAmplifier = compDef.id === 'concentrator';
  const isTarget = CONCENTRATOR_TARGETS.has(compDef.id);
  if (!isAmplifier && !isTarget) return 0;

  let bonus = 0;
  const counted = new Set();
  for (const { cell, side } of energyPorts) {
    const gr = row + cell[0], gc = col + cell[1];
    const d  = SIDE_DELTA[side];
    const ar = gr + d.dr, ac = gc + d.dc;
    for (let j = 0; j < placements.length; j++) {
      const pp = placements[j];
      const isMatch = isAmplifier
        ? CONCENTRATOR_TARGETS.has(pp.componentId)
        : pp.componentId === 'concentrator';
      if (!isMatch || counted.has(j)) continue;
      const connects = pp.rotatedPorts.some(({ cell: pc, side: ps }) =>
        pp.row + pc[0] === ar && pp.col + pc[1] === ac && ps === OPPOSITE[side]
      );
      if (connects) { counted.add(j); bonus += scoreWeights.concentrator; }
    }
  }
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
  const isBioCell = BIOCELL_IDS.has(compDef.id);

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

  for (const deg of [0, 90, 180, 270]) {
    const { shape, energyPorts } = rotateComponent(compDef, deg);
    const bounds = getBounds(shape);
    if (bounds.height > grid.rows || bounds.width > grid.cols) continue;

    const rotPeri = buildRotatedPeri(compDef, deg);

    for (let row = 0; row <= grid.rows - bounds.height; row++) {
      for (let col = 0; col <= grid.cols - bounds.width; col++) {
        if (hasOverlap(shape, row, col, occupiedMap)) continue;
        if (!fitsInGrid(shape, row, col, grid.rows, grid.cols)) continue;

        // ── Hard constraint: Repeater — if any non-working Spinner exists,
        //    the Repeater MUST connect to it. Otherwise position rejected
        //    (this is a condition, not a bonus).
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

        // ── Hard constraint: Biocell / Disposable Biocell — must be
        //    port-adjacent to a Bio Generator (any tier) to function at all.
        if (isBioCell && !wouldConnectToBioGenerator(energyPorts, row, col, placements)) continue;

        // ── Energy/bio connection priority ────────────────────────────────
        let energyBonus = 0;
        let wirePath    = [];

        if (wouldConnectToComponent(energyPorts, row, col, placements, poweredSet)) {
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

        // ── Amplifier-family connection bonuses ──────────────────────────
        const amplifierBonus = getAmplifierConnectionBonus(compDef, energyPorts, row, col, placements);
        const batteryAmpBonus = getBatteryAmplifierConnectionBonus(compDef, energyPorts, row, col, placements, shape);
        const energyAmpBonus = getEnergyAmplifierConnectionBonus(compDef, energyPorts, row, col, placements);
        const concentratorBonus = getConcentratorConnectionBonus(compDef, energyPorts, row, col, placements);

        // ── Total score ───────────────────────────────────────────────────
        const score = energyBonus + quality * 4 + spatial + periBonus + repeaterBonus + spinnerBonus
                     + amplifierBonus + batteryAmpBonus + energyAmpBonus + concentratorBonus;

        if (score > bestScore) {
          bestScore = score;
          bestResult = {
            row, col, rotation: deg,
            rotatedShape: shape, rotatedPorts: energyPorts,
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
// findWirePath moved to src/optimizer/bus.js
