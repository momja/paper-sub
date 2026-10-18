# paper

An infinite canvas scratchpad for HTML/CSS designs — driven entirely from the command line.

Agents write markup and push it onto a canvas with `paper add` / `paper set`. You pan, zoom, and
rearrange the result in the browser. There is no in-app editing: the CLI is the only way content
changes, so an agent and a human can work on the same canvas without stepping on each other.

![paper demo: CLI commands add frames to the canvas live, a frame is dragged into place, and `paper set` updates the hero in place](docs/demo.gif)

```
paper serve                                    # open the canvas
paper add hero --file hero.html --preset desktop
paper set hero --file hero-v2.html             # iterate; the frame reloads instantly
paper arrange --cols 3
```

## Install

Node 18+, no dependencies.

```bash
npm link          # puts `paper` on your PATH
# or skip it and use `node bin/paper.js …` everywhere
```

### Remote servers

The viewer binds to `127.0.0.1` by default. Set `PAPER_HOST` to the server's Tailscale IP
or pass `paper serve --host <ip>` to reach it directly over your tailnet. `--host` overrides
`PAPER_HOST`. Bind to the Tailscale IP rather than `0.0.0.0` to avoid listening on public interfaces.
The viewer has no authentication; only use it on a trusted network.

For a server-wide default, configure the server's `paper` launcher to export `PAPER_HOST` before
running the CLI. Agents can then use their normal `paper serve --no-open` command without knowing
about the network configuration. Use `PAPER_CHROME=off` if the server cannot run Chromium's sandbox.

## How it works

The canvas lives on disk in `.paper-canvas/` in whatever directory you run from:

```
.paper-canvas/
  canvas.json          frame metadata (position, size, name)
  frames/<id>.html     the markup for one frame
  viewport.json        the viewer's saved pan and zoom
  thumbs/              rendered thumbnails (a cache; safe to delete)
  server.json          host/port of the running viewer
```

The CLI only ever edits those files. The server watches the directory and pushes changes to open
browser tabs over Server-Sent Events. That means:

- CLI commands work whether or not the viewer is running.
- Any number of terminals can drive the same canvas.
- Moving a frame in the browser writes straight back to `canvas.json`, so `paper ls` sees it.

## Commands

| Command | What it does |
| --- | --- |
| `paper serve` | Start the viewer (`--port`, `--host`, `--no-open`) |
| `paper add <name>` | Add a frame from `--file`, `--html`, or stdin |
| `paper set <frame>` | Replace a frame's contents in place |
| `paper ls` | List frames (`--json` for machine output) |
| `paper cat <frame>` | Print a frame's HTML |
| `paper move <frame>` | `--x --y` absolute, or `--dx --dy` relative |
| `paper resize <frame>` | `--w --h`, or `--preset` |
| `paper rename <frame> <name>` | Rename |
| `paper rm <frame...>` | Delete (`--all` clears the canvas) |
| `paper arrange` | Lay everything out on a grid (`--cols`, `--gap`) |
| `paper status` | Canvas path, frame count, server URL |
| `paper open [frame]` | Open the viewer, optionally focused on a frame |
| `paper export` | Save the canvas as one view-only HTML file (`--out`, `--title`) |

`<frame>` is an id (`f_9c2a1b04`), an id prefix (`f_9c2`), or a name (`hero`).

Run `paper help <command>` for per-command detail.

### Content

Content comes from `--file`, `--html`, or piped stdin:

```bash
paper add hero --file hero.html
paper add badge --html '<h1>Ship it</h1>' --w 400 --h 200
cat card.html | paper add pricing-card --preset card
```

A bare fragment is wrapped in a minimal document — charset, viewport, box-sizing reset, background,
and `height: 100%` on `html`/`body` so `height: 100%` inside your design does what you expect. Pass a
full document (anything starting with `<!doctype` or `<html`) and it is used verbatim. `--raw` skips
wrapping entirely.

### Size presets

`desktop` 1440×900 · `laptop` 1280×800 · `tablet` 834×1112 · `mobile` 390×844 · `square` 1000×1000 ·
`wide` 1920×1080 · `card` 480×320

## Canvas controls

| | |
| --- | --- |
| scroll / two-finger drag | Pan |
| ⌘-scroll or pinch | Zoom |
| space + drag | Pan from anywhere |
| drag a frame | Move it (drag the title works too) |
| drag an edge or corner | Resize — shift keeps the aspect ratio |
| double-click a frame | Interact with the design inside; esc to leave |
| `F` / `0` / `1` | Fit all · reset to 100% · zoom to selection |
| `R` | Reload the selected frame |
| `⌫` | Delete the selected frame |
| `P` | Rendering stats: fps, CPU per frame, textures, live iframes |
| `?` | Shortcut list |

Frames are inert by default — a click drags rather than hitting links inside — so you can rearrange a
board of live pages without triggering them. Double-click to step into one.

## Sharing a canvas

`paper export` writes the whole board to a single HTML file that needs no server:

```bash
paper export                          # → <project>.html in the current directory
paper export --out public/board.html --title "Q3 explorations"
paper export --out - | pbcopy         # straight to the clipboard
```

The viewer's **Copy HTML** and **Download** buttons produce the same file.

The copy is view-only. People can pan, zoom, and double-click into a design to scroll or click
around, but they can't move, resize, or delete frames. Everything is inlined: the viewer's CSS and
JS, and every frame's markup, which loads into sandboxed `srcdoc` iframes. Open it from disk or
upload it to any static host (GitHub Pages, S3, Netlify, a gist preview). It makes no network
requests of its own; a design that links a web font or remote image still fetches that.

The file carries thumbnails too, so a large board opens zoomed out without rendering anything: the
32px one for every frame, and a 512px one on boards of up to 2,000 frames. `paper export` renders
missing ones first (`--no-thumbs` skips that); the viewer's buttons use whatever is cached.

## How it stays fast

A board of 100,000 frames pans and zooms at 60 fps. The viewer builds no DOM per frame:

- WebGL draws every frame as one instanced quad sampling a texture atlas, in a single draw call.
  Panning and zooming update three numbers, so the CPU cost of a frame doesn't grow with the board.
- Thumbnails are real screenshots. `paper serve` drives a headless Chromium over the DevTools pipe
  (no npm dependencies), captures each frame at the resolution the viewer asks for, and caches it in
  `.paper-canvas/thumbs/`. A frame's resolution follows its size on screen, from 32px zoomed far out
  up to 2048px. The atlas stays under a fixed GPU memory budget by giving back textures of frames
  you can't see. The tiny thumbnails travel in bulk as raw pixels, so the browser decodes nothing.
- Real iframes exist only for the frames you're zoomed in on (50% and up, twelve at most) and the one
  you double-click into. An updated frame loads into a second iframe that swaps in once painted.
- A spatial grid keeps planning, labels and hit testing proportional to what's on screen.
- The server keeps the board in memory and sends tabs only the frames that changed. The full state
  always comes over plain HTTP: Chromium's EventSource parser needs 25 seconds for one 2.4 MB message
  that `fetch` handles in 30 ms.

Measured on an M1 Mac in headless Chromium 149 (Metal backend), panning and zooming continuously for
three seconds at each of four or five zoom levels, from fully zoomed out to 85%:

| Board | First paint | Frame rate | Render CPU per frame |
| --- | --- | --- | --- |
| 10,000 frames | 0.3 s | 60 fps, no dropped frames | under 1 ms on average, 4 ms worst |
| 100,000 frames | 0.8 s | 60 fps, no dropped frames | about 1 ms on average, 3.5 ms worst |

The 100k run was taken while the server was still rendering that board's thumbnails. Warm-up gets at
most half of its capture tabs, so on-screen requests always find one free.

Try it yourself:

```bash
node scripts/stress.js 10000 /tmp/big   # write a synthetic 10k-frame board
cd /tmp/big && paper serve              # press P in the viewer for live stats
```

Thumbnails need a Chromium-family browser. paper looks for a Playwright headless shell, Chrome,
Chromium, Edge, Brave, Helium and a few others in their usual places. Set `PAPER_CHROME` to a binary
to pick one, or to `off` to disable it. Without one, the viewer draws thumbnails itself from each
frame's markup. Those are rougher (scripts don't run, remote fonts don't load), and zooming in still
shows the real page.

## For agents

`.claude/skills/paper-canvas/` is a Claude Code skill that teaches an agent to drive this CLI —
the workflow, the authoring constraints, and the full flag reference. It loads automatically when a
task involves mocking up or previewing a UI.

To use it from other projects, symlink it into your user skills directory:

```bash
ln -s "$PWD/.claude/skills/paper-canvas" ~/.claude/skills/paper-canvas
npm link   # so the skill finds `paper` on PATH
```

`AGENTS.md` covers the same ground for agents working directly in this repo.

## Notes

- Zoomed out, you're looking at screenshots taken just after each frame loads, once web fonts are in.
  Animations, and anything a script draws later, show up once you zoom to 50% or double-click in.
- Designs render in a sandboxed iframe with an opaque origin. Scripts and forms run; the page can't
  reach back into the canvas.
- Pan/zoom is saved, so reopening the viewer returns you where you left off.
- `--dir <path>` or `PAPER_CANVAS_DIR` points at a canvas outside the current directory.
