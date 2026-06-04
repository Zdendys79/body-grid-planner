// src/sa/clusters.js — Spinner-Repeater cluster pre-baking.
//
// Spinner requires Repeater adjacency (Rep_2s on any side, OR Rep_4s on both).
// One Repeater can serve up to two Spinners when placed between them, so
// these constraints naturally tile into linear chains:
//
//   Pattern A (Rep_2s):  S - R2 - S - R2 - S - R2 - S - ...
//     N spinners need (N-1) Rep_2s
//
//   Pattern B (Rep_4s):  R4 - S - R4 - S - R4 - S - R4 - ...
//     M spinners need (M+1) Rep_4s
//
// Instead of letting the search optimize the constraint blindly, we synthesise
// the longest possible chain as a single composite "cluster component" and
// substitute it in nonWireIds. The search then treats the cluster as one
// atomic placement — much smaller search space, every cluster placement is
// guaranteed valid by construction.
//
// LIMITATION: this initial implementation only supports the canonical
// horizontal orientation (rotation 0). Cluster can be placed but not rotated
// 90/180/270 by the search. TODO: pre-rotate cluster variants.

// Count S/R/R4 in a non-wire id list (others returned separately).
function _saCountAvailable(nonWireIds) {
  const counts = { spinner: 0, repeater_2s: 0, repeater_4s: 0 };
  const others = [];
  for (const id of nonWireIds) {
    if (counts.hasOwnProperty(id)) counts[id]++;
    else others.push(id);
  }
  return { counts, others };
}

// Enumerate ALL cluster def variants supported by the available components.
// Lengths from minimum chain up to the largest possible chain given budget.
// Called once at the start of the search; resulting defs are registered into
// componentLib so the search has full freedom over which sizes to actually use.
function enumerateAllClusterDefs(nonWireIds) {
  const { counts } = _saCountAvailable(nonWireIds);
  const defs = [];

  // Pattern A — S-R2-S chain; needs 2+ spinners and 1+ rep_2s.
  // Max chain length = min(spinners, rep_2s + 1)
  if (counts.spinner >= 2 && counts.repeater_2s >= 1) {
    const maxA = Math.min(counts.spinner, counts.repeater_2s + 1);
    for (let n = 2; n <= maxA; n++) {
      const def = buildClusterDef('A', n);
      if (def) defs.push(def);
    }
  }
  // Pattern B — R4-S-R4 chain; needs 1+ spinners and 2+ rep_4s.
  if (counts.spinner >= 1 && counts.repeater_4s >= 2) {
    const maxB = Math.min(counts.spinner, counts.repeater_4s - 1);
    for (let m = 1; m <= maxB; m++) {
      const def = buildClusterDef('B', m);
      if (def) defs.push(def);
    }
  }
  return defs;
}

// Enumerate all valid decompositions (ways to partition components into clusters).
// Returns list of { clusters: [{pattern, spinners}, ...], remaining: {...} }.
// Uses canonical ordering (cluster sizes non-decreasing) to avoid duplicates.
function enumerateDecompositions(nonWireIds) {
  const { counts } = _saCountAvailable(nonWireIds);
  const results = [];

  function recurseA(remS, remR2, current, minSize) {
    // Record current state as a candidate (only if non-empty)
    if (current.length > 0) results.push({ clusters: current.slice() });
    const maxN = Math.min(remS, remR2 + 1);
    for (let n = minSize; n <= maxN; n++) {
      if (n - 1 > remR2) continue;
      current.push({ pattern: 'A', spinners: n });
      recurseA(remS - n, remR2 - (n - 1), current, n);
      current.pop();
    }
  }
  function recurseB(remS, remR4, current, minSize) {
    if (current.length > 0) results.push({ clusters: current.slice() });
    const maxM = Math.min(remS, remR4 - 1);
    for (let m = minSize; m <= maxM; m++) {
      if (m + 1 > remR4) continue;
      current.push({ pattern: 'B', spinners: m });
      recurseB(remS - m, remR4 - (m + 1), current, m);
      current.pop();
    }
  }

  if (counts.spinner >= 2 && counts.repeater_2s >= 1) {
    recurseA(counts.spinner, counts.repeater_2s, [], 2);
  }
  if (counts.spinner >= 1 && counts.repeater_4s >= 2) {
    recurseB(counts.spinner, counts.repeater_4s, [], 1);
  }
  return results;
}

// Score a decomposition for ranking: more clustered spinners = better.
function _saScoreDecomposition(decomp) {
  const totalS = decomp.clusters.reduce((s, c) => s + c.spinners, 0);
  const totalR = decomp.clusters.reduce((s, c) => {
    return s + (c.pattern === 'A' ? c.spinners - 1 : c.spinners + 1);
  }, 0);
  return totalS * 1000 - decomp.clusters.length * 10 + totalR;
}

// Pick a decomposition deterministically by workerId — workers get
// different decompositions for structural diversity. Sorted by usage desc.
function pickDecompositionForWorker(decompositions, workerId) {
  if (decompositions.length === 0) return { clusters: [] };
  const sorted = decompositions.slice().sort((a, b) => _saScoreDecomposition(b) - _saScoreDecomposition(a));
  return sorted[workerId % sorted.length];
}

// Backward-compatible: greedy best decomposition (used when no workerId given)
function detectClusterOpportunities(nonWireIds) {
  const decomps = enumerateDecompositions(nonWireIds);
  const picked = pickDecompositionForWorker(decomps, 0);
  return picked;
}

// Build a synthetic component def for a cluster.
// Internal placements use original-orientation coordinates (cluster rotation 0).
function buildClusterDef(pattern, spinners) {
  const internals = [];
  const shapeCells = [];

  if (pattern === 'A') {
    // S(0) - R2(0) - S(0) - R2(0) - ... - S(0)
    // Each Spinner: 3-row × 2-col block, port row at bottom (row 2)
    // Each Rep_2s: 2-row × 1-col block at columns rows 1..2
    // Total width: 3N - 1, total height: 3 (where N = spinners)
    for (let i = 0; i < spinners; i++) {
      const baseCol = i * 3;
      // Spinner cells
      for (let r = 0; r < 3; r++) for (let c = 0; c < 2; c++) shapeCells.push([r, baseCol + c]);
      internals.push({ componentId: 'spinner', relRow: 0, relCol: baseCol, rotation: 0 });
      // Rep_2s after each spinner except last
      if (i < spinners - 1) {
        const repCol = baseCol + 2;
        shapeCells.push([1, repCol]);
        shapeCells.push([2, repCol]);
        internals.push({ componentId: 'repeater_2s', relRow: 1, relCol: repCol, rotation: 0 });
      }
    }
    const width = 3 * spinners - 1;
    return {
      id: `cluster_A${spinners}`,
      name: `Cluster A${spinners}`,
      shape: shapeCells,
      energyPorts: [
        { cell: [2, 0], side: 'W' },           // leftmost Spinner's W (external)
        { cell: [2, width - 1], side: 'E' }    // rightmost Spinner's E (external)
      ],
      bioPorts: [],
      peripheral: null,
      color: '#80CBC4', bgColor: '#003830',
      icon: '⛓',
      description: `Spinner-Rep_2s chain of ${spinners} spinners + ${spinners-1} Rep_2s.`,
      _internalPlacements: internals,
      _isCluster: true
    };
  }

  if (pattern === 'B') {
    // R4(0) - S(0) - R4(0) - S(0) - ... - R4(0)
    // M spinners + (M+1) rep_4s
    // Width = 3*M + 1, height = 3
    shapeCells.push([1, 0], [2, 0]);
    internals.push({ componentId: 'repeater_4s', relRow: 1, relCol: 0, rotation: 0 });
    for (let i = 0; i < spinners; i++) {
      const sCol = 1 + i * 3;
      for (let r = 0; r < 3; r++) for (let c = 0; c < 2; c++) shapeCells.push([r, sCol + c]);
      internals.push({ componentId: 'spinner', relRow: 0, relCol: sCol, rotation: 0 });
      const rCol = sCol + 2;
      shapeCells.push([1, rCol], [2, rCol]);
      internals.push({ componentId: 'repeater_4s', relRow: 1, relCol: rCol, rotation: 0 });
    }
    const width = 3 * spinners + 1;
    return {
      id: `cluster_B${spinners}`,
      name: `Cluster B${spinners}`,
      shape: shapeCells,
      energyPorts: [
        { cell: [2, 0], side: 'W' },           // leftmost Rep_4s W
        { cell: [2, width - 1], side: 'E' }    // rightmost Rep_4s E
      ],
      bioPorts: [],
      peripheral: null,
      color: '#80CBC4', bgColor: '#001a12',
      icon: '⛓',
      description: `Rep_4s-Spinner chain of ${spinners} spinners + ${spinners+1} Rep_4s.`,
      _internalPlacements: internals,
      _isCluster: true
    };
  }
  return null;
}

// Pre-compute internal sub-placements for all 4 cluster rotations so
// expandClusterPlacement can look them up directly without recomputing.
function _precomputeRotationVariants(def) {
  if (!def._internalPlacements) return;
  const result = { 0: def._internalPlacements };
  const maxR = Math.max(...def.shape.map(([r]) => r));
  const maxC = Math.max(...def.shape.map(([, c]) => c));

  for (const rot of [90, 180, 270]) {
    // Rotated cluster shape to find normalization offset
    const rotatedShape = def.shape.map(([r, c]) => rotateCoord(r, c, maxR, maxC, rot));
    const offsetR = Math.min(...rotatedShape.map(([r]) => r));
    const offsetC = Math.min(...rotatedShape.map(([, c]) => c));

    const rotInternals = [];
    for (const ip of def._internalPlacements) {
      const subDef = componentLib.find(d => d.id === ip.componentId);
      if (!subDef) continue;
      // Sub-component shape in its own original rotation
      const subShape = rotateComponent(subDef, ip.rotation).shape;
      // Where its cells sit in the original (rotation 0) cluster
      const subCellsInCluster = subShape.map(([sr, sc]) => [ip.relRow + sr, ip.relCol + sc]);
      // Rotate each cell by cluster's rotation, then normalise
      const rotatedSubCells = subCellsInCluster.map(([r, c]) => rotateCoord(r, c, maxR, maxC, rot));
      const normalized = rotatedSubCells.map(([r, c]) => [r - offsetR, c - offsetC]);
      const newRelRow = Math.min(...normalized.map(([r]) => r));
      const newRelCol = Math.min(...normalized.map(([, c]) => c));
      rotInternals.push({
        componentId: ip.componentId,
        relRow: newRelRow,
        relCol: newRelCol,
        rotation: (ip.rotation + rot) % 360
      });
    }
    result[rot] = rotInternals;
  }
  def._internalsByRotation = result;
}

// Register cluster defs into componentLib (idempotent). Precomputes all 4
// rotation variants of internal placements so expansion works for any rotation.
function registerClusterDefs(defs) {
  for (const def of defs) {
    if (!def) continue;
    if (!componentLib.find(d => d.id === def.id)) {
      componentLib.push(def);
    }
    _precomputeRotationVariants(def);
    // Note: we DO NOT force [0] in _uniqueRotsCache anymore — all 4 rotations
    // are valid placements for the cluster, and expansion handles them.
  }
}

// Substitute cluster IDs into a nonWireIds list — replaces the constituent
// components with cluster placement tokens. Decomposition is { clusters: [...] }.
function substituteClusterIds(nonWireIds, decomposition) {
  const result = [];
  const absorbed = { spinner: 0, repeater_2s: 0, repeater_4s: 0 };
  for (const c of decomposition.clusters) {
    if (c.pattern === 'A') {
      absorbed.spinner += c.spinners;
      absorbed.repeater_2s += (c.spinners - 1);
    } else if (c.pattern === 'B') {
      absorbed.spinner += c.spinners;
      absorbed.repeater_4s += (c.spinners + 1);
    }
    result.push(`cluster_${c.pattern}${c.spinners}`);
  }
  for (const id of nonWireIds) {
    if (absorbed[id] > 0) { absorbed[id]--; continue; }
    result.push(id);
  }
  return result;
}

// Expand a cluster placement back into individual component placements.
// Uses precomputed _internalsByRotation to handle any cluster rotation (0/90/180/270).
function expandClusterPlacement(clusterPlacement, clusterDef) {
  const rot = clusterPlacement.rotation || 0;
  const internals = (clusterDef._internalsByRotation && clusterDef._internalsByRotation[rot])
    ? clusterDef._internalsByRotation[rot]
    : clusterDef._internalPlacements;
  const out = [];
  for (const ip of internals) {
    const subDef = componentLib.find(d => d.id === ip.componentId);
    if (!subDef) continue;
    const rotated = rotateComponent(subDef, ip.rotation);
    out.push({
      componentId: ip.componentId,
      row: clusterPlacement.row + ip.relRow,
      col: clusterPlacement.col + ip.relCol,
      rotation: ip.rotation,
      rotatedShape: rotated.shape,
      rotatedPorts: rotated.energyPorts,
      rotatedBioPorts: rotated.bioPorts,
      rotatedPeripheral: buildRotatedPeri(subDef, ip.rotation)
    });
  }
  return out;
}

// Walk a placement list and expand any cluster placements into individuals.
// Used at SA cost-evaluation time and on result reporting.
function expandClustersInPlacements(placements) {
  const out = [];
  for (const p of placements) {
    const def = componentLib.find(d => d.id === p.componentId);
    if (def && def._isCluster) {
      out.push(...expandClusterPlacement(p, def));
    } else {
      out.push(p);
    }
  }
  return out;
}
