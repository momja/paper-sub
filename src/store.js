// Disk-backed canvas store.
//
// The store is the single source of truth and lives entirely on disk, so the
// CLI and the server never need to talk to each other directly: the CLI mutates
// files, the server watches them and pushes the result to connected browsers.
//
//   <root>/canvas.json          metadata for every frame
//   <root>/frames/<id>.html     the markup for one frame
//   <root>/viewport.json        the viewer's saved pan/zoom (kept apart so a
//                               pan never rewrites a large canvas.json)
//   <root>/thumbs/              rendered thumbnails, a disposable cache
//
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const STORE_DIRNAME = '.paper-canvas';
const CANVAS_FILE = 'canvas.json';
const VIEWPORT_FILE = 'viewport.json';
const FRAMES_DIRNAME = 'frames';
const THUMBS_DIRNAME = 'thumbs';

const DEFAULT_STATE = {
  version: 1,
  rev: 0,
  viewport: { x: 0, y: 0, scale: 1 },
  frames: [],
};

export const DEFAULT_FRAME_SIZE = { w: 1280, h: 800 };

/** Resolve the canvas root: explicit arg > env > <cwd>/.paper-canvas */
export function resolveRoot(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.PAPER_CANVAS_DIR) return path.resolve(process.env.PAPER_CANVAS_DIR);
  return path.join(process.cwd(), STORE_DIRNAME);
}

export class Store {
  constructor(root) {
    this.root = resolveRoot(root);
    this.canvasPath = path.join(this.root, CANVAS_FILE);
    this.viewportPath = path.join(this.root, VIEWPORT_FILE);
    this.framesDir = path.join(this.root, FRAMES_DIRNAME);
    this.thumbsDir = path.join(this.root, THUMBS_DIRNAME);
  }

  exists() {
    return fs.existsSync(this.canvasPath);
  }

  init() {
    fs.mkdirSync(this.framesDir, { recursive: true });
    if (!this.exists()) this.write({ ...DEFAULT_STATE, frames: [] });
    return this.root;
  }

  read() {
    if (!this.exists()) return { ...DEFAULT_STATE, frames: [] };
    try {
      const raw = fs.readFileSync(this.canvasPath, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_STATE,
        ...parsed,
        viewport: { ...DEFAULT_STATE.viewport, ...(parsed.viewport || {}) },
        frames: Array.isArray(parsed.frames) ? parsed.frames : [],
      };
    } catch {
      // A half-written or hand-mangled file shouldn't take down the canvas.
      return { ...DEFAULT_STATE, frames: [] };
    }
  }

  /** Atomic write so a reader never observes a truncated file. */
  write(state) {
    fs.mkdirSync(this.framesDir, { recursive: true });
    state.rev = (state.rev || 0) + 1;
    const tmp = path.join(this.root, `.canvas.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, this.canvasPath);
    return state;
  }

  /** Read-modify-write in one shot. Keeps every mutation on the same path. */
  update(mutator) {
    const state = this.read();
    const result = mutator(state);
    this.write(state);
    return result;
  }

  /** Saved pan/zoom. Older canvases kept it inside canvas.json; still honour that. */
  readViewport() {
    try {
      const v = JSON.parse(fs.readFileSync(this.viewportPath, 'utf8'));
      return { ...DEFAULT_STATE.viewport, ...v };
    } catch {
      return this.read().viewport;
    }
  }

  writeViewport(viewport) {
    fs.mkdirSync(this.root, { recursive: true });
    const tmp = path.join(this.root, `.viewport.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(viewport) + '\n', 'utf8');
    fs.renameSync(tmp, this.viewportPath);
  }

  framePath(id) {
    return path.join(this.framesDir, `${id}.html`);
  }

  /**
   * A cheap fingerprint of a frame's markup file (mtime and size), so viewers
   * know when to reload without diffing HTML. 0 means no content yet.
   */
  contentRev(id) {
    try {
      const st = fs.statSync(this.framePath(id));
      return Math.round(st.mtimeMs) ^ st.size;
    } catch {
      return 0;
    }
  }

  readContent(id) {
    try {
      return fs.readFileSync(this.framePath(id), 'utf8');
    } catch {
      return '';
    }
  }

  writeContent(id, html) {
    fs.mkdirSync(this.framesDir, { recursive: true });
    fs.writeFileSync(this.framePath(id), html, 'utf8');
  }

  removeContent(id) {
    try {
      fs.unlinkSync(this.framePath(id));
    } catch {
      /* already gone */
    }
  }

  /**
   * Look up a frame by exact id, unique id prefix, or name (case-insensitive).
   * Throws with a helpful message when the reference is ambiguous or unknown.
   */
  resolve(state, ref) {
    if (!ref) throw new Error('No frame specified.');
    const needle = String(ref).trim();
    const exact = state.frames.find((f) => f.id === needle);
    if (exact) return exact;

    const byName = state.frames.filter((f) => f.name.toLowerCase() === needle.toLowerCase());
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) {
      throw new Error(
        `"${needle}" matches ${byName.length} frames. Use an id instead: ${byName.map((f) => f.id).join(', ')}`
      );
    }

    const byPrefix = state.frames.filter((f) => f.id.startsWith(needle));
    if (byPrefix.length === 1) return byPrefix[0];
    if (byPrefix.length > 1) {
      throw new Error(
        `"${needle}" is ambiguous: ${byPrefix.map((f) => f.id).join(', ')}`
      );
    }

    const fuzzy = state.frames.filter((f) => f.name.toLowerCase().includes(needle.toLowerCase()));
    if (fuzzy.length === 1) return fuzzy[0];

    throw new Error(`No frame matching "${needle}". Run \`paper ls\` to see what's on the canvas.`);
  }

  /** Where the server writes its port so `paper` commands can find it. */
  get lockPath() {
    return path.join(this.root, 'server.json');
  }

  readLock() {
    try {
      return JSON.parse(fs.readFileSync(this.lockPath, 'utf8'));
    } catch {
      return null;
    }
  }

  writeLock(info) {
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(this.lockPath, JSON.stringify(info, null, 2), 'utf8');
  }

  clearLock() {
    try {
      fs.unlinkSync(this.lockPath);
    } catch {
      /* not running */
    }
  }
}

export function newId() {
  return 'f_' + crypto.randomBytes(4).toString('hex');
}

/** Grid-aware placement: drop a new frame to the right of what's already there. */
export function nextFreeSlot(frames, w, h) {
  if (!frames.length) return { x: 0, y: 0 };
  const GAP = 120;
  const ROW_WIDTH = 6200;
  // Plain loops: spreading a very large canvas into Math.min overflows the stack.
  let x = Infinity, y = Infinity, rightEdge = -Infinity, bottomEdge = -Infinity;
  for (const f of frames) {
    x = Math.min(x, f.x);
    y = Math.min(y, f.y);
    rightEdge = Math.max(rightEdge, f.x + f.w);
    bottomEdge = Math.max(bottomEdge, f.y + f.h);
  }

  if (rightEdge - x + GAP + w <= ROW_WIDTH) return { x: rightEdge + GAP, y };
  return { x, y: bottomEdge + GAP };
}

const DOC_RE = /^\s*(<!doctype|<html\b)/i;

/**
 * Agents shouldn't have to remember boilerplate. A bare fragment gets wrapped in
 * a minimal document; anything that already looks like a full page is untouched.
 */
export function wrapHtml(content, { background = '#ffffff', title = 'Frame' } = {}) {
  if (DOC_RE.test(content)) return content;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  /* The frame is the viewport, so height:100% resolves the way a design
     expects. Taller content simply overflows and scrolls inside the frame. */
  html, body { margin: 0; padding: 0; height: 100%; }
  body {
    background: ${background};
    color: #111;
    font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  img, svg, video { max-width: 100%; display: block; }
</style>
</head>
<body>
${content}
</body>
</html>
`;
}

/** What an empty frame shows. The CLI hint only makes sense on a live canvas. */
export function emptyFramePlaceholder(name, { hint = true } = {}) {
  const cmd = hint
    ? `\n    <code style="font:12px ui-monospace,SFMono-Regular,monospace;color:#c0c4c9">paper set ${escapeHtml(name)} --file design.html</code>`
    : '';
  return `<div style="display:grid;place-items:center;height:100vh;font:500 14px ui-sans-serif,system-ui;color:#9aa0a6;letter-spacing:.02em">
  <div style="text-align:center">
    <div style="font-size:13px;text-transform:uppercase;letter-spacing:.14em;margin-bottom:8px">Empty frame</div>${cmd}
  </div>
</div>`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/** Read piped stdin, if any. Returns '' when stdin is a TTY. */
export function readStdin() {
  if (process.stdin.isTTY) return '';
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

export function homeShorten(p) {
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}
