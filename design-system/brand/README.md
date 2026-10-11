# Brand image (B-brand1 to B-brand3)

The owner's long-tailed shrike photo, drawn in dots. Approved look: `bust-sparkle.gif` (portrait) and `emblem-sparkle.gif` (emblem). Reproduce them; don't redesign.

| File | What |
|---|---|
| `shrike.jpeg` | Source photo (515 x 388), not in the repo (see `.gitignore`). The eye is at photo px 251.5, 51 |
| `mask.png`, `mask.swift` | Bird mask from macOS Vision: `swiftc mask.swift -o /tmp/mask && /tmp/mask shrike.jpeg mask.png` |
| `generate.py` | `python3 design-system/brand/generate.py` (Pillow) writes the files below |
| `portrait.json` | B-brand1: 128 x 128 grid. `rows`: `b` bird dot, `f` field dot, space empty. `colors`: one hex `rrggbb` per bird dot in row order. `eye` in dot units, `frame` layout in GIF px at `s0` px per dot, dot radii as a share of the pitch |
| `emblem.json` | B-brand2: grids `40` and `28` columns. `rows`: `#` dot. `eye` in dot units, `braille` rows |
| `emblem-bust-40.txt`, `emblem-bust-28.txt` | The emblem as braille text (the 28 is the terminal banner) |
| `icon.py` | B-brand4: writes `apps/desktop/resources/icon.png` |

Drawn by `apps/desktop/src/renderer/src/brand/` (`ShrikeBust`, `ShrikeEmblem`); colours of the field, frame and emblem come from `tokens.ts`, the bird keeps its photo colours.
