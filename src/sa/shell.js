// src/sa/shell.js — Shell packing heuristic.
// Idea: bus is on left (col=0, W edge) and bottom (row=R-1, S edge).
// The TOP and RIGHT edges are "bus-free" — components placed there are
// farthest from the bus and have the worst wire-routing cost.
//
// Strategy: greedily pack the largest components into the top-right corner
// with NO gaps between them. This creates a tight "shell" along the bus-free
// edges, leaving the bus-near interior for components with shorter wire runs.
//
// Bonus: components packed against the N/E edges can use their ports on those
// sides without wires (the edge is the same as "no neighbour"), reducing wire
// count by ~1 per edge-side port.
//
// Returns: { shellPlacements: [...], remaining: [...] }
//   shellPlacements — components placed in the shell (with row/col/rotation)
//   remaining — IDs that didn't fit in the shell (for SA to handle)

function packShell(componentIds, grid) {
  const R = grid.rows, C = grid.cols;

  // Sort by shape size descending — largest goes first (hardest to fit later)
  const order = [...componentIds].sort((a, b) => {
    const da = componentLib.find(d => d.id === a);
    const db = componentLib.find(d => d.id === b);
    return (db?.shape.length || 0) - (da?.shape.length || 0);
  });

  const occupied = new Set();
  const shellPlacements = [];
  const remaining = [];

  for (const id of order) {
    const def = componentLib.find(d => d.id === id);
    if (!def) { remaining.push(id); continue; }

    let best = null;
    let bestScore = -Infinity;

    for (const deg of getUniqueDegs(def)) {
      const { shape, energyPorts, bioPorts } = rotateComponent(def, deg);
      const bounds = getBounds(shape);
      if (bounds.height > R || bounds.width > C) continue;
      const rotPeri = buildRotatedPeri(def, deg);

      // Try positions row-by-row from top, col scanned from RIGHT to LEFT.
      // This biases packing into the top-right corner.
      for (let row = 0; row <= R - bounds.height; row++) {
        for (let col = C - bounds.width; col >= 0; col--) {
          // Overlap check
          let overlap = false;
          for (const [r, c] of shape) {
            if (occupied.has(`${row+r},${col+c}`)) { overlap = true; break; }
          }
          if (overlap) continue;

          // Reserve peripheral (Biocell etc.) — cells must be free too
          let periBlocked = false;
          if (rotPeri) {
            const d = SIDE_DELTA[rotPeri.port.side];
            const baseR = row + rotPeri.port.cell[0] + d.dr;
            const baseC = col + rotPeri.port.cell[1] + d.dc;
            for (const [pr, pc] of rotPeri.shape) {
              const rr = baseR + pr, cc = baseC + pc;
              if (rr < 0 || rr >= R || cc < 0 || cc >= C) { periBlocked = true; break; }
              if (occupied.has(`${rr},${cc}`)) { periBlocked = true; break; }
            }
          }
          if (periBlocked) continue;

          // Score: prefer top-right; reward NO gap with already placed cells
          //   distFromCorner = row (0=top) + (C-1 - (col + width - 1))   (0=right)
          //   adjacency bonus = how many shape cells touch occupied cells or N/E grid edges
          const distFromCorner = row + (C - col - bounds.width);
          let adjacency = 0;
          for (const [r, c] of shape) {
            const gr = row + r, gc = col + c;
            // Check 4 neighbours; touching occupied or grid edge (N/E only) counts
            if (gr === 0) adjacency++;                              // top edge
            else if (occupied.has(`${gr-1},${gc}`)) adjacency++;
            if (gc === C - 1) adjacency++;                          // right edge
            else if (occupied.has(`${gr},${gc+1}`)) adjacency++;
            if (gr > 0 && occupied.has(`${gr-1},${gc}`)) {/* already */}
          }

          // Port direction bonus: ports facing N or E (which become the OUTER side
          // of the shell) are "free" — no wire needed. Ports facing S or W must be
          // wire-connected through the interior.
          let portBonus = 0;
          for (const { cell, side } of energyPorts) {
            const gr = row + cell[0], gc = col + cell[1];
            if (side === 'N' && gr === 0) portBonus += 3;             // direct out, free
            else if (side === 'E' && gc === C - 1) portBonus += 3;
            else if (side === 'W' && gc === 0) portBonus += 10;       // ON the bus!
            else if (side === 'S' && gr === R - 1) portBonus += 10;   // ON the bus!
          }

          // Compute score: lower distFromCorner is better; adjacency+ports add bonus
          const score = -distFromCorner * 100 + adjacency * 10 + portBonus * 20;

          if (score > bestScore) {
            bestScore = score;
            best = { row, col, deg, shape, energyPorts, bioPorts, rotPeri };
          }
        }
      }
    }

    if (best) {
      shellPlacements.push({
        componentId: id,
        row: best.row, col: best.col, rotation: best.deg,
        rotatedShape: best.shape,
        rotatedPorts: best.energyPorts,
        rotatedBioPorts: best.bioPorts,
        rotatedPeripheral: best.rotPeri
      });
      for (const [r, c] of best.shape) occupied.add(`${best.row+r},${best.col+c}`);
      // Mark peri cells as occupied too
      if (best.rotPeri) {
        const d = SIDE_DELTA[best.rotPeri.port.side];
        const baseR = best.row + best.rotPeri.port.cell[0] + d.dr;
        const baseC = best.col + best.rotPeri.port.cell[1] + d.dc;
        for (const [pr, pc] of best.rotPeri.shape) {
          occupied.add(`${baseR+pr},${baseC+pc}`);
        }
      }
    } else {
      remaining.push(id);
    }
  }

  return { shellPlacements, remaining };
}
