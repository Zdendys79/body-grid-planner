// src/optimizer/placement.js — Placement geometry helpers.
// Map-of-occupied-cells, overlap and bounds checks. Pure functions.
// Note: addPeripheralReserved depends on SIDE_DELTA from bus.js — loaded later.

function getOccupiedMap(placements) {
  const map = new Map();
  placements.forEach((p, idx) => {
    p.rotatedShape.forEach(([r,c]) => map.set(`${p.row+r},${p.col+c}`, idx));
  });
  return map;
}

function hasOverlap(shape, row, col, occupiedMap) {
  return shape.some(([r,c]) => occupiedMap.has(`${row+r},${col+c}`));
}

function fitsInGrid(shape, row, col, gridRows, gridCols) {
  return shape.every(([r,c]) => {
    const gr = row+r, gc = col+c;
    return gr >= 0 && gr < gridRows && gc >= 0 && gc < gridCols;
  });
}

// Reserves peripheral cells (e.g., Biocell attached to Bio Generator) and one
// extra cell in the same direction onto the supplied "occupied" Set.
// Used by findWirePath and computeFreeSpaceQuality to keep wires/components
// out of slots reserved for auto-placed peripherals.
function addPeripheralReserved(placements, occupied) {
  placements.forEach(p => {
    if (!p.rotatedPeripheral) return;
    const peri = p.rotatedPeripheral;
    const d = SIDE_DELTA[peri.port.side];
    const startR = p.row + peri.port.cell[0] + d.dr;
    const startC = p.col + peri.port.cell[1] + d.dc;
    peri.shape.forEach(([r, c]) => occupied.add(`${startR + r},${startC + c}`));
    occupied.add(`${startR + d.dr},${startC + d.dc}`);
  });
}
