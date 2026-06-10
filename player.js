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
  let aoes = [];

  const aoeLayer = document.getElementById("aoe-layer");
  const SVG_NS = "http://www.w3.org/2000/svg";
  const CONE_HALF_ANGLE = (53.13 / 2) * (Math.PI / 180);

  let peer = null;
  let conn = null;
  let retryTimer = null;
  let room = "";
  let lastSeen = 0; // time of the last message from the GM
  let wakeLock = null;
  let allowEdits = true;
  let tokenDrag = null; // {id, startIx, startIy, origX, origY, moved}
  let moveSendTimer = null;
  let tokenRenderPending = false;

  const PALETTE = [
    "#e74c3c", "#e67e22", "#f1c40f", "#2ecc71", "#1abc9c",
    "#3498db", "#9b59b6", "#e84393", "#95a5a6", "#34495e",
  ];

  // ---------- View transform ----------
  function applyTransform() {
    stage.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
  }

  function screenToImage(clientX, clientY) {
    const rect = viewport.getBoundingClientRect();
    return {
      ix: (clientX - rect.left - panX) / scale,
      iy: (clientY - rect.top - panY) / scale,
    };
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
    // Rebuilding mid-drag would destroy the captured element (GM updates
    // stream in constantly); defer until the drag ends.
    if (tokenDrag) {
      tokenRenderPending = true;
      return;
    }
    tokenRenderPending = false;
    tokenLayer.innerHTML = "";
    for (const t of tokens) {
      if (fogAlphaAt(t.x, t.y) > FOG_HIDE_ALPHA) continue; // hidden in fog
      const el = document.createElement("div");
      el.className = "token";
      el.dataset.id = t.id;
      if (t.shape === "square") el.classList.add("square");
      el.style.left = `${t.x - t.size / 2}px`;
      el.style.top = `${t.y - t.size / 2}px`;
      el.style.width = el.style.height = `${t.size}px`;
      el.style.setProperty("--token-color", t.color);
      el.style.borderWidth = `${Math.max(2, t.size * 0.06)}px`;
      el.title = t.label;
      const src = !t.imageId
        ? null
        : t.imageId.startsWith("builtin:")
          ? "tokens/" + t.imageId.slice(8) // shipped with the site, same origin
          : images[t.imageId] || null;
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

  function positionTokenEl(t) {
    const el = tokenLayer.querySelector(`[data-id="${t.id}"]`);
    if (!el) return;
    el.style.left = `${t.x - t.size / 2}px`;
    el.style.top = `${t.y - t.size / 2}px`;
  }

  // AoE markers, mirroring the GM renderer (view-only)
  function aoePathFor(a) {
    const r2 = (n) => Math.round(n * 100) / 100;
    const { x, y, size: s, angle: ang } = a;
    if (a.shape === "circle") {
      return (
        `M ${r2(x - s)} ${r2(y)} ` +
        `a ${r2(s)} ${r2(s)} 0 1 0 ${r2(2 * s)} 0 ` +
        `a ${r2(s)} ${r2(s)} 0 1 0 ${r2(-2 * s)} 0 Z`
      );
    }
    if (a.shape === "cone") {
      const a1 = ang - CONE_HALF_ANGLE;
      const a2 = ang + CONE_HALF_ANGLE;
      return (
        `M ${r2(x)} ${r2(y)} ` +
        `L ${r2(x + s * Math.cos(a1))} ${r2(y + s * Math.sin(a1))} ` +
        `A ${r2(s)} ${r2(s)} 0 0 1 ` +
        `${r2(x + s * Math.cos(a2))} ${r2(y + s * Math.sin(a2))} Z`
      );
    }
    const half =
      a.shape === "square"
        ? s / 2
        : Math.max(6, grid && grid.enabled ? grid.cellSize / 2 : s * 0.08);
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    const px = -dy;
    const py = dx;
    const corners = [
      [x + px * half, y + py * half],
      [x - px * half, y - py * half],
      [x - px * half + dx * s, y - py * half + dy * s],
      [x + px * half + dx * s, y + py * half + dy * s],
    ];
    return "M " + corners.map(([cx, cy]) => `${r2(cx)} ${r2(cy)}`).join(" L ") + " Z";
  }

  function renderAoes() {
    aoeLayer.innerHTML = "";
    for (const a of aoes) {
      if (!a || a.size < 1) continue;
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", aoePathFor(a));
      path.setAttribute("fill", a.color);
      path.setAttribute("fill-opacity", a.opacity);
      path.setAttribute("stroke", a.color);
      path.setAttribute("stroke-opacity", 0.85);
      path.setAttribute("stroke-width", 3);
      aoeLayer.appendChild(path);
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
    lastSeen = Date.now();
    switch (msg.t) {
      case "ping":
        // Answer the GM's keepalive so traffic flows both ways and idle
        // NAT mappings stay open.
        if (conn && conn.open) conn.send({ t: "pong" });
        break;
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
      case "scene": {
        // Echo suppression: our own drag is optimistic, and the GM streams
        // positions back; keep local coordinates for the token in hand.
        const held = tokenDrag && tokens.find((t) => t.id === tokenDrag.id);
        grid = msg.grid;
        tokens = msg.tokens || [];
        aoes = msg.aoes || [];
        if (held) {
          const t = tokens.find((tk) => tk.id === held.id);
          if (t) {
            t.x = held.x;
            t.y = held.y;
          }
        }
        if (msg.edits !== undefined) setEdits(msg.edits);
        drawGrid();
        renderAoes();
        renderTokens();
        break;
      }
      case "image":
        images[msg.id] = msg.data;
        renderTokens();
        break;
    }
  }

  function applySnapshot(msg) {
    tokenDrag = null; // the whole scene may have changed under us
    grid = msg.grid;
    tokens = msg.tokens || [];
    images = msg.images || {};
    aoes = msg.aoes || [];
    if (msg.edits !== undefined) setEdits(msg.edits);
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
      aoeLayer.setAttribute("width", img.naturalWidth);
      aoeLayer.setAttribute("height", img.naturalHeight);
      aoeLayer.setAttribute("viewBox", `0 0 ${img.naturalWidth} ${img.naturalHeight}`);
      mapCtx.drawImage(img, 0, 0);
      hasMap = true;
      waiting.hidden = true;
      drawGrid();
      renderAoes();
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
    // Re-register with the signaling server if its socket drops; without
    // this, recovering from a GM restart is impossible.
    peer.on("disconnected", () => {
      if (peer && !peer.destroyed) {
        try {
          peer.reconnect();
        } catch {
          /* already reconnecting */
        }
      }
    });
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
      lastSeen = Date.now();
      setStatus(`Connected · room ${room}`, "ok");
      acquireWakeLock();
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

  // Watchdog: the GM pings every 10s, so silence means the channel died
  // without firing "close" (typical of expired NAT mappings). Force a
  // reconnect cycle.
  setInterval(() => {
    if (conn && conn.open && lastSeen && Date.now() - lastSeen > 30000) {
      setStatus("Connection stale — reconnecting…", "bad");
      conn.close();
      scheduleRetry();
    }
  }, 5000);

  // Keep the screen awake while watching — this page is meant to sit on a
  // TV or tablet for a whole session.
  function acquireWakeLock() {
    if (!navigator.wakeLock) return;
    navigator.wakeLock
      .request("screen")
      .then((lock) => {
        wakeLock = lock;
      })
      .catch(() => {});
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (conn && conn.open) acquireWakeLock(); // released when tab was hidden
    if (peer && peer.disconnected && !peer.destroyed) {
      try {
        peer.reconnect();
      } catch {
        /* already reconnecting */
      }
    }
    if (room && peer && !peer.disconnected && (!conn || !conn.open)) dial();
  });

  // ---------- Player token editing ----------
  function setEdits(v) {
    allowEdits = !!v;
    document.body.classList.toggle("no-edits", !allowEdits);
    document.getElementById("btn-add-token").hidden = !allowEdits;
  }

  function send(msg) {
    if (conn && conn.open) conn.send(msg);
  }

  // Drag any visible token: move it locally (optimistic) and stream the
  // position to the GM, who validates, snaps, and rebroadcasts.
  tokenLayer.addEventListener("pointerdown", (e) => {
    const el = e.target.closest(".token");
    if (!el || e.button !== 0 || !allowEdits) return;
    const t = tokens.find((tk) => tk.id === el.dataset.id);
    if (!t) return;
    e.stopPropagation(); // don't start a viewport pan
    const p = screenToImage(e.clientX, e.clientY);
    tokenDrag = { id: t.id, startIx: p.ix, startIy: p.iy, origX: t.x, origY: t.y, moved: false };
    el.setPointerCapture(e.pointerId);
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
      const d = Math.hypot(
        (p.ix - tokenDrag.startIx) * scale,
        (p.iy - tokenDrag.startIy) * scale
      );
      if (d < 4) return;
      tokenDrag.moved = true;
    }
    t.x = tokenDrag.origX + (p.ix - tokenDrag.startIx);
    t.y = tokenDrag.origY + (p.iy - tokenDrag.startIy);
    positionTokenEl(t);
    if (!moveSendTimer) {
      moveSendTimer = setTimeout(() => {
        moveSendTimer = null;
        send({ t: "token-move", id: t.id, x: t.x, y: t.y, final: false });
      }, 100);
    }
  });

  function endTokenDrag() {
    if (!tokenDrag) return;
    const t = tokens.find((tk) => tk.id === tokenDrag.id);
    const moved = tokenDrag.moved;
    tokenDrag = null;
    clearTimeout(moveSendTimer);
    moveSendTimer = null;
    if (moved && t) send({ t: "token-move", id: t.id, x: t.x, y: t.y, final: true });
    if (tokenRenderPending) renderTokens();
  }

  tokenLayer.addEventListener("pointerup", endTokenDrag);
  tokenLayer.addEventListener("pointercancel", endTokenDrag);

  // Upload an image and add it as a token at the center of the current view.
  const tokenFileInput = document.getElementById("token-file");

  document.getElementById("btn-add-token").addEventListener("click", () => {
    if (hasMap && allowEdits) tokenFileInput.click();
  });

  tokenFileInput.addEventListener("change", () => {
    const file = tokenFileInput.files[0];
    tokenFileInput.value = "";
    if (!file || !file.type.startsWith("image/") || !hasMap) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        // Downscale before sending, same as the GM's import pipeline
        const k = Math.min(1, 256 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.naturalWidth * k));
        c.height = Math.max(1, Math.round(img.naturalHeight * k));
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        const keepAlpha = file.type === "image/png" || file.type === "image/webp";
        const data = keepAlpha
          ? c.toDataURL("image/png")
          : c.toDataURL("image/jpeg", 0.85);
        const rand = Math.random().toString(36).slice(2, 8);
        const center = screenToImage(
          viewport.getBoundingClientRect().left + viewport.clientWidth / 2,
          viewport.getBoundingClientRect().top + viewport.clientHeight / 2
        );
        send({
          t: "token-add",
          token: {
            id: `p-${Date.now().toString(36)}-${rand}`,
            x: center.ix,
            y: center.iy,
            size: grid && grid.enabled ? grid.cellSize : Math.max(24, mapCanvas.width / 20),
            color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
            label: file.name.replace(/\.[^.]+$/, "").slice(0, 24) || "Player",
            shape: "circle",
          },
          image: { id: `pimg-${Date.now().toString(36)}-${rand}`, data },
        });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });

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
