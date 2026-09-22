---
name: paper-canvas
description: Show HTML/CSS designs on an infinite canvas using the `paper` CLI. Use when asked to mock up, design, preview, or iterate on a UI, landing page, component, or screen — anything the user should look at rather than read as code. Also use when they mention the canvas, a frame, or ask to put a design "up" / "on the board".
---

# paper canvas

An infinite canvas that displays HTML/CSS designs. You put designs on it from the command line; the
user pans, zooms, and rearranges them in the browser. There is no in-app editing — the CLI is the only
way content changes, so you and the user can work on the same board without stepping on each other.

Reach for this instead of dumping a large HTML file in chat and hoping the user opens it.

## Before anything else

**1. Resolve the command.** `paper` is only on PATH if someone ran `npm link`. Try in order, and use
whichever works for every command below:

```bash
paper status                      # 1. on PATH
node bin/paper.js status          # 2. cwd is the paper_sub repo
node ../paper_sub/bin/paper.js status
```

Still nothing? Locate it once rather than guessing:

```bash
find ~ -name paper.js -path '*/bin/*' -not -path '*/node_modules/*' 2>/dev/null | head -3
```

If it isn't installed on this machine, say so — don't improvise a substitute. Suggest `npm link` from
the repo to put `paper` on PATH permanently.

**2. Make sure the viewer is running.** `paper status` prints the server URL, or `not running`.
If it isn't running, start it **in the background** — `paper serve` never returns:

```bash
paper serve --no-open   # run_in_background: true
```

Then tell the user the URL (default `http://127.0.0.1:4321`). Adding frames works whether or not the
viewer is running, but the user sees nothing until it is.

## The loop

```bash
paper add hero --file designs/hero.html --preset desktop   # create
paper set hero --file designs/hero.html                    # iterate — reloads that frame live
```

`add` creates a frame, `set` replaces its contents in place. **Prefer `set` when iterating**: it keeps
the frame's position and size, so any layout the user arranged survives your change. Using `add` again
for a revision leaves a stale duplicate on the board.

Frames are referenced by name (`hero`), id (`f_9c2a1b04`), or id prefix (`f_9c2`).

## Rules that matter

- **One design per frame**, with a short stable kebab-case name (`hero`, `pricing-card`,
  `settings-empty`). The name is how you and the user refer to the same thing.
- **Show variants as separate frames**, not three mockups stacked in one. The user can then move and
  compare them.
- **Size the frame to the design.** A mobile layout in a 1440px frame reads as broken. Use
  `--preset mobile|tablet|laptop|desktop|wide|square|card` or explicit `--w`/`--h`.
- **Write real files.** Author designs as `.html` files in the repo and pass `--file`. Inline `--html`
  is fine for a one-liner, but a file is editable, diffable, and re-runnable.
- **Don't reposition frames the user has moved.** They arrange the board; you fill it. Use `move` or
  `arrange` only when asked, or on frames you just created.
- **Never hand-edit `.paper-canvas/`** — use the CLI so open tabs stay in sync.
- **Never `paper rm --all`** unless explicitly asked to clear the board.

## Authoring the HTML

Write a fragment and it gets wrapped in a document with a reset, viewport meta, and full-height
`html`/`body` (so `height: 100%` works). Write a full document (starting `<!doctype` or `<html`) and
it is used verbatim — do that when you need custom `<head>` content such as a font link.

Everything must be **self-contained**: inline the CSS in a `<style>` block, inline SVG, use data URIs.
There is no build step, no bundler, and no asset pipeline. A design referencing `./styles.css` renders
unstyled.

Designs run in a sandboxed iframe with an opaque origin — scripts and forms work, but `localStorage`
throws. Don't rely on storage APIs.

```bash
paper add pricing --file designs/pricing.html --w 1000 --h 620
cat designs/nav.html | paper add nav --preset mobile
paper add note --html '<h1 style="font:600 42px system-ui;padding:64px">Draft</h1>' --w 600 --h 240
```

## Reading the board back

```bash
paper ls --json    # ids, names, sizes, positions — parse this
paper cat hero     # exact HTML currently on the canvas
```

Every command accepts `--json`. Check `paper ls` before adding, so you `set` an existing frame instead
of creating a near-duplicate.

## Telling the user how to drive it

Drag a frame to move it, drag its edge to resize, **double-click to interact** with the design inside
(frames are inert by default so clicks drag rather than trigger links). `F` fits everything, `?` lists
shortcuts.

To share the board with someone who can't run the viewer, `paper export` writes one self-contained,
view-only HTML file (`--out <file>`, or `--out -` for stdout). The viewer's Copy HTML and Download
buttons do the same.

## Full command and flag reference

See [reference.md](reference.md) for every command, all flags, the size presets, the on-disk layout,
and troubleshooting.
