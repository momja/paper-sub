# Working with the paper canvas

> Also available as the `paper-canvas` skill in `.claude/skills/`, which carries the same guidance
> plus a full flag reference. Either is enough; don't read both.

This project is an infinite canvas for showing HTML/CSS designs. You put designs on it with the
`paper` CLI; the human pans, zooms, and rearranges them in the browser. Treat the canvas as the place
you show your work, not a place you read state from.

## The loop

```bash
paper status                                      # is a canvas here? is the viewer running?
paper serve                                       # start the viewer if it isn't (long-running)
paper add hero --file hero.html --preset desktop  # put a design up
paper set hero --file hero-v2.html                # iterate — the open tab reloads that frame
```

`paper add` creates, `paper set` replaces contents in place. Prefer `set` when iterating: it keeps the
frame's position and size, so the human's layout survives your changes.

## Rules that matter

- **One design per frame.** Give each frame a short, stable, kebab-case name (`hero`, `pricing-card`,
  `settings-empty`). Names are how you and the human refer to the same thing.
- **Don't reposition frames the human has moved.** They arrange the board; you fill it. Use `paper
  move`/`arrange` only when asked, or for frames you just created.
- **Write real files.** Author designs as `.html` files in the repo and pass `--file`. Inline `--html`
  is fine for a one-liner, but a file is editable, diffable, and re-runnable.
- **Size the frame to the design.** A mobile layout in a 1440px frame reads as broken. Use `--preset
  mobile|tablet|desktop|…` or explicit `--w/--h`.
- **Show variants side by side.** Separate frames beat one frame containing three mockups — the human
  can move and compare them.

## Authoring content

Write a fragment and the CLI wraps it in a document with a reset, viewport meta, and full-height
`html`/`body`. Write a complete document (starting `<!doctype`/`<html>`) and it is used verbatim —
do that when you need custom `<head>` content such as a font link.

Everything must be self-contained: inline the CSS in a `<style>` block, inline SVG, use data URIs.
There is no build step and no asset pipeline.

```bash
paper add pricing --file designs/pricing.html --w 1000 --h 620
cat designs/nav.html | paper add nav --preset mobile
paper add note --html '<h1 style="font:600 42px system-ui;padding:64px">Draft</h1>' --w 600 --h 240
```

## Reading back

```bash
paper ls --json     # ids, names, sizes, positions
paper cat hero      # exact HTML currently on the canvas
```

Use `--json` when you need to parse. Every command accepts it.

## Don't

- Don't edit `.paper-canvas/` by hand — use the CLI so open tabs stay in sync.
- Don't run `paper rm --all` unless the human asked you to clear the board.
- Don't leave `paper serve` running in the foreground of a step you need to finish; start it in the
  background or tell the human to run it.
