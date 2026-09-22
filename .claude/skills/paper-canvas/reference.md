# paper CLI reference

Full command surface. See `SKILL.md` for the workflow and the rules that matter.

A `<frame>` argument is a name (`hero`), an id (`f_9c2a1b04`), or an id prefix (`f_9c2`). Ambiguous
references fail with the list of candidates rather than guessing.

Every command accepts `--json` for machine-readable output and `--dir <path>` to target a canvas
outside the current directory (or set `PAPER_CANVAS_DIR`). Failures exit non-zero with a message on
stderr.

## Canvas

| Command | Notes |
| --- | --- |
| `paper serve` | Starts the viewer. **Long-running — always background it.** `--port <n>` (walks forward if taken), `--no-open` to skip launching a browser. |
| `paper init` | Creates `.paper-canvas/` in the cwd. Rarely needed — any command bootstraps it. |
| `paper status` | Canvas path, frame count, server URL or `not running`. |
| `paper open [frame]` | Opens the viewer, optionally focused on a frame. `--print` emits the URL instead of launching. |

## Frames

| Command | Notes |
| --- | --- |
| `paper add <name>` | Creates a frame. Content from `--file`, `--html`, or stdin; omit all three for an empty placeholder. Auto-places to the right of existing frames, wrapping onto a new row. |
| `paper set <frame>` | Replaces contents in place, keeping position and size. |
| `paper ls` | Table of id, name, size, position, content size. |
| `paper cat <frame>` | Prints the frame's HTML to stdout. |
| `paper move <frame>` | `--x --y` absolute, or `--dx --dy` relative. |
| `paper resize <frame>` | `--w --h`, or `--preset <name>`. |
| `paper rename <frame> <new-name>` | |
| `paper rm <frame...>` | Deletes frames. `--all` clears the board. |
| `paper arrange` | Grid layout ordered by creation. `--cols <n>` (default 3), `--gap <px>` (default 120). Columns size to their widest frame, rows to their tallest. |

## Content flags

Accepted by `add` and `set`:

| Flag | Meaning |
| --- | --- |
| `--file <path>`, `-f` | Read HTML from a file |
| `--html <string>` | Inline HTML |
| *(stdin)* | Piped content, e.g. `cat x.html \| paper add x` |
| `--raw` | Use content verbatim — skip the document wrapper |
| `--bg <color>` | Background behind the design (default `#ffffff`) |

`add` also takes `--x --y` (explicit position), `--note <text>` (caption shown beside the frame
title), and `--force` (allow a duplicate name — normally a name collision is an error telling you to
use `set`).

## Size presets

| Preset | Size |
| --- | --- |
| `desktop` | 1440×900 |
| `laptop` | 1280×800 *(default for a new frame)* |
| `tablet` | 834×1112 |
| `mobile` / `phone` | 390×844 |
| `square` | 1000×1000 |
| `wide` | 1920×1080 |
| `card` | 480×320 |

`--w`/`--h` override a preset, so `--preset mobile --h 1400` gives a tall phone frame. Minimum
dimension is 80px.

## The document wrapper

Content not starting with `<!doctype` or `<html` is wrapped in:

- `<meta charset>` and `<meta name="viewport">`
- `box-sizing: border-box` on everything
- `margin: 0; padding: 0; height: 100%` on `html` and `body` — the frame behaves like a viewport, so
  `height: 100%` in the design resolves. Taller content overflows and scrolls inside the frame.
- The frame background and a system sans-serif stack
- `max-width: 100%; display: block` on `img`, `svg`, `video`

Pass `--raw` to opt out entirely, or supply a full document to control the `<head>` yourself.

## On-disk layout

The canvas is plain files in `.paper-canvas/` in the working directory:

```
.paper-canvas/
  canvas.json          frame metadata (position, size, name) + saved viewport
  frames/<id>.html     markup for one frame
  server.json          host/port/pid of the running viewer
```

The CLI edits these files directly and never talks to the server. The server watches the directory and
pushes changes to open tabs over SSE. Consequences worth knowing:

- CLI commands work whether or not the viewer is running.
- Any number of terminals can drive the same canvas.
- Moves and resizes done in the browser write back to `canvas.json`, so `paper ls` sees them.
- An empty frame has **no** file in `frames/` — the viewer renders a placeholder instead.

Read `canvas.json` if you must, but never write it; the CLI keeps open tabs in sync and does atomic
writes.

## Canvas controls (for telling the user)

| | |
| --- | --- |
| scroll / two-finger drag | Pan |
| ⌘-scroll or pinch | Zoom |
| space + drag | Pan from anywhere |
| drag a frame | Move it (dragging the title works too) |
| drag an edge or corner | Resize — shift keeps the aspect ratio |
| double-click a frame | Interact with the design inside; esc to leave |
| `F` / `0` / `1` | Fit all · reset to 100% · zoom to selection |
| `R` | Reload the selected frame |
| `⌫` | Delete the selected frame |
| `?` | Shortcut list |

Frames are inert by default — a click drags rather than hitting links inside — so a board of live
pages can be rearranged without triggering them.

## Troubleshooting

**Nothing appears in the browser.** Check `paper status` for a server URL. If the canvas path it
reports isn't the one you're adding to, you're in a different directory — pass `--dir`.

**"A frame named X already exists."** You meant `paper set X`, not `paper add X`.

**Design renders unstyled.** It references an external stylesheet. Inline the CSS in a `<style>` block.

**Layout collapses to zero height.** The design used `height: 100%` with `--raw`, which skips the
full-height wrapper. Drop `--raw` or set the height yourself.

**Frame is blank white.** Created without content. `paper set <frame> --file …` to fill it.

**Changes don't show.** The viewer reloads a frame when its file changes on disk. If a tab looks
stale, the connection dot in the top-left goes red when disconnected; it reconnects on its own, and
the user can reload the page.
