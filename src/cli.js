// The agent-facing surface. Every command mutates the on-disk store directly,
// so it works identically whether or not the canvas server happens to be
// running — a running server just picks the change up and pushes it live.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  Store,
  newId,
  nextFreeSlot,
  wrapHtml,
  readStdin,
  homeShorten,
  DEFAULT_FRAME_SIZE,
} from './store.js';
import { listen } from './server.js';
import { HELP, COMMAND_HELP } from './help.js';

const PRESETS = {
  desktop: { w: 1440, h: 900 },
  laptop: { w: 1280, h: 800 },
  tablet: { w: 834, h: 1112 },
  mobile: { w: 390, h: 844 },
  phone: { w: 390, h: 844 },
  square: { w: 1000, h: 1000 },
  wide: { w: 1920, h: 1080 },
  card: { w: 480, h: 320 },
};

export async function run(argv) {
  const { command, args, flags } = parseArgs(argv);

  // `-h`/`-v` only mean help/version when they carry no value — `--h 300` is a height.
  if (flags.help === true || flags.h === true || command === 'help') {
    const topic = command === 'help' ? args[0] : command;
    process.stdout.write(topic && COMMAND_HELP[topic] ? COMMAND_HELP[topic] : HELP);
    return 0;
  }
  if (flags.version === true || flags.v === true) {
    process.stdout.write('paper 0.1.0\n');
    return 0;
  }
  if (!command) {
    process.stdout.write(HELP);
    return 0;
  }

  const store = new Store(flags.dir);
  const handler = COMMANDS[command];
  if (!handler) {
    fail(`Unknown command "${command}". Run \`paper help\` for the list.`);
    return 1;
  }
  if (command !== 'init' && command !== 'serve' && !store.exists()) {
    store.init(); // first write bootstraps the canvas; no ceremony required
  }

  try {
    const code = await handler({ store, args, flags });
    return code || 0;
  } catch (err) {
    fail(err.message || String(err));
    return 1;
  }
}

const COMMANDS = {
  // ---------------------------------------------------------------- init ---
  async init({ store, flags }) {
    const root = store.init();
    if (truthy(flags.json)) return json({ root });
    ok(`Canvas ready at ${dim(homeShorten(root))}`);
    info(`Start the viewer with ${cyan('paper serve')}`);
    return 0;
  },

  // --------------------------------------------------------------- serve ---
  async serve({ store, flags }) {
    const port = Number(flags.port || flags.p || 4321);
    const { url } = await listen({ root: store.root, port });
    const frames = store.read().frames.length;

    process.stdout.write(
      `\n  ${bold('paper canvas')}  ${dim('·')}  ${cyan(url)}\n` +
        `  ${dim(`${frames} frame${frames === 1 ? '' : 's'} · ${homeShorten(store.root)}`)}\n\n` +
        `  ${dim('Add a design:')} ${cyan('paper add hero --file hero.html')}\n` +
        `  ${dim('Ctrl-C to stop')}\n\n`
    );

    if (!truthy(flags["no-open"]) && flags.open !== false) openBrowser(url);
    await new Promise(() => {}); // run until interrupted
    return 0;
  },

  // ----------------------------------------------------------------- add ---
  async add({ store, args, flags }) {
    const name = args[0] || `frame-${store.read().frames.length + 1}`;
    const content = readContentSource(flags);
    const size = resolveSize(flags);
    const state = store.read();

    if (!truthy(flags.force) && state.frames.some((f) => f.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(
        `A frame named "${name}" already exists. Use \`paper set ${name} ...\` to replace its contents, or pass --force to add a duplicate.`
      );
    }

    const slot =
      flags.x !== undefined || flags.y !== undefined
        ? { x: Number(flags.x || 0), y: Number(flags.y || 0) }
        : nextFreeSlot(state.frames, size.w, size.h);

    const frame = {
      id: newId(),
      name,
      x: Math.round(slot.x),
      y: Math.round(slot.y),
      w: size.w,
      h: size.h,
      background: flags.background || flags.bg || '#ffffff',
      note: flags.note || '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // No content yet? Leave the file unwritten so the viewer shows its
    // "empty frame" placeholder instead of a blank white rectangle.
    if (content.trim()) {
      store.writeContent(
        frame.id,
        truthy(flags.raw) ? content : wrapHtml(content, { background: frame.background, title: name })
      );
    }
    store.update((s) => {
      s.frames.push(frame);
    });

    if (truthy(flags.json)) return json(frame);
    ok(`Added ${bold(name)} ${dim(`(${frame.id}) ${frame.w}×${frame.h} at ${frame.x},${frame.y}`)}`);
    hintServer(store);
    return 0;
  },

  // ----------------------------------------------------------------- set ---
  async set({ store, args, flags }) {
    const state = store.read();
    const frame = store.resolve(state, args[0]);
    const content = readContentSource(flags);
    if (!content) throw new Error('Nothing to write. Pass --file, --html, or pipe HTML on stdin.');

    if (flags.background || flags.bg) frame.background = flags.background || flags.bg;
    store.writeContent(
      frame.id,
      truthy(flags.raw) ? content : wrapHtml(content, { background: frame.background, title: frame.name })
    );
    store.update((s) => {
      const target = s.frames.find((f) => f.id === frame.id);
      if (target) {
        target.background = frame.background;
        target.updatedAt = new Date().toISOString();
      }
    });

    if (truthy(flags.json)) return json({ ...frame, bytes: content.length });
    ok(`Updated ${bold(frame.name)} ${dim(`(${frame.id}, ${content.length} bytes)`)}`);
    return 0;
  },

  // ---------------------------------------------------------------- move ---
  async move({ store, args, flags }) {
    const state = store.read();
    const frame = store.resolve(state, args[0]);
    const dx = flags.by !== undefined || flags.dx !== undefined || flags.dy !== undefined;

    store.update((s) => {
      const target = s.frames.find((f) => f.id === frame.id);
      if (dx) {
        target.x += Number(flags.dx || 0);
        target.y += Number(flags.dy || 0);
      } else {
        if (flags.x !== undefined) target.x = Math.round(Number(flags.x));
        if (flags.y !== undefined) target.y = Math.round(Number(flags.y));
      }
      target.updatedAt = new Date().toISOString();
      Object.assign(frame, target);
    });

    if (truthy(flags.json)) return json(frame);
    ok(`Moved ${bold(frame.name)} to ${dim(`${frame.x},${frame.y}`)}`);
    return 0;
  },

  // -------------------------------------------------------------- resize ---
  async resize({ store, args, flags }) {
    const state = store.read();
    const frame = store.resolve(state, args[0]);
    const size = resolveSize(flags, { w: frame.w, h: frame.h });

    store.update((s) => {
      const target = s.frames.find((f) => f.id === frame.id);
      target.w = size.w;
      target.h = size.h;
      target.updatedAt = new Date().toISOString();
      Object.assign(frame, target);
    });

    if (truthy(flags.json)) return json(frame);
    ok(`Resized ${bold(frame.name)} to ${dim(`${frame.w}×${frame.h}`)}`);
    return 0;
  },

  // -------------------------------------------------------------- rename ---
  async rename({ store, args, flags }) {
    const state = store.read();
    const frame = store.resolve(state, args[0]);
    const next = args[1];
    if (!next) throw new Error('Usage: paper rename <frame> <new-name>');

    store.update((s) => {
      const target = s.frames.find((f) => f.id === frame.id);
      target.name = next;
      target.updatedAt = new Date().toISOString();
    });

    if (truthy(flags.json)) return json({ ...frame, name: next });
    ok(`Renamed ${dim(frame.name)} → ${bold(next)}`);
    return 0;
  },

  // ------------------------------------------------------------------ rm ---
  async rm({ store, args, flags }) {
    const state = store.read();

    if (truthy(flags.all)) {
      const count = state.frames.length;
      for (const f of state.frames) store.removeContent(f.id);
      store.update((s) => {
        s.frames = [];
      });
      if (truthy(flags.json)) return json({ removed: count });
      ok(`Cleared ${count} frame${count === 1 ? '' : 's'}`);
      return 0;
    }

    if (!args.length) throw new Error('Usage: paper rm <frame...>   (or --all)');
    const targets = args.map((ref) => store.resolve(state, ref));
    store.update((s) => {
      s.frames = s.frames.filter((f) => !targets.some((t) => t.id === f.id));
    });
    for (const t of targets) store.removeContent(t.id);

    if (truthy(flags.json)) return json({ removed: targets.map((t) => t.id) });
    ok(`Removed ${targets.map((t) => bold(t.name)).join(', ')}`);
    return 0;
  },

  // ------------------------------------------------------------------ ls ---
  async ls({ store, flags }) {
    const state = store.read();
    if (truthy(flags.json)) return json(state.frames);
    if (!state.frames.length) {
      info('Canvas is empty. Add one with ' + cyan('paper add hero --file hero.html'));
      return 0;
    }

    const rows = state.frames.map((f) => [
      f.id,
      f.name,
      `${f.w}×${f.h}`,
      `${f.x},${f.y}`,
      `${(store.readContent(f.id).length / 1024).toFixed(1)}kb`,
    ]);
    const widths = ['ID', 'NAME', 'SIZE', 'POSITION', 'CONTENT'].map((h, i) =>
      Math.max(h.length, ...rows.map((r) => r[i].length))
    );
    const line = (cells, fmt = (s) => s) =>
      '  ' + cells.map((c, i) => fmt(c.padEnd(widths[i]))).join('   ');

    process.stdout.write('\n' + line(['ID', 'NAME', 'SIZE', 'POSITION', 'CONTENT'], dim) + '\n');
    for (const r of rows) process.stdout.write(line(r) + '\n');
    process.stdout.write('\n');
    return 0;
  },

  // ----------------------------------------------------------------- cat ---
  async cat({ store, args }) {
    const state = store.read();
    const frame = store.resolve(state, args[0]);
    process.stdout.write(store.readContent(frame.id));
    return 0;
  },

  // ------------------------------------------------------------- arrange ---
  async arrange({ store, flags }) {
    const cols = Number(flags.cols || flags.c || 3);
    const gap = Number(flags.gap || flags.g || 120);
    const state = store.read();
    if (!state.frames.length) {
      info('Nothing to arrange.');
      return 0;
    }

    // Column widths and row heights are driven by the largest frame in each,
    // so mixed-size frames still line up on a readable grid.
    const colWidths = [];
    const rowHeights = [];
    state.frames.forEach((f, i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      colWidths[c] = Math.max(colWidths[c] || 0, f.w);
      rowHeights[r] = Math.max(rowHeights[r] || 0, f.h);
    });
    const colX = colWidths.reduce((acc, w, i) => {
      acc.push(i === 0 ? 0 : acc[i - 1] + colWidths[i - 1] + gap);
      return acc;
    }, []);
    const rowY = rowHeights.reduce((acc, h, i) => {
      acc.push(i === 0 ? 0 : acc[i - 1] + rowHeights[i - 1] + gap);
      return acc;
    }, []);

    store.update((s) => {
      s.frames.forEach((f, i) => {
        f.x = colX[i % cols];
        f.y = rowY[Math.floor(i / cols)];
      });
    });

    if (truthy(flags.json)) return json(store.read().frames);
    ok(`Arranged ${state.frames.length} frames into ${cols} column${cols === 1 ? '' : 's'}`);
    return 0;
  },

  // -------------------------------------------------------------- status ---
  async status({ store, flags }) {
    const state = store.read();
    const lock = store.readLock();
    const running = lock && isAlive(lock.pid);
    const payload = {
      root: store.root,
      frames: state.frames.length,
      rev: state.rev,
      server: running ? `http://${lock.host}:${lock.port}` : null,
    };
    if (truthy(flags.json)) return json(payload);

    process.stdout.write(
      `\n  ${bold('canvas')}  ${dim(homeShorten(store.root))}\n` +
        `  ${bold('frames')}  ${state.frames.length}\n` +
        `  ${bold('server')}  ${running ? cyan(payload.server) : dim('not running — `paper serve`')}\n\n`
    );
    return 0;
  },

  // ---------------------------------------------------------------- open ---
  async open({ store, args, flags }) {
    const lock = store.readLock();
    if (!lock || !isAlive(lock.pid)) throw new Error('Canvas server is not running. Start it with `paper serve`.');
    let url = `http://${lock.host}:${lock.port}`;
    if (args[0]) {
      const frame = store.resolve(store.read(), args[0]);
      url += `#${frame.id}`;
    }
    if (truthy(flags.print)) {
      process.stdout.write(url + '\n');
      return 0;
    }
    openBrowser(url);
    ok(`Opened ${cyan(url)}`);
    return 0;
  },
};

// --------------------------------------------------------------- helpers ---

/**
 * Boolean flags may arrive as `--raw`, `--raw=true`, `--raw=false`, or `--no-raw`.
 * Coercing at the read site keeps string flags like `--name false` intact.
 */
function truthy(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  return !['false', '0', 'no', 'off', ''].includes(String(value).toLowerCase());
}

function readContentSource(flags) {
  if (flags.file || flags.f) {
    const file = path.resolve(String(flags.file || flags.f));
    if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
    return fs.readFileSync(file, 'utf8');
  }
  if (flags.html) return String(flags.html);
  return readStdin();
}

function resolveSize(flags, fallback = DEFAULT_FRAME_SIZE) {
  const preset = flags.preset || flags.size;
  let base = { ...fallback };
  if (preset) {
    const found = PRESETS[String(preset).toLowerCase()];
    if (!found) {
      throw new Error(`Unknown preset "${preset}". Try: ${Object.keys(PRESETS).join(', ')}`);
    }
    base = { ...found };
  }
  if (flags.w !== undefined || flags.width !== undefined) base.w = Number(flags.w ?? flags.width);
  if (flags.h !== undefined || flags.height !== undefined) base.h = Number(flags.h ?? flags.height);
  return { w: Math.max(80, Math.round(base.w)), h: Math.max(80, Math.round(base.h)) };
}

/**
 * Flags accept `--key value`, `--key=value`, and bare `--key` (true).
 * `--no-key` sets false. Everything else is a positional argument.
 */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = [];
  const flags = {};

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === '--') {
      args.push(...rest.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (body.startsWith('no-')) {
        flags[body.slice(3)] = false;
        flags[body] = true;
      } else {
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[body] = next;
          i++;
        } else {
          flags[body] = true;
        }
      }
    } else if (token.startsWith('-') && token.length > 1) {
      const body = token.slice(1);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
    } else {
      args.push(token);
    }
  }

  return { command: command && !command.startsWith('-') ? command : undefined, args, flags };
}

function openBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
  } catch {
    /* headless is fine */
  }
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function hintServer(store) {
  const lock = store.readLock();
  if (!lock || !isAlive(lock.pid)) {
    info(`Canvas viewer isn't running — start it with ${cyan('paper serve')}`);
  }
}

function json(payload) {
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  return 0;
}

// Colour helpers degrade to plain text when output isn't a TTY (or NO_COLOR).
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = wrap('2');
const bold = wrap('1');
const cyan = wrap('36');
const green = wrap('32');
const red = wrap('31');

function ok(msg) {
  process.stdout.write(`${green('✓')} ${msg}\n`);
}
function info(msg) {
  process.stdout.write(`${dim('·')} ${msg}\n`);
}
function fail(msg) {
  process.stderr.write(`${red('✗')} ${msg}\n`);
}
