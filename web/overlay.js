// Overlay.
//
// A 2D canvas above the live iframes for everything that isn't a frame's
// content: names, the selection outline and its handles, the "interactive"
// badge, and the flash when an update lands. Labels are only drawn for frames
// wide enough to fit one, so the work tracks what is legible on screen, not
// how many frames exist.

const FONT = 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';
const NAME_FONT = `550 13px ${FONT}`;
const SMALL_FONT = `11px ${FONT}`;
const META_FONT = `11px ${MONO}`;
const BADGE_FONT = `600 10px ${FONT}`;

const COLORS = {
  text: '#e9ebee',
  muted: '#878d96',
  faint: '#5d636c',
  accent: '#8b7cff',
  live: '#3ddc97',
  panel: '#14161a',
};

/** Labels start appearing once a frame is this wide on screen (CSS px). */
const LABEL_MIN_WIDTH = 40;
const FLASH_MS = 500;
export const HANDLE = 11;

export class Overlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = 1;
    /** [id, x, y, w, h] name rects from the last draw, for hit testing */
    this.labels = [];
    this.widths = new Map(); // `${font}|${text}` → width
  }

  resize(cssW, cssH, dpr) {
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = w / cssW;
  }

  measure(font, text) {
    const key = `${font}|${text}`;
    let w = this.widths.get(key);
    if (w === undefined) {
      this.ctx.font = font;
      w = this.ctx.measureText(text).width;
      if (this.widths.size > 20000) this.widths.clear();
      this.widths.set(key, w);
    }
    return w;
  }

  /**
   * @param {object} p
   * @param {(x0: number, y0: number, x1: number, y1: number, fn: (f: any) => void) => void} p.query
   *        frames overlapping a world rect
   * @param {(id: string) => any} p.byId
   * @param {number} p.maxW       widest frame, to skip the label pass when none can fit one
   * @returns {boolean} true while an animation (a flash) needs more frames
   */
  draw({ query, byId, maxW, view, selected, hover, interactive, readonly, flashes, now }) {
    const { ctx } = this;
    const W = this.cssW;
    const H = this.cssH;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    this.labels = [];

    const s = view.scale;
    const screen = (f) => [f.x * s + view.x, f.y * s + view.y, f.w * s, f.h * s];

    // --- labels -------------------------------------------------------------
    // Frames too narrow for a label are skipped before anything is measured,
    // and whole labels off screen are culled by their strip above the frame.
    if (maxW * s >= LABEL_MIN_WIDTH) {
      const minWorldW = LABEL_MIN_WIDTH / s;
      ctx.textBaseline = 'alphabetic';
      ctx.font = NAME_FONT;
      const rest = [];
      // Names sit above their frame and may run past its right edge, so look
      // a little beyond the screen on those sides.
      query(-view.x / s - 400 / s, -view.y / s, (W - view.x) / s, (H + 24 - view.y) / s, (f) => {
        if (f.w < minWorldW) return;
        const sx = Math.round(f.x * s + view.x);
        const sy = Math.round(f.y * s + view.y);
        if (sy < 0 || sx + Math.max(f.w * s, 400) < 0) return;
        const sw = f.w * s;
        const isSel = f.id === selected;
        const isHover = f.id === hover;
        const nameW = this.measure(NAME_FONT, f.name);
        const room = isSel || isHover ? Infinity : sw;
        ctx.fillStyle = isSel ? COLORS.accent : isHover ? COLORS.text : COLORS.muted;
        const baseline = sy - 11;
        if (nameW > room) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(sx, baseline - 14, room, 20);
          ctx.clip();
          ctx.fillText(f.name, sx, baseline);
          ctx.restore();
        } else {
          ctx.fillText(f.name, sx, baseline);
        }
        const shown = Math.min(nameW, room);
        this.labels.push([f.id, sx, baseline - 13, shown, 19]);
        if ((isSel || isHover || f.note) && nameW <= room) rest.push([f, sx + nameW + 8, baseline, sw - nameW - 8, isSel || isHover]);
      });
      // Size readout and note, batched by font to spare the state changes.
      ctx.font = META_FONT;
      ctx.fillStyle = COLORS.faint;
      for (const item of rest) {
        const [f, x, y, , active] = item;
        if (!active) continue;
        const meta = `${Math.round(f.w)} × ${Math.round(f.h)}`;
        ctx.fillText(meta, x, y);
        item[1] = x + this.measure(META_FONT, meta) + 8;
      }
      ctx.font = SMALL_FONT;
      for (const [f, x, y, room, active] of rest) {
        if (!f.note) continue;
        const max = active ? 340 : Math.min(340, room);
        if (max < 24) continue;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y - 12, max, 18);
        ctx.clip();
        ctx.fillText(f.note, x, y);
        ctx.restore();
      }
    }

    // --- update flashes -----------------------------------------------------
    let animating = false;
    for (const [id, start] of flashes) {
      const t = (now - start) / FLASH_MS;
      const f = byId(id);
      if (t >= 1 || !f) {
        flashes.delete(id);
        continue;
      }
      animating = true;
      const [x, y, w, h] = screen(f);
      ctx.globalAlpha = 0.22 * (1 - t) * (1 - t);
      ctx.fillStyle = COLORS.accent;
      ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 1;
    }

    // --- selection & interactive -----------------------------------------------
    const outline = (f, color) => {
      const [x, y, w, h] = screen(f);
      const lw = Math.min(2.5, 1 + s);
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.strokeRect(x - lw / 2, y - lw / 2, w + lw, h + lw);
      return [x, y, w, h];
    };

    const sel = selected && byId(selected);
    const live = interactive && byId(interactive);
    if (sel && sel !== live) {
      const [x, y, w, h] = outline(sel, COLORS.accent);
      if (!readonly) {
        ctx.fillStyle = COLORS.panel;
        ctx.strokeStyle = COLORS.accent;
        ctx.lineWidth = 1.5;
        for (const [hx, hy] of [
          [x, y],
          [x + w, y],
          [x, y + h],
          [x + w, y + h],
        ]) {
          ctx.beginPath();
          ctx.roundRect(hx - HANDLE / 2, hy - HANDLE / 2, HANDLE, HANDLE, 2);
          ctx.fill();
          ctx.stroke();
        }
      }
    }
    if (live) {
      const [x, y, w] = outline(live, COLORS.live);
      const text = 'INTERACTIVE · ESC TO EXIT';
      ctx.font = BADGE_FONT;
      ctx.letterSpacing = '0.8px';
      const tw = ctx.measureText(text).width;
      const bw = tw + 14;
      const bx = Math.round(x + w - bw);
      const by = Math.round(y - 8 - 18);
      ctx.fillStyle = 'rgba(61, 220, 151, 0.12)';
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, 18, 5);
      ctx.fill();
      ctx.fillStyle = COLORS.live;
      ctx.fillText(text, bx + 7, by + 13);
      ctx.letterSpacing = '0px';
    }

    return animating;
  }

  /** The frame whose name is under a screen point, if any. */
  labelAt(x, y) {
    for (let i = this.labels.length - 1; i >= 0; i--) {
      const [id, lx, ly, lw, lh] = this.labels[i];
      if (x >= lx && x <= lx + lw && y >= ly && y <= ly + lh) return id;
    }
    return null;
  }
}
