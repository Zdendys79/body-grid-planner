// bruteforce-worker.js — runs the brute force search in a dedicated worker thread.
// Phase 2: multi-worker; each instance handles a [branchStart, branchEnd) slice.
// All search logic is in src/bruteforce/generator.js, loaded via importScripts.
// componentLib is sent from main on init.

importScripts(
  'src/constants.js?v=92',
  'src/optimizer/rotation.js?v=92',
  'src/optimizer/bus.js?v=92',
  'src/optimizer/placement.js?v=92',
  'src/optimizer/score.js?v=92',
  'src/optimizer/validate.js?v=92',
  'src/bruteforce/generator.js?v=92',
  'optimizer.js?v=92'
);

let componentLib = [];

// ── Brute force generator (copied from app.js) ──────────────────────────────
// (_SIDE_IDX is defined in src/constants.js, loaded via importScripts above)

// ── Worker message protocol ─────────────────────────────────────────────────

let stopRequested = false;
let activeRun = false;

self.onmessage = function (e) {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      componentLib = msg.componentLib;
      self.postMessage({ type: 'ready' });
      break;
    case 'start':
      if (activeRun) {
        self.postMessage({ type: 'error', message: 'already running' });
        return;
      }
      stopRequested = false;
      activeRun = true;
      runSearch(msg);
      break;
    case 'stop':
      stopRequested = true;
      break;
  }
};

function runSearch(params) {
  const { nonWireIds, grid, resumePath, branchStart = 0, branchEnd = Infinity, workerId = 0 } = params;
  const stateRef = {};
  let checked = (params.resumeStats?.checked) || 0;
  let valid   = (params.resumeStats?.valid)   || 0;
  let ticks   = (params.resumeStats?.ticks)   || 0;
  let bestScore = (params.resumeStats?.bestScore) || -Infinity;
  let completedBranches = (params.resumeStats?.completedBranches) || 0;
  let lastProgress = Date.now();
  const PROGRESS_INTERVAL_MS = 1000;

  const gen = bruteForcePlacements(nonWireIds, grid, () => {
    completedBranches++;
  }, resumePath, stateRef, { branchStart, branchEnd });

  function sendProgress() {
    const path = stateRef.getPath ? stateRef.getPath() : [];
    const currentBranchIdx = stateRef.getCurrentBranchIdx ? stateRef.getCurrentBranchIdx() : branchStart;
    self.postMessage({
      type: 'progress',
      workerId,
      stats: { checked, valid, ticks, completedBranches, bestScore },
      path,
      currentBranchIdx
    });
  }

  function step() {
    if (stopRequested) {
      activeRun = false;
      sendProgress();
      self.postMessage({ type: 'stopped', workerId });
      return;
    }

    const batchDeadline = Date.now() + 50; // worker can use longer batches (no UI blocking risk)
    while (Date.now() < batchDeadline) {
      const { value: pl, done } = gen.next();
      if (done) {
        activeRun = false;
        sendProgress();
        self.postMessage({ type: 'done', workerId, stats: { checked, valid, ticks, completedBranches, bestScore } });
        return;
      }
      if (pl === null) { ticks++; continue; }
      checked++;

      let finalPl = pl;
      if (!isLayoutValid(pl, grid)) {
        const wired = tryAddWires(pl, grid);
        if (!wired || !isLayoutValid(wired, grid)) continue;
        finalPl = wired;
      }
      valid++;
      const score = scoreLayout(finalPl, grid);
      if (score > bestScore) {
        bestScore = score;
        self.postMessage({
          type: 'leaf',
          workerId,
          layout: finalPl,
          score,
          isFirst: valid === 1,
          stats: { checked, valid, ticks, completedBranches }
        });
      }
    }

    const now = Date.now();
    if (now - lastProgress >= PROGRESS_INTERVAL_MS) {
      lastProgress = now;
      sendProgress();
    }
    setTimeout(step, 0);
  }

  step();
}
