// src/ui/settings.js — Settings modal: thread count + entry-points to
// import/export. Persists the user's choice to localStorage[SETTINGS_KEY].

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? (JSON.parse(raw) || {}) : {};
  } catch (e) { return {}; }
}

function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
}

// Used by scheduleBruteForceOpt to decide how many workers to spawn.
function getThreadCount() {
  const s = loadSettings();
  if (typeof s.threads === 'number' && s.threads >= 1 && s.threads <= MAX_THREADS) return s.threads;
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
