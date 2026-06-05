// sa-worker.js — Simulated Annealing in a Web Worker.
// Seed strategy: Shell pack (N+E edges) → greedy fill interior → per-worker
// perturbation → SA. This guarantees each worker starts at a valid (or near-
// valid) layout AND at structurally distinct points in the search space.
//
// Message protocol:
//   Main → Worker:
//     {type:'init', componentLib}                          → 'ready'
//     {type:'start', nonWireIds, grid, options, workerId}  — begin
//     {type:'stop'}                                        — cancel
//   Worker → Main:
//     {type:'ready'}
//     {type:'progress', workerId, iter, T, currentCost, bestCost, bestValidCost, elapsedMs}
//     {type:'leaf', workerId, layout, score, isFirst}      — VALID layout improvement
//     {type:'stopped', workerId}
//     {type:'error', message}

importScripts(
  'src/constants.js?v=92',
  'src/optimizer/rotation.js?v=92',
  'src/optimizer/bus.js?v=92',
  'src/optimizer/placement.js?v=92',
  'src/optimizer/score.js?v=92',
  'src/optimizer/validate.js?v=92',
  'src/sa/shell.js?v=92',
  'src/sa/moves.js?v=92',
  'src/sa/clusters.js?v=92',
  'src/sa/greedy.js?v=92',
  'src/sa/annealer.js?v=92',
  'optimizer.js?v=92'
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

// Per-worker strategy: each worker gets a distinct combination of
//   (move bias profile, perturbation count)
// so all six explore the search space from structurally different points.
const WORKER_PROFILES = [
  { bias: 'balanced', perturb:  0 }, // worker 0: clean shell+greedy, balanced moves
  { bias: 'local',    perturb:  3 }, // worker 1: slight perturb, fine-tune
  { bias: 'rotate',   perturb:  8 }, // worker 2: rotation-focused, mid perturb
  { bias: 'swap',     perturb: 12 }, // worker 3: swap-focused, more perturb
  { bias: 'jump',     perturb: 18 }, // worker 4: aggressive relocate, big perturb
  { bias: 'balanced', perturb: 25 }  // worker 5: balanced moves, very different start
];

function runSA(params) {
  const { nonWireIds, grid, workerId = 0, initialPlacements } = params;
  const options = params.options || {};
  const startTime = Date.now();

  const profile = WORKER_PROFILES[workerId % WORKER_PROFILES.length];
  setSaMoveBias(profile.bias);
  console.log(`[SA worker ${workerId}] Profile: bias=${profile.bias}, perturb=${profile.perturb}`);

  // === Phase 0a: Register cluster defs for ALL workers. ===
  // Even workers that start from user's state will benefit from registered
  // cluster defs (SA's relocate-move can introduce clusters during search).
  const allClusterDefs = enumerateAllClusterDefs(nonWireIds);
  registerClusterDefs(allClusterDefs);
  console.log(`[SA worker ${workerId}] Registered ${allClusterDefs.length} cluster def variants`);

  // === Phase 0b: Seed selection priority ===
  //   1. User's current layout if structurally sane (bounds + no overlap).
  //      Wire-validity NOT required — SA's cost function handles invalid
  //      states with a penalty; what matters is preserving the full component
  //      count so SA never reports a leaf with fewer components than the user has.
  //   2. Multi-strategy greedy chain: each tries to place ALL components;
  //      next strategy fires if any are dropped.
  let seed = null;
  let seedExpanded = null;
  let seedWired = null;
  let seedValid = false;
  let seedScore = -Infinity;
  let seedSource = '';

  function _isUserSeedSane(userSeed) {
    const occupied = new Set();
    for (const p of userSeed) {
      if (!p.rotatedShape) return false;
      for (const [r, c] of p.rotatedShape) {
        const gr = p.row + r, gc = p.col + c;
        if (gr < 0 || gr >= grid.rows || gc < 0 || gc >= grid.cols) return false;
        const key = `${gr},${gc}`;
        if (occupied.has(key)) return false;
        occupied.add(key);
      }
      // Peripheral cells (Biocell etc.) must also fit in grid + not overlap
      if (p.rotatedPeripheral) {
        const peri = p.rotatedPeripheral;
        const d = SIDE_DELTA[peri.port.side];
        const sR = p.row + peri.port.cell[0] + d.dr;
        const sC = p.col + peri.port.cell[1] + d.dc;
        for (const [r, c] of peri.shape) {
          const gr = sR + r, gc = sC + c;
          if (gr < 0 || gr >= grid.rows || gc < 0 || gc >= grid.cols) return false;
          const key = `${gr},${gc}`;
          if (occupied.has(key)) return false;
          occupied.add(key);
        }
      }
    }
    return true;
  }

  if (initialPlacements && initialPlacements.length > 0) {
    const userSeed = initialPlacements.map(p => ({
      componentId: p.componentId,
      row: p.row, col: p.col, rotation: p.rotation,
      rotatedShape: p.rotatedShape,
      rotatedPorts: p.rotatedPorts,
      rotatedBioPorts: p.rotatedBioPorts || [],
      rotatedPeripheral: p.rotatedPeripheral
    }));
    if (_isUserSeedSane(userSeed)) {
      seed = userSeed;
      seedExpanded = userSeed;
      seedWired = tryAddWires(userSeed, grid);
      seedValid = seedWired && isLayoutValid(seedWired, grid);
      seedScore = seedValid ? scoreLayout(seedWired, grid) : -Infinity;
      seedSource = seedValid
        ? `user layout (${userSeed.length} components, valid)`
        : `user layout (${userSeed.length} components, invalid — SA will fix)`;
    }
  }

  if (!seed) {
    // Multi-strategy fallback chain. Each strategy returns expanded placements.
    const targetCount = nonWireIds.length;
    const allDecompositions = enumerateDecompositions(nonWireIds);
    const decomposition = pickDecompositionForWorker(allDecompositions, workerId);
    const effectiveIds = substituteClusterIds(nonWireIds, decomposition);
    const desc = decomposition.clusters.length > 0
      ? decomposition.clusters.map(c => `${c.pattern}${c.spinners}`).join(' + ')
      : '(no clusters)';
    console.log(`[SA worker ${workerId}] Decomposition: ${desc} (from ${nonWireIds.length} IDs to ${effectiveIds.length})`);

    // Each strategy: build returns SA-level placements (may contain clusters),
    // expand returns the post-expansion individual list (for the count check).
    // SA needs the un-expanded seed so moves operate on clusters as atoms.
    const strategies = [
      { name: `shell+greedy with ${desc}`,
        build: () => buildShellThenGreedy(effectiveIds, grid),
        expand: (s) => expandClustersInPlacements(s) },
      { name: 'shell+greedy no clusters',
        build: () => buildShellThenGreedy(nonWireIds, grid),
        expand: (s) => s },
      { name: 'pure greedy no clusters',
        build: () => buildGreedyInitial(nonWireIds, grid, []),
        expand: (s) => s }
    ];

    let chosen = null;
    for (const strat of strategies) {
      try {
        const candidate = strat.build();
        const expanded = candidate ? strat.expand(candidate) : null;
        const placed = expanded ? expanded.length : 0;
        if (placed >= targetCount) {
          chosen = { seed: candidate, expanded, source: strat.name };
          break;
        }
        console.log(`[SA worker ${workerId}] ${strat.name}: ${placed}/${targetCount} fit → trying next strategy.`);
      } catch (e) {
        console.warn(`[SA worker ${workerId}] ${strat.name} threw: ${e.message}`);
      }
    }

    if (!chosen) {
      activeRun = false;
      self.postMessage({
        type: 'error', workerId,
        message: `Cannot place all ${targetCount} components in grid ${grid.rows}x${grid.cols}. Expand body or reduce set.`
      });
      return;
    }

    seed = chosen.seed;            // SA-level (may contain clusters)
    seedExpanded = chosen.expanded; // individual placements for scoring/wiring
    seedWired = tryAddWires(seedExpanded, grid);
    seedValid = seedWired && isLayoutValid(seedWired, grid);
    seedScore = seedValid ? scoreLayout(seedWired, grid) : -Infinity;
    seedSource = chosen.source;
  }
  console.log(`[SA worker ${workerId}] Seed: ${seedSource}, valid=${seedValid}, score=${seedScore}, count=${seedExpanded.length}`);

  // === Phase 2: perturb for structural diversity ===
  const perturbed = profile.perturb > 0 ? perturbInitial(seed, grid, profile.perturb) : seed;
  const pExpanded = expandClustersInPlacements(perturbed);
  const pWired = tryAddWires(pExpanded, grid);
  const pValid = pWired && isLayoutValid(pWired, grid);
  const pScore = pValid ? scoreLayout(pWired, grid) : -Infinity;
  console.log(`[SA worker ${workerId}] Po perturbaci: valid=${pValid}, score=${pScore}`);

  let bestKnownCost = Infinity;
  let bestKnownLayout = null;

  // If the seed itself is already valid, report it immediately so the user
  // sees something on screen within ~100 ms instead of waiting for SA.
  if (seedValid) {
    bestKnownCost = -seedScore;
    bestKnownLayout = seedWired;
    self.postMessage({ type: 'leaf', workerId, layout: seedWired, score: seedScore, isFirst: true });
  }

  // === Phase 3: SA from perturbed state ===
  simulatedAnneal(perturbed, grid, {
    tStart:        options.tStart        || 30000,
    tEnd:          options.tEnd          || 0.1,
    coolingRate:   options.coolingRate   || 0.99997,
    restartAfter:  options.restartAfter  || 5000,
    progressEvery: options.progressEvery || 500,
    shouldStop:    () => stopRequested,
    progressCb: (iter, T, currentCost, bestCost, bestValidCost) => {
      self.postMessage({
        type: 'progress', workerId,
        iter, T, currentCost, bestCost, bestValidCost,
        elapsedMs: Date.now() - startTime
      });
    },
    reportLeaf: (wiredLayout, score) => {
      const isFirst = (bestKnownLayout === null);
      bestKnownLayout = wiredLayout;
      bestKnownCost = -score;
      self.postMessage({ type: 'leaf', workerId, layout: wiredLayout, score, isFirst });
    }
  });

  activeRun = false;
  self.postMessage({ type: 'stopped', workerId });
}
