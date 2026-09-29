// Live iframes.
//
// Thumbnails cover the board; real iframes exist only for the handful of
// frames you are close enough to care about, plus the one you have stepped
// into. An iframe fades in over its thumbnail once it has painted, a content
// update loads into a second iframe that replaces the first only when ready
// (no white flash), and iframes that scroll away are parked rather than torn
// down, so panning back and forth doesn't reload them.

const PARKED_MAX = 6;

export class LiveLayer {
  /**
   * @param {HTMLElement} world  transformed container that holds the iframes
   * @param {object} opts
   * @param {(frame: any) => {src?: string, srcdoc?: string}} opts.source
   * @param {() => void} opts.onChange  an iframe became ready or went away
   */
  constructor(world, { source, onChange }) {
    this.world = world;
    this.source = source;
    this.onChange = onChange;
    /** id → { el, iframe, next, ready, rev, parkedAt } */
    this.entries = new Map();
    this.interactive = null;
  }

  get size() {
    let n = 0;
    for (const e of this.entries.values()) if (!e.parkedAt) n++;
    return n;
  }

  /** True when a painted iframe is covering this frame's thumbnail. */
  ready(id) {
    const e = this.entries.get(id);
    return Boolean(e && e.ready && !e.parkedAt);
  }

  mounted(id) {
    const e = this.entries.get(id);
    return Boolean(e && !e.parkedAt);
  }

  /**
   * Make exactly `frames` live (parking the rest).
   * @param {any[]} frames
   * @param {(id: string) => number} zOf  stacking order, so overlapping iframes stack like thumbnails
   */
  show(frames, zOf) {
    const want = new Set(frames.map((f) => f.id));
    const now = performance.now();
    for (const [id, e] of this.entries) {
      if (!want.has(id) && !e.parkedAt) {
        e.parkedAt = now;
        e.el.style.display = 'none';
      }
    }
    for (const f of frames) {
      const e = this.entries.get(f.id);
      if (!e) this.mount(f, zOf(f.id));
      else if (e.parkedAt) {
        e.parkedAt = 0;
        e.el.style.display = '';
        this.place(f, zOf(f.id));
      }
    }
    // Keep the most recently parked few; the rest free their documents.
    const parked = [...this.entries].filter(([, e]) => e.parkedAt).sort((a, b) => b[1].parkedAt - a[1].parkedAt);
    for (const [id] of parked.slice(PARKED_MAX)) this.remove(id);
  }

  mount(f, z) {
    const el = document.createElement('div');
    el.className = 'live';
    const e = { el, iframe: null, next: null, ready: false, rev: f.contentRev, parkedAt: 0 };
    this.entries.set(f.id, e);
    this.world.appendChild(el);
    this.load(f, e);
    this.place(f, z);
    if (this.interactive === f.id) el.classList.add('interactive');
  }

  /** Load the frame's current content into a fresh iframe; swap it in once painted. */
  load(f, e) {
    const iframe = document.createElement('iframe');
    // No allow-same-origin: designs render and run scripts in an opaque
    // origin so generated markup can't reach back into the canvas.
    iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups');
    iframe.title = f.name;
    const src = this.source(f);
    if (src.srcdoc !== undefined) iframe.srcdoc = src.srcdoc;
    else iframe.src = src.src;
    iframe.addEventListener('load', () => {
      // Two frames for the first paint to land before revealing it.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (e.next !== iframe && e.iframe !== iframe) return; // superseded
          if (e.next === iframe) {
            e.iframe?.remove();
            e.iframe = iframe;
            e.next = null;
          }
          iframe.classList.add('ready');
          e.ready = true;
          this.onChange();
        })
      );
    });
    if (e.iframe) {
      e.next?.remove();
      e.next = iframe;
    } else {
      e.iframe = iframe;
    }
    e.el.appendChild(iframe);
  }

  /** Position and size in world units; the world container does the zoom. */
  place(f, z) {
    const e = this.entries.get(f.id);
    if (!e) return;
    e.el.style.transform = `translate(${f.x}px, ${f.y}px)`;
    e.el.style.width = `${f.w}px`;
    e.el.style.height = `${f.h}px`;
    if (z !== undefined) e.el.style.zIndex = String(z);
  }

  /** Draw order changed (a frame was raised): restack iframes to match. */
  restack(zOf) {
    for (const [id, e] of this.entries) e.el.style.zIndex = String(Math.max(0, zOf(id)));
  }

  /** Content changed. Live iframes reload in place; parked ones are dropped. */
  update(f) {
    const e = this.entries.get(f.id);
    if (!e || e.rev === f.contentRev) return;
    e.rev = f.contentRev;
    if (e.parkedAt) this.remove(f.id);
    else this.load(f, e);
  }

  reload(f) {
    const e = this.entries.get(f.id);
    if (e && !e.parkedAt) this.load(f, e);
  }

  setInteractive(id) {
    if (this.interactive) this.entries.get(this.interactive)?.el.classList.remove('interactive');
    this.interactive = id;
    if (id) this.entries.get(id)?.el.classList.add('interactive');
  }

  remove(id) {
    const e = this.entries.get(id);
    if (!e) return;
    e.el.remove();
    this.entries.delete(id);
    this.onChange();
  }
}
