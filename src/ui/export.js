// src/ui/export.js — Cross-machine layout transfer via base64 string.
//
// Export builds a `idle-directive-export v=1` bundle containing the current
// grid + every placement, encodes it as base64(utf8(JSON)), and shows it in
// the save modal for the user to copy. Import accepts the same bundle (or a
// legacy bare-layout shape) and overwrites the local state after a confirm.
//
// Typical size for a 35-component layout: ~10–15 KB encoded.

function _encodeBundle(data) {
  const json = JSON.stringify(data);
  const utf8 = new TextEncoder().encode(json);
  let bin = '';
  for (let i = 0; i < utf8.length; i++) bin += String.fromCharCode(utf8[i]);
  return btoa(bin);
}

function _decodeBundle(encoded) {
  const bin = atob(encoded.trim());
  const utf8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) utf8[i] = bin.charCodeAt(i);
  const json = new TextDecoder().decode(utf8);
  return JSON.parse(json);
}

function exportLayout() {
  // Close settings if it's open — otherwise its backdrop sits ON TOP of the
  // save modal (same z-index, later in DOM order) and blocks pointer events,
  // making the import textarea unfocusable / paste impossible.
  if (typeof closeSettings === 'function') closeSettings();
  if (!state.placements || state.placements.length === 0) {
    showStatus('Layout is empty — nothing to export.', 'warn');
    return;
  }

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
    exportedAt: Date.now()
  };
  const encoded = _encodeBundle(bundle);

  const layoutInfo = `${bundle.layout.placements.length} components · grid ${state.grid.rows}×${state.grid.cols}`;

  document.getElementById('save-modal-title').textContent = 'Export layout';
  document.getElementById('save-modal-info').innerHTML = `
    <p><strong>Layout:</strong> ${layoutInfo}</p>
    <p><strong>String size:</strong> ${encoded.length.toLocaleString()} chars</p>
    <p style="margin-top:6px;color:var(--text-bright)">Copy the text and paste it on the target machine in the Import dialog.</p>
  `;
  const ta = document.getElementById('save-modal-text');
  ta.value = encoded;
  ta.readOnly = true;
  document.getElementById('save-modal-action').textContent = 'Copy to clipboard';
  document.getElementById('save-modal').classList.remove('hidden');
  setTimeout(() => { ta.focus(); ta.select(); }, 50);
}

function openImportLayout() {
  // Same as exportLayout: close settings first so it doesn't sit on top
  // of the import modal and swallow paste/click events on the textarea.
  if (typeof closeSettings === 'function') closeSettings();
  document.getElementById('save-modal-title').textContent = 'Import layout';
  document.getElementById('save-modal-info').innerHTML = `
    <p>Paste exported string from another machine:</p>
  `;
  const ta = document.getElementById('save-modal-text');
  ta.value = '';
  ta.readOnly = false;
  document.getElementById('save-modal-action').textContent = 'Import';
  document.getElementById('save-modal').classList.remove('hidden');
  setTimeout(() => ta.focus(), 50);
}

function confirmSaveModal() {
  const ta = document.getElementById('save-modal-text');
  if (ta.readOnly) {
    navigator.clipboard.writeText(ta.value).then(
      () => { showStatus('Layout copied to clipboard.', 'ok'); closeSaveModal(); },
      () => { ta.select(); showStatus('Copy failed — select text and Ctrl+C.', 'warn'); }
    );
  } else {
    applyImportLayout();
  }
}

function applyImportLayout() {
  const text = document.getElementById('save-modal-text').value.trim();
  if (!text) { showStatus('Empty input.', 'warn'); return; }
  let data;
  try {
    data = _decodeBundle(text);
  } catch (e) {
    showStatus('Invalid string format: ' + e.message, 'error');
    return;
  }
  if (!data || data.type !== 'idle-directive-export' || data.v !== 1) {
    showStatus('Unrecognized import format.', 'error');
    return;
  }

  const layoutData = data.layout;
  if (!layoutData || !layoutData.placements) {
    showStatus('Bundle does not contain a layout.', 'error');
    return;
  }

  const ok = (state.placements && state.placements.length > 0)
    ? confirm(
        `Import layout with ${layoutData.placements.length} components, grid ${layoutData.grid.rows}×${layoutData.grid.cols}?\n\n` +
        `Current layout (${state.placements.length} components, grid ${state.grid.rows}×${state.grid.cols}) will be overwritten.`
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
  stopOptimization();
  bfResultsClear();
  saveState();
  renderAll();
  closeSaveModal();
  showStatus('Layout imported.', 'ok');
}

function closeSaveModal() {
  document.getElementById('save-modal').classList.add('hidden');
}
