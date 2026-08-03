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

// Compute SA cost for a placement list (may include cluster placements),
// returning the intermediate wired/valid/score too — the main loop's
// accepted-move leaf-check needs exactly these and used to recompute them
// from scratch via a second tryAddWires+isLayoutValid+scoreLayout pass,
// doubling the single most expensive part of every accepted iteration
// (tryAddWires is O(components) BFS passes — see profiling notes below).
// Clusters are expanded to their individual components before validation —
// the search treats clusters as atomic placements, but scoring sees them
// as the individual Spinner/Repeater components they actually are.
function saComputeCostDetailed(nonWirePlacements, grid) {
  // Expand any cluster placements to individuals (Spinner/Rep_2s/Rep_4s).
  // If no clusters present, expandClustersInPlacements returns input unchanged.
  const expanded = (typeof expandClustersInPlacements === 'function')
    ? expandClustersInPlacements(nonWirePlacements)
    : nonWirePlacements;

  const wired = tryAddWires(expanded, grid);
  if (wired) {
    const valid = isLayoutValid(wired, grid);
    const score = scoreLayout(wired, grid);
    const baseCost = -score;
    return { cost: valid ? baseCost : baseCost + 30000, wired, valid, score };
  }
  const poweredSet = computePoweredSet(expanded, grid.rows, grid.cols);
  let unpowered = 0;
  for (let i = 0; i < expanded.length; i++) {
    const p = expanded[i];
    const def = componentLib.find(d => d.id === p.componentId);
    if (def && def.energyPorts.length > 0 && !poweredSet.has(i)) unpowered++;
  }
  return { cost: 50000 + unpowered * 3000, wired: null, valid: false, score: null };
}

function saComputeCost(nonWirePlacements, grid) {
  return saComputeCostDetailed(nonWirePlacements, grid).cost;
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
      const nDetail = saComputeCostDetailed(neighbour, grid);
      const nCost = nDetail.cost;
      const delta = nCost - currentCost;
      if (delta < 0 || Math.random() < Math.exp(-delta / T)) {
        current = neighbour;
        currentCost = nCost;
        if (currentCost < bestCost) {
          best = current.map(p => ({ ...p }));
          bestCost = currentCost;
          lastImprovement = iter;
        }
        // Reuse nDetail's wired/valid/score from the cost computation above
        // instead of recomputing tryAddWires+isLayoutValid+scoreLayout again.
        if (nDetail.wired && nDetail.valid && -nDetail.score < bestValidCost) {
          bestValidCost = -nDetail.score;
          bestValidLayout = nDetail.wired;
          if (reportLeaf) reportLeaf(nDetail.wired, nDetail.score);
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
