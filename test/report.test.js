'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, beforeEach, afterEach } = require('node:test');

const { PriceBook, PricingError, totals } = require('../src/core/pricing.js');
const { buildReportHtml, coversLabel } = require('../src/main/report.js');

let dir, book;

/** A BenchClock time card: two rings made together, hoops clocked as four, a cuff with a photo, a pendant on the bench. */
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchprice-'));
  fs.mkdirSync(path.join(dir, 'items'), { recursive: true });
  const item = (extra) => ({
    schema_version: 1, sku: '', type: 'ring', photo: null, batch_id: null, quantity: 1, notes: '', created_at: '2026-09-01T09:00:00-04:00',
    started_at: '2026-09-01T09:00:00-04:00', finished_at: null, split_from: null, time_entries: [], ...extra,
  });
  const items = [
    item({ id: 'ring-a', sequence: 1, name: 'Moonstone ring', batch_id: 'batch-1', status: 'finished', finished_at: '2026-09-10T15:00:00-04:00', total_seconds: 9000 }),
    item({ id: 'ring-b', sequence: 2, name: 'Moonstone ring', batch_id: 'batch-1', status: 'finished', finished_at: '2026-09-12T15:00:00-04:00', total_seconds: 6300 }),
    item({ id: 'hoops', sequence: 3, name: 'Hoop earrings', type: 'earrings', status: 'finished', finished_at: '2026-09-14T11:00:00-04:00', quantity: 4, total_seconds: 7200, notes: 'Hammered' }),
    item({ id: 'cuff', sequence: 4, name: 'Cuff <b>& "co"', type: 'cuff', sku: 'C-1', photo: '0123456789abcdef.jpg', status: 'finished', finished_at: '2026-08-20T10:00:00-04:00', total_seconds: 3600 }),
    item({ id: 'pendant', sequence: 5, name: 'Opal pendant', type: 'pendant', status: 'in_progress', total_seconds: 5400 }),
    item({ id: 'time-overhead', sequence: 0, name: 'TimeOverhead', type: 'overhead', status: 'overhead', total_seconds: 13500 }), // 30% of 45000
  ];
  for (const it of items) fs.writeFileSync(path.join(dir, 'items', `${it.id}.json`), JSON.stringify(it));
  book = new PriceBook(dir);
  book.saveSettings({ metals: [{ id: 'm', name: 'Silver', base: null, per_gram: 2 }], round_to: 0 });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const report = (choice, when) => {
  const { scope, period, lines } = book.chooseLines(choice);
  const settings = book.settings();
  const html = buildReportHtml({ lines, settings, overheadShare: book.overheadShare(settings), scope, period, photosDir: book.photosDir, generatedAt: when });
  return { html, text: html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ').replace(/&middot;/g, '·').replace(/&times;/g, '×')
    .replace(/&divide;/g, '÷').replace(/&minus;/g, '−').replace(/&mdash;/g, '—').replace(/&#39;/g, "'").replace(/\s+/g, ' ') };
};

test('the report shows the hours, the materials and the prices of each line', () => {
  book.confirmPrice('batch-1', { metal: 'm', weight_grams: 5, components: [{ name: 'Moonstone', quantity: 1, unit_cost: 30 }, { name: 'Jump rings', quantity: 4, unit_cost: 0.25 }], notes: 'Bezel set' });
  book.savePricing('cuff', { metal: 'm', weight_grams: 20, manual_price: 180 });
  const { html, text } = report();

  assert.match(text, /BenchPrice price report Finished pieces Made/);
  assert.match(text, /Pieces 7 in 3 sets or singles/);
  assert.match(text, /Making time 7h 15m 7\.25 hours/); // 9000 + 6300 + 7200 + 3600 s
  assert.match(text, /Materials \$122\.00/); // two rings at $41, a cuff at $40, hoops with nothing entered
  assert.match(text, /At these prices \$661\.98 1 of 3 not priced yet/); // 2 x $240.99 + $180
  assert.match(text, /Confirmed prices stand as confirmed, on spot \$32 silver, \$2,400 gold, \$1,000 platinum a troy ounce, labor \$50 an hour\. Prices not yet confirmed are worked from today's figures: spot \$32 silver, \$2,400 gold, \$1,000 platinum a troy ounce, labor \$50 an hour, TimeOverhead 30% of clocked time from BenchClock\. Finished/);
  // at a glance first, one row a line
  assert.match(text, /Finished 7 pieces · 7h 15m of making · \$661\.98 Piece Finished Time each Labor Materials Price Total/);
  assert.match(text, /Moonstone ring ×2 Ring · Bezel set Sep 12, 2026 2h 08m 2\.13 h \$106\.25 \$41\.00 \$240\.99 confirmed \$481\.98/);
  assert.match(text, /Hoop earrings ×4 Earrings · Hammered Sep 14, 2026 0h 30m 0\.50 h \$25\.00 — not priced yet —/);
  assert.match(text, /Cuff \/ bangle · SKU C-1 Aug 20, 2026 1h 00m 1\.00 h \$50\.00 \$40\.00 \$180 not confirmed \$180/);
  assert.match(text, /How each price is reached 3 sets or singles · costs and prices for one piece/);

  // a set: one price, its labor on the average of the two, and each ring's own time beneath
  assert.match(text, /Moonstone ring ×2 Ring · a set of 2, one price · finished Sep 12, 2026 · Bezel set \$240\.99 each Confirmed .* · Loaded hourly 2 pieces: \$481\.98/);
  assert.match(text, /Labor 2h 08m of making \(2\.125 h\) at \$50 an hour \$106\.25/);
  assert.match(text, /Metal: Silver 5 g at \$2\.00 a gram \$10\.00 Moonstone 1 × \$30\.00 \$30\.00 Jump rings 4 × \$0\.25 \$1\.00/);
  assert.match(text, /Materials metal \$10\.00, stones and findings \$31\.00 \$41\.00 Labor and materials \$147\.25/);
  assert.match(text, /Cost-plus \(\$41\.00 materials \+ \$106\.25 labor\) × 2 \$294\.50/);
  assert.match(text, /Loaded hourly chosen \$50\/h ÷ \(1 − 30% TimeOverhead\) = \$71\.43\/h; 2\.125 h × \$71\.43 = \$151\.79, \+ \$41\.00 materials, ÷ \(1 − 20% margin\) \$240\.99/);
  assert.match(text, /Piece 1 of 2 Sep 10, 2026 2h 30m 2\.50 Piece 2 of 2 Sep 12, 2026 1h 45m 1\.75 2h 08m each, the average over the 2 finished 4h 15m 4\.25/);

  // pieces clocked as one: the lot, and what that is each; nothing entered, so no prices
  assert.match(text, /Hoop earrings ×4 Earrings · a set of 4, one price · finished Sep 14, 2026 · Hammered — Not priced yet/);
  assert.match(text, /Labor 0h 30m of making \(0\.5 h\) at \$50 an hour \$25\.00 No weight or materials entered yet/);
  assert.match(text, /All 4 together Sep 14, 2026 2h 00m 2\.00 0h 30m each 2h 00m 2\.00/);

  // a price set by hand, not confirmed; no making-time table for a single piece
  assert.match(text, /Cuff \/ bangle · finished Aug 20, 2026 · SKU C-1 \$180 Set by hand, not confirmed/);
  assert.match(text, /Set by hand chosen wins over every method \$180/);
  assert.ok(html.includes('Cuff &lt;b&gt;&amp; &quot;co&quot;') && !html.includes('Cuff <b>'), 'names are escaped');
  assert.ok(html.includes('photos/0123456789abcdef.jpg'), 'the photo is shown');
  assert.ok(!text.includes('Opal pendant') && !text.includes('On the bench'), 'only what is finished, unless asked');
});

test('a confirmed price stands with the figures it was confirmed from, whatever the settings do since', () => {
  book.confirmPrice('cuff', { metal: 'm', weight_grams: 20 });
  book.confirmPrice('batch-1', { metal: 'm', weight_grams: 5, manual_price: 250 });
  const before = report().text;
  assert.match(before, /\$139\.29 Confirmed .* · Loaded hourly What goes into it Cost Labor 1h 00m of making \(1 h\) at \$50 an hour \$50\.00 Metal: Silver 20 g at \$2\.00 a gram \$40\.00/); // (1 h x $71.43 + $40) / 0.8
  assert.match(before, /Loaded hourly chosen .* \$139\.29 Tiered/);
  book.saveSettings({ labor_rate: 60, metals: [{ id: 'm', name: 'Silver', base: null, per_gram: 3 }], cost_plus: { factor: 3 }, round_to: 5 });
  const { text } = report();
  assert.match(text, /Confirmed prices stand as confirmed, on spot \$32 silver, \$2,400 gold, \$1,000 platinum a troy ounce, labor \$50 an hour\. Prices not yet confirmed are worked from today's figures: .* labor \$60 an hour, .*; they are rounded up to the next \$5\./);
  assert.match(text, /Cuff .* \$139\.29 Confirmed .* · Loaded hourly What goes into it Cost Labor 1h 00m of making \(1 h\) at \$50 an hour \$50\.00 Metal: Silver 20 g at \$2\.00 a gram \$40\.00/);
  assert.match(text, /Cost-plus \(\$40\.00 materials \+ \$50\.00 labor\) × 2 \$180 Loaded hourly chosen .* \$139\.29 Tiered/, 'the three methods as they were, not with the new factor');
  assert.match(text, /Moonstone ring ×2 .* \$250 each Confirmed .* · Set by hand .* Labor 2h 08m of making \(2\.125 h\) at \$50 an hour \$106\.25 Metal: Silver 5 g at \$2\.00 a gram \$10\.00 .* Set by hand chosen wins over every method \$250/);
  assert.match(text, /At these prices \$639\.29 1 of 3 not priced yet/);
  assert.ok(!text.includes("Today's figures"), 'no line is reworked on today\'s figures');
  // the hoops, not confirmed, are priced on today's figures
  assert.match(text, /Hoop earrings ×4 .* Labor 0h 30m of making \(0\.5 h\) at \$60 an hour \$30\.00/);

  // a price confirmed before the three methods were saved with it: the methods are worked out again from its own figures
  const file = path.join(dir, 'pricing', 'items', 'cuff.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete saved.confirmed.methods;
  delete saved.confirmed.chosen;
  fs.writeFileSync(file, JSON.stringify(saved));
  const old = report().text;
  assert.match(old, /Cuff .* \$139\.29 Confirmed .* Labor 1h 00m of making \(1 h\) at \$50 an hour \$50\.00 Metal: Silver 20 g at \$2\.00 a gram \$40\.00/);
  assert.match(old, /Cost-plus \(\$40\.00 materials \+ \$50\.00 labor\) × 3 \$270 Loaded hourly chosen .* \$139\.29 Tiered/, 'the factor of today, the rest of its day');

  // confirmed on different days at different spot prices: each block says which
  book.saveSettings({ spot: { silver: 40 } });
  book.confirmPrice('hoops', { components: [{ name: 'Posts', quantity: 2, unit_cost: 1 }] });
  const mixed = report().text;
  assert.match(mixed, /Confirmed prices stand as confirmed, each on the spot prices of its day, given with the piece\. Finished/);
  assert.match(mixed, /Hoop earrings ×4 .* Confirmed .* on spot \$40 silver, \$2,400 gold, \$1,000 platinum a troy ounce/);
  assert.match(mixed, /Cuff .* Confirmed .* on spot \$32 silver/);
  assert.ok(!mixed.includes('not yet confirmed'), 'every price is confirmed');
});

test('which pieces and which days a report covers', () => {
  const ids = (choice) => book.chooseLines(choice).lines.map((g) => g.id);
  assert.deepEqual(ids(), ['hoops', 'batch-1', 'cuff']); // as on the list: finished, newest first
  assert.deepEqual(ids({ scope: 'bench' }), ['pendant']);
  assert.deepEqual(ids({ scope: 'all' }), ['hoops', 'batch-1', 'cuff', 'pendant']);
  assert.deepEqual(ids({ scope: 'ticked', ids: ['pendant', 'cuff'] }), ['cuff', 'pendant']);
  assert.deepEqual(ids({ from: '2026-09-01', to: '2026-09-12' }), ['batch-1']);
  assert.deepEqual(ids({ from: '2026-09-10', to: '2026-09-10' }), ['batch-1'], 'a set is in when any piece of it was finished then');
  assert.deepEqual(ids({ to: '2026-08-31' }), ['cuff']);
  assert.deepEqual(ids({ scope: 'all', from: '2026-09-13' }), ['hoops'], 'nothing on the bench has a finished day');
  assert.deepEqual(ids({ scope: 'ticked', ids: ['pendant', 'cuff'], from: '2026-08-01', to: '2026-08-31' }), ['cuff']);
  assert.deepEqual(ids({ from: '', to: null }), ['hoops', 'batch-1', 'cuff']);
  assert.throws(() => ids({ from: '2026-09-13', to: '2026-09-07' }), /on or before/);
  assert.throws(() => ids({ from: 'last tuesday' }), /Couldn't understand the date/);
  assert.throws(() => ids({ scope: 'some' }), PricingError);

  assert.deepEqual(totals(book.chooseLines({ scope: 'all' }).lines), { lines: 4, pieces: 8, seconds: 31500, materials: 0, value: 0, confirmed: 0, unpriced: 4 });
  assert.equal(coversLabel('finished', {}), 'Finished pieces');
  assert.equal(coversLabel('finished', { from: '2026-09-07', to: '2026-09-13' }), 'Pieces finished Sep 7, 2026 – Sep 13, 2026');
  assert.equal(coversLabel('ticked', { from: '2026-09-10', to: '2026-09-10' }), 'Ticked pieces · finished Sep 10, 2026');
  assert.equal(coversLabel('all', { from: '2026-09-14' }), 'Every piece · finished from Sep 14, 2026');
  assert.equal(coversLabel('all', { to: '2026-08-31' }), 'Every piece · finished up to Aug 31, 2026');

  const both = report({ scope: 'all' }).text;
  assert.match(both, /Pieces 8 in 4 sets or singles, 1 on the bench/);
  assert.match(both, /Opal pendant Pendant · in progress — Not priced yet/);
  assert.match(both, /On the bench 1 piece · 1h 30m of making Piece .* Opal pendant Pendant In progress 1h 30m 1\.50 h \$75\.00 — not priced yet — How each price is reached 4 sets or singles/);
  assert.match(report({ from: '2026-09-01', to: '2026-09-12' }).text, /Pieces finished Sep 1, 2026 – Sep 12, 2026 Made/);
  assert.match(report({ scope: 'bench', to: '2026-09-30' }).text, /No pieces to report on/);
});
