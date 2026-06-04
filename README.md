# Idle Directive – Body Optimizer

Web aplikace pro optimalizaci rozmístění součástek na tělovém gridu.

**URL:** `https://idle-directive.zdendys79.website`  
**Soubory:** `/var/www/html/idle_directive/`

---

## Architektura

| Soubor | Role |
|---|---|
| `index.html` | HTML kostra, načítá skripty s cache busterem `?v=XX` |
| `components.json` | Definice všech součástek (tvar, porty, barvy) — AUTORITATIVNÍ, neupravovat! |
| `optimizer.js` | Logika rozmísťování: rotace, výpočet napájení, hard constraints |
| `app.js` | UI, state management, background optimizer |
| `renderer.js` | SVG renderer gridu |
| `styles.css` | CSS |

---

## Klíčové koncepty

### Souřadnicový systém
Grid `rows × cols`, (0,0) = levý horní roh.  
**Bus:** levý sloupec (W porty na col=0) a dolní řádek (S porty na row=rows-1).

### Napájení (computePoweredSet)
BFS z busů přes port-na-port spojení. Port A side → sousední buňka → port B OPPOSITE(side).

### Funkčnost Spinneru (computeWorkingSet)
Spinner je funkční, pokud:
- má sousedící repeater_2s na jakékoli straně, NEBO
- má sousedící repeater_4s na 2 různých stranách.

Pulser: Repeatery jsou volitelné.

### Hard constraints v findBestPlacement
1. **Spinner**: musí mít volné sousední buňky pro čekající Repeatery (z pendingIds).
2. **Repeater**: pokud existuje nefunkční Spinner, Repeater se k němu MUSÍ připojit.

### Pořadí komponent (Rep → Spin)
ensureComponentOrder: ostatní → Repeater → Spinner → Repeater → Spinner → bio-only.  
Repeater jde vždy PŘED Spinnerem — Spinner pak využije energyBonus a připojí se
k napájenému Repeateru. Tím vzniká řetěz Rep→Spin→Rep→Spin přirozeně.

### Background optimizer (scheduleBackgroundOpt)
- N ≤ 7 komponent: zkouší všechna N! pořadí
- N > 7: 800 náhodných pořadí (generateClusterOrdering) + 1× ensureComponentOrder
- Každé pořadí projde isLayoutValid — neplatné zahazuje
- Nejlepší validní výsledek nabídne uživateli přes banner

### isLayoutValid
Layout je platný pokud:
- každá energetická komponenta je napájená
- každý Spinner je funkční (pokud v layoutu existují Repeatery)

---

## Cache buster

Po každé změně optimizer.js nebo app.js je nutné zvýšit verzi v index.html.
Aktuální verze: v=22

---

## Pravidla pro vývoj

- components.json je autoritativní — NIKDY neupravovat porty, tvar ani barvy bez výslovného požadavku
- Debugování connectivity: hledej chybu v ORDER nebo SCORING v optimizer.js, ne v definicích portů
- Validace layoutu: hard constraints v isLayoutValid, ne scoring triky
- Žádné umělé cluster systémy — správné uspořádání vznikne přirozeně ze správných constraints
