// Spatial index.
//
// A uniform grid over world space answering "which frames touch this
// rectangle". Zoomed in, the view covers a few cells, so planning, labels and
// hit testing cost what is on screen rather than what is on the board.
// Zoomed all the way out every frame is visible anyway, and a query simply
// walks every cell.

const CELL = 2048;
const BIAS = 32768; // cell coordinates as non-negative 16-bit halves of a key

export class Grid {
  constructor() {
    /** key → frames overlapping that cell */
    this.cells = new Map();
    /** every frame, for queries that cover the whole board */
    this.all = [];
    this.bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    this.stamp = 0;
  }

  static range(f) {
    return [
      Math.floor(f.x / CELL),
      Math.floor(f.y / CELL),
      Math.floor((f.x + f.w) / CELL),
      Math.floor((f.y + f.h) / CELL),
    ];
  }

  insert(f) {
    if (f._gi === undefined || this.all[f._gi] !== f) {
      f._gi = this.all.length;
      this.all.push(f);
    }
    this.grow(f);
    const r = Grid.range(f);
    f._cells = r;
    for (let cx = r[0]; cx <= r[2]; cx++) {
      for (let cy = r[1]; cy <= r[3]; cy++) {
        const key = (cx + BIAS) * 65536 + (cy + BIAS);
        let cell = this.cells.get(key);
        if (!cell) this.cells.set(key, (cell = []));
        cell.push(f);
      }
    }
  }

  remove(f) {
    this.unfile(f);
    const i = f._gi;
    if (i !== undefined && this.all[i] === f) {
      const last = this.all.pop();
      if (last !== f) {
        this.all[i] = last;
        last._gi = i;
      }
    }
    f._gi = undefined;
  }

  /** Take a frame out of its cells (but not out of the board). */
  unfile(f) {
    const r = f._cells;
    if (!r) return;
    for (let cx = r[0]; cx <= r[2]; cx++) {
      for (let cy = r[1]; cy <= r[3]; cy++) {
        const key = (cx + BIAS) * 65536 + (cy + BIAS);
        const cell = this.cells.get(key);
        if (!cell) continue;
        const i = cell.indexOf(f);
        if (i !== -1) {
          cell[i] = cell[cell.length - 1];
          cell.pop();
        }
        if (!cell.length) this.cells.delete(key);
      }
    }
    f._cells = null;
  }

  /** Bounds only grow; a stale edge just sends a query down the slower path. */
  grow(f) {
    const b = this.bounds;
    b.x0 = Math.min(b.x0, f.x);
    b.y0 = Math.min(b.y0, f.y);
    b.x1 = Math.max(b.x1, f.x + f.w);
    b.y1 = Math.max(b.y1, f.y + f.h);
  }

  /** Re-file a frame after it moved or resized; free when it stayed in the same cells. */
  update(f) {
    this.grow(f);
    const r = Grid.range(f);
    const old = f._cells;
    if (old && old[0] === r[0] && old[1] === r[1] && old[2] === r[2] && old[3] === r[3]) return;
    this.unfile(f);
    this.insert(f);
  }

  /** Call `fn` once for every frame overlapping the world rectangle. */
  query(x0, y0, x1, y1, fn) {
    const b = this.bounds;
    if (x0 <= b.x0 && y0 <= b.y0 && x1 >= b.x1 && y1 >= b.y1) {
      // The whole board is in view: one flat pass, nothing to de-duplicate.
      const all = this.all;
      for (let i = 0; i < all.length; i++) fn(all[i]);
      return;
    }
    const stamp = ++this.stamp;
    const visit = (cell) => {
      for (let i = 0; i < cell.length; i++) {
        const f = cell[i];
        if (f._seen === stamp) continue;
        f._seen = stamp;
        if (f.x < x1 && f.x + f.w > x0 && f.y < y1 && f.y + f.h > y0) fn(f);
      }
    };
    const cx0 = Math.floor(x0 / CELL);
    const cy0 = Math.floor(y0 / CELL);
    const cx1 = Math.floor(x1 / CELL);
    const cy1 = Math.floor(y1 / CELL);
    if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > this.cells.size) {
      for (const cell of this.cells.values()) visit(cell);
      return;
    }
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const cell = this.cells.get((cx + BIAS) * 65536 + (cy + BIAS));
        if (cell) visit(cell);
      }
    }
  }
}
