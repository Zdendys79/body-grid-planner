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
// Cost gradient (lower = better):
//   - valid wired layout:       -scoreLayout(wired)                  ≈ -400k..-200k
//   - wired but constraint-bad: baseCost + 30000                     ≈ -370k..-170k
//   - unwireable (no path):     pseudo-base + unpowered * 5000       ≈ -100k..+200k
//
// The unwireable branch needs a gradient — count how many energy components
// can't be powered by direct port/bus access, and penalise per-unpowered.
// This way SA can move from "many isolated" → "fewer isolated" → "wired" →
// "valid" without facing infinite cliffs.
function saComputeCost(nonWirePlacements, grid) {
  const wired = tryAddWires(nonWirePlacements, grid);
  if (wired) {
    const baseCost = -scoreLayout(wired, grid);
    if (isLayoutValid(wired, grid)) return baseCost;
    return baseCost + 30000;
  }
  // Unwireable — gradient based on count of un-powerable components
  const poweredSet = computePoweredSet(nonWirePlacements, grid.rows, grid.cols);
  let unpowered = 0;
  for (let i = 0; i < nonWirePlacements.length; i++) {
    const p = nonWirePlacements[i];
    const def = componentLib.find(d => d.id === p.componentId);
    if (def && def.energyPorts.length > 0 && !poweredSet.has(i)) unpowered++;
  }
  // pseudo-baseline + linear penalty per unpowered component
  return 50000 + unpowered * 3000;
}

// Main SA loop. Runs until shouldStop() returns true (no maxIter cap).
// SA may transiently accept invalid neighbours to escape local minima, but
// only VALID layouts are reported via reportLeaf — invalid results are useless.
function simulatedAnneal(initialNonWire, grid, options = {}) {
  const tStart        = options.tStart        ?? 30000;
  const tEnd          = options.tEnd          ?? 0.1;
  const coolingRate   = options.coolingRate   ?? 0.9999;
  const restartAfter  = options.restartAfter  ?? 5000;
  const progressEvery = options.progressEvery ?? 500;
  const progressCb    = options.progressCb;
  const shouldStop    = options.shouldStop;
  const reportLeaf    = options.reportLeaf;

  let current = initialNonWire.map(p => ({ ...p }));
  let currentCost = saComputeCost(current, grid);
  let best = current.map(p => ({ ...p }));
  let bestCost = currentCost;
  // Track best VALID layout separately — only this is reported as a result
  let bestValidCost = Infinity;
  let bestValidLayout = null;
  let T = tStart;
  let lastImprovement = 0;
  let iter = 0;

  // Run indefinitely until shouldStop signals
  while (true) {
    if (shouldStop && shouldStop()) break;

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
        }
        // Check if this neighbour is a VALID layout that beats our best-valid
        const nWired = tryAddWires(neighbour, grid);
        if (nWired && isLayoutValid(nWired, grid)) {
          const validScore = scoreLayout(nWired, grid);
          if (-validScore < bestValidCost) {
            bestValidCost = -validScore;
            bestValidLayout = nWired;
            if (reportLeaf) reportLeaf(nWired, validScore);
          }
        }
      }
    }

    T *= coolingRate;
    if (T < tEnd) T = tEnd;

    // Restart from best if stuck — reheat partially
    if (iter - lastImprovement > restartAfter) {
      T = tStart * 0.7;
      current = best.map(p => ({ ...p }));
      currentCost = bestCost;
      lastImprovement = iter;
    }

    if (progressCb && (iter % progressEvery === 0)) {
      progressCb(iter, T, currentCost, bestCost, bestValidCost);
    }
    iter++;
  }

  return { placements: best, cost: bestCost, bestValidLayout, bestValidCost, iters: iter };
}
