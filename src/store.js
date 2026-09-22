// Disk-backed canvas store.
//
// The store is the single source of truth and lives entirely on disk, so the
// CLI and the server never need to talk to each other directly: the CLI mutates
// files, the server watches them and pushes the result to connected browsers.
//
//   <root>/canvas.json          metadata for every frame + saved viewport
//   <root>/frames/<id>.html     the markup for one frame
//
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const STORE_DIRNAME = '.paper-canvas';
const CANVAS_FILE = 'canvas.json';
const FRAMES_DIRNAME = 'frames';

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
    this.framesDir = path.join(this.root, FRAMES_DIRNAME);
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

  framePath(id) {
    return path.join(this.framesDir, `${id}.html`);
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
  let x = Math.min(...frames.map((f) => f.x));
  let y = Math.min(...frames.map((f) => f.y));
  const rightEdge = Math.max(...frames.map((f) => f.x + f.w));
  const bottomEdge = Math.max(...frames.map((f) => f.y + f.h));

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
