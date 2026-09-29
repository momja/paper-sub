// View-only export.
//
// Bundles the canvas into one self-contained HTML file: the viewer's own
// markup, CSS, and JS inlined, plus every frame's HTML as embedded data that
// the viewer loads into sandboxed `srcdoc` iframes. Cached thumbnails ride
// along so a big board opens zoomed out without rendering a thing: the
// smallest level for every frame as one deflated block of raw pixels (no
// per-image decoding in the browser), sharper ones as data URIs. No server,
// no network, no editing — open it from disk or drop it on any static host.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { wrapHtml, escapeHtml, emptyFramePlaceholder, STORE_DIRNAME } from './store.js';
import { Thumbnailer, thumbVersion, decodePng, MIN_LEVEL } from './thumbs.js';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

/** Levels baked into an export: the smallest for zoomed-out boards, and one sharp enough for a close look. */
export const EXPORT_LEVELS = [MIN_LEVEL, 512];
/** Past this many frames only the smallest level is embedded, to keep the file sane. */
const SHARP_LIMIT = 2000;

/** Default title: the project folder the canvas belongs to. */
export function defaultTitle(store) {
  const base = path.basename(store.root);
  return base === STORE_DIRNAME ? path.basename(path.dirname(store.root)) : base;
}

export function exportFilename(title) {
  const slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${slug || 'canvas'}.html`;
}

/** A thumbnailer for code that runs without the server (the CLI). */
export function standaloneThumbnailer(store) {
  const byId = new Map(store.read().frames.map((f) => [f.id, f]));
  return new Thumbnailer({
    dir: store.thumbsDir,
    idleMs: 0,
    lookup: (id) => {
      const frame = byId.get(id);
      if (!frame) return null;
      const html = store.readContent(id) || wrapHtml(emptyFramePlaceholder(frame.name), { title: frame.name });
      return { frame, version: thumbVersion(frame, store.contentRev(id)), html };
    },
  });
}

/**
 * Render whatever export thumbnails are missing. Resolves once every frame has
 * been tried; frames that fail simply ship without one.
 */
export async function renderExportThumbs(store, thumbs, { onProgress = () => {} } = {}) {
  if (!thumbs.available) return 0;
  const frames = store.read().frames;
  const levels = frames.length > SHARP_LIMIT ? [MIN_LEVEL] : EXPORT_LEVELS;
  const jobs = [];
  for (const f of frames) {
    const version = thumbVersion(f, store.contentRev(f.id));
    for (const level of levels) {
      if (!thumbs.cached(f.id, version, level)) jobs.push(thumbs.request(f.id, version, level, { urgent: false }));
    }
  }
  let done = 0;
  await Promise.all(jobs.map((job) => job.catch(() => {}).finally(() => onProgress(++done, jobs.length))));
  return jobs.length;
}

export function buildExport(store, { title, thumbs } = {}) {
  const state = store.read();
  const name = title || defaultTitle(store);
  const cache = thumbs || standaloneThumbnailer(store);
  const levels = state.frames.length > SHARP_LIMIT ? [MIN_LEVEL] : EXPORT_LEVELS;

  // Smallest level: raw RGBA for every frame, back to back, deflated.
  const packIndex = [];
  const packParts = [];
  const frames = state.frames.map((f) => {
    const contentRev = store.contentRev(f.id);
    const tv = thumbVersion(f, contentRev);
    const small = cache.cached(f.id, tv, MIN_LEVEL);
    const img = small && small.type === 'image/png' ? decodePng(fs.readFileSync(small.file)) : null;
    if (img) {
      packIndex.push([f.id, img.width, img.height]);
      packParts.push(img.rgba);
    }
    const embedded = {};
    for (const level of levels) {
      if (level === MIN_LEVEL && img) continue; // already in the pack
      const hit = cache.cached(f.id, tv, level);
      if (hit) embedded[level] = `data:${hit.type};base64,${fs.readFileSync(hit.file).toString('base64')}`;
    }
    return {
      id: f.id,
      name: f.name,
      x: f.x,
      y: f.y,
      w: f.w,
      h: f.h,
      background: f.background,
      note: f.note || '',
      contentRev: 1, // the viewer loads a frame once it has a content revision
      tv,
      tone: cache.tone(f.id),
      thumbs: embedded,
      html:
        store.readContent(f.id) ||
        wrapHtml(emptyFramePlaceholder(f.name, { hint: false }), { title: f.name }),
    };
  });
  const thumbPack = packIndex.length
    ? {
        level: MIN_LEVEL,
        index: packIndex,
        data: zlib.deflateRawSync(Buffer.concat(packParts)).toString('base64'),
      }
    : null;

  // `<` escaped so frame markup can never close the data <script> early.
  const data = JSON.stringify({ title: name, exportedAt: new Date().toISOString(), frames, thumbPack }).replace(
    /</g,
    '\\u003c'
  );
  const css = fs.readFileSync(path.join(WEB_DIR, 'style.css'), 'utf8');
  const js = bundle('app.js').replace(/<\/script/gi, '<\\/script');
  const index = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');

  // Function replacers: the inlined sources contain `$` sequences that a
  // string replacement would interpret.
  return index
    .replace(/<title>[^<]*<\/title>/, () => `<title>${escapeHtml(name)}</title>`)
    .replace('<link rel="stylesheet" href="/style.css">', () => `<style>\n${css}</style>`)
    .replace('<body>', () => '<body class="readonly">')
    .replace(
      '<script type="module" src="/app.js"></script>',
      () =>
        `<script id="paper-data" type="application/json">${data}</script>\n` +
        `<script type="module">\n${js}</script>`
    );
}

/**
 * Inline the viewer's ES modules into one script. Deliberately tiny: it
 * handles exactly the forms web/ uses — `import { a, b } from './x.js'` and
 * `export function|class|const|let` — and wraps each module in its own scope.
 */
export function bundle(entry) {
  const modules = [];
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    let src = fs.readFileSync(path.join(WEB_DIR, file), 'utf8');
    src = src.replace(/^import\s*\{([^}]*)\}\s*from\s*'\.\/([\w.-]+\.js)';?[ \t]*$/gm, (_, names, dep) => {
      visit(dep);
      return `const {${names}} = __modules[${JSON.stringify(dep)}];`;
    });
    if (/^\s*import\s/m.test(src)) throw new Error(`bundle: unsupported import in web/${file}`);
    const exported = [];
    src = src.replace(/^export\s+(async\s+function|function|class|const|let)\s+([\w$]+)/gm, (_, kind, id) => {
      exported.push(id);
      return `${kind} ${id}`;
    });
    modules.push({ file, src, exported });
  };
  visit(entry);
  return (
    'const __modules = {};\n' +
    modules
      .map(
        ({ file, src, exported }) =>
          `__modules[${JSON.stringify(file)}] = (() => {\n${src}\nreturn { ${exported.join(', ')} };\n})();`
      )
      .join('\n')
  );
}
