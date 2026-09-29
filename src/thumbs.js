// Thumbnails.
//
// The viewer draws every frame from a thumbnail until you zoom in far enough to
// want the live page, so a board of ten thousand designs costs the browser ten
// thousand small images instead of ten thousand iframes. Thumbnails are real
// screenshots: a headless Chromium, driven over the DevTools pipe (no npm
// dependency, no network port), loads each frame's markup at its true size and
// captures it at whatever resolution the viewer asks for.
//
//   <root>/thumbs/<id>.<version>.<level>.<ext>   one capture
//   <root>/thumbs/tones.json                     average colour per frame
//
// A level is the pixel length of the capture's longer side: 32, 64 … 2048.
// The version changes whenever the frame's markup or size does, so a cached
// file is never stale — old versions are simply deleted.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

export const MIN_LEVEL = 32;
export const MAX_LEVEL = 2048;

/** Snap any requested size to the nearest supported power-of-two level. */
export function normalizeLevel(value) {
  const n = Number(value) || MIN_LEVEL;
  let level = MIN_LEVEL;
  while (level < n && level < MAX_LEVEL) level *= 2;
  return level;
}

/** Stable version string for a frame's rendered look: markup plus size. */
export function thumbVersion(frame, contentRev) {
  const size = `${Math.round(frame.w)}x${Math.round(frame.h)}`;
  // An empty frame renders a placeholder that shows its name.
  return contentRev ? `${(contentRev >>> 0).toString(36)}-${size}` : `e${hash(frame.name)}-${size}`;
}

const hash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
};

// The two smallest levels are PNG: the server decodes them itself (for the
// frame's average colour, and to ship them to viewers as raw pixels in bulk).
// Mid levels are WebP (tiny files); large ones JPEG, since WebP encoding of a
// 2048px capture is ~4x slower.
const FORMATS = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg' };
export const RAW_LEVEL = 64;
const formatFor = (level) => (level <= RAW_LEVEL ? 'png' : level <= 512 ? 'webp' : 'jpg');

// ------------------------------------------------------- browser discovery --

/**
 * Find a Chromium-family browser. PAPER_CHROME wins (a path, or "off" to
 * disable thumbnails). A headless shell is preferred when one is lying around
 * — it starts in a fraction of the time a full browser takes.
 */
export function findBrowser() {
  const env = process.env.PAPER_CHROME;
  if (env) return /^(off|none|0|false)$/i.test(env) ? null : env;

  const home = os.homedir();
  const candidates = [];
  const playwright = (base) => {
    try {
      for (const dir of fs.readdirSync(base).sort().reverse()) {
        const root = path.join(base, dir);
        if (dir.startsWith('chromium_headless_shell-')) {
          for (const sub of safeReaddir(root)) candidates.push(path.join(root, sub, 'chrome-headless-shell'));
        }
      }
      for (const dir of fs.readdirSync(base).sort().reverse()) {
        const root = path.join(base, dir);
        if (/^chromium-\d+$/.test(dir)) {
          for (const sub of safeReaddir(root)) {
            candidates.push(path.join(root, sub, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'));
            candidates.push(path.join(root, sub, 'Chromium.app/Contents/MacOS/Chromium'));
            candidates.push(path.join(root, sub, 'chrome'));
          }
        }
      }
    } catch {
      /* no cache here */
    }
  };

  if (process.platform === 'darwin') {
    playwright(path.join(home, 'Library/Caches/ms-playwright'));
    for (const app of [
      'Google Chrome',
      'Google Chrome Canary',
      'Google Chrome for Testing',
      'Chromium',
      'Microsoft Edge',
      'Brave Browser',
      'Helium',
      'Vivaldi',
      'Arc',
    ]) {
      for (const base of ['/Applications', path.join(home, 'Applications')]) {
        candidates.push(path.join(base, `${app}.app/Contents/MacOS/${app}`));
      }
    }
  } else if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    playwright(path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'));
    for (const root of roots) {
      candidates.push(path.join(root, 'Google/Chrome/Application/chrome.exe'));
      candidates.push(path.join(root, 'Microsoft/Edge/Application/msedge.exe'));
      candidates.push(path.join(root, 'BraveSoftware/Brave-Browser/Application/brave.exe'));
    }
  } else {
    playwright(path.join(home, '.cache/ms-playwright'));
    const dirs = (process.env.PATH || '').split(path.delimiter);
    for (const name of [
      'chrome-headless-shell',
      'google-chrome',
      'google-chrome-stable',
      'chromium',
      'chromium-browser',
      'microsoft-edge',
      'brave-browser',
    ]) {
      for (const dir of dirs) candidates.push(path.join(dir, name));
    }
  }

  return candidates.find((file) => isExecutable(file)) || null;
}

const safeReaddir = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

const isExecutable = (file) => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------- CDP pipe --

/** Chrome DevTools Protocol over --remote-debugging-pipe: NUL-delimited JSON on fds 3 and 4. */
class Cdp {
  constructor(proc) {
    this.proc = proc;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    let buffer = '';
    proc.stdio[4].setEncoding('utf8');
    proc.stdio[4].on('data', (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\0')) !== -1) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        const waiter = message.id !== undefined && this.pending.get(message.id);
        if (waiter) {
          this.pending.delete(message.id);
          if (message.error) waiter.reject(new Error(message.error.message));
          else waiter.resolve(message.result);
        } else {
          for (const listener of this.listeners) listener(message);
        }
      }
    });
    proc.stdio[3].on('error', () => {}); // EPIPE when Chrome dies mid-write
    proc.on('exit', () => this.fail(new Error('Browser exited')));
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('Browser is not running'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.proc.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    });
  }

  /** Resolve on the next `method` event for a session, or reject after `ms`. */
  waitFor(method, sessionId, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error(`Timed out waiting for ${method}`));
      }, ms);
      const listener = (m) => {
        if (m.method === method && m.sessionId === sessionId) {
          clearTimeout(timer);
          this.listeners.delete(listener);
          resolve(m.params);
        }
      };
      this.listeners.add(listener);
    });
  }

  fail(err) {
    this.closed = true;
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }
}

const withTimeout = (promise, ms, what) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms).unref()),
  ]);

// --------------------------------------------------------------- the engine --

/**
 * Renders and caches thumbnails. Requests from a viewer jump the queue
 * (newest first, since that is what is on screen now); background work fills
 * in the smallest level for every frame so a zoomed-out board is never blank.
 *
 * @param {object} opts
 * @param {string} opts.dir                  cache directory
 * @param {(id: string) => ({frame: any, version: string, html: string} | null)} opts.lookup
 *        current frame, its version, and its markup — null if it no longer exists
 * @param {(id: string, tone: string) => void} [opts.onTone]
 */
export class Thumbnailer {
  constructor({ dir, lookup, onTone = () => {}, workers = defaultWorkers(), idleMs = 60_000 }) {
    this.dir = dir;
    this.lookup = lookup;
    this.onTone = onTone;
    this.maxWorkers = workers;
    this.idleMs = idleMs;
    this.browserPath = findBrowser();
    /** 'ready' until a launch fails; then 'none' and every request is refused */
    this.engine = this.browserPath ? 'ready' : 'none';
    this.engineError = this.browserPath ? null : 'No Chromium-family browser found (set PAPER_CHROME)';

    /** id → (`${version}.${level}` → filename), for everything on disk */
    this.files = new Map();
    /** key → job, for everything queued or rendering */
    this.jobs = new Map();
    this.urgent = []; // viewer requests, served newest first
    this.background = []; // warm-up work, served in order
    this.tones = {};
    this.browser = null;
    this.launching = null;
    this.tabs = [];
    this.idleTimer = null;
    this.stats = { rendered: 0, ms: 0 };

    fs.mkdirSync(dir, { recursive: true });
    for (const name of safeReaddir(dir)) {
      const m = /^(.+)\.([^.]+)\.(\d+)\.(png|webp|jpg)$/.exec(name);
      if (m) this.addFile(m[1], m[2], m[3], name);
    }
    try {
      this.tones = JSON.parse(fs.readFileSync(path.join(dir, 'tones.json'), 'utf8'));
    } catch {
      this.tones = {};
    }
  }

  get available() {
    return this.engine !== 'none';
  }

  /** Average colour of a frame's current version, if it has been rendered. */
  tone(id) {
    return this.tones[id]?.c; // may belong to an older version; a stale tone beats none
  }

  cached(id, version, level) {
    const name = this.files.get(id)?.get(`${version}.${level}`);
    return name ? { file: path.join(this.dir, name), type: FORMATS[path.extname(name).slice(1)] } : null;
  }

  /** Get a thumbnail, rendering it if needed. Resolves to {file, type}. */
  request(id, version, level, { urgent = true } = {}) {
    const hit = this.cached(id, version, level);
    if (hit) return Promise.resolve(hit);
    if (!this.available) return Promise.reject(new Error(this.engineError));

    const key = `${id}.${version}.${level}`;
    let job = this.jobs.get(key);
    if (!job) {
      job = { key, id, version, level, waiters: [], urgent };
      job.promise = new Promise((resolve, reject) => job.waiters.push({ resolve, reject }));
      this.jobs.set(key, job);
      (urgent ? this.urgent : this.background).push(job);
    } else if (urgent && !job.urgent && !job.started) {
      job.urgent = true;
      this.background.splice(this.background.indexOf(job), 1);
      this.urgent.push(job);
    } else if (urgent && !job.started) {
      // Already urgent: move it to the front of the line (the end — newest first).
      this.urgent.splice(this.urgent.indexOf(job), 1);
      this.urgent.push(job);
    }
    this.pump();
    return job.promise;
  }

  /** Queue the smallest level for frames that lack it, without anyone waiting. */
  warm(entries) {
    if (!this.available) return;
    for (const { id, version } of entries) {
      if (!this.cached(id, version, MIN_LEVEL)) this.request(id, version, MIN_LEVEL, { urgent: false }).catch(() => {});
    }
  }

  addFile(id, version, level, name) {
    let mine = this.files.get(id);
    if (!mine) this.files.set(id, (mine = new Map()));
    mine.set(`${version}.${level}`, name);
  }

  /** Drop cached files for a frame, keeping only `keepVersion` (or nothing). */
  forget(id, keepVersion = null) {
    const mine = this.files.get(id);
    if (mine) {
      for (const [key, name] of mine) {
        if (key.slice(0, key.lastIndexOf('.')) === keepVersion) continue;
        mine.delete(key);
        fs.rm(path.join(this.dir, name), { force: true }, () => {});
      }
      if (!mine.size) this.files.delete(id);
    }
    if (!keepVersion && this.tones[id]) {
      delete this.tones[id];
      this.saveTones();
    }
  }

  /** Remove files for frames that no longer exist. */
  retain(ids) {
    const keep = new Set(ids);
    for (const id of [...this.files.keys()]) if (!keep.has(id)) this.forget(id);
    for (const id of Object.keys(this.tones)) if (!keep.has(id)) delete this.tones[id];
  }

  // -------------------------------------------------------------- workers --

  pump() {
    clearTimeout(this.idleTimer);
    if (!this.urgent.length && !this.background.length) {
      if (this.browser && !this.tabs.some((t) => t.busy)) {
        this.idleTimer = setTimeout(() => this.shutdown(), this.idleMs);
        this.idleTimer.unref();
      }
      return;
    }
    if (!this.browser) {
      this.launch().then(
        () => this.pump(),
        (err) => this.disable(err)
      );
      return;
    }
    for (const tab of this.tabs) {
      if (tab.busy) continue;
      // Warm-up work gets at most half the tabs: an on-screen request always
      // finds one free, and a big board warming up doesn't eat the machine.
      const busyBackground = this.tabs.filter((t) => t.busy && t.background).length;
      const job = this.urgent.pop() || (busyBackground < Math.max(1, this.tabs.length >> 1) ? this.background.shift() : null);
      if (!job) break;
      this.run(tab, job);
    }
  }

  async run(tab, job) {
    tab.busy = true;
    tab.background = !job.urgent;
    const batch = this.claimSiblings(job);
    const current = this.lookup(job.id);

    try {
      if (!current || current.version !== job.version) throw new Error('Frame changed before it was rendered');
      const todo = batch.filter((j) => !this.cached(j.id, j.version, j.level)).map((j) => j.level);
      if (todo.length) {
        const started = performance.now();
        await this.render(tab, current, todo);
        this.stats.rendered += todo.length;
        this.stats.ms += performance.now() - started;
      }
      for (const j of batch) {
        const hit = this.cached(j.id, j.version, j.level);
        for (const w of j.waiters) hit ? w.resolve(hit) : w.reject(new Error('Render produced nothing'));
      }
    } catch (err) {
      for (const j of batch) for (const w of j.waiters) w.reject(err);
      if (this.browser?.cdp.closed) this.browser = null; // relaunch on the next request
    } finally {
      for (const j of batch) this.jobs.delete(j.key);
      tab.busy = false;
      this.pump();
    }
  }

  /** Take every queued job for the same frame version so one page load serves them all. */
  claimSiblings(job) {
    job.started = true;
    const batch = [job];
    for (const queue of [this.urgent, this.background]) {
      for (let i = queue.length - 1; i >= 0; i--) {
        const other = queue[i];
        if (other.id === job.id && other.version === job.version) {
          other.started = true;
          batch.push(other);
          queue.splice(i, 1);
        }
      }
    }
    // Always capture the smallest level too: it is nearly free once the page is
    // up, and it is what the frame's average colour is computed from.
    if (!batch.some((j) => j.level === MIN_LEVEL) && !this.cached(job.id, job.version, MIN_LEVEL)) {
      batch.push({ key: `${job.id}.${job.version}.${MIN_LEVEL}`, id: job.id, version: job.version, level: MIN_LEVEL, waiters: [] });
    }
    return batch;
  }

  async render(tab, { frame, version, html }, levels) {
    const { cdp } = this.browser;
    const { sessionId } = tab;
    const w = Math.max(1, Math.round(frame.w));
    const h = Math.max(1, Math.round(frame.h));
    const pageKey = `${frame.id}.${version}`;

    if (tab.pageKey !== pageKey) {
      tab.pageKey = null;
      if (tab.w !== w || tab.h !== h) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }, sessionId);
        tab.w = w;
        tab.h = h;
      }
      tab.html = html;
      const loaded = cdp.waitFor('Page.loadEventFired', sessionId, 8000);
      await cdp.send('Page.navigate', { url: `${tab.origin}/${encodeURIComponent(frame.id)}/${version}` }, sessionId);
      await loaded;
      // Web fonts, then one frame so anything a script draws on load is in.
      await withTimeout(
        cdp.send(
          'Runtime.evaluate',
          { expression: 'document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => r())))', awaitPromise: true },
          sessionId
        ),
        1500,
        'Settling'
      ).catch(() => {});
      tab.pageKey = pageKey;
    }

    for (const level of [...new Set(levels)].sort((a, b) => a - b)) {
      // Never upscale past 2x: a 400px card doesn't need a 2048px capture.
      const scale = Math.min(2, level / Math.max(w, h));
      const format = formatFor(level);
      const { data } = await cdp.send(
        'Page.captureScreenshot',
        {
          format: format === 'jpg' ? 'jpeg' : format,
          quality: format === 'png' ? undefined : format === 'jpg' ? 85 : 82,
          clip: { x: 0, y: 0, width: w, height: h, scale },
          optimizeForSpeed: true,
        },
        sessionId
      );
      const bytes = Buffer.from(data, 'base64');
      const name = `${frame.id}.${version}.${level}.${format}`;
      const tmp = path.join(this.dir, `.${name}.${process.pid}.tmp`);
      fs.writeFileSync(tmp, bytes);
      fs.renameSync(tmp, path.join(this.dir, name));
      this.addFile(frame.id, version, level, name);

      if (level === MIN_LEVEL) {
        const tone = pngTone(bytes);
        if (tone && (this.tones[frame.id]?.v !== version || this.tones[frame.id]?.c !== tone)) {
          this.tones[frame.id] = { v: version, c: tone };
          this.saveTones();
          this.onTone(frame.id, tone);
        }
      }
    }
    this.forget(frame.id, version);
  }

  saveTones() {
    clearTimeout(this.toneTimer);
    this.toneTimer = setTimeout(() => {
      const file = path.join(this.dir, 'tones.json');
      fs.writeFile(`${file}.tmp`, JSON.stringify(this.tones), (err) => {
        if (!err) fs.rename(`${file}.tmp`, file, () => {});
      });
    }, 500);
    this.toneTimer.unref();
  }

  // -------------------------------------------------------------- browser --

  launch() {
    if (this.launching) return this.launching;
    this.launching = (async () => {
      const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-thumbs-'));
      const proc = spawn(
        this.browserPath,
        [
          '--headless=new',
          '--remote-debugging-pipe',
          `--user-data-dir=${profile}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--hide-scrollbars',
          '--mute-audio',
          '--disable-extensions',
          '--disable-sync',
          '--disable-component-update',
          '--disable-background-networking',
          '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding',
          '--disable-backgrounding-occluded-windows',
          '--force-color-profile=srgb',
          'about:blank',
        ],
        { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] }
      );
      proc.stderr.resume(); // Chrome is chatty; never let the pipe fill up
      const cdp = new Cdp(proc);
      const browser = { proc, cdp, profile };
      const kill = () => proc.kill();
      process.once('exit', kill);
      proc.once('exit', () => {
        process.removeListener('exit', kill);
        fs.rm(profile, { recursive: true, force: true }, () => {});
        if (this.browser === browser) {
          this.browser = null;
          this.tabs = [];
        }
      });
      proc.once('error', (err) => cdp.fail(err));

      await withTimeout(cdp.send('Browser.getVersion'), 15000, 'Starting the browser');
      const tabs = await Promise.all(
        Array.from({ length: this.maxWorkers }, async (_, i) => {
          const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
          const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
          // A distinct site per tab so Chromium gives each its own renderer process.
          const tab = { sessionId, origin: `https://paper-${i}.invalid`, busy: false, pageKey: null, w: 0, h: 0, html: '' };
          await Promise.all([
            cdp.send('Page.enable', {}, sessionId),
            cdp.send('Fetch.enable', { patterns: [{ urlPattern: `${tab.origin}/*` }] }, sessionId),
          ]);
          return tab;
        })
      );

      // Serve each tab's markup from memory. The CSP sandbox gives the page an
      // opaque origin, exactly like the viewer's sandboxed iframe.
      cdp.listeners.add((m) => {
        if (m.method !== 'Fetch.requestPaused') return;
        const tab = tabs.find((t) => t.sessionId === m.sessionId);
        const isDoc = m.params.resourceType === 'Document';
        cdp
          .send(
            'Fetch.fulfillRequest',
            {
              requestId: m.params.requestId,
              responseCode: isDoc ? 200 : 404,
              responseHeaders: [
                { name: 'Content-Type', value: 'text/html; charset=utf-8' },
                { name: 'Content-Security-Policy', value: 'sandbox allow-scripts allow-forms' },
              ],
              body: isDoc && tab ? Buffer.from(tab.html).toString('base64') : '',
            },
            m.sessionId
          )
          .catch(() => {});
      });

      this.browser = browser;
      this.tabs = tabs;
    })().finally(() => {
      this.launching = null;
    });
    return this.launching;
  }

  disable(err) {
    this.engine = 'none';
    this.engineError = `Thumbnails unavailable: ${err.message}`;
    for (const job of this.jobs.values()) for (const w of job.waiters) w.reject(err);
    this.jobs.clear();
    this.urgent = [];
    this.background = [];
    this.shutdown();
  }

  shutdown() {
    const browser = this.browser;
    this.browser = null;
    this.tabs = [];
    if (browser) browser.proc.kill();
  }
}

function defaultWorkers() {
  const cpus = os.availableParallelism?.() ?? os.cpus().length;
  return Math.max(1, Math.min(4, Math.floor(cpus / 2)));
}

// ------------------------------------------------------------------- PNG --

/**
 * Decode a small 8-bit RGB/RGBA PNG (what Chromium captures emit) to RGBA
 * pixels. Just enough of a decoder for that: inflate and un-filter. Returns
 * null for anything else.
 */
export function decodePng(buf) {
  try {
    let offset = 8;
    let width = 0;
    let height = 0;
    let channels = 0;
    const idat = [];
    while (offset < buf.length) {
      const length = buf.readUInt32BE(offset);
      const type = buf.toString('latin1', offset + 4, offset + 8);
      const data = buf.subarray(offset + 8, offset + 8 + length);
      if (type === 'IHDR') {
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        if (data[8] !== 8 || data[12] !== 0) return null; // 8-bit, non-interlaced only
        channels = { 2: 3, 6: 4 }[data[9]];
        if (!channels) return null;
      } else if (type === 'IDAT') {
        idat.push(data);
      } else if (type === 'IEND') {
        break;
      }
      offset += 12 + length;
    }

    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    const rgba = Buffer.alloc(width * height * 4);
    let prev = new Uint8Array(stride);
    let line = new Uint8Array(stride);
    for (let y = 0; y < height; y++) {
      const base = y * (stride + 1);
      const filter = raw[base];
      for (let i = 0; i < stride; i++) {
        const left = i >= channels ? line[i - channels] : 0;
        const up = prev[i];
        const upLeft = i >= channels ? prev[i - channels] : 0;
        let x = raw[base + 1 + i];
        if (filter === 1) x += left;
        else if (filter === 2) x += up;
        else if (filter === 3) x += (left + up) >> 1;
        else if (filter === 4) {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          x += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        }
        line[i] = x & 255;
      }
      for (let px = 0, o = y * width * 4; px < width; px++, o += 4) {
        const i = px * channels;
        rgba[o] = line[i];
        rgba[o + 1] = line[i + 1];
        rgba[o + 2] = line[i + 2];
        rgba[o + 3] = channels === 4 ? line[i + 3] : 255;
      }
      [prev, line] = [line, prev];
    }
    return { width, height, rgba };
  } catch {
    return null;
  }
}

/** Average colour of a PNG as #rrggbb. */
export function pngTone(buf) {
  const img = decodePng(buf);
  if (!img || !img.width || !img.height) return null;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < img.rgba.length; i += 4) {
    r += img.rgba[i];
    g += img.rgba[i + 1];
    b += img.rgba[i + 2];
  }
  const n = img.width * img.height;
  return '#' + [r, g, b].map((v) => Math.round(v / n).toString(16).padStart(2, '0')).join('');
}
