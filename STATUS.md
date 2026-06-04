# Idle Directive – Body Optimizer – STATUS

**Datum:** 2026-06-04
**Verze:** v=88
**URL:** https://idle-directive.zdendys79.website
**GitHub:** https://github.com/Zdendys/idle-directive

---

## Nápady na vylepšení

### ✅ saChainMove (v=89) — chain translate + rotate jako atomic skupina

Implementováno v `src/sa/moves.js`. `_saFindChains` detekuje connected component-y port-touching Spinnerů a Repeaterů (BFS přes adjacency). `saChainTranslate` posouvá celý chain o 1–4 buňky v náhodném směru. `saChainRotate` rotuje chain o 90/180/270° kolem bbox top-left (každá komponenta + svůj anchor rotuje konzistentně). Začleněno do `saGenerateMove` jako `chain` kategorie s váhou 0.10 (balanced/swap/rotate/local), 0.20 (jump). Pro chain-rotation využívá factu, že component-rotation logic shape-wise odpovídá chain-rotation transform (90 CW na bbox = 90 CW na každý shape s posunutým anchorem).

### Nápady na vylepšení (zatím neimplementováno)

### 1. Bent/diagonal cluster varianty pro Spinner-Repeater chainy

Aktuálně `src/sa/clusters.js` definuje jen **lineární** I-shape chain (`buildClusterDef('A', n)` = horizontální `S-R₂-S-R₂-…`, ve 4 rotacích přes `_precomputeRotationVariants`). SA s těmito atomickými clustery zvládne jen "narovnané" tvary; ohnuté/diagonální musí skládat z jednotlivých součástek přes `shift/swap/relocate` moves — řádově pomalejší.

Návrh: přidat další `buildClusterDef` varianty s identickými outer porty `(2,0) W` + `(2,4) E` ale jinou vnitřní geometrií:

- `A_L_n` — L-shape (R₂ vystupuje kolmo o 1 řádek dolů → 4h × 5w)
- `A_diag_up_n` — diagonální vzestup (S vlevo dole, S vpravo nahoře → 5h × 5w)
- `A_diag_down_n` — diagonální sestup (mirror diag_up)

Každá nová varianta vyžaduje vlastní `_internalPlacements` array + projde stejným `_precomputeRotationVariants` → 4 rotace na variantu. Celkem +12 cluster variant pro `n=2`.

Přínos: SA dokáže atomicky umístit "L u horní hrany + I uvnitř" nebo "dva diagonály do rohů" místo aby k těmto konfiguracím konvergovala přes desítky individuálních moves.

### 2. Island migration — cross-worker sync nejlepšího layoutu

Aktuálně jsou SA workery nezávislé ostrovy: `bestValidLayout` je per-worker, main thread leafy sbírá ale nevysílá je zpět. Zaseknutý worker (např. na score 75k zatímco jiný má 100k) pokračuje od svého lokálního maxima.

Návrh: každých N iterací (např. 1000) main thread broadcastne aktuální `bfResults[0].layout` všem workerům jako `{type:'migrate', layout, score}`. Worker pokud má `bestValidCost > globalCost`, přepne svůj `current` + `best` na globální nejlepší a rozhřeje T zpátky na ~50 % `tStart`. Stále si nese svůj per-worker `WORKER_PROFILES` (move bias + perturb), takže od stejného startu jde **jinou cestou**.

Trade-off:
- ✅ Rychlejší konvergence k globálnímu optimu
- ⚠️ Riziko premature convergence (všichni v jednom basinu)
- ⚠️ Vyžaduje broadcast logiku v `scheduleAnnealOpt` + `migrate` handler v sa-worker

Implementační rozsah: ~80 LOC, low-risk (žádná změna scoringu).

---

## v=53–62 — Multi-worker brute force + modularizace

### v=53 — Phase 2 Multi-worker
- `scheduleBruteForceOpt` spawnuje `N = getThreadCount()` workerů, každý přebírá `[branchStart, branchEnd)` slice z `totalBranches`
- `bfSaveStateV2` formát zachycuje per-worker stav pro resume
- Reset přesunut do Settings modalu jako "System reset" (danger style)
- Glassmorphism styl modalů

### v=54–62 — Modularizace (refactor steps 1–9)
Kompletně rozdělený monolitní app.js (~1900 řádků) + duplicitní worker (~600 řádků) do logické struktury:

```
src/
  constants.js                — STATE_KEY, BF_SAVE_KEY, SETTINGS_KEY, MAX_THREADS, _SIDE_IDX
  optimizer/
    rotation.js                — rotateSide/rotateCoord/rotateComponent/rotatePeriShape
                                 getBounds, getUniqueDegs (+ cache)
    bus.js                     — SIDE_DELTA, OPPOSITE, computePoweredSet, findWirePath
                                 wouldConnectToComponent/Bus, wouldBePowered
    placement.js               — getOccupiedMap, hasOverlap, fitsInGrid
                                 addPeripheralReserved
    score.js                   — computeFreeSpaceQuality, computeWorkingSet, scoreLayout
    validate.js                — isLayoutValid, tryAddWires
  bruteforce/
    generator.js               — bruteForcePlacements (sdílený main + worker)
    save.js                    — bfSaveState, bfSaveStateV2, bfLoadSave, bfClearSave
                                 export/import bundle, _bfEncode/Decode, _computeBranchRanges
  ui/
    settings.js                — loadSettings/saveSettings/getThreadCount/openSettings…
```

**Výhody:**
- Žádná duplicita kódu mezi main a worker (sdílí `src/`)
- Jasné API granice
- Easy unit-testing (každý modul samostatně)
- IDE navigace + jump-to-definition

**Velký refaktor commit:** krok 7 (`generator.js`) — −862/+438 řádků (sdílený generátor odstranil dvě kopie).

### Pravidla závislostí (script load order)
1. `src/constants.js` (žádné závislosti)
2. `src/optimizer/rotation.js` (žádné závislosti)
3. `src/optimizer/bus.js` (žádné závislosti — definuje SIDE_DELTA, OPPOSITE)
4. `src/optimizer/placement.js` (závisí na bus.js: SIDE_DELTA pro addPeripheralReserved)
5. `src/optimizer/score.js` (závisí na bus.js, placement.js)
6. `src/optimizer/validate.js` (závisí na bus.js, score.js)
7. `src/bruteforce/generator.js` (závisí na všech optimizer/* + constants)
8. `src/bruteforce/save.js` (žádné optimizer závislosti, ale potřebuje state.js objekt)
9. `src/ui/settings.js` (potřebuje SETTINGS_KEY, MAX_THREADS)
10. `optimizer.js`, `renderer.js` (legacy — zbylé non-extracted funkce: scorePositionAndCompact, buildRotatedPeri, findBestPlacement, atd.)
11. `app.js` (entry point + state, init, scheduleBruteForceOpt)

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
