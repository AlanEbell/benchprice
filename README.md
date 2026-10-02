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
- **Groups** on a set's line is for a set whose pieces are not all alike: earrings made
  together but set with different stones, say. Give each piece a letter; the pieces sharing a
  letter become a line of their own (*Spiral earrings (group A)*), with its own metal, stones
  and price, on the making time of its own pieces. A new group starts with a copy of what was
  entered for the set, unconfirmed. Put every piece back on one letter and the set is one line
  with one price again. A group left with no pieces is forgotten, and it asks first.
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
- **Not finished** on a line is for a piece that was marked finished by mistake. It goes back
  on the bench in BenchClock with all its time, the same as *Reopen* there, and what you
  entered for its price is kept for when it is really done. For a set it asks which ones.
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
  by purity and your supplier's premium over spot. Type the spot prices in, or press *Fetch
  live prices* there to look up today's silver, gold and platinum on
  [gold-api.com](https://gold-api.com); they land in the fields for you to look over, and
  nothing changes until you press Save. Tick *Fetch them each time BenchPrice starts* to have
  that done as the app opens. Those are the only times BenchPrice goes online, and confirmed
  prices stay as they are either way. Gold-filled, brass and anything else can be
  given a price per gram instead. The premium is what the supplier charges over the metal's
  value at spot: sterling wire at $85 an ounce when fine silver is $64 is 85 / (64 x 0.925) - 1,
  or 43.6%. *Add the supplier's premium* on a piece is ticked to start; untick it to price that
  piece's metal at its bare value, for metal you did not buy at the supplier's price.
- **Report or export** - one box, three choices, the same as in BenchClock. *Which pieces*:
  the finished ones, the ones you ticked on the list, the ones on the bench, or everything.
  *Finished on which days*: this week, last month, or any dates you set; a line is in when a
  piece of it was finished on those days. Then *Save as PDF* for a report to read and print,
  or *Save as CSV* for a spreadsheet, one row a line with all three prices, the chosen one and
  the cost breakdown. The PDF opens with every line and its price at a glance, then goes
  through each one: its making time (each piece of a set, and the average the labor is worked
  on), its metal by weight, every stone and finding, materials and labor, and how each of the
  three methods reached its figure. A confirmed price stands with the figures it was confirmed
  from, whatever spot prices and settings have done since; the top of the report says which
  spot prices the confirmed prices rest on, and that any price not yet confirmed is worked
  from today's.
- **Settings** (Ctrl+,) holds the labor rate, default method, spot prices, metals, and the
  numbers behind each method.
- **Help** (F1) explains the app from start to finish and shows how each of the three methods
  reaches its price: the formula, your own settings in it, and one piece worked through step
  by step.

## Where it keeps things

BenchPrice reads BenchClock's data folder. The one change it ever makes to BenchClock's own
files is *Not finished*, which sets a piece's `status` back and empties its `finished_at`,
exactly as BenchClock's *Reopen* does. Its own files live in a `pricing` folder inside it:

```
<BenchClock data folder>/pricing/settings.json    labor rate, spot prices, metals, the three methods
<BenchClock data folder>/pricing/items/<id>.json  metal, weight, stones and findings for one piece
<BenchClock data folder>/pricing/splits.json      the sets divided into groups, and each piece's letter
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
- `src/core/pricing.js` - settings, per-piece files, reading BenchClock's pieces, what a report
  covers, the CSV.
- `src/core/spot.js` - live spot prices from gold-api.com, the only code that goes online.
- `src/main/` - the Electron main process: window, menu bar, file dialogs, and the PDF report
  (`report.js` lays it out).
- `src/renderer/` - the window itself. `styles.css` and `icons.js` are shared with BenchClock;
  `help.js` is the help page.
- `build/icon.svg` - the app icon; `npm run icon` renders it to PNG.
- `scripts/smoke.js` - drives the real app end to end: `npm run smoke -- --data-dir=/tmp/benchprice-smoke`.

Installers have to be built on the system they are for. GitHub does that for all three:
`.github/workflows/build.yml` builds them when run from the Actions tab, and pushing a tag
like `v1.0.0` also makes a Release with the installers attached.

## License

[MIT](LICENSE).
