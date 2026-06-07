// src/ui/help.js — Help modal: explains every button + interaction + scoring,
// plus links out to the actual game on Steam and itch.io.

function openHelp() {
  document.getElementById('help-modal').classList.remove('hidden');
}

function closeHelp() {
  document.getElementById('help-modal').classList.add('hidden');
}
