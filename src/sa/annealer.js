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
// Returns Infinity if the state is unsalvageable.
function saComputeCost(nonWirePlacements, grid) {
  // Try to add wires to make every energy component reachable
  const wired = tryAddWires(nonWirePlacements, grid);
  if (!wired) {
    // Layout cannot be wired — high penalty, but encode some gradient so SA
    // can still feel its way toward improvement (more components = worse).
    return 1e9 + nonWirePlacements.length;
  }
  if (!isLayoutValid(wired, grid)) {
    // Layout wires up but fails hard constraints (Spinner without Repeater etc.)
    const wires = wired.filter(p => p.componentId === 'wire').length;
    return 1e7 + wires * 100;
  }
  // Soft cost = negated scoreLayout (scoreLayout: higher = better)
  // scoreLayout = quality * 4 - wires * 5000 + workingSet.size * 50000
  return -scoreLayout(wired, grid);
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

    const neighbour = saGenerateMove(current, grid);
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
