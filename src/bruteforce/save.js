// src/bruteforce/save.js — Brute force save/load/export/import.
// Persists search progress to localStorage (BF_SAVE_KEY) and lets users
// move an in-progress search across machines via base64 string transfer.
//
// Save formats:
//   v=1 (legacy single-worker): { idsKey, rows, cols, path, stats, bestLayout }
//   v=2 (multi-worker):        { ..., totalBranches, threadCount, workers[], elapsedMs }
//
// Export bundle (cross-device transfer):
//   { type: 'idle-directive-export', v: 1, layout, bfSave }

function _bfBuildIdsKey(nonWireIds) { return [...nonWireIds].sort().join(','); }

function bfClearSave() {
  try { localStorage.removeItem(BF_SAVE_KEY); } catch (e) {}
  // Invalidate bgOptId so any pending worker messages already in the queue
  // see bgOptId !== their myId and exit early instead of stomping state.
  bgOptId++;
  // Stop BF workers
  if (currentBfWorkers.length > 0) {
    for (const w of currentBfWorkers) {
      try { w.postMessage({ type: 'stop' }); } catch (e) {}
      try { w.terminate(); } catch (e) {}
    }
    currentBfWorkers = [];
  }
  // Stop SA workers (previously missed — caused leaf messages to overwrite
  // user's component additions and lose work).
  if (typeof currentSaWorkers !== 'undefined' && currentSaWorkers.length > 0) {
    for (const w of currentSaWorkers) {
      try { w.postMessage({ type: 'stop' }); } catch (e) {}
      try { w.terminate(); } catch (e) {}
    }
    currentSaWorkers = [];
  }
}

function bfLoadSave() {
  try {
    const raw = localStorage.getItem(BF_SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || (data.v !== 1 && data.v !== 2)) return null;
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

function _bfEncodeSave(data) {
  const json = JSON.stringify(data);
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
  // Close settings if it's open — otherwise its backdrop sits ON TOP of the
  // save modal (same z-index, later in DOM order) and blocks pointer events,
  // making the import textarea unfocusable / paste impossible.
  if (typeof closeSettings === 'function') closeSettings();
  if (!state.placements || state.placements.length === 0) {
    showStatus('Layout je prázdný — není co exportovat.', 'warn');
    return;
  }

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
  // Same as exportBfSave: close settings first so it doesn't sit on top
  // of the import modal and swallow paste/click events on the textarea.
  if (typeof closeSettings === 'function') closeSettings();
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
    navigator.clipboard.writeText(ta.value).then(
      () => { showStatus('Save zkopírován do schránky.', 'ok'); closeSaveModal(); },
      () => { ta.select(); showStatus('Kopírování selhalo — vyber text a Ctrl+C.', 'warn'); }
    );
  } else {
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
    bfClearSave();
    saveState();
    renderAll();
  }

  if (bfData) {
    try {
      localStorage.setItem(BF_SAVE_KEY, JSON.stringify(bfData));
      closeSaveModal();
      showStatus('Layout a BF save importovány. Spusť ho ručně tlačítkem BRUTE.', 'ok');
      // Note: do NOT auto-start. User triggers via the BRUTE button.
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
