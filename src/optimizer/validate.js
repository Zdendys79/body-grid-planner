// src/optimizer/validate.js — Layout validation and wire-bridging.
// Shared by main thread and worker. Reads `componentLib` as a global
// (defined in app.js or set on worker init).

// Returns true if layout is fully valid:
//   - every energy component is powered (connected to bus/powered chain)
//   - every Spinner has required Repeaters adjacent (only when Repeaters exist)
//   - every Repeater connects (port-match) to at least one Spinner OR Pulser
//   - Pulsers do not require Repeaters
//   - every Biocell/Disposable Biocell is port-adjacent to a Bio Generator
//     (any tier) — they have normal electrical ports, but only function
//     when plugged directly into one
const BIOCELL_IDS = new Set(['biocell', 'disposable_biocell']);
const BIO_GENERATOR_IDS = new Set(['bio_generator', 'bio_generator_ii', 'bio_core']);

// Upgrader: each of its (up to 2) ports is either PINNED to a specific
// OTHER placement instance (by `pinTag`, assigned only via direct user
// action — see _repinUpgrader in app.js, never by SA/RE-OPTIMIZE) or FREE.
// A pinned port must stay port-adjacent to that exact instance across any
// layout change, even after rotation/relocation. A free port must NOT pick
// up an unintended connection to any other real component — SA/RE-OPTIMIZE
// may only relay power to it via a wire there, never silently "upgrade" a
// component the user didn't choose.
//
// Shared core: does SOME injective assignment of `ports` to `targetIdxs`
// (placement indices, in order) exist such that each assigned port is
// port-adjacent to its target, and every unassigned port touches no OTHER
// real (non-wire) component? Used both for an already-placed Upgrader
// (isLayoutValid, via _upgraderPinsOk below) and for a CANDIDATE position
// being evaluated before commit (findBestPlacement in optimizer.js, which
// passes `excludeSelf: null` since the candidate isn't in `placements` yet).
function _upgraderPortAssignmentOk(ports, row, col, placements, targetIdxs, excludeSelf) {
  if (targetIdxs.length > ports.length) return false; // can't pin more targets than ports

  function adjCell(port) {
    const gr = row + port.cell[0], gc = col + port.cell[1];
    const d = SIDE_DELTA[port.side];
    return { ar: gr + d.dr, ac: gc + d.dc };
  }
  function portTouchesPlacement(port, other) {
    const { ar, ac } = adjCell(port);
    return (other.rotatedPorts || []).some(tp =>
      other.row + tp.cell[0] === ar && other.col + tp.cell[1] === ac && tp.side === OPPOSITE[port.side]
    );
  }
  function portTouchesAnyOther(port) {
    const { ar, ac } = adjCell(port);
    return placements.some(other =>
      other !== excludeSelf && other.componentId !== 'wire' &&
      (other.rotatedPorts || []).some(tp =>
        other.row + tp.cell[0] === ar && other.col + tp.cell[1] === ac && tp.side === OPPOSITE[port.side]
      )
    );
  }

  // Brute-force permutations of port indices assigned to targetIdxs, in
  // order — at most 2 ports, so at most 2 permutations to try.
  function permutations(arr) {
    if (arr.length <= 1) return [arr];
    const out = [];
    arr.forEach((v, i) => {
      const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
      permutations(rest).forEach(p2 => out.push([v, ...p2]));
    });
    return out;
  }

  const portIdxs = ports.map((_, i) => i);
  for (const perm of permutations(portIdxs)) {
    let ok = true;
    for (let t = 0; t < targetIdxs.length && ok; t++) {
      if (!portTouchesPlacement(ports[perm[t]], placements[targetIdxs[t]])) ok = false;
    }
    for (let k = targetIdxs.length; k < perm.length && ok; k++) {
      if (portTouchesAnyOther(ports[perm[k]])) ok = false;
    }
    if (ok) return true;
  }
  return false;
}

function _upgraderPinsOk(p, placements) {
  const tags = p.pinnedTags || [];
  const targetIdxs = tags
    .map(tag => placements.findIndex(pp => pp.pinTag === tag))
    .filter(idx => idx !== -1); // missing target = that pin was lost, silently dropped
  return _upgraderPortAssignmentOk(p.rotatedPorts || [], p.row, p.col, placements, targetIdxs, p);
}

function isLayoutValid(placements, grid) {
  const poweredSet  = computePoweredSet(placements, grid.rows, grid.cols);
  const workingSet  = computeWorkingSet(placements);
  const hasRepeaters = placements.some(p =>
    p.componentId === 'repeater_4s' || p.componentId === 'repeater_2s'
  );
  const hasBiocells = placements.some(p => BIOCELL_IDS.has(p.componentId));
  const hasBioCores = placements.some(p => p.componentId === 'bio_core');

  // Pre-build set of Spinner+Pulser port keys for Repeater "useful-target" check
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

  // Pre-build set of Bio Generator port keys for the Biocell "must be
  // plugged into a generator" check
  let bioGenPortKeys = null;
  if (hasBiocells) {
    bioGenPortKeys = new Set();
    for (const p of placements) {
      if (!BIO_GENERATOR_IDS.has(p.componentId)) continue;
      for (const port of (p.rotatedPorts || [])) {
        bioGenPortKeys.add(`${p.row+port.cell[0]},${p.col+port.cell[1]},${port.side}`);
      }
    }
  }

  // Pre-build set of Biocell/Disposable Biocell port keys for the Bio Core
  // "needs a connected Biocell to function" check — the reverse requirement
  // from Biocell's own (which needs ANY Bio Generator tier, bio_core included
  // since v=157). Bio Generator (I)/(II) have no such requirement — only
  // Bio Core does.
  let biocellPortKeys = null;
  if (hasBioCores) {
    biocellPortKeys = new Set();
    for (const p of placements) {
      if (!BIOCELL_IDS.has(p.componentId)) continue;
      for (const port of (p.rotatedPorts || [])) {
        biocellPortKeys.add(`${p.row+port.cell[0]},${p.col+port.cell[1]},${port.side}`);
      }
    }
  }

  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    if (p.componentId === 'wire') continue;
    const def = componentLib.find(d => d.id === p.componentId);
    if (!def) continue;
    // Upgrader with no active pin needs no power of its own (see
    // _upgraderPinsOk above) — everyone else, and a pinned Upgrader, keep
    // the normal "must reach the bus" requirement.
    const isFreeUpgrader = p.componentId === 'upgrader' && (!p.pinnedTags || p.pinnedTags.length === 0);
    if (def.energyPorts.length > 0 && !isFreeUpgrader && !poweredSet.has(i)) return false;
    if (p.componentId === 'upgrader' && !_upgraderPinsOk(p, placements)) return false;
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
    if (BIOCELL_IDS.has(p.componentId)) {
      let connected = false;
      for (const port of (p.rotatedPorts || [])) {
        const gr = p.row + port.cell[0], gc = p.col + port.cell[1];
        const d = SIDE_DELTA[port.side];
        const adjKey = `${gr + d.dr},${gc + d.dc},${OPPOSITE[port.side]}`;
        if (bioGenPortKeys.has(adjKey)) { connected = true; break; }
      }
      if (!connected) return false;
    }
    if (p.componentId === 'bio_core') {
      let connected = false;
      for (const port of (p.rotatedPorts || [])) {
        const gr = p.row + port.cell[0], gc = p.col + port.cell[1];
        const d = SIDE_DELTA[port.side];
        const adjKey = `${gr + d.dr},${gc + d.dc},${OPPOSITE[port.side]}`;
        if (biocellPortKeys.has(adjKey)) { connected = true; break; }
      }
      if (!connected) return false;
    }
  }
  return true;
}

// For each unpowered energy component in a brute-force candidate layout, tries
// to find a wire path connecting it to the bus or an already-powered component.
// Returns the layout augmented with wires, or null if any component can't be
// connected.
function tryAddWires(placements, grid) {
  const wireDef = componentLib.find(d => d.id === 'wire');
  if (!wireDef) return null;

  // Work on a copy so we don't mutate the generator's array
  let current = placements.map((p, i) => ({ ...p, id: i + 1 }));

  // Each iteration powers one more component; loop until all are powered or we give up
  const maxIter = placements.filter(p => {
    const def = componentLib.find(d => d.id === p.componentId);
    return def && def.energyPorts.length > 0;
  }).length + 1;

  for (let iter = 0; iter < maxIter; iter++) {
    const poweredSet = computePoweredSet(current, grid.rows, grid.cols);
    const unpowered = [];

    for (let i = 0; i < current.length; i++) {
      const p = current[i];
      if (p.componentId === 'wire') continue;
      const def = componentLib.find(d => d.id === p.componentId);
      if (!def || def.energyPorts.length === 0) continue;
      if (p.componentId === 'upgrader' && (!p.pinnedTags || p.pinnedTags.length === 0)) continue; // free Upgrader: no power needed
      if (poweredSet.has(i)) continue;
      unpowered.push(p);
    }

    if (unpowered.length === 0) return current;

    // Try every still-unpowered component this pass, not just the first —
    // one placement's own port-adjacent cells may all be boxed in (no free
    // cell to drop a wire on) while it's still directly port-connected to
    // ANOTHER unpowered component that DOES have a free exit. Wiring that
    // other one first powers both via the direct port link on the next
    // pass, with no wire needed for the boxed-in one at all. Bailing out on
    // the first placement's failure (old behaviour) missed exactly this case.
    let wiredAny = false;
    for (const p of unpowered) {
      const path = findWirePath(p.rotatedShape, p.rotatedPorts, p.row, p.col, { grid, placements: current });
      if (!path || path.length === 0) continue;

      path.forEach(([r, c]) => {
        current.push({
          id: current.length + 1,
          componentId: 'wire',
          row: r, col: c, rotation: 0,
          rotatedShape: [[0, 0]],
          rotatedPorts: wireDef.energyPorts.map(ep => ({ cell: [...ep.cell], side: ep.side })),
          rotatedPeripheral: null,
          autoPlaced: true
        });
      });
      wiredAny = true;
      break;
    }

    // Nobody in this pass could be wired — genuinely stuck, not just a
    // traversal-order artifact.
    if (!wiredAny) return null;
  }

  return null;
}
