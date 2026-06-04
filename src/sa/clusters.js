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

// Strategy: split available Spinner/Rep budget into the LARGEST chain possible.
// Larger chains have higher cell density (no isolated repeaters) and fewer
// external ports to wire. We can pack one big chain or many small ones; for
// the user's typical layouts (8 spinners + 4 rep_2s), the largest A chain is
// S=5, R=4 = 9 components — uses 4 reps and 5 spinners, leaving 3 spinners
// unable to be working. Two A4 chains (S=4, R=3 each) would use 8 spinners
// and 6 reps — but only 4 reps available. So one big chain it is.
function detectClusterOpportunities(nonWireIds) {
  const counts = { spinner: 0, repeater_2s: 0, repeater_4s: 0 };
  const others = [];
  for (const id of nonWireIds) {
    if (counts.hasOwnProperty(id)) counts[id]++;
    else others.push(id);
  }

  const clusters = [];

  // Pattern A — one big chain of S-R-S-R-...-S using all available rep_2s
  if (counts.repeater_2s >= 1 && counts.spinner >= 2) {
    // Max chain: min(spinner, rep_2s + 1) spinners
    const maxSpinners = Math.min(counts.spinner, counts.repeater_2s + 1);
    if (maxSpinners >= 2) {
      clusters.push({ pattern: 'A', spinners: maxSpinners });
      counts.spinner -= maxSpinners;
      counts.repeater_2s -= (maxSpinners - 1);
    }
  }

  // Pattern B — R-S-R-S-...-R using available rep_4s
  if (counts.repeater_4s >= 2 && counts.spinner >= 1) {
    const maxSpinners = Math.min(counts.spinner, counts.repeater_4s - 1);
    if (maxSpinners >= 1) {
      clusters.push({ pattern: 'B', spinners: maxSpinners });
      counts.spinner -= maxSpinners;
      counts.repeater_4s -= (maxSpinners + 1);
    }
  }

  // Anything left over stays as individuals (will be placed normally)
  const individuals = [];
  for (const id of ['spinner', 'repeater_2s', 'repeater_4s']) {
    for (let i = 0; i < counts[id]; i++) individuals.push(id);
  }
  individuals.push(...others);

  return { clusters, individuals };
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

// Register cluster defs into componentLib so the search treats them as
// real components. Idempotent — safe to call multiple times.
// Also force getUniqueDegs to return [0] for clusters (rotation 0 only for now).
function registerClusterDefs(opportunities) {
  const out = [];
  for (const opp of opportunities.clusters) {
    const def = buildClusterDef(opp.pattern, opp.spinners);
    if (!def) continue;
    if (!componentLib.find(d => d.id === def.id)) {
      componentLib.push(def);
    }
    // Pre-cache unique rotations to force [0] only — until rotated cluster
    // expansion is implemented, clusters are placed horizontally only.
    if (typeof _uniqueRotsCache !== 'undefined') {
      _uniqueRotsCache.set(def.id, [0]);
    }
    out.push(def);
  }
  return out;
}

// Substitute cluster IDs into a nonWireIds list (removing the components
// they consume). Returns new id list with cluster_XN tokens.
function substituteClusterIds(nonWireIds, opportunities) {
  const result = [];
  // Track absorption budget per kind
  const absorbed = { spinner: 0, repeater_2s: 0, repeater_4s: 0 };
  for (const opp of opportunities.clusters) {
    if (opp.pattern === 'A') {
      absorbed.spinner += opp.spinners;
      absorbed.repeater_2s += (opp.spinners - 1);
    } else if (opp.pattern === 'B') {
      absorbed.spinner += opp.spinners;
      absorbed.repeater_4s += (opp.spinners + 1);
    }
    result.push(`cluster_${opp.pattern}${opp.spinners}`);
  }
  // Re-emit any individual id that wasn't absorbed
  for (const id of nonWireIds) {
    if (absorbed[id] > 0) { absorbed[id]--; continue; }
    result.push(id);
  }
  return result;
}

// Expand a cluster placement back into individual component placements.
// Currently supports only rotation 0 (clusters are placed canonically).
function expandClusterPlacement(clusterPlacement, clusterDef) {
  const out = [];
  for (const ip of clusterDef._internalPlacements) {
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
