// renderer.js – Idle Directive Body Optimizer
// SVG grid renderer

const CELL      = 56;
const BUS_W     = 22;
const PERI_V    = CELL;       // top/bottom SVG padding (N/S peripherals)
const PERI_H    = CELL * 2;   // right SVG padding (E peripheral = 2 cells)
const COMP_PAD  = 2;
const PORT_R    = 5;
const BUS_COLOR = '#FF7B2B';

function cellX(col)  { return BUS_W + col * CELL; }
function cellY(row)  { return PERI_V + row * CELL; }

function renderGrid(state, componentLib) {
  const svg = document.getElementById('body-grid');
  if (!svg) return;
  const { grid, placements } = state;

  const W = BUS_W + grid.cols * CELL + PERI_H;
  const H = PERI_V + grid.rows * CELL + BUS_W + PERI_V;

  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const poweredSet  = computePoweredSet(placements, grid.rows, grid.cols);
  const workingSet  = computeWorkingSet(placements);

  let html = buildDefs(componentLib);

  // Background
  html += `<rect width="${W}" height="${H}" fill="#070d1a"/>`;

  // Empty grid cells
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const x = cellX(c), y = cellY(r);
      html += `<rect x="${x+1}" y="${y+1}" width="${CELL-2}" height="${CELL-2}"
               fill="#101a28" stroke="#1a2f45" stroke-width="1" rx="2"/>`;
    }
  }

  // Bus connection lines (behind buses)
  html += renderBusConnections(placements, grid.rows, grid.cols);

  // Left bus
  const busH = grid.rows * CELL;
  html += `<rect x="0" y="${PERI_V}" width="${BUS_W}" height="${busH}"
           fill="${BUS_COLOR}18" stroke="${BUS_COLOR}" stroke-width="1.5"/>`;
  html += `<text x="${BUS_W/2}" y="${PERI_V + busH/2}"
           fill="${BUS_COLOR}cc" font-size="9" text-anchor="middle" dominant-baseline="middle"
           font-family="monospace" letter-spacing="1"
           transform="rotate(-90,${BUS_W/2},${PERI_V + busH/2})">PWR BUS</text>`;

  // Bottom bus
  const busY = PERI_V + grid.rows * CELL;
  const busW = BUS_W + grid.cols * CELL;
  html += `<rect x="0" y="${busY}" width="${busW}" height="${BUS_W}"
           fill="${BUS_COLOR}18" stroke="${BUS_COLOR}" stroke-width="1.5"/>`;
  html += `<text x="${busW/2}" y="${busY + BUS_W/2}"
           fill="${BUS_COLOR}cc" font-size="9" text-anchor="middle" dominant-baseline="middle"
           font-family="monospace" letter-spacing="1">PWR BUS</text>`;

  // Bus corner square
  html += `<rect x="0" y="${busY}" width="${BUS_W}" height="${BUS_W}"
           fill="${BUS_COLOR}30" stroke="${BUS_COLOR}" stroke-width="1.5"/>`;

  // Components (fills)
  placements.forEach((p, idx) => {
    const def = componentLib.find(d => d.id === p.componentId);
    if (def) html += renderComponent(p, def, poweredSet.has(idx), idx);
  });

  // Port indicators (on top)
  placements.forEach((p, idx) => {
    const powered = poweredSet.has(idx);
    p.rotatedPorts.forEach(({ cell, side }) => {
      const gr = p.row + cell[0], gc = p.col + cell[1];
      html += renderPort(gr, gc, side, powered);
    });
    (p.rotatedBioPorts || []).forEach(({ cell, side }) => {
      const gr = p.row + cell[0], gc = p.col + cell[1];
      html += renderPort(gr, gc, side, true, '#66BB6A');
    });
  });

  // Powered glow overlay
  placements.forEach((p, idx) => {
    if (!poweredSet.has(idx)) return;
    const def = componentLib.find(d => d.id === p.componentId);
    if (!def) return;
    p.rotatedShape.forEach(([r,c]) => {
      const x = cellX(p.col+c), y = cellY(p.row+r);
      html += `<rect x="${x+COMP_PAD}" y="${y+COMP_PAD}"
               width="${CELL-COMP_PAD*2}" height="${CELL-COMP_PAD*2}"
               fill="${def.color}12" rx="4" pointer-events="none"
               filter="url(#glow-${def.id})"/>`;
    });
  });

  // Working condition indicator (✓/✗) on spinners
  placements.forEach((p, idx) => {
    if (p.componentId !== 'spinner') return;
    const isWorking = workingSet.has(idx);
    const rows = p.rotatedShape.map(([r]) => r);
    const cols = p.rotatedShape.map(([,c]) => c);
    const cx = cellX(p.col + (Math.min(...cols)+Math.max(...cols))/2) + CELL/2;
    const cy = cellY(p.row + (Math.min(...rows)+Math.max(...rows))/2) + CELL/2;
    const color  = isWorking ? '#5abf60' : '#f05050';
    const symbol = isWorking ? '✓' : '✗';
    html += `<text x="${cx}" y="${cy+14}" fill="${color}" font-size="12"
             text-anchor="middle" dominant-baseline="middle"
             font-family="monospace" font-weight="bold" pointer-events="none">${symbol}</text>`;
  });

  svg.innerHTML = html;

  // Attach interaction handlers — carry-mode: click to pick up, click again to drop.
  // R rotates the carried component (handled at document level).
  placements.forEach((p, idx) => {
    const g = svg.querySelector(`[data-comp="${idx}"]`);
    if (g) {
      g.style.cursor = p._carrying ? 'crosshair' : 'pointer';
      g.addEventListener('click', (e) => onComponentClick(idx, e));
      g.addEventListener('mouseenter', () => highlightComponent(idx, true));
      g.addEventListener('mouseleave', () => highlightComponent(idx, false));
      g.addEventListener('contextmenu', (e) => e.preventDefault());
    }
  });
}

// Exposed for app.js drag/rotate logic — read by them when computing the
// mouse-to-grid-cell mapping.
const RENDERER_CELL    = CELL;
const RENDERER_BUS_W   = BUS_W;
const RENDERER_PERI_V  = PERI_V;

function renderComponent(placement, def, isPowered, idx) {
  const alpha = isPowered ? '' : '66';
  const fill  = def.bgColor + (isPowered ? 'ee' : '88');
  const stroke = def.color + (isPowered ? '' : '55');
  const cellSet = new Set(placement.rotatedShape.map(([r,c]) => `${r},${c}`));

  const carryAttr = placement._carrying ? ' data-carrying="true"' : '';
  let html = `<g data-comp="${idx}" data-comp-id="${def.id}"${carryAttr}>`;

  placement.rotatedShape.forEach(([r,c]) => {
    const x = cellX(placement.col + c), y = cellY(placement.row + r);

    html += `<rect x="${x+COMP_PAD}" y="${y+COMP_PAD}"
             width="${CELL-COMP_PAD*2}" height="${CELL-COMP_PAD*2}"
             fill="${fill}" stroke="${stroke}" stroke-width="1.5" rx="4"/>`;

    // Bridge right
    if (cellSet.has(`${r},${c+1}`)) {
      html += `<rect x="${x+CELL-COMP_PAD-1}" y="${y+COMP_PAD+4}"
               width="${COMP_PAD*2+2}" height="${CELL-COMP_PAD*2-8}"
               fill="${fill}" stroke="none"/>`;
    }
    // Bridge down
    if (cellSet.has(`${r+1},${c}`)) {
      html += `<rect x="${x+COMP_PAD+4}" y="${y+CELL-COMP_PAD-1}"
               width="${CELL-COMP_PAD*2-8}" height="${COMP_PAD*2+2}"
               fill="${fill}" stroke="none"/>`;
    }
  });

  // Outer label – centre of bounding box
  const rows = placement.rotatedShape.map(([r]) => r);
  const cols = placement.rotatedShape.map(([,c]) => c);
  const cx = cellX(placement.col + (Math.min(...cols)+Math.max(...cols))/2) + CELL/2;
  const cy = cellY(placement.row + (Math.min(...rows)+Math.max(...rows))/2) + CELL/2;

  html += `<text x="${cx}" y="${cy - 7}" fill="${def.color}${alpha || 'bb'}"
           font-size="45" text-anchor="middle" dominant-baseline="middle"
           font-family="serif" pointer-events="none">${def.icon}</text>`;

  if (placement.rotatedShape.length === 1) {
    html += `<text x="${cx}" y="${cy + 10}" fill="${def.color}${alpha || '88'}"
             font-size="7" text-anchor="middle" dominant-baseline="middle"
             font-family="monospace" pointer-events="none"
             >${def.name.substring(0,8).toUpperCase()}</text>`;
  }

  // Peripheral
  if (placement.rotatedPeripheral) {
    html += renderPeripheral(placement, def);
  }

  html += `</g>`;
  return html;
}

function renderPeripheral(placement, def) {
  const peri = placement.rotatedPeripheral;
  const portCell = peri.port.cell;
  const portSide = peri.port.side;
  const d = SIDE_DELTA[portSide];

  // Anchor: the grid cell where the port is
  const anchorR = placement.row + portCell[0];
  const anchorC = placement.col + portCell[1];

  // Peripheral cell [0,0] starts one step beyond the anchor cell
  const startR = anchorR + d.dr;
  const startC = anchorC + d.dc;

  const periSet = new Set(peri.shape.map(([r,c]) => `${r},${c}`));
  let html = `<g class="peripheral" opacity="0.8">`;

  peri.shape.forEach(([r,c]) => {
    const px = cellX(startC + c), py = cellY(startR + r);
    html += `<rect x="${px+COMP_PAD}" y="${py+COMP_PAD}"
             width="${CELL-COMP_PAD*2}" height="${CELL-COMP_PAD*2}"
             fill="${peri.bgColor}cc" stroke="${peri.color}" stroke-width="1.5"
             rx="4" stroke-dasharray="4,2"/>`;

    if (periSet.has(`${r},${c+1}`)) {
      html += `<rect x="${px+CELL-COMP_PAD-1}" y="${py+COMP_PAD+4}"
               width="${COMP_PAD*2+2}" height="${CELL-COMP_PAD*2-8}"
               fill="${peri.bgColor}cc" stroke="none"/>`;
    }
    if (periSet.has(`${r+1},${c}`)) {
      html += `<rect x="${px+COMP_PAD+4}" y="${py+CELL-COMP_PAD-1}"
               width="${CELL-COMP_PAD*2-8}" height="${COMP_PAD*2+2}"
               fill="${peri.bgColor}cc" stroke="none"/>`;
    }
  });

  // Second reserved slot (one step further in port direction — fits 2-cell bio component)
  const extraR = startR + d.dr;
  const extraC = startC + d.dc;
  const ex = cellX(extraC), ey = cellY(extraR);
  html += `<rect x="${ex+COMP_PAD}" y="${ey+COMP_PAD}"
           width="${CELL-COMP_PAD*2}" height="${CELL-COMP_PAD*2}"
           fill="${peri.bgColor}55" stroke="${peri.color}" stroke-width="1"
           rx="4" stroke-dasharray="3,3"/>`;
  // Bridge between extra slot and peripheral slot
  if      (d.dr === -1) html += `<rect x="${ex+COMP_PAD+4}" y="${ey+CELL-COMP_PAD-1}" width="${CELL-COMP_PAD*2-8}" height="${COMP_PAD*2+2}" fill="${peri.bgColor}55" stroke="none"/>`;
  else if (d.dr ===  1) html += `<rect x="${cellX(startC)+COMP_PAD+4}" y="${cellY(startR)+CELL-COMP_PAD-1}" width="${CELL-COMP_PAD*2-8}" height="${COMP_PAD*2+2}" fill="${peri.bgColor}55" stroke="none"/>`;
  else if (d.dc ===  1) html += `<rect x="${cellX(startC)+CELL-COMP_PAD-1}" y="${cellY(startR)+COMP_PAD+4}" width="${COMP_PAD*2+2}" height="${CELL-COMP_PAD*2-8}" fill="${peri.bgColor}55" stroke="none"/>`;
  else if (d.dc === -1) html += `<rect x="${ex+CELL-COMP_PAD-1}" y="${ey+COMP_PAD+4}" width="${COMP_PAD*2+2}" height="${CELL-COMP_PAD*2-8}" fill="${peri.bgColor}55" stroke="none"/>`;

  // Connection line from port to peripheral
  const portX = cellX(anchorC) + CELL/2;
  const portY = cellY(anchorR) + CELL/2;
  const periX = cellX(startC) + CELL/2;
  const periY = cellY(startR) + CELL/2;

  html += `<line x1="${portX}" y1="${portY}" x2="${periX}" y2="${periY}"
           stroke="${peri.color}" stroke-width="2" stroke-dasharray="3,2" opacity="0.6"/>`;

  // Label in each reserved slot
  const label = peri.name.substring(0,6).toUpperCase();
  peri.shape.forEach(([r,c]) => {
    const lx = cellX(startC + c) + CELL/2;
    const ly = cellY(startR + r) + CELL/2;
    html += `<text x="${lx}" y="${ly}" fill="${peri.color}cc"
             font-size="8" text-anchor="middle" dominant-baseline="middle"
             font-family="monospace">${label}</text>`;
  });
  // Label also in the extra (second) slot
  html += `<text x="${ex + CELL/2}" y="${ey + CELL/2}" fill="${peri.color}88"
           font-size="8" text-anchor="middle" dominant-baseline="middle"
           font-family="monospace">${label}</text>`;

  html += `</g>`;
  return html;
}

function renderPort(gridRow, gridCol, side, powered, color) {
  const x = cellX(gridCol), y = cellY(gridRow);
  const half = CELL / 2;
  const size = PORT_R;
  if (!color) color = powered ? '#FFAA44' : '#FF7B2B99';
  let pts;

  switch (side) {
    case 'N': pts = `${x+half},${y+3} ${x+half-size},${y+3+size*1.4} ${x+half+size},${y+3+size*1.4}`; break;
    case 'S': pts = `${x+half},${y+CELL-3} ${x+half-size},${y+CELL-3-size*1.4} ${x+half+size},${y+CELL-3-size*1.4}`; break;
    case 'E': pts = `${x+CELL-3},${y+half} ${x+CELL-3-size*1.4},${y+half-size} ${x+CELL-3-size*1.4},${y+half+size}`; break;
    case 'W': pts = `${x+3},${y+half} ${x+3+size*1.4},${y+half-size} ${x+3+size*1.4},${y+half+size}`; break;
  }

  return `<polygon points="${pts}" fill="${color}" pointer-events="none"/>`;
}

function renderBusConnections(placements, gridRows, gridCols) {
  let html = '';
  placements.forEach(p => {
    p.rotatedPorts.forEach(({ cell, side }) => {
      const gr = p.row + cell[0], gc = p.col + cell[1];
      const x = cellX(gc), y = cellY(gr);
      const half = CELL / 2;

      if (side === 'W' && gc === 0) {
        html += `<line x1="${BUS_W}" y1="${y+half}" x2="${x+COMP_PAD}" y2="${y+half}"
                 stroke="${BUS_COLOR}" stroke-width="3" stroke-linecap="round" opacity="0.7"/>`;
        // Bus notch
        html += `<rect x="1" y="${y+half-4}" width="${BUS_W-1}" height="8"
                 fill="${BUS_COLOR}44" rx="2"/>`;
      }
      if (side === 'S' && gr === gridRows - 1) {
        const busY = PERI_V + gridRows * CELL;
        html += `<line x1="${x+half}" y1="${y+CELL-COMP_PAD}" x2="${x+half}" y2="${busY}"
                 stroke="${BUS_COLOR}" stroke-width="3" stroke-linecap="round" opacity="0.7"/>`;
        html += `<rect x="${x+half-4}" y="${busY}" width="8" height="${BUS_W-1}"
                 fill="${BUS_COLOR}44" rx="2"/>`;
      }
    });
  });
  return html;
}

function buildDefs(componentLib) {
  const filters = componentLib.map(def => `
    <filter id="glow-${def.id}" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="blur"/>
      <feComposite in="SourceGraphic" in2="blur" operator="over"/>
    </filter>`).join('');

  return `<defs>
    <filter id="glow-bus" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur"/>
      <feComposite in="SourceGraphic" in2="blur" operator="over"/>
    </filter>
    ${filters}
  </defs>`;
}

function highlightComponent(idx, on) {
  const svg = document.getElementById('body-grid');
  const g = svg && svg.querySelector(`[data-comp="${idx}"]`);
  if (g) {
    g.querySelectorAll('rect').forEach(el => {
      el.style.filter = on ? 'brightness(1.4)' : '';
    });
  }
}

// Render the mini shape preview in the component library list
function renderMiniShape(shape, color, bgColor, energyPorts, bioPorts) {
  const S = 14, pad = 1, t = 3;
  const rows = shape.map(([r]) => r);
  const cols = shape.map(([,c]) => c);
  const H = (Math.max(...rows)+1) * S + pad*2;
  const W = (Math.max(...cols)+1) * S + pad*2;

  let html = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="flex-shrink:0">`;
  const cellSet = new Set(shape.map(([r,c]) => `${r},${c}`));
  shape.forEach(([r,c]) => {
    const x = pad + c*S, y = pad + r*S;
    html += `<rect x="${x+1}" y="${y+1}" width="${S-2}" height="${S-2}"
             fill="${bgColor}" stroke="${color}" stroke-width="1" rx="2"/>`;
    if (cellSet.has(`${r},${c+1}`))
      html += `<rect x="${x+S-1}" y="${y+4}" width="3" height="${S-8}" fill="${bgColor}"/>`;
    if (cellSet.has(`${r+1},${c}`))
      html += `<rect x="${x+4}" y="${y+S-1}" width="${S-8}" height="3" fill="${bgColor}"/>`;
  });

  const miniPort = (cell, side, portColor) => {
    const x = pad + cell[1]*S, y = pad + cell[0]*S, h = S/2;
    let pts;
    switch (side) {
      case 'N': pts = `${x+h},${y+2} ${x+h-t},${y+2+t*1.4} ${x+h+t},${y+2+t*1.4}`; break;
      case 'S': pts = `${x+h},${y+S-2} ${x+h-t},${y+S-2-t*1.4} ${x+h+t},${y+S-2-t*1.4}`; break;
      case 'E': pts = `${x+S-2},${y+h} ${x+S-2-t*1.4},${y+h-t} ${x+S-2-t*1.4},${y+h+t}`; break;
      case 'W': pts = `${x+2},${y+h} ${x+2+t*1.4},${y+h-t} ${x+2+t*1.4},${y+h+t}`; break;
    }
    html += `<polygon points="${pts}" fill="${portColor}"/>`;
  };

  (energyPorts || []).forEach(p => miniPort(p.cell, p.side, '#FFAA44'));
  (bioPorts    || []).forEach(p => miniPort(p.cell, p.side, '#66BB6A'));

  html += `</svg>`;
  return html;
}

// Render editor shape grid (6×6 toggle cells)
function renderEditorShapeGrid(shape, size) {
  const S = size || 30;
  const GRID = 6;
  const W = GRID * S;
  const cellSet = new Set(shape.map(([r,c]) => `${r},${c}`));
  let html = `<svg id="shape-editor-svg" width="${W}" height="${W}" viewBox="0 0 ${W} ${W}"
              style="cursor:pointer;border:1px solid #1e3050;border-radius:4px">`;

  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      const active = cellSet.has(`${r},${c}`);
      html += `<rect x="${c*S+1}" y="${r*S+1}" width="${S-2}" height="${S-2}"
               fill="${active ? '#1a3a6a' : '#0a1020'}" stroke="${active ? '#4FC3F7' : '#1a2f45'}"
               stroke-width="1" rx="3" data-r="${r}" data-c="${c}"
               class="shape-cell ${active ? 'active' : ''}"/>`;
    }
  }
  html += `</svg>`;
  return html;
}

// Render editor port indicator (mini component with clickable edges)
function renderEditorPortSVG(shape, ports, color) {
  const S = 36;
  const maxR = Math.max(...shape.map(([r]) => r));
  const maxC = Math.max(...shape.map(([,c]) => c));
  const W = (maxC + 1) * S + 4;
  const H = (maxR + 1) * S + 4;
  const portSet = new Set(ports.map(p => `${p.cell[0]},${p.cell[1]},${p.side}`));
  const cellSet = new Set(shape.map(([r,c]) => `${r},${c}`));

  let html = `<svg id="port-editor-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"
              style="cursor:pointer;border:1px solid #1e3050;border-radius:4px">`;

  shape.forEach(([r,c]) => {
    const x = 2 + c*S, y = 2 + r*S;
    html += `<rect x="${x+2}" y="${y+2}" width="${S-4}" height="${S-4}"
             fill="#1a3a6a" stroke="${color}" stroke-width="1.5" rx="3"/>`;

    // Clickable edge areas
    const esz = 8;
    [
      ['N', x+S/2-esz/2, y+1,    esz, esz],
      ['S', x+S/2-esz/2, y+S-9,  esz, esz],
      ['E', x+S-9,       y+S/2-esz/2, esz, esz],
      ['W', x+1,         y+S/2-esz/2, esz, esz],
    ].forEach(([side, ex, ey, ew, eh]) => {
      const hasPort = portSet.has(`${r},${c},${side}`);
      html += `<rect x="${ex}" y="${ey}" width="${ew}" height="${eh}"
               fill="${hasPort ? '#FFAA44' : '#ffffff11'}"
               stroke="${hasPort ? '#FFAA44' : '#334455'}" stroke-width="1" rx="2"
               data-r="${r}" data-c="${c}" data-side="${side}" class="port-edge"
               style="cursor:pointer"/>`;
    });
  });

  html += `</svg>`;
  return html;
}
