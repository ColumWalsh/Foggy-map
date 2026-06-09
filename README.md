# 🌫️ Foggy Map

A fog-of-war web app for tabletop game masters. Upload any map image, cover it
in fog, and selectively reveal areas as your players explore.

No build step, no server, no dependencies — just open `index.html` in a
browser (or serve the folder statically).

## Running it

```sh
# Option 1: open the file directly
open index.html        # macOS
xdg-open index.html    # Linux

# Option 2: serve it
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Features

- **Upload a map** via the 📂 button, drag-and-drop, or paste from clipboard.
  The map starts fully covered in fog.
- **Reveal / hide brushes** with adjustable size and edge softness.
- **Rectangle tools** to reveal or re-fog rectangular areas.
- **Pan & zoom** — mouse wheel to zoom, middle-drag / hold Space / Pan tool to
  move around.
- **GM vs. player view** — as the GM you see through the fog at adjustable
  opacity; toggle 🎭 Player view to see the fully opaque fog your players
  would see.
- **Grid overlay** (G) with one-drag calibration: drag a box along the map's
  printed grid and the cell size and offsets are derived automatically. The
  grid renders under the fog, so fogged areas reveal nothing. Settings cover
  line color/opacity, distance per cell (e.g. 1 cell = 5 ft), and the
  diagonal rule (Euclidean or D&D 5e).
- **Measure tool** (M) — drag to get a live distance readout in cells and
  scaled units.
- **Tokens** (N) — movable player/monster markers. Colored circles or squares
  with automatic initials, or **custom images**: set a portrait from a file,
  drop an image straight onto a token, or reuse one from the session's image
  library (images are downscaled on import so storage stays small). Tokens
  drag with any tool active, optionally snap to grid cells, and show a live
  distance readout while dragging.
- **Undo / redo** (Ctrl+Z / Ctrl+Y) covering both fog edits and token
  changes, plus one-click Cover all / Reveal all.
- **Autosave** — map, fog, grid, and tokens are saved to the browser's
  localStorage and restored when you return (very large maps may exceed the
  browser's storage quota; use 💾 Save instead).
- **Save / load session files** — download a portable `.json` session
  containing the map, fog, grid, and tokens, and load it on any machine.
  Files from older versions still load.
- **Export PNG** of the player view (map with grid, opaque fog, and tokens
  baked in).

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `B` | Reveal brush |
| `H` | Hide brush |
| `R` | Reveal rectangle |
| `T` | Hide rectangle |
| `P` | Pan tool (or hold `Space`, or middle mouse drag) |
| `M` | Measure tool |
| `G` | Toggle grid overlay |
| `N` | Add a token |
| `Delete` / `Backspace` | Delete the selected token |
| `Esc` | Deselect token / cancel grid calibration |
| `V` | Toggle player view |
| `O` | Open map image |
| `[` / `]` | Decrease / increase brush size |
| `+` / `-` / `0` | Zoom in / out / fit to window |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo |

## How it works

Stacked layers sized to the image: the map canvas at the bottom, the grid
canvas above it, the opaque fog canvas above that, and a DOM layer for
tokens on top. Revealing erases fog pixels using `destination-out`
compositing with a radial-gradient brush; hiding paints the fog back. Pan and
zoom are a CSS transform on the whole stack, so all drawing and token
positions live in image-pixel coordinates regardless of view state. Tokens
are plain DOM elements (dragging, hit-testing, and image cropping come free
from the browser); custom token images are downscaled to 256px on import and
stored once in a per-session library that tokens reference by id.
