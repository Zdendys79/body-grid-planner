// app.js – Idle Directive Body Optimizer
// Constants (STATE_KEY, BF_SAVE_KEY, SETTINGS_KEY, MAX_THREADS, _SIDE_IDX)
// are defined in src/constants.js, loaded before this file.

let state = {
  grid: { rows: 3, cols: 4, maxRows: 19, maxCols: 12 },
  placements: [],
  nextId: 1
};

let componentLib = [];
let selectedPlacementIdx = null;

// Background optimizer state
let bgOptId = 0;
let pendingBetterLayout = null;
let currentBfWorkers = []; // active brute-force workers (Phase 2: multi-thread)

// ─── Init ────────────────────────────────────────────────────────────────────

async function init() {
  // Cache detection via Performance API
  try {
    const nav = performance.getEntriesByType('navigation')[0];
    const resources = performance.getEntriesByType('resource').filter(r => r.name.match(/\.(js|css)\?v=/));
    const fromCache = nav && nav.transferSize === 0;
    console.log(`[Cache] Page: ${fromCache ? 'FROM CACHE' : 'fresh from network'} (type=${nav?.type || '?'})`);
    resources.forEach(r => {
      const name = r.name.split('/').pop();
      console.log(`[Cache]   ${r.transferSize === 0 ? 'CACHE' : 'NET  '} ${name}`);
    });
  } catch (e) { /* Performance API unavailable */ }

  const listEl = document.getElementById('component-list');

  try {
    const resp = await fetch('components.json');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    componentLib = data.components || [];
    console.log('[init] Loaded', componentLib.length, 'components:', componentLib.map(c => c.id).join(', '));
  } catch (e) {
    console.error('[init] Failed to load components.json:', e);
    if (listEl) listEl.innerHTML = `<div class="empty-hint" style="color:#f05050">Loading error: ${e.message}</div>`;
    showStatus('Error: components.json', 'error');
    return;
  }

  const saved = localStorage.getItem(STATE_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      state.grid       = parsed.grid       || state.grid;
      state.nextId     = parsed.nextId     || 1;
      state.placements = (parsed.placements || []).map(p => rehydratePlacement(p));
      const summary = {};
      state.placements.forEach(p => { summary[p.componentId] = (summary[p.componentId] || 0) + 1; });
      const parts = Object.entries(summary).map(([id, n]) => `${id}×${n}`).join(', ');
      console.log(`[Load] ${state.placements.length} components from memory: ${parts || '—'} | grid ${state.grid.rows}×${state.grid.cols}`);
    } catch (e) {
      console.warn('[init] State parse error, using fresh state');
    }
  }

  // Load persisted SA results (top-20)
  bfResults = bfResultsLoad();
  if (bfResults.length > 0) {
    // Validate against current component set — old results from different
    // component layouts would lose components when applied.
    const currentKey = _componentSetKey(state.placements);
    const before = bfResults.length;
    bfResults = bfResults.filter(r => _componentSetKey(r.layout) === currentKey);
    if (bfResults.length !== before) {
      console.log(`[init] ${before - bfResults.length} SA results discarded (different component set), kept ${bfResults.length}.`);
      bfResultsSave();
    }
    if (bfResults.length > 0) {
      console.log(`[init] ${bfResults.length} SA results loaded from memory.`);
    }
  }

  // Dump current layout to console on startup (saveState dumps on every later change)
  console.log('[Layout dump]', JSON.stringify({
    grid: state.grid,
    nextId: state.nextId,
    placements: state.placements.map(p => ({
      id: p.id, componentId: p.componentId,
      row: p.row, col: p.col, rotation: p.rotation,
      autoPlaced: p.autoPlaced || false
    }))
  }));

  // Global keyboard listener for R-key rotation of selected component
  document.addEventListener('keydown', onGlobalKeydown);

  renderAll();
  renderBfResults();

  // Verify drag handlers attached
  const dragHandlerCount = document.querySelectorAll('#body-grid [data-comp]').length;
  console.log(`[init] ${dragHandlerCount} components in grid, carry handlers attached.`);

  showStatus('Ready · Click = pick up/drop · R = rotate · Esc = cancel', 'ok');

  // Auto-resume brute force if a saved snapshot matches the current layout
  try {
    const bfSaved = bfLoadSave();
    if (bfSaved && bfSaved.v === 1) {
      const BIO_PERI = new Set(['biocell', 'disposable_biocell']);
      const currentIds = state.placements
        .filter(p => p.componentId !== 'wire' && !BIO_PERI.has(p.componentId))
        .map(p => p.componentId);
      const currentKey = [...currentIds].sort().join(',');
      if (bfSaved.idsKey === currentKey &&
          bfSaved.rows === state.grid.rows &&
          bfSaved.cols === state.grid.cols &&
          currentIds.length > 1) {
        console.log('[init] Saved search found for current layout — STOP! Optimization runs only manually.');
        showStatus('Saved BF state found. Start it manually via the BRUTE button.', 'ok');
        // Note: do NOT auto-resume. User triggers via the BRUTE button.
      } else {
        console.log('[init] Saved search does not match layout — discarding.');
        bfClearSave();
      }
    }
  } catch (e) { /* ignore */ }
}

function rehydratePlacement(p) {
  const def = componentLib.find(d => d.id === p.componentId);
  if (!def) return p;
  const deg = p.rotation || 0;
  const { shape, energyPorts, bioPorts } = rotateComponent(def, deg);
  const rotatedPeripheral = buildRotatedPeri(def, deg);
  return { ...p, rotatedShape: shape, rotatedPorts: energyPorts, rotatedBioPorts: bioPorts, rotatedPeripheral };
}

// ─── Render ──────────────────────────────────────────────────────────────────

function renderAll() {
  renderGrid(state, componentLib);
  renderComponentList();
  renderPlacedList();
  updateGridInfo();
  updateExpandButton();
  updatePowerStatus();
}

function renderComponentList() {
  const container = document.getElementById('component-list');
  if (!container) return;

  // Wire is placed automatically – never shown in the library
  const HIDDEN_IDS = new Set(['wire', 'biocell', 'disposable_biocell']);
  const visible = componentLib.filter(c => !HIDDEN_IDS.has(c.id));
  const categories = [...new Set(visible.map(c => c.category))];

  if (visible.length === 0) {
    container.innerHTML = '<div class="empty-hint" style="color:#f05050">No components (check console)</div>';
    return;
  }

  let html = '';

  categories.forEach(cat => {
    html += `<div class="cat-label">${cat.toUpperCase()}</div>`;
    visible.filter(c => c.category === cat).forEach(def => {
      const countPlaced = state.placements.filter(p => p.componentId === def.id).length;
      html += `<div class="comp-item">
        <div class="comp-preview">${renderMiniShape(def.shape, def.color, def.bgColor, def.energyPorts, def.bioPorts)}</div>
        <div class="comp-info">
          <div class="comp-name" style="color:${def.color}">${def.icon} ${def.name}</div>
        </div>
        <div class="comp-actions">
          ${countPlaced > 0 ? `<span class="comp-count">${countPlaced}×</span>` : ''}
          <button class="btn-add" onclick="addComponent('${def.id}')" title="Place">+</button>
        </div>
      </div>`;
    });
  });

  container.innerHTML = html;
}

function renderPlacedList() {
  const container = document.getElementById('placed-list');
  const count     = document.getElementById('placed-count');
  if (!container) return;

  count.textContent = state.placements.length;

  if (state.placements.length === 0) {
    container.innerHTML = '<div class="empty-hint">Add components from the menu above.</div>';
    return;
  }

  const poweredSet = computePoweredSet(state.placements, state.grid.rows, state.grid.cols);
  const workingSet = computeWorkingSet(state.placements);
  let html = '';

  state.placements.forEach((p, idx) => {
    const def     = componentLib.find(d => d.id === p.componentId);
    if (!def) return;
    const powered  = poweredSet.has(idx);
    const selected = idx === selectedPlacementIdx;
    const autoTag  = p.autoPlaced ? '<span class="auto-tag">auto</span>' : '';

    let condTag = '';
    if (def.id === 'spinner') {
      const met = workingSet.has(idx);
      condTag = `<span style="font-size:11px;font-weight:bold;color:${met ? '#5abf60' : '#f05050'}">${met ? '✓' : '!'}</span>`;
    }

    html += `<div class="placed-item ${selected ? 'selected' : ''} ${powered ? 'powered' : 'unpowered'}"
             onclick="selectPlacement(${idx})">
      <span class="placed-icon" style="color:${def.color}">${def.icon}</span>
      <span class="placed-name" style="color:${def.color}${powered ? '' : '88'}">${def.name}</span>
      ${autoTag}${condTag}
      <span class="placed-pos">[${p.row},${p.col}]${p.rotation ? ' '+p.rotation+'°' : ''}</span>
      <span class="placed-power ${powered ? 'on' : 'off'}">${powered ? '⚡' : '✗'}</span>
      <button class="btn-remove" onclick="removePlacement(event,${idx})" title="Odebrat">✕</button>
    </div>`;
  });

  container.innerHTML = html;
}

function updateGridInfo() {
  const el1 = document.getElementById('grid-size-label');
  const el2 = document.getElementById('grid-level-label');
  if (el1) el1.textContent = `${state.grid.rows} × ${state.grid.cols}`;
  if (el2) {
    const level = Math.max((state.grid.rows - 3) / 2, (state.grid.cols - 4) / 2) + 1;
    el2.textContent = `LVL ${level}`;
  }
}

function updateExpandButton() {
  const btn = document.getElementById('btn-expand');
  if (!btn) return;
  const { grid } = state;
  btn.disabled = grid.rows >= grid.maxRows && grid.cols >= grid.maxCols;
}

function updatePowerStatus() {
  const el = document.getElementById('power-status');
  if (!el || state.placements.length === 0) { if (el) el.textContent = ''; return; }
  const powered = computePoweredSet(state.placements, state.grid.rows, state.grid.cols);
  const total = state.placements.length;
  const on = powered.size;
  el.textContent = `⚡ ${on}/${total}`;
  el.style.color = on === total ? '#5abf60' : on === 0 ? '#f05050' : '#FFA726';
}

// ─── Actions ─────────────────────────────────────────────────────────────────

async function addComponent(componentId) {
  const def = componentLib.find(d => d.id === componentId);
  if (!def) return;

  // Biocell / disposable_biocell are automatically handled as bio_generator peripherals
  if ((componentId === 'biocell' || componentId === 'disposable_biocell') &&
      state.placements.some(p => p.componentId === 'bio_generator')) {
    showStatus(`${def.icon} ${def.name}: Bio Generator already includes Biocell automatically.`, 'warn');
    return;
  }

  let result = findBestPlacement(def, state);
  if (!result) {
    // No room with current layout – try async rearrangement (yields between components)
    const allIds = ensureComponentOrder([
      ...state.placements.filter(p => p.componentId !== 'wire').map(p => p.componentId),
      componentId
    ]);
    showStatus(`Rearranging ${allIds.length} components…`, 'ok');
    const rearranged = await runOptimizationAsync(allIds, state.grid);
    const expectedCount = allIds.filter(id => id === componentId).length;
    const actualCount   = rearranged.filter(p => p.componentId === componentId).length;
    if (actualCount < expectedCount) {
      // Last resort: place anywhere that fits geometrically, ignoring power connections
      const anyResult = findAnyPlacement(def, state);
      if (!anyResult) {
        showStatus(`${def.icon} ${def.name}: no room even after rearrangement. Expand body.`, 'error');
        return;
      }
      const rotPeri = buildRotatedPeri(def, anyResult.rotation);
      state.placements.push({
        id: state.nextId++,
        componentId,
        row: anyResult.row, col: anyResult.col,
        rotation: anyResult.rotation,
        rotatedShape: anyResult.rotatedShape,
        rotatedPorts: anyResult.rotatedPorts,
        rotatedBioPorts: anyResult.rotatedBioPorts || [],
        rotatedPeripheral: rotPeri
      });
      state.nextId = state.placements.length + 1;
      saveState();
      renderAll();
      showStatus(`${def.icon} ${def.name} added (not connected – use Re-Optimize or Brute).`, 'warn');
      return;
    }
    state.placements = rearranged;
    state.nextId = rearranged.length + 1;
    selectedPlacementIdx = null;
    saveState();
    renderAll();
    showStatus(`${def.icon} ${def.name} added – components rearranged.`, 'ok');
    return;
  }

  const wireDef = componentLib.find(d => d.id === 'wire');

  (result.wirePath || []).forEach(([r, c]) => {
    if (!wireDef) return;
    state.placements.push({
      id: state.nextId++,
      componentId: 'wire',
      row: r, col: c, rotation: 0,
      rotatedShape: [[0,0]],
      rotatedPorts: wireDef.energyPorts.map(p => ({ cell: [...p.cell], side: p.side })),
      rotatedBioPorts: [],
      rotatedPeripheral: null,
      autoPlaced: true
    });
  });

  state.placements.push({
    id: state.nextId++,
    componentId,
    row: result.row, col: result.col,
    rotation: result.rotation,
    rotatedShape: result.rotatedShape,
    rotatedPorts: result.rotatedPorts,
    rotatedBioPorts: result.rotatedBioPorts || [],
    rotatedPeripheral: result.rotatedPeripheral
  });

  const wc = (result.wirePath || []).length;
  const wireMsg = wc > 0 ? ` (+ ${wc} wire${wc > 1 ? 's' : ''})` : '';
  console.log(`[Add] ${def.name} → [${result.row},${result.col}] r${result.rotation}°${wireMsg}`);
  debugLayoutStatus(state.placements, state.grid, `after adding ${def.name}`);

  bfClearSave(); // component set changed → discard resume snapshot
  bfResultsClear(); // component set changed → discard SA result history
  saveState();
  renderAll();
  showStatus(`${def.icon} ${def.name} → [${result.row},${result.col}] r${result.rotation}°${wireMsg}`, 'ok');
}

function removePlacement(event, idx) {
  event.stopPropagation();
  state.placements.splice(idx, 1);
  if (selectedPlacementIdx === idx) selectedPlacementIdx = null;
  else if (selectedPlacementIdx > idx) selectedPlacementIdx--;
  bfClearSave(); // component set changed → discard resume snapshot
  bfResultsClear(); // component set changed → discard SA result history
  saveState();
  renderAll();
  showStatus('Component removed.', 'ok');
}

function selectPlacement(idx) {
  selectedPlacementIdx = selectedPlacementIdx === idx ? null : idx;
  renderPlacedList();
}

function onComponentClick(idx) { selectPlacement(idx); }

// ─── Carry mode (click to pick up, R rotates, click to drop, Esc cancels) ──

let carryState = null;
// {
//   idx: position of the carried placement in state.placements,
//   origRow, origCol, origRotation, origShape, origPorts, origBioPorts, origPeri,
//   savedWires: [],
//   pickedUpAt: timestamp (suppress the same-event click that triggered pickup)
// }
const SNAP_PX = 5; // ghost snaps when cursor lies within this many SVG units of a cell center

function _mouseToGridCell(e) {
  const svg = document.getElementById('body-grid');
  if (!svg) return null;
  const rect = svg.getBoundingClientRect();
  const svgWidth = svg.viewBox.baseVal.width || rect.width;
  const svgHeight = svg.viewBox.baseVal.height || rect.height;
  const scaleX = svgWidth / rect.width;
  const scaleY = svgHeight / rect.height;
  const x = (e.clientX - rect.left) * scaleX;
  const y = (e.clientY - rect.top) * scaleY;
  const col = Math.floor((x - RENDERER_BUS_W) / RENDERER_CELL);
  const row = Math.floor((y - RENDERER_PERI_V) / RENDERER_CELL);
  return { row, col };
}

function _mouseToSvgCoords(clientX, clientY) {
  const svg = document.getElementById('body-grid');
  if (!svg) return null;
  const rect = svg.getBoundingClientRect();
  const svgWidth = svg.viewBox.baseVal.width || rect.width;
  const svgHeight = svg.viewBox.baseVal.height || rect.height;
  return {
    x: (clientX - rect.left) * (svgWidth / rect.width),
    y: (clientY - rect.top) * (svgHeight / rect.height)
  };
}

function onComponentClick(idx, e) {
  // While carrying, all clicks (including on other components) are drop attempts.
  if (carryState) return; // bubbles to document → onCarryClick handles drop
  if (e.button !== 0) return;
  e.stopPropagation();
  pickUpComponent(idx, e);
}

function pickUpComponent(idx, e) {
  const p = state.placements[idx];
  if (!p || p.componentId === 'wire') return;

  // Remove wires — they'd block validation at the new position and will be
  // recomputed when the component is dropped.
  const targetId = p.id;
  const wires = state.placements.filter(pp => pp.componentId === 'wire');
  state.placements = state.placements.filter(pp => pp.componentId !== 'wire');
  const newIdx = state.placements.findIndex(pp => pp.id === targetId);

  state.placements[newIdx]._carrying = true;

  carryState = {
    idx: newIdx,
    origRow: p.row,
    origCol: p.col,
    origRotation: p.rotation,
    origShape: p.rotatedShape,
    origPorts: p.rotatedPorts,
    origBioPorts: p.rotatedBioPorts || [],
    origPeri: p.rotatedPeripheral,
    savedWires: wires,
    pickedUpAt: Date.now()
  };

  document.addEventListener('mousemove', onCarryMove);
  document.addEventListener('click', onCarryClick, true); // capture phase
  document.addEventListener('keydown', onCarryKey);
  document.body.classList.add('carry-mode');

  const def = componentLib.find(d => d.id === p.componentId);
  showStatus(`Carrying: ${def?.name || p.componentId}. Move mouse, R = rotate, click = drop, Esc = cancel.`, 'ok');
  console.log(`[carry] pick up #${newIdx} (${p.componentId}) from [${p.origRow},${p.origCol}]`);

  renderAll();
  onCarryMove(e); // position ghost immediately
}

function onCarryMove(e) {
  if (!carryState) return;
  const cell = _mouseToGridCell(e);
  if (!cell) return;
  // Clamp to grid (cursor outside grid → leave ghost at last in-bound position)
  if (cell.row < 0 || cell.row >= state.grid.rows || cell.col < 0 || cell.col >= state.grid.cols) {
    _applyGhostOffset(e.clientX, e.clientY);
    return;
  }
  const p = state.placements[carryState.idx];
  if (p.row !== cell.row || p.col !== cell.col) {
    p.row = cell.row;
    p.col = cell.col;
    renderAll();
  }
  _applyGhostOffset(e.clientX, e.clientY);
}

// Apply a sub-cell SVG transform so the ghost visually follows the cursor
// pixel-by-pixel within the snap zone. Outside SNAP_PX of cell center,
// no offset is applied (ghost stays cell-aligned, like a snapped tile).
function _applyGhostOffset(clientX, clientY) {
  const g = document.querySelector('g[data-carrying="true"]');
  if (!g) return;
  const svgCoords = _mouseToSvgCoords(clientX, clientY);
  if (!svgCoords) return;
  const p = state.placements[carryState.idx];
  // Anchor: top-left of the component's bounding box (where shape begins)
  let minR = Infinity, minC = Infinity;
  for (const [r, c] of p.rotatedShape) {
    if (r < minR) minR = r;
    if (c < minC) minC = c;
  }
  const anchorX = RENDERER_BUS_W + (p.col + minC) * RENDERER_CELL + RENDERER_CELL / 2;
  const anchorY = RENDERER_PERI_V + (p.row + minR) * RENDERER_CELL + RENDERER_CELL / 2;
  const dx = svgCoords.x - anchorX;
  const dy = svgCoords.y - anchorY;
  if (Math.abs(dx) < SNAP_PX && Math.abs(dy) < SNAP_PX) {
    g.removeAttribute('transform');
  } else {
    g.setAttribute('transform', `translate(${dx} ${dy})`);
  }
}

function onCarryKey(e) {
  if (!carryState) return;
  // Don't intercept keys when user is typing in an input/textarea
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.key === 'Escape') {
    e.preventDefault();
    _cancelCarry();
  } else if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    _rotateCarried();
  }
}

function _rotateCarried() {
  const p = state.placements[carryState.idx];
  const def = componentLib.find(d => d.id === p.componentId);
  if (!def) return;
  const degs = getUniqueDegs(def);
  if (degs.length < 2) {
    showStatus(`${def.name}: rotation makes no sense (ports symmetric).`, 'warn');
    return;
  }
  const i = degs.indexOf(p.rotation);
  const nextRot = degs[((i < 0 ? 0 : i) + 1) % degs.length];
  const rotated = rotateComponent(def, nextRot);
  p.rotation = nextRot;
  p.rotatedShape = rotated.shape;
  p.rotatedPorts = rotated.energyPorts;
  p.rotatedBioPorts = rotated.bioPorts;
  p.rotatedPeripheral = buildRotatedPeri(def, nextRot);
  renderAll();
  console.log(`[carry] R → rotation ${nextRot}°`);
}

function onCarryClick(e) {
  if (!carryState) return;
  // Suppress the same click that initiated pickup
  if (Date.now() - carryState.pickedUpAt < 150) return;
  e.preventDefault();
  e.stopPropagation();
  _tryDropCarry();
}

function _tryDropCarry() {
  const p = state.placements[carryState.idx];

  // Bounds check (shape)
  for (const [r, c] of p.rotatedShape) {
    const gr = p.row + r, gc = p.col + c;
    if (gr < 0 || gr >= state.grid.rows || gc < 0 || gc >= state.grid.cols) {
      showStatus('Outside grid — try another spot.', 'warn');
      return;
    }
  }
  // Bounds check (peripheral)
  if (p.rotatedPeripheral) {
    const peri = p.rotatedPeripheral;
    const d = SIDE_DELTA[peri.port.side];
    const sR = p.row + peri.port.cell[0] + d.dr;
    const sC = p.col + peri.port.cell[1] + d.dc;
    for (const [r, c] of peri.shape) {
      const gr = sR + r, gc = sC + c;
      if (gr < 0 || gr >= state.grid.rows || gc < 0 || gc >= state.grid.cols) {
        showStatus('Peripheral would be outside grid.', 'warn');
        return;
      }
    }
  }
  // Overlap check (against non-wire, non-carried)
  const occupied = new Set();
  for (let i = 0; i < state.placements.length; i++) {
    if (i === carryState.idx) continue;
    const other = state.placements[i];
    if (other.componentId === 'wire') continue;
    for (const [r, c] of other.rotatedShape) occupied.add(`${other.row + r},${other.col + c}`);
    if (other.rotatedPeripheral) {
      const peri = other.rotatedPeripheral;
      const d = SIDE_DELTA[peri.port.side];
      const sR = other.row + peri.port.cell[0] + d.dr;
      const sC = other.col + peri.port.cell[1] + d.dc;
      peri.shape.forEach(([pr, pc]) => occupied.add(`${sR + pr},${sC + pc}`));
    }
  }
  for (const [r, c] of p.rotatedShape) {
    if (occupied.has(`${p.row + r},${p.col + c}`)) {
      showStatus('Collision — something is here.', 'warn');
      return;
    }
  }
  if (p.rotatedPeripheral) {
    const peri = p.rotatedPeripheral;
    const d = SIDE_DELTA[peri.port.side];
    const sR = p.row + peri.port.cell[0] + d.dr;
    const sC = p.col + peri.port.cell[1] + d.dc;
    for (const [r, c] of peri.shape) {
      if (occupied.has(`${sR + r},${sC + c}`)) {
        showStatus('Peripheral collides.', 'warn');
        return;
      }
    }
  }

  // Commit drop
  delete p._carrying;
  console.log(`[carry] drop #${carryState.idx} (${p.componentId}) at [${p.row},${p.col}] r${p.rotation}°`);

  // Recompute wires for the new layout
  const wired = tryAddWires(state.placements, state.grid);
  if (wired) {
    state.placements = wired;
    const newWireCount = wired.filter(pp => pp.componentId === 'wire').length;
    console.log(`[carry] after drop ${newWireCount} wires recomputed`);
  } else {
    showStatus('Placed, but cannot power — wire route to bus may be missing.', 'warn');
  }

  _endCarry();
  bfClearSave();
  bfResultsClear();
  saveState();
  renderAll();
}

function _cancelCarry() {
  const p = state.placements[carryState.idx];
  // Restore original placement
  p.row = carryState.origRow;
  p.col = carryState.origCol;
  p.rotation = carryState.origRotation;
  p.rotatedShape = carryState.origShape;
  p.rotatedPorts = carryState.origPorts;
  p.rotatedBioPorts = carryState.origBioPorts;
  p.rotatedPeripheral = carryState.origPeri;
  delete p._carrying;
  // Restore wires
  state.placements = [...state.placements, ...carryState.savedWires];
  _endCarry();
  renderAll();
  showStatus('Cancelled — component returned to original spot.', 'ok');
}

function _endCarry() {
  document.removeEventListener('mousemove', onCarryMove);
  document.removeEventListener('click', onCarryClick, true);
  document.removeEventListener('keydown', onCarryKey);
  document.body.classList.remove('carry-mode');
  carryState = null;
}

// Compute occupied-cells set excluding placement at excludeIdx.
function _occupiedExcept(excludeIdx) {
  const occupied = new Set();
  for (let i = 0; i < state.placements.length; i++) {
    if (i === excludeIdx) continue;
    const p = state.placements[i];
    if (!p.rotatedShape) continue;
    for (const [r, c] of p.rotatedShape) occupied.add(`${p.row + r},${p.col + c}`);
    // Also reserve peripheral cells of other placements
    if (p.rotatedPeripheral) {
      const peri = p.rotatedPeripheral;
      const d = SIDE_DELTA[peri.port.side];
      const sR = p.row + peri.port.cell[0] + d.dr;
      const sC = p.col + peri.port.cell[1] + d.dc;
      peri.shape.forEach(([r, c]) => occupied.add(`${sR + r},${sC + c}`));
    }
  }
  return occupied;
}

function tryRotatePlacement(idx, deltaRotation) {
  const p = state.placements[idx];
  if (p.componentId === 'wire') return false;
  const def = componentLib.find(d => d.id === p.componentId);
  if (!def) return false;

  const newRotation = ((p.rotation || 0) + deltaRotation + 360) % 360;
  if (newRotation === p.rotation) return false;
  const rotated = rotateComponent(def, newRotation);
  const newPeri = buildRotatedPeri(def, newRotation);

  // Bounds check for shape
  for (const [r, c] of rotated.shape) {
    const gr = p.row + r, gc = p.col + c;
    if (gr < 0 || gr >= state.grid.rows || gc < 0 || gc >= state.grid.cols) {
      showStatus('Rotation not possible — component would not fit in grid.', 'warn');
      return false;
    }
  }
  // Bounds check for peripheral
  if (newPeri) {
    const d = SIDE_DELTA[newPeri.port.side];
    const sR = p.row + newPeri.port.cell[0] + d.dr;
    const sC = p.col + newPeri.port.cell[1] + d.dc;
    for (const [r, c] of newPeri.shape) {
      const gr = sR + r, gc = sC + c;
      if (gr < 0 || gr >= state.grid.rows || gc < 0 || gc >= state.grid.cols) {
        showStatus('Rotation not possible — peripheral outside grid.', 'warn');
        return false;
      }
    }
  }

  // Overlap check against NON-WIRE placements only. Wires are auto-routed to
  // connect the component's current port direction; rotating changes that
  // direction so the existing wire path is obsolete. Including wires here
  // would falsely block valid rotations (user report: rotation rejected
  // despite a 3×5 free gap because old wires sat in the new shape's cells).
  const occupied = new Set();
  for (let i = 0; i < state.placements.length; i++) {
    if (i === idx) continue;
    const other = state.placements[i];
    if (other.componentId === 'wire') continue;
    for (const [r, c] of other.rotatedShape) occupied.add(`${other.row + r},${other.col + c}`);
    if (other.rotatedPeripheral) {
      const peri = other.rotatedPeripheral;
      const d = SIDE_DELTA[peri.port.side];
      const sR = other.row + peri.port.cell[0] + d.dr;
      const sC = other.col + peri.port.cell[1] + d.dc;
      peri.shape.forEach(([pr, pc]) => occupied.add(`${sR + pr},${sC + pc}`));
    }
  }
  for (const [r, c] of rotated.shape) {
    if (occupied.has(`${p.row + r},${p.col + c}`)) {
      showStatus('Rotation not possible — collision with another component.', 'warn');
      return false;
    }
  }
  if (newPeri) {
    const d = SIDE_DELTA[newPeri.port.side];
    const sR = p.row + newPeri.port.cell[0] + d.dr;
    const sC = p.col + newPeri.port.cell[1] + d.dc;
    for (const [r, c] of newPeri.shape) {
      if (occupied.has(`${sR + r},${sC + c}`)) {
        showStatus('Rotation not possible — peripheral collides.', 'warn');
        return false;
      }
    }
  }

  // Commit rotation
  state.placements[idx].rotation = newRotation;
  state.placements[idx].rotatedShape = rotated.shape;
  state.placements[idx].rotatedPorts = rotated.energyPorts;
  state.placements[idx].rotatedBioPorts = rotated.bioPorts;
  state.placements[idx].rotatedPeripheral = newPeri;

  // Drop old wires (their paths target the component's OLD port direction)
  // and recompute for the new layout.
  state.placements = state.placements.filter(pp => pp.componentId !== 'wire');
  const wired = tryAddWires(state.placements, state.grid);
  if (wired) {
    state.placements = wired;
  } else {
    showStatus('Component rotated, but cannot be powered — try another spot.', 'warn');
  }

  bfClearSave();
  saveState();
  renderAll();
  return true;
}

function onGlobalKeydown(e) {
  // Don't intercept when typing in inputs
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  // R key rotates selected component
  if ((e.key === 'r' || e.key === 'R') && selectedPlacementIdx !== null) {
    e.preventDefault();
    tryRotatePlacement(selectedPlacementIdx, 90);
  }
}

function expandBody() {
  const { grid } = state;
  if (grid.rows >= grid.maxRows && grid.cols >= grid.maxCols) return;
  if (grid.rows < grid.maxRows) grid.rows = Math.min(grid.rows + 2, grid.maxRows);
  if (grid.cols < grid.maxCols) grid.cols = Math.min(grid.cols + 2, grid.maxCols);
  bfClearSave(); // grid dims changed → discard resume snapshot
  bfResultsClear(); // grid dims changed → saved layouts may not fit anymore
  saveState();
  renderAll();
  showStatus(`Body expanded to ${grid.rows}×${grid.cols}.`, 'ok');
}

function resetLayout() {
  if (!confirm('Remove all components and reset layout to default size?')) return;
  state.placements = [];
  state.nextId = 1;
  state.grid.rows = 3;
  state.grid.cols = 4;
  selectedPlacementIdx = null;
  hideBetterLayoutOffer();
  bgOptId++;
  bfClearSave(); // layout cleared → discard resume snapshot
  bfResultsClear(); // layout cleared → no saved layouts are relevant
  saveState();
  renderAll();
  showStatus('Layout reset to default size (3×4).', 'ok');
}

async function optimizeAll() {
  if (state.placements.length === 0) return;

  const ids = ensureComponentOrder(
    state.placements
      .filter(p => p.componentId !== 'wire')
      .sort((a, b) => {
        const da = componentLib.find(d => d.id === a.componentId);
        const db = componentLib.find(d => d.id === b.componentId);
        const pa = da && da.peripheral ? 1 : 0;
        const pb = db && db.peripheral ? 1 : 0;
        const sa = da ? da.shape.length : 0;
        const sb = db ? db.shape.length : 0;
        return (pb - pa) || (sb - sa);
      })
      .map(p => p.componentId)
  );

  console.log('[Optimize] Order:', ids.join(' → '));
  showStatus(`Optimizing ${ids.length} components…`, 'ok');

  // Save original for rollback — non-wire components must NEVER disappear
  const savedPlacements = state.placements.slice();
  const savedNextId = state.nextId;

  // Async loop: yield between components so browser stays responsive
  state.placements = [];
  state.nextId = 1;
  selectedPlacementIdx = null;

  const skipped = [];
  for (let i = 0; i < ids.length; i++) {
    await new Promise(resolve => setTimeout(resolve, 0)); // yield to browser

    const id  = ids[i];
    const def = componentLib.find(d => d.id === id);
    if (!def) continue;
    const result = findBestPlacement(def, state, ids.slice(i + 1));
    if (!result) {
      console.warn(`[Optimize] ✗ ${def.name}: no valid position`);
      skipped.push(def.name);
      continue;
    }
    const wireDef = componentLib.find(d => d.id === 'wire');
    (result.wirePath || []).forEach(([r, c]) => {
      if (!wireDef) return;
      state.placements.push({
        id: state.nextId++, componentId: 'wire',
        row: r, col: c, rotation: 0,
        rotatedShape: [[0,0]],
        rotatedPorts: wireDef.energyPorts.map(p => ({ cell: [...p.cell], side: p.side })),
        rotatedBioPorts: [],
        rotatedPeripheral: null, autoPlaced: true
      });
    });
    state.placements.push({
      id: state.nextId++, componentId: id,
      row: result.row, col: result.col, rotation: result.rotation,
      rotatedShape: result.rotatedShape, rotatedPorts: result.rotatedPorts,
      rotatedBioPorts: result.rotatedBioPorts || [],
      rotatedPeripheral: result.rotatedPeripheral
    });
    const wires = (result.wirePath || []).length;
    console.log(`[Optimize] ✓ ${def.name} → [${result.row},${result.col}] r${result.rotation}°${wires ? ` +${wires}w` : ''}`);
  }

  if (skipped.length > 0) {
    state.placements = savedPlacements;
    state.nextId = savedNextId;
    selectedPlacementIdx = null;
    saveState();
    renderAll();
    const uniqueNames = [...new Set(skipped)];
    showStatus(`Optimization not possible: ${uniqueNames.join(', ')} does not fit. Expand body.`, 'error');
    return;
  }

  debugLayoutStatus(state.placements, state.grid, 'optimization result');

  if (!isLayoutValid(state.placements, state.grid)) {
    state.placements = savedPlacements;
    state.nextId = savedNextId;
    selectedPlacementIdx = null;
    saveState();
    renderAll();
    showStatus('Optimizer did not find a valid layout. Try a larger body or a different order.', 'error');
    return;
  }

  saveState();
  renderAll();
  showStatus(`Optimized (${state.placements.length} items).`, 'ok');
}

// ─── Background Optimizer ─────────────────────────────────────────────────────

// Order: other core → interleaved Rep/Spin (Rep→Spin→Rep→Spin…) → bio-only
// Interleaving ensures each Spinner connects to a Repeater placed just before it.
function ensureComponentOrder(ids) {
  const bioOnlySet = new Set(
    componentLib
      .filter(d => d.energyPorts.length === 0 && (d.bioPorts || []).length > 0)
      .map(d => d.id)
  );
  const repeaterSet = new Set(['repeater_2s', 'repeater_4s']);
  const spinnerSet  = new Set(['spinner', 'pulser']);

  const bioOnly  = ids.filter(id => bioOnlySet.has(id));
  const reps     = ids.filter(id => repeaterSet.has(id));
  const spinners = ids.filter(id => spinnerSet.has(id));
  const other    = ids.filter(id => !bioOnlySet.has(id) && !repeaterSet.has(id) && !spinnerSet.has(id));

  // Interleave: Rep → Spin → Rep → Spin → remaining Reps
  // Repeater goes first (connects to bus, gets powered), Spinner then connects to the
  // powered Repeater (energyBonus=2000). Next Repeater sees the now-powered Spinner
  // and snaps to its free port (energyBonus=2000), continuing the chain.
  const interleaved = [];
  const repQ  = [...reps];
  const spinQ = [...spinners];
  while (repQ.length > 0 || spinQ.length > 0) {
    if (repQ.length > 0)  interleaved.push(repQ.shift()); // Rep first!
    if (spinQ.length > 0) interleaved.push(spinQ.shift());
  }

  return [...other, ...interleaved, ...bioOnly];
}

// scoreLayout moved to src/optimizer/score.js

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Generates ALL permutations of arr (use only for small arrays, ≤ 7 items)
function allPermutations(arr) {
  if (arr.length <= 1) return [arr.slice()];
  const result = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const perm of allPermutations(rest)) result.push([arr[i], ...perm]);
  }
  return result;
}

// isLayoutValid moved to src/optimizer/validate.js

// Debug helper: logs powered/working status of current layout to console.
// Prints one collapsed group — no spam, only important facts.
function debugLayoutStatus(placements, grid, label) {
  const powered  = computePoweredSet(placements, grid.rows, grid.cols);
  const working  = computeWorkingSet(placements);
  const hasReps  = placements.some(p => p.componentId === 'repeater_4s' || p.componentId === 'repeater_2s');
  const nonWires = placements.map((p, i) => ({ p, i })).filter(({ p }) => p.componentId !== 'wire');
  const powOk    = nonWires.filter(({ i }) => powered.has(i)).length;
  const spinners = nonWires.filter(({ p }) => p.componentId === 'spinner');
  const unpow    = nonWires.filter(({ i }) => !powered.has(i)).map(({ p }) => p.componentId);

  const portMap = new Map();
  placements.forEach((p, pi) => {
    (p.rotatedPorts || []).forEach(({ cell, side }) => {
      const key = `${p.row+cell[0]},${p.col+cell[1]},${side}`;
      if (!portMap.has(key)) portMap.set(key, []);
      portMap.get(key).push(pi);
    });
  });

  const tag = label ? ` ${label}` : '';
  const ok  = powOk === nonWires.length && (spinners.length === 0 || spinners.every(({ i }) => !hasReps || working.has(i)));
  console.groupCollapsed(`[Layout${tag}] ${nonWires.length} comps | powered ${powOk}/${nonWires.length} | spinners ${spinners.filter(({i})=>working.has(i)).length}/${spinners.length} working ${ok ? '✓' : '⚠'}`);
  if (unpow.length > 0) console.warn('  Unpowered:', unpow.join(', '));
  spinners.forEach(({ p, i }) => {
    const adjReps = [];
    (p.rotatedPorts || []).forEach(({ cell, side }) => {
      const gr = p.row + cell[0], gc = p.col + cell[1];
      const d  = SIDE_DELTA[side];
      const adjKey = `${gr+d.dr},${gc+d.dc},${OPPOSITE[side]}`;
      (portMap.get(adjKey) || []).forEach(ri => {
        const cid = placements[ri].componentId;
        if (cid === 'repeater_2s' || cid === 'repeater_4s') adjReps.push(`${cid}@${side}`);
      });
    });
    const wok    = working.has(i);
    const status = wok ? '✓ WORKING' : (hasReps ? '✗ NO REPEATER' : '(no reps in layout)');
    console.log(`  Spinner [${p.row},${p.col}] r${p.rotation}°: ${status} | neighbors: ${adjReps.join(', ') || '–'}`);
  });
  console.groupEnd();
}

// Generates a cluster-aware ordering: Spinners are followed by their Repeaters,
// other components are randomly interleaved. Designed for large N (> 7).
function generateClusterOrdering(nonWireIds) {
  const REP_IDS = new Set(['repeater_4s', 'repeater_2s']);

  const spinners = shuffleArray(nonWireIds.filter(id => id === 'spinner'));
  const pulsers  = shuffleArray(nonWireIds.filter(id => id === 'pulser'));
  const reps     = shuffleArray(nonWireIds.filter(id => REP_IDS.has(id)));
  const others   = shuffleArray(nonWireIds.filter(id =>
    id !== 'spinner' && id !== 'pulser' && !REP_IDS.has(id)
  ));

  // Build Repeater-Spinner chain: Rep → Spin → Rep → Spin → Rep (chain propagation)
  // Each Spinner is PRECEDED by its assigned Repeater(s), so Spinner can connect
  // to the already-powered Repeater (energyBonus=2000 instead of 0).
  const spinRepSeq = [];
  let ri = 0;
  const baseAssign = spinners.length > 0 ? Math.max(1, Math.floor(reps.length / spinners.length)) : 0;

  for (const spin of spinners) {
    // Push assigned Repeater(s) BEFORE this Spinner
    const n = baseAssign + (Math.random() < 0.5 && ri + baseAssign < reps.length ? 1 : 0);
    for (let k = 0; k < n && ri < reps.length; k++) spinRepSeq.push(reps[ri++]);
    spinRepSeq.push(spin);
  }

  // Pulsers: optionally preceded by a remaining Repeater
  for (const pulser of pulsers) {
    if (Math.random() < 0.4 && ri < reps.length) spinRepSeq.push(reps[ri++]);
    spinRepSeq.push(pulser);
  }

  // Remaining Repeaters (if more Repeaters than Spinners need)
  while (ri < reps.length) spinRepSeq.push(reps[ri++]);

  // Randomly interleave 'others' throughout the Spinner+Repeater sequence
  const result = [...spinRepSeq];
  for (const other of others) {
    const pos = Math.floor(Math.random() * (result.length + 1));
    result.splice(pos, 0, other);
  }
  return result;
}

// Finds any non-overlapping position for a component, ignoring power connections.
// Used as last-resort fallback when optimizer cannot wire the component.
function findAnyPlacement(def, state) {
  const { grid, placements } = state;
  const occupiedMap = getOccupiedMap(placements);
  placements.forEach(p => {
    if (!p.rotatedPeripheral) return;
    const peri = p.rotatedPeripheral;
    const d = SIDE_DELTA[peri.port.side];
    const sR = p.row + peri.port.cell[0] + d.dr;
    const sC = p.col + peri.port.cell[1] + d.dc;
    peri.shape.forEach(([r, c]) => { const k = `${sR+r},${sC+c}`; if (!occupiedMap.has(k)) occupiedMap.set(k, -1); });
  });
  for (const deg of [0, 90, 180, 270]) {
    const rotated = rotateComponent(def, deg);
    const bounds = getBounds(rotated.shape);
    if (bounds.height > grid.rows || bounds.width > grid.cols) continue;
    for (let row = 0; row <= grid.rows - bounds.height; row++) {
      for (let col = 0; col <= grid.cols - bounds.width; col++) {
        if (hasOverlap(rotated.shape, row, col, occupiedMap)) continue;
        return { row, col, rotation: deg, rotatedShape: rotated.shape, rotatedPorts: rotated.energyPorts, rotatedBioPorts: rotated.bioPorts || [] };
      }
    }
  }
  return null;
}

// getUniqueDegs moved to src/optimizer/rotation.js

// Counts exact number of valid root positions for the first component (depth-1 branches).
// Uses unique rotations to match the actual generator behaviour.
function countDepth1Positions(nonWireIds, grid) {
  const ordered = [...nonWireIds].sort((a, b) => {
    const da = componentLib.find(d => d.id === a);
    const db = componentLib.find(d => d.id === b);
    return (db?.shape.length || 0) - (da?.shape.length || 0);
  });
  if (ordered.length === 0) return 0;
  const def = componentLib.find(d => d.id === ordered[0]);
  if (!def) return 0;

  let count = 0;
  for (const deg of getUniqueDegs(def)) {
    const { shape } = rotateComponent(def, deg);
    const bounds = getBounds(shape);
    if (bounds.height > grid.rows || bounds.width > grid.cols) continue;
    for (let row = 0; row <= grid.rows - bounds.height; row++)
      for (let col = 0; col <= grid.cols - bounds.width; col++)
        count++;
  }
  return count;
}

// Upper-bound estimate of total leaf combinations (ignores component overlap).
// Computed in log-space to avoid floating-point overflow for large layouts.
// Returns a formatted string like "3.2e+25".
function estimateTotalCombinations(nonWireIds, grid) {
  const ordered = [...nonWireIds].sort((a, b) => {
    const da = componentLib.find(d => d.id === a);
    const db = componentLib.find(d => d.id === b);
    return (db?.shape.length || 0) - (da?.shape.length || 0);
  });

  let logTotal = 0;
  const countById = new Map();
  for (const id of ordered) {
    const def = componentLib.find(d => d.id === id);
    if (!def) continue;
    let pos = 0;
    for (const deg of getUniqueDegs(def)) {
      const { shape } = rotateComponent(def, deg);
      const b = getBounds(shape);
      if (b.height > grid.rows || b.width > grid.cols) continue;
      pos += (grid.rows - b.height + 1) * (grid.cols - b.width + 1);
    }
    if (pos <= 0) continue;
    logTotal += Math.log10(pos);
    countById.set(id, (countById.get(id) || 0) + 1);
  }
  // Divide by N! for each group of identical components (ordering pruning)
  for (const n of countById.values()) {
    for (let i = 2; i <= n; i++) logTotal -= Math.log10(i);
  }

  if (logTotal < 6) return String(Math.round(Math.pow(10, logTotal)));
  const exp = Math.floor(logTotal);
  const man = Math.pow(10, logTotal - exp);
  return man.toFixed(1) + 'e+' + exp;
}

// ─── Brute Force Generator moved to src/bruteforce/generator.js ───────


// For each unpowered energy component in a brute-force candidate layout, tries to find
// a wire path that connects it to the bus or to an already-powered component.
// Returns the layout augmented with wires, or null if any component cannot be powered.
// tryAddWires moved to src/optimizer/validate.js

// Async version: yields to browser between components so UI stays responsive.
async function runOptimizationAsync(componentIds, grid) {
  const wireDef   = componentLib.find(d => d.id === 'wire');
  const fakeState = { grid: { ...grid }, placements: [], nextId: 1 };

  for (let idx = 0; idx < componentIds.length; idx++) {
    // Yield to browser between components — prevents UI freeze
    await new Promise(resolve => setTimeout(resolve, 0));

    const id  = componentIds[idx];
    const def = componentLib.find(d => d.id === id);
    if (!def) continue;
    const result = findBestPlacement(def, fakeState, componentIds.slice(idx + 1));
    if (!result) continue;

    (result.wirePath || []).forEach(([r, c]) => {
      if (!wireDef) return;
      fakeState.placements.push({
        id: fakeState.nextId++, componentId: 'wire',
        row: r, col: c, rotation: 0,
        rotatedShape: [[0,0]],
        rotatedPorts: wireDef.energyPorts.map(p => ({ cell: [...p.cell], side: p.side })),
        rotatedBioPorts: [],
        rotatedPeripheral: null, autoPlaced: true
      });
    });

    fakeState.placements.push({
      id: fakeState.nextId++, componentId: id,
      row: result.row, col: result.col, rotation: result.rotation,
      rotatedShape: result.rotatedShape, rotatedPorts: result.rotatedPorts,
      rotatedBioPorts: result.rotatedBioPorts || [],
      rotatedPeripheral: result.rotatedPeripheral
    });
  }

  return fakeState.placements;
}

function scheduleBackgroundOpt() {
  scheduleBruteForceOpt();
}

// ─── Brute force save/load/export/import moved to src/bruteforce/save.js ──


// Settings (loadSettings, saveSettings, getThreadCount, openSettings, closeSettings,
// onThreadsChange) moved to src/ui/settings.js

// Pretty-print rolling brute-force timings and reset the accumulators.
// Helps identify which phase of the search loop dominates wall time.
function logBFTimings(timings) {
  const fmtT = (ms) => {
    if (ms >= 1000) return (ms / 1000).toFixed(2) + 's';
    if (ms >= 1)    return ms.toFixed(2) + 'ms';
    if (ms >= 0.001) return (ms * 1000).toFixed(1) + 'μs';
    return (ms * 1e6).toFixed(0) + 'ns';
  };
  const fmtN = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M'
                    : n >= 1000 ? (n / 1000).toFixed(1) + 'k'
                    : String(n);
  const labels = {
    genNext:  'gen.next   ',
    busCheck: 'busCheck   ',
    isValid:  'isValid    ',
    tryWires: 'tryAddWires',
    score:    'scoreLayout',
    batch:    'batch      '
  };
  const lines = [];
  // Compute total wall (batch sum) for % breakdown
  const wall = timings.batch ? timings.batch.sum : 0;
  for (const cat of ['genNext', 'busCheck', 'isValid', 'tryWires', 'score', 'batch']) {
    const t = timings[cat];
    if (!t) continue;
    if (t.count === 0) {
      lines.push(`  ${labels[cat]}: —`);
    } else {
      const avg = t.sum / t.count;
      const pct = (wall > 0 && cat !== 'batch') ? ((t.sum / wall) * 100).toFixed(0) + '%' : '';
      lines.push(`  ${labels[cat]}: total ${fmtT(t.sum).padStart(8)}  avg ${fmtT(avg).padStart(8)}  max ${fmtT(t.max).padStart(8)}  calls ${fmtN(t.count).padStart(6)}${pct ? '  ' + pct : ''}`);
    }
    // Reset for next 60s window
    t.sum = 0; t.count = 0; t.max = 0;
  }
  console.log('[BruteForce timings · 60s window]\n' + lines.join('\n'));
}

function scheduleBruteForceOpt() {
  const myId = ++bgOptId;
  pendingBetterLayout = null;
  hideBetterLayoutOffer();

  // Biocell/disposable_biocell are auto-placed as bio_generator peripherals — exclude from search
  const BIO_PERIPHERAL_IDS = new Set(['biocell', 'disposable_biocell']);
  const nonWireIds = state.placements
    .filter(p => p.componentId !== 'wire' && !BIO_PERIPHERAL_IDS.has(p.componentId))
    .map(p => p.componentId);

  if (nonWireIds.length <= 1) return;

  // For large layouts, warn that search may take hours/days but don't block —
  // the first valid layout is typically found within minutes even for 20+ components.
  if (nonWireIds.length > 10) {
    console.info(`[BruteForce] Large layout (${nonWireIds.length} components) — finding the first valid combination may take a while. UI stays responsive.`);
    showStatus(`Brute force: ${nonWireIds.length} components — searching for the first valid combination…`, 'ok');
  }

  // ── Phase 2: brute force runs in N Web Workers, each on a slice of depth-0 branches. ──
  const idsKey = _bfBuildIdsKey(nonWireIds);
  const N = getThreadCount();
  const saved = bfLoadSave();

  // Compute totalBranches first — we need it to plan ranges
  const t0 = Date.now();
  const totalBranches  = countDepth1Positions(nonWireIds, state.grid);
  const totalCombosStr = estimateTotalCombinations(nonWireIds, state.grid);
  console.log(`[BruteForce] countDepth1Positions: ${totalBranches} branches in ${Date.now()-t0}ms, combination estimate: ${totalCombosStr}`);

  // Decide whether and how to resume from saved state
  let workerInitStates = null; // per-worker resume data; null means fresh start
  let resumed = false;
  if (saved && saved.idsKey === idsKey && saved.rows === state.grid.rows && saved.cols === state.grid.cols) {
    if (saved.v === 2 && Array.isArray(saved.workers) && saved.threadCount === N) {
      // Full multi-worker resume
      workerInitStates = saved.workers.map(w => ({
        branchRange: w.branchRange,
        currentBranchIdx: w.currentBranchIdx,
        path: w.path || [],
        stats: w.stats || {}
      }));
      resumed = true;
      console.log(`[BruteForce] Resuming multi-worker search (${N} threads, ${saved.workers.length} workers saved).`);
    } else if (saved.v === 1 && N === 1) {
      // Legacy single-worker save matches current N=1 setup
      workerInitStates = [{
        branchRange: [0, totalBranches],
        currentBranchIdx: 0, // legacy save doesn't track this; restart current branch
        path: saved.path || [],
        stats: saved.stats || {}
      }];
      resumed = true;
      console.log('[BruteForce] Resuming legacy v=1 save (single worker).');
    } else if (saved.v === 1) {
      // Legacy v=1 save with N>1 → migrate: split branches into N ranges,
      // assign the v=1 path to whichever worker owns the current branch.
      const v1Path = saved.path || [];
      const v1Stats = saved.stats || {};
      const v1CurrentBranch = v1Stats.completedBranches || 0;
      const ranges = _computeBranchRanges(totalBranches, N);
      workerInitStates = ranges.map(([start, end]) => {
        if (v1CurrentBranch >= start && v1CurrentBranch < end) {
          // This worker's slice contains the v=1 current branch — resume here
          return { branchRange: [start, end], currentBranchIdx: v1CurrentBranch, path: v1Path, stats: v1Stats };
        } else if (end <= v1CurrentBranch) {
          // Slice is entirely behind v=1's progress — skip (terminates immediately)
          return { branchRange: [start, end], currentBranchIdx: end, path: [], stats: {} };
        } else {
          // Slice is past v=1's progress — fresh start
          return { branchRange: [start, end], currentBranchIdx: start, path: [], stats: {} };
        }
      });
      resumed = true;
      console.log(`[BruteForce] Migration v=1 → v=2: distributed across ${N} workers (v=1 was at branch ${v1CurrentBranch}).`);
    } else if (saved.v === 2 && Array.isArray(saved.workers) && saved.threadCount !== N) {
      // v=2 save with different thread count → re-distribute completed branches.
      // Collect all completed/in-progress branches and redistribute the remainder.
      const completedSet = new Set();
      let bestPath = [];
      let bestPathBranch = -1;
      let bestPathStats = {};
      for (const w of saved.workers) {
        const [s] = w.branchRange;
        const cur = w.currentBranchIdx ?? s;
        for (let b = s; b < cur; b++) completedSet.add(b);
        // Save the deepest active path so worker covering that branch can resume it
        if (w.path && w.path.length > bestPath.length) {
          bestPath = w.path;
          bestPathBranch = cur;
          bestPathStats = w.stats || {};
        }
      }
      const ranges = _computeBranchRanges(totalBranches, N);
      workerInitStates = ranges.map(([start, end]) => {
        // Skip ahead past any contiguous completed branches at the start
        let cur = start;
        while (cur < end && completedSet.has(cur)) cur++;
        const usesBestPath = (bestPathBranch >= cur && bestPathBranch < end && bestPath.length > 0);
        return {
          branchRange: [start, end],
          currentBranchIdx: usesBestPath ? bestPathBranch : cur,
          path: usesBestPath ? bestPath : [],
          stats: usesBestPath ? bestPathStats : {}
        };
      });
      resumed = true;
      console.log(`[BruteForce] Migration v=2 thread count ${saved.threadCount} → ${N}: ${completedSet.size} branches already completed, redistributing.`);
    } else {
      console.log(`[BruteForce] Saved state does not match configuration (v=${saved.v}, threads=${saved.threadCount}, current N=${N}) — starting from scratch.`);
      // Note: do NOT call bfClearSave() here — bestLayout below still useful
    }
  } else if (saved) {
    console.log('[BruteForce] Saved state does not match current layout — starting from scratch.');
    bfClearSave();
  }

  // Restore bestLayout if save exists for matching layout (even if not "resuming" config)
  if (saved && saved.idsKey === idsKey
      && saved.rows === state.grid.rows && saved.cols === state.grid.cols
      && saved.bestLayout && Array.isArray(saved.bestLayout) && saved.bestLayout.length > 0) {
    try {
      state.placements = saved.bestLayout.map(rehydratePlacement);
      state.nextId = state.placements.length + 1;
      renderAll();
    } catch (e) { console.warn('[BruteForce] Failed to restore bestLayout:', e.message); }
  }

  // Set up per-worker state (live on main thread)
  const ranges = workerInitStates
    ? workerInitStates.map(w => w.branchRange)
    : _computeBranchRanges(totalBranches, N);
  const workerStates = ranges.map((range, i) => {
    const init = workerInitStates ? workerInitStates[i] : null;
    return {
      branchRange: range,
      currentBranchIdx: init?.currentBranchIdx ?? range[0],
      path: init?.path || [],
      stats: init?.stats || { checked: 0, valid: 0, ticks: 0, completedBranches: 0, bestScore: -Infinity }
    };
  });

  // Aggregated stats (updated from worker progress messages)
  const currentScore = scoreLayout(state.placements, state.grid);
  let bestScore = workerStates.reduce((m, w) => Math.max(m, w.stats.bestScore ?? -Infinity), -Infinity);
  if (!Number.isFinite(bestScore)) bestScore = currentScore;
  let checked  = workerStates.reduce((s, w) => s + (w.stats.checked  || 0), 0);
  let valid    = workerStates.reduce((s, w) => s + (w.stats.valid    || 0), 0);
  let ticks    = workerStates.reduce((s, w) => s + (w.stats.ticks    || 0), 0);
  let completedBranches = workerStates.reduce((s, w) => s + (w.stats.completedBranches || 0), 0);
  const startTime = (resumed && saved.elapsedMs) ? Date.now() - saved.elapsedMs : Date.now();

  function aggregate() {
    checked  = workerStates.reduce((s, w) => s + (w.stats.checked  || 0), 0);
    valid    = workerStates.reduce((s, w) => s + (w.stats.valid    || 0), 0);
    ticks    = workerStates.reduce((s, w) => s + (w.stats.ticks    || 0), 0);
    completedBranches = workerStates.reduce((s, w) => s + (w.stats.completedBranches || 0), 0);
    const bs = workerStates.reduce((m, w) => Math.max(m, w.stats.bestScore ?? -Infinity), -Infinity);
    if (Number.isFinite(bs) && bs > bestScore) bestScore = bs;
  }

  let lastProgressUpdate = 0;
  let finishedWorkers = 0;

  // Spawn N workers
  currentBfWorkers = [];
  for (let i = 0; i < N; i++) {
    const w = new Worker('bruteforce-worker.js?v=91');
    currentBfWorkers.push(w);

    w.onmessage = (e) => {
      if (bgOptId !== myId) {
        try { w.terminate(); } catch (err) {}
        return;
      }
      const msg = e.data;
      const ws = workerStates[i];
      switch (msg.type) {
        case 'ready': {
          // Tell this worker its range (resume current branch if applicable)
          w.postMessage({
            type: 'start',
            workerId: i,
            nonWireIds,
            grid: { rows: state.grid.rows, cols: state.grid.cols },
            branchStart: ws.currentBranchIdx,
            branchEnd: ws.branchRange[1],
            resumePath: (ws.path && ws.path.length > 0) ? ws.path : null,
            resumeStats: ws.stats || null
          });
          break;
        }
        case 'progress': {
          ws.stats = msg.stats || ws.stats;
          if (msg.path) ws.path = msg.path;
          if (typeof msg.currentBranchIdx === 'number') ws.currentBranchIdx = msg.currentBranchIdx;
          aggregate();
          const now = Date.now();
          if (now - lastProgressUpdate >= 60_000) {
            lastProgressUpdate = now;
            updateBFProgress(false);
            bfSaveStateV2(idsKey, state.grid.rows, state.grid.cols, totalBranches, N, workerStates, state.placements, now - startTime);
          }
          break;
        }
        case 'leaf': {
          const finalPl = (msg.layout || []).map(rehydratePlacement);
          const score = msg.score;
          const isFirstGlobal = (valid === 0); // first valid found across all workers
          ws.stats.valid = (ws.stats.valid || 0) + 0; // valid already in stats from worker
          if (score > bestScore || isFirstGlobal) {
            bestScore = score;
            state.placements = finalPl;
            state.nextId = finalPl.length + 1;
            saveState();
            renderAll();
            const elapsedS = ((Date.now() - startTime) / 1000).toFixed(1);
            if (isFirstGlobal) {
              console.log(`[BruteForce] First valid (worker ${i}) in ${elapsedS}s (score=${score})`);
              debugLayoutStatus(finalPl, state.grid, `BF — first valid (worker ${i})`);
              showStatus(`Brute force: first valid found by worker ${i} (${elapsedS}s). Searching for better…`, 'ok');
            } else {
              console.log(`[BruteForce] Better (worker ${i}) score=${score}`);
              debugLayoutStatus(finalPl, state.grid, `BF applied (worker ${i})`);
            }
          }
          break;
        }
        case 'done': {
          finishedWorkers++;
          try { w.terminate(); } catch (err) {}
          console.log(`[BruteForce] Worker ${i} done (${finishedWorkers}/${N}).`);
          if (finishedWorkers >= N) {
            bfClearSave();
            aggregate();
            const completeMsg = valid > 0
              ? `Brute force complete (${N} threads): ${valid} valid layouts from ${fmtNum(checked)} combinations.`
              : `Brute force complete (${N} threads): no valid layouts (${fmtNum(checked)} combinations).`;
            console.log(`[BruteForce] ${completeMsg}`);
            updateBFProgress(true, completeMsg);
            currentBfWorkers = [];
          }
          break;
        }
        case 'stopped': {
          try { w.terminate(); } catch (err) {}
          break;
        }
        case 'error': {
          console.error(`[BruteForce Worker ${i}]`, msg.message);
          showStatus(`Worker ${i}: ${msg.message}`, 'error');
          break;
        }
      }
    };

    w.onerror = (err) => {
      console.error(`[BruteForce Worker ${i}] onerror:`, err.message, err.filename, err.lineno);
      showStatus(`Worker ${i} selhal: ${err.message}`, 'error');
    };

    w.postMessage({ type: 'init', componentLib });
  }

  function fmtNum(n) {
    return n >= 1e9 ? (n / 1e9).toFixed(1) + 'G'
         : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M'
         : n >= 1000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k'
         : String(n);
  }

  // Format seconds as d:h:m — seconds are not displayed (updates are every 60s anyway).
  function fmtDHM(sec) {
    if (sec < 0) sec = 0;
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const parts = [];
    if (d > 0) parts.push(d + 'd');
    if (h > 0 || d > 0) parts.push(h + 'h');
    parts.push(m + 'm');
    return parts.join(' ');
  }

  const bfEl = document.getElementById('bf-progress');
  function updateBFProgress(isDone, doneMsg) {
    if (!bfEl) return;
    if (isDone) {
      bfEl.style.display = 'none';
      bfEl.textContent   = '';
      if (doneMsg) showStatus(doneMsg, valid > 0 ? 'ok' : 'error');
      return;
    }

    const elapsedSec = (Date.now() - startTime) / 1000;
    let pctStr = '', etaStr = '';

    if (totalBranches > 0 && completedBranches > 0) {
      // Exact % + ETA from completed branches
      const pct = Math.min(99.9, (completedBranches / totalBranches) * 100);
      pctStr = (pct < 1 ? pct.toFixed(2) : pct < 10 ? pct.toFixed(1) : Math.floor(pct)) + '%';
      const secPerBranch = elapsedSec / completedBranches;
      etaStr = 'eta ' + fmtDHM((totalBranches - completedBranches) * secPerBranch);
    } else if (totalBranches > 0) {
      // Still in first branch — estimate: time so far × total branches = total time
      // Conservative (assumes we're near start of first branch); shown as approximate.
      etaStr = 'eta ~' + fmtDHM(elapsedSec * (totalBranches - 1)) + ' (estimate)';
    }

    const elStr = fmtDHM(elapsedSec);
    const parts = ['⚡²'];
    if (pctStr) parts.push(pctStr);
    const totalSuffix = totalCombosStr ? ' of ~' + totalCombosStr : '';
    if (checked > 0) {
      parts.push(fmtNum(checked) + ' combos' + totalSuffix);
    } else {
      parts.push('searching… ≈' + fmtNum(ticks * 300) + ' nodes' + totalSuffix);
    }
    parts.push(elStr + ' elapsed');
    if (etaStr) parts.push(etaStr);

    bfEl.style.display = 'inline';
    bfEl.textContent   = parts.join(' · ');
  }

  console.log(`[BruteForce] Start: ${nonWireIds.length} components, grid ${state.grid.rows}×${state.grid.cols}, depth-1 branches: ${totalBranches} (worker thread)`);
  if (bfEl) { bfEl.style.display = 'inline'; bfEl.textContent = '⚡² …'; }
}

function startBruteForce() {
  scheduleBruteForceOpt();
  showStatus('Brute force started — searching all combinations...', 'ok');
}

// ─── Simulated Annealing dispatcher ─────────────────────────────────────────
// Spawns N workers, each runs an independent SA from a different random seed.
// Best layout across all workers is applied. SA is the PRIMARY algorithm —
// orders of magnitude faster than brute force for non-trivial layouts.

let currentSaWorkers = [];

// Top-K best VALID layouts found by SA — newest improvements go on top.
// Persisted to localStorage (key BF_RESULTS_KEY) so they survive reloads.
const BF_RESULTS_MAX = 20;
const BF_RESULTS_KEY = 'bf_results_v1';
let bfResults = []; // [{ layout, score, foundAt, workerId }] sorted by score desc

// Canonical key for a component set (non-wires only, sorted). Two layouts
// with the same key are interchangeable in SA terms; mismatched keys mean
// applying a saved layout would lose or duplicate components.
function _componentSetKey(placements) {
  return (placements || [])
    .filter(p => p.componentId !== 'wire')
    .map(p => p.componentId)
    .sort()
    .join(',');
}

// Auto-follow flag: when true, the grid auto-switches to the new #1 result
// whenever a better one arrives. Browsing a different slot turns this off
// (so the user's chosen layout isn't replaced behind their back). Clicking
// the "TOP" button re-enables it and snaps back to #1.
let bfAutoFollowTop = true;

function bfResultsLoad() {
  try {
    const raw = localStorage.getItem(BF_RESULTS_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (e) { return []; }
}

function bfResultsSave() {
  try {
    localStorage.setItem(BF_RESULTS_KEY, JSON.stringify(bfResults));
  } catch (e) {
    // Quota exceeded — drop oldest until it fits
    console.warn('[bfResults] LocalStorage full — trimming oldest:', e.message);
    while (bfResults.length > 5) {
      bfResults.pop();
      try { localStorage.setItem(BF_RESULTS_KEY, JSON.stringify(bfResults)); return; } catch (e2) {}
    }
  }
}

function bfResultsClear() {
  bfResults = [];
  try { localStorage.removeItem(BF_RESULTS_KEY); } catch (e) {}
  renderBfResults();
}

function startAnneal() {
  // Note: don't clear bfResults — they persist across runs (up to 20) so the
  // user can compare new SA output against earlier sessions.
  bfAutoFollowTop = true;
  renderBfResults();
  scheduleAnnealOpt();
  showStatus('SA started — shell pack + greedy fill, then 6 workers with different strategies.', 'ok');
}

function stopAllWorkers() {
  bgOptId++;
  let stopped = 0;
  for (const w of currentBfWorkers) {
    try { w.postMessage({ type: 'stop' }); } catch (e) {}
    try { w.terminate(); } catch (e) {}
    stopped++;
  }
  for (const w of currentSaWorkers) {
    try { w.postMessage({ type: 'stop' }); } catch (e) {}
    try { w.terminate(); } catch (e) {}
    stopped++;
  }
  currentBfWorkers = [];
  currentSaWorkers = [];
  const bfEl = document.getElementById('bf-progress');
  if (bfEl) { bfEl.style.display = 'none'; bfEl.textContent = ''; }
  showStatus(stopped > 0 ? `Stopped ${stopped} workers.` : 'No worker was running.', 'ok');
}

function addBfResult(layout, score, workerId) {
  // Reject duplicates by score (within 1 point) — SA can re-find same plateau
  if (bfResults.some(r => Math.abs(r.score - score) < 1)) return;

  // Defensive: reject any leaf whose component set differs from current state.
  // Catches bugs like greedy.js silently dropping components that can't be
  // placed — those leafs would overwrite the user's full layout with a
  // partial one when applied via auto-follow.
  const currentKey = _componentSetKey(state.placements);
  const layoutKey = _componentSetKey(layout);
  if (currentKey !== layoutKey) {
    const cur = currentKey.split(',').length, lf = layoutKey.split(',').length;
    console.warn(`[Anneal] Worker ${workerId} rejected — different component set (state has ${cur}, leaf has ${lf}). Probably greedy.js dropped components.`);
    return;
  }

  const entry = { layout, score, foundAt: Date.now(), workerId };
  const oldTopScore = bfResults.length > 0 ? bfResults[0].score : -Infinity;

  bfResults.unshift(entry);
  bfResults.sort((a, b) => (b.score - a.score) || (b.foundAt - a.foundAt));

  // Trim to MAX but always preserve the oldest entry (anchor)
  if (bfResults.length > BF_RESULTS_MAX) {
    let oldestIdx = 0;
    for (let i = 1; i < bfResults.length; i++) {
      if (bfResults[i].foundAt < bfResults[oldestIdx].foundAt) oldestIdx = i;
    }
    const oldest = bfResults[oldestIdx];
    const top = bfResults.slice(0, BF_RESULTS_MAX - 1);
    if (top.includes(oldest)) {
      bfResults = bfResults.slice(0, BF_RESULTS_MAX);
    } else {
      bfResults = [...top, oldest];
    }
  }
  bfResultsSave();
  renderBfResults();

  // Auto-follow: only fire if BOTH conditions hold:
  //   (a) new entry is at #1 AND beats previous bfResults top
  //   (b) new score beats the user's currently displayed layout
  // (b) is critical — protects against downgrading the user's valid state
  // with an inferior SA result (e.g. when bfResults was empty so oldTopScore
  // = -Infinity and any new entry trivially "wins").
  if (bfAutoFollowTop && bfResults[0] === entry && score > oldTopScore) {
    const currentScore = scoreLayout(state.placements, state.grid);
    if (score > currentScore) {
      state.placements = layout.map(rehydratePlacement);
      state.nextId = state.placements.length + 1;
      saveState();
      renderAll();
    }
  }
}

function renderBfResults() {
  const container = document.getElementById('bf-results');
  if (!container) return;
  if (bfResults.length === 0) {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'flex';
  // Header with TOP follow-mode toggle
  const topBtnClass = bfAutoFollowTop ? 'top-btn active' : 'top-btn';
  const topBtnText = bfAutoFollowTop ? '★ TOP (auto-follow ON)' : '★ TOP (click to enable auto-follow)';
  let html = `<button class="${topBtnClass}" onclick="enableTopFollow()" title="Auto-switch to the best result">${topBtnText}</button>`;
  html += bfResults.map((r, i) => {
    const ageSec = Math.floor((Date.now() - r.foundAt) / 1000);
    const ageStr = ageSec < 60 ? `${ageSec}s` : `${Math.floor(ageSec/60)}m`;
    return `<div class="result-slot" onclick="applyBfResult(${i})" title="W${r.workerId} · ${ageStr} ago · score ${r.score}">
      <span class="result-rank">#${i+1}</span>
      <span class="result-score">${r.score.toLocaleString()}</span>
      <span class="result-age">${ageStr}</span>
    </div>`;
  }).join('');
  container.innerHTML = html;
}

function applyBfResult(idx) {
  const r = bfResults[idx];
  if (!r || !r.layout) return;
  // User chose a specific slot — disable auto-follow so we don't override their pick
  bfAutoFollowTop = false;
  state.placements = r.layout.map(rehydratePlacement);
  state.nextId = state.placements.length + 1;
  saveState();
  renderAll();
  renderBfResults();
  showStatus(`Layout #${idx+1} applied (score ${r.score.toLocaleString()}). Auto-follow off — click TOP to re-enable.`, 'ok');
}

// Re-enable auto-follow mode and snap to current #1 result
function enableTopFollow() {
  if (bfResults.length === 0) return;
  bfAutoFollowTop = true;
  const top = bfResults[0];
  state.placements = top.layout.map(rehydratePlacement);
  state.nextId = state.placements.length + 1;
  saveState();
  renderAll();
  renderBfResults();
  showStatus(`Auto-follow on. Current #1: score ${top.score.toLocaleString()}.`, 'ok');
}

function scheduleAnnealOpt() {
  const myId = ++bgOptId;
  pendingBetterLayout = null;
  hideBetterLayoutOffer();

  // Terminate any prior workers (BF or SA)
  for (const w of currentBfWorkers) { try { w.terminate(); } catch (e) {} }
  currentBfWorkers = [];
  for (const w of currentSaWorkers) { try { w.terminate(); } catch (e) {} }
  currentSaWorkers = [];

  const BIO_PERIPHERAL_IDS = new Set(['biocell', 'disposable_biocell']);
  const currentNonWire = state.placements
    .filter(p => p.componentId !== 'wire' && !BIO_PERIPHERAL_IDS.has(p.componentId));
  const nonWireIds = currentNonWire.map(p => p.componentId);
  if (nonWireIds.length <= 1) return;

  // Pass user's current non-wire placements as seed candidate. Workers will
  // test validity and use it as starting point if valid (so SA improves the
  // user's existing solution rather than rebuilding from scratch).
  const seedPlacements = currentNonWire.map(p => ({
    componentId: p.componentId,
    row: p.row, col: p.col, rotation: p.rotation,
    rotatedShape: p.rotatedShape,
    rotatedPorts: p.rotatedPorts,
    rotatedBioPorts: p.rotatedBioPorts || [],
    rotatedPeripheral: p.rotatedPeripheral
  }));

  const N = getThreadCount();
  const startTime = Date.now();
  let bestScore = scoreLayout(state.placements, state.grid);
  let bestSourceWorker = -1;
  console.log(`[Anneal] Seed score = ${bestScore} (goal: improve)`);

  const bfEl = document.getElementById('bf-progress');
  if (bfEl) { bfEl.style.display = 'inline'; bfEl.textContent = '⚡³ …'; }

  // Worker state
  const workerStats = Array.from({ length: N }, () => ({
    iter: 0, T: 0, currentCost: Infinity, bestCost: Infinity, elapsedMs: 0
  }));
  let lastProgressUpdate = 0;
  let finishedWorkers = 0;

  function renderProgress() {
    if (!bfEl) return;
    const elapsedSec = (Date.now() - startTime) / 1000;
    const totalIter = workerStats.reduce((s, w) => s + (w.iter || 0), 0);
    const avgBest = workerStats.reduce((m, w) => Math.min(m, w.bestCost || Infinity), Infinity);
    const fmt = (v) => v === Infinity ? '?' : Math.round(v);
    const elStr = elapsedSec < 60 ? `${elapsedSec.toFixed(0)}s` : `${(elapsedSec/60).toFixed(1)}m`;
    bfEl.textContent = `⚡³ ${N}× SA · iter ${fmtBfNum(totalIter)} · best cost ${fmt(avgBest)} · ${elStr} elapsed`;
  }

  console.log(`[Anneal] Start: ${nonWireIds.length} components, grid ${state.grid.rows}×${state.grid.cols}, ${N} workers`);

  for (let i = 0; i < N; i++) {
    const w = new Worker('sa-worker.js?v=91');
    currentSaWorkers.push(w);

    w.onmessage = (e) => {
      if (bgOptId !== myId) { try { w.terminate(); } catch (err) {} return; }
      const msg = e.data;
      switch (msg.type) {
        case 'ready': {
          // Each worker gets a slightly different temperature schedule for diversity
          // (max ~3-5 min runtime per worker on a 35-component layout)
          const opts = {
            tStart: 30000 + i * 5000,
            tEnd: 0.1,
            coolingRate: 0.9997 - i * 0.00005,
            maxIter: 30000,
            restartAfter: 3000 + i * 500,
            progressEvery: 200
          };
          w.postMessage({
            type: 'start', workerId: i, nonWireIds,
            grid: { rows: state.grid.rows, cols: state.grid.cols },
            initialPlacements: seedPlacements,
            options: opts
          });
          break;
        }
        case 'progress': {
          workerStats[i].iter = msg.iter;
          workerStats[i].T = msg.T;
          workerStats[i].currentCost = msg.currentCost;
          workerStats[i].bestCost = msg.bestCost;
          workerStats[i].elapsedMs = msg.elapsedMs;
          const now = Date.now();
          if (now - lastProgressUpdate >= 1000) {
            lastProgressUpdate = now;
            renderProgress();
          }
          break;
        }
        case 'leaf': {
          // Worker reports a VALID layout improvement
          const layout = msg.layout || [];
          const score = msg.score;
          if (score > bestScore) {
            bestScore = score;
            bestSourceWorker = i;
            const elapsedS = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`[Anneal] New top layout (worker ${i}) score=${score}, ${elapsedS}s`);
          }
          addBfResult(layout, score, i);
          break;
        }
        case 'stopped': {
          finishedWorkers++;
          try { w.terminate(); } catch (err) {}
          console.log(`[Anneal] Worker ${i} stopped (${finishedWorkers}/${N}).`);
          if (finishedWorkers >= N) {
            const elapsedS = ((Date.now() - startTime) / 1000).toFixed(1);
            const completeMsg = bfResults.length > 0
              ? `SA finished (${N}× workers, ${elapsedS}s). ${bfResults.length} valid results found, best score ${bestScore.toLocaleString()}.`
              : `SA finished (${N}× workers, ${elapsedS}s). No valid layout found — try expanding grid or adjusting components.`;
            console.log(`[Anneal] ${completeMsg}`);
            if (bfEl) { bfEl.style.display = 'none'; bfEl.textContent = ''; }
            showStatus(completeMsg, bfResults.length > 0 ? 'ok' : 'warn');
            currentSaWorkers = [];
          }
          break;
        }
        case 'error': {
          console.error(`[Anneal Worker ${i}]`, msg.message);
          showStatus(`SA worker ${i}: ${msg.message}`, 'error');
          break;
        }
      }
    };

    w.onerror = (err) => {
      console.error(`[Anneal Worker ${i}] onerror:`, err.message, err.filename, err.lineno);
      showStatus(`SA worker ${i} selhal: ${err.message}`, 'error');
    };

    w.postMessage({ type: 'init', componentLib });
  }
}

function fmtBfNum(n) {
  return n >= 1e9 ? (n / 1e9).toFixed(1) + 'G'
       : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M'
       : n >= 1000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k'
       : String(n);
}

function showBetterLayoutOffer(newScore, oldScore, newWires, oldWires) {
  const pct     = Math.round((newScore - oldScore) / Math.max(1, Math.abs(oldScore)) * 100);
  const wireDiff = oldWires - newWires;
  const wireMsg  = wireDiff > 0 ? `, −${wireDiff} wire${wireDiff > 1 ? 's' : ''}` : '';
  const el  = document.getElementById('opt-offer');
  const msg = document.getElementById('opt-offer-msg');
  if (!el || !msg) return;
  msg.textContent = `Found a better layout (+${pct}% quality${wireMsg})`;
  el.classList.remove('hidden');
}

function hideBetterLayoutOffer() {
  document.getElementById('opt-offer')?.classList.add('hidden');
}

function applyBetterLayout() {
  if (!pendingBetterLayout) return;
  state.placements     = pendingBetterLayout;
  state.nextId         = pendingBetterLayout.length + 1;
  pendingBetterLayout  = null;
  hideBetterLayoutOffer();
  saveState();
  renderAll();
  showStatus('Better layout applied.', 'ok');
}

function dismissOptOffer() {
  pendingBetterLayout = null;
  hideBetterLayoutOffer();
}

// ─── Persistence ─────────────────────────────────────────────────────────────

function saveState() {
  const data = {
    grid: state.grid,
    nextId: state.nextId,
    placements: state.placements.map(p => ({
      id: p.id, componentId: p.componentId,
      row: p.row, col: p.col, rotation: p.rotation,
      autoPlaced: p.autoPlaced || false
    }))
  };
  const json = JSON.stringify(data);
  localStorage.setItem(STATE_KEY, json);
  // Console dump after every layout change — handy for sharing layouts
  // or debugging. Compact one-liner so it's easy to copy.
  console.log('[Layout dump]', json);
}

// ─── UI helpers ──────────────────────────────────────────────────────────────

function showStatus(msg, type) {
  const el = document.getElementById('status-msg');
  if (!el) return;
  el.textContent = msg;
  el.className   = 'status-' + (type || 'ok');
  clearTimeout(el._timeout);
  el._timeout = setTimeout(() => {
    el.textContent = 'Ready';
    el.className   = 'status-ok';
  }, 5000);
}

function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', init);
