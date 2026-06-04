// src/optimizer/placement.js — Placement geometry helpers.
// Map-of-occupied-cells, overlap and bounds checks. Pure functions.

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
