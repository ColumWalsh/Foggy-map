/* Foggy Map — live player view.
 *
 * Connects to a GM's session over a PeerJS WebRTC data channel and renders
 * the player perspective: map, grid, fully opaque fog, and tokens (hidden
 * while they stand in unrevealed fog). View-only — the page receives a full
 * snapshot on join, then applies streamed updates (see the message protocol
 * in app.js).
 */
(() => {
  "use strict";

  const FOG_COLOR = "#0e1118";
  const FOG_HIDE_ALPHA = 128;
  const PEER_ID_PREFIX = "foggymap-";
  const RETRY_MS = 3000;

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
  const roomInput = document.getElementById("room-input");
  const joinBtn = document.getElementById("btn-join");
  const connStatus = document.getElementById("conn-status");
  const waiting = document.getElementById("waiting");
  const waitingTitle = document.getElementById("waiting-title");
  const waitingText = document.getElementById("waiting-text");

  // ---------- State ----------
  let scale = 1;
  let panX = 0;
  let panY = 0;
  let hasMap = false;
  let grid = null;
  let tokens = [];
  let images = {};

  let peer = null;
  let conn = null;
  let retryTimer = null;
  let room = "";

  // ---------- View transform ----------
  function applyTransform() {
    stage.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
  }

  function zoomAt(clientX, clientY, factor) {
    const rect = viewport.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    const newScale = Math.min(16, Math.max(0.05, scale * factor));
    const real = newScale / scale;
    panX = mx - (mx - panX) * real;
    panY = my - (my - panY) * real;
    scale = newScale;
    applyTransform();
  }

  function fitToWindow() {
    if (!hasMap) return;
    scale = Math.min(
      viewport.clientWidth / mapCanvas.width,
      viewport.clientHeight / mapCanvas.height
    ) * 0.95;
    panX = (viewport.clientWidth - mapCanvas.width * scale) / 2;
    panY = (viewport.clientHeight - mapCanvas.height * scale) / 2;
    applyTransform();
  }

  // ---------- Rendering (player-perspective mirrors of the GM app) ----------
  function drawGrid() {
    gridCtx.clearRect(0, 0, gridCanvas.width, gridCanvas.height);
    if (!grid || !grid.enabled || grid.cellSize < 4) return;
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

  function initials(label) {
    const words = (label || "").trim().split(/\s+/).filter(Boolean);
    if (!words.length) return "?";
    return words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0];
  }

  function fogAlphaAt(x, y) {
    if (!hasMap) return 255;
    const cx = Math.max(0, Math.min(fogCanvas.width - 1, Math.round(x)));
    const cy = Math.max(0, Math.min(fogCanvas.height - 1, Math.round(y)));
    return fogCtx.getImageData(cx, cy, 1, 1).data[3];
  }

  function renderTokens() {
    tokenLayer.innerHTML = "";
    for (const t of tokens) {
      if (fogAlphaAt(t.x, t.y) > FOG_HIDE_ALPHA) continue; // hidden in fog
      const el = document.createElement("div");
      el.className = "token";
      if (t.shape === "square") el.classList.add("square");
      el.style.left = `${t.x - t.size / 2}px`;
      el.style.top = `${t.y - t.size / 2}px`;
      el.style.width = el.style.height = `${t.size}px`;
      el.style.setProperty("--token-color", t.color);
      el.style.borderWidth = `${Math.max(2, t.size * 0.06)}px`;
      if (t.imageId && images[t.imageId]) {
        el.style.backgroundImage = `url("${images[t.imageId]}")`;
      } else {
        const span = document.createElement("span");
        span.textContent = initials(t.label);
        span.style.fontSize = `${t.size * 0.36}px`;
        el.appendChild(span);
      }
      tokenLayer.appendChild(el);
    }
  }

  function stampBrush(ix, iy, mode, size, soft) {
    const r = size / 2;
    const inner = r * (1 - soft);
    const grad = fogCtx.createRadialGradient(ix, iy, inner, ix, iy, r);
    if (mode === "reveal") {
      fogCtx.globalCompositeOperation = "destination-out";
      grad.addColorStop(0, "rgba(0,0,0,1)");
      grad.addColorStop(1, "rgba(0,0,0,0)");
    } else {
      fogCtx.globalCompositeOperation = "source-over";
      grad.addColorStop(0, FOG_COLOR);
      grad.addColorStop(1, FOG_COLOR + "00");
    }
    fogCtx.fillStyle = grad;
    fogCtx.beginPath();
    fogCtx.arc(ix, iy, r, 0, Math.PI * 2);
    fogCtx.fill();
  }

  function loadFog(dataUrl) {
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

  // ---------- Message handling ----------
  function onMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    switch (msg.t) {
      case "snapshot":
        applySnapshot(msg);
        break;
      case "stamps":
        for (const [x, y] of msg.pts) stampBrush(x, y, msg.mode, msg.size, msg.soft);
        renderTokens();
        break;
      case "rect":
        if (msg.mode === "reveal") {
          fogCtx.globalCompositeOperation = "destination-out";
          fogCtx.fillStyle = "rgba(0,0,0,1)";
        } else {
          fogCtx.globalCompositeOperation = "source-over";
          fogCtx.fillStyle = FOG_COLOR;
        }
        fogCtx.fillRect(msg.x, msg.y, msg.w, msg.h);
        renderTokens();
        break;
      case "fill":
        fogCtx.globalCompositeOperation = "source-over";
        if (msg.mode === "hide") {
          fogCtx.fillStyle = FOG_COLOR;
          fogCtx.fillRect(0, 0, fogCanvas.width, fogCanvas.height);
        } else {
          fogCtx.clearRect(0, 0, fogCanvas.width, fogCanvas.height);
        }
        renderTokens();
        break;
      case "fog":
        loadFog(msg.data).then(renderTokens).catch(() => {});
        break;
      case "scene":
        grid = msg.grid;
        tokens = msg.tokens || [];
        drawGrid();
        renderTokens();
        break;
      case "image":
        images[msg.id] = msg.data;
        renderTokens();
        break;
    }
  }

  function applySnapshot(msg) {
    grid = msg.grid;
    tokens = msg.tokens || [];
    images = msg.images || {};
    if (!msg.map) {
      hasMap = false;
      showWaiting("Connected", "Waiting for the GM to load a map…");
      return;
    }
    const img = new Image();
    img.onload = () => {
      mapCanvas.width = gridCanvas.width = fogCanvas.width = img.naturalWidth;
      mapCanvas.height = gridCanvas.height = fogCanvas.height = img.naturalHeight;
      tokenLayer.style.width = `${img.naturalWidth}px`;
      tokenLayer.style.height = `${img.naturalHeight}px`;
      mapCtx.drawImage(img, 0, 0);
      hasMap = true;
      waiting.hidden = true;
      drawGrid();
      const fogReady = msg.fog
        ? loadFog(msg.fog)
        : Promise.resolve(onMessage({ t: "fill", mode: "hide" }));
      fogReady.then(() => {
        renderTokens();
        fitToWindow();
      });
    };
    img.src = msg.map;
  }

  // ---------- Connection ----------
  function setStatus(msg, cls) {
    connStatus.textContent = msg;
    connStatus.className = cls || "muted";
  }

  function showWaiting(title, text) {
    waiting.hidden = false;
    waitingTitle.textContent = title;
    waitingText.textContent = text;
  }

  function join() {
    room = roomInput.value.trim().toUpperCase();
    if (!room) return;
    const url = new URL(location.href);
    url.searchParams.set("room", room);
    history.replaceState(null, "", url);
    if (typeof Peer === "undefined") {
      setStatus("Could not load PeerJS — check your connection", "bad");
      return;
    }
    setStatus(`Connecting to ${room}…`);
    showWaiting("Connecting…", `Joining room ${room}.`);
    if (peer) {
      dial();
      return;
    }
    peer = new Peer();
    peer.on("open", dial);
    peer.on("error", (err) => {
      if (err.type === "peer-unavailable") {
        setStatus(`Room ${room} not found — is the GM sharing?`, "bad");
      } else {
        setStatus(`Connection error (${err.type})`, "bad");
      }
      scheduleRetry();
    });
  }

  function dial() {
    clearTimeout(retryTimer);
    conn = peer.connect(PEER_ID_PREFIX + room, { reliable: true });
    conn.on("open", () => {
      clearTimeout(retryTimer);
      setStatus(`Connected · room ${room}`, "ok");
    });
    conn.on("data", onMessage);
    conn.on("close", () => {
      setStatus("Disconnected — retrying…", "bad");
      scheduleRetry();
    });
    conn.on("error", scheduleRetry);
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (!conn || !conn.open) dial();
    }, RETRY_MS);
  }

  // ---------- Pan & zoom ----------
  let panning = false;

  viewport.addEventListener("pointerdown", (e) => {
    panning = true;
    viewport.classList.add("panning");
    viewport.setPointerCapture(e.pointerId);
  });

  viewport.addEventListener("pointermove", (e) => {
    if (!panning) return;
    panX += e.movementX;
    panY += e.movementY;
    applyTransform();
  });

  function endPan() {
    panning = false;
    viewport.classList.remove("panning");
  }
  viewport.addEventListener("pointerup", endPan);
  viewport.addEventListener("pointercancel", endPan);

  viewport.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 1 / 1.1);
  }, { passive: false });

  document.getElementById("btn-zoom-in").addEventListener("click", () => {
    const r = viewport.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.25);
  });
  document.getElementById("btn-zoom-out").addEventListener("click", () => {
    const r = viewport.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / 1.25);
  });
  document.getElementById("btn-zoom-fit").addEventListener("click", fitToWindow);
  document.getElementById("btn-fullscreen").addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  });

  window.addEventListener("resize", () => {
    if (hasMap && scale <= 1) fitToWindow();
  });

  joinBtn.addEventListener("click", join);
  roomInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") join();
  });

  // ---------- Init ----------
  const param = new URLSearchParams(location.search).get("room");
  if (param) {
    roomInput.value = param.toUpperCase();
    join();
  }
})();
