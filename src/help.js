const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = c('2');
const bold = c('1');
const cyan = c('36');

export const HELP = `
  ${bold('paper')} — an infinite canvas for HTML/CSS designs

  ${dim('USAGE')}
    paper <command> [options]

  ${dim('CANVAS')}
    serve                    Start the canvas viewer and open it in a browser
    init                     Create a canvas in the current directory
    status                   Show canvas location, frame count, server URL
    open [frame]             Open the viewer, optionally focused on a frame

  ${dim('FRAMES')}
    add <name>               Add a frame  ${dim('(--file | --html | stdin)')}
    set <frame>              Replace a frame's contents
    ls                       List every frame
    cat <frame>              Print a frame's HTML to stdout
    move <frame>             Reposition  ${dim('(--x --y, or --dx --dy)')}
    resize <frame>           Resize  ${dim('(--w --h, or --preset)')}
    rename <frame> <name>    Rename a frame
    rm <frame...>            Delete frames  ${dim('(--all to clear the canvas)')}
    arrange                  Lay every frame out on a tidy grid  ${dim('(--cols)')}

  ${dim('OPTIONS')}
    --file, -f <path>        Read HTML from a file
    --html <string>          Inline HTML
    --raw                    Don't wrap fragments in a document shell
    --preset <name>          desktop laptop tablet mobile square wide card
    --w --h                  Explicit size in px
    --x --y                  Explicit position; omit to auto-place
    --bg <color>             Frame background  ${dim('(default #ffffff)')}
    --json                   Machine-readable output
    --dir <path>             Use a canvas outside the current directory

  ${dim('A FRAME REFERENCE')} is an id, an id prefix, or a name.

  ${dim('EXAMPLES')}
    ${cyan('paper serve')}
    ${cyan('paper add hero --file hero.html --preset desktop')}
    ${cyan('cat nav.html | paper add nav --preset mobile')}
    ${cyan("paper add badge --html '<h1>Ship it</h1>' --w 400 --h 200")}
    ${cyan('paper set hero --file hero-v2.html')}
    ${cyan('paper arrange --cols 4')}

`;

export const COMMAND_HELP = {
  add: `
  ${bold('paper add')} <name> [options]

  Adds a new frame to the canvas. Content comes from --file, --html, or stdin;
  omit all three to create an empty placeholder frame you can fill in later.

  Fragments are wrapped in a minimal HTML document (charset, viewport, reset,
  background) so you can pass a bare ${dim('<div>')} and get a sane page. Pass --raw to
  skip that, or provide a full document and it's used verbatim.

  Position is chosen automatically — frames flow left to right and wrap onto a
  new row — unless you pass --x/--y.

  ${dim('OPTIONS')}
    --file, -f <path>   Read HTML from a file
    --html <string>     Inline HTML
    --raw               Use content verbatim, no document wrapper
    --preset <name>     desktop laptop tablet mobile square wide card
    --w --h <px>        Explicit size  ${dim('(default 1280×800)')}
    --x --y <px>        Explicit canvas position
    --bg <color>        Background behind the design
    --note <text>       Caption shown under the frame title
    --force             Allow a duplicate name
    --json              Print the created frame as JSON

  ${dim('EXAMPLES')}
    ${cyan('paper add hero --file hero.html --preset desktop')}
    ${cyan('cat card.html | paper add pricing-card --w 480 --h 620')}
`,
  set: `
  ${bold('paper set')} <frame> [options]

  Replaces a frame's contents in place, keeping its position and size. Every
  open canvas tab reloads that frame immediately — this is the command to use
  when iterating on a design.

  ${dim('OPTIONS')}
    --file, -f <path>   Read HTML from a file
    --html <string>     Inline HTML
    --raw               Use content verbatim, no document wrapper
    --bg <color>        Change the background at the same time

  ${dim('EXAMPLES')}
    ${cyan('paper set hero --file hero-v2.html')}
    ${cyan('paper set f_9c2a --html "<h1>Draft 3</h1>"')}
`,
  move: `
  ${bold('paper move')} <frame> [--x <px> --y <px>] [--dx <px> --dy <px>]

  Absolute placement with --x/--y, or relative nudges with --dx/--dy.
  Canvas coordinates: x grows right, y grows down, origin is wherever you like.

  ${dim('EXAMPLES')}
    ${cyan('paper move hero --x 0 --y 0')}
    ${cyan('paper move nav --dx 1400')}
`,
  resize: `
  ${bold('paper resize')} <frame> [--w <px> --h <px>] [--preset <name>]

  ${dim('PRESETS')}  desktop 1440×900 · laptop 1280×800 · tablet 834×1112
            mobile 390×844 · square 1000×1000 · wide 1920×1080 · card 480×320

  ${dim('EXAMPLES')}
    ${cyan('paper resize hero --preset mobile')}
    ${cyan('paper resize hero --h 1600')}
`,
  arrange: `
  ${bold('paper arrange')} [--cols <n>] [--gap <px>]

  Lays every frame out on a grid, ordered by creation. Columns size to their
  widest frame and rows to their tallest, so mixed-size frames still align.

  ${dim('EXAMPLES')}
    ${cyan('paper arrange --cols 4')}
    ${cyan('paper arrange --cols 2 --gap 200')}
`,
  serve: `
  ${bold('paper serve')} [--port <n>] [--no-open]

  Starts the canvas viewer on http://127.0.0.1:4321 (walks forward if that port
  is taken) and opens it in your browser. The server watches the canvas on disk,
  so any ${cyan('paper')} command from any terminal shows up live.

  ${dim('CANVAS CONTROLS')}
    Scroll / two-finger drag   Pan
    ⌘-scroll or pinch          Zoom
    Space + drag               Pan from anywhere
    Drag a frame's title bar   Move it
    Drag a frame's edge        Resize it
    Double-click a frame       Interact with the design inside
    F                          Zoom to fit    ${dim('· 0 resets to 100%')}
    Delete                     Remove the selected frame
`,
};
