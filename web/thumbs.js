// Thumbnail residency.
//
// Decides which frames need which resolution, fetches them, and keeps the GPU
// atlas within budget. Each frame holds at most one texture. The level it
// wants is the power of two just above its on-screen size in device pixels,
// so the pixels resident on the GPU track the pixels on screen no matter how
// many frames the board holds. Zoomed out, frames drop to 32px thumbnails;
// off-screen frames are the first to give their texture back.

export const MIN_LEVEL = 32;
export const MAX_LEVEL = 2048;

const nextPow2 = (n) => 2 ** Math.ceil(Math.log2(Math.max(1, n)));
export const levelFor = (px) => Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, nextPow2(px)));

/** Most requests plan() lines up per pass; it runs again long before they drain. */
const WANT_MAX = 1500;
/** Most frames plan() looks at per pass when working through the missing set. */
const WALK_MAX = 12000;
/**
 * Below this many device pixels a frame shows its average colour (the shader
 * fades textures out there anyway), so it asks for no texture at all.
 */
const MIN_TEXTURE_PX = 8;
/** Most texel bytes moved to the GPU per frame. */
const UPLOAD_BYTES = 4 * 1024 * 1024;
/** Off-screen prefetch stops once the atlas is this full, leaving room for what's visible. */
const PREFETCH_FILL = 0.6;
/** Levels this small travel many to a request when the source can batch. */
const BATCH_LEVEL = 64;
const BATCH_MAX = 200;

export class Thumbs {
  /**
   * @param {object} opts
   * @param {import('./gl.js').Atlas} opts.atlas
   * @param {{ load: (frame: any, level: number) => Promise<ImageBitmap>, concurrency: number }} opts.source
   * @param {(id: string) => void} opts.onResident  called when a frame's texture changes
   * @param {(frame: any, tone: number) => void} [opts.onTone]  a tone learned from pixels
   */
  constructor({ atlas, source, onResident, onTone = () => {} }) {
    this.atlas = atlas;
    this.source = source;
    this.onResident = onResident;
    this.onTone = onTone;
    /** id → { slot, level, tv, seen, f } */
    this.resident = new Map();
    /** frames without a texture for their current version */
    this.missing = new Set();
    /** id → { level, tv } for requests in flight */
    this.pending = new Map();
    /** frame → its last failure {tv, level, at}, so broken frames aren't hammered */
    this.failed = new WeakMap();
    this.uploads = [];
    this.wants = [];
    this.inflight = 0;
    this.background = [];
    // Scratch space for plan(): priority keys, levels and frames of candidates.
    this.keys = new Float64Array(0);
    this.levels = new Uint16Array(0);
    this.refs = [];
    /** frame → {tv, at}: off-screen frames the server hadn't rendered when last asked */
    this.later = new WeakMap();
    /** frame → {tv, level} the batch endpoint didn't have; those go singly (and get rendered) */
    this.unbatchable = new WeakMap();
    this.broken = false;
    this.toneCtx = null;
  }

  slot(id) {
    return this.resident.get(id)?.slot || null;
  }

  has(id) {
    return this.resident.has(id);
  }

  /**
   * Work out what visible frames should have and start fetching the most
   * important gaps. Runs several times a second, so it allocates nothing per
   * frame and never sorts more than it can use: candidates go into typed
   * arrays and only the most urgent WANT_MAX are picked out and ordered.
   *
   * @param {object} p
   * @param {{x0: number, y0: number, x1: number, y1: number}} p.rect  visible world rect
   * @param {(x0: number, y0: number, x1: number, y1: number, fn: (f: any) => void) => void} p.query
   *        frames overlapping a world rect
   * @param {number} p.maxDim  longest side of the largest frame
   * @param {number} p.pxPerUnit  device pixels per world unit
   * @param {(id: string) => number} p.ceiling  highest level worth holding for a frame;
   *        0 means "keep whatever it has" (a live iframe is covering it)
   */
  plan({ rect, query, maxDim, pxPerUnit, ceiling }) {
    if (this.broken) return;
    const now = performance.now();
    const padX = (rect.x1 - rect.x0) * 0.25;
    const padY = (rect.y1 - rect.y0) * 0.25;
    const x0 = rect.x0 - padX;
    const x1 = rect.x1 + padX;
    const y0 = rect.y0 - padY;
    const y1 = rect.y1 + padY;
    const cx = (rect.x0 + rect.x1) / 2;
    const cy = (rect.y0 + rect.y1) / 2;
    this.near = { x0, y0, x1, y1 }; // eviction never touches frames in here

    let n = 0;
    const consider = (f) => {
      const r = this.resident.get(f.id);
      if (r) r.seen = now;
      const px = Math.max(f.w, f.h) * pxPerUnit;
      if (px < MIN_TEXTURE_PX && !r) return;
      let level = levelFor(px * 0.9);
      const cap = ceiling(f.id);
      if (cap === 0) {
        if (r) level = Math.min(level, r.level);
      } else {
        level = Math.min(level, Math.max(MIN_LEVEL, cap));
      }
      const fresh = r && r.tv === f.tv;
      if (fresh && r.level >= level) return;
      if (n === this.keys.length) this.growScratch();
      // Missing beats stale beats blurry; then nearest the centre first.
      const rank = !r ? 0 : !fresh ? 1 : 2;
      const dx = f.x + f.w / 2 - cx;
      const dy = f.y + f.h / 2 - cy;
      this.keys[n] = rank * 1e18 + dx * dx + dy * dy; // rank dominates; float64 keeps the distance
      this.levels[n] = level;
      this.refs[n] = f;
      n++;
    };
    if (maxDim * pxPerUnit < MIN_TEXTURE_PX) {
      // Every frame is a speck: colours only, nothing to plan.
    } else if (maxDim * pxPerUnit * 0.9 <= MIN_LEVEL) {
      // Zoomed far out, every frame wants the smallest level, so only frames
      // lacking one matter: walk that set (it empties as thumbnails land)
      // instead of every frame on the board, a bounded slice per pass.
      this.walk('near', WALK_MAX, (f) => {
        if (f.x < x1 && f.x + f.w > x0 && f.y < y1 && f.y + f.h > y0) consider(f);
      });
    } else {
      query(x0, y0, x1, y1, consider);
    }

    const k = Math.min(n, WANT_MAX);
    if (n > k) selectSmallest(this.keys, this.levels, this.refs, n, k);
    const picked = Array.from({ length: k }, (_, i) => i).sort((a, b) => this.keys[b] - this.keys[a]);
    // Queues are kept best-last so taking from them is a cheap pop().
    this.wants = picked.map((i) => ({ f: this.refs[i], level: this.levels[i] }));
    this.refs.fill(null, 0, n); // don't pin removed frames

    // Off screen, only frames with nothing at all are worth a (small) fetch,
    // and only while the atlas has room to spare.
    const background = [];
    const backgroundMax = this.atlas.used < this.atlas.budget * PREFETCH_FILL ? (this.source.loadMany ? BATCH_MAX : 1) : 0;
    if (backgroundMax) this.walk('far', WALK_MAX, (f) => {
      if (f.x < x1 && f.x + f.w > x0 && f.y < y1 && f.y + f.h > y0) return false;
      if (!this.pending.has(f.id) && !this.notYet(f, now) && !this.recentlyFailed(f, MIN_LEVEL, now)) {
        background.push({ f, level: MIN_LEVEL });
      }
      return background.length >= backgroundMax;
    });
    this.background = background.reverse();
    this.pump();
  }

  /**
   * Visit up to `limit` frames of `missing`, carrying on where the previous
   * walk of the same name stopped (Set iterators survive edits), so a huge
   * set is covered over a few passes instead of all in one. `fn` may return
   * true to stop early.
   */
  walk(name, limit, fn) {
    const iters = (this.iters ??= {});
    let it = iters[name];
    let wrapped = false;
    for (let n = 0; n < Math.min(limit, this.missing.size); ) {
      if (!it) it = this.missing.values();
      const { value, done } = it.next();
      if (done) {
        it = null;
        if (wrapped) break;
        wrapped = true;
        continue;
      }
      n++;
      if (fn(value)) break;
    }
    iters[name] = it;
  }

  growScratch() {
    const size = Math.max(1024, this.keys.length * 2);
    const keys = new Float64Array(size);
    keys.set(this.keys);
    const levels = new Uint16Array(size);
    levels.set(this.levels);
    this.keys = keys;
    this.levels = levels;
    this.refs.length = size;
  }

  pump() {
    const now = performance.now();
    const skip = ({ f, level }) => {
      const p = this.pending.get(f.id);
      // Let an in-flight request land first; plan() will ask again if needed.
      return Boolean(p) || this.recentlyFailed(f, level, now);
    };
    for (const queue of [this.wants, this.background]) {
      const offscreen = queue === this.background;
      while (this.inflight < this.source.concurrency && queue.length) {
        const batch = this.source.loadMany ? this.takeBatch(queue, skip) : [];
        // Off-screen frames only collect thumbnails that already exist; the
        // server renders the rest in its own time, without anyone waiting.
        if (batch.length > 1 || (batch.length && offscreen)) {
          this.fetchMany(batch, offscreen);
          continue;
        }
        const next = batch[0] || queue.pop();
        if (!next) break;
        if (!skip(next)) this.fetch(next.f, next.level);
      }
    }
  }

  /** Pull a run of same-level small requests off the head (the end) of a queue. */
  takeBatch(queue, skip) {
    const batch = [];
    while (queue.length && batch.length < BATCH_MAX) {
      const w = queue[queue.length - 1];
      if (skip(w)) {
        queue.pop();
        continue;
      }
      if (w.level > BATCH_LEVEL || (batch.length && w.level !== batch[0].level)) break;
      if (this.isUnbatchable(w.f, w.level)) break;
      batch.push(queue.pop());
    }
    return batch;
  }

  /**
   * Many small thumbnails in one round trip. Visible frames the server lacks
   * go singly next (which renders them); off-screen ones just try again later.
   */
  async fetchMany(batch, offscreen = false) {
    const tvs = batch.map(({ f, level }) => {
      this.pending.set(f.id, { level, tv: f.tv });
      return f.tv;
    });
    this.inflight++;
    try {
      const bitmaps = await this.source.loadMany(batch);
      batch.forEach(({ f, level }, i) => {
        const bitmap = bitmaps[i];
        if (!bitmap) {
          if (offscreen) this.later.set(f, { tv: tvs[i], at: performance.now() });
          else this.unbatchable.set(f, { tv: tvs[i], level });
        } else if (f.tv !== tvs[i] || f.removed) bitmap.close();
        else this.uploads.push({ f, level, tv: tvs[i], bitmap });
      });
    } catch {
      const at = performance.now();
      for (const { f } of batch) this.later.set(f, { tv: f.tv, at });
    } finally {
      for (const { f } of batch) this.pending.delete(f.id);
      this.inflight--;
      this.onResident(null);
      this.pump();
    }
  }

  recentlyFailed(f, level, now) {
    const x = this.failed.get(f);
    return x !== undefined && x.tv === f.tv && x.level === level && now - x.at < 15000;
  }

  fail(f, tv, level) {
    this.failed.set(f, { tv, level, at: performance.now() });
  }

  /** Off screen and not rendered yet: leave it to the server for a few seconds. */
  notYet(f, now) {
    const x = this.later.get(f);
    return x !== undefined && x.tv === f.tv && now - x.at < 5000;
  }

  isUnbatchable(f, level) {
    const x = this.unbatchable.get(f);
    return x !== undefined && x.tv === f.tv && x.level === level;
  }

  async fetch(f, level) {
    const tv = f.tv;
    this.pending.set(f.id, { level, tv });
    this.inflight++;
    try {
      const bitmap = await this.source.load(f, level);
      // A source may hand back less than asked (an export's best embedded
      // level). Record what actually arrived, and don't ask again for a while.
      // Small frames legitimately come back smaller: captures stop at 2x.
      const got = Math.max(bitmap.width, bitmap.height);
      if (got < level * 0.95 && got < Math.max(f.w, f.h) * 2 - 1) {
        this.fail(f, tv, level);
        level = levelFor(got);
      }
      if (f.tv !== tv || f.removed) bitmap.close();
      else this.uploads.push({ f, level, tv, bitmap });
    } catch {
      this.fail(f, tv, level);
    } finally {
      this.pending.delete(f.id);
      this.inflight--;
      this.onResident(null); // nudge the loop: process the upload, plan the next
      this.pump(); // and keep the pipe full meanwhile
    }
  }

  /**
   * Move decoded bitmaps into the atlas, within a time and size budget so a
   * burst of arrivals never costs a dropped frame. Returns true when work remains.
   */
  upload(budgetMs) {
    const start = performance.now();
    let bytes = 0;
    // Time alone isn't enough: two 1024px textures can land in one frame and
    // blow it. Cap the texels too (at least one upload always goes through).
    while (this.uploads.length && performance.now() - start < budgetMs && bytes < UPLOAD_BYTES) {
      const { f, level, tv, bitmap } = this.uploads.shift();
      bytes += bitmap.width * bitmap.height * 4;
      if (f.removed || f.tv !== tv) {
        bitmap.close();
        continue;
      }
      const prev = this.resident.get(f.id);
      if (prev && prev.tv === tv && prev.level >= level) {
        bitmap.close();
        continue;
      }
      let slot = this.atlas.alloc(bitmap.width, bitmap.height);
      if (!slot && this.evict(f.id)) slot = this.atlas.alloc(bitmap.width, bitmap.height);
      if (!slot) {
        // Everything resident is on screen: back off rather than refetch in a loop.
        this.fail(f, tv, level);
        bitmap.close();
        continue;
      }
      try {
        this.atlas.upload(slot, bitmap);
      } catch (err) {
        // A tainted bitmap (Safari and foreignObject) can never reach WebGL.
        this.atlas.release(slot);
        bitmap.close();
        if (err && err.name === 'SecurityError') {
          if (this.source.onTaint) this.source.onTaint();
          else this.broken = true;
        }
        continue;
      }
      if (f.tone === undefined) this.learnTone(f, bitmap);
      bitmap.close();
      if (prev) this.atlas.release(prev.slot);
      this.resident.set(f.id, { slot, level, tv, seen: performance.now(), f });
      this.missing.delete(f);
      this.onResident(f.id);
    }
    return this.uploads.length > 0;
  }

  /**
   * Free textures of frames outside the view (and its margin), largest and
   * least recently seen first, until a decent chunk is free. Never touches
   * `keep`. Returns false when everything resident is in view.
   */
  evict(keep) {
    const near = this.near;
    const idle = [];
    for (const [id, r] of this.resident) {
      const f = r.f;
      const inView = near && f.x < near.x1 && f.x + f.w > near.x0 && f.y < near.y1 && f.y + f.h > near.y0;
      if (id !== keep && !inView) idle.push([id, r]);
    }
    if (!idle.length) return false;
    idle.sort((a, b) => b[1].slot.size - a[1].slot.size || a[1].seen - b[1].seen);
    // Free a decent chunk at once so the next few uploads don't each evict.
    const target = Math.max(idle[0][1].slot.size ** 2 * 4, this.atlas.bytes / 8);
    let freed = 0;
    for (const [id, r] of idle) {
      this.atlas.release(r.slot);
      this.resident.delete(id);
      this.missing.add(r.f);
      this.onResident(id);
      freed += r.slot.size ** 2 * 4;
      if (freed >= target) break;
    }
    return true;
  }

  /** A frame appeared or its content changed: it needs a texture for this version. */
  track(f) {
    const r = this.resident.get(f.id);
    if (!r || r.tv !== f.tv) this.missing.add(f);
  }

  /** A frame is gone for good. */
  drop(f) {
    this.missing.delete(f);
    const r = this.resident.get(f.id);
    if (r) {
      this.atlas.release(r.slot);
      this.resident.delete(f.id);
    }
  }

  /** The GPU forgot everything (context loss): start over with a new atlas. */
  reset(atlas) {
    this.atlas = atlas;
    for (const r of this.resident.values()) this.missing.add(r.f);
    this.resident.clear();
    for (const u of this.uploads) u.bitmap.close();
    this.uploads = [];
  }

  /** Average colour of a bitmap, for frames the server had no tone for. */
  learnTone(f, bitmap) {
    if (bitmap.data) {
      let r = 0;
      let g = 0;
      let b = 0;
      const px = bitmap.data;
      for (let i = 0; i < px.length; i += 4) {
        r += px[i];
        g += px[i + 1];
        b += px[i + 2];
      }
      const n = px.length / 4 || 1;
      this.onTone(f, packRGBA(r / n, g / n, b / n, 255));
      return;
    }
    try {
      if (!this.toneCtx) {
        const c = document.createElement('canvas');
        c.width = c.height = 4;
        this.toneCtx = c.getContext('2d', { willReadFrequently: true });
      }
      const ctx = this.toneCtx;
      ctx.clearRect(0, 0, 4, 4);
      ctx.drawImage(bitmap, 0, 0, 4, 4);
      const px = ctx.getImageData(0, 0, 4, 4).data;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let i = 0; i < px.length; i += 4) {
        r += px[i];
        g += px[i + 1];
        b += px[i + 2];
      }
      this.onTone(f, packRGBA(r / 16, g / 16, b / 16, 255));
    } catch {
      /* tainted — keep the fallback colour */
    }
  }
}

/**
 * Partially order parallel arrays so their k smallest keys occupy [0, k), in
 * no particular order (quickselect). O(n) on average against a sort's n log n.
 */
function selectSmallest(keys, levels, refs, n, k) {
  const swap = (i, j) => {
    const key = keys[i];
    keys[i] = keys[j];
    keys[j] = key;
    const level = levels[i];
    levels[i] = levels[j];
    levels[j] = level;
    const ref = refs[i];
    refs[i] = refs[j];
    refs[j] = ref;
  };
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const pivot = keys[(lo + hi) >> 1];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (keys[i] < pivot) i++;
      while (keys[j] > pivot) j--;
      if (i <= j) swap(i++, j--);
    }
    if (k - 1 <= j) hi = j;
    else if (k - 1 >= i) lo = i;
    else break;
  }
}

/** Pixels that skip image decoding entirely; shaped like an ImageBitmap where it matters. */
const rawImage = (width, height, data) => ({ width, height, data, close() {} });

export const packRGBA = (r, g, b, a = 255) =>
  ((Math.round(a) << 24) | (Math.round(b) << 16) | (Math.round(g) << 8) | Math.round(r)) >>> 0;

// ----------------------------------------------------------------- sources --

/**
 * Server-rendered thumbnails: real Chromium screenshots, cached forever by URL.
 * When the server can't render one (no browser on that machine), `fallback`
 * draws it here instead.
 */
export function serverSource(fallback) {
  return {
    concurrency: 4,
    /**
     * Cached small thumbnails in bulk, as raw pixels ready for the GPU (see
     * /api/thumbs); null for any the server doesn't have yet.
     */
    async loadMany(list) {
      const res = await fetch('/api/thumbs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ l: list[0].level, frames: list.map(({ f }) => [f.id, f.tv]) }),
      });
      if (!res.ok) throw new Error(`thumbs ${res.status}`);
      const buf = await res.arrayBuffer();
      const headerLength = new DataView(buf).getUint32(0);
      const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, headerLength)));
      const out = new Array(list.length).fill(null);
      let offset = 4 + headerLength;
      for (const [index, width, height] of header) {
        const length = width * height * 4;
        out[index] = rawImage(width, height, new Uint8Array(buf, offset, length));
        offset += length;
      }
      return out;
    },
    async load(f, level) {
      const res = await fetch(`/api/thumb/${encodeURIComponent(f.id)}?l=${level}&v=${encodeURIComponent(f.tv)}`);
      if (res.ok) return createImageBitmap(await res.blob());
      if (res.status === 503 && fallback) return fallback.load(f, level);
      throw new Error(`thumb ${res.status}`);
    },
  };
}

/**
 * Thumbnails rendered in this tab by drawing the frame's markup through an
 * SVG foreignObject. Used when there is no server-side browser (and in
 * exports). Scripts don't run and remote assets don't load, so it is a
 * sketch of the frame rather than a screenshot; live iframes take over once
 * you zoom in.
 */
export function localSource(htmlFor) {
  let chain = Promise.resolve();
  return {
    concurrency: 1,
    load(f, level) {
      // One at a time, each in its own task: rasterising SVG runs on the main thread.
      const job = chain.then(() => new Promise((r) => setTimeout(r, 0))).then(async () => rasterize(await htmlFor(f), f.w, f.h, level));
      chain = job.catch(() => {});
      return job;
    },
  };
}

async function rasterize(html, w, h, level) {
  const scale = Math.min(2, level / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const el of doc.querySelectorAll('script, noscript')) el.remove();
  const xhtml = new XMLSerializer().serializeToString(doc.documentElement);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<rect width="100%" height="100%" fill="#fff"/>` +
    `<foreignObject width="100%" height="100%">${xhtml}</foreignObject></svg>`;
  // A data: URL drawn through a canvas. Chromium taints foreignObject images
  // loaded from blob: URLs, and createImageBitmap() on the image taints too;
  // either way WebGL would refuse the result. Drawn this way it stays clean,
  // even in an export opened from file://.
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(tw, th);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, tw, th);
    return canvas.transferToImageBitmap();
  }
  const canvas = Object.assign(document.createElement('canvas'), { width: tw, height: th });
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, tw, th);
  return createImageBitmap(canvas);
}

/**
 * Thumbnails baked into an export (see src/export.js): the smallest level for
 * every frame as one deflated block of raw pixels, sharper levels as data
 * URIs, and local rendering to fill in anything sharper still.
 */
export function embeddedSource(fallback, pack) {
  const small = unpack(pack);
  const fromPack = async (f, level) => (level <= (pack?.level ?? 0) ? ((await small).get(f.id) ?? null) : null);
  return {
    concurrency: 2,
    // Local renders that the browser taints are useless to WebGL; stop making them.
    onTaint() {
      fallback = null;
    },
    async loadMany(list) {
      return Promise.all(list.map(({ f, level }) => fromPack(f, level)));
    },
    async load(f, level) {
      const packed = await fromPack(f, level);
      if (packed) return packed;
      const levels = Object.keys(f.thumbs || {}).map(Number).sort((a, b) => a - b);
      const fit = levels.find((l) => l >= level);
      if (fit === undefined && fallback) {
        try {
          return await fallback.load(f, level);
        } catch {
          /* fall through to the best embedded level */
        }
      }
      const pick = fit ?? levels[levels.length - 1];
      if (pick === undefined) {
        const any = (await small).get(f.id);
        if (any) return any;
        throw new Error('no thumbnail');
      }
      const res = await fetch(f.thumbs[pick]);
      return createImageBitmap(await res.blob());
    },
  };
}

/** Inflate an export's pixel pack into id → raw image. */
async function unpack(pack) {
  const out = new Map();
  if (!pack) return out;
  try {
    const bytes = await (await fetch(`data:application/octet-stream;base64,${pack.data}`)).blob();
    const buf = await new Response(bytes.stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
    let offset = 0;
    for (const [id, width, height] of pack.index) {
      const length = width * height * 4;
      out.set(id, rawImage(width, height, new Uint8Array(buf, offset, length)));
      offset += length;
    }
  } catch {
    /* no DecompressionStream (an old browser): data URIs and live iframes still work */
  }
  return out;
}
