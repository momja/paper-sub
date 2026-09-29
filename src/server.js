// Local canvas server.
//
// Serves the web UI, exposes a small JSON API for the browser (frame moves and
// resizes), renders thumbnails, and streams store changes to every open tab
// over Server-Sent Events. The CLI never talks to this process — it edits the
// store on disk and the watcher below turns that into a live update.
//
// Everything here is built to stay flat as a canvas grows: the parsed state is
// cached until canvas.json actually changes, content revisions are re-stat'd
// only for the files the watcher names, and tabs receive diffs — one changed
// frame costs one frame on the wire, not the whole board.
//
// The event stream only ever carries small messages. Chromium's EventSource
// parser slows down badly on large ones (a 2.4 MB message for a 10k-frame
// board took 25 s to arrive, against 30 ms for the same bytes over fetch), so
// the full state is always fetched from /api/state and SSE just says when.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, wrapHtml, emptyFramePlaceholder } from './store.js';
import { buildExport, exportFilename } from './export.js';
import { Thumbnailer, thumbVersion, normalizeLevel, decodePng, RAW_LEVEL } from './thumbs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

// Same flags as the viewer's iframe, applied to the document itself so a
// preview opened directly in a tab can't reach the API either.
const PREVIEW_CSP = 'sandbox allow-scripts allow-forms allow-popups';
const IMMUTABLE = 'private, max-age=31536000, immutable';
/** Diffs bigger than this go out as a "refresh" hint instead; see the header. */
const MAX_EVENT_BYTES = 64 * 1024;

export function createServer({ root } = {}) {
  const store = new Store(root);
  store.init();

  /** @type {Set<import('node:http').ServerResponse>} */
  const clients = new Set();

  const send = (res, status, body, headers = {}) => {
    const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body)
        ? 'application/json; charset=utf-8'
        : 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(payload);
  };

  const broadcast = (event, data) => {
    let json = JSON.stringify(data);
    if (json.length > MAX_EVENT_BYTES) {
      event = 'refresh';
      json = JSON.stringify({ rev: data.rev });
    }
    const chunk = `event: ${event}\ndata: ${json}\n\n`;
    for (const res of clients) {
      try {
        res.write(chunk);
      } catch {
        clients.delete(res);
      }
    }
  };

  // --- cached state ---------------------------------------------------------
  let stamp = null;
  let state = null;
  let byId = new Map();
  const readState = () => {
    const st = statOrNull(store.canvasPath);
    const next = st ? `${st.ino}:${st.mtimeMs}:${st.size}` : 'none';
    if (next !== stamp || !state) {
      stamp = next;
      state = store.read();
      byId = new Map(state.frames.map((f) => [f.id, f]));
    }
    return state;
  };
  const frameById = (id) => (readState(), byId.get(id));

  /** id → content revision; entries are dropped when the watcher names the file */
  const revs = new Map();
  const revOf = (id) => {
    let rev = revs.get(id);
    if (rev === undefined) {
      rev = store.contentRev(id);
      revs.set(id, rev);
    }
    return rev;
  };
  const versionOf = (frame) => thumbVersion(frame, revOf(frame.id));

  // --- thumbnails -------------------------------------------------------------
  const thumbs = new Thumbnailer({
    dir: store.thumbsDir,
    lookup: (id) => {
      const frame = frameById(id);
      if (!frame) return null;
      const html = store.readContent(id) || wrapHtml(emptyFramePlaceholder(frame.name), { title: frame.name });
      return { frame, version: versionOf(frame), html };
    },
    onTone: (id) => {
      touched.add(id);
      schedulePush(250); // tones ride along on the next diff
    },
  });

  const clientFrame = (frame) => {
    const contentRev = revOf(frame.id);
    return { ...frame, contentRev, tv: thumbVersion(frame, contentRev), tone: thumbs.tone(frame.id) };
  };

  const snapshot = () => {
    const current = readState();
    return {
      ...current,
      viewport: store.readViewport(),
      frames: current.frames.map(clientFrame),
      thumbs: thumbs.available ? 'server' : 'none',
    };
  };

  // --- diffs ------------------------------------------------------------------
  /** id → the frame as last broadcast */
  let sent = new Map();
  let sentStamp = null;
  /** frames that may have changed without canvas.json changing (content or tone) */
  const touched = new Set();
  let warmed = false;

  const pushChanges = () => {
    const current = readState();
    const changed = [];
    const stale = [];
    const removed = [];
    const check = (frame) => {
      const view = clientFrame(frame);
      const before = sent.get(frame.id);
      if (before && sameFrame(before, view)) return;
      sent.set(frame.id, view);
      changed.push(view);
      if (!before || before.tv !== view.tv) stale.push({ id: frame.id, version: view.tv });
    };

    if (stamp !== sentStamp) {
      // canvas.json changed: compare every frame (field by field, no JSON).
      sentStamp = stamp;
      const ids = new Set();
      for (const frame of current.frames) {
        ids.add(frame.id);
        check(frame);
      }
      for (const id of sent.keys()) {
        if (ids.has(id)) continue;
        sent.delete(id);
        removed.push(id);
        revs.delete(id);
        thumbs.forget(id);
      }
    } else {
      // Only markup files or tones moved: look at just those frames.
      for (const id of touched) {
        const frame = byId.get(id);
        if (frame) check(frame);
      }
    }
    touched.clear();

    for (const { id, version } of stale) thumbs.forget(id, version);
    if (warmed) thumbs.warm(stale);
    if (changed.length || removed.length) broadcast('patch', { frames: changed, removed, rev: current.rev });
  };

  // Coalesce bursts into one diff. The earliest deadline wins: a steady trickle
  // of tone updates from background rendering must never hold back a CLI edit.
  let pushTimer = null;
  let pushAt = 0;
  const schedulePush = (ms = 40) => {
    const at = Date.now() + ms;
    if (pushTimer && pushAt <= at) return;
    clearTimeout(pushTimer);
    pushAt = at;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      pushChanges();
    }, ms);
  };

  // Seed the diff baseline and sweep thumbnails of frames that are long gone.
  {
    const initial = snapshot();
    sentStamp = stamp;
    for (const frame of initial.frames) sent.set(frame.id, frame);
    thumbs.retain(initial.frames.map((f) => f.id));
  }

  // --- watch the store --------------------------------------------------------
  // fs.watch fires several times for one logical save (temp file, rename), so
  // coalesce into one diff. File names tell us which content revisions to redo.
  let watcher = null;
  let poller = null;
  const onWatch = (_event, filename) => {
    if (filename) {
      const rel = String(filename).split(path.sep).join('/');
      if (rel.startsWith('thumbs') || rel === 'viewport.json' || rel === 'server.json') return;
      if (rel.endsWith('.tmp') || path.basename(rel).startsWith('.')) return;
      const m = /^frames\/(.+)\.html$/.exec(rel);
      if (m) {
        revs.delete(m[1]);
        touched.add(m[1]);
      } else if (rel === 'frames') {
        revs.clear();
        sentStamp = null; // unknown which: compare everything
      }
    } else {
      revs.clear();
      sentStamp = null;
    }
    schedulePush();
  };
  const startWatching = () => {
    try {
      watcher = fs.watch(store.root, { recursive: true }, onWatch);
    } catch {
      // Recursive watch is unsupported on some platforms; fall back to polling.
      poller = setInterval(() => {
        revs.clear();
        sentStamp = null;
        pushChanges();
      }, 750);
      poller.unref();
    }
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (c) => {
        data += c;
        if (data.length > 5e7) reject(new Error('Payload too large'));
      });
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;

    try {
      // --- events stream ---------------------------------------------------
      if (pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        // Just a nudge: the tab fetches /api/state itself (see the header).
        res.write(`event: hello\ndata: ${JSON.stringify({ rev: readState().rev })}\n\n`);
        clients.add(res);
        // Someone is looking: start rendering the smallest thumbnail of every
        // frame so zooming out never shows blanks.
        if (!warmed) {
          warmed = true;
          thumbs.warm(readState().frames.map((f) => ({ id: f.id, version: versionOf(f) })));
        }
        const ping = setInterval(() => {
          try {
            res.write(': ping\n\n');
          } catch {
            /* closed */
          }
        }, 25000);
        req.on('close', () => {
          clearInterval(ping);
          clients.delete(res);
        });
        return;
      }

      // --- full state ------------------------------------------------------
      if (pathname === '/api/state' && req.method === 'GET') {
        return send(res, 200, snapshot());
      }

      // --- frame preview document (iframe src) -----------------------------
      if (pathname.startsWith('/api/preview/')) {
        const id = decodeURIComponent(pathname.slice('/api/preview/'.length));
        const frame = frameById(id);
        if (!frame) return send(res, 404, 'No such frame');
        const html = store.readContent(id);
        // The URL carries the content revision, so a matching one never changes.
        const current = html && url.searchParams.get('r') === String(revOf(id));
        return send(res, 200, html || wrapHtml(emptyFramePlaceholder(frame.name), { title: frame.name }), {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': PREVIEW_CSP,
          'Cache-Control': current ? IMMUTABLE : 'no-store',
        });
      }

      // --- raw source ------------------------------------------------------
      // Resolve through the frame list so the id can never become a path.
      if (pathname.startsWith('/api/source/')) {
        const id = decodeURIComponent(pathname.slice('/api/source/'.length));
        if (!frameById(id)) return send(res, 404, 'No such frame');
        return send(res, 200, store.readContent(id), { 'Content-Type': 'text/plain; charset=utf-8' });
      }

      // --- thumbnails ------------------------------------------------------
      // /api/thumb/<id>?l=<level>&v=<version>. The version pins the URL to one
      // rendering, so browsers may cache it forever.
      if (pathname.startsWith('/api/thumb/')) {
        const id = decodeURIComponent(pathname.slice('/api/thumb/'.length));
        const frame = frameById(id);
        if (!frame) return send(res, 404, 'No such frame');
        const version = versionOf(frame);
        if (url.searchParams.get('v') !== version) return send(res, 409, { error: 'stale', version });
        const level = normalizeLevel(url.searchParams.get('l'));
        let hit;
        try {
          hit = await thumbs.request(id, version, level);
        } catch (err) {
          // 503 tells the viewer to draw this one itself; cached ones still come from here.
          return send(res, thumbs.available ? 500 : 503, { error: err.message });
        }
        res.writeHead(200, { 'Content-Type': hit.type, 'Cache-Control': IMMUTABLE });
        return fs.createReadStream(hit.file).pipe(res);
      }

      // --- thumbnails in bulk ------------------------------------------------
      // POST {l, frames: [[id, version], ...]} for the smallest levels. A
      // zoomed-out board wants thousands of these, and decoding thousands of
      // tiny images costs a browser more than drawing them, so they go out as
      // raw RGBA: u32 header length, JSON [[index, width, height], ...], then
      // the pixels back to back. Only cached ones; nothing renders here.
      if (pathname === '/api/thumbs' && req.method === 'POST') {
        const { l, frames: wanted = [] } = await readBody(req);
        const level = normalizeLevel(l);
        if (level > RAW_LEVEL) return send(res, 400, { error: `bulk thumbnails stop at level ${RAW_LEVEL}` });
        const header = [];
        const parts = [];
        wanted.slice(0, 1000).forEach(([id, version], index) => {
          const frame = frameById(id);
          if (!frame || versionOf(frame) !== version) return;
          const hit = thumbs.cached(id, version, level);
          if (!hit || hit.type !== 'image/png') return;
          let img = null;
          try {
            img = decodePng(fs.readFileSync(hit.file));
          } catch {
            /* evicted between the check and the read */
          }
          if (!img) return;
          header.push([index, img.width, img.height]);
          parts.push(img.rgba);
        });
        const json = Buffer.from(JSON.stringify(header));
        const length = Buffer.alloc(4);
        length.writeUInt32BE(json.length);
        return send(res, 200, Buffer.concat([length, json, ...parts]), { 'Content-Type': 'application/octet-stream' });
      }

      // --- view-only export ------------------------------------------------
      if (pathname === '/api/export' && req.method === 'GET') {
        const html = buildExport(store, { thumbs });
        const headers = { 'Content-Type': 'text/html; charset=utf-8' };
        if (url.searchParams.has('download')) {
          const title = html.match(/<title>([^<]*)<\/title>/)[1];
          headers['Content-Disposition'] = `attachment; filename="${exportFilename(title)}"`;
        }
        return send(res, 200, html, headers);
      }

      // --- mutate frame geometry -------------------------------------------
      const frameMatch = pathname.match(/^\/api\/frames\/([^/]+)$/);
      if (frameMatch && (req.method === 'PATCH' || req.method === 'POST')) {
        const id = decodeURIComponent(frameMatch[1]);
        const patch = await readBody(req);
        const updated = store.update((s) => {
          const frame = s.frames.find((f) => f.id === id);
          if (!frame) return null;
          for (const key of ['x', 'y', 'w', 'h', 'z', 'name', 'background']) {
            if (patch[key] !== undefined) frame[key] = patch[key];
          }
          if (patch.w !== undefined) frame.w = Math.max(80, Math.round(frame.w));
          if (patch.h !== undefined) frame.h = Math.max(80, Math.round(frame.h));
          frame.x = Math.round(frame.x);
          frame.y = Math.round(frame.y);
          frame.updatedAt = new Date().toISOString();
          return frame;
        });
        if (!updated) return send(res, 404, { error: 'No such frame' });
        pushChanges(); // tell every tab now rather than waiting on the watcher
        return send(res, 200, clientFrame(updated));
      }

      if (frameMatch && req.method === 'DELETE') {
        const id = decodeURIComponent(frameMatch[1]);
        store.update((s) => {
          s.frames = s.frames.filter((f) => f.id !== id);
        });
        store.removeContent(id);
        pushChanges();
        return send(res, 200, { ok: true });
      }

      // --- viewport persistence ---------------------------------------------
      if (pathname === '/api/viewport' && (req.method === 'POST' || req.method === 'PATCH')) {
        const patch = await readBody(req);
        store.writeViewport({
          x: Number(patch.x) || 0,
          y: Number(patch.y) || 0,
          scale: Number(patch.scale) || 1,
        });
        return send(res, 200, { ok: true });
      }

      // --- static web UI ----------------------------------------------------
      if (req.method === 'GET') {
        const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        const file = path.join(WEB_DIR, rel);
        if (!file.startsWith(WEB_DIR)) return send(res, 403, 'Forbidden');
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
          const ext = path.extname(file).toLowerCase();
          res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Cache-Control': 'no-store',
          });
          return fs.createReadStream(file).pipe(res);
        }
      }

      send(res, 404, 'Not found');
    } catch (err) {
      if (!res.headersSent) send(res, 500, { error: String(err && err.message ? err.message : err) });
    }
  });

  // Thumbnail requests hold a socket while they render; keep-alive lets a tab
  // reuse its handful of connections instead of queueing behind new handshakes.
  server.keepAliveTimeout = 30_000;

  server.on('listening', startWatching);
  server.on('close', () => {
    watcher?.close();
    clearInterval(poller);
    thumbs.shutdown();
    store.clearLock();
  });

  return { server, store, thumbs, broadcast };
}

/** Shallow equality for flat frame records (every value is a primitive). */
function sameFrame(a, b) {
  let n = 0;
  for (const key in a) {
    if (a[key] !== b[key]) return false;
    n++;
  }
  for (const key in b) n--;
  return n === 0;
}

const statOrNull = (file) => {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
};

export async function listen({ root, port = 4321, host = '127.0.0.1' } = {}) {
  const { server, store, thumbs } = createServer({ root });
  const chosen = await tryListen(server, port, host);
  store.writeLock({ port: chosen, host, pid: process.pid, startedAt: new Date().toISOString() });
  const cleanup = () => {
    thumbs.shutdown();
    store.clearLock();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  return { server, store, thumbs, port: chosen, host, url: `http://${host}:${chosen}` };
}

/** Walk forward from the requested port until one is free. */
function tryListen(server, port, host, attempt = 0) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err.code === 'EADDRINUSE' && attempt < 20) {
        server.removeListener('error', onError);
        resolve(tryListen(server, port + 1, host, attempt + 1));
      } else {
        reject(err);
      }
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve(port);
    });
  });
}
