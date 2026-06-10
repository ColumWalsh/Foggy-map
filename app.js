/* Foggy Map — fog of war for uploaded map images.
 *
 * Architecture: stacked layers sized to the map image.
 *  - #map-canvas holds the uploaded image.
 *  - #grid-canvas draws the distance grid (under the fog, so fogged areas
 *    reveal nothing).
 *  - #fog-canvas holds an opaque fog layer; "revealing" erases fog pixels
 *    with destination-out compositing, "hiding" paints them back.
 *  - #token-layer holds tokens as DOM elements (drag, hit-testing, and
 *    image cropping come free from the browser).
 * The stack is panned/zoomed with a CSS transform on #stage, so drawing and
 * token positions always live in image-pixel coordinates.
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

  const overlayCanvas = document.getElementById("overlay-canvas");
  const overlayCtx = overlayCanvas.getContext("2d");
  const measureLabel = document.getElementById("measure-label");
  const gridBtn = document.getElementById("btn-grid");
  const gridPanel = document.getElementById("grid-panel");
  const calibrateBtn = document.getElementById("btn-calibrate");
  const calCellsInput = document.getElementById("cal-cells");
  const gridSizeInput = document.getElementById("grid-size");
  const gridOffXInput = document.getElementById("grid-off-x");
  const gridOffYInput = document.getElementById("grid-off-y");
  const gridColorInput = document.getElementById("grid-color");
  const gridAlphaInput = document.getElementById("grid-alpha");
  const gridUnitsInput = document.getElementById("grid-units");
  const gridUnitLabelInput = document.getElementById("grid-unit-label");
  const gridDiagInput = document.getElementById("grid-diag");
  const gridSnapInput = document.getElementById("grid-snap");

  const tokenPanel = document.getElementById("token-panel");
  const tokenLabelInput = document.getElementById("token-label");
  const tokenColorsDiv = document.getElementById("token-colors");
  const tokenSizeInput = document.getElementById("token-size");
  const tokenShapeInput = document.getElementById("token-shape");
  const tokenImageInput = document.getElementById("token-image-input");
  const imageLibraryDiv = document.getElementById("image-library");

  const sharePanel = document.getElementById("share-panel");
  const shareOffDiv = document.getElementById("share-off");
  const shareOnDiv = document.getElementById("share-on");
  const shareCodeEl = document.getElementById("share-code");
  const shareLinkInput = document.getElementById("share-link");
  const shareViewersEl = document.getElementById("share-viewers");
  const shareErrorEl = document.getElementById("share-error");

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
  let measureStart = null; // {ix, iy}
  let toolBeforeCalibrate = null;

  const TOOL_LABELS = {
    reveal: "Reveal brush",
    hide: "Hide brush",
    "reveal-rect": "Reveal rectangle",
    "hide-rect": "Hide rectangle",
    pan: "Pan",
    measure: "Measure",
    calibrate: "Calibrate grid — drag a box along the map's grid",
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

  function imageToScreen(ix, iy) {
    return {
      x: ix * state.scale + state.panX,
      y: iy * state.scale + state.panY,
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
      syncGridUI();
      drawGrid();

      const fogReady = session?.fog
        ? restoreFog(session.fog).catch(() => coverAll(false))
        : Promise.resolve(coverAll(false));
      fogReady.then(() => {
        fitToWindow();
        scheduleAutosave();
        broadcastSnapshot(); // viewers get the new map + fog in one message
      });
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
    broadcast({ t: "fill", mode: "hide" });
    fogChanged();
  }

  function revealAll() {
    if (!state.hasMap) return;
    pushUndo("fog");
    fogCtx.clearRect(0, 0, fogCanvas.width, fogCanvas.height);
    broadcast({ t: "fill", mode: "reveal" });
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
    queueStamp(ix, iy, mode);
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
    broadcast({ t: "rect", mode, x, y, w, h });
    fogChanged();
  }

  function fogChanged() {
    updateTokenFogVisibility();
    scheduleAutosave();
  }

  // ---------- Token visibility under fog ----------
  // Players shouldn't see tokens standing in unrevealed areas. A token is
  // "fogged" when the fog is still opaque at its center.
  const FOG_HIDE_ALPHA = 128;

  function fogAlphaAt(x, y) {
    const cx = Math.max(0, Math.min(fogCanvas.width - 1, Math.round(x)));
    const cy = Math.max(0, Math.min(fogCanvas.height - 1, Math.round(y)));
    return fogCtx.getImageData(cx, cy, 1, 1).data[3];
  }

  function tokenFogged(t) {
    return fogAlphaAt(t.x, t.y) > FOG_HIDE_ALPHA;
  }

  function updateTokenFogVisibility() {
    for (const t of tokens) {
      const el = tokenLayer.querySelector(`[data-id="${t.id}"]`);
      if (el) el.classList.toggle("fogged", state.playerView && tokenFogged(t));
    }
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

  function gridChanged() {
    drawGrid();
    scheduleAutosave();
  }

  function syncGridUI() {
    gridBtn.classList.toggle("on", grid.enabled);
    gridSizeInput.value = grid.cellSize;
    gridOffXInput.value = Math.round(grid.offsetX * 10) / 10;
    gridOffYInput.value = Math.round(grid.offsetY * 10) / 10;
    gridColorInput.value = grid.color;
    gridAlphaInput.value = Math.round(grid.opacity * 100);
    gridUnitsInput.value = grid.unitsPerCell;
    gridUnitLabelInput.value = grid.unitLabel;
    gridDiagInput.value = grid.diagRule;
    gridSnapInput.checked = grid.snap;
  }

  function applyCalibration(a, b) {
    const w = Math.abs(a.ix - b.ix);
    const h = Math.abs(a.iy - b.iy);
    const n = Math.max(1, Math.round(+calCellsInput.value) || 1);
    // Average both axes when the drag is a real box; a thin drag along one
    // row/column of cells calibrates from its long side only.
    const cs = (w > 8 && h > 8 ? (w + h) / 2 : Math.max(w, h)) / n;
    if (!isFinite(cs) || cs < 4) {
      setStatus("⚠️ Drag a bigger box to calibrate the grid.");
      return;
    }
    grid.cellSize = Math.round(cs * 100) / 100;
    grid.offsetX = Math.round((((Math.min(a.ix, b.ix) % cs) + cs) % cs) * 10) / 10;
    grid.offsetY = Math.round((((Math.min(a.iy, b.iy) % cs) + cs) % cs) * 10) / 10;
    grid.enabled = true;
    syncGridUI();
    gridChanged();
    setTool(toolBeforeCalibrate || "reveal");
    setStatus(`Grid calibrated: ${grid.cellSize}px per cell ✓`);
  }

  // ---------- Measuring ----------
  function sizeOverlay() {
    if (overlayCanvas.width !== viewport.clientWidth ||
        overlayCanvas.height !== viewport.clientHeight) {
      overlayCanvas.width = viewport.clientWidth;
      overlayCanvas.height = viewport.clientHeight;
    }
  }

  function clearOverlay() {
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    measureLabel.hidden = true;
  }

  function formatDistance(dxPx, dyPx) {
    const cells =
      grid.diagRule === "dnd"
        ? Math.max(Math.abs(dxPx), Math.abs(dyPx)) / grid.cellSize
        : Math.hypot(dxPx, dyPx) / grid.cellSize;
    const units = Math.round(cells * grid.unitsPerCell * 10) / 10;
    return `${cells.toFixed(1)} cells · ${units} ${grid.unitLabel}`;
  }

  function drawMeasureLine(fromImg, toImg) {
    sizeOverlay();
    const a = imageToScreen(fromImg.ix, fromImg.iy);
    const b = imageToScreen(toImg.ix, toImg.iy);
    const ctx = overlayCtx;
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    ctx.strokeStyle = "#5b8cff";
    ctx.fillStyle = "#5b8cff";
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const p of [a, b]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    measureLabel.textContent = formatDistance(toImg.ix - fromImg.ix, toImg.iy - fromImg.iy);
    measureLabel.style.left = `${b.x + 16}px`;
    measureLabel.style.top = `${b.y + 16}px`;
    measureLabel.hidden = false;
  }

  // ---------- Tokens ----------
  const PALETTE = [
    "#e74c3c", "#e67e22", "#f1c40f", "#2ecc71", "#1abc9c",
    "#3498db", "#9b59b6", "#e84393", "#95a5a6", "#34495e",
  ];

  let selectedTokenId = null;
  let tokenDrag = null; // {id, startIx, startIy, origX, origY, moved, before}
  // Selection (click) and the inspector panel (double-click) are separate:
  // a single click/tap only selects, so quick moves don't pop the panel up.
  let tokenPanelOpen = false;
  let lastTokenTap = { id: null, time: 0 };

  function selectedToken() {
    return tokens.find((t) => t.id === selectedTokenId) || null;
  }

  let tokenRenderPending = false;

  function renderTokens() {
    // Rebuilding the layer mid-drag would destroy the captured element
    // (a player message can land while the GM is dragging); defer it.
    if (tokenDrag) {
      tokenRenderPending = true;
      return;
    }
    tokenRenderPending = false;
    tokenLayer.innerHTML = "";
    for (const t of tokens) {
      const el = document.createElement("div");
      el.className = "token";
      el.dataset.id = t.id;
      if (t.shape === "square") el.classList.add("square");
      if (t.id === selectedTokenId) el.classList.add("selected");
      if (state.playerView && tokenFogged(t)) el.classList.add("fogged");
      positionTokenEl(t, el);
      el.style.setProperty("--token-color", t.color);
      el.style.borderWidth = `${Math.max(2, t.size * 0.06)}px`;
      el.title = `${t.label} — double-click to edit`;
      const src = tokenImageSrc(t.imageId);
      if (src) {
        el.style.backgroundImage = `url("${src}")`;
      } else {
        const span = document.createElement("span");
        span.textContent = initials(t.label);
        span.style.fontSize = `${t.size * 0.36}px`;
        el.appendChild(span);
      }
      tokenLayer.appendChild(el);
    }
  }

  function positionTokenEl(t, el = tokenLayer.querySelector(`[data-id="${t.id}"]`)) {
    if (!el) return;
    el.style.left = `${t.x - t.size / 2}px`;
    el.style.top = `${t.y - t.size / 2}px`;
    el.style.width = el.style.height = `${t.size}px`;
  }

  function initials(label) {
    const words = (label || "").trim().split(/\s+/).filter(Boolean);
    if (!words.length) return "?";
    return words.length === 1
      ? words[0].slice(0, 2)
      : words[0][0] + words[1][0];
  }

  function selectToken(id) {
    selectedTokenId = id;
    renderTokens();
    updateTokenPanel();
  }

  // Re-render tokens and refresh the inspector after a discrete change.
  function tokenChanged() {
    renderTokens();
    updateTokenPanel();
    scheduleAutosave();
  }

  function updateTokenPanel() {
    const t = selectedToken();
    if (!t) tokenPanelOpen = false;
    tokenPanel.hidden = !t || !tokenPanelOpen;
    if (tokenPanel.hidden) return;
    gridPanel.hidden = true;
    sharePanel.hidden = true;
    tokenLabelInput.value = t.label;
    tokenSizeInput.value = t.size;
    tokenShapeInput.value = t.shape;

    tokenColorsDiv.innerHTML = "";
    for (const c of PALETTE) {
      const s = document.createElement("div");
      s.className = "swatch" + (c === t.color ? " active" : "");
      s.style.background = c;
      s.title = "Token color";
      s.addEventListener("click", () => {
        pushUndo("tokens");
        t.color = c;
        tokenChanged();
      });
      tokenColorsDiv.appendChild(s);
    }

    imageLibraryDiv.innerHTML = "";
    const addThumb = (id, src, title) => {
      const im = document.createElement("img");
      im.className = "lib-thumb" + (id === t.imageId ? " active" : "");
      im.src = src;
      im.title = title;
      im.addEventListener("click", () => {
        pushUndo("tokens");
        t.imageId = id;
        tokenChanged();
      });
      imageLibraryDiv.appendChild(im);
    };
    for (const f of builtinTokens) {
      addThumb("builtin:" + f, "tokens/" + f, f.replace(/\.[^.]+$/, ""));
    }
    for (const [id, dataUrl] of Object.entries(images)) {
      addThumb(id, dataUrl, "Session image");
    }
  }

  function addToken() {
    if (!state.hasMap) return;
    pushUndo("tokens");
    const r = viewport.getBoundingClientRect();
    const p = screenToImage(r.left + r.width / 2, r.top + r.height / 2);
    const size = grid.enabled
      ? grid.cellSize
      : Math.max(24, Math.round(Math.min(mapCanvas.width, mapCanvas.height) / 20));
    const t = {
      id: newId("t"),
      x: Math.min(Math.max(p.ix, 0), mapCanvas.width),
      y: Math.min(Math.max(p.iy, 0), mapCanvas.height),
      size,
      color: PALETTE[tokens.length % PALETTE.length],
      label: `Token ${String.fromCharCode(65 + (tokens.length % 26))}`,
      shape: "circle",
      imageId: null,
    };
    snapToken(t);
    tokens.push(t);
    tokenPanelOpen = true; // a fresh token usually wants a name straight away
    selectToken(t.id);
    scheduleAutosave();
  }

  function deleteSelectedToken() {
    if (!selectedToken()) return;
    pushUndo("tokens");
    tokens = tokens.filter((t) => t.id !== selectedTokenId);
    selectToken(null);
    scheduleAutosave();
  }

  function duplicateSelectedToken() {
    const t = selectedToken();
    if (!t) return;
    pushUndo("tokens");
    const copy = { ...t, id: newId("t"), x: t.x + t.size * 1.15, y: t.y };
    tokens.push(copy);
    selectToken(copy.id);
    scheduleAutosave();
  }

  // Token dragging works regardless of the active tool: handlers live on the
  // token layer and stop propagation so the brush underneath doesn't paint.
  tokenLayer.addEventListener("pointerdown", (e) => {
    const el = e.target.closest(".token");
    if (!el || e.button !== 0) return;
    e.stopPropagation();
    const t = tokens.find((tk) => tk.id === el.dataset.id);
    if (!t) return;
    const before = JSON.stringify(tokens);
    selectToken(t.id);
    // Double-click / double-tap opens the inspector (dblclick is unreliable
    // on mobile, so detect it from successive pointerdowns ourselves).
    const now = performance.now();
    if (lastTokenTap.id === t.id && now - lastTokenTap.time < 350) {
      tokenPanelOpen = true;
      updateTokenPanel();
    }
    lastTokenTap = { id: t.id, time: now };
    // selectToken re-rendered the layer; capture on the fresh element
    const liveEl = tokenLayer.querySelector(`[data-id="${t.id}"]`);
    const p = screenToImage(e.clientX, e.clientY);
    tokenDrag = {
      id: t.id,
      startIx: p.ix,
      startIy: p.iy,
      origX: t.x,
      origY: t.y,
      moved: false,
      before,
    };
    liveEl.setPointerCapture(e.pointerId);
    liveEl.classList.add("dragging");
  });

  tokenLayer.addEventListener("pointermove", (e) => {
    if (!tokenDrag) return;
    const t = tokens.find((tk) => tk.id === tokenDrag.id);
    if (!t) {
      tokenDrag = null;
      return;
    }
    const p = screenToImage(e.clientX, e.clientY);
    if (!tokenDrag.moved) {
      const screenDist = Math.hypot(
        (p.ix - tokenDrag.startIx) * state.scale,
        (p.iy - tokenDrag.startIy) * state.scale
      );
      if (screenDist < 4) return; // click, not a drag: no undo entry yet
      tokenDrag.moved = true;
      pushUndoEntry({ type: "tokens", data: tokenDrag.before });
    }
    t.x = tokenDrag.origX + (p.ix - tokenDrag.startIx);
    t.y = tokenDrag.origY + (p.iy - tokenDrag.startIy);
    positionTokenEl(t);
    scheduleShareSync(); // viewers see the token move live
    // Live movement readout from the drag origin, same as the measure tool.
    drawMeasureLine(
      { ix: tokenDrag.origX, iy: tokenDrag.origY },
      { ix: t.x, iy: t.y }
    );
  });

  // Snap a token's center to the center of the grid cell containing it.
  function snapToken(t) {
    if (!grid.snap || !grid.enabled) return;
    const cs = grid.cellSize;
    t.x = grid.offsetX + (Math.floor((t.x - grid.offsetX) / cs) + 0.5) * cs;
    t.y = grid.offsetY + (Math.floor((t.y - grid.offsetY) / cs) + 0.5) * cs;
  }

  function endTokenDrag() {
    if (!tokenDrag) return;
    const t = tokens.find((tk) => tk.id === tokenDrag.id);
    tokenLayer.querySelector(`[data-id="${tokenDrag.id}"]`)?.classList.remove("dragging");
    if (tokenDrag.moved && t) {
      snapToken(t);
      positionTokenEl(t);
      updateTokenFogVisibility();
      scheduleAutosave();
    }
    tokenDrag = null;
    clearOverlay();
    if (tokenRenderPending) renderTokens();
  }

  tokenLayer.addEventListener("pointerup", endTokenDrag);
  tokenLayer.addEventListener("pointercancel", endTokenDrag);

  // ---------- Token image library ----------
  // Two kinds of token images:
  //  - session uploads: downscaled dataURLs in `images`, persisted in saves
  //  - built-ins: files committed to tokens/ in the repo, referenced as
  //    "builtin:<file>" and resolved to a same-origin URL — they cost
  //    nothing in localStorage and ship with the site on every device.
  let builtinTokens = []; // filenames from tokens/manifest.json

  function tokenImageSrc(imageId) {
    if (!imageId) return null;
    if (imageId.startsWith("builtin:")) return "tokens/" + imageId.slice(8);
    return images[imageId] || null;
  }

  function loadBuiltinTokens() {
    fetch("tokens/manifest.json")
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => {
        if (!Array.isArray(list)) return;
        builtinTokens = list.filter((f) => typeof f === "string");
        for (const f of builtinTokens) {
          const img = new Image();
          img.src = "tokens/" + f; // pre-decode for PNG export
          imageCache["builtin:" + f] = img;
        }
        updateTokenPanel();
      })
      .catch(() => {}); // e.g. file:// — built-ins simply don't appear
  }

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
          broadcast({ t: "image", id, data: images[id] });
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
      restoreFog(entry.data).then(() => {
        broadcast({ t: "fog", data: entry.data });
        fogChanged();
      });
    } else {
      tokens = JSON.parse(entry.data);
      renderTokens();
      updateTokenPanel(); // the selected token may have changed or vanished
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

  // ---------- Live share (PeerJS) ----------
  // The GM hosts a room (peer id "foggymap-<CODE>"); player.html connects
  // and receives a full snapshot, then streamed updates:
  //   snapshot {map, fog, grid, tokens, images, edits}  on join / map change
  //   stamps   {mode, size, soft, pts}                  batched brush stamps
  //   rect     {mode, x, y, w, h}                       rectangle fog ops
  //   fill     {mode}                                   cover all / reveal all
  //   fog      {data}                                   full fog image (undo/redo)
  //   scene    {grid, tokens, edits}                    grid + token state
  //   image    {id, data}                               new token image
  // Players send back (applied by the GM, who stays authoritative, then
  // rebroadcast via the scene sync):
  //   pong                                              keepalive reply
  //   token-move {id, x, y, final}                      drag a token
  //   token-add  {token, image?}                        create a token
  const PEERJS_SRC = "https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js";
  const PEER_ID_PREFIX = "foggymap-";
  // No ambiguous characters (0/O, 1/I/L) in room codes
  const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

  let peer = null;
  let viewers = [];
  let shareCode = null;
  let peerJsPromise = null;
  let stampBatch = null;
  let stampTimer = null;
  let shareSyncTimer = null;
  let pingTimer = null;
  let reconnectTimer = null;
  let wakeLock = null;
  let allowPlayerEdits = true;

  function sharing() {
    return peer !== null;
  }

  function loadPeerJs() {
    if (typeof Peer !== "undefined") return Promise.resolve();
    if (!peerJsPromise) {
      peerJsPromise = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = PEERJS_SRC;
        s.onload = resolve;
        s.onerror = () => {
          peerJsPromise = null;
          reject(new Error("failed to load PeerJS"));
        };
        document.head.appendChild(s);
      });
    }
    return peerJsPromise;
  }

  function randomCode() {
    let code = "";
    for (let i = 0; i < 6; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    return code;
  }

  function startSharing() {
    setShareError("");
    loadPeerJs()
      .then(() => {
        shareCode = randomCode();
        peer = new Peer(PEER_ID_PREFIX + shareCode);
        peer.on("open", () => {
          setShareError("");
          updateShareUI();
        });
        // PeerJS does not reconnect to its signaling server by itself; if
        // the socket drops, the room silently stops being joinable. Keep
        // re-registering under the same code.
        peer.on("disconnected", () => {
          if (!sharing()) return;
          setShareError("Signaling lost — reconnecting…");
          reconnectSignaling();
        });
        peer.on("error", (err) => {
          if (err.type === "unavailable-id" && sharing()) {
            // Code collision: retry with a fresh one
            stopSharing();
            startSharing();
          } else if (err.type !== "peer-unavailable") {
            setShareError(`Sharing error (${err.type}). Try again.`);
            stopSharing();
          }
        });
        peer.on("connection", (conn) => {
          conn.on("open", () => {
            viewers.push(conn);
            conn.send(snapshotMsg());
            updateShareUI();
          });
          conn.on("data", (msg) => handleViewerMessage(msg));
          conn.on("close", () => {
            viewers = viewers.filter((c) => c !== conn);
            updateShareUI();
          });
        });
        // Keepalive: without traffic, idle NAT mappings expire after
        // ~30-60s and the data channel dies silently.
        clearInterval(pingTimer);
        pingTimer = setInterval(() => broadcast({ t: "ping" }), 10000);
        acquireWakeLock();
        updateShareUI();
      })
      .catch(() => setShareError("Could not load PeerJS — are you online?"));
  }

  // Player actions arrive as requests; the GM validates and applies them,
  // and the regular scene sync rebroadcasts the result to everyone.
  function handleViewerMessage(msg) {
    if (!msg || typeof msg !== "object" || msg.t === "pong") return;
    if (!allowPlayerEdits || !state.hasMap) return;

    if (msg.t === "token-move") {
      const t = tokens.find((tk) => tk.id === msg.id);
      if (!t || !Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return;
      t.x = Math.min(Math.max(msg.x, 0), mapCanvas.width);
      t.y = Math.min(Math.max(msg.y, 0), mapCanvas.height);
      if (msg.final) {
        snapToken(t);
        updateTokenFogVisibility();
      }
      positionTokenEl(t);
      scheduleAutosave(); // also schedules the scene rebroadcast
    } else if (msg.t === "token-add") {
      const tk = msg.token;
      if (!tk || typeof tk !== "object") return;
      let imageId = null;
      if (
        msg.image &&
        typeof msg.image.id === "string" &&
        typeof msg.image.data === "string" &&
        msg.image.data.startsWith("data:image/") &&
        msg.image.data.length < 500000 // players downscale; reject anomalies
      ) {
        imageId = msg.image.id;
        images[imageId] = msg.image.data;
        ensureImageCache();
        broadcast({ t: "image", id: imageId, data: msg.image.data });
      }
      pushUndo("tokens"); // lets the GM undo a player's addition
      tokens.push({
        id: typeof tk.id === "string" ? tk.id.slice(0, 40) : newId("t"),
        x: Math.min(Math.max(Number(tk.x) || 0, 0), mapCanvas.width),
        y: Math.min(Math.max(Number(tk.y) || 0, 0), mapCanvas.height),
        size: Math.min(Math.max(Number(tk.size) || 50, 10), 400),
        color: /^#[0-9a-f]{6}$/i.test(tk.color) ? tk.color : PALETTE[0],
        label: String(tk.label || "Player").slice(0, 24),
        shape: tk.shape === "square" ? "square" : "circle",
        imageId,
      });
      renderTokens();
      updateTokenFogVisibility();
      scheduleAutosave();
    }
  }

  function reconnectSignaling() {
    if (!peer || peer.destroyed) return;
    try {
      peer.reconnect();
    } catch {
      /* already reconnecting */
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (peer && peer.disconnected && !peer.destroyed) reconnectSignaling();
    }, 3000);
  }

  function stopSharing() {
    if (peer) peer.destroy();
    peer = null;
    viewers = [];
    shareCode = null;
    clearTimeout(stampTimer);
    clearTimeout(reconnectTimer);
    clearInterval(pingTimer);
    stampBatch = null;
    wakeLock?.release().catch(() => {});
    wakeLock = null;
    updateShareUI();
  }

  // Keep the screen awake while sharing — a locked phone kills both the
  // signaling socket and the data channels.
  function acquireWakeLock() {
    if (!navigator.wakeLock || !sharing()) return;
    navigator.wakeLock
      .request("screen")
      .then((lock) => {
        wakeLock = lock;
      })
      .catch(() => {});
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !sharing()) return;
    acquireWakeLock(); // wake locks are released when the tab is hidden
    if (peer && peer.disconnected && !peer.destroyed) reconnectSignaling();
  });

  function broadcast(msg) {
    for (const conn of viewers) {
      if (conn.open) conn.send(msg);
    }
  }

  function snapshotMsg() {
    return {
      t: "snapshot",
      v: 1,
      map: state.mapDataUrl,
      fog: state.hasMap ? fogCanvas.toDataURL("image/png") : null,
      grid,
      tokens,
      images,
      edits: allowPlayerEdits,
    };
  }

  function broadcastSnapshot() {
    if (sharing() && viewers.length) broadcast(snapshotMsg());
  }

  // Brush stamps are batched and flushed on a short timer so a stroke
  // streams smoothly without a message per stamp.
  function queueStamp(ix, iy, mode) {
    if (!sharing() || !viewers.length) return;
    if (
      stampBatch &&
      (stampBatch.mode !== mode ||
        stampBatch.size !== state.brushSize ||
        stampBatch.soft !== state.softness)
    ) {
      flushStamps();
    }
    if (!stampBatch) {
      stampBatch = {
        t: "stamps",
        mode,
        size: state.brushSize,
        soft: state.softness,
        pts: [],
      };
    }
    stampBatch.pts.push([Math.round(ix), Math.round(iy)]);
    if (!stampTimer) stampTimer = setTimeout(flushStamps, 80);
  }

  function flushStamps() {
    clearTimeout(stampTimer);
    stampTimer = null;
    if (stampBatch && stampBatch.pts.length) broadcast(stampBatch);
    stampBatch = null;
  }

  // Throttled grid + token sync; cheap enough to ride along with autosave
  // scheduling and token drags.
  function scheduleShareSync() {
    if (!sharing() || !viewers.length || shareSyncTimer) return;
    shareSyncTimer = setTimeout(() => {
      shareSyncTimer = null;
      broadcast({ t: "scene", grid, tokens, edits: allowPlayerEdits });
    }, 120);
  }

  function updateShareUI() {
    shareOffDiv.hidden = sharing();
    shareOnDiv.hidden = !sharing();
    if (!sharing()) return;
    shareCodeEl.textContent = shareCode;
    const url = new URL("player.html", location.href);
    url.searchParams.set("room", shareCode);
    shareLinkInput.value = url.href;
    shareViewersEl.textContent =
      viewers.length === 1 ? "1 viewer connected" : `${viewers.length} viewers connected`;
  }

  function setShareError(msg) {
    shareErrorEl.textContent = msg;
    shareErrorEl.hidden = !msg;
  }

  // ---------- Persistence ----------
  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(autosave, 800);
    scheduleShareSync();
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
    if (grid.enabled) ctx.drawImage(gridCanvas, 0, 0);
    ctx.drawImage(fogCanvas, 0, 0); // fog at full opacity = what players see
    for (const t of tokens) {
      if (!tokenFogged(t)) drawTokenOnCanvas(ctx, t);
    }
    out.toBlob((blob) => {
      downloadBlob(blob, `foggymap-player-view-${timestamp()}.png`);
      setStatus("Player view exported 🖼️");
    }, "image/png");
  }

  // Mirror of the DOM token rendering for the exported image.
  function drawTokenOnCanvas(ctx, t) {
    const r = t.size / 2;
    ctx.save();
    ctx.beginPath();
    if (t.shape === "square") {
      roundedRectPath(ctx, t.x - r, t.y - r, t.size, t.size, t.size * 0.12);
    } else {
      ctx.arc(t.x, t.y, r, 0, Math.PI * 2);
    }
    ctx.clip();
    const img = t.imageId ? imageCache[t.imageId] : null;
    if (img && img.complete && img.naturalWidth) {
      // Cover-crop the image into the token bounds, like background-size: cover
      const k = Math.max(t.size / img.naturalWidth, t.size / img.naturalHeight);
      const sw = t.size / k;
      const sh = t.size / k;
      ctx.drawImage(
        img,
        (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh,
        t.x - r, t.y - r, t.size, t.size
      );
    } else {
      ctx.fillStyle = t.color;
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = `700 ${t.size * 0.36}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(initials(t.label), t.x, t.y);
    }
    ctx.restore();
    // Ring border, drawn unclipped so it isn't halved
    ctx.save();
    ctx.strokeStyle = t.color;
    ctx.lineWidth = Math.max(2, t.size * 0.06);
    ctx.beginPath();
    if (t.shape === "square") {
      roundedRectPath(ctx, t.x - r, t.y - r, t.size, t.size, t.size * 0.12);
    } else {
      ctx.arc(t.x, t.y, r, 0, Math.PI * 2);
    }
    ctx.stroke();
    ctx.restore();
  }

  function roundedRectPath(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
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
    calibrateBtn.classList.toggle("active", tool === "calibrate");
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
      !effectivePan &&
        (state.tool.endsWith("-rect") ||
          state.tool === "measure" ||
          state.tool === "calibrate")
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
    if (e.target.closest("#drop-hint, .panel")) return;
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
    if (selectedTokenId) selectToken(null); // click-through on the map deselects
    viewport.setPointerCapture(e.pointerId);
    const p = screenToImage(e.clientX, e.clientY);

    if (state.tool === "reveal" || state.tool === "hide") {
      pushUndo("fog");
      stroking = true;
      lastStamp = null;
      strokeTo(p.ix, p.iy, state.tool);
    } else if (state.tool.endsWith("-rect") || state.tool === "calibrate") {
      rectStart = p;
      rectPreview.classList.toggle("hide-mode", state.tool === "hide-rect");
      updateRectPreview(p, p);
      rectPreview.hidden = false;
    } else if (state.tool === "measure") {
      measureStart = p;
      drawMeasureLine(p, p);
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
      // Brushing in player view can reveal/cover tokens mid-stroke
      if (state.playerView) updateTokenFogVisibility();
    } else if (rectStart) {
      updateRectPreview(rectStart, p);
    } else if (measureStart) {
      drawMeasureLine(measureStart, p);
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
      flushStamps();
      fogChanged();
    }
    if (rectStart) {
      const p = screenToImage(e.clientX, e.clientY);
      if (state.tool === "calibrate") {
        applyCalibration(rectStart, p);
      } else {
        applyRect(rectStart, p, state.tool === "reveal-rect" ? "reveal" : "hide");
      }
      rectStart = null;
      rectPreview.hidden = true;
    }
    if (measureStart) {
      measureStart = null;
      clearOverlay();
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
    if (e.target.closest(".panel")) return;
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
    if (!file) return;
    // Dropping an image onto a token sets its portrait; anywhere else
    // replaces the map.
    const tokenEl = e.target.closest(".token");
    if (tokenEl && file.type.startsWith("image/")) {
      const t = tokens.find((tk) => tk.id === tokenEl.dataset.id);
      if (t) {
        importTokenImage(file)
          .then((id) => {
            pushUndo("tokens");
            t.imageId = id;
            selectToken(t.id);
            scheduleAutosave();
          })
          .catch(() => setStatus("⚠️ Could not read that image file."));
        return;
      }
    }
    handleImageFile(file);
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
    updateTokenFogVisibility();
  });

  gridBtn.addEventListener("click", () => {
    grid.enabled = !grid.enabled;
    syncGridUI();
    gridChanged();
  });

  document.getElementById("btn-grid-settings").addEventListener("click", () => {
    const opening = gridPanel.hidden;
    if (opening) {
      tokenPanelOpen = false; // one panel at a time
      updateTokenPanel();
      sharePanel.hidden = true;
    }
    gridPanel.hidden = !opening;
  });

  document.getElementById("btn-grid-close").addEventListener("click", () => {
    gridPanel.hidden = true;
  });

  document.getElementById("btn-token-close").addEventListener("click", () => {
    tokenPanelOpen = false;
    updateTokenPanel();
  });

  document.getElementById("btn-share").addEventListener("click", () => {
    const opening = sharePanel.hidden;
    if (opening) {
      gridPanel.hidden = true;
      tokenPanelOpen = false;
      updateTokenPanel();
    }
    sharePanel.hidden = !opening;
  });

  document.getElementById("btn-share-close").addEventListener("click", () => {
    sharePanel.hidden = true; // sharing itself keeps running
  });

  document.getElementById("btn-share-start").addEventListener("click", startSharing);
  document.getElementById("btn-share-stop").addEventListener("click", stopSharing);

  document.getElementById("share-edits").addEventListener("change", (e) => {
    allowPlayerEdits = e.target.checked;
    broadcast({ t: "scene", grid, tokens, edits: allowPlayerEdits });
  });

  document.getElementById("btn-copy-link").addEventListener("click", () => {
    shareLinkInput.select();
    navigator.clipboard
      ?.writeText(shareLinkInput.value)
      .then(() => setStatus("Player link copied 📋"))
      .catch(() => document.execCommand("copy"));
  });

  calibrateBtn.addEventListener("click", () => {
    if (state.tool === "calibrate") {
      setTool(toolBeforeCalibrate || "reveal");
      return;
    }
    toolBeforeCalibrate = state.tool;
    setTool("calibrate");
    setStatus("Drag a box along the map's grid to calibrate.");
  });

  gridSizeInput.addEventListener("input", () => {
    grid.cellSize = Math.max(4, +gridSizeInput.value || grid.cellSize);
    gridChanged();
  });
  gridOffXInput.addEventListener("input", () => {
    grid.offsetX = +gridOffXInput.value || 0;
    gridChanged();
  });
  gridOffYInput.addEventListener("input", () => {
    grid.offsetY = +gridOffYInput.value || 0;
    gridChanged();
  });
  gridColorInput.addEventListener("change", () => {
    grid.color = gridColorInput.value;
    gridChanged();
  });
  gridAlphaInput.addEventListener("input", () => {
    grid.opacity = +gridAlphaInput.value / 100;
    gridChanged();
  });
  gridUnitsInput.addEventListener("input", () => {
    grid.unitsPerCell = +gridUnitsInput.value || 0;
    scheduleAutosave();
  });
  gridUnitLabelInput.addEventListener("input", () => {
    grid.unitLabel = gridUnitLabelInput.value;
    scheduleAutosave();
  });
  gridDiagInput.addEventListener("change", () => {
    grid.diagRule = gridDiagInput.value;
    scheduleAutosave();
  });
  gridSnapInput.addEventListener("change", () => {
    grid.snap = gridSnapInput.checked;
    scheduleAutosave();
  });

  document.getElementById("btn-add-token").addEventListener("click", addToken);

  tokenLabelInput.addEventListener("input", () => {
    const t = selectedToken();
    if (!t) return;
    t.label = tokenLabelInput.value;
    renderTokens();
    scheduleAutosave();
  });

  tokenSizeInput.addEventListener("input", () => {
    const t = selectedToken();
    if (!t) return;
    t.size = +tokenSizeInput.value;
    renderTokens();
    scheduleAutosave();
  });

  document.getElementById("btn-token-cell").addEventListener("click", () => {
    const t = selectedToken();
    if (!t) return;
    pushUndo("tokens");
    t.size = grid.cellSize;
    tokenChanged();
  });

  tokenShapeInput.addEventListener("change", () => {
    const t = selectedToken();
    if (!t) return;
    pushUndo("tokens");
    t.shape = tokenShapeInput.value;
    tokenChanged();
  });

  document.getElementById("btn-token-image").addEventListener("click", () => {
    tokenImageInput.click();
  });

  tokenImageInput.addEventListener("change", () => {
    const file = tokenImageInput.files[0];
    tokenImageInput.value = "";
    if (!file) return;
    importTokenImage(file)
      .then((id) => {
        const t = selectedToken();
        if (!t) return;
        pushUndo("tokens");
        t.imageId = id;
        tokenChanged();
      })
      .catch(() => setStatus("⚠️ Could not read that image file."));
  });

  document.getElementById("btn-token-clear-image").addEventListener("click", () => {
    const t = selectedToken();
    if (!t || !t.imageId) return;
    pushUndo("tokens");
    t.imageId = null;
    tokenChanged();
  });

  document.getElementById("btn-token-duplicate").addEventListener("click", duplicateSelectedToken);
  document.getElementById("btn-token-delete").addEventListener("click", deleteSelectedToken);

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
    if (e.target.matches("input, textarea, select")) return;

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
      case "m": setTool("measure"); break;
      case "g": gridBtn.click(); break;
      case "n": addToken(); break;
      case "delete":
      case "backspace":
        deleteSelectedToken();
        break;
      case "escape":
        if (state.tool === "calibrate") setTool(toolBeforeCalibrate || "reveal");
        else if (selectedTokenId) selectToken(null);
        break;
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
  syncGridUI();
  loadBuiltinTokens();
  tryRestoreSession();
})();
