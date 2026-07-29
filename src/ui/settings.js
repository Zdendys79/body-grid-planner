// src/ui/settings.js — Settings modal: thread count, layout scoring
// weights, + entry-points to import/export. Persists the user's choices to
// localStorage[SETTINGS_KEY].

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
  renderWeightInputs();
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

// ─── Layout scoring weights ─────────────────────────────────────────────────
// setScoreWeights/getScoreWeights (src/optimizer/score.js) hold the live
// values scoreLayout reads on the main thread. localStorage[SETTINGS_KEY]
// is just persistence — SA workers get their own copy via the 'init'
// message (see scheduleAnnealOpt in app.js), since threads share no memory.
const WEIGHT_FIELDS = ['workingSet', 'wirePenalty', 'quality', 'freeBlock', 'cluster', 'amplifier'];

// Called once on app startup to seed the main thread's live weights from
// whatever the player saved last time (falls back to DEFAULT_SCORE_WEIGHTS).
function loadScoreWeights() {
  const s = loadSettings();
  setScoreWeights(s.weights || {});
}

function renderWeightInputs() {
  const w = getScoreWeights();
  WEIGHT_FIELDS.forEach(key => {
    const el = document.getElementById(`weight-${key}`);
    if (el) el.value = w[key];
  });
}

function onWeightChange(key, rawValue) {
  let val = parseFloat(rawValue);
  if (!Number.isFinite(val) || val < 0) val = DEFAULT_SCORE_WEIGHTS[key];
  const s = loadSettings();
  s.weights = { ...getScoreWeights(), [key]: val };
  saveSettings(s);
  setScoreWeights(s.weights);
}

function resetScoreWeights() {
  const s = loadSettings();
  delete s.weights;
  saveSettings(s);
  setScoreWeights({});
  renderWeightInputs();
}
