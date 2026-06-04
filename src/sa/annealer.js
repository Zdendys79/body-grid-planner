// src/sa/annealer.js — Simulated Annealing main loop.
//
// State: an array of non-wire placements (positions/rotations/shape).
// At each step the move generator produces a neighbour state. The neighbour
// is fully evaluated by adding wires (tryAddWires) and scoring (scoreLayout).
// Lower cost = better. SA accepts improving moves always, worsening moves
// with probability e^(-ΔE / T). T cools each iteration.
//
// The cost function uses scoreLayout (negated) plus heavy penalties for
// states that cannot be wired or violate hard constraints.

// Compute SA cost for a placement list (non-wire components only).
// Penalty weights are calibrated so SA can probabilistically tunnel through
// invalid regions at high T (e.g. e^(-100000/20000) = e^-5 ≈ 0.007).
function saComputeCost(nonWirePlacements, grid) {
  const wired = tryAddWires(nonWirePlacements, grid);
  if (!wired) {
    // Cannot be wired — very high penalty, mostly unreachable for SA.
    return 800000 + nonWirePlacements.length * 1000;
  }
  // Soft cost from scoreLayout (negated so lower = better)
  const baseCost = -scoreLayout(wired, grid);
  if (!isLayoutValid(wired, grid)) {
    // Wired but fails Spinner-Repeater / Repeater-target constraints.
    return baseCost + 100000;
  }
  return baseCost;
}

// Main SA loop. Returns { placements (non-wire), cost, wiredLayout, iters }.
// progressCb(iter, T, currentCost, bestCost) — called every N iterations.
function simulatedAnneal(initialNonWire, grid, options = {}) {
  const tStart        = options.tStart        ?? 20000;
  const tEnd          = options.tEnd          ?? 0.01;
  const coolingRate   = options.coolingRate   ?? 0.9999;
  const maxIter       = options.maxIter       ?? 200000;
  const restartAfter  = options.restartAfter  ?? 8000;   // restart from best if stuck
  const progressEvery = options.progressEvery ?? 1000;
  const progressCb    = options.progressCb;
  const shouldStop    = options.shouldStop;
  const reportLeaf    = options.reportLeaf;

  let current = initialNonWire.map(p => ({ ...p }));
  let currentCost = saComputeCost(current, grid);
  let best = current.map(p => ({ ...p }));
  let bestCost = currentCost;
  let T = tStart;
  let lastImprovement = 0;

  for (let iter = 0; iter < maxIter; iter++) {
    if (shouldStop && shouldStop()) break;

    // Retry move generation until we get a non-null neighbour — dense layouts
    // produce lots of null moves (overlap/out-of-bounds), so we'd otherwise
    // spin the iteration counter without doing real work.
    let neighbour = null;
    for (let attempt = 0; attempt < 30 && !neighbour; attempt++) {
      neighbour = saGenerateMove(current, grid);
    }
    if (neighbour) {
      const nCost = saComputeCost(neighbour, grid);
      const delta = nCost - currentCost;
      if (delta < 0 || Math.random() < Math.exp(-delta / T)) {
        current = neighbour;
        currentCost = nCost;
        if (currentCost < bestCost) {
          best = current.map(p => ({ ...p }));
          bestCost = currentCost;
          lastImprovement = iter;
          if (reportLeaf) reportLeaf(best, bestCost);
        }
      }
    }

    // Cool down
    T *= coolingRate;
    if (T < tEnd) T = tEnd;

    // Restart from best if stuck
    if (iter - lastImprovement > restartAfter) {
      T = tStart * 0.5;
      current = best.map(p => ({ ...p }));
      currentCost = bestCost;
      lastImprovement = iter;
    }

    if (progressCb && (iter % progressEvery === 0)) {
      progressCb(iter, T, currentCost, bestCost);
    }
  }

  // Final wiring of best state
  const wired = tryAddWires(best, grid) || [];
  return { placements: best, cost: bestCost, wiredLayout: wired };
}
