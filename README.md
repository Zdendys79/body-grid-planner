# Idle Directive – Body Optimizer

Web app for optimizing component placement on a body grid.

**URL:** `https://idle-directive.zdendys79.website`  
**Files:** `/var/www/html/idle_directive/`

---

## Architecture

| File | Role |
|---|---|
| `index.html` | HTML skeleton, loads scripts with cache buster `?v=XX` |
| `components.json` | Definitions of all components (shape, ports, colors) — AUTHORITATIVE, do not edit! |
| `optimizer.js` | Placement logic: rotation, powering computation, hard constraints |
| `app.js` | UI, state management, background optimizer |
| `renderer.js` | SVG grid renderer |
| `styles.css` | CSS |

---

## Key concepts

### Coordinate system
Grid `rows × cols`, (0,0) = top-left corner.  
**Bus:** left column (W ports at col=0) and bottom row (S ports at row=rows-1).

### Powering (computePoweredSet)
BFS from buses through port-to-port connections. Port A side → adjacent cell → port B OPPOSITE(side).

### Spinner working state (computeWorkingSet)
A Spinner is working if:
- it has an adjacent repeater_2s on any side, OR
- it has an adjacent repeater_4s on 2 distinct sides.

Pulser: Repeaters are optional.

### Hard constraints in findBestPlacement
1. **Spinner**: must have free adjacent cells for pending Repeaters (from pendingIds).
2. **Repeater**: if any non-working Spinner exists, the Repeater MUST connect to it.

### Component order (Rep → Spin)
ensureComponentOrder: others → Repeater → Spinner → Repeater → Spinner → bio-only.  
Repeater always comes BEFORE Spinner — the Spinner then uses energyBonus and connects
to the powered Repeater. This naturally creates a Rep→Spin→Rep→Spin chain.

### Background optimizer (scheduleBackgroundOpt)
- N ≤ 7 components: tries all N! orderings
- N > 7: 800 random orderings (generateClusterOrdering) + 1× ensureComponentOrder
- Every ordering goes through isLayoutValid — invalid ones are discarded
- Best valid result is offered to the user via a banner

### isLayoutValid
A layout is valid if:
- every energy component is powered
- every Spinner is working (if Repeaters exist in the layout)

---

## Cache buster

After any change to optimizer.js or app.js, bump the version in index.html.
Current version: v=90

---

## Development rules

- components.json is authoritative — NEVER edit ports, shape or colors without an explicit request
- Debugging connectivity: look for bugs in ORDER or SCORING in optimizer.js, not in port definitions
- Layout validation: hard constraints in isLayoutValid, not scoring tricks
- No artificial cluster systems — correct arrangement emerges naturally from correct constraints
