// Local canvas server.
//
// Serves the web UI, exposes a small JSON API for the browser (frame moves and
// resizes), and streams store changes to every open tab over Server-Sent Events.
// The CLI never talks to this process — it edits the store on disk and the
// watcher below turns that into a live update.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, wrapHtml, emptyFramePlaceholder } from './store.js';
import { buildExport, exportFilename } from './export.js';

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
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try {
        res.write(chunk);
      } catch {
        clients.delete(res);
      }
    }
  };

  // --- watch the store -----------------------------------------------------
  // fs.watch fires several times for one logical save (temp file, rename), so
  // coalesce into a single broadcast and drop no-op revisions.
  let lastRev = store.read().rev;
  let debounce = null;
  const pushState = () => {
    const state = store.read();
    if (state.rev === lastRev) return;
    lastRev = state.rev;
    broadcast('state', withContentRevs(store, state));
  };
  let watcher = null;
  const startWatching = () => {
    try {
      watcher = fs.watch(store.root, { recursive: true }, () => {
        clearTimeout(debounce);
        debounce = setTimeout(pushState, 60);
      });
    } catch {
      // Recursive watch is unsupported on some platforms; fall back to polling.
      setInterval(pushState, 750).unref();
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
        res.write(': connected\n\n');
        res.write(`event: state\ndata: ${JSON.stringify(withContentRevs(store, store.read()))}\n\n`);
        clients.add(res);
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
        return send(res, 200, withContentRevs(store, store.read()));
      }

      // --- frame preview document (iframe src) -----------------------------
      if (pathname.startsWith('/api/preview/')) {
        const id = decodeURIComponent(pathname.slice('/api/preview/'.length));
        const state = store.read();
        const frame = state.frames.find((f) => f.id === id);
        if (!frame) return send(res, 404, 'No such frame');
        const html = store.readContent(id);
        return send(res, 200, html || wrapHtml(emptyFramePlaceholder(frame.name), { title: frame.name }), {
          'Content-Type': 'text/html; charset=utf-8',
        });
      }

      // --- raw source ------------------------------------------------------
      // Resolve through the frame list so the id can never become a path.
      if (pathname.startsWith('/api/source/')) {
        const id = decodeURIComponent(pathname.slice('/api/source/'.length));
        const known = store.read().frames.some((f) => f.id === id);
        if (!known) return send(res, 404, 'No such frame');
        return send(res, 200, store.readContent(id), { 'Content-Type': 'text/plain; charset=utf-8' });
      }

      // --- view-only export ------------------------------------------------
      if (pathname === '/api/export' && req.method === 'GET') {
        const html = buildExport(store);
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
        const updated = store.update((state) => {
          const frame = state.frames.find((f) => f.id === id);
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
        lastRev = store.read().rev; // our own write; don't echo it back
        if (!updated) return send(res, 404, { error: 'No such frame' });
        broadcast('frame', updated);
        return send(res, 200, updated);
      }

      if (frameMatch && req.method === 'DELETE') {
        const id = decodeURIComponent(frameMatch[1]);
        store.update((state) => {
          state.frames = state.frames.filter((f) => f.id !== id);
        });
        store.removeContent(id);
        lastRev = store.read().rev;
        broadcast('removed', { id });
        return send(res, 200, { ok: true });
      }

      // --- viewport persistence ---------------------------------------------
      if (pathname === '/api/viewport' && (req.method === 'POST' || req.method === 'PATCH')) {
        const patch = await readBody(req);
        store.update((state) => {
          state.viewport = {
            x: Number(patch.x) || 0,
            y: Number(patch.y) || 0,
            scale: Number(patch.scale) || 1,
          };
        });
        lastRev = store.read().rev;
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
      send(res, 500, { error: String(err && err.message ? err.message : err) });
    }
  });

  server.on('listening', startWatching);
  server.on('close', () => {
    watcher?.close();
    store.clearLock();
  });

  return { server, store, broadcast };
}

/**
 * Stamp each frame with a hash of its file mtime+size so the browser knows when
 * to reload an iframe without diffing markup.
 */
function withContentRevs(store, state) {
  return {
    ...state,
    frames: state.frames.map((f) => {
      let contentRev = 0;
      try {
        const st = fs.statSync(store.framePath(f.id));
        contentRev = Math.round(st.mtimeMs) ^ st.size;
      } catch {
        /* no content yet */
      }
      return { ...f, contentRev };
    }),
  };
}

export async function listen({ root, port = 4321, host = '127.0.0.1' } = {}) {
  const { server, store } = createServer({ root });
  const chosen = await tryListen(server, port, host);
  store.writeLock({ port: chosen, host, pid: process.pid, startedAt: new Date().toISOString() });
  const cleanup = () => {
    store.clearLock();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  return { server, store, port: chosen, host, url: `http://${host}:${chosen}` };
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
