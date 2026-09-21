# BenchPrice

A price for each finished piece on your [BenchClock](https://github.com/AlanEbell/benchclock)
time card. BenchClock knows how long a piece took; BenchPrice adds what it is made of and
works out a price three ways. A desktop app for Linux, Windows and macOS.

## Installing it

Install [BenchClock](https://github.com/AlanEbell/benchclock) first: BenchPrice reads its time
card. Then download the installer for your computer from the
[latest release](https://github.com/AlanEbell/benchprice/releases/latest): `win-x64.exe` for
Windows, `mac-universal.dmg` for a Mac, `linux-amd64.deb` or the `.AppImage` for Linux. The
installers are not signed with a paid certificate yet, so Windows and macOS show a warning the
first time; the release notes say what to click.

## Using it

- **Finished pieces** come straight from BenchClock, with their making time per piece. Tick
  *Show the bench too* to price pieces that are still being made, for a quote.
- **Sets carry one price.** Pieces added together in BenchClock (*Moonstone ring x3*) are one
  line here, priced once on the average making time of the finished ones, so every piece in
  the set sells for the same. A custom piece is always priced on its own.
- **Price** on a line opens the piece: its metal and weight in grams, and a list of stones,
  findings and anything else bought in, at what you paid. The prices update as you type, and
  the box shows how each was arrived at. Press a method's card to price this piece that way
  instead of the default. *Or set the price yourself* overrides every method with a price you
  choose; the methods are still shown beside it for comparison. *Clear pricing* forgets
  everything entered for the line so you can start over.
- **Confirm price** writes the price itself into the piece's file, with the figures it was
  reached from and the date. From then on that is the piece's price, whatever spot prices and
  settings do; the list says "now $X" when the live figure has moved, and confirming again
  reprices. *Save* keeps what was entered without confirming.
- **Three methods**, side by side:
  1. **Cost-plus**: materials plus labor, times a factor (2 to start).
  2. **Loaded hourly** (the default): your hourly rate divided by the share of clocked time
     that is making, so the making hours carry the TimeOverhead, then a profit margin. The
     TimeOverhead share is measured from BenchClock's files and can be overridden.
  3. **Tiered materials**: each material marked up by its cost band (cheap findings more,
     expensive stones less), plus labor and a studio overhead per hour, then a margin.
  Selling fees and rounding (to the nearest $5, say, going up, to the nearest or down) are applied
  to all three, last.
- **Metal prices** come from spot prices per troy ounce that you keep current in *Settings*,
  by purity and your supplier's premium over spot. Gold-filled, brass and anything else can be
  given a price per gram instead. The premium is what the supplier charges over the metal's
  value at spot: sterling wire at $85 an ounce when fine silver is $64 is 85 / (64 x 0.925) - 1,
  or 43.6%. *Add the supplier's premium* on a piece is ticked to start; untick it to price that
  piece's metal at its bare value, for metal you did not buy at the supplier's price.
- **Save price sheet** writes a CSV of the ticked pieces (or every finished piece) with all
  three prices, the chosen one, and the cost breakdown.
- **Settings** (Ctrl+,) holds the labor rate, default method, spot prices, metals, and the
  numbers behind each method.

## Where it keeps things

BenchPrice reads BenchClock's data folder and never writes to BenchClock's own files. Its own
files live in a `pricing` folder inside it:

```
<BenchClock data folder>/pricing/settings.json    labor rate, spot prices, metals, the three methods
<BenchClock data folder>/pricing/items/<id>.json  metal, weight, stones and findings for one piece
```

The data folder is the one BenchClock uses (`~/.local/share/BenchClock`, `%APPDATA%\BenchClock`,
`~/Library/Application Support/BenchClock`), and the same `BENCHCLOCK_DATA_DIR` variable or
`--data-dir=<folder>` argument moves it. Backing up that folder backs up both apps.

## Development

Needs [Node.js](https://nodejs.org) 22 or newer.

    npm install
    npm start                 # run the app
    npm test                  # the arithmetic and the files (no window needed)

- `src/core/arithmetic.js` - the three methods, pure arithmetic. Loaded by the window too.
- `src/core/pricing.js` - settings, per-piece files, reading BenchClock's pieces, the CSV.
- `src/main/` - the Electron main process: window, menu bar, file dialogs.
- `src/renderer/` - the window itself. `styles.css` and `icons.js` are shared with BenchClock.
- `build/icon.svg` - the app icon; `npm run icon` renders it to PNG.
- `scripts/smoke.js` - drives the real app end to end: `npm run smoke -- --data-dir=/tmp/benchprice-smoke`.

Installers have to be built on the system they are for. GitHub does that for all three:
`.github/workflows/build.yml` builds them when run from the Actions tab, and pushing a tag
like `v1.0.0` also makes a Release with the installers attached.

## License

[MIT](LICENSE).
