// bruteforce-worker.js — runs the brute force search in a dedicated worker thread.
// Phase 1: single worker, full search space (no parallelisation yet).
// Loads optimizer.js for SIDE_DELTA, rotateComponent, computePoweredSet, computeWorkingSet,
// computeFreeSpaceQuality, findWirePath, etc. componentLib is sent from main on init.

importScripts('src/constants.js?v=55', 'src/optimizer/rotation.js?v=55', 'optimizer.js?v=55');

let componentLib = [];

// ── Helpers copied verbatim from app.js (kept in sync) ──────────────────────
// getUniqueDegs moved to src/optimizer/rotation.js

function isLayoutValid(placements, grid) {
  const poweredSet  = computePoweredSet(placements, grid.rows, grid.cols);
  const workingSet  = computeWorkingSet(placements);
  const hasRepeaters = placements.some(p =>
    p.componentId === 'repeater_4s' || p.componentId === 'repeater_2s'
  );
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

function scoreLayout(placements, grid) {
  const wires      = placements.filter(p => p.componentId === 'wire').length;
  const quality    = computeFreeSpaceQuality(null, 0, 0, placements, grid.rows, grid.cols);
  const workingSet = computeWorkingSet(placements);
  return quality * 4 - wires * 5000 + workingSet.size * 50000;
}

function tryAddWires(placements, grid) {
  const wireDef = componentLib.find(d => d.id === 'wire');
  if (!wireDef) return null;
  let current = placements.map((p, i) => ({ ...p, id: i + 1 }));
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
          id: current.length + 1, componentId: 'wire',
          row: r, col: c, rotation: 0,
          rotatedShape: [[0,0]],
          rotatedPorts: wireDef.energyPorts.map(ep => ({ cell: [...ep.cell], side: ep.side })),
          rotatedBioPorts: [],
          rotatedPeripheral: null, autoPlaced: true
        });
      });
      break;
    }
    if (!foundUnpowered) return current;
  }
  return null;
}

// ── Brute force generator (copied from app.js) ──────────────────────────────
// (_SIDE_IDX is defined in src/constants.js, loaded via importScripts above)

function* bruteForcePlacements(nonWireIds, grid, onBranchComplete, resumePath, stateRef, options) {
  const R = grid.rows, C = grid.cols;
  const GRID_CELLS = R * C;
  // Phase 2: branch-range slicing for parallel workers
  const branchStart = (options && options.branchStart) || 0;
  const branchEnd   = (options && options.branchEnd != null) ? options.branchEnd : Infinity;

  const defById = new Map();
  for (const id of new Set(nonWireIds)) {
    const def = componentLib.find(d => d.id === id);
    if (def) defById.set(id, def);
  }

  const rotData = new Map();
  for (const [id, def] of defById) {
    const rots = [];
    for (const deg of getUniqueDegs(def)) {
      const { shape, energyPorts, bioPorts } = rotateComponent(def, deg);
      const bounds = getBounds(shape);
      if (bounds.height > R || bounds.width > C) continue;
      const cellOffsets = new Int32Array(shape.length);
      for (let i = 0; i < shape.length; i++) cellOffsets[i] = shape[i][0] * C + shape[i][1];
      const rotPeri = buildRotatedPeri(def, deg);
      let periRelCells = null;
      if (rotPeri) {
        const d = SIDE_DELTA[rotPeri.port.side];
        const baseR = rotPeri.port.cell[0] + d.dr;
        const baseC = rotPeri.port.cell[1] + d.dc;
        periRelCells = [];
        for (const [pr, pc] of rotPeri.shape) periRelCells.push([baseR + pr, baseC + pc]);
        periRelCells.push([baseR + d.dr, baseC + d.dc]);
      }
      const maxRow = R - bounds.height;
      const maxCol = C - bounds.width;
      const positions = new Int32Array((maxRow + 1) * (maxCol + 1) * 2);
      let pi = 0;
      for (let row = 0; row <= maxRow; row++) {
        for (let col = 0; col <= maxCol; col++) {
          positions[pi++] = row; positions[pi++] = col;
        }
      }
      rots.push({ deg, shape, cellOffsets, bounds, energyPorts, bioPorts, rotPeri, periRelCells, positions });
    }
    rotData.set(id, rots);
  }

  const occupied = new Int32Array(GRID_CELLS);
  const periStack = [];
  const placements = [];
  let cellsUsed = 0;

  const repPortSet = new Set();
  const allEnergyPortSet = new Set();
  const energyPortStack = [];
  const spinnerInfo = [];
  let unmetCount = 0;
  const targetCoverKeyCount = new Map();
  const pulserCoverStack = [];

  const bfsGeneration = new Uint32Array(GRID_CELLS);
  const bfsQueue = new Int32Array(GRID_CELLS);
  let bfsGen = 0;

  const ordered = [...nonWireIds].sort((a, b) => {
    const da = defById.get(a);
    const db = defById.get(b);
    return (db?.shape.length || 0) - (da?.shape.length || 0);
  });

  const remShape = new Array(ordered.length + 1).fill(0);
  const rem2s    = new Array(ordered.length + 1).fill(0);
  const rem4s    = new Array(ordered.length + 1).fill(0);
  for (let i = ordered.length - 1; i >= 0; i--) {
    const def = defById.get(ordered[i]);
    remShape[i] = remShape[i + 1] + (def ? def.shape.length : 0);
    rem2s[i]    = rem2s[i + 1]    + (ordered[i] === 'repeater_2s' ? 1 : 0);
    rem4s[i]    = rem4s[i + 1]    + (ordered[i] === 'repeater_4s' ? 1 : 0);
  }

  function portKey(gr, gc, sideIdx) { return (gr * C + gc) * 4 + sideIdx; }

  function hasOverlapFlat(cellOffsets, baseIdx) {
    for (let i = 0; i < cellOffsets.length; i++) {
      if (occupied[baseIdx + cellOffsets[i]] !== 0) return true;
    }
    return false;
  }

  function canReachBus(p) {
    const ports = p.rotatedPorts;
    for (let i = 0; i < ports.length; i++) {
      const gr = p.row + ports[i].cell[0];
      const gc = p.col + ports[i].cell[1];
      const side = ports[i].side;
      if (side === 'W' && gc === 0) return true;
      if (side === 'S' && gr === R - 1) return true;
      const d = SIDE_DELTA[side];
      const ar = gr + d.dr, ac = gc + d.dc;
      if (ar < 0 || ar >= R || ac < 0 || ac >= C) continue;
      const adjIdx = ar * C + ac;
      if (allEnergyPortSet.has(portKey(ar, ac, _SIDE_IDX[OPPOSITE[side]]))) return true;
      if (occupied[adjIdx] !== 0) continue;
      bfsGen++;
      bfsGeneration[adjIdx] = bfsGen;
      let qHead = 0, qTail = 0;
      bfsQueue[qTail++] = adjIdx;
      while (qHead < qTail) {
        const cur = bfsQueue[qHead++];
        const cr = (cur / C) | 0;
        const cc = cur - cr * C;
        if (cc === 0 || cr === R - 1) return true;
        if (cr > 0) {
          const ni = cur - C;
          if (bfsGeneration[ni] !== bfsGen && occupied[ni] === 0) {
            bfsGeneration[ni] = bfsGen; bfsQueue[qTail++] = ni;
          }
        }
        if (cr < R - 1) {
          const ni = cur + C;
          if (bfsGeneration[ni] !== bfsGen && occupied[ni] === 0) {
            bfsGeneration[ni] = bfsGen; bfsQueue[qTail++] = ni;
          }
        }
        if (cc > 0) {
          const ni = cur - 1;
          if (bfsGeneration[ni] !== bfsGen && occupied[ni] === 0) {
            bfsGeneration[ni] = bfsGen; bfsQueue[qTail++] = ni;
          }
        }
        if (cc < C - 1) {
          const ni = cur + 1;
          if (bfsGeneration[ni] !== bfsGen && occupied[ni] === 0) {
            bfsGeneration[ni] = bfsGen; bfsQueue[qTail++] = ni;
          }
        }
      }
    }
    return false;
  }

  function computeCoverKeys(p) {
    const ports = p.rotatedPorts;
    const keys = [];
    for (let i = 0; i < ports.length; i++) {
      const gr = p.row + ports[i].cell[0];
      const gc = p.col + ports[i].cell[1];
      const d = SIDE_DELTA[ports[i].side];
      const ar = gr + d.dr, ac = gc + d.dc;
      if (ar < 0 || ar >= R || ac < 0 || ac >= C) continue;
      keys.push(portKey(ar, ac, _SIDE_IDX[OPPOSITE[ports[i].side]]));
    }
    return keys;
  }
  function addTargetKeys(coverKeys) {
    for (let i = 0; i < coverKeys.length; i++) {
      const k = coverKeys[i];
      targetCoverKeyCount.set(k, (targetCoverKeyCount.get(k) || 0) + 1);
    }
  }
  function removeTargetKeys(coverKeys) {
    for (let i = 0; i < coverKeys.length; i++) {
      const k = coverKeys[i];
      const c = (targetCoverKeyCount.get(k) || 0) - 1;
      if (c <= 0) targetCoverKeyCount.delete(k);
      else targetCoverKeyCount.set(k, c);
    }
  }
  function pushSpinnerTracking(p) {
    const coverKeys = computeCoverKeys(p);
    let coverCount = 0;
    for (let i = 0; i < coverKeys.length; i++) if (repPortSet.has(coverKeys[i])) coverCount++;
    spinnerInfo.push({ coverKeys, coverCount });
    if (coverCount === 0) unmetCount++;
    addTargetKeys(coverKeys);
  }
  function popSpinnerTracking() {
    const s = spinnerInfo.pop();
    if (s.coverCount === 0) unmetCount--;
    removeTargetKeys(s.coverKeys);
  }
  function pushPulserTracking(p) {
    const coverKeys = computeCoverKeys(p);
    pulserCoverStack.push(coverKeys);
    addTargetKeys(coverKeys);
  }
  function popPulserTracking() {
    const coverKeys = pulserCoverStack.pop();
    if (coverKeys) removeTargetKeys(coverKeys);
  }
  function pushRepTracking(p) {
    const ports = p.rotatedPorts;
    const newKeys = [];
    for (let i = 0; i < ports.length; i++) {
      const k = portKey(p.row + ports[i].cell[0], p.col + ports[i].cell[1], _SIDE_IDX[ports[i].side]);
      newKeys.push(k); repPortSet.add(k);
    }
    for (let i = 0; i < spinnerInfo.length; i++) {
      const s = spinnerInfo[i];
      const wasZero = s.coverCount === 0;
      const ck = s.coverKeys;
      for (let j = 0; j < newKeys.length; j++) {
        const nk = newKeys[j];
        for (let kk = 0; kk < ck.length; kk++) if (ck[kk] === nk) { s.coverCount++; break; }
      }
      if (wasZero && s.coverCount > 0) unmetCount--;
    }
  }
  function popRepTracking(p) {
    const ports = p.rotatedPorts;
    const removed = [];
    for (let i = 0; i < ports.length; i++) {
      const k = portKey(p.row + ports[i].cell[0], p.col + ports[i].cell[1], _SIDE_IDX[ports[i].side]);
      removed.push(k); repPortSet.delete(k);
    }
    for (let i = 0; i < spinnerInfo.length; i++) {
      const s = spinnerInfo[i];
      const wasNonZero = s.coverCount > 0;
      const ck = s.coverKeys;
      for (let j = 0; j < removed.length; j++) {
        const rk = removed[j];
        for (let kk = 0; kk < ck.length; kk++) if (ck[kk] === rk) { s.coverCount--; break; }
      }
      if (wasNonZero && s.coverCount === 0) unmetCount++;
    }
  }

  function pushPlacement(p, periRelCells) {
    const idx = placements.length;
    placements.push(p);
    const baseIdx = p.row * C + p.col;
    p._baseIdx = baseIdx;
    const offs = p._cellOffsets;
    for (let i = 0; i < offs.length; i++) occupied[baseIdx + offs[i]] = idx + 1;
    cellsUsed += offs.length;
    if (periRelCells && periRelCells.length) {
      const changed = [];
      for (let i = 0; i < periRelCells.length; i++) {
        const r = p.row + periRelCells[i][0];
        const c = p.col + periRelCells[i][1];
        if (r < 0 || r >= R || c < 0 || c >= C) continue;
        const gi = r * C + c;
        if (occupied[gi] === 0) { occupied[gi] = -1; changed.push(gi); }
      }
      cellsUsed += changed.length;
      periStack.push(changed);
    } else {
      periStack.push(null);
    }
    const def = defById.get(p.componentId);
    const hasEnergy = def && def.energyPorts.length > 0;
    if (hasEnergy) {
      const ports = p.rotatedPorts;
      const added = new Array(ports.length);
      for (let i = 0; i < ports.length; i++) {
        const k = portKey(p.row + ports[i].cell[0], p.col + ports[i].cell[1], _SIDE_IDX[ports[i].side]);
        added[i] = k; allEnergyPortSet.add(k);
      }
      energyPortStack.push(added);
    } else {
      energyPortStack.push(null);
    }
    const cid = p.componentId;
    if (cid === 'spinner') pushSpinnerTracking(p);
    else if (cid === 'pulser') pushPulserTracking(p);
    else if (cid === 'repeater_2s' || cid === 'repeater_4s') pushRepTracking(p);
  }

  function popPlacement() {
    const idx = placements.length - 1;
    const p = placements[idx];
    const cid = p.componentId;
    if (cid === 'spinner') popSpinnerTracking();
    else if (cid === 'pulser') popPulserTracking();
    else if (cid === 'repeater_2s' || cid === 'repeater_4s') popRepTracking(p);
    const removed = energyPortStack.pop();
    if (removed) for (let i = 0; i < removed.length; i++) allEnergyPortSet.delete(removed[i]);
    const baseIdx = p._baseIdx;
    const offs = p._cellOffsets;
    for (let i = 0; i < offs.length; i++) occupied[baseIdx + offs[i]] = 0;
    cellsUsed -= offs.length;
    const changed = periStack.pop();
    if (changed) {
      for (let i = 0; i < changed.length; i++) occupied[changed[i]] = 0;
      cellsUsed -= changed.length;
    }
    placements.pop();
  }

  // Depth-0 branch index, exposed via stateRef.getCurrentBranchIdx for save snapshots
  let depth0BranchIdx = 0;
  if (stateRef) {
    stateRef.getPath = () => placements.map(p => ({ cid: p.componentId, ri: p._ri, pi: p._pi }));
    stateRef.getCurrentBranchIdx = () => depth0BranchIdx;
  }

  let _nodes = 0;
  const NODES_PER_TICK = 4000;

  function* search(idx, resume) {
    if (++_nodes >= NODES_PER_TICK) { _nodes = 0; yield null; }
    if (idx === ordered.length) {
      const clean = new Array(placements.length);
      for (let i = 0; i < placements.length; i++) {
        const p = placements[i];
        clean[i] = {
          id: p.id, componentId: p.componentId, row: p.row, col: p.col, rotation: p.rotation,
          rotatedShape: p.rotatedShape, rotatedPorts: p.rotatedPorts,
          rotatedBioPorts: p.rotatedBioPorts, rotatedPeripheral: p.rotatedPeripheral
        };
      }
      yield clean;
      return;
    }

    if (GRID_CELLS - cellsUsed < remShape[idx]) return;

    const id = ordered[idx];
    const rots = rotData.get(id);
    if (!rots || rots.length === 0) { yield* search(idx + 1, resume); return; }

    const prevSame = (idx > 0 && ordered[idx - 1] === id) ? placements[idx - 1] : null;
    const prevDeg = prevSame ? prevSame.rotation : -1;
    const prevRow = prevSame ? prevSame.row : -1;
    const prevCol = prevSame ? prevSame.col : -1;

    const isSpinnerOrRep = id === 'spinner' || id === 'repeater_2s' || id === 'repeater_4s';
    const maxSatisfiable = rem2s[idx + 1] * 2 + rem4s[idx + 1];

    const def = defById.get(id);
    const hasEnergy = def && def.energyPorts.length > 0;

    const hasResume = resume && idx < resume.length && resume[idx] && resume[idx].cid === id;
    const startRi = hasResume ? resume[idx].ri : 0;
    const startPi = hasResume ? resume[idx].pi : 0;
    let resumeMatched = !hasResume;

    for (let ri = startRi; ri < rots.length; ri++) {
      const rot = rots[ri];
      const { deg, shape, cellOffsets, energyPorts, bioPorts, rotPeri, periRelCells, positions } = rot;
      if (prevSame && deg < prevDeg) continue;
      const sameDeg = (deg === prevDeg);
      const len = positions.length;
      const piFrom = (ri === startRi) ? startPi : 0;
      for (let pi = piFrom; pi < len; pi += 2) {
        const row = positions[pi];
        const col = positions[pi + 1];
        if (sameDeg && (row < prevRow || (row === prevRow && col <= prevCol))) continue;
        const baseIdx = row * C + col;
        if (hasOverlapFlat(cellOffsets, baseIdx)) continue;

        // Phase 2: depth-0 branch-range slicing for parallel workers.
        // At depth 0 the grid is empty, so each (ri, pi) maps 1:1 to a branch index.
        if (idx === 0) {
          if (depth0BranchIdx >= branchEnd) return;
          if (depth0BranchIdx < branchStart) { depth0BranchIdx++; continue; }
        }

        const p = {
          id: placements.length+1, componentId: id, row, col, rotation: deg,
          rotatedShape: shape, rotatedPorts: energyPorts, rotatedBioPorts: bioPorts, rotatedPeripheral: rotPeri,
          _cellOffsets: cellOffsets, _ri: ri, _pi: pi
        };
        pushPlacement(p, periRelCells);
        let ok = (!isSpinnerOrRep || unmetCount <= maxSatisfiable);
        if (ok && (id === 'repeater_2s' || id === 'repeater_4s')) {
          const ports = p.rotatedPorts;
          let matched = false;
          for (let pj = 0; pj < ports.length; pj++) {
            const k = portKey(p.row + ports[pj].cell[0], p.col + ports[pj].cell[1], _SIDE_IDX[ports[pj].side]);
            if (targetCoverKeyCount.has(k)) { matched = true; break; }
          }
          if (!matched) ok = false;
        }
        if (ok && hasEnergy && !canReachBus(p)) ok = false;
        if (ok) {
          const childResume = (!resumeMatched && ri === startRi && pi === startPi) ? resume : null;
          yield* search(idx + 1, childResume);
          if (!resumeMatched && ri === startRi && pi === startPi) resumeMatched = true;
        }
        popPlacement();
        if (idx === 0) {
          depth0BranchIdx++;
          if (onBranchComplete) onBranchComplete();
        }
      }
    }
  }

  yield* search(0, resumePath);
}

// ── Worker message protocol ─────────────────────────────────────────────────

let stopRequested = false;
let activeRun = false;

self.onmessage = function (e) {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      componentLib = msg.componentLib;
      self.postMessage({ type: 'ready' });
      break;
    case 'start':
      if (activeRun) {
        self.postMessage({ type: 'error', message: 'already running' });
        return;
      }
      stopRequested = false;
      activeRun = true;
      runSearch(msg);
      break;
    case 'stop':
      stopRequested = true;
      break;
  }
};

function runSearch(params) {
  const { nonWireIds, grid, resumePath, branchStart = 0, branchEnd = Infinity, workerId = 0 } = params;
  const stateRef = {};
  let checked = (params.resumeStats?.checked) || 0;
  let valid   = (params.resumeStats?.valid)   || 0;
  let ticks   = (params.resumeStats?.ticks)   || 0;
  let bestScore = (params.resumeStats?.bestScore) || -Infinity;
  let completedBranches = (params.resumeStats?.completedBranches) || 0;
  let lastProgress = Date.now();
  const PROGRESS_INTERVAL_MS = 1000;

  const gen = bruteForcePlacements(nonWireIds, grid, () => {
    completedBranches++;
  }, resumePath, stateRef, { branchStart, branchEnd });

  function sendProgress() {
    const path = stateRef.getPath ? stateRef.getPath() : [];
    const currentBranchIdx = stateRef.getCurrentBranchIdx ? stateRef.getCurrentBranchIdx() : branchStart;
    self.postMessage({
      type: 'progress',
      workerId,
      stats: { checked, valid, ticks, completedBranches, bestScore },
      path,
      currentBranchIdx
    });
  }

  function step() {
    if (stopRequested) {
      activeRun = false;
      sendProgress();
      self.postMessage({ type: 'stopped', workerId });
      return;
    }

    const batchDeadline = Date.now() + 50; // worker can use longer batches (no UI blocking risk)
    while (Date.now() < batchDeadline) {
      const { value: pl, done } = gen.next();
      if (done) {
        activeRun = false;
        sendProgress();
        self.postMessage({ type: 'done', workerId, stats: { checked, valid, ticks, completedBranches, bestScore } });
        return;
      }
      if (pl === null) { ticks++; continue; }
      checked++;

      let finalPl = pl;
      if (!isLayoutValid(pl, grid)) {
        const wired = tryAddWires(pl, grid);
        if (!wired || !isLayoutValid(wired, grid)) continue;
        finalPl = wired;
      }
      valid++;
      const score = scoreLayout(finalPl, grid);
      if (score > bestScore) {
        bestScore = score;
        self.postMessage({
          type: 'leaf',
          workerId,
          layout: finalPl,
          score,
          isFirst: valid === 1,
          stats: { checked, valid, ticks, completedBranches }
        });
      }
    }

    const now = Date.now();
    if (now - lastProgress >= PROGRESS_INTERVAL_MS) {
      lastProgress = now;
      sendProgress();
    }
    setTimeout(step, 0);
  }

  step();
}
