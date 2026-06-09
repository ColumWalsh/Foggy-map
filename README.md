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
- **Undo / redo** (Ctrl+Z / Ctrl+Y), plus one-click Cover all / Reveal all.
- **Autosave** — your map and fog state are saved to the browser's
  localStorage and restored when you return (very large maps may exceed the
  browser's storage quota; use 💾 Save instead).
- **Save / load session files** — download a portable `.json` session
  containing the map and fog, and load it on any machine.
- **Export PNG** of the player view (map with opaque fog baked in).

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `B` | Reveal brush |
| `H` | Hide brush |
| `R` | Reveal rectangle |
| `T` | Hide rectangle |
| `P` | Pan tool (or hold `Space`, or middle mouse drag) |
| `V` | Toggle player view |
| `O` | Open map image |
| `[` / `]` | Decrease / increase brush size |
| `+` / `-` / `0` | Zoom in / out / fit to window |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo |

## How it works

Two stacked `<canvas>` elements sized to the image: the map below, an opaque
fog layer above. Revealing erases fog pixels using `destination-out`
compositing with a radial-gradient brush; hiding paints the fog back. Pan and
zoom are a CSS transform on the canvas stack, so all drawing happens in
image-pixel coordinates regardless of view state.
