// sa-worker.js — Simulated Annealing in a Web Worker.
// Receives nonWireIds + grid, builds an initial state (shell pack + random fill),
// runs SA, periodically reports progress and best layouts.
//
// Message protocol:
//   Main → Worker:
//     {type:'init', componentLib}                          → 'ready'
//     {type:'start', nonWireIds, grid, options, workerId}  — begin
//     {type:'stop'}                                        — cancel
//   Worker → Main:
//     {type:'ready'}
//     {type:'progress', workerId, iter, T, currentCost, bestCost, elapsedMs}
//     {type:'leaf', workerId, layout, score, isFirst}      — better solution found
//     {type:'done', workerId, finalLayout, finalCost, iters}
//     {type:'stopped', workerId}
//     {type:'error', message}

importScripts(
  'src/constants.js?v=64',
  'src/optimizer/rotation.js?v=64',
  'src/optimizer/bus.js?v=64',
  'src/optimizer/placement.js?v=64',
  'src/optimizer/score.js?v=64',
  'src/optimizer/validate.js?v=64',
  'src/sa/shell.js?v=64',
  'src/sa/moves.js?v=64',
  'src/sa/annealer.js?v=64',
  'optimizer.js?v=64'
);

let componentLib = [];
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
      if (activeRun) { self.postMessage({ type: 'error', message: 'already running' }); return; }
      stopRequested = false;
      activeRun = true;
      runSA(msg);
      break;
    case 'stop':
      stopRequested = true;
      break;
  }
};

// Build initial non-wire placement list:
//   1. Shell pack as many components as possible into top-right corner
//   2. Place the remainder by greedy random placement (any non-overlapping slot)
//   3. If something can't be placed at all, return null (search aborts)
function buildInitialState(nonWireIds, grid) {
  const { shellPlacements, remaining } = packShell(nonWireIds, grid);

  const all = shellPlacements.slice();
  const occupied = new Set();
  for (const p of all) {
    for (const [r, c] of p.rotatedShape) occupied.add(`${p.row+r},${p.col+c}`);
    if (p.rotatedPeripheral) {
      const d = SIDE_DELTA[p.rotatedPeripheral.port.side];
      const baseR = p.row + p.rotatedPeripheral.port.cell[0] + d.dr;
      const baseC = p.col + p.rotatedPeripheral.port.cell[1] + d.dc;
      for (const [pr, pc] of p.rotatedPeripheral.shape) {
        occupied.add(`${baseR+pr},${baseC+pc}`);
      }
    }
  }

  // Random fill for the remainder — prefer positions near the bus
  for (const id of remaining) {
    const def = componentLib.find(d => d.id === id);
    if (!def) return null;
    let placed = false;
    const degs = getUniqueDegs(def);
    // Try several random positions and rotations
    for (let attempt = 0; attempt < 200 && !placed; attempt++) {
      const deg = degs[Math.floor(Math.random() * degs.length)];
      const { shape, energyPorts, bioPorts } = rotateComponent(def, deg);
      const bounds = getBounds(shape);
      if (bounds.height > grid.rows || bounds.width > grid.cols) continue;
      const row = Math.floor(Math.random() * (grid.rows - bounds.height + 1));
      const col = Math.floor(Math.random() * (grid.cols - bounds.width + 1));
      let ok = true;
      for (const [r, c] of shape) {
        if (occupied.has(`${row+r},${col+c}`)) { ok = false; break; }
      }
      if (!ok) continue;
      const rotPeri = buildRotatedPeri(def, deg);
      all.push({
        componentId: id,
        row, col, rotation: deg,
        rotatedShape: shape,
        rotatedPorts: energyPorts,
        rotatedBioPorts: bioPorts,
        rotatedPeripheral: rotPeri
      });
      for (const [r, c] of shape) occupied.add(`${row+r},${col+c}`);
      if (rotPeri) {
        const d = SIDE_DELTA[rotPeri.port.side];
        const baseR = row + rotPeri.port.cell[0] + d.dr;
        const baseC = col + rotPeri.port.cell[1] + d.dc;
        for (const [pr, pc] of rotPeri.shape) {
          occupied.add(`${baseR+pr},${baseC+pc}`);
        }
      }
      placed = true;
    }
    if (!placed) return null;
  }
  return all;
}

function runSA(params) {
  const { nonWireIds, grid, workerId = 0 } = params;
  const options = params.options || {};

  const startTime = Date.now();

  // Build initial state (shell + random fill)
  let initial = null;
  for (let tryNum = 0; tryNum < 5 && !initial; tryNum++) {
    initial = buildInitialState(nonWireIds, grid);
  }
  if (!initial) {
    activeRun = false;
    self.postMessage({ type: 'error', workerId, message: 'Nelze sestavit počáteční rozložení — gridu je málo místa.' });
    return;
  }

  let bestKnownCost = Infinity;
  let bestKnownLayout = null;

  const result = simulatedAnneal(initial, grid, {
    tStart:        options.tStart        || 20000,
    tEnd:          options.tEnd          || 0.01,
    coolingRate:   options.coolingRate   || 0.99995,
    maxIter:       options.maxIter       || 500000,
    restartAfter:  options.restartAfter  || 10000,
    progressEvery: options.progressEvery || 1000,
    shouldStop:    () => stopRequested,
    progressCb: (iter, T, currentCost, bestCost) => {
      self.postMessage({
        type: 'progress', workerId,
        iter, T, currentCost, bestCost,
        elapsedMs: Date.now() - startTime
      });
    },
    reportLeaf: (best, bestCost) => {
      const wired = tryAddWires(best, grid);
      if (!wired || !isLayoutValid(wired, grid)) return;
      const score = -bestCost; // SA cost = -scoreLayout
      const isFirst = (bestKnownLayout === null);
      bestKnownLayout = wired;
      bestKnownCost = bestCost;
      self.postMessage({
        type: 'leaf', workerId,
        layout: wired, score, isFirst
      });
    }
  });

  activeRun = false;
  if (stopRequested) {
    self.postMessage({ type: 'stopped', workerId });
  } else {
    self.postMessage({
      type: 'done', workerId,
      finalLayout: result.wiredLayout, finalCost: result.cost,
      iters: options.maxIter
    });
  }
}
