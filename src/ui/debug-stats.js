// src/ui/debug-stats.js — Local-only RE-OPTIMIZE run stats, kept so the user
// can inspect/export them when debugging why a run did or didn't help.
// Never leaves the browser on its own — same "no server, no tracking"
// guarantee as the rest of the app (see README Privacy section). Export
// reuses the save-modal + base64 bundle mechanism from src/ui/export.js,
// same as the cross-machine layout transfer string.

const REOPT_STATS_MAX = 50;

function reoptStatsLoad() {
  try {
    const raw = localStorage.getItem(REOPT_STATS_KEY);
    return raw ? (JSON.parse(raw) || []) : [];
  } catch (e) { return []; }
}

function reoptStatsSave(stats) {
  try { localStorage.setItem(REOPT_STATS_KEY, JSON.stringify(stats)); } catch (e) {}
}

// Appends one run record, trimmed to the most recent REOPT_STATS_MAX.
function reoptStatsRecord(entry) {
  const stats = reoptStatsLoad();
  stats.push({ at: Date.now(), ...entry });
  while (stats.length > REOPT_STATS_MAX) stats.shift();
  reoptStatsSave(stats);
}

function reoptStatsClear() {
  reoptStatsSave([]);
  showStatus('RE-OPTIMIZE stats cleared.', 'ok');
}

// Encodes the stored stats as the same kind of base64 bundle exportLayout()
// produces, and shows it in the save-modal for the user to copy/paste.
function openReoptStats() {
  if (typeof closeSettings === 'function') closeSettings();
  const stats = reoptStatsLoad();
  if (stats.length === 0) {
    showStatus('No RE-OPTIMIZE runs recorded yet.', 'warn');
    return;
  }
  const improved = stats.filter(s => s.outcome === 'improved').length;

  const bundle = {
    type: 'body-grid-planner-reopt-stats',
    v: 1,
    stats,
    exportedAt: Date.now()
  };
  const encoded = _encodeBundle(bundle);

  document.getElementById('save-modal-title').textContent = 'RE-OPTIMIZE debug stats';
  document.getElementById('save-modal-info').innerHTML = `
    <p><strong>${stats.length} run${stats.length === 1 ? '' : 's'} recorded · ${improved} improved</strong></p>
    <p style="margin-top:6px;color:var(--text-bright)">Local only — never sent anywhere. Copy this string and paste it for debugging.</p>
  `;
  const ta = document.getElementById('save-modal-text');
  ta.value = encoded;
  ta.readOnly = true;
  document.getElementById('save-modal-action').textContent = 'Copy to clipboard';
  document.getElementById('save-modal').classList.remove('hidden');
  setTimeout(() => { ta.focus(); ta.select(); }, 50);
}
