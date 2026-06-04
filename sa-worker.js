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
  'src/constants.js?v=76',
  'src/optimizer/rotation.js?v=76',
  'src/optimizer/bus.js?v=76',
  'src/optimizer/placement.js?v=76',
  'src/optimizer/score.js?v=76',
  'src/optimizer/validate.js?v=76',
  'src/sa/shell.js?v=76',
  'src/sa/moves.js?v=76',
  'src/sa/clusters.js?v=76',
  'src/sa/greedy.js?v=76',
  'src/sa/annealer.js?v=76',
  'optimizer.js?v=76'
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
  //   1. User's current layout (if valid) — preserves existing work
  //   2. Shell pack + greedy fill with cluster substitution (per-worker decomposition)
  let seed = null;
  let seedExpanded = null;
  let seedWired = null;
  let seedValid = false;
  let seedScore = -Infinity;
  let seedSource = '';

  if (initialPlacements && initialPlacements.length > 0) {
    const userSeed = initialPlacements.map(p => ({
      componentId: p.componentId,
      row: p.row, col: p.col, rotation: p.rotation,
      rotatedShape: p.rotatedShape,
      rotatedPorts: p.rotatedPorts,
      rotatedBioPorts: p.rotatedBioPorts || [],
      rotatedPeripheral: p.rotatedPeripheral
    }));
    const uWired = tryAddWires(userSeed, grid);
    if (uWired && isLayoutValid(uWired, grid)) {
      seed = userSeed;
      seedExpanded = userSeed;
      seedWired = uWired;
      seedValid = true;
      seedScore = scoreLayout(uWired, grid);
      seedSource = `uživatelův layout (${userSeed.length} součástek, validní)`;
    }
  }

  if (!seed) {
    // Fall back to cluster-substituted shell+greedy
    const allDecompositions = enumerateDecompositions(nonWireIds);
    const decomposition = pickDecompositionForWorker(allDecompositions, workerId);
    const effectiveIds = substituteClusterIds(nonWireIds, decomposition);
    const desc = decomposition.clusters.length > 0
      ? decomposition.clusters.map(c => `${c.pattern}${c.spinners}`).join(' + ')
      : '(žádné clustery)';
    console.log(`[SA worker ${workerId}] Decomposition: ${desc} (z ${nonWireIds.length} ID na ${effectiveIds.length})`);
    try {
      seed = buildShellThenGreedy(effectiveIds, grid);
    } catch (e) {
      activeRun = false;
      self.postMessage({ type: 'error', workerId, message: 'Greedy seed selhal: ' + e.message });
      return;
    }
    if (!seed || seed.length === 0) {
      activeRun = false;
      self.postMessage({ type: 'error', workerId, message: 'Nelze sestavit seed.' });
      return;
    }
    seedExpanded = expandClustersInPlacements(seed);
    seedWired = tryAddWires(seedExpanded, grid);
    seedValid = seedWired && isLayoutValid(seedWired, grid);
    seedScore = seedValid ? scoreLayout(seedWired, grid) : -Infinity;
    seedSource = `shell+greedy s ${desc}`;
  }
  console.log(`[SA worker ${workerId}] Seed: ${seedSource}, valid=${seedValid}, score=${seedScore}`);

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
