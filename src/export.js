// View-only export.
//
// Bundles the canvas into one self-contained HTML file: the viewer's own
// markup, CSS, and JS inlined, plus every frame's HTML as embedded data that
// the viewer loads into sandboxed `srcdoc` iframes. No server, no network, no
// editing — open it from disk or drop it on any static host.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wrapHtml, escapeHtml, emptyFramePlaceholder, STORE_DIRNAME } from './store.js';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

/** Default title: the project folder the canvas belongs to. */
export function defaultTitle(store) {
  const base = path.basename(store.root);
  return base === STORE_DIRNAME ? path.basename(path.dirname(store.root)) : base;
}

export function exportFilename(title) {
  const slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${slug || 'canvas'}.html`;
}

export function buildExport(store, { title } = {}) {
  const state = store.read();
  const name = title || defaultTitle(store);

  const frames = state.frames.map((f) => ({
    id: f.id,
    name: f.name,
    x: f.x,
    y: f.y,
    w: f.w,
    h: f.h,
    background: f.background,
    note: f.note || '',
    contentRev: 1, // the viewer loads a frame once it has a content revision
    html:
      store.readContent(f.id) ||
      wrapHtml(emptyFramePlaceholder(f.name, { hint: false }), { title: f.name }),
  }));

  // `<` escaped so frame markup can never close the data <script> early.
  const data = JSON.stringify({ title: name, exportedAt: new Date().toISOString(), frames }).replace(
    /</g,
    '\\u003c'
  );
  const css = fs.readFileSync(path.join(WEB_DIR, 'style.css'), 'utf8');
  const js = fs.readFileSync(path.join(WEB_DIR, 'app.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
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
