// src/optimizer/rotation.js — Component rotation primitives.
// Pure geometry: no UI, no state, no DOM. Safe to share between main and worker.

const ROT_ORDER = ['N','E','S','W'];

function rotateSide(side, deg) {
  const steps = ((deg / 90) % 4 + 4) % 4;
  return ROT_ORDER[(ROT_ORDER.indexOf(side) + steps) % 4];
}

function rotateCoord(r, c, maxR, maxC, deg) {
  if (deg === 0)   return [r, c];
  if (deg === 90)  return [c, maxR - r];
  if (deg === 180) return [maxR - r, maxC - c];
  if (deg === 270) return [maxC - c, r];
}

function rotateComponent(compDef, deg) {
  if (deg === 0) {
    return {
      shape: compDef.shape.map(c => [...c]),
      energyPorts: compDef.energyPorts.map(p => ({ cell: [...p.cell], side: p.side })),
      bioPorts: (compDef.bioPorts || []).map(p => ({ cell: [...p.cell], side: p.side }))
    };
  }

  const maxR = Math.max(...compDef.shape.map(([r]) => r));
  const maxC = Math.max(...compDef.shape.map(([,c]) => c));

  let shape = compDef.shape.map(([r,c]) => rotateCoord(r, c, maxR, maxC, deg));
  let ports = compDef.energyPorts.map(p => ({
    cell: rotateCoord(p.cell[0], p.cell[1], maxR, maxC, deg),
    side: rotateSide(p.side, deg)
  }));
  let bioPorts = (compDef.bioPorts || []).map(p => ({
    cell: rotateCoord(p.cell[0], p.cell[1], maxR, maxC, deg),
    side: rotateSide(p.side, deg)
  }));

  // Normalize to origin (min row/col = 0)
  const minR = Math.min(...shape.map(([r]) => r));
  const minC = Math.min(...shape.map(([,c]) => c));
  shape    = shape.map(([r,c]) => [r - minR, c - minC]);
  ports    = ports.map(p => ({ cell: [p.cell[0] - minR, p.cell[1] - minC], side: p.side }));
  bioPorts = bioPorts.map(p => ({ cell: [p.cell[0] - minR, p.cell[1] - minC], side: p.side }));

  return { shape, energyPorts: ports, bioPorts };
}

function rotatePeriShape(periShape, deg) {
  if (deg === 0) return periShape.map(c => [...c]);
  const maxR = Math.max(...periShape.map(([r]) => r));
  const maxC = Math.max(...periShape.map(([,c]) => c));
  let s = periShape.map(([r,c]) => rotateCoord(r, c, maxR, maxC, deg));
  const minR = Math.min(...s.map(([r]) => r));
  const minC = Math.min(...s.map(([,c]) => c));
  return s.map(([r,c]) => [r - minR, c - minC]);
}

function getBounds(shape) {
  return {
    height: Math.max(...shape.map(([r]) => r)) + 1,
    width:  Math.max(...shape.map(([,c]) => c)) + 1
  };
}

// Returns only the geometrically distinct rotations for a component.
// Square: 1, rectangle: 2, asymmetric: 4. Cached by component ID.
const _uniqueRotsCache = new Map();
function getUniqueDegs(def) {
  if (_uniqueRotsCache.has(def.id)) return _uniqueRotsCache.get(def.id);
  const seen = new Set();
  const result = [];
  for (const deg of [0, 90, 180, 270]) {
    const { shape } = rotateComponent(def, deg);
    const key = shape.map(([r,c]) => `${r},${c}`).sort().join('|');
    if (!seen.has(key)) { seen.add(key); result.push(deg); }
  }
  _uniqueRotsCache.set(def.id, result);
  return result;
}
