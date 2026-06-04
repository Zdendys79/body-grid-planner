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
    console.log(`[Cache] Stránka: ${fromCache ? 'Z CACHE' : 'čerstvě ze sítě'} (type=${nav?.type || '?'})`);
    resources.forEach(r => {
      const name = r.name.split('/').pop();
      console.log(`[Cache]   ${r.transferSize === 0 ? 'CACHE' : 'SÍŤ  '} ${name}`);
    });
  } catch (e) { /* Performance API nedostupné */ }

  const listEl = document.getElementById('component-list');

  try {
    const resp = await fetch('components.json');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    componentLib = data.components || [];
    console.log('[init] Loaded', componentLib.length, 'components:', componentLib.map(c => c.id).join(', '));
  } catch (e) {
    console.error('[init] Failed to load components.json:', e);
    if (listEl) listEl.innerHTML = `<div class="empty-hint" style="color:#f05050">Chyba načítání: ${e.message}</div>`;
    showStatus('Chyba: components.json', 'error');
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
      console.log(`[Load] ${state.placements.length} součástek z paměti: ${parts || '—'} | grid ${state.grid.rows}×${state.grid.cols}`);
    } catch (e) {
      console.warn('[init] State parse error, using fresh state');
    }
  }

  renderAll();
  showStatus('Ready', 'ok');

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
        console.log('[init] Nalezeno uložené prohledávání pro aktuální layout — pokračuji…');
        showStatus('Pokračuji v dříve uloženém brute force…', 'ok');
        setTimeout(scheduleBruteForceOpt, 200);
      } else {
        console.log('[init] Uložené prohledávání neodpovídá layoutu — zahodím.');
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
    container.innerHTML = '<div class="empty-hint" style="color:#f05050">Žádné komponenty (zkontroluj konzoli)</div>';
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
    container.innerHTML = '<div class="empty-hint">Přidej součástky z nabídky výše.</div>';
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
    showStatus(`${def.icon} ${def.name}: Bio Generator již obsahuje Biocell automaticky.`, 'warn');
    return;
  }

  let result = findBestPlacement(def, state);
  if (!result) {
    // No room with current layout – try async rearrangement (yields between components)
    const allIds = ensureComponentOrder([
      ...state.placements.filter(p => p.componentId !== 'wire').map(p => p.componentId),
      componentId
    ]);
    showStatus(`Přeskládávám ${allIds.length} součástek…`, 'ok');
    const rearranged = await runOptimizationAsync(allIds, state.grid);
    const expectedCount = allIds.filter(id => id === componentId).length;
    const actualCount   = rearranged.filter(p => p.componentId === componentId).length;
    if (actualCount < expectedCount) {
      // Last resort: place anywhere that fits geometrically, ignoring power connections
      const anyResult = findAnyPlacement(def, state);
      if (!anyResult) {
        showStatus(`${def.icon} ${def.name}: nenalezeno místo ani po přeskládání. Rozbal body.`, 'error');
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
      showStatus(`${def.icon} ${def.name} přidán (nezapojen – použij Re-Optimize nebo Brute).`, 'warn');
      return;
    }
    state.placements = rearranged;
    state.nextId = rearranged.length + 1;
    selectedPlacementIdx = null;
    saveState();
    renderAll();
    showStatus(`${def.icon} ${def.name} přidán – komponenty přeskládány.`, 'ok');
    scheduleBackgroundOpt();
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
  debugLayoutStatus(state.placements, state.grid, `po přidání ${def.name}`);

  bfClearSave(); // component set changed → discard resume snapshot
  saveState();
  renderAll();
  showStatus(`${def.icon} ${def.name} → [${result.row},${result.col}] r${result.rotation}°${wireMsg}`, 'ok');

  scheduleBackgroundOpt();
}

function removePlacement(event, idx) {
  event.stopPropagation();
  state.placements.splice(idx, 1);
  if (selectedPlacementIdx === idx) selectedPlacementIdx = null;
  else if (selectedPlacementIdx > idx) selectedPlacementIdx--;
  bfClearSave(); // component set changed → discard resume snapshot
  saveState();
  renderAll();
  showStatus('Součástka odebrána.', 'ok');
  scheduleBackgroundOpt();
}

function selectPlacement(idx) {
  selectedPlacementIdx = selectedPlacementIdx === idx ? null : idx;
  renderPlacedList();
}

function onComponentClick(idx) { selectPlacement(idx); }

function expandBody() {
  const { grid } = state;
  if (grid.rows >= grid.maxRows && grid.cols >= grid.maxCols) return;
  if (grid.rows < grid.maxRows) grid.rows = Math.min(grid.rows + 2, grid.maxRows);
  if (grid.cols < grid.maxCols) grid.cols = Math.min(grid.cols + 2, grid.maxCols);
  bfClearSave(); // grid dims changed → discard resume snapshot
  saveState();
  renderAll();
  showStatus(`Body rozšířeno na ${grid.rows}×${grid.cols}.`, 'ok');
  scheduleBackgroundOpt();
}

function resetLayout() {
  if (!confirm('Odebrat všechny součástky a resetovat rozložení na výchozí rozměry?')) return;
  state.placements = [];
  state.nextId = 1;
  state.grid.rows = 3;
  state.grid.cols = 4;
  selectedPlacementIdx = null;
  hideBetterLayoutOffer();
  bgOptId++;
  bfClearSave(); // layout cleared → discard resume snapshot
  saveState();
  renderAll();
  showStatus('Rozložení resetováno na výchozí rozměry (3×4).', 'ok');
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

  console.log('[Optimize] Pořadí:', ids.join(' → '));
  showStatus(`Optimalizuji ${ids.length} součástek…`, 'ok');

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
      console.warn(`[Optimize] ✗ ${def.name}: žádná platná pozice`);
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
    showStatus(`Optimalizaci nelze provést: ${uniqueNames.join(', ')} se nevejde. Zvětšete body.`, 'error');
    return;
  }

  debugLayoutStatus(state.placements, state.grid, 'výsledek optimalizace');

  if (!isLayoutValid(state.placements, state.grid)) {
    state.placements = savedPlacements;
    state.nextId = savedNextId;
    selectedPlacementIdx = null;
    saveState();
    renderAll();
    showStatus('Optimizer nenašel validní rozmístění. Zkus větší body nebo jiné pořadí.', 'error');
    scheduleBackgroundOpt();
    return;
  }

  saveState();
  renderAll();
  showStatus(`Optimalizováno (${state.placements.length} položek).`, 'ok');
  scheduleBackgroundOpt();
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

function scoreLayout(placements, grid) {
  const wires      = placements.filter(p => p.componentId === 'wire').length;
  const quality    = computeFreeSpaceQuality(null, 0, 0, placements, grid.rows, grid.cols);
  const workingSet = computeWorkingSet(placements);
  // Working spinners dominate; then wire count; then free-space quality
  return quality * 4 - wires * 5000 + workingSet.size * 50000;
}

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

// Returns true if layout is fully valid:
// - every energy component is powered (connected to bus/powered chain)
// - every Spinner has required Repeaters adjacent — BUT ONLY IF Repeaters exist in the layout
// - Pulser: Repeaters are optional (connects if a Repeater has a free port, not mandatory)
// - Every Repeater must connect (port-match) to at least one Spinner OR Pulser — Repeater
//   without a useful target is wasted (forbidden by the optimizer rules).
function isLayoutValid(placements, grid) {
  const poweredSet  = computePoweredSet(placements, grid.rows, grid.cols);
  const workingSet  = computeWorkingSet(placements);
  const hasRepeaters = placements.some(p =>
    p.componentId === 'repeater_4s' || p.componentId === 'repeater_2s'
  );

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

  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    if (p.componentId === 'wire') continue;
    const def = componentLib.find(d => d.id === p.componentId);
    if (!def) continue;
    if (def.energyPorts.length > 0 && !poweredSet.has(i)) return false;
    // Spinner: pokud jsou v layoutu Repeatery, každý Spinner musí mít povinné Repeatery
    if (p.componentId === 'spinner' && hasRepeaters && !workingSet.has(i)) return false;
    // Pulser: Repeatery nejsou povinné — nepožadujeme workingSet
    // Repeater: musí mít port-match na Spinner NEBO Pulser (jinak je zbytečný)
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
  }
  return true;
}

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
  console.groupCollapsed(`[Layout${tag}] ${nonWires.length} souč. | napájeno ${powOk}/${nonWires.length} | spinners ${spinners.filter(({i})=>working.has(i)).length}/${spinners.length} funkční ${ok ? '✓' : '⚠'}`);
  if (unpow.length > 0) console.warn('  Bez napájení:', unpow.join(', '));
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
    const status = wok ? '✓ FUNKČNÍ' : (hasReps ? '✗ BEZ REPEATERU' : '(bez repů v layoutu)');
    console.log(`  Spinner [${p.row},${p.col}] r${p.rotation}°: ${status} | sousedé: ${adjReps.join(', ') || '–'}`);
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

// ─── Brute Force Generator ────────────────────────────────────────────────────
// Backtracking search over ALL grid positions for each component.
// Static "largest first" ordering. (MCV is deferred — naive scan was too expensive;
// incremental aliveCount implementation pending.)
// Pruning optimisations applied at each node:
//   1. Unique rotations         — skip geometrically equivalent rotations (Opt #1 — pre-cached)
//   2. Identical ordering       — for N copies of same component, enforce row-major
//                                 position ordering to eliminate N! permutations
//   3. Spinner-Rep feasibility  — prune if unmet Spinners > max coverable
//                                 (Opt #2: incremental coverage counter → O(1) check)
//   4. Cell-budget              — prune if free cells < remaining shape size
//   5. Bus reachability (Opt #3)— after each energy-component push, BFS through free cells
//                                 + direct bus + port-match check; prune if unreachable
// Performance optimisations:
//   A. Flat Int32Array occupied grid (no Map allocation, no string keys)
//   B. Incremental push/pop (occupied + cellsUsed + spinner-rep tracking + energy port set)
//   C. Pre-cached rotation data per (id, deg): shape, flat cellOffsets, bounds, positions,
//      ports, peri offsets — eliminates per-node rotation work
//   D. Integer port keys for all port lookups (no string hashing)
//   E. BFS uses generation counter (no per-call clear), pre-allocated typed-array buffers
//   F. Incremental Spinner-Rep coverage counter — unmet count is O(1) read
//
// isLayoutValid + tryAddWires at the leaf still verify final correctness.
// onBranchComplete: called after each depth-0 branch (used for % progress display).
// (_SIDE_IDX is defined in src/constants.js)

function* bruteForcePlacements(nonWireIds, grid, onBranchComplete, resumePath, stateRef, timings) {
  const R = grid.rows, C = grid.cols;
  const GRID_CELLS = R * C;

  // Per-id metadata cache
  const defById = new Map();
  for (const id of new Set(nonWireIds)) {
    const def = componentLib.find(d => d.id === id);
    if (def) defById.set(id, def);
  }

  // Pre-compute all rotation data per unique component id, including the full
  // flat positions list per rotation (Opt #1).
  const rotData = new Map();
  for (const [id, def] of defById) {
    const rots = [];
    for (const deg of getUniqueDegs(def)) {
      const { shape, energyPorts, bioPorts } = rotateComponent(def, deg);
      const bounds = getBounds(shape);
      if (bounds.height > R || bounds.width > C) continue;
      const cellOffsets = new Int32Array(shape.length);
      for (let i = 0; i < shape.length; i++) cellOffsets[i] = shape[i][0] * C + shape[i][1];
      const rotPeri = buildRotatedPeri(def, deg);
      let periRelCells = null;
      if (rotPeri) {
        const d = SIDE_DELTA[rotPeri.port.side];
        const baseR = rotPeri.port.cell[0] + d.dr;
        const baseC = rotPeri.port.cell[1] + d.dc;
        periRelCells = [];
        for (const [pr, pc] of rotPeri.shape) periRelCells.push([baseR + pr, baseC + pc]);
        periRelCells.push([baseR + d.dr, baseC + d.dc]);
      }
      // Opt #1: pre-flatten positions list as [row0, col0, row1, col1, ...]
      const maxRow = R - bounds.height;
      const maxCol = C - bounds.width;
      const positions = new Int32Array((maxRow + 1) * (maxCol + 1) * 2);
      let pi = 0;
      for (let row = 0; row <= maxRow; row++) {
        for (let col = 0; col <= maxCol; col++) {
          positions[pi++] = row; positions[pi++] = col;
        }
      }
      rots.push({ deg, shape, cellOffsets, bounds, energyPorts, bioPorts, rotPeri, periRelCells, positions });
    }
    rotData.set(id, rots);
  }

  // ── Mutable state ──
  const occupied = new Int32Array(GRID_CELLS);
  const periStack = [];
  const placements = [];
  let cellsUsed = 0;

  // Opt #2: incremental Spinner-Rep coverage tracking
  const repPortSet = new Set();          // active rep port int-keys
  const allEnergyPortSet = new Set();    // active energy port int-keys (for bus port-match check)
  const energyPortStack = [];            // stack of [keys] arrays per push (for pop-undo)
  const spinnerInfo = [];                // per placed spinner: { coverKeys: number[], coverCount: number }
  let unmetCount = 0;
  // Repeater target tracking — union of Spinner + Pulser cover keys (refcounted).
  // A Repeater placement is valid only if at least one of its port keys is in this map.
  const targetCoverKeyCount = new Map();
  const pulserCoverStack = [];           // stack of Pulser coverKeys (for pop-undo)

  // Opt #3: BFS buffers (generation counter avoids per-call clear)
  const bfsGeneration = new Uint32Array(GRID_CELLS);
  const bfsQueue = new Int32Array(GRID_CELLS);
  let bfsGen = 0;

  // Largest components first → static ordering (MCV deferred for now — see TODO)
  const ordered = [...nonWireIds].sort((a, b) => {
    const da = defById.get(a);
    const db = defById.get(b);
    return (db?.shape.length || 0) - (da?.shape.length || 0);
  });

  // Cumulative remaining cells/reps from each position onward — for cell-budget + spinner pruning
  const remShape = new Array(ordered.length + 1).fill(0);
  const rem2s    = new Array(ordered.length + 1).fill(0);
  const rem4s    = new Array(ordered.length + 1).fill(0);
  for (let i = ordered.length - 1; i >= 0; i--) {
    const def = defById.get(ordered[i]);
    remShape[i] = remShape[i + 1] + (def ? def.shape.length : 0);
    rem2s[i]    = rem2s[i + 1]    + (ordered[i] === 'repeater_2s' ? 1 : 0);
    rem4s[i]    = rem4s[i + 1]    + (ordered[i] === 'repeater_4s' ? 1 : 0);
  }

  // ── Helpers ──
  function portKey(gr, gc, sideIdx) { return (gr * C + gc) * 4 + sideIdx; }

  function hasOverlapFlat(cellOffsets, baseIdx) {
    for (let i = 0; i < cellOffsets.length; i++) {
      if (occupied[baseIdx + cellOffsets[i]] !== 0) return true;
    }
    return false;
  }

  // Opt #3: bus reachability — at least one port has path to bus
  function canReachBus(p) {
    const ports = p.rotatedPorts;
    for (let i = 0; i < ports.length; i++) {
      const gr = p.row + ports[i].cell[0];
      const gc = p.col + ports[i].cell[1];
      const side = ports[i].side;
      // Direct bus
      if (side === 'W' && gc === 0) return true;
      if (side === 'S' && gr === R - 1) return true;
      // Adjacent cell
      const d = SIDE_DELTA[side];
      const ar = gr + d.dr, ac = gc + d.dc;
      if (ar < 0 || ar >= R || ac < 0 || ac >= C) continue;
      const adjIdx = ar * C + ac;
      // Direct port match with another component
      if (allEnergyPortSet.has(portKey(ar, ac, _SIDE_IDX[OPPOSITE[side]]))) return true;
      // BFS through free cells
      if (occupied[adjIdx] !== 0) continue;
      bfsGen++;
      bfsGeneration[adjIdx] = bfsGen;
      let qHead = 0, qTail = 0;
      bfsQueue[qTail++] = adjIdx;
      while (qHead < qTail) {
        const cur = bfsQueue[qHead++];
        const cr = (cur / C) | 0;
        const cc = cur - cr * C;
        if (cc === 0 || cr === R - 1) return true; // bus edge reached
        if (cr > 0) {
          const ni = cur - C;
          if (bfsGeneration[ni] !== bfsGen && occupied[ni] === 0) {
            bfsGeneration[ni] = bfsGen; bfsQueue[qTail++] = ni;
          }
        }
        if (cr < R - 1) {
          const ni = cur + C;
          if (bfsGeneration[ni] !== bfsGen && occupied[ni] === 0) {
            bfsGeneration[ni] = bfsGen; bfsQueue[qTail++] = ni;
          }
        }
        if (cc > 0) {
          const ni = cur - 1;
          if (bfsGeneration[ni] !== bfsGen && occupied[ni] === 0) {
            bfsGeneration[ni] = bfsGen; bfsQueue[qTail++] = ni;
          }
        }
        if (cc < C - 1) {
          const ni = cur + 1;
          if (bfsGeneration[ni] !== bfsGen && occupied[ni] === 0) {
            bfsGeneration[ni] = bfsGen; bfsQueue[qTail++] = ni;
          }
        }
      }
    }
    return false;
  }

  // Compute "cover keys" of a component p (Spinner or Pulser): for each of its
  // ports, the int key of the adjacent cell-side combo that a Repeater port
  // would need to occupy to connect to it.
  function computeCoverKeys(p) {
    const ports = p.rotatedPorts;
    const keys = [];
    for (let i = 0; i < ports.length; i++) {
      const gr = p.row + ports[i].cell[0];
      const gc = p.col + ports[i].cell[1];
      const d = SIDE_DELTA[ports[i].side];
      const ar = gr + d.dr, ac = gc + d.dc;
      if (ar < 0 || ar >= R || ac < 0 || ac >= C) continue;
      keys.push(portKey(ar, ac, _SIDE_IDX[OPPOSITE[ports[i].side]]));
    }
    return keys;
  }
  function addTargetKeys(coverKeys) {
    for (let i = 0; i < coverKeys.length; i++) {
      const k = coverKeys[i];
      targetCoverKeyCount.set(k, (targetCoverKeyCount.get(k) || 0) + 1);
    }
  }
  function removeTargetKeys(coverKeys) {
    for (let i = 0; i < coverKeys.length; i++) {
      const k = coverKeys[i];
      const c = (targetCoverKeyCount.get(k) || 0) - 1;
      if (c <= 0) targetCoverKeyCount.delete(k);
      else targetCoverKeyCount.set(k, c);
    }
  }

  // Opt #2: spinner-rep tracking helpers
  function pushSpinnerTracking(p) {
    const coverKeys = computeCoverKeys(p);
    let coverCount = 0;
    for (let i = 0; i < coverKeys.length; i++) if (repPortSet.has(coverKeys[i])) coverCount++;
    spinnerInfo.push({ coverKeys, coverCount });
    if (coverCount === 0) unmetCount++;
    addTargetKeys(coverKeys);
  }
  function popSpinnerTracking() {
    const s = spinnerInfo.pop();
    if (s.coverCount === 0) unmetCount--;
    removeTargetKeys(s.coverKeys);
  }
  function pushPulserTracking(p) {
    const coverKeys = computeCoverKeys(p);
    pulserCoverStack.push(coverKeys);
    addTargetKeys(coverKeys);
  }
  function popPulserTracking() {
    const coverKeys = pulserCoverStack.pop();
    if (coverKeys) removeTargetKeys(coverKeys);
  }
  function pushRepTracking(p) {
    const ports = p.rotatedPorts;
    const newKeys = [];
    for (let i = 0; i < ports.length; i++) {
      const k = portKey(p.row + ports[i].cell[0], p.col + ports[i].cell[1], _SIDE_IDX[ports[i].side]);
      newKeys.push(k); repPortSet.add(k);
    }
    for (let i = 0; i < spinnerInfo.length; i++) {
      const s = spinnerInfo[i];
      const wasZero = s.coverCount === 0;
      const ck = s.coverKeys;
      for (let j = 0; j < newKeys.length; j++) {
        const nk = newKeys[j];
        for (let kk = 0; kk < ck.length; kk++) if (ck[kk] === nk) { s.coverCount++; break; }
      }
      if (wasZero && s.coverCount > 0) unmetCount--;
    }
  }
  function popRepTracking(p) {
    const ports = p.rotatedPorts;
    const removed = [];
    for (let i = 0; i < ports.length; i++) {
      const k = portKey(p.row + ports[i].cell[0], p.col + ports[i].cell[1], _SIDE_IDX[ports[i].side]);
      removed.push(k); repPortSet.delete(k);
    }
    for (let i = 0; i < spinnerInfo.length; i++) {
      const s = spinnerInfo[i];
      const wasNonZero = s.coverCount > 0;
      const ck = s.coverKeys;
      for (let j = 0; j < removed.length; j++) {
        const rk = removed[j];
        for (let kk = 0; kk < ck.length; kk++) if (ck[kk] === rk) { s.coverCount--; break; }
      }
      if (wasNonZero && s.coverCount === 0) unmetCount++;
    }
  }

  function pushPlacement(p, periRelCells) {
    const idx = placements.length;
    placements.push(p);
    const baseIdx = p.row * C + p.col;
    p._baseIdx = baseIdx;
    const offs = p._cellOffsets;
    for (let i = 0; i < offs.length; i++) occupied[baseIdx + offs[i]] = idx + 1;
    cellsUsed += offs.length;
    if (periRelCells && periRelCells.length) {
      const changed = [];
      for (let i = 0; i < periRelCells.length; i++) {
        const r = p.row + periRelCells[i][0];
        const c = p.col + periRelCells[i][1];
        if (r < 0 || r >= R || c < 0 || c >= C) continue;
        const gi = r * C + c;
        if (occupied[gi] === 0) { occupied[gi] = -1; changed.push(gi); }
      }
      cellsUsed += changed.length;
      periStack.push(changed);
    } else {
      periStack.push(null);
    }

    // Energy port tracking (for bus port-match check)
    const def = defById.get(p.componentId);
    const hasEnergy = def && def.energyPorts.length > 0;
    if (hasEnergy) {
      const ports = p.rotatedPorts;
      const added = new Array(ports.length);
      for (let i = 0; i < ports.length; i++) {
        const k = portKey(p.row + ports[i].cell[0], p.col + ports[i].cell[1], _SIDE_IDX[ports[i].side]);
        added[i] = k; allEnergyPortSet.add(k);
      }
      energyPortStack.push(added);
    } else {
      energyPortStack.push(null);
    }

    // Spinner-Rep tracking + Pulser target-tracking
    const cid = p.componentId;
    if (cid === 'spinner') pushSpinnerTracking(p);
    else if (cid === 'pulser') pushPulserTracking(p);
    else if (cid === 'repeater_2s' || cid === 'repeater_4s') pushRepTracking(p);
  }

  function popPlacement() {
    const idx = placements.length - 1;
    const p = placements[idx];
    const cid = p.componentId;

    // Reverse incremental tracking
    if (cid === 'spinner') popSpinnerTracking();
    else if (cid === 'pulser') popPulserTracking();
    else if (cid === 'repeater_2s' || cid === 'repeater_4s') popRepTracking(p);

    const removed = energyPortStack.pop();
    if (removed) for (let i = 0; i < removed.length; i++) allEnergyPortSet.delete(removed[i]);

    const baseIdx = p._baseIdx;
    const offs = p._cellOffsets;
    for (let i = 0; i < offs.length; i++) occupied[baseIdx + offs[i]] = 0;
    cellsUsed -= offs.length;
    const changed = periStack.pop();
    if (changed) {
      for (let i = 0; i < changed.length; i++) occupied[changed[i]] = 0;
      cellsUsed -= changed.length;
    }
    placements.pop();
  }

  // Expose live path snapshot for periodic saving (stateRef.getPath returns
  // [{ cid, ri, pi }, ...] of currently placed components, each carrying enough
  // information to be replayed deterministically on resume).
  if (stateRef) {
    stateRef.getPath = () => placements.map(p => ({ cid: p.componentId, ri: p._ri, pi: p._pi }));
  }

  // Time-slicing
  let _nodes = 0;
  const NODES_PER_TICK = 4000;

  function* search(idx, resume) {
    if (++_nodes >= NODES_PER_TICK) { _nodes = 0; yield null; }
    if (idx === ordered.length) {
      const clean = new Array(placements.length);
      for (let i = 0; i < placements.length; i++) {
        const p = placements[i];
        clean[i] = {
          id: p.id, componentId: p.componentId, row: p.row, col: p.col, rotation: p.rotation,
          rotatedShape: p.rotatedShape, rotatedPorts: p.rotatedPorts,
          rotatedBioPorts: p.rotatedBioPorts, rotatedPeripheral: p.rotatedPeripheral
        };
      }
      yield clean;
      return;
    }

    // Cell-budget pruning
    if (GRID_CELLS - cellsUsed < remShape[idx]) return;

    const id = ordered[idx];
    const rots = rotData.get(id);
    if (!rots || rots.length === 0) { yield* search(idx + 1, resume); return; }

    const prevSame = (idx > 0 && ordered[idx - 1] === id) ? placements[idx - 1] : null;
    const prevDeg = prevSame ? prevSame.rotation : -1;
    const prevRow = prevSame ? prevSame.row : -1;
    const prevCol = prevSame ? prevSame.col : -1;

    const isSpinnerOrRep = id === 'spinner' || id === 'repeater_2s' || id === 'repeater_4s';
    const maxSatisfiable = rem2s[idx + 1] * 2 + rem4s[idx + 1];

    const def = defById.get(id);
    const hasEnergy = def && def.energyPorts.length > 0;

    // Resume support: skip iterations before the saved (ri, pi) at this depth.
    // Only the FIRST matching iteration carries resume forward; subsequent ones are fresh.
    const hasResume = resume && idx < resume.length && resume[idx]
      && resume[idx].cid === id;
    const startRi = hasResume ? resume[idx].ri : 0;
    const startPi = hasResume ? resume[idx].pi : 0;
    let resumeMatched = !hasResume; // if no resume here, all iterations are "post-resume"

    for (let ri = startRi; ri < rots.length; ri++) {
      const rot = rots[ri];
      const { deg, shape, cellOffsets, energyPorts, bioPorts, rotPeri, periRelCells, positions } = rot;
      if (prevSame && deg < prevDeg) continue;
      const sameDeg = (deg === prevDeg);
      const len = positions.length;
      const piFrom = (ri === startRi) ? startPi : 0;
      for (let pi = piFrom; pi < len; pi += 2) {
        const row = positions[pi];
        const col = positions[pi + 1];
        if (sameDeg && (row < prevRow || (row === prevRow && col <= prevCol))) continue;
        const baseIdx = row * C + col;
        if (hasOverlapFlat(cellOffsets, baseIdx)) continue;
        const p = {
          id: placements.length+1, componentId: id, row, col, rotation: deg,
          rotatedShape: shape, rotatedPorts: energyPorts, rotatedBioPorts: bioPorts, rotatedPeripheral: rotPeri,
          _cellOffsets: cellOffsets, _ri: ri, _pi: pi
        };
        pushPlacement(p, periRelCells);
        let ok = (!isSpinnerOrRep || unmetCount <= maxSatisfiable);
        // Repeater must match a Spinner/Pulser cover key — otherwise it's useless
        if (ok && (id === 'repeater_2s' || id === 'repeater_4s')) {
          const ports = p.rotatedPorts;
          let matched = false;
          for (let pj = 0; pj < ports.length; pj++) {
            const k = portKey(p.row + ports[pj].cell[0], p.col + ports[pj].cell[1], _SIDE_IDX[ports[pj].side]);
            if (targetCoverKeyCount.has(k)) { matched = true; break; }
          }
          if (!matched) ok = false;
        }
        if (ok && hasEnergy) {
          const _bt = timings ? performance.now() : 0;
          const reach = canReachBus(p);
          if (timings) {
            const d = performance.now() - _bt;
            const t = timings.busCheck;
            t.sum += d; t.count++; if (d > t.max) t.max = d;
          }
          if (!reach) ok = false;
        }
        if (ok) {
          // Pass resume down only on the iteration that matches the saved (ri, pi)
          const childResume = (!resumeMatched && ri === startRi && pi === startPi) ? resume : null;
          yield* search(idx + 1, childResume);
          if (!resumeMatched && ri === startRi && pi === startPi) resumeMatched = true;
        }
        popPlacement();
        if (idx === 0 && onBranchComplete) onBranchComplete();
      }
    }
  }

  yield* search(0, resumePath);
}

// For each unpowered energy component in a brute-force candidate layout, tries to find
// a wire path that connects it to the bus or to an already-powered component.
// Returns the layout augmented with wires, or null if any component cannot be powered.
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
    let foundUnpowered = false;

    for (let i = 0; i < current.length; i++) {
      const p = current[i];
      if (p.componentId === 'wire') continue;
      const def = componentLib.find(d => d.id === p.componentId);
      if (!def || def.energyPorts.length === 0) continue;
      if (poweredSet.has(i)) continue;

      foundUnpowered = true;
      const path = findWirePath(p.rotatedShape, p.rotatedPorts, p.row, p.col, { grid, placements: current });
      if (!path || path.length === 0) return null; // no wire path possible → whole layout invalid

      path.forEach(([r, c]) => {
        current.push({
          id: current.length + 1,
          componentId: 'wire',
          row: r, col: c, rotation: 0,
          rotatedShape: [[0, 0]],
          rotatedPorts: wireDef.energyPorts.map(ep => ({ cell: [...ep.cell], side: ep.side })),
          rotatedBioPorts: [],
          rotatedPeripheral: null,
          autoPlaced: true
        });
      });
      break; // recompute poweredSet with new wires before continuing
    }

    if (!foundUnpowered) return current; // all powered
  }

  return null; // gave up (shouldn't happen)
}

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

// ─── Brute-force resume persistence (localStorage) ──
// Saved snapshot ties to (idsKey, grid dims) so it is auto-invalidated when the
// layout's component list or grid size changes. The path encodes (cid, ri, pi)
// per placed component so the search can replay deterministically.
function _bfBuildIdsKey(nonWireIds) { return [...nonWireIds].sort().join(','); }
function bfClearSave() {
  try { localStorage.removeItem(BF_SAVE_KEY); } catch (e) {}
  // Also stop any running workers — their state is now invalid
  if (currentBfWorkers.length > 0) {
    for (const w of currentBfWorkers) {
      try { w.postMessage({ type: 'stop' }); } catch (e) {}
      try { w.terminate(); } catch (e) {}
    }
    currentBfWorkers = [];
  }
}
function bfLoadSave() {
  try {
    const raw = localStorage.getItem(BF_SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || data.v !== 1) return null;
    return data;
  } catch (e) { return null; }
}
function bfSaveState(idsKey, rows, cols, path, stats, bestLayout) {
  try {
    localStorage.setItem(BF_SAVE_KEY, JSON.stringify({
      v: 1, idsKey, rows, cols, path, stats, bestLayout, saved: Date.now()
    }));
  } catch (e) { console.warn('[BruteForce] Save failed:', e.message); }
}

// Multi-worker save (Phase 2). One snapshot atomically captures every worker's
// position so resume — even across page reloads — preserves per-thread progress.
function bfSaveStateV2(idsKey, rows, cols, totalBranches, threadCount, workerStates, bestLayout, elapsedMs) {
  try {
    localStorage.setItem(BF_SAVE_KEY, JSON.stringify({
      v: 2, idsKey, rows, cols, totalBranches, threadCount,
      workers: workerStates.map(w => ({
        branchRange: w.branchRange,
        currentBranchIdx: w.currentBranchIdx,
        path: w.path,
        stats: w.stats
      })),
      bestLayout,
      elapsedMs,
      saved: Date.now()
    }));
  } catch (e) { console.warn('[BruteForce] Save v=2 failed:', e.message); }
}

// Split [0, total) into n contiguous ranges as evenly as possible
function _computeBranchRanges(total, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push([Math.floor(i * total / n), Math.floor((i + 1) * total / n)]);
  }
  return out;
}

// ─── Export / Import save state (cross-device transfer) ─────────────────────
// Encodes the save snapshot as base64-of-utf8-JSON so it survives clipboard
// copy/paste. Useful for moving an in-progress brute force from a slow machine
// (e.g. server with 4 cores) to a powerful one (e.g. desktop with 24 threads).

function _bfEncodeSave(data) {
  const json = JSON.stringify(data);
  // base64(utf8(json)) — uses TextEncoder for proper UTF-8 handling
  const utf8 = new TextEncoder().encode(json);
  let bin = '';
  for (let i = 0; i < utf8.length; i++) bin += String.fromCharCode(utf8[i]);
  return btoa(bin);
}
function _bfDecodeSave(encoded) {
  const bin = atob(encoded.trim());
  const utf8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) utf8[i] = bin.charCodeAt(i);
  const json = new TextDecoder().decode(utf8);
  return JSON.parse(json);
}

function _fmtElapsed(ms) {
  const sec = Math.floor(ms / 1000);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(d + 'd');
  if (h > 0 || d > 0) parts.push(h + 'h');
  parts.push(m + 'm');
  return parts.join(' ');
}

function exportBfSave() {
  if (!state.placements || state.placements.length === 0) {
    showStatus('Layout je prázdný — není co exportovat.', 'warn');
    return;
  }

  // Build self-contained export bundle: always includes layout, optionally BF save
  const bfData = bfLoadSave();
  const bundle = {
    type: 'idle-directive-export',
    v: 1,
    layout: {
      grid: { rows: state.grid.rows, cols: state.grid.cols, maxRows: state.grid.maxRows, maxCols: state.grid.maxCols },
      nextId: state.nextId,
      placements: state.placements.map(p => ({
        id: p.id, componentId: p.componentId,
        row: p.row, col: p.col, rotation: p.rotation,
        autoPlaced: p.autoPlaced || false
      }))
    },
    bfSave: bfData,
    exportedAt: Date.now()
  };
  const encoded = _bfEncodeSave(bundle);

  const layoutInfo = `${bundle.layout.placements.length} součástek · grid ${state.grid.rows}×${state.grid.cols}`;
  let bfInfo = '';
  if (bfData) {
    const elapsedStr = _fmtElapsed(bfData.stats?.elapsedMs || 0);
    const checked = bfData.stats?.checked || 0;
    const completed = bfData.stats?.completedBranches || 0;
    bfInfo = `
      <p><strong>BF progress:</strong> path ${bfData.path?.length || 0} úrovní · dokončeno větví ${completed}</p>
      <p><strong>Prohledáno listů:</strong> ${checked.toLocaleString()} · uplynulo ${elapsedStr}</p>
    `;
  } else {
    bfInfo = `<p><em>(žádný BF save — exportuje se jen layout)</em></p>`;
  }

  document.getElementById('save-modal-title').textContent = 'Export stavu';
  document.getElementById('save-modal-info').innerHTML = `
    <p><strong>Layout:</strong> ${layoutInfo}</p>
    ${bfInfo}
    <p><strong>Velikost stringu:</strong> ${encoded.length.toLocaleString()} znaků</p>
    <p style="margin-top:6px;color:var(--text-bright)">Zkopíruj text a vlož ho na cílovém stroji v dialogu Import.</p>
  `;
  const ta = document.getElementById('save-modal-text');
  ta.value = encoded;
  ta.readOnly = true;
  document.getElementById('save-modal-action').textContent = 'Kopírovat do schránky';
  document.getElementById('save-modal').classList.remove('hidden');
  setTimeout(() => { ta.focus(); ta.select(); }, 50);
}

function openImportBfSave() {
  document.getElementById('save-modal-title').textContent = 'Import save stavu';
  document.getElementById('save-modal-info').innerHTML = `
    <p>Vlož exportovaný řetězec z jiného stroje:</p>
  `;
  const ta = document.getElementById('save-modal-text');
  ta.value = '';
  ta.readOnly = false;
  document.getElementById('save-modal-action').textContent = 'Importovat';
  document.getElementById('save-modal').classList.remove('hidden');
  setTimeout(() => ta.focus(), 50);
}

function confirmSaveModal() {
  const ta = document.getElementById('save-modal-text');
  if (ta.readOnly) {
    // Export mode — copy to clipboard
    navigator.clipboard.writeText(ta.value).then(
      () => { showStatus('Save zkopírován do schránky.', 'ok'); closeSaveModal(); },
      () => { ta.select(); showStatus('Kopírování selhalo — vyber text a Ctrl+C.', 'warn'); }
    );
  } else {
    // Import mode
    applyImportSave();
  }
}

function applyImportSave() {
  const text = document.getElementById('save-modal-text').value.trim();
  if (!text) { showStatus('Prázdný vstup.', 'warn'); return; }
  let data;
  try {
    data = _bfDecodeSave(text);
  } catch (e) {
    showStatus('Neplatný formát řetězce: ' + e.message, 'error');
    return;
  }
  if (!data) {
    showStatus('Prázdný nebo nevalidní obsah.', 'error');
    return;
  }

  // Two supported formats:
  //   A) Full bundle: { type: 'idle-directive-export', v: 1, layout, bfSave }
  //   B) Legacy BF-only: { v: 1, idsKey, rows, cols, path, stats, bestLayout }
  let layoutData = null;
  let bfData = null;
  if (data.type === 'idle-directive-export' && data.v === 1) {
    layoutData = data.layout;
    bfData = data.bfSave;
  } else if (data.v === 1 && data.idsKey) {
    // Legacy BF-only save — reconstruct layout from bestLayout
    bfData = data;
    if (data.bestLayout && Array.isArray(data.bestLayout)) {
      layoutData = {
        grid: { rows: data.rows, cols: data.cols },
        placements: data.bestLayout,
        nextId: data.bestLayout.length + 1
      };
    }
  } else {
    showStatus('Nerozpoznaný formát importu.', 'error');
    return;
  }

  // Apply layout (overwrites current)
  if (layoutData && layoutData.placements) {
    const ok = (state.placements && state.placements.length > 0)
      ? confirm(
          `Importovat layout ${layoutData.placements.length} součástek, grid ${layoutData.grid.rows}×${layoutData.grid.cols}?\n\n` +
          `Aktuální layout (${state.placements.length} součástek, grid ${state.grid.rows}×${state.grid.cols}) bude přepsán.`
        )
      : true;
    if (!ok) return;
    if (layoutData.grid) {
      state.grid.rows = layoutData.grid.rows || state.grid.rows;
      state.grid.cols = layoutData.grid.cols || state.grid.cols;
      if (layoutData.grid.maxRows) state.grid.maxRows = layoutData.grid.maxRows;
      if (layoutData.grid.maxCols) state.grid.maxCols = layoutData.grid.maxCols;
    }
    state.placements = layoutData.placements.map(rehydratePlacement);
    state.nextId = layoutData.nextId || (state.placements.length + 1);
    bfClearSave(); // any prior BF save is now stale
    saveState();
    renderAll();
  }

  // Optionally restore BF save and resume brute force
  if (bfData) {
    try {
      localStorage.setItem(BF_SAVE_KEY, JSON.stringify(bfData));
      closeSaveModal();
      showStatus('Layout a BF save importovány. Pokračuji v prohledávání…', 'ok');
      setTimeout(scheduleBruteForceOpt, 200);
    } catch (e) {
      closeSaveModal();
      showStatus('Layout importován, BF save selhal: ' + e.message, 'warn');
    }
  } else {
    closeSaveModal();
    showStatus('Layout importován (bez BF save).', 'ok');
  }
}

function closeSaveModal() {
  document.getElementById('save-modal').classList.add('hidden');
}

// ─── Settings (thread count + import/export entrypoints) ────────────────────

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? (JSON.parse(raw) || {}) : {};
  } catch (e) { return {}; }
}
function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
}
function getThreadCount() {
  const s = loadSettings();
  if (typeof s.threads === 'number' && s.threads >= 1 && s.threads <= MAX_THREADS) return s.threads;
  // Default: detected HW capped at MAX_THREADS
  return Math.min(navigator.hardwareConcurrency || 4, MAX_THREADS);
}

function openSettings() {
  const hw = navigator.hardwareConcurrency || '?';
  document.getElementById('setting-hw-cores').textContent = hw;
  const current = getThreadCount();
  const slider = document.getElementById('setting-threads');
  slider.value = current;
  document.getElementById('setting-threads-value').textContent = current;
  document.getElementById('settings-modal').classList.remove('hidden');
}
function closeSettings() {
  document.getElementById('settings-modal').classList.add('hidden');
}
function onThreadsChange() {
  let val = parseInt(document.getElementById('setting-threads').value, 10);
  if (!Number.isFinite(val)) val = 1;
  if (val < 1) val = 1;
  if (val > MAX_THREADS) val = MAX_THREADS;
  document.getElementById('setting-threads-value').textContent = val;
  const s = loadSettings();
  s.threads = val;
  saveSettings(s);
}

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
    console.info(`[BruteForce] Velký layout (${nonWireIds.length} součástek) — hledání první validní kombinace může trvat dlouho. UI zůstává responzivní.`);
    showStatus(`Brute force: ${nonWireIds.length} součástek — hledám první validní kombinaci…`, 'ok');
  }

  // ── Phase 2: brute force runs in N Web Workers, each on a slice of depth-0 branches. ──
  const idsKey = _bfBuildIdsKey(nonWireIds);
  const N = getThreadCount();
  const saved = bfLoadSave();

  // Compute totalBranches first — we need it to plan ranges
  const t0 = Date.now();
  const totalBranches  = countDepth1Positions(nonWireIds, state.grid);
  const totalCombosStr = estimateTotalCombinations(nonWireIds, state.grid);
  console.log(`[BruteForce] countDepth1Positions: ${totalBranches} větví za ${Date.now()-t0}ms, odhad kombinací: ${totalCombosStr}`);

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
      console.log(`[BruteForce] Pokračuji v multi-worker prohledávání (${N} threadů, ${saved.workers.length} workerů uloženo).`);
    } else if (saved.v === 1 && N === 1) {
      // Legacy single-worker save matches current N=1 setup
      workerInitStates = [{
        branchRange: [0, totalBranches],
        currentBranchIdx: 0, // legacy save doesn't track this; restart current branch
        path: saved.path || [],
        stats: saved.stats || {}
      }];
      resumed = true;
      console.log('[BruteForce] Pokračuji v legacy v=1 saveu (jeden worker).');
    } else {
      console.log(`[BruteForce] Uložený stav neodpovídá konfiguraci (v=${saved.v}, threads=${saved.threadCount}, current N=${N}) — startuji od začátku.`);
      bfClearSave();
    }
  } else if (saved) {
    console.log('[BruteForce] Uložený stav neodpovídá aktuálnímu layoutu — startuji od začátku.');
    bfClearSave();
  }

  // Restore bestLayout if resuming
  if (resumed && saved.bestLayout && Array.isArray(saved.bestLayout) && saved.bestLayout.length > 0) {
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
    const w = new Worker('bruteforce-worker.js?v=53');
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
              console.log(`[BruteForce] První validní (worker ${i}) za ${elapsedS}s (score=${score})`);
              debugLayoutStatus(finalPl, state.grid, `BF — první validní (worker ${i})`);
              showStatus(`Brute force: první validní nalezeno workerem ${i} (${elapsedS}s). Hledám lepší…`, 'ok');
            } else {
              console.log(`[BruteForce] Lepší (worker ${i}) score=${score}`);
              debugLayoutStatus(finalPl, state.grid, `BF aplikováno (worker ${i})`);
            }
          }
          break;
        }
        case 'done': {
          finishedWorkers++;
          try { w.terminate(); } catch (err) {}
          console.log(`[BruteForce] Worker ${i} hotov (${finishedWorkers}/${N}).`);
          if (finishedWorkers >= N) {
            bfClearSave();
            aggregate();
            const completeMsg = valid > 0
              ? `Brute force hotový (${N} threadů): ${valid} validních rozložení z ${fmtNum(checked)} kombinací.`
              : `Brute force hotový (${N} threadů): žádné validní rozložení (${fmtNum(checked)} kombinací).`;
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
      etaStr = 'zbývá ' + fmtDHM((totalBranches - completedBranches) * secPerBranch);
    } else if (totalBranches > 0) {
      // Still in first branch — estimate: time so far × total branches = total time
      // Conservative (assumes we're near start of first branch); shown as approximate.
      etaStr = 'zbývá ~' + fmtDHM(elapsedSec * (totalBranches - 1)) + ' (odhad)';
    }

    const elStr = fmtDHM(elapsedSec);
    const parts = ['⚡²'];
    if (pctStr) parts.push(pctStr);
    const totalSuffix = totalCombosStr ? ' z ~' + totalCombosStr : '';
    if (checked > 0) {
      parts.push(fmtNum(checked) + ' kombin.' + totalSuffix);
    } else {
      parts.push('prohledávám… ≈' + fmtNum(ticks * 300) + ' uzlů' + totalSuffix);
    }
    parts.push(elStr + ' uplynulo');
    if (etaStr) parts.push(etaStr);

    bfEl.style.display = 'inline';
    bfEl.textContent   = parts.join(' · ');
  }

  console.log(`[BruteForce] Start: ${nonWireIds.length} součástek, grid ${state.grid.rows}×${state.grid.cols}, větví hloubky 1: ${totalBranches} (worker thread)`);
  if (bfEl) { bfEl.style.display = 'inline'; bfEl.textContent = '⚡² …'; }
}

function startBruteForce() {
  scheduleBruteForceOpt();
  showStatus('Brute force spuštěn — prohledávám všechny kombinace...', 'ok');
}

function showBetterLayoutOffer(newScore, oldScore, newWires, oldWires) {
  const pct     = Math.round((newScore - oldScore) / Math.max(1, Math.abs(oldScore)) * 100);
  const wireDiff = oldWires - newWires;
  const wireMsg  = wireDiff > 0 ? `, −${wireDiff} wire${wireDiff > 1 ? 's' : ''}` : '';
  const el  = document.getElementById('opt-offer');
  const msg = document.getElementById('opt-offer-msg');
  if (!el || !msg) return;
  msg.textContent = `Nalezeno lepší rozložení (+${pct}% kvalita${wireMsg})`;
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
  showStatus('Lepší rozložení aplikováno.', 'ok');
}

function dismissOptOffer() {
  pendingBetterLayout = null;
  hideBetterLayoutOffer();
}

// ─── Persistence ─────────────────────────────────────────────────────────────

function saveState() {
  localStorage.setItem(STATE_KEY, JSON.stringify({
    grid: state.grid,
    nextId: state.nextId,
    placements: state.placements.map(p => ({
      id: p.id, componentId: p.componentId,
      row: p.row, col: p.col, rotation: p.rotation,
      autoPlaced: p.autoPlaced || false
    }))
  }));
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
