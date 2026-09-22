# paper

An infinite canvas scratchpad for HTML/CSS designs — driven entirely from the command line.

Agents write markup and push it onto a canvas with `paper add` / `paper set`. You pan, zoom, and
rearrange the result in the browser. There is no in-app editing: the CLI is the only way content
changes, so an agent and a human can work on the same canvas without stepping on each other.

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

## How it works

The canvas lives on disk in `.paper-canvas/` in whatever directory you run from:

```
.paper-canvas/
  canvas.json          frame metadata (position, size, name) + saved viewport
  frames/<id>.html     the markup for one frame
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
| `paper serve` | Start the viewer (`--port`, `--no-open`) |
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
| `?` | Shortcut list |

Frames are inert by default — a click drags rather than hitting links inside — so you can rearrange a
board of live pages without triggering them. Double-click to step into one.

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

- Designs render in a sandboxed iframe with an opaque origin. Scripts and forms run; the page can't
  reach back into the canvas.
- Pan/zoom is saved, so reopening the viewer returns you where you left off.
- `--dir <path>` or `PAPER_CANVAS_DIR` points at a canvas outside the current directory.
