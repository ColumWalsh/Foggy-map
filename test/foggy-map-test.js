/* Headless functional tests for Foggy Map (index.html + app.js).
 *
 * Setup (once):   npm install jsdom canvas
 * Run:            node test/foggy-map-test.js        (from the repo root)
 *                 FOGGY_REPO=/path/to/repo node test/foggy-map-test.js
 *
 * Exercises the app in jsdom with real canvas pixels: map load, fog
 * brushing, undo/redo, tokens, grid calibration, measure, AoE, autosave
 * round-trip, quota fallback, and hostile player input. Exits non-zero
 * on any failure, so it can run in CI.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");
const { createCanvas } = require("canvas");

const REPO = process.env.FOGGY_REPO || process.cwd();
const html = fs.readFileSync(path.join(REPO, "index.html"), "utf8");
const appJs = fs.readFileSync(path.join(REPO, "app.js"), "utf8");

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; failures.push(name + (extra ? ` (${extra})` : "")); console.log("  ✗", name, extra); }
}

function makeMapDataUrl(w = 400, h = 300) {
  const c = createCanvas(w, h);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#88aa55";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#334455";
  ctx.fillRect(50, 50, 100, 100);
  return c.toDataURL("image/png");
}

async function boot({ storage = {} } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => { if (!String(e).includes("style.css")) errors.push(String(e)); });
  vc.on("error", (...a) => errors.push(a.join(" ")));
  const dom = new JSDOM(html, {
    url: "https://columwalsh.github.io/Foggy-map/",
    runScripts: "outside-only",
    resources: "usable",
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const { window } = dom;
  // --- polyfills jsdom lacks ---
  if (!window.PointerEvent) {
    window.PointerEvent = class PointerEvent extends window.MouseEvent {
      constructor(type, init = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
    };
  }
  window.Element.prototype.setPointerCapture = function () {};
  window.Element.prototype.releasePointerCapture = function () {};
  window.fetch = () => Promise.reject(new Error("no network in harness"));
  window.URL.createObjectURL = window.URL.createObjectURL || (() => "blob:fake");
  window.URL.revokeObjectURL = window.URL.revokeObjectURL || (() => {});
  if (!window.Path2D) window.Path2D = class Path2D { constructor(d) { this.d = d; } };
  // seed localStorage
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  // viewport size: jsdom clientWidth is 0; fake it
  Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { get() { return this.id === "viewport" ? 800 : 0; }, configurable: true });
  Object.defineProperty(window.HTMLElement.prototype, "clientHeight", { get() { return this.id === "viewport" ? 600 : 0; }, configurable: true });
  const vpRect = { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 };
  window.Element.prototype.getBoundingClientRect = function () { return vpRect; };
  window.performance = window.performance || { now: () => Date.now() };

  // run the app
  try {
    window.eval(appJs);
  } catch (e) {
    errors.push("app.js threw on init: " + e.stack);
  }
  return { dom, window, errors };
}

function ptr(window, target, type, x, y, opts = {}) {
  const e = new window.PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1, ...opts });
  target.dispatchEvent(e);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 3000, step = 25) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
}

(async () => {
  // ---------------- Test 1: clean boot ----------------
  console.log("\n[1] Boot with no saved session");
  let { window, errors } = await boot();
  check("no init errors", errors.length === 0, errors[0]);
  const doc = window.document;
  check("drop hint visible before map", !doc.getElementById("drop-hint").hidden);
  check("undo disabled at start", doc.getElementById("btn-undo").disabled);
  check("status shows reveal tool", doc.getElementById("status-tool").textContent.includes("Reveal"));

  // ---------------- Test 2: load a map ----------------
  console.log("\n[2] Load a 400x300 map");
  const mapUrl = makeMapDataUrl();
  // simulate paste-style path: call the same internals via file input is hard headlessly;
  // instead drive loadMapFromDataUrl through the session-restore path on a fresh boot.
  const session = { app: "foggymap", version: 2, map: mapUrl };
  ({ window, errors } = await boot({ storage: { "foggymap.session.v1": JSON.stringify(session) } }));
  const d = window.document;
  const mapC = d.getElementById("map-canvas");
  const fogC = d.getElementById("fog-canvas");
  const ok = await waitFor(() => mapC.width === 400 && d.getElementById("drop-hint").hidden);
  check("map canvas sized to image", ok, `w=${mapC.width}`);
  check("no errors during load", errors.length === 0, errors[0]);
  const fogCtx = fogC.getContext("2d");
  await waitFor(() => fogCtx.getImageData(200, 150, 1, 1).data[3] === 255);
  check("fog fully covers map after load", fogCtx.getImageData(200, 150, 1, 1).data[3] === 255);
  check("status mentions restore", d.getElementById("status-save").textContent.includes("Restored"));

  // ---------------- Test 3: reveal brush stroke ----------------
  console.log("\n[3] Brush reveal stroke + undo/redo");
  const vp = d.getElementById("viewport");
  // map fits 800x600 -> scale = min(2,2)*.95=1.9; pan centers it
  // stroke across the middle of the screen
  ptr(window, vp, "pointerdown", 400, 300);
  ptr(window, vp, "pointermove", 460, 300);
  ptr(window, vp, "pointerup", 460, 300);
  // image coords of screen 400,300:
  const alphaMid = () => {
    // compute image coord like app: (client - pan)/scale; read center-ish pixel
    return fogCtx.getImageData(200, 150, 1, 1).data[3];
  };
  check("fog erased where brushed", alphaMid() < 250, `alpha=${alphaMid()}`);
  check("undo enabled after stroke", !d.getElementById("btn-undo").disabled);
  d.getElementById("btn-undo").click();
  await waitFor(() => alphaMid() === 255);
  check("undo restores fog", alphaMid() === 255, `alpha=${alphaMid()}`);
  check("redo enabled", !d.getElementById("btn-redo").disabled);
  d.getElementById("btn-redo").click();
  await waitFor(() => alphaMid() < 250);
  check("redo re-erases fog", alphaMid() < 250, `alpha=${alphaMid()}`);

  // ---------------- Test 4: reveal all / cover all ----------------
  console.log("\n[4] Reveal all / Cover all");
  d.getElementById("btn-reveal-all").click();
  check("reveal-all clears fog", fogCtx.getImageData(10, 10, 1, 1).data[3] === 0);
  d.getElementById("btn-cover-all").click();
  check("cover-all repaints fog", fogCtx.getImageData(10, 10, 1, 1).data[3] === 255);

  // ---------------- Test 5: hide brush over revealed area ----------------
  console.log("\n[5] Hide brush");
  d.getElementById("btn-reveal-all").click();
  d.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: "h", bubbles: true }));
  ptr(window, vp, "pointerdown", 400, 300);
  ptr(window, vp, "pointerup", 400, 300);
  check("hide brush repaints fog at stamp", fogCtx.getImageData(200, 150, 1, 1).data[3] > 200,
    `alpha=${fogCtx.getImageData(200, 150, 1, 1).data[3]}`);
  d.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: "b", bubbles: true }));

  // ---------------- Test 6: tokens ----------------
  console.log("\n[6] Tokens: add, snap, duplicate, delete, label initials");
  d.getElementById("btn-add-token").click();
  let tokenEls = d.querySelectorAll("#token-layer .token");
  check("token added", tokenEls.length === 1);
  check("token panel opened for new token", !d.getElementById("token-panel").hidden);
  // label -> initials
  const lbl = d.getElementById("token-label");
  lbl.value = "Gith Knight";
  lbl.dispatchEvent(new window.Event("input", { bubbles: true }));
  tokenEls = d.querySelectorAll("#token-layer .token");
  check("initials update with label", tokenEls[0].textContent === "GK", tokenEls[0].textContent);
  d.getElementById("btn-token-duplicate").click();
  check("duplicate adds a token", d.querySelectorAll("#token-layer .token").length === 2);
  d.getElementById("btn-token-delete").click();
  check("delete removes selected token", d.querySelectorAll("#token-layer .token").length === 1);

  // ---------------- Test 7: grid + calibration via drag ----------------
  console.log("\n[7] Grid calibration drag");
  d.getElementById("btn-grid-settings").click();
  d.getElementById("btn-calibrate").click();
  check("tool switches to calibrate", d.getElementById("status-tool").textContent.includes("alibrate"));
  // drag a box: 4 cells across 190 screen px at scale 1.9 -> 100 image px -> 25px cells
  d.getElementById("cal-cells").value = "4";
  ptr(window, vp, "pointerdown", 300, 300);
  ptr(window, vp, "pointermove", 490, 302);
  ptr(window, vp, "pointerup", 490, 302);
  const cellVal = +d.getElementById("grid-size").value;
  check("calibration computes cell size ~25px", Math.abs(cellVal - 25) < 0.6, `cell=${cellVal}`);
  check("grid toggled on after calibration", d.getElementById("btn-grid").classList.contains("on"));
  check("tool restored after calibration", d.getElementById("status-tool").textContent.includes("Reveal"));

  // snap: enable snap, add a token, check center alignment
  const snap = d.getElementById("grid-snap");
  snap.checked = true;
  snap.dispatchEvent(new window.Event("change", { bubbles: true }));
  d.getElementById("btn-add-token").click();
  const tEl = [...d.querySelectorAll("#token-layer .token")].pop();
  const cs = cellVal;
  const left = parseFloat(tEl.style.left), size = parseFloat(tEl.style.width);
  const cx = left + size / 2;
  const offX = +d.getElementById("grid-off-x").value;
  const frac = ((cx - offX) / cs) % 1;
  check("snapped token sits at cell center", Math.abs(frac - 0.5) < 0.05, `frac=${frac.toFixed(3)}`);

  // ---------------- Test 8: measure tool label ----------------
  console.log("\n[8] Measure tool");
  d.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: "m", bubbles: true }));
  ptr(window, vp, "pointerdown", 300, 300);
  ptr(window, vp, "pointermove", 300 + cs * 1.9 * 3, 300); // 3 cells along x
  const label = d.getElementById("measure-label");
  check("measure label visible during drag", !label.hidden);
  check("measure label ~3.0 cells", /3\.0 cells/.test(label.textContent), label.textContent);
  check("measure label shows ft units", /15 ft/.test(label.textContent), label.textContent);
  ptr(window, vp, "pointerup", 500, 300);
  check("measure label hidden after release", label.hidden);
  d.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: "b", bubbles: true }));

  // ---------------- Test 9: AoE placement ----------------
  console.log("\n[9] AoE marker drag (circle)");
  d.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: "a", bubbles: true }));
  check("AoE panel opens", !d.getElementById("aoe-panel").hidden);
  ptr(window, vp, "pointerdown", 400, 300);
  ptr(window, vp, "pointermove", 450, 300);
  ptr(window, vp, "pointerup", 450, 300);
  const aoePaths = d.querySelectorAll("#aoe-layer path");
  check("AoE path created", aoePaths.length === 1);
  check("new AoE selected (dashed)", aoePaths[0]?.getAttribute("stroke-dasharray") === "8 6");
  // Escape deselects
  d.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: "escape", bubbles: true }));
  check("Esc deselects AoE", d.querySelector("#aoe-layer path")?.getAttribute("stroke-dasharray") === null);
  d.getElementById("btn-aoe-clear").click();
  check("clear-all removes AoEs", d.querySelectorAll("#aoe-layer path").length === 0);
  d.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: "b", bubbles: true }));

  // ---------------- Test 10: autosave + restore round-trip ----------------
  console.log("\n[10] Autosave round-trip");
  await sleep(1000); // autosave debounce is 800ms
  const saved = window.localStorage.getItem("foggymap.session.v1");
  check("autosave wrote localStorage", !!saved);
  let parsed = null;
  try { parsed = JSON.parse(saved); } catch {}
  check("autosave JSON valid, version 2", parsed?.version === 2);
  check("autosave kept tokens", Array.isArray(parsed?.tokens) && parsed.tokens.length === 2, `n=${parsed?.tokens?.length}`);
  check("autosave kept grid calibration", Math.abs((parsed?.grid?.cellSize ?? 0) - 25) < 0.6);

  // boot a second instance from that storage
  const second = await boot({ storage: { "foggymap.session.v1": saved } });
  const d2 = second.window.document;
  const ok2 = await waitFor(() => d2.getElementById("map-canvas").width === 400 && d2.querySelectorAll("#token-layer .token").length === 2);
  check("second boot restores map + tokens", ok2);
  check("second boot no errors", second.errors.length === 0, second.errors[0]);

  // ---------------- Test 11: corrupted session is handled ----------------
  console.log("\n[11] Corrupted localStorage session");
  const third = await boot({ storage: { "foggymap.session.v1": "{not json" } });
  check("corrupt session doesn't crash boot", third.errors.length === 0, third.errors[0]);
  check("falls back to empty state", !third.window.document.getElementById("drop-hint").hidden);

  // ---------------- Test 12: zoom & pan ----------------
  console.log("\n[12] Zoom and pan");
  const zoomTxt = () => d.getElementById("status-zoom").textContent;
  const before = zoomTxt();
  d.getElementById("btn-zoom-in").click();
  check("zoom-in changes zoom status", zoomTxt() !== before, `${before} -> ${zoomTxt()}`);
  d.getElementById("btn-zoom-fit").click();
  check("fit returns to 190%", zoomTxt() === "Zoom: 190%", zoomTxt());
  // wheel zoom
  vp.dispatchEvent(new window.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100, clientX: 400, clientY: 300 }));
  check("wheel zooms in", zoomTxt() !== "Zoom: 190%", zoomTxt());

  // ---------------- Test 13: hostile player token id (regression for fix) ----
  console.log("\n[13] App survives a token id containing a quote");
  // A malicious player can send token-add with id 'pwn"]' — only .slice(0,40)
  // guards it. Unescaped, it makes querySelector('[data-id="..."]') throw in
  // positionTokenEl/updateTokenFogVisibility. This test FAILS until ids are
  // sanitized (e.g. /^[\w-]{1,40}$/) or CSS.escape() is used at query sites.
  const evil = { id: 'pwn"]', x: 50, y: 50, size: 40, color: "#e74c3c",
    label: "Evil", shape: "circle", imageId: null };
  const evilSession = { app: "foggymap", version: 2, map: mapUrl, tokens: [evil] };
  const evilBoot = await boot({ storage: { "foggymap.session.v1": JSON.stringify(evilSession) } });
  const dE = evilBoot.window.document;
  await waitFor(() => dE.getElementById("map-canvas").width === 400);
  dE.getElementById("btn-player-view").click(); // triggers updateTokenFogVisibility
  await sleep(300);
  check("player-view toggle survives hostile token id", evilBoot.errors.length === 0,
    evilBoot.errors[0]?.split("\n")[0]);

  // ---------------- Test 14: export player PNG ----------------
  console.log("\n[14] Export player view PNG");
  let exportErr = null;
  try { d.getElementById("btn-export-png").click(); } catch (e) { exportErr = e; }
  await sleep(300);
  check("export does not throw", !exportErr, exportErr?.message);
  check("export sets status", d.getElementById("status-save").textContent.includes("exported"),
    d.getElementById("status-save").textContent);

  // ---------------- summary ----------------
  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  if (failures.length) failures.forEach((f) => console.log("FAIL:", f));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(1); });
