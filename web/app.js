// Infinite canvas viewer.
//
// The server is the source of truth: every frame arrives over SSE and every
// move/resize is POSTed back. Nothing here edits design content — that is the
// CLI's job — so the interaction model is deliberately small: pan, zoom, move,
// resize, and step inside a frame to poke at it.

const viewport = document.getElementById('viewport');
const world = document.getElementById('world');
const emptyState = document.getElementById('empty');
const connDot = document.getElementById('conn');
const countEl = document.getElementById('count');
const zoomLevelEl = document.getElementById('zoomlevel');
const toastEl = document.getElementById('toast');
const helpEl = document.getElementById('help');

const MIN_SCALE = 0.02;
const MAX_SCALE = 4;

/** @type {Map<string, {frame: any, el: HTMLElement, refs: any, contentRev: number}>} */
const views = new Map();

let view = { x: 0, y: 0, scale: 1 };
let selectedId = null;
let liveId = null;
let hasFitted = false;
/** ids the pointer is currently manipulating — incoming updates must not fight the user */
const busy = new Set();

// ---------------------------------------------------------------- render ---

let transformQueued = false;
function applyTransform() {
  if (transformQueued) return;
  transformQueued = true;
  requestAnimationFrame(() => {
    transformQueued = false;
    world.style.transform = `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`;
    world.style.setProperty('--scale', view.scale);
    world.style.setProperty('--inv', 1 / view.scale);

    // Keep dot spacing in a readable band by stepping the base grid in powers of two.
    let spacing = 32 * view.scale;
    while (spacing < 18) spacing *= 4;
    while (spacing > 90) spacing /= 4;
    viewport.style.setProperty('--dot-size', `${spacing}px`);
    viewport.style.setProperty('--dot-x', `${mod(view.x, spacing)}px`);
    viewport.style.setProperty('--dot-y', `${mod(view.y, spacing)}px`);

    zoomLevelEl.textContent = `${Math.round(view.scale * 100)}%`;
    saveViewport();
  });
}

const mod = (n, m) => ((n % m) + m) % m;

function zoomTo(scale, cx, cy) {
  const next = clamp(scale, MIN_SCALE, MAX_SCALE);
  const px = cx ?? window.innerWidth / 2;
  const py = cy ?? window.innerHeight / 2;
  view.x = px - (px - view.x) * (next / view.scale);
  view.y = py - (py - view.y) * (next / view.scale);
  view.scale = next;
  applyTransform();
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function bounds(frames) {
  if (!frames.length) return null;
  return {
    x0: Math.min(...frames.map((f) => f.x)),
    y0: Math.min(...frames.map((f) => f.y)),
    x1: Math.max(...frames.map((f) => f.x + f.w)),
    y1: Math.max(...frames.map((f) => f.y + f.h)),
  };
}

function fitTo(frames, { padding = 60, maxScale = 1 } = {}) {
  const b = bounds(frames);
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
  const availW = Math.max(120, window.innerWidth - inset.left - inset.right);
  const availH = Math.max(120, window.innerHeight - inset.top - inset.bottom);

  const scale = clamp(Math.min(availW / w, availH / h), MIN_SCALE, maxScale);
  view.scale = scale;
  view.x = inset.left + (availW - w * scale) / 2 - b.x0 * scale;
  view.y = inset.top + (availH - h * scale) / 2 - b.y0 * scale;
  applyTransform();
}

// ----------------------------------------------------------------- frames --

function frameHtml() {
  const el = document.createElement('div');
  el.className = 'frame';
  el.innerHTML = `
    <div class="frame-label">
      <span class="frame-name"></span>
      <span class="frame-meta"></span>
      <span class="frame-note"></span>
    </div>
    <div class="live-badge">interactive · esc to exit</div>
    <div class="frame-body">
      <!-- No allow-same-origin: designs render and run scripts in an opaque
           origin so generated markup can't reach back into the canvas. -->
      <iframe sandbox="allow-scripts allow-forms allow-popups" title=""></iframe>
      <div class="frame-flash"></div>
      <div class="frame-shield"></div>
    </div>
    <div class="edge n" data-dir="n"></div>
    <div class="edge s" data-dir="s"></div>
    <div class="edge w" data-dir="w"></div>
    <div class="edge e" data-dir="e"></div>
    <div class="handle nw" data-dir="nw"></div>
    <div class="handle ne" data-dir="ne"></div>
    <div class="handle sw" data-dir="sw"></div>
    <div class="handle se" data-dir="se"></div>`;
  return el;
}

function mountFrame(frame) {
  const el = frameHtml();
  const refs = {
    name: el.querySelector('.frame-name'),
    meta: el.querySelector('.frame-meta'),
    note: el.querySelector('.frame-note'),
    body: el.querySelector('.frame-body'),
    iframe: el.querySelector('iframe'),
    flash: el.querySelector('.frame-flash'),
  };
  const entry = { frame, el, refs, contentRev: -1 };
  views.set(frame.id, entry);
  world.appendChild(el);
  bindFrame(entry);
  paintFrame(entry, frame);
  return entry;
}

function paintFrame(entry, frame) {
  const { el, refs } = entry;
  entry.frame = frame;
  el.style.setProperty('--x', `${frame.x}px`);
  el.style.setProperty('--y', `${frame.y}px`);
  el.style.setProperty('--w', `${frame.w}px`);
  el.style.setProperty('--h', `${frame.h}px`);
  refs.name.textContent = frame.name;
  refs.meta.textContent = `${Math.round(frame.w)} × ${Math.round(frame.h)}`;
  refs.note.textContent = frame.note || '';
  refs.body.style.background = frame.background || '#fff';
  refs.iframe.title = frame.name;

  if (frame.contentRev !== undefined && frame.contentRev !== entry.contentRev) {
    const first = entry.contentRev === -1;
    entry.contentRev = frame.contentRev;
    refs.iframe.src = `/api/preview/${encodeURIComponent(frame.id)}?r=${frame.contentRev}`;
    if (!first) flash(entry);
  }
  if (selectedId === frame.id) updateInspector(frame);
}

function flash(entry) {
  const { flash: node } = entry.refs;
  node.classList.remove('on');
  void node.offsetWidth; // restart the animation
  node.classList.add('on');
}

function unmountFrame(id) {
  const entry = views.get(id);
  if (!entry) return;
  entry.el.remove();
  views.delete(id);
  if (selectedId === id) select(null);
  if (liveId === id) liveId = null;
  refreshChrome();
}

/** Frame count and empty state, driven off whatever is actually mounted. */
function refreshChrome() {
  const n = views.size;
  countEl.textContent = `${n} frame${n === 1 ? '' : 's'}`;
  emptyState.classList.toggle('show', n === 0);
}

function reconcile(frames) {
  const seen = new Set();
  for (const frame of frames) {
    seen.add(frame.id);
    const entry = views.get(frame.id);
    if (!entry) {
      mountFrame(frame);
    } else if (!busy.has(frame.id)) {
      paintFrame(entry, frame);
    } else {
      // Mid-drag: accept content changes, ignore geometry so we don't jump.
      entry.frame = { ...frame, x: entry.frame.x, y: entry.frame.y, w: entry.frame.w, h: entry.frame.h };
      if (frame.contentRev !== entry.contentRev) {
        entry.contentRev = frame.contentRev;
        entry.refs.iframe.src = `/api/preview/${encodeURIComponent(frame.id)}?r=${frame.contentRev}`;
      }
    }
  }
  for (const id of [...views.keys()]) if (!seen.has(id)) unmountFrame(id);
  refreshChrome();

  if (!hasFitted && frames.length) {
    hasFitted = true;
    const target = location.hash.slice(1);
    const focus = frames.find((f) => f.id === target || f.name === target);
    if (focus) fitTo([focus], { padding: 140 });
    else fitTo(frames);
  }
}

// ------------------------------------------------------------- selection ---

function select(id) {
  if (selectedId === id) return;
  const prev = views.get(selectedId);
  if (prev) prev.el.classList.remove('selected');
  selectedId = id;
  const next = views.get(id);
  if (next) {
    next.el.classList.add('selected');
    next.el.style.zIndex = String(++zTop);
    updateInspector(next.frame);
  }
  document.getElementById('inspector').classList.toggle('show', Boolean(next));
}

let zTop = 1;

function setLive(id) {
  if (liveId && views.has(liveId)) views.get(liveId).el.classList.remove('live');
  liveId = id;
  if (id && views.has(id)) {
    views.get(id).el.classList.add('live');
    toast('Interacting with <b>' + views.get(id).frame.name + '</b> — esc to exit');
  }
}

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
  const entry = views.get(selectedId);
  if (!entry) return;
  entry.frame.w = preset.w;
  entry.frame.h = preset.h;
  paintFrame(entry, entry.frame);
  commit(entry.frame.id, { w: preset.w, h: preset.h });
  toast(`<b>${entry.frame.name}</b> → ${preset.w} × ${preset.h}`);
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

// ---------------------------------------------------------- frame gestures --

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

function bindFrame(entry) {
  const { el, refs } = entry;

  const startMove = (ev) => {
    if (ev.button !== 0 || spaceHeld) return;
    ev.preventDefault();
    ev.stopPropagation();
    select(entry.frame.id);
    if (liveId && liveId !== entry.frame.id) setLive(null);

    const origin = { x: entry.frame.x, y: entry.frame.y };
    const start = { x: ev.clientX, y: ev.clientY };
    let moved = false;
    busy.add(entry.frame.id);
    capture(el, ev.pointerId);

    const onMove = (e) => {
      let dx = (e.clientX - start.x) / view.scale;
      let dy = (e.clientY - start.y) / view.scale;
      if (Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) > 3) moved = true;
      if (e.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      entry.frame.x = Math.round(origin.x + dx);
      entry.frame.y = Math.round(origin.y + dy);
      el.style.setProperty('--x', `${entry.frame.x}px`);
      el.style.setProperty('--y', `${entry.frame.y}px`);
      if (selectedId === entry.frame.id) updateInspector(entry.frame);
    };

    const onUp = () => {
      release(el, ev.pointerId);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      busy.delete(entry.frame.id);
      if (moved) commit(entry.frame.id, { x: entry.frame.x, y: entry.frame.y });
    };

    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
  };

  refs.body.addEventListener('pointerdown', (ev) => {
    if (entry.el.classList.contains('live')) return; // let the design have the event
    startMove(ev);
  });
  el.querySelector('.frame-label').addEventListener('pointerdown', startMove);

  refs.body.addEventListener('dblclick', (ev) => {
    if (entry.el.classList.contains('live')) return;
    ev.preventDefault();
    select(entry.frame.id);
    setLive(entry.frame.id);
  });

  for (const grip of el.querySelectorAll('.handle, .edge')) {
    grip.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      select(entry.frame.id);

      const dir = grip.dataset.dir;
      const origin = { ...entry.frame };
      const start = { x: ev.clientX, y: ev.clientY };
      busy.add(entry.frame.id);
      capture(grip, ev.pointerId);

      const onMove = (e) => {
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

        Object.assign(entry.frame, {
          x: Math.round(x),
          y: Math.round(y),
          w: Math.max(80, Math.round(w)),
          h: Math.max(80, Math.round(h)),
        });
        el.style.setProperty('--x', `${entry.frame.x}px`);
        el.style.setProperty('--y', `${entry.frame.y}px`);
        el.style.setProperty('--w', `${entry.frame.w}px`);
        el.style.setProperty('--h', `${entry.frame.h}px`);
        entry.refs.meta.textContent = `${entry.frame.w} × ${entry.frame.h}`;
        updateInspector(entry.frame);
      };

      const onUp = () => {
        release(grip, ev.pointerId);
        grip.removeEventListener('pointermove', onMove);
        grip.removeEventListener('pointerup', onUp);
        busy.delete(entry.frame.id);
        const { x, y, w, h } = entry.frame;
        commit(entry.frame.id, { x, y, w, h });
      };

      grip.addEventListener('pointermove', onMove);
      grip.addEventListener('pointerup', onUp);
    });
  }
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

// --------------------------------------------------------- canvas gestures --

let spaceHeld = false;

viewport.addEventListener('pointerdown', (ev) => {
  const onFrame = ev.target.closest('.frame');
  if (onFrame && !spaceHeld && ev.button === 0) return;
  if (ev.button === 0 && !spaceHeld && !onFrame) {
    select(null);
    setLive(null);
  }
  if (ev.button !== 0 && ev.button !== 1 && !spaceHeld) return;

  ev.preventDefault();
  const start = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y };
  viewport.classList.add('panning');
  capture(viewport, ev.pointerId);

  const onMove = (e) => {
    view.x = start.vx + (e.clientX - start.x);
    view.y = start.vy + (e.clientY - start.y);
    applyTransform();
  };
  const onUp = () => {
    release(viewport, ev.pointerId);
    viewport.classList.remove('panning');
    viewport.removeEventListener('pointermove', onMove);
    viewport.removeEventListener('pointerup', onUp);
  };
  viewport.addEventListener('pointermove', onMove);
  viewport.addEventListener('pointerup', onUp);
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
      applyTransform();
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
      fitTo([...views.values()].map((v) => v.frame));
      break;
    case '0':
      zoomTo(1);
      break;
    case '1':
      if (selectedId) fitTo([views.get(selectedId).frame], { padding: 140 });
      break;
    case 'r':
    case 'R': {
      const entry = views.get(selectedId);
      if (entry) {
        entry.refs.iframe.src = `/api/preview/${encodeURIComponent(entry.frame.id)}?r=${Date.now()}`;
        flash(entry);
      }
      break;
    }
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
      if (!selectedId || liveId) break;
      ev.preventDefault();
      const entry = views.get(selectedId);
      const name = entry?.frame.name;
      fetch(`/api/frames/${encodeURIComponent(selectedId)}`, { method: 'DELETE' })
        .then(() => toast(`Removed <b>${name}</b>`))
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
document.getElementById('btn-fit').onclick = () =>
  fitTo([...views.values()].map((v) => v.frame));
zoomLevelEl.onclick = () => zoomTo(1);
document.getElementById('btn-help').onclick = () => helpEl.classList.toggle('show');
helpEl.onclick = () => helpEl.classList.remove('show');

// ------------------------------------------------------------- transport ---

let source = null;
function connect() {
  source = new EventSource('/api/events');

  source.addEventListener('open', () => connDot.classList.remove('off'));

  source.addEventListener('state', (ev) => {
    connDot.classList.remove('off');
    const state = JSON.parse(ev.data);
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
      applyTransform();
    }
    reconcile(state.frames);
  });

  source.addEventListener('frame', (ev) => {
    const frame = JSON.parse(ev.data);
    const entry = views.get(frame.id);
    if (entry && !busy.has(frame.id)) paintFrame(entry, { ...entry.frame, ...frame });
  });

  source.addEventListener('removed', (ev) => unmountFrame(JSON.parse(ev.data).id));

  source.addEventListener('error', () => {
    connDot.classList.add('off');
    // EventSource retries on its own; this only covers a hard close.
    if (source.readyState === EventSource.CLOSED) setTimeout(connect, 1500);
  });
}

let saveTimer = null;
function saveViewport() {
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

applyTransform();
connect();
