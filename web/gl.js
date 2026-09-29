// WebGL2 renderer.
//
// Every frame on the board is one instance of a unit quad: a rectangle in
// world space, a colour to show when it is too small to read, and a slot in a
// texture atlas holding its thumbnail. Panning and zooming change three
// uniforms and nothing else, so drawing costs one call and the same few
// microseconds of CPU for ten frames or a hundred thousand. The GPU does the
// culling. The dot grid is drawn in the same pass by a full-screen shader.

const STRIDE = 12; // floats per instance: rect(4) uv(4) layer(1) tone(1, 4×u8) spare(2)
const BYTES = STRIDE * 4;

const FRAME_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_rect;
layout(location = 2) in vec4 a_uv;
layout(location = 3) in float a_layer;
layout(location = 4) in vec4 a_tone;
uniform vec2 u_res;
uniform vec2 u_originHi; // world point under the screen's top-left corner, split
uniform vec2 u_originLo; // into two floats so far-flung boards stay exact
uniform float u_scale;   // device pixels per world unit
out vec2 v_px;
flat out vec2 v_size;
flat out float v_area;
flat out vec4 v_uv;
flat out float v_layer;
flat out vec4 v_tone;
void main() {
  vec2 size = a_rect.zw * u_scale;
  vec2 topLeft = ((a_rect.xy - u_originHi) - u_originLo) * u_scale;
  // Never smaller than a pixel, so distant frames fade instead of flickering
  // out; v_area carries how much of that pixel the frame really covers.
  vec2 drawn = max(size, vec2(1.0));
  v_area = min(size.x, 1.0) * min(size.y, 1.0);
  // Pad one pixel on each side for analytic edge antialiasing.
  vec2 px = (a_corner * (drawn + 2.0)) - 1.0;
  vec2 pos = topLeft + (size - drawn) * 0.5 + px;
  v_px = px;
  v_size = drawn;
  v_uv = a_uv;
  v_layer = a_layer;
  v_tone = a_tone;
  vec2 clip = pos / u_res * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const FRAME_FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray u_atlas;
in vec2 v_px;
flat in vec2 v_size;
flat in float v_area;
flat in vec4 v_uv;
flat in float v_layer;
flat in vec4 v_tone;
out vec4 o_color;
void main() {
  vec2 edge = clamp(min(v_px + 0.5, v_size - v_px + 0.5), 0.0, 1.0);
  float coverage = edge.x * edge.y * v_area;
  if (coverage <= 0.0) discard;
  vec3 color = v_tone.rgb;
  if (v_layer >= 0.0) {
    vec2 t = clamp(v_px / v_size, 0.0, 1.0);
    vec3 texel = texture(u_atlas, vec3(mix(v_uv.xy, v_uv.zw, t), v_layer)).rgb;
    // A frame a few pixels across would sample its thumbnail sparsely and
    // shimmer while panning; ease into the frame's average colour instead.
    color = mix(color, texel, smoothstep(4.0, 12.0, max(v_size.x, v_size.y)));
  }
  o_color = vec4(color * coverage, coverage);
}`;

const GRID_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Matches the old CSS background: a 1px-radius dot at (1,1) of every tile.
const GRID_FS = `#version 300 es
precision highp float;
uniform vec2 u_res;
uniform float u_spacing;
uniform vec2 u_offset;
uniform float u_dpr;
uniform vec3 u_bg;
uniform vec3 u_dot;
out vec4 o_color;
void main() {
  vec2 p = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);
  vec2 q = mod(p - u_offset, u_spacing);
  float d = length(q - vec2(u_dpr));
  float a = clamp(u_dpr - d + 0.5, 0.0, 1.0);
  o_color = vec4(mix(u_bg, u_dot, a), 1.0);
}`;

export class GLRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ onLost?: () => void, onRestored?: () => void, maxLayers?: number }} opts
   */
  constructor(canvas, { onLost = () => {}, onRestored = () => {}, maxLayers = defaultMaxLayers() } = {}) {
    this.canvas = canvas;
    this.maxLayers = maxLayers;
    this.capacity = 0;
    this.count = 0;
    this.data = new Float32Array(0);
    this.words = new Uint32Array(this.data.buffer);
    this.dirtyLo = Infinity;
    this.dirtyHi = -1;
    this.resized = true;
    this.bg = [0x0b / 255, 0x0c / 255, 0x0e / 255];
    this.dot = [0x19 / 255, 0x1c / 255, 0x21 / 255];

    this.gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    this.ok = Boolean(this.gl);
    if (!this.ok) return;

    canvas.addEventListener('webglcontextlost', (ev) => {
      ev.preventDefault();
      this.lost = true;
      onLost();
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false;
      this.init();
      onRestored();
    });
    this.init();
  }

  init() {
    const { gl } = this;
    this.frameProgram = program(gl, FRAME_VS, FRAME_FS);
    this.gridProgram = program(gl, GRID_VS, GRID_FS);
    this.u = uniforms(gl, this.frameProgram, ['u_res', 'u_originHi', 'u_originLo', 'u_scale', 'u_atlas']);
    this.ug = uniforms(gl, this.gridProgram, ['u_res', 'u_spacing', 'u_offset', 'u_dpr', 'u_bg', 'u_dot']);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const corners = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.instances = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    const attr = (loc, size, type, normalized, offset) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, type, normalized, BYTES, offset);
      gl.vertexAttribDivisor(loc, 1);
    };
    attr(1, 4, gl.FLOAT, false, 0);
    attr(2, 4, gl.FLOAT, false, 16);
    attr(3, 1, gl.FLOAT, false, 32);
    attr(4, 4, gl.UNSIGNED_BYTE, true, 36);
    gl.bindVertexArray(null);

    this.gpuCapacity = 0;
    this.dirtyLo = 0;
    this.dirtyHi = this.count - 1;
    this.atlas = new Atlas(gl, this.maxLayers);
  }

  /** Match the drawing buffer to the canvas's CSS size at the given pixel ratio. */
  resize(cssW, cssH, dpr) {
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.cssW = cssW;
    this.cssH = cssH;
  }

  /**
   * Reserve room for `n` instances. By default everything is re-uploaded
   * (the caller rewrites it all); `preserve` keeps what is there and only
   * uploads what setInstance() touches next.
   */
  setCount(n, { preserve = false } = {}) {
    if (n > this.capacity) {
      const capacity = Math.max(64, 1 << Math.ceil(Math.log2(n)));
      const next = new Float32Array(capacity * STRIDE);
      next.set(this.data.subarray(0, this.count * STRIDE));
      this.data = next;
      this.words = new Uint32Array(next.buffer);
      this.capacity = capacity;
    }
    this.count = n;
    if (!preserve) {
      this.dirtyLo = 0;
      this.dirtyHi = n - 1;
    }
  }

  /**
   * Write one instance. `slot` is an atlas slot or null; `tone` is 0xAABBGGRR.
   */
  setInstance(i, x, y, w, h, tone, slot) {
    const o = i * STRIDE;
    const d = this.data;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = w;
    d[o + 3] = h;
    if (slot) {
      d[o + 4] = slot.u0;
      d[o + 5] = slot.v0;
      d[o + 6] = slot.u1;
      d[o + 7] = slot.v1;
      d[o + 8] = slot.layer;
    } else {
      d[o + 8] = -1;
    }
    this.words[o + 9] = tone;
    if (i < this.dirtyLo) this.dirtyLo = i;
    if (i > this.dirtyHi) this.dirtyHi = i;
  }

  flush() {
    const { gl } = this;
    if (this.dirtyHi < this.dirtyLo) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    if (this.gpuCapacity < this.capacity) {
      gl.bufferData(gl.ARRAY_BUFFER, this.data, gl.DYNAMIC_DRAW);
      this.gpuCapacity = this.capacity;
    } else {
      const lo = this.dirtyLo * STRIDE;
      const hi = (this.dirtyHi + 1) * STRIDE;
      gl.bufferSubData(gl.ARRAY_BUFFER, lo * 4, this.data, lo, hi - lo);
    }
    this.dirtyLo = Infinity;
    this.dirtyHi = -1;
  }

  /** @param {{x: number, y: number, scale: number}} view CSS-pixel pan and zoom */
  draw(view, dpr) {
    if (!this.ok || this.lost) return;
    const { gl } = this;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const k = W / this.cssW; // effective device pixel ratio after rounding
    gl.viewport(0, 0, W, H);

    // Dot grid: keep spacing in a readable band by stepping in powers of four.
    let spacing = 32 * view.scale;
    while (spacing < 18) spacing *= 4;
    while (spacing > 90) spacing /= 4;
    gl.disable(gl.BLEND);
    gl.useProgram(this.gridProgram);
    gl.uniform2f(this.ug.u_res, W, H);
    gl.uniform1f(this.ug.u_spacing, spacing * k);
    gl.uniform2f(this.ug.u_offset, mod(view.x, spacing) * k, mod(view.y, spacing) * k);
    gl.uniform1f(this.ug.u_dpr, dpr);
    gl.uniform3fv(this.ug.u_bg, this.bg);
    gl.uniform3fv(this.ug.u_dot, this.dot);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (!this.count) return;
    this.flush();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.frameProgram);
    const ox = -view.x / view.scale;
    const oy = -view.y / view.scale;
    const hx = Math.fround(ox);
    const hy = Math.fround(oy);
    gl.uniform2f(this.u.u_res, W, H);
    gl.uniform2f(this.u.u_originHi, hx, hy);
    gl.uniform2f(this.u.u_originLo, ox - hx, oy - hy);
    gl.uniform1f(this.u.u_scale, view.scale * k);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlas.texture);
    gl.uniform1i(this.u.u_atlas, 0);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    gl.bindVertexArray(null);
  }
}

const mod = (n, m) => ((n % m) + m) % m;

function defaultMaxLayers() {
  // 16 MB per layer, so 128 MB at most; less where the device reports little
  // memory. Past the budget, off-screen frames give their textures back.
  const mem = navigator.deviceMemory || 8;
  return mem <= 2 ? 2 : mem <= 4 ? 4 : 8;
}

// ------------------------------------------------------------------- atlas --

const PAGE = 2048;
const MIN_BLOCK = 32;
const LEVELS = Math.log2(PAGE / MIN_BLOCK) + 1; // 2048 … 32

/**
 * Thumbnails live in a 2D texture array of 2048² pages, carved up by a buddy
 * allocator into square power-of-two blocks. One texture means one draw call
 * for the whole board, whatever mix of resolutions is resident. Pages are
 * added on demand up to a memory budget; past that, the caller evicts.
 */
export class Atlas {
  constructor(gl, maxLayers) {
    this.gl = gl;
    this.maxLayers = Math.min(maxLayers, gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS));
    this.layers = 0;
    this.used = 0; // bytes held by live slots
    /** free block keys per level; key = layer * PAGE² + y * PAGE + x */
    this.free = Array.from({ length: LEVELS }, () => new Set());
    this.texture = null;
    this.grow();
  }

  /** Bytes allocated on the GPU now. */
  get bytes() {
    return this.layers * PAGE * PAGE * 4;
  }

  /** Bytes it may grow to. */
  get budget() {
    return this.maxLayers * PAGE * PAGE * 4;
  }

  /** Allocate a block for a w×h image; null when the budget is exhausted. */
  alloc(w, h) {
    let size = MIN_BLOCK;
    while (size < Math.max(w, h) && size < PAGE) size *= 2;
    const level = Math.log2(PAGE / size);
    const key = this.take(level);
    if (key === null) return null;
    const layer = Math.floor(key / (PAGE * PAGE));
    const rest = key % (PAGE * PAGE);
    const x = rest % PAGE;
    const y = Math.floor(rest / PAGE);
    this.used += size * size * 4;
    const cw = Math.min(w, size);
    const ch = Math.min(h, size);
    return {
      key,
      level,
      size,
      layer,
      x,
      y,
      w: cw,
      h: ch,
      // Half-texel inset: bilinear filtering never reaches a neighbour.
      u0: (x + 0.5) / PAGE,
      v0: (y + 0.5) / PAGE,
      u1: (x + cw - 0.5) / PAGE,
      v1: (y + ch - 0.5) / PAGE,
    };
  }

  release(slot) {
    this.used -= slot.size * slot.size * 4;
    this.give(slot.key, slot.level);
  }

  /** Copy an image (ImageBitmap, or raw RGBA as {width, height, data}) into a slot. */
  upload(slot, source) {
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (source.data) {
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, slot.x, slot.y, slot.layer, slot.w, slot.h, 1, gl.RGBA, gl.UNSIGNED_BYTE, source.data);
    } else {
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, slot.x, slot.y, slot.layer, slot.w, slot.h, 1, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }
  }

  take(level) {
    const set = this.free[level];
    for (const key of set) {
      set.delete(key);
      return key;
    }
    if (level === 0) return this.grow() ? this.take(0) : null;
    const parent = this.take(level - 1);
    if (parent === null) return null;
    const half = PAGE >> level;
    set.add(parent + half);
    set.add(parent + half * PAGE);
    set.add(parent + half * PAGE + half);
    return parent;
  }

  give(key, level) {
    if (level === 0) {
      this.free[0].add(key);
      return;
    }
    const size = PAGE >> level;
    const layerBase = Math.floor(key / (PAGE * PAGE)) * PAGE * PAGE;
    const rest = key - layerBase;
    const x = rest % PAGE;
    const y = (rest - x) / PAGE;
    const px = x & ~(size * 2 - 1);
    const py = y & ~(size * 2 - 1);
    const base = layerBase + py * PAGE + px;
    const buddies = [base, base + size, base + size * PAGE, base + size * PAGE + size];
    const set = this.free[level];
    if (buddies.every((b) => b === key || set.has(b))) {
      for (const b of buddies) set.delete(b);
      this.give(base, level - 1);
    } else {
      set.add(key);
    }
  }

  /** Add pages (doubling), copying existing ones across on the GPU. */
  grow() {
    const { gl } = this;
    const next = this.layers ? Math.min(this.maxLayers, this.layers * 2) : 1;
    if (next <= this.layers) return false;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, PAGE, PAGE, next);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (this.texture) {
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
      for (let layer = 0; layer < this.layers; layer++) {
        gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.texture, 0, layer);
        gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, 0, 0, PAGE, PAGE);
      }
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);
      gl.deleteTexture(this.texture);
    }
    for (let layer = this.layers; layer < next; layer++) this.free[0].add(layer * PAGE * PAGE);
    this.texture = texture;
    this.layers = next;
    return true;
  }
}

// ----------------------------------------------------------------- helpers --

function program(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      throw new Error(gl.getShaderInfoLog(s));
    }
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

function uniforms(gl, p, names) {
  return Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(p, n)]));
}
