/* Foggy Map — fog of war for uploaded map images.
 *
 * Architecture: two stacked canvases sized to the map image.
 *  - #map-canvas holds the uploaded image.
 *  - #fog-canvas holds an opaque fog layer; "revealing" erases fog pixels
 *    with destination-out compositing, "hiding" paints them back.
 * The stack is panned/zoomed with a CSS transform on #stage, so drawing
 * always happens in image-pixel coordinates.
 */
(() => {
  "use strict";

  const FOG_COLOR = "#0e1118";
  const STORAGE_KEY = "foggymap.session.v1";
  const MAX_UNDO = 20;

  // ---------- DOM ----------
  const viewport = document.getElementById("viewport");
  const stage = document.getElementById("stage");
  const mapCanvas = document.getElementById("map-canvas");
  const gridCanvas = document.getElementById("grid-canvas");
  const fogCanvas = document.getElementById("fog-canvas");
  const mapCtx = mapCanvas.getContext("2d");
  const gridCtx = gridCanvas.getContext("2d");
  const fogCtx = fogCanvas.getContext("2d");
  const tokenLayer = document.getElementById("token-layer");
  const rectPreview = document.getElementById("rect-preview");
  const brushCursor = document.getElementById("brush-cursor");
  const dropHint = document.getElementById("drop-hint");

  const fileInput = document.getElementById("file-input");
  const sessionInput = document.getElementById("session-input");
  const brushSizeInput = document.getElementById("brush-size");
  const brushSizeValue = document.getElementById("brush-size-value");
  const brushSoftInput = document.getElementById("brush-soft");
  const fogOpacityInput = document.getElementById("fog-opacity");
  const toolButtons = [...document.querySelectorAll("#tools .tool")];
  const undoBtn = document.getElementById("btn-undo");
  const redoBtn = document.getElementById("btn-redo");
  const playerViewBtn = document.getElementById("btn-player-view");
  const statusTool = document.getElementById("status-tool");
  const statusZoom = document.getElementById("status-zoom");
  const statusSave = document.getElementById("status-save");

  // ---------- State ----------
  const state = {
    hasMap: false,
    mapDataUrl: null, // original upload, kept for save/restore
    scale: 1,
    panX: 0,
    panY: 0,
    tool: "reveal",
    brushSize: 60, // diameter in image pixels
    softness: 0.5,
    playerView: false,
    fogOpacity: 0.65,
  };

  // Scene data, persisted in sessions alongside the map and fog.
  let tokens = []; // {id, x, y, size, color, label, shape, imageId}
  let images = {}; // token image library: id -> downscaled dataURL
  const imageCache = {}; // id -> decoded HTMLImageElement (for PNG export)
  let grid = defaultGrid();

  function defaultGrid() {
    return {
      enabled: false,
      cellSize: 50, // image pixels
      offsetX: 0,
      offsetY: 0,
      color: "dark",
      opacity: 0.5,
      unitsPerCell: 5,
      unitLabel: "ft",
      snap: false,
      diagRule: "euclidean", // or "dnd": diagonals count as 1 cell
    };
  }

  const undoStack = [];
  const redoStack = [];
  let autosaveTimer = null;

  // Pointer interaction state
  let panning = false;
  let stroking = false;
  let rectStart = null; // {ix, iy} image coords
  let lastStamp = null; // {ix, iy}
  let spaceHeld = false;

  const TOOL_LABELS = {
    reveal: "Reveal brush",
    hide: "Hide brush",
    "reveal-rect": "Reveal rectangle",
    "hide-rect": "Hide rectangle",
    pan: "Pan",
  };

  // ---------- View transform ----------
  function applyTransform() {
    stage.style.transform =
      `translate(${state.panX}px, ${state.panY}px) scale(${state.scale})`;
    statusZoom.textContent = `Zoom: ${Math.round(state.scale * 100)}%`;
    updateBrushCursorSize();
  }

  function screenToImage(clientX, clientY) {
    const rect = viewport.getBoundingClientRect();
    return {
      ix: (clientX - rect.left - state.panX) / state.scale,
      iy: (clientY - rect.top - state.panY) / state.scale,
    };
  }

  function zoomAt(clientX, clientY, factor) {
    const rect = viewport.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    const newScale = Math.min(16, Math.max(0.05, state.scale * factor));
    const real = newScale / state.scale;
    state.panX = mx - (mx - state.panX) * real;
    state.panY = my - (my - state.panY) * real;
    state.scale = newScale;
    applyTransform();
  }

  function fitToWindow() {
    if (!state.hasMap) return;
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    state.scale = Math.min(vw / mapCanvas.width, vh / mapCanvas.height) * 0.95;
    state.panX = (vw - mapCanvas.width * state.scale) / 2;
    state.panY = (vh - mapCanvas.height * state.scale) / 2;
    applyTransform();
  }

  // ---------- Map loading ----------
  // `session` is an optional saved-session object ({fog, grid, tokens,
  // images}); omitting it starts a fresh scene for a newly uploaded map.
  function loadMapFromDataUrl(dataUrl, session = null) {
    const img = new Image();
    img.onload = () => {
      mapCanvas.width = gridCanvas.width = fogCanvas.width = img.naturalWidth;
      mapCanvas.height = gridCanvas.height = fogCanvas.height = img.naturalHeight;
      tokenLayer.style.width = `${img.naturalWidth}px`;
      tokenLayer.style.height = `${img.naturalHeight}px`;
      mapCtx.drawImage(img, 0, 0);
      state.hasMap = true;
      state.mapDataUrl = dataUrl;
      undoStack.length = 0;
      redoStack.length = 0;
      updateUndoButtons();
      dropHint.hidden = true;

      tokens = session?.tokens || [];
      images = session?.images || {};
      grid = { ...defaultGrid(), ...(session?.grid || {}) };
      ensureImageCache();
      renderTokens();
      drawGrid();

      if (session?.fog) {
        restoreFog(session.fog).catch(() => coverAll(false));
      } else {
        coverAll(false);
      }
      fitToWindow();
      scheduleAutosave();
    };
    img.onerror = () => setStatus("⚠️ Could not read that image file.");
    img.src = dataUrl;
  }

  function handleImageFile(file) {
    if (!file || !file.type.startsWith("image/")) {
      setStatus("⚠️ Please choose an image file.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => loadMapFromDataUrl(reader.result);
    reader.readAsDataURL(file);
  }

  // ---------- Fog operations ----------
  function coverAll(withUndo = true) {
    if (!state.hasMap) return;
    if (withUndo) pushUndo("fog");
    fogCtx.globalCompositeOperation = "source-over";
    fogCtx.fillStyle = FOG_COLOR;
    fogCtx.fillRect(0, 0, fogCanvas.width, fogCanvas.height);
    fogChanged();
  }

  function revealAll() {
    if (!state.hasMap) return;
    pushUndo("fog");
    fogCtx.clearRect(0, 0, fogCanvas.width, fogCanvas.height);
    fogChanged();
  }

  function stampBrush(ix, iy, mode) {
    const r = state.brushSize / 2;
    const inner = r * (1 - state.softness);
    const grad = fogCtx.createRadialGradient(ix, iy, inner, ix, iy, r);
    if (mode === "reveal") {
      fogCtx.globalCompositeOperation = "destination-out";
      grad.addColorStop(0, "rgba(0,0,0,1)");
      grad.addColorStop(1, "rgba(0,0,0,0)");
    } else {
      fogCtx.globalCompositeOperation = "source-over";
      grad.addColorStop(0, FOG_COLOR);
      grad.addColorStop(1, FOG_COLOR + "00"); // transparent fog color
    }
    fogCtx.fillStyle = grad;
    fogCtx.beginPath();
    fogCtx.arc(ix, iy, r, 0, Math.PI * 2);
    fogCtx.fill();
  }

  function strokeTo(ix, iy, mode) {
    if (!lastStamp) {
      stampBrush(ix, iy, mode);
    } else {
      const dx = ix - lastStamp.ix;
      const dy = iy - lastStamp.iy;
      const dist = Math.hypot(dx, dy);
      const step = Math.max(1, state.brushSize * 0.15);
      for (let d = step; d <= dist; d += step) {
        stampBrush(lastStamp.ix + (dx * d) / dist, lastStamp.iy + (dy * d) / dist, mode);
      }
      stampBrush(ix, iy, mode);
    }
    lastStamp = { ix, iy };
  }

  function applyRect(a, b, mode) {
    const x = Math.min(a.ix, b.ix);
    const y = Math.min(a.iy, b.iy);
    const w = Math.abs(a.ix - b.ix);
    const h = Math.abs(a.iy - b.iy);
    if (w < 1 || h < 1) return;
    pushUndo("fog");
    if (mode === "reveal") {
      fogCtx.globalCompositeOperation = "destination-out";
      fogCtx.fillStyle = "rgba(0,0,0,1)";
    } else {
      fogCtx.globalCompositeOperation = "source-over";
      fogCtx.fillStyle = FOG_COLOR;
    }
    fogCtx.fillRect(x, y, w, h);
    fogChanged();
  }

  function fogChanged() {
    scheduleAutosave();
  }

  // ---------- Grid ----------
  function drawGrid() {
    gridCtx.clearRect(0, 0, gridCanvas.width, gridCanvas.height);
    if (!grid.enabled || grid.cellSize < 4) return;
    const cs = grid.cellSize;
    gridCtx.globalAlpha = grid.opacity;
    gridCtx.strokeStyle = grid.color === "light" ? "#ffffff" : "#000000";
    gridCtx.lineWidth = Math.max(1, cs / 60);
    gridCtx.beginPath();
    const sx = ((grid.offsetX % cs) + cs) % cs;
    const sy = ((grid.offsetY % cs) + cs) % cs;
    for (let x = sx; x <= gridCanvas.width; x += cs) {
      gridCtx.moveTo(x, 0);
      gridCtx.lineTo(x, gridCanvas.height);
    }
    for (let y = sy; y <= gridCanvas.height; y += cs) {
      gridCtx.moveTo(0, y);
      gridCtx.lineTo(gridCanvas.width, y);
    }
    gridCtx.stroke();
    gridCtx.globalAlpha = 1;
  }

  // ---------- Tokens (rendering arrives with the token feature) ----------
  function renderTokens() {}

  // ---------- Token image library ----------
  // Imported images are downscaled before storage: tokens render small, and
  // full-size photos would blow the localStorage autosave budget.
  const TOKEN_IMG_SIZE = 256;
  let idCounter = 0;

  function newId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${idCounter++}`;
  }

  function importTokenImage(file) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type.startsWith("image/")) {
        reject(new Error("not an image"));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const k = Math.min(1, TOKEN_IMG_SIZE / Math.max(img.naturalWidth, img.naturalHeight));
          const c = document.createElement("canvas");
          c.width = Math.max(1, Math.round(img.naturalWidth * k));
          c.height = Math.max(1, Math.round(img.naturalHeight * k));
          c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
          const keepAlpha = file.type === "image/png" || file.type === "image/webp";
          const id = newId("img");
          images[id] = keepAlpha
            ? c.toDataURL("image/png")
            : c.toDataURL("image/jpeg", 0.85);
          ensureImageCache();
          resolve(id);
        };
        img.onerror = reject;
        img.src = reader.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function ensureImageCache() {
    for (const [id, dataUrl] of Object.entries(images)) {
      if (!imageCache[id]) {
        const img = new Image();
        img.src = dataUrl;
        imageCache[id] = img;
      }
    }
  }

  // ---------- Undo / redo ----------
  // The stacks hold tagged snapshots of a single state slice each:
  // {type: "fog", data: dataURL} or {type: "tokens", data: JSON string}.
  // Undoing an entry restores only that slice and pushes the slice's
  // current state onto the other stack.
  function snapshot(type) {
    return type === "fog"
      ? { type, data: fogCanvas.toDataURL("image/png") }
      : { type, data: JSON.stringify(tokens) };
  }

  function pushUndoEntry(entry) {
    undoStack.push(entry);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
    updateUndoButtons();
  }

  function pushUndo(type) {
    pushUndoEntry(snapshot(type));
  }

  function applySnapshot(entry) {
    if (entry.type === "fog") {
      restoreFog(entry.data).then(fogChanged);
    } else {
      tokens = JSON.parse(entry.data);
      renderTokens();
      scheduleAutosave();
    }
  }

  function restoreFog(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        fogCtx.globalCompositeOperation = "source-over";
        fogCtx.clearRect(0, 0, fogCanvas.width, fogCanvas.height);
        fogCtx.drawImage(img, 0, 0);
        resolve();
      };
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  function undo() {
    if (!undoStack.length) return;
    const entry = undoStack.pop();
    redoStack.push(snapshot(entry.type));
    applySnapshot(entry);
    updateUndoButtons();
  }

  function redo() {
    if (!redoStack.length) return;
    const entry = redoStack.pop();
    undoStack.push(snapshot(entry.type));
    applySnapshot(entry);
    updateUndoButtons();
  }

  function updateUndoButtons() {
    undoBtn.disabled = undoStack.length === 0;
    redoBtn.disabled = redoStack.length === 0;
  }

  // ---------- Persistence ----------
  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(autosave, 800);
  }

  // Version 2 adds grid, tokens and the token image library; version 1
  // files (map + fog only) still load, with the new fields defaulted.
  function sessionData() {
    return {
      app: "foggymap",
      version: 2,
      map: state.mapDataUrl,
      fog: fogCanvas.toDataURL("image/png"),
      grid,
      tokens,
      images,
    };
  }

  function autosave() {
    if (!state.hasMap) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sessionData()));
      setStatus("Autosaved ✓");
    } catch (err) {
      setStatus("⚠️ Map too large for browser autosave — use 💾 Save instead.");
    }
  }

  function tryRestoreSession() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (!data.map) return false;
      loadMapFromDataUrl(data.map, data);
      setStatus("Restored previous session.");
      return true;
    } catch {
      return false;
    }
  }

  function saveSessionFile() {
    if (!state.hasMap) return;
    const blob = new Blob([JSON.stringify(sessionData())], {
      type: "application/json",
    });
    downloadBlob(blob, `foggymap-session-${timestamp()}.json`);
    setStatus("Session saved 💾");
  }

  function loadSessionFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (data.app !== "foggymap" || !data.map) throw new Error("bad file");
        loadMapFromDataUrl(data.map, data);
        setStatus("Session loaded 📥");
      } catch {
        setStatus("⚠️ Not a valid Foggy Map session file.");
      }
    };
    reader.readAsText(file);
  }

  function exportPlayerPng() {
    if (!state.hasMap) return;
    const out = document.createElement("canvas");
    out.width = mapCanvas.width;
    out.height = mapCanvas.height;
    const ctx = out.getContext("2d");
    ctx.drawImage(mapCanvas, 0, 0);
    ctx.drawImage(fogCanvas, 0, 0); // fog at full opacity = what players see
    out.toBlob((blob) => {
      downloadBlob(blob, `foggymap-player-view-${timestamp()}.png`);
      setStatus("Player view exported 🖼️");
    }, "image/png");
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function timestamp() {
    return new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  }

  // ---------- UI helpers ----------
  function setStatus(msg) {
    statusSave.textContent = msg;
  }

  function setTool(tool) {
    state.tool = tool;
    toolButtons.forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
    statusTool.textContent = `Tool: ${TOOL_LABELS[tool]}`;
    updateViewportCursor();
  }

  function updateViewportCursor() {
    const effectivePan = state.tool === "pan" || spaceHeld;
    viewport.classList.toggle("tool-pan", effectivePan);
    viewport.classList.toggle(
      "tool-brush",
      !effectivePan && (state.tool === "reveal" || state.tool === "hide")
    );
    viewport.classList.toggle(
      "tool-rect",
      !effectivePan && state.tool.endsWith("-rect")
    );
    brushCursor.hidden = effectivePan || !state.tool.match(/^(reveal|hide)$/) || !state.hasMap;
  }

  function updateBrushCursorSize() {
    const d = state.brushSize * state.scale;
    brushCursor.style.width = `${d}px`;
    brushCursor.style.height = `${d}px`;
    brushCursor.classList.toggle("hide-mode", state.tool === "hide");
  }

  function moveBrushCursor(clientX, clientY) {
    const rect = viewport.getBoundingClientRect();
    brushCursor.style.left = `${clientX - rect.left}px`;
    brushCursor.style.top = `${clientY - rect.top}px`;
  }

  function updateFogOpacity() {
    fogCanvas.style.opacity = state.playerView ? 1 : state.fogOpacity;
  }

  function setBrushSize(size) {
    state.brushSize = Math.min(300, Math.max(5, size));
    brushSizeInput.value = state.brushSize;
    brushSizeValue.textContent = state.brushSize;
    updateBrushCursorSize();
  }

  // ---------- Pointer events ----------
  viewport.addEventListener("pointerdown", (e) => {
    if (e.target.closest("#drop-hint")) return;
    const wantsPan =
      e.button === 1 || spaceHeld || state.tool === "pan";

    if (wantsPan) {
      panning = true;
      viewport.classList.add("panning");
      viewport.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }

    if (e.button !== 0 || !state.hasMap) return;
    viewport.setPointerCapture(e.pointerId);
    const p = screenToImage(e.clientX, e.clientY);

    if (state.tool === "reveal" || state.tool === "hide") {
      pushUndo("fog");
      stroking = true;
      lastStamp = null;
      strokeTo(p.ix, p.iy, state.tool);
    } else if (state.tool.endsWith("-rect")) {
      rectStart = p;
      rectPreview.classList.toggle("hide-mode", state.tool === "hide-rect");
      updateRectPreview(p, p);
      rectPreview.hidden = false;
    }
  });

  viewport.addEventListener("pointermove", (e) => {
    moveBrushCursor(e.clientX, e.clientY);

    if (panning) {
      state.panX += e.movementX;
      state.panY += e.movementY;
      applyTransform();
      return;
    }

    const p = screenToImage(e.clientX, e.clientY);
    if (stroking) {
      strokeTo(p.ix, p.iy, state.tool);
    } else if (rectStart) {
      updateRectPreview(rectStart, p);
    }
  });

  function endPointer(e) {
    if (panning) {
      panning = false;
      viewport.classList.remove("panning");
    }
    if (stroking) {
      stroking = false;
      lastStamp = null;
      fogChanged();
    }
    if (rectStart) {
      const p = screenToImage(e.clientX, e.clientY);
      applyRect(rectStart, p, state.tool === "reveal-rect" ? "reveal" : "hide");
      rectStart = null;
      rectPreview.hidden = true;
    }
  }

  viewport.addEventListener("pointerup", endPointer);
  viewport.addEventListener("pointercancel", endPointer);
  viewport.addEventListener("pointerleave", () => {
    if (!stroking && !panning && !rectStart) brushCursor.hidden = true;
  });
  viewport.addEventListener("pointerenter", updateViewportCursor);

  function updateRectPreview(a, b) {
    const rect = viewport.getBoundingClientRect();
    const x1 = a.ix * state.scale + state.panX;
    const y1 = a.iy * state.scale + state.panY;
    const x2 = b.ix * state.scale + state.panX;
    const y2 = b.iy * state.scale + state.panY;
    rectPreview.style.left = `${Math.min(x1, x2)}px`;
    rectPreview.style.top = `${Math.min(y1, y2)}px`;
    rectPreview.style.width = `${Math.abs(x2 - x1)}px`;
    rectPreview.style.height = `${Math.abs(y2 - y1)}px`;
  }

  viewport.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 1 / 1.1);
  }, { passive: false });

  // ---------- Drag & drop / paste ----------
  ["dragenter", "dragover"].forEach((ev) =>
    viewport.addEventListener(ev, (e) => {
      e.preventDefault();
      viewport.classList.add("drag-over");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    viewport.addEventListener(ev, (e) => {
      e.preventDefault();
      viewport.classList.remove("drag-over");
    })
  );
  viewport.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files?.[0];
    if (file) handleImageFile(file);
  });

  document.addEventListener("paste", (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) =>
      i.type.startsWith("image/")
    );
    if (item) handleImageFile(item.getAsFile());
  });

  // ---------- Toolbar wiring ----------
  document.getElementById("btn-upload").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    handleImageFile(fileInput.files[0]);
    fileInput.value = "";
  });

  toolButtons.forEach((b) =>
    b.addEventListener("click", () => setTool(b.dataset.tool))
  );

  brushSizeInput.addEventListener("input", () => setBrushSize(+brushSizeInput.value));
  brushSoftInput.addEventListener("input", () => {
    state.softness = +brushSoftInput.value / 100;
  });

  fogOpacityInput.addEventListener("input", () => {
    state.fogOpacity = +fogOpacityInput.value / 100;
    updateFogOpacity();
  });

  playerViewBtn.addEventListener("click", () => {
    state.playerView = !state.playerView;
    playerViewBtn.classList.toggle("on", state.playerView);
    updateFogOpacity();
  });

  undoBtn.addEventListener("click", undo);
  redoBtn.addEventListener("click", redo);
  document.getElementById("btn-cover-all").addEventListener("click", () => coverAll(true));
  document.getElementById("btn-reveal-all").addEventListener("click", revealAll);

  document.getElementById("btn-zoom-in").addEventListener("click", () => {
    const r = viewport.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.25);
  });
  document.getElementById("btn-zoom-out").addEventListener("click", () => {
    const r = viewport.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / 1.25);
  });
  document.getElementById("btn-zoom-fit").addEventListener("click", fitToWindow);

  document.getElementById("btn-save-session").addEventListener("click", saveSessionFile);
  document.getElementById("btn-load-session").addEventListener("click", () => sessionInput.click());
  sessionInput.addEventListener("change", () => {
    if (sessionInput.files[0]) loadSessionFile(sessionInput.files[0]);
    sessionInput.value = "";
  });
  document.getElementById("btn-export-png").addEventListener("click", exportPlayerPng);

  // ---------- Keyboard shortcuts ----------
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea")) return;

    if (e.code === "Space") {
      if (!spaceHeld) {
        spaceHeld = true;
        updateViewportCursor();
      }
      e.preventDefault();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
      e.preventDefault();
      redo();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    switch (e.key.toLowerCase()) {
      case "b": setTool("reveal"); break;
      case "h": setTool("hide"); break;
      case "r": setTool("reveal-rect"); break;
      case "t": setTool("hide-rect"); break;
      case "p": setTool("pan"); break;
      case "v": playerViewBtn.click(); break;
      case "o": fileInput.click(); break;
      case "0": fitToWindow(); break;
      case "+": case "=":
        document.getElementById("btn-zoom-in").click(); break;
      case "-":
        document.getElementById("btn-zoom-out").click(); break;
      case "[": setBrushSize(state.brushSize - 10); break;
      case "]": setBrushSize(state.brushSize + 10); break;
    }
  });

  document.addEventListener("keyup", (e) => {
    if (e.code === "Space") {
      spaceHeld = false;
      updateViewportCursor();
    }
  });

  window.addEventListener("resize", () => {
    // Keep the map sensibly in view on window resize when not zoomed in.
    if (state.hasMap && state.scale <= 1) fitToWindow();
  });

  // ---------- Init ----------
  setTool("reveal");
  updateFogOpacity();
  updateUndoButtons();
  tryRestoreSession();
})();
