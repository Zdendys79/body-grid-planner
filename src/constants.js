// src/constants.js — Shared constants for the Body Optimizer.
// Loaded BEFORE app.js so other scripts can read these as top-level identifiers.

// localStorage keys
const STATE_KEY    = 'idle_directive_state';
const BF_SAVE_KEY  = 'bf_resume_v1';
const SETTINGS_KEY = 'app_settings';

// Brute force tuning
const MAX_THREADS = 6;

// Port-side encoding: maps "N", "S", "E", "W" to flat integer indices used
// in port int keys throughout the brute force inner loops.
const _SIDE_IDX = { N: 0, S: 1, E: 2, W: 3 };
