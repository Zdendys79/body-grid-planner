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
  renderWeightList();
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
//
// The whole "Layout scoring weights" section is built here (not static HTML)
// so each row can carry a live fill bar showing that signal's share of the
// CURRENT layout's total score — see computeWeightContributions/updateWeightBars.
const WEIGHT_META = [
  { key: 'workingSet', label: 'Working Spinner', step: 50000,
    hint: "Score awarded per working Spinner (one that has its required Repeater adjacency). The single largest signal — SA nearly always prioritizes getting one more Spinner working over any other improvement." },
  { key: 'amplifier', label: 'Amplifier bonus', step: 100000,
    hint: "Score per port-to-port connection between a Power Amplifier and an adjacent Harvester or Salvager, which the amplifier boosts in-game. Optional — not required for layout validity, but this weight makes SA try to wire a Harvester/Salvager up to an Amplifier when the grid allows it." },
  { key: 'batteryAmplifier', label: 'Battery Amplifier bonus', step: 100000,
    hint: "Score per port-to-port connection between a Battery Amplifier and an adjacent battery, MULTIPLIED by that battery's cell count — a 4-cell battery is worth 4x a 1-cell one. Optional — not required for layout validity, but this weight makes SA try to connect batteries (bigger ones especially) to a Battery Amplifier when the grid allows it." },
  { key: 'energyAmpBioGen', label: 'Energy Amp: Bio Generator', step: 100000,
    hint: "Score per port-to-port connection between an Energy Amplifier and an adjacent Bio Generator or Bio Generator (II), which the amplifier boosts in-game. Flat per connection. Optional — not required for layout validity, but this weight makes SA try to wire a Bio Generator up to an Energy Amplifier when the grid allows it." },
  { key: 'energyAmpEnergyCells', label: 'Energy Amp: Energy Cells', step: 100000,
    hint: "Score per port-to-port connection between an Energy Amplifier and an adjacent Energy Cells block, which the amplifier boosts in-game. Flat per connection. Optional — not required for layout validity, but this weight makes SA try to wire Energy Cells up to an Energy Amplifier when the grid allows it." },
  { key: 'energyAmpSpinner', label: 'Energy Amp: Spinner', step: 100000,
    hint: "Score per port-to-port connection between an Energy Amplifier and an adjacent Spinner, which the amplifier boosts in-game. Flat per connection. Optional — independent of the Spinner's separate Repeater working-set requirement, and not required for layout validity." },
  { key: 'energyAmpPulser', label: 'Energy Amp: Pulser', step: 100000,
    hint: "Score per port-to-port connection between an Energy Amplifier and an adjacent Pulser, which the amplifier boosts in-game. Flat per connection. Optional — not required for layout validity, but this weight makes SA try to wire a Pulser up to an Energy Amplifier when the grid allows it." },
  { key: 'concentrator', label: 'Concentrator bonus', step: 100000,
    hint: "Score per DISTINCT Energy Cells block connected to a Concentrator (up to 8, one per outward port), which the Concentrator boosts in-game. Flat per connected block, not per port — a block touching via 2 of its own ports still counts once. Optional — not required for layout validity, but this weight makes SA try to wire Energy Cells up to a Concentrator when the grid allows it." },
  { key: 'wirePenalty', label: 'Wire penalty', step: 5000,
    hint: "Score subtracted per auto-routed wire cell. Keeps SA from routing long wire chains when a more compact, wire-free arrangement is possible. Raised to 100000 by default (v=149) — humans read fewer wires as more logical, so this now outweighs a fair amount of free-space bonus rather than being pure noise next to it." },
  { key: 'quality', label: 'Free space quality', step: 500,
    hint: "Score per unit of free-cell connectivity (each empty cell's count of empty orthogonal neighbours, summed over the grid). Rewards keeping remaining free space open and unfragmented. Small compared to the other signals — mostly acts as a tie-breaker." },
  { key: 'freeBlock', label: 'Free space bonus', step: 0.1,
    hint: "Multiplier on the bonus for large open rectangles of free cells that are reachable from the W/S bus or from a placed component's port (so a future battery/cluster put there could eventually be powered). Applies regardless of whether the rectangle touches the bus directly — see 'Bus access bonus' for that extra reward. Default lowered to 0.2 (v=149, was 1.0) to make room for a stronger wire penalty; raise to make SA leave more open space, lower to let it pack tighter." },
  { key: 'busAccess', label: 'Bus access bonus', step: 0.1,
    hint: "Extra multiplier added ON TOP of the free space bonus, but only for open rectangles that touch the W (col 0) or S (bottom row) bus directly — a future component placed there needs no wire at all. Independent of 'Free space bonus', so you can value general open space and direct bus access separately. 1.0 = default tuning (matches the old always-doubled behaviour); 0 disables the extra bus incentive entirely." },
  { key: 'cluster', label: 'Aesthetic clustering', step: 1000,
    hint: "Score per pair of same-type components placed next to each other (doubled if they're also port-to-port connected). Purely cosmetic — doesn't affect power or validity, just makes SA prefer tidy same-type groupings. Spinners, Repeaters and wires are excluded, since their adjacency is already governed by the power rules." }
];

// Working Spinner + all Amplifier bonuses render together in a visually
// distinct box (per request): all are functional component-to-component
// bonuses, as opposed to the general spatial/aesthetic signals below them.
const WEIGHT_GROUPED = new Set([
  'workingSet', 'amplifier', 'batteryAmplifier',
  'energyAmpBioGen', 'energyAmpEnergyCells', 'energyAmpSpinner', 'energyAmpPulser',
  'concentrator'
]);

// Called once on app startup to seed the main thread's live weights from
// whatever the player saved last time (falls back to DEFAULT_SCORE_WEIGHTS).
function loadScoreWeights() {
  const s = loadSettings();
  setScoreWeights(s.weights || {});
}

// Raw (already weighted) contribution of each signal to scoreLayout's total
// for the CURRENT layout — the same building blocks scoreLayout itself uses.
// wirePenalty comes out negative; everything else is >= 0.
function computeWeightContributions() {
  const placements = state.placements || [];
  const grid = state.grid;
  const wires           = placements.filter(p => p.componentId === 'wire').length;
  const quality          = computeFreeSpaceQuality(null, 0, 0, placements, grid.rows, grid.cols);
  const workingSet       = computeWorkingSet(placements);
  const blockBonus       = computeFreeBlockBonus(placements, grid.rows, grid.cols);
  const amplifierBonus   = computeAmplifierBonus(placements);
  const batteryAmpBonus  = computeBatteryAmplifierBonus(placements);
  const energyAmpCounts  = computeEnergyAmplifierBonus(placements);
  const concentratorBonus = computeConcentratorBonus(placements);
  const clusterBonus     = computeClusterBonus(placements);
  const w = getScoreWeights();
  return {
    workingSet:            workingSet.size * w.workingSet,
    amplifier:             amplifierBonus,
    batteryAmplifier:      batteryAmpBonus,
    energyAmpBioGen:       energyAmpCounts.bioGen * w.energyAmpBioGen,
    energyAmpEnergyCells:  energyAmpCounts.energyCells * w.energyAmpEnergyCells,
    energyAmpSpinner:      energyAmpCounts.spinner * w.energyAmpSpinner,
    energyAmpPulser:       energyAmpCounts.pulser * w.energyAmpPulser,
    concentrator:          concentratorBonus,
    wirePenalty:      -(wires * w.wirePenalty),
    quality:          quality * w.quality,
    freeBlock:        blockBonus.free * w.freeBlock,
    busAccess:        blockBonus.bus * w.busAccess,
    cluster:          clusterBonus
  };
}

// Updates only the fill-bar width + percentage label of each row, without
// touching the <input> elements — so it's safe to call on every keystroke
// (onWeightChange) without stealing focus mid-type. Percentage = this
// signal's share of the sum of every signal's magnitude, so the bars stay
// meaningful even though wirePenalty is a subtraction.
function updateWeightBars() {
  const contrib = computeWeightContributions();
  const total = Object.values(contrib).reduce((sum, v) => sum + Math.abs(v), 0);
  WEIGHT_META.forEach(m => {
    const val = contrib[m.key] || 0;
    const pct = total > 0 ? Math.round(Math.abs(val) / total * 100) : 0;
    const fillEl  = document.getElementById(`weight-bar-${m.key}`);
    const labelEl = document.getElementById(`weight-pct-${m.key}`);
    if (fillEl)  { fillEl.style.width = `${pct}%`; fillEl.classList.toggle('negative', val < 0); }
    if (labelEl) labelEl.textContent = `${pct}%`;
  });
}

// Full rebuild: inputs (current values) + bar/percentage markup. Called when
// the modal opens and after a reset — NOT on every keystroke, since rebuilding
// the <input> nodes would drop focus while the player is typing.
function renderWeightList() {
  const w = getScoreWeights();

  const rowHtml = (m) => `
      <div class="weight-item">
        <div class="weight-row">
          <label for="weight-${m.key}">${m.label} <span class="hint-icon" title="${m.hint.replace(/"/g, '&quot;')}">[?]</span></label>
          <input type="number" id="weight-${m.key}" min="0" step="${m.step}" value="${w[m.key]}" oninput="onWeightChange('${m.key}', this.value)">
        </div>
        <div class="weight-bar-track">
          <div class="weight-bar-fill" id="weight-bar-${m.key}" style="width:0%"></div>
          <span class="weight-bar-label" id="weight-pct-${m.key}">0%</span>
        </div>
      </div>`;

  const grouped = WEIGHT_META.filter(m => WEIGHT_GROUPED.has(m.key));
  const rest    = WEIGHT_META.filter(m => !WEIGHT_GROUPED.has(m.key));

  const container = document.getElementById('weight-list');
  if (!container) return;
  container.innerHTML =
    `<div class="weight-group">${grouped.map(rowHtml).join('')}</div>` +
    rest.map(rowHtml).join('');

  updateWeightBars();
}

function onWeightChange(key, rawValue) {
  // A running SA batch already has its own copy of the old weights (sent
  // once via the worker 'init' message) and won't pick up the change — stop
  // it, same as any layout-mutating action, so it never keeps optimizing
  // against stale weights. The player has to explicitly restart SMART.
  stopOptimization();
  let val = parseFloat(rawValue);
  if (!Number.isFinite(val) || val < 0) val = DEFAULT_SCORE_WEIGHTS[key];
  const s = loadSettings();
  s.weights = { ...getScoreWeights(), [key]: val };
  saveSettings(s);
  setScoreWeights(s.weights);
  updateWeightBars();
}

function resetScoreWeights() {
  stopOptimization();
  const s = loadSettings();
  delete s.weights;
  saveSettings(s);
  setScoreWeights({});
  renderWeightList();
}
