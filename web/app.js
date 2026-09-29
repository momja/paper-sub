// Infinite canvas viewer.
//
// The server is the source of truth: every frame arrives over SSE and every
// move/resize is POSTed back. Nothing here edits design content — that is the
// CLI's job — so the interaction model is deliberately small: pan, zoom, move,
// resize, and step inside a frame to poke at it.
//
// Rendering is layered so that the size of the board never reaches the DOM:
//   gl.js       WebGL draws every frame from a thumbnail in one call
//   thumbs.js   picks each frame's thumbnail resolution from its screen size
//   live.js     real iframes, only for the few frames you are zoomed in on
//   overlay.js  names, selection, handles
// Frames have no DOM nodes, so input is hit-tested here against their rects.

import { GLRenderer } from './gl.js';
import { Thumbs, serverSource, localSource, embeddedSource, packRGBA } from './thumbs.js';
import { LiveLayer } from './live.js';
import { Overlay, HANDLE } from './overlay.js';
import { Grid } from './grid.js';

const viewport = document.getElementById('viewport');
const world = document.getElementById('world');
const emptyState = document.getElementById('empty');
const connDot = document.getElementById('conn');
const countEl = document.getElementById('count');
const zoomLevelEl = document.getElementById('zoomlevel');
const toastEl = document.getElementById('toast');
const helpEl = document.getElementById('help');
const perfEl = document.getElementById('perf');

// A view-only export (src/export.js) carries its frames inline and has no
// server behind it: frames can be looked at and stepped into, never changed.
const READONLY = document.body.classList.contains('readonly');
const EXPORTED = READONLY ? JSON.parse(document.getElementById('paper-data').textContent) : null;

const MIN_SCALE = 0.001;
const MAX_SCALE = 4;
/** Zoom at which visible frames get real iframes… */
const LIVE_SCALE = 0.5;
/** …and the zoom they are kept until, so hovering at the threshold doesn't thrash. */
const LIVE_KEEP = 0.4;
/** Most iframes alive at once, besides the one you are interacting with. */
const LIVE_CAP = 12;
/** A frame this wide on screen with no thumbnail yet gets an iframe meanwhile… */
const FALLBACK_W = 160;
/** …once it has waited this long; thumbnails usually beat an iframe's load. */
const FALLBACK_MS = 700;
/** Thumbnail ceiling while zoomed in far enough for iframes to cover frames. */
const COVERED_LEVEL = 1024;

/** @type {Map<string, any>} */
const frames = new Map();
/** Frames bottom to top; the instance buffer mirrors this order. */
let order = [];
/** id → index into `order` (and the instance buffer) */
let slotOf = new Map();
/**
 * Frames lifted above the stack by selection, topmost last. They are drawn a
 * second time after everything else, so raising one rewrites a few instances
 * instead of the whole buffer; after RAISED_MAX they fold back into `order`.
 */
const raised = [];
const RAISED_MAX = 32;
/** Stacking position: raised frames above every frame in `order`. */
const zOf = (id) => {
  const f = frames.get(id);
  const j = f ? raised.indexOf(f) : -1;
  return j >= 0 ? order.length + j : (slotOf.get(id) ?? -1);
};
/** Where frames are, for queries that should cost what is on screen. */
const grid = new Grid();
const query = (x0, y0, x1, y1, fn) => grid.query(x0, y0, x1, y1, fn);
let orderDirty = true;
let maxW = 0;
let maxDim = 0;

let view = { x: 0, y: 0, scale: 1 };
let cssW = window.innerWidth;
let cssH = window.innerHeight;
let dpr = window.devicePixelRatio || 1;
let selectedId = null;
let liveId = null;
let hoverId = null;
let hasFitted = false;
let liveZoomed = false;
let lastViewChange = 0;
/** ids the pointer is currently manipulating — incoming updates must not fight the user */
const busy = new Set();
/** id → time an update landed, for the overlay's flash */
const flashes = new Map();
/** The view is a placeholder until the server's state arrives; don't save it. */
let stateSeen = false;

// ------------------------------------------------------------- renderers ---

const renderer = new GLRenderer(document.getElementById('gl'), {
  onRestored() {
    thumbs?.reset(renderer.atlas);
    orderDirty = true;
    invalidate();
    schedulePlan();
  },
});
if (!renderer.ok) viewport.classList.add('no-gl');

const overlay = new Overlay(document.getElementById('overlay'));

const live = new LiveLayer(world, {
  source: (f) =>
    EXPORTED
      ? { srcdoc: f.html }
      : { src: `/api/preview/${encodeURIComponent(f.id)}?r=${f.reloadKey ?? f.contentRev}` },
  onChange: () => {
    invalidate();
    schedulePlan();
  },
});

/** @type {Thumbs | null} created once we know where thumbnails come from */
let thumbs = null;

function startThumbs() {
  if (thumbs || !renderer.ok) return;
  const fetchHtml = async (f) =>
    (await fetch(`/api/preview/${encodeURIComponent(f.id)}?r=${f.contentRev}`)).text();
  const source = EXPORTED
    ? embeddedSource(localSource(async (f) => f.html), EXPORTED.thumbPack)
    : serverSource(localSource(fetchHtml));
  thumbs = new Thumbs({
    atlas: renderer.atlas,
    source,
    onResident(id) {
      if (id) {
        const f = frames.get(id);
        if (f) writeInstance(f);
      } else {
        schedulePlan();
      }
      invalidate();
    },
    onTone(f, tone) {
      f.toneRGBA = tone;
      writeInstance(f);
    },
  });
  for (const f of order) thumbs.track(f);
}

// ------------------------------------------------------------ frame data ---

const colorCtx = document.createElement('canvas').getContext('2d');
const colorCache = new Map();
/** Any CSS colour → packed opaque RGBA, via the canvas's own colour parser. */
function parseColor(css) {
  let packed = colorCache.get(css);
  if (packed === undefined) {
    colorCtx.fillStyle = '#ffffff';
    colorCtx.fillStyle = css;
    const s = colorCtx.fillStyle;
    const n =
      s[0] === '#'
        ? [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16))
        : s.match(/[\d.]+/g).slice(0, 3).map(Number);
    packed = packRGBA(n[0], n[1], n[2]);
    colorCache.set(css, packed);
  }
  return packed;
}

/** What a frame looks like with no thumbnail: its average colour, else its background. */
const toneOf = (f) => f.toneRGBA ?? (f.toneRGBA = parseColor(f.tone || f.background || '#ffffff'));

function writeInstance(f) {
  const i = slotOf.get(f.id);
  if (i === undefined || !renderer.ok || orderDirty) return;
  const tone = toneOf(f);
  const slot = thumbs?.slot(f.id) ?? null;
  renderer.setInstance(i, f.x, f.y, f.w, f.h, tone, slot);
  const j = raised.indexOf(f);
  if (j >= 0) renderer.setInstance(order.length + j, f.x, f.y, f.w, f.h, tone, slot);
}

/** Rewrite just the raised copies at the end of the instance buffer. */
function writeRaised() {
  if (!renderer.ok || orderDirty) return;
  renderer.setCount(order.length + raised.length, { preserve: true });
  for (const f of raised) writeInstance(f);
  live.restack(zOf);
}

function rebuild() {
  orderDirty = false;
  slotOf = new Map();
  maxW = 0;
  maxDim = 0;
  for (let i = 0; i < order.length; i++) {
    const f = order[i];
    slotOf.set(f.id, i);
    if (f.w > maxW) maxW = f.w;
    maxDim = Math.max(maxDim, f.w, f.h);
  }
  if (renderer.ok) {
    renderer.setCount(order.length + raised.length);
    for (const f of order) writeInstance(f);
  }
  live.restack(zOf);
}

function upsert(data) {
  let f = frames.get(data.id);
  if (!f) {
    f = { ...data };
    frames.set(f.id, f);
    order.push(f);
    grid.insert(f);
    thumbs?.track(f);
    orderDirty = true;
    return;
  }
  // Mid-drag: accept content changes, ignore geometry so we don't jump.
  if (busy.has(f.id)) data = { ...data, x: f.x, y: f.y, w: f.w, h: f.h };
  const contentChanged = data.contentRev !== f.contentRev;
  if (data.tone !== f.tone || data.background !== f.background) f.toneRGBA = undefined;
  const versionChanged = data.tv !== f.tv;
  Object.assign(f, data);
  if (versionChanged) thumbs?.track(f);
  if (contentChanged) {
    f.reloadKey = undefined;
    live.update(f);
    flashes.set(f.id, performance.now());
  }
  frameMoved(f);
}

function removeFrames(ids) {
  const gone = new Set();
  for (const id of ids) {
    const f = frames.get(id);
    if (!f) continue;
    f.removed = true;
    frames.delete(id);
    grid.remove(f);
    gone.add(f);
    thumbs?.drop(f);
    live.remove(id);
    flashes.delete(id);
    if (selectedId === id) select(null);
    if (liveId === id) setLive(null);
    if (hoverId === id) hoverId = null;
  }
  if (gone.size) {
    order = order.filter((f) => !gone.has(f));
    for (let j = raised.length - 1; j >= 0; j--) if (gone.has(raised[j])) raised.splice(j, 1);
    orderDirty = true;
  }
}

/** Geometry changed locally or from the server: push it to every layer. */
function frameMoved(f) {
  grid.update(f);
  writeInstance(f);
  live.place(f);
  if (f.w > maxW) maxW = f.w;
  maxDim = Math.max(maxDim, f.w, f.h);
  if (selectedId === f.id) updateInspector(f);
  invalidate();
}

function reconcile(list) {
  const seen = new Set();
  for (const data of list) {
    seen.add(data.id);
    upsert(data);
  }
  removeFrames([...frames.keys()].filter((id) => !seen.has(id)));
  afterChange();
}

function afterChange() {
  refreshChrome();
  invalidate();
  schedulePlan();
  if (!hasFitted && frames.size) {
    hasFitted = true;
    const target = decodeURIComponent(location.hash.slice(1));
    const focus = order.find((f) => f.id === target || f.name === target);
    if (focus) fitTo([focus], { padding: 140 });
    else fitTo(order);
  }
}

/** Frame count and empty state, driven off whatever is actually loaded. */
function refreshChrome() {
  const n = frames.size;
  countEl.textContent = `${n.toLocaleString()} frame${n === 1 ? '' : 's'}`;
  emptyState.classList.toggle('show', n === 0);
}

// ---------------------------------------------------------------- render ---

let rafPending = false;
function invalidate() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(render);
}

let worldTransform = '';
function render() {
  rafPending = false;
  const t0 = performance.now();
  if (orderDirty) rebuild();
  const moreUploads = thumbs ? thumbs.upload(6) : false;
  renderer.draw(view, dpr);

  const transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  if (transform !== worldTransform) {
    world.style.transform = transform;
    worldTransform = transform;
  }

  const animating = overlay.draw({
    query,
    byId: (id) => frames.get(id),
    maxW,
    view,
    selected: selectedId,
    hover: hoverId,
    interactive: liveId,
    readonly: READONLY,
    flashes,
    now: t0,
  });
  perfSample(performance.now() - t0);
  if (moreUploads || animating) invalidate();
}

function viewChanged() {
  lastViewChange = performance.now();
  if (!renderer.ok) paintCssGrid();
  zoomLevelEl.textContent = `${Math.round(view.scale * 100)}%`;
  invalidate();
  schedulePlan();
  saveViewport();
}

// Without WebGL the dot grid falls back to the viewport's CSS background.
function paintCssGrid() {
  let spacing = 32 * view.scale;
  while (spacing < 18) spacing *= 4;
  while (spacing > 90) spacing /= 4;
  viewport.style.setProperty('--dot-size', `${spacing}px`);
  viewport.style.setProperty('--dot-x', `${mod(view.x, spacing)}px`);
  viewport.style.setProperty('--dot-y', `${mod(view.y, spacing)}px`);
}

const mod = (n, m) => ((n % m) + m) % m;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function resize() {
  cssW = window.innerWidth;
  cssH = window.innerHeight;
  dpr = window.devicePixelRatio || 1;
  if (renderer.ok) renderer.resize(cssW, cssH, dpr);
  overlay.resize(cssW, cssH, dpr);
  invalidate();
  schedulePlan();
}
window.addEventListener('resize', resize);
// Dragging the window to a display with a different pixel ratio.
(function watchDpr() {
  matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
    'change',
    () => {
      resize();
      watchDpr();
    },
    { once: true }
  );
})();

// ------------------------------------------------------------------ plan ---
// What should be resident — thumbnail levels and live iframes — is worked out
// a few times a second, not every frame, and never mounts iframes mid-gesture.

let planTimer = null;
let lastPlan = 0;
function schedulePlan() {
  if (planTimer) return;
  planTimer = setTimeout(plan, Math.max(0, 100 - (performance.now() - lastPlan)));
}

function visibleRect() {
  const s = view.scale;
  return { x0: -view.x / s, y0: -view.y / s, x1: (cssW - view.x) / s, y1: (cssH - view.y) / s };
}

const planCost = { thumbs: 0, live: 0 };
function plan() {
  clearTimeout(planTimer);
  planTimer = null;
  lastPlan = performance.now();
  const t0 = lastPlan;
  const rect = visibleRect();
  // An iframe on top makes a sharp thumbnail wasted memory: keep what a ready
  // one covers as it is, and cap the rest while zoomed in to live range.
  if (orderDirty) rebuild(); // maxDim and stacking
  thumbs?.plan({
    rect,
    query,
    maxDim,
    pxPerUnit: view.scale * dpr,
    ceiling: (id) => (live.ready(id) ? 0 : liveZoomed ? COVERED_LEVEL : Infinity),
  });
  const t1 = performance.now();
  const waiting = planLive(rect);
  planCost.thumbs = Math.max(planCost.thumbs, t1 - t0);
  planCost.live = Math.max(planCost.live, performance.now() - t1);
  if (waiting) schedulePlan(); // come back once the gesture stops or a grace period ends
}

/** Choose which frames get iframes. Returns true when it wants to run again soon. */
function planLive(rect) {
  const s = view.scale;
  const now = performance.now();
  const settled = now - lastViewChange > 140;
  let waiting = !settled;
  if (s >= LIVE_SCALE) liveZoomed = true;
  else if (s < LIVE_KEEP) liveZoomed = false;
  // Without WebGL there are no thumbnails; iframes are all there is.
  const noThumbs = !renderer.ok || Boolean(thumbs?.broken);
  const fallbackW = noThumbs ? 24 : FALLBACK_W;

  const want = [];
  // Zoomed out with nothing big enough to qualify, skip the walk entirely.
  const anyCandidate = liveZoomed || maxW * s >= fallbackW * 0.75;
  if (anyCandidate) query(rect.x0, rect.y0, rect.x1, rect.y1, (f) => {
    const mounted = live.mounted(f.id);
    let bare = false;
    if (!liveZoomed && !thumbs?.has(f.id) && f.w * s >= (mounted ? fallbackW * 0.75 : fallbackW)) {
      f.bareSince ??= now;
      bare = mounted || noThumbs || now - f.bareSince >= FALLBACK_MS;
      if (!bare) waiting = true;
    } else {
      f.bareSince = undefined;
    }
    const eligible = liveZoomed || f.id === liveId || bare;
    if (!eligible || (!settled && !mounted && f.id !== liveId)) return;
    const w = Math.min(f.x + f.w, rect.x1) - Math.max(f.x, rect.x0);
    const h = Math.min(f.y + f.h, rect.y1) - Math.max(f.y, rect.y0);
    want.push({ f, area: w * h });
  });
  want.sort((a, b) => b.area - a.area);
  const chosen = want.slice(0, noThumbs ? LIVE_CAP * 3 : LIVE_CAP).map((w) => w.f);
  const current = liveId && frames.get(liveId);
  if (current && !chosen.includes(current)) chosen.push(current);
  live.show(chosen, zOf);
  return waiting;
}

// -------------------------------------------------------------- viewport ---

function zoomTo(scale, cx, cy) {
  const next = clamp(scale, MIN_SCALE, MAX_SCALE);
  const px = cx ?? cssW / 2;
  const py = cy ?? cssH / 2;
  view.x = px - (px - view.x) * (next / view.scale);
  view.y = py - (py - view.y) * (next / view.scale);
  view.scale = next;
  viewChanged();
}

function bounds(list) {
  if (!list.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const f of list) {
    x0 = Math.min(x0, f.x);
    y0 = Math.min(y0, f.y);
    x1 = Math.max(x1, f.x + f.w);
    y1 = Math.max(y1, f.y + f.h);
  }
  return { x0, y0, x1, y1 };
}

function fitTo(list, { padding = 60, maxScale = 1 } = {}) {
  const b = bounds(list);
  if (!b) return;
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;

  // Fit into the space the floating chrome leaves free, not the raw window,
  // so nothing lands underneath the toolbars or the inspector.
  const inset = {
    top: padding + 48,
    bottom: padding + 48,
    left: padding,
    right: padding + (document.getElementById('inspector').classList.contains('show') ? 290 : 0),
  };
  const availW = Math.max(120, cssW - inset.left - inset.right);
  const availH = Math.max(120, cssH - inset.top - inset.bottom);

  const scale = clamp(Math.min(availW / w, availH / h), MIN_SCALE, maxScale);
  view.scale = scale;
  view.x = inset.left + (availW - w * scale) / 2 - b.x0 * scale;
  view.y = inset.top + (availH - h * scale) / 2 - b.y0 * scale;
  viewChanged();
}

// ------------------------------------------------------------- selection ---

function select(id) {
  if (selectedId === id) return;
  selectedId = id;
  const f = frames.get(id);
  if (f) {
    raise(f);
    updateInspector(f);
  }
  document.getElementById('inspector').classList.toggle('show', Boolean(f) && !READONLY);
  invalidate();
}

/** Bring a frame to the top of the stack, like clicking a window. */
function raise(f) {
  const j = raised.indexOf(f);
  if (j !== -1 && j === raised.length - 1) return;
  if (j !== -1) raised.splice(j, 1);
  raised.push(f);
  if (raised.length > RAISED_MAX) {
    // Fold the oldest back into the stack proper: one full rebuild, rarely.
    const old = raised.shift();
    const i = order.indexOf(old);
    if (i !== -1) order.splice(i, 1);
    order.push(old);
    orderDirty = true;
    return;
  }
  writeRaised();
}

function setLive(id) {
  liveId = id;
  live.setInteractive(id);
  if (id && frames.has(id)) toast('Interacting with <b>' + escapeHtml(frames.get(id).name) + '</b> — esc to exit');
  plan();
  invalidate();
}

function enterFrame(f) {
  if (liveId === f.id) return;
  select(f.id);
  setLive(f.id);
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const insName = document.getElementById('ins-name');
const insId = document.getElementById('ins-id');
const insCli = document.getElementById('ins-cli');
const insW = document.getElementById('ins-w');
const insH = document.getElementById('ins-h');
const insX = document.getElementById('ins-x');
const insY = document.getElementById('ins-y');

function updateInspector(frame) {
  insName.textContent = frame.name;
  insId.textContent = frame.id;
  insW.textContent = Math.round(frame.w);
  insH.textContent = Math.round(frame.h);
  insX.textContent = Math.round(frame.x);
  insY.textContent = Math.round(frame.y);
  insCli.textContent = `paper set ${quoteArg(frame.name)} --file design.html`;
  markActivePreset(frame);
}

const quoteArg = (s) => (/^[\w.-]+$/.test(s) ? s : JSON.stringify(s));

// ----------------------------------------------------------- size presets --

// Mirrors the CLI's --preset table (src/cli.js); keep the two in step.
const SIZE_PRESETS = [
  { name: 'mobile', label: 'Mobile', w: 390, h: 844 },
  { name: 'tablet', label: 'Tablet', w: 834, h: 1112 },
  { name: 'laptop', label: 'Laptop', w: 1280, h: 800 },
  { name: 'desktop', label: 'Desktop', w: 1440, h: 900 },
  { name: 'wide', label: 'Wide', w: 1920, h: 1080 },
];

const presetsEl = document.getElementById('ins-presets');

for (const preset of SIZE_PRESETS) {
  const btn = document.createElement('button');
  btn.className = 'chip';
  btn.textContent = preset.label;
  btn.title = `${preset.w} × ${preset.h} — paper resize --preset ${preset.name}`;
  btn.addEventListener('click', () => applyPreset(preset));
  presetsEl.appendChild(btn);
}

/** Resize the selected frame in place — position stays put, only w/h change. */
function applyPreset(preset) {
  const f = frames.get(selectedId);
  if (!f) return;
  f.w = preset.w;
  f.h = preset.h;
  frameMoved(f);
  commit(f.id, { w: preset.w, h: preset.h });
  toast(`<b>${escapeHtml(f.name)}</b> → ${preset.w} × ${preset.h}`);
}

function markActivePreset(frame) {
  const w = Math.round(frame.w);
  const h = Math.round(frame.h);
  presetsEl.childNodes.forEach((btn, i) => {
    const preset = SIZE_PRESETS[i];
    btn.classList.toggle('on', preset.w === w && preset.h === h);
  });
}

insCli.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(insCli.textContent);
    insCli.classList.add('copied');
    setTimeout(() => insCli.classList.remove('copied'), 900);
  } catch {
    /* clipboard may be blocked; the text is selectable anyway */
  }
});

// ------------------------------------------------------------ hit testing --

const screenRect = (f) => [f.x * view.scale + view.x, f.y * view.scale + view.y, f.w * view.scale, f.h * view.scale];

/** Topmost frame under a screen point: bodies first, then the names above them. */
function frameAt(sx, sy) {
  const wx = (sx - view.x) / view.scale;
  const wy = (sy - view.y) / view.scale;
  if (orderDirty) rebuild(); // slotOf must match the stack
  let top = null;
  let topZ = -1;
  query(wx, wy, wx + 1e-6, wy + 1e-6, (f) => {
    const z = zOf(f.id);
    if (z > topZ) {
      top = f;
      topZ = z;
    }
  });
  if (top) return top;
  const id = overlay.labelAt(sx, sy);
  return id ? frames.get(id) : null;
}

/** Which resize grip of the selected frame is under a screen point, if any. */
function gripAt(sx, sy) {
  if (READONLY || !selectedId || liveId === selectedId) return null;
  const f = frames.get(selectedId);
  if (!f) return null;
  const [x, y, w, h] = screenRect(f);
  const r = HANDLE / 2 + 2;
  const near = (px, py) => Math.abs(sx - px) <= r && Math.abs(sy - py) <= r;
  if (near(x, y)) return 'nw';
  if (near(x + w, y)) return 'ne';
  if (near(x, y + h)) return 'sw';
  if (near(x + w, y + h)) return 'se';
  const band = 4;
  const inX = sx >= x && sx <= x + w;
  const inY = sy >= y && sy <= y + h;
  if (inX && Math.abs(sy - y) <= band) return 'n';
  if (inX && Math.abs(sy - (y + h)) <= band) return 's';
  if (inY && Math.abs(sx - x) <= band) return 'w';
  if (inY && Math.abs(sx - (x + w)) <= band) return 'e';
  return null;
}

const CURSORS = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
};

// --------------------------------------------------------------- gestures --

// Pointer capture throws if the pointer is already gone (fast clicks, synthetic
// input). Losing capture is survivable; losing the whole gesture is not.
const capture = (el, id) => {
  try {
    el.setPointerCapture(id);
  } catch {
    /* gesture still works via bubbling */
  }
};
const release = (el, id) => {
  try {
    el.releasePointerCapture(id);
  } catch {
    /* already released */
  }
};

/** Track one pointer until it lifts. */
function drag(ev, onMove, onUp = () => {}) {
  ev.preventDefault();
  capture(viewport, ev.pointerId);
  const move = (e) => {
    if (e.pointerId === ev.pointerId) onMove(e);
  };
  const up = (e) => {
    if (e.pointerId !== ev.pointerId) return;
    release(viewport, ev.pointerId);
    viewport.removeEventListener('pointermove', move);
    viewport.removeEventListener('pointerup', up);
    viewport.removeEventListener('pointercancel', up);
    onUp(e);
  };
  viewport.addEventListener('pointermove', move);
  viewport.addEventListener('pointerup', up);
  viewport.addEventListener('pointercancel', up);
}

function startPan(ev) {
  const start = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y };
  viewport.classList.add('panning');
  drag(
    ev,
    (e) => {
      view.x = start.vx + (e.clientX - start.x);
      view.y = start.vy + (e.clientY - start.y);
      viewChanged();
    },
    () => viewport.classList.remove('panning')
  );
}

function startMove(ev, f) {
  const origin = { x: f.x, y: f.y };
  const start = { x: ev.clientX, y: ev.clientY };
  let moved = false;
  busy.add(f.id);
  drag(
    ev,
    (e) => {
      if (Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) > 3) moved = true;
      if (!moved) return;
      let dx = (e.clientX - start.x) / view.scale;
      let dy = (e.clientY - start.y) / view.scale;
      if (e.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      f.x = Math.round(origin.x + dx);
      f.y = Math.round(origin.y + dy);
      frameMoved(f);
    },
    () => {
      busy.delete(f.id);
      if (moved) {
        commit(f.id, { x: f.x, y: f.y });
        schedulePlan();
      }
    }
  );
}

function startResize(ev, f, dir) {
  const origin = { x: f.x, y: f.y, w: f.w, h: f.h };
  const start = { x: ev.clientX, y: ev.clientY };
  busy.add(f.id);
  drag(
    ev,
    (e) => {
      const dx = (e.clientX - start.x) / view.scale;
      const dy = (e.clientY - start.y) / view.scale;
      let { x, y, w, h } = origin;

      if (dir.includes('e')) w = origin.w + dx;
      if (dir.includes('s')) h = origin.h + dy;
      if (dir.includes('w')) {
        w = origin.w - dx;
        x = origin.x + dx;
      }
      if (dir.includes('n')) {
        h = origin.h - dy;
        y = origin.y + dy;
      }

      // Corner drags with shift keep the frame's aspect ratio.
      if (e.shiftKey && dir.length === 2) {
        const ratio = origin.w / origin.h;
        if (Math.abs(w - origin.w) > Math.abs(h - origin.h)) h = w / ratio;
        else w = h * ratio;
        if (dir.includes('w')) x = origin.x + (origin.w - w);
        if (dir.includes('n')) y = origin.y + (origin.h - h);
      }

      Object.assign(f, {
        x: Math.round(x),
        y: Math.round(y),
        w: Math.max(80, Math.round(w)),
        h: Math.max(80, Math.round(h)),
      });
      frameMoved(f);
    },
    () => {
      busy.delete(f.id);
      const { x, y, w, h } = f;
      commit(f.id, { x, y, w, h });
      schedulePlan();
    }
  );
}

async function commit(id, patch) {
  try {
    await fetch(`/api/frames/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  } catch {
    toast('Could not save — is <b>paper serve</b> still running?');
  }
}

let spaceHeld = false;

viewport.addEventListener('pointerdown', (ev) => {
  if (ev.button === 1 || (ev.button === 0 && spaceHeld)) return startPan(ev);
  if (ev.button !== 0) return;
  const grip = gripAt(ev.clientX, ev.clientY);
  if (grip) return startResize(ev, frames.get(selectedId), grip);

  // The interactive frame's iframe takes its own events, so a press that
  // reaches us is always outside it.
  const f = frameAt(ev.clientX, ev.clientY);
  if (liveId && f?.id !== liveId) setLive(null);
  if (!f) {
    select(null);
    return startPan(ev);
  }
  if (READONLY) return startPan(ev); // no moving or resizing; a drag pans instead
  select(f.id);
  startMove(ev, f);
});

viewport.addEventListener('dblclick', (ev) => {
  const f = frameAt(ev.clientX, ev.clientY);
  if (!f) return;
  ev.preventDefault();
  enterFrame(f);
});

// Hover: brighten the name under the pointer, show resize cursors on grips.
let hoverPoint = null;
let hoverQueued = false;
viewport.addEventListener('pointermove', (ev) => {
  if (ev.buttons) return;
  hoverPoint = [ev.clientX, ev.clientY];
  if (hoverQueued) return;
  hoverQueued = true;
  requestAnimationFrame(() => {
    hoverQueued = false;
    if (!hoverPoint) return;
    const [sx, sy] = hoverPoint;
    const grip = gripAt(sx, sy);
    viewport.style.cursor = grip ? CURSORS[grip] : '';
    const id = grip ? selectedId : (frameAt(sx, sy)?.id ?? null);
    if (id !== hoverId) {
      hoverId = id;
      invalidate();
    }
  });
});
viewport.addEventListener('pointerleave', () => {
  hoverPoint = null;
  if (hoverId) {
    hoverId = null;
    invalidate();
  }
});

viewport.addEventListener(
  'wheel',
  (ev) => {
    ev.preventDefault();
    if (ev.ctrlKey || ev.metaKey) {
      // Trackpad pinch and ⌘-scroll both arrive here with ctrlKey set.
      const factor = Math.exp(-ev.deltaY * 0.01);
      zoomTo(view.scale * factor, ev.clientX, ev.clientY);
    } else {
      view.x -= ev.deltaX;
      view.y -= ev.deltaY;
      viewChanged();
    }
  },
  { passive: false }
);

// --------------------------------------------------------------- keyboard --

window.addEventListener('keydown', (ev) => {
  if (ev.code === 'Space' && !spaceHeld) {
    spaceHeld = true;
    viewport.classList.add('space-held');
  }

  const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
  if (typing || ev.metaKey || ev.ctrlKey) return;

  switch (ev.key) {
    case 'Escape':
      if (liveId) setLive(null);
      else select(null);
      helpEl.classList.remove('show');
      break;
    case '?':
      helpEl.classList.toggle('show');
      break;
    case 'f':
    case 'F':
      fitTo(order);
      break;
    case '0':
      zoomTo(1);
      break;
    case '1':
      if (selectedId) fitTo([frames.get(selectedId)], { padding: 140 });
      break;
    case 'r':
    case 'R': {
      const f = frames.get(selectedId);
      if (f) {
        f.reloadKey = `${f.contentRev}-${Date.now()}`;
        live.reload(f);
        flashes.set(f.id, performance.now());
        invalidate();
      }
      break;
    }
    case 'p':
    case 'P':
      perf.on = !perf.on;
      perfEl.classList.toggle('show', perf.on);
      break;
    case '=':
    case '+':
      zoomTo(view.scale * 1.25);
      break;
    case '-':
    case '_':
      zoomTo(view.scale / 1.25);
      break;
    case 'Backspace':
    case 'Delete': {
      if (!selectedId || liveId || READONLY) break;
      ev.preventDefault();
      const name = frames.get(selectedId)?.name;
      fetch(`/api/frames/${encodeURIComponent(selectedId)}`, { method: 'DELETE' })
        .then(() => toast(`Removed <b>${escapeHtml(name)}</b>`))
        .catch(() => toast('Could not delete'));
      break;
    }
  }
});

window.addEventListener('keyup', (ev) => {
  if (ev.code === 'Space') {
    spaceHeld = false;
    viewport.classList.remove('space-held');
  }
});

document.getElementById('btn-in').onclick = () => zoomTo(view.scale * 1.25);
document.getElementById('btn-out').onclick = () => zoomTo(view.scale / 1.25);
document.getElementById('btn-fit').onclick = () => fitTo(order);
zoomLevelEl.onclick = () => zoomTo(1);
document.getElementById('btn-help').onclick = () => helpEl.classList.toggle('show');
helpEl.onclick = () => helpEl.classList.remove('show');

// ------------------------------------------------------------- transport ---

// The event stream only carries small messages: `hello` on every (re)connect
// and `refresh` after a change too big to send as a diff both mean "fetch the
// whole state"; `patch` carries the frames that changed. Patches that land
// while a fetch is in flight are replayed on top of it, newest last.
let source = null;
let loading = null;
let queued = [];
let refetch = false;

async function loadState() {
  if (loading) {
    refetch = true; // the response in flight may predate whatever prompted this
    return loading;
  }
  loading = (async () => {
    try {
      const res = await fetch('/api/state');
      if (!res.ok) throw new Error(`state ${res.status}`);
      const state = await res.json();
      stateSeen = true;
      startThumbs();
      // A #frame deep link beats the saved viewport — the caller asked for that
      // frame specifically, so let reconcile() zoom to it instead.
      const wantsFocus = Boolean(location.hash.slice(1));
      if (
        !wantsFocus &&
        !hasFitted &&
        state.viewport &&
        (state.viewport.x || state.viewport.y || state.viewport.scale !== 1)
      ) {
        view = { ...state.viewport };
        hasFitted = true;
        viewChanged();
      }
      reconcile(state.frames);
      const late = queued.filter((p) => p.rev === undefined || p.rev >= state.rev);
      queued = [];
      for (const patch of late) applyPatch(patch);
    } catch {
      connDot.classList.add('off');
      setTimeout(() => {
        loading = null;
        loadState();
      }, 1500);
      return;
    }
    loading = null;
    if (refetch) {
      refetch = false;
      loadState();
    }
  })();
  return loading;
}

function applyPatch({ frames: changed, removed }) {
  for (const f of changed) upsert(f);
  removeFrames(removed);
  afterChange();
}

function connect() {
  source = new EventSource('/api/events');

  source.addEventListener('open', () => connDot.classList.remove('off'));
  source.addEventListener('hello', () => {
    connDot.classList.remove('off');
    loadState();
  });
  source.addEventListener('refresh', () => loadState());
  source.addEventListener('patch', (ev) => {
    const patch = JSON.parse(ev.data);
    if (loading) queued.push(patch);
    else applyPatch(patch);
  });

  source.addEventListener('error', () => {
    connDot.classList.add('off');
    // EventSource retries on its own; this only covers a hard close.
    if (source.readyState === EventSource.CLOSED) setTimeout(connect, 1500);
  });
}

let saveTimer = null;
function saveViewport() {
  // Until the server's state arrives, the view is a placeholder, not a choice.
  if (READONLY || !stateSeen) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fetch('/api/viewport', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(view),
    }).catch(() => {});
  }, 600);
}

let toastTimer = null;
function toast(html) {
  toastEl.innerHTML = html;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2400);
}

// ------------------------------------------------------------------ perf --
// `P` toggles a readout of what the renderer is doing.

const perf = { on: false, frames: 0, cpu: 0, worst: 0, since: performance.now(), last: null };

function perfSample(ms) {
  perf.frames++;
  perf.cpu += ms;
  perf.worst = Math.max(perf.worst, ms);
  const now = performance.now();
  if (now - perf.since < 500) return;
  perf.last = { fps: (perf.frames * 1000) / (now - perf.since), avgMs: perf.cpu / perf.frames, worstMs: perf.worst };
  if (perf.on) perfEl.textContent = perfText(perf.last.fps, perf.last.avgMs, perf.last.worstMs);
  perf.frames = 0;
  perf.cpu = 0;
  perf.worst = 0;
  perf.since = now;
}

function perfText(fps, avg, worst) {
  const mb = (b) => (b / 1048576).toFixed(0);
  const atlas = renderer.ok ? renderer.atlas : null;
  return [
    `${fps.toFixed(0)} fps · ${avg.toFixed(2)} ms/frame cpu (worst ${worst.toFixed(1)})`,
    `${frames.size.toLocaleString()} frames · ${live.size} live iframe${live.size === 1 ? '' : 's'}`,
    thumbs
      ? `${thumbs.resident.size.toLocaleString()} textures · atlas ${mb(atlas.used)}/${mb(atlas.bytes)} MB · ${thumbs.inflight} loading`
      : renderer.ok
        ? 'no thumbnails yet'
        : 'WebGL2 unavailable: iframes only',
  ].join('\n');
}

// A small handle for scripted benchmarks and debugging from the console.
window.paper = {
  get view() {
    return { ...view };
  },
  setView(x, y, scale) {
    view = { x, y, scale: clamp(scale, MIN_SCALE, MAX_SCALE) };
    viewChanged();
  },
  fit: () => fitTo(order),
  stats: () => ({
    frames: frames.size,
    textures: thumbs?.resident.size ?? 0,
    atlasBytes: renderer.ok ? renderer.atlas.bytes : 0,
    atlasUsed: renderer.ok ? renderer.atlas.used : 0,
    live: live.size,
    loading: thumbs?.inflight ?? 0,
    queued: thumbs?.uploads.length ?? 0,
    render: perf.last,
    planMaxMs: { ...planCost },
  }),
  resetPlanCost() {
    planCost.thumbs = planCost.live = 0;
  },
};

// ---------------------------------------------------------------- export --

/** Fetch the export, turning a missing route into advice instead of a bare 404. */
async function fetchExport() {
  const res = await fetch('/api/export?download=1');
  if (res.status === 404) throw new Error('This <b>paper serve</b> predates export. Restart it.');
  if (!res.ok) throw new Error(`Export failed (${res.status})`);
  const disposition = res.headers.get('Content-Disposition') || '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] || 'canvas.html';
  return { html: await res.text(), filename };
}

const kb = (html) => `${(html.length / 1024).toFixed(0)} kb`;

document.getElementById('btn-download').onclick = async () => {
  try {
    const { html, filename } = await fetchExport();
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Downloaded <b>${filename}</b> · ${kb(html)}`);
  } catch (err) {
    toast(err.message);
  }
};

document.getElementById('btn-copy-html').onclick = async () => {
  const pending = fetchExport();
  pending.catch(() => {}); // awaited below; keeps the console free of a duplicate report
  try {
    // A promised ClipboardItem keeps Safari's user-gesture check happy across the fetch.
    await navigator.clipboard.write([
      new ClipboardItem({ 'text/plain': pending.then(({ html }) => new Blob([html], { type: 'text/plain' })) }),
    ]);
  } catch {
    let html;
    try {
      ({ html } = await pending);
    } catch (err) {
      return toast(err.message);
    }
    try {
      await navigator.clipboard.writeText(html);
    } catch {
      return toast('Clipboard blocked. Use <b>Download</b> instead');
    }
  }
  toast(`Copied view-only HTML · ${kb((await pending).html)}`);
};

resize();
viewChanged();
if (EXPORTED) {
  startThumbs();
  reconcile(EXPORTED.frames);
} else {
  connect();
}
