# Idle Directive – Body Optimizer – STATUS

**Datum:** 2026-06-04
**Verze:** v=52
**URL:** https://idle-directive.zdendys79.website

## v=52 — Settings překryvka

- **⚙ ikona** vedle nadpisu "BODY OPTIMIZER" → otevírá modal s nastavením
- **Počet threadů** pro brute force (slider 1–6, default `min(hardwareConcurrency, 6)`)
- **Max je 6** i kdyby HW mělo víc — nezahltí cílový stroj
- Hodnota persistována v `localStorage['app_settings']`, čteno přes `getThreadCount()` — připravené pro Phase 2 (multi-worker dispatcher)
- **Export/Import přesunut** z hlavního panelu do settings modalu
- **Glassmorphism modal**: `backdrop-filter: blur(10px) saturate(140%)`, semi-transparentní pozadí, fade-in animace, lehký scale-up content

## v=51 — Export bundle = layout + BF save

Export vždy obsahuje layout; BF save se přidá, pokud existuje. Import přepíše layout a optionally obnoví BF save (auto-restart workera). Backward-compatible s v=49/50 legacy formátem (jen BF save).

## v=50 — Repeater musí mít cíl (Spinner nebo Pulser)

- **Nová validační podmínka** v `isLayoutValid` (app.js i worker): každý umístěný Repeater musí mít port-match s alespoň jedním Spinnerem nebo Pulserem
- **Placement-time pruning**: `targetCoverKeyCount: Map<int, count>` udržuje union Spinner + Pulser cover keys; Repeater bez match je odmítnut bezprostředně po pushPlacement (před canReachBus)
- **Pulser tracking**: nový `pushPulserTracking` / `popPulserTracking` aktualizují `targetCoverKeyCount`
- **Helper `computeCoverKeys`** sdílen Spinnerem i Pulserem
- Spinner-Rep coverage counter (Opt #2) zůstává beze změny

## v=49 — Save state export/import

- **Export tlačítko** v levém panelu → modal s base64 zakódovaným save state
- **Import tlačítko** → vložit řetězec → validace → resume na cílovém stroji
- Použití: server (4 jádra) → desktop (24 threadů) bez ztráty progressu
- Při mismatchi layoutu nabízí přepsat aktuální layout layoutem ze saveu
- Formát stringu: `base64(utf8(JSON))` — typicky ~10-15 KB pro 35-componentní search

---

## TODO: Paralelizace brute force (Web Workers)

**Motivace:** Brute force pro 35-40 součástek běží dny. Search prostor větví hloubky 1 je 800-3000 nezávislých větví — ideální kandidát pro paralelizaci.

**Plán implementace ve fázích:**

### Fáze 1 — Refactor do worker (1 vlákno, kontrolní) ✅ DOKONČENO (v=48)
- ✅ `bruteforce-worker.js` vytvořen s `importScripts('optimizer.js?v=48')`
- ✅ Worker obsahuje vlastní kopii `bruteForcePlacements`, `isLayoutValid`, `tryAddWires`, `scoreLayout`, `getUniqueDegs`
- ✅ Main thread: `scheduleBruteForceOpt` vytváří `Worker`, posílá `{type:'init', componentLib}` → `{type:'start', nonWireIds, grid, resumePath, resumeStats}`
- ✅ Worker posílá: `progress` (každou sekundu), `leaf` (lepší layout), `done`, `stopped`
- ✅ `currentBfWorker` module-level state pro terminate při změně layoutu nebo nové scheduleBruteForceOpt
- ✅ Resume funguje přes worker — main předá `resumePath` v `start` message
- ✅ Save funguje — main na 60s ticku v `progress` message uloží `path` + stats
- ✅ `bfClearSave()` zabíjí běžící worker při změně layoutu/gridu
- ✅ Auto-resume na page load (init detekuje saved stav, volá scheduleBruteForceOpt)
- **Bonus speedup ~2×** — worker má 50ms batch deadline (vs. main 8ms s UI sync), vyšší CPU využití.

### Fáze 2 — N workerů, naivní partition
- `navigator.hardwareConcurrency` udává počet jader (typicky 4-16)
- Main rozdělí `totalBranches` (depth-1) rovnoměrně: každý worker dostane `[start, end)` rozsah
- Workeři běží nezávisle, posílají best-found layout
- Main agreguje, ukáže globálně nejlepší
- **Očekávaný speedup: 5-7× na 8 jádrech** (lineární s režií messaging).

### Fáze 3 — Sdílený bestScore (volitelné, pokročilé)
- `SharedArrayBuffer + Atomics` pro globální bestScore mezi workery
- Workeři používají sdílené best pro pruning větví, které nemohou překonat
- Vyžaduje COOP+COEP HTTP hlavičky a `crossOriginIsolated` (nutná konfigurace Apache)

### Co se přizpůsobí
- **Resume** — per-worker stav nebo agregovaný snapshot. Save formát musí obsahovat per-worker path.
- **UI progress** — sečíst progress všech workerů.
- **Timings** — agregovat z workerů přes message.

### Co se zachová
- Pruningy #1-#5 fungují per-worker (state je lokální).
- Bus reachability funguje per-worker.
- Cell-budget funguje per-worker.

---

## Aktuální stav: FUNKČNÍ

### Co bylo nasazeno ve v=22

**Velká refaktorizace optimizeru** — odstraněn umělý cluster systém, přidány hard constraints.

#### Odstraněno (bylo zbytečně komplexní)
- `buildSpinnerClusters` — generátor šablon pro clustery
- `placeClusterAt` — umísťovač cluster šablon
- `runClusterOptimization` — cluster fáze background optimizeru
- `removeUsed` + `greedyFillRemaining` — pomocné funkce cluster fáze

#### Přidáno / opraveno

**optimizer.js:**
- Hard constraint #1 — Spinner musí mít volné sousední buňky pro pending Repeatery
- Hard constraint #2 — Repeater MUSÍ se připojit k nefunkčnímu Spinneru (pokud existuje)
- Rezervace peripheral slotů v `occupiedMap` (sentinel -1) — oprava biocell bug

**app.js:**
- `isLayoutValid` — validuje kompletní layout (napájení + funkčnost Spinnerů)
- `scheduleBackgroundOpt` — zjednodušen: pouze sampling pořadí + `isLayoutValid` filtr
- `ensureComponentOrder` — opraveno pořadí: Rep PŘED Spin (bylo opačně)
- `generateClusterOrdering` — opraveno: Repeatery tlačeny PŘED jejich Spinner
- `debugLayoutStatus` — debug helper s console.group výstupem
- Opravena reference `generateRepFirstOrdering` → `generateClusterOrdering`

---

## Architektura optimizeru (po refaktorizaci)

```
addComponent / optimizeAll
    └── findBestPlacement (greedy, hard constraints)
            ├── Hard: Spinner musí mít místo pro Repeatery
            └── Hard: Repeater musí jít k nefunkčnímu Spinneru

scheduleBackgroundOpt (async batched)
    ├── N ≤ 7: allPermutations (N!)
    └── N > 7: 800× generateClusterOrdering + ensureComponentOrder
            └── runOptimizationOnCopy
                    └── isLayoutValid → zahazuje neplatné
                            └── scoreLayout → ukládá nejlepší
```

---

## Známé limitace

- Background optimizer může nenajít platný layout pokud je grid příliš malý
  (správná zpráva: "nenalezeno místo — rozbal body")
- Pro N > 7 komponent: 800 vzorků nemusí pokrýt optimální pořadí (stochastické)

---

## Historie verzí (poslední)

| Verze | Datum | Změna |
|---|---|---|
| v=22 | 2026-06-03 | Odstraněn cluster systém, hard constraints, oprava Rep→Spin pořadí |
| v=21 | 2026-06-03 | Debug logging, biocell reservation fix, Repeater hard constraint |
| v=20 | předchozí | Cluster template systém (nahrazen) |
