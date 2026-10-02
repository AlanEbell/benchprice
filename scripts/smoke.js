'use strict';
// Developer tool: drives the real app through its real window-to-main bridge on a throwaway
// data folder, checks what lands on disk, and saves screenshots of each screen beside it.
//   npx electron scripts/smoke.js --data-dir=/tmp/x
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const { PricingError } = require('../src/core/pricing.js');
let spotDown = false; // what the stand-in for gold-api.com does, see the end

const dataDir = (process.argv.find((a) => a.startsWith('--data-dir=')) || '').slice(11);
assert.ok(dataDir, 'pass --data-dir=<empty folder>');

// A BenchClock time card: two finished rings from one batch, finished hoops, a pendant on the bench, TimeOverhead.
fs.mkdirSync(path.join(dataDir, 'items'), { recursive: true });
const item = (extra) => ({
  schema_version: 1, sku: '', type: 'ring', photo: null, batch_id: null, quantity: 1, notes: '', created_at: '2026-09-01T09:00:00-04:00',
  started_at: '2026-09-01T09:00:00-04:00', finished_at: null, split_from: null, time_entries: [], ...extra,
});
const items = [
  item({ id: 'moonstone-ring-a', sequence: 1, name: 'Moonstone ring', batch_id: 'batch-1', status: 'finished', finished_at: '2026-09-10T15:00:00-04:00', total_seconds: 9000, seconds_per_piece: 9000 }),
  item({ id: 'moonstone-ring-b', sequence: 2, name: 'Moonstone ring', batch_id: 'batch-1', status: 'finished', finished_at: '2026-09-12T15:00:00-04:00', total_seconds: 6300, seconds_per_piece: 6300 }),
  item({ id: 'hoops', sequence: 3, name: 'Hoop earrings', type: 'earrings', status: 'finished', finished_at: '2026-09-14T11:00:00-04:00', quantity: 4, total_seconds: 7200, seconds_per_piece: 1800, notes: 'Hammered' }),
  item({ id: 'pendant', sequence: 4, name: 'Opal pendant', type: 'pendant', status: 'in_progress', total_seconds: 5400, seconds_per_piece: 5400 }),
  item({ id: 'time-overhead', sequence: 0, name: 'TimeOverhead', type: 'overhead', status: 'overhead', total_seconds: 12000, seconds_per_piece: 12000 }),
];
for (const it of items) fs.writeFileSync(path.join(dataDir, 'items', `${it.id}.json`), JSON.stringify(it, null, 2));

let started = false;
app.on('browser-window-created', (event, win) => {
  if (started) return; // only the app's own window; the report printer comes later
  started = true;
  win.webContents.once('did-finish-load', async () => {
    const run = (js) => win.webContents.executeJavaScript(`(async () => { ${js} })()`, true);
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    const shot = async (name) => { await pause(200); fs.writeFileSync(path.join(dataDir, `${name}.png`), (await win.webContents.capturePage()).toPNG()); };
    try {
      await pause(600);
      assert.equal(await run('return typeof price'), 'function', 'the arithmetic is loaded in the page');
      const rows = await run("return [...document.querySelectorAll('#pieces .row b')].map((b) => b.textContent)");
      assert.deepEqual(rows, ['Hoop earrings', 'Moonstone ring'], 'finished sets and singles, newest first; a set is one line');
      assert.match(await run("return document.querySelector('#pieces .row[data-id=batch-1] .meta').textContent"), /2h 08m each · a set, one price/); // (9000 + 6300) / 2
      assert.match(await run("return $('strip').textContent"), /30\.1% TimeOverhead/); // 12000 / (12000 + 27900)
      await shot('1-main-empty');

      // price a ring: sterling, 4.2 g, a stone and some findings
      await run("document.querySelector('#pieces .row[data-id=batch-1] [data-act=price]').click()");
      assert.equal(await run("return $('pieceDlg').open"), true);
      assert.match(await run("return $('pieceHint').textContent"), /A set of 2: every piece carries the same price/);
      await run(`$('pMetal').value = 'sterling'; $('pWeight').value = '4.2';
                 $('partAdd').click(); $('partAdd').click();
                 const rows = $('partRows').children;
                 rows[0].querySelector('[data-part=name]').value = 'Moonstone cabochon 8 mm'; rows[0].querySelector('[data-part=unit_cost]').value = '30';
                 rows[1].querySelector('[data-part=name]').value = 'Jump rings'; rows[1].querySelector('[data-part=quantity]').value = '4'; rows[1].querySelector('[data-part=unit_cost]').value = '0.25';
                 $('pNotes').value = 'Bezel set'; updatePiece();`);
      const cards = await run("return [...document.querySelectorAll('#methodCards .card .price')].map((e) => e.textContent)");
      assert.equal(cards.length, 3);
      assert.equal(await run("return document.querySelector('#methodCards .card.chosen').dataset.method"), '2', 'method 2 is the default');
      assert.match(await run("return $('breakdown').textContent"), /4\.2 g of Sterling silver at \$1\.09\/g, with the 15% premium/);
      // the supplier's premium is a tick box: on to start, and the metal drops to its bare value without it
      assert.deepEqual(await run("return [$('pPremium').checked, $('pPremiumRow').hidden]"), [true, false]);
      assert.match(await run("return $('pPremiumText').textContent"), /premium over spot: 15%, \$1\.09\/g instead of \$0\.95\/g/);
      await run("$('pPremium').click()");
      assert.match(await run("return $('breakdown').textContent"), /4\.2 g of Sterling silver at \$0\.95\/g\$4\.00/);
      await run("$('pMetal').value = 'brass'; updatePiece();");
      assert.equal(await run("return $('pPremiumRow').hidden"), true, 'no premium on a metal priced by the gram');
      await run("$('pMetal').value = 'sterling'; $('pPremium').click(); updatePiece();");
      await shot('2-piece');
      await run("document.querySelector('#methodCards [data-method=\"3\"]').click()");
      assert.equal(await run("return $('pMethod').value"), '3');
      assert.match(await run("return $('pieceConfirm').textContent"), /^Confirm \$\d+ each$/);
      await run("$('pieceSave').click(); await new Promise((r) => setTimeout(r, 400));");
      const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'pricing', 'items', 'batch-1.json'), 'utf8'));
      assert.deepEqual([saved.metal, saved.weight_grams, saved.method, saved.notes, saved.components.length, saved.confirmed], ['sterling', 4.2, 3, 'Bezel set', 2, null]);
      assert.match(await run("return document.querySelector('#pieces .row[data-id=batch-1] .prices .chosen small').textContent"), /unconfirmed/);
      // confirming writes the price into the file; a settings change then shows it has moved, until repriced
      await run("document.querySelector('#pieces .row[data-id=batch-1] [data-act=price]').click(); $('pieceConfirm').click(); await new Promise((r) => setTimeout(r, 400));");
      const confirmed = JSON.parse(fs.readFileSync(path.join(dataDir, 'pricing', 'items', 'batch-1.json'), 'utf8')).confirmed;
      assert.deepEqual([confirmed.method, confirmed.method_name, confirmed.pieces, confirmed.metal.name], [3, 'Tiered materials', 2, 'Sterling silver']);
      assert.match(await run("return document.querySelector('#pieces .row[data-id=batch-1] .prices .chosen').textContent"), new RegExp(`^Confirmed\\$${confirmed.price}$`));
      await run("await api('saveSettings', { spot: { silver: 64 } });");
      assert.match(await run("return document.querySelector('#pieces .row[data-id=batch-1] .prices .chosen small').textContent"), /Confirmed, now \$\d+/);
      await run("document.querySelector('#pieces .row[data-id=batch-1] [data-act=price]').click();");
      assert.match(await run("return $('confirmedNote').textContent"), /now come to \$\d+\. Press Confirm to reprice/);
      await shot('3a-moved');
      await run("$('pieceConfirm').click(); await new Promise((r) => setTimeout(r, 400)); await api('saveSettings', { spot: { silver: 32 } });");
      const repriced = JSON.parse(fs.readFileSync(path.join(dataDir, 'pricing', 'items', 'batch-1.json'), 'utf8')).confirmed;
      assert.ok(repriced.price > confirmed.price, 'repriced at the dearer silver');
      await run("document.querySelector('#pieces .row[data-id=batch-1] [data-act=price]').click(); $('pieceConfirm').click(); await new Promise((r) => setTimeout(r, 400));");
      assert.deepEqual(saved.components[1], { name: 'Jump rings', quantity: 4, unit_cost: 0.25 });
      assert.equal(fs.readdirSync(path.join(dataDir, 'items')).length, 5, "BenchClock's folder is untouched");
      assert.match(await run("return document.querySelector('#pieces .row[data-id=batch-1] .prices .chosen').textContent"), /^Confirmed\$/);
      await shot('3-main-priced');

      // a price set by hand wins; clearing starts over
      await run("document.querySelector('#pieces .row[data-id=batch-1] [data-act=price]').click(); $('pManual').value = '299'; updatePiece();");
      assert.equal(await run("return $('methodCards').classList.contains('overridden') && !$('byHandNote').hidden"), true);
      assert.match(await run("return $('byHandNote').textContent"), /Set by hand: \$299\.00 a piece\. Tiered materials would say/);
      await shot('3b-by-hand');
      await run("$('pieceConfirm').click(); await new Promise((r) => setTimeout(r, 400));");
      const byHand = JSON.parse(fs.readFileSync(path.join(dataDir, 'pricing', 'items', 'batch-1.json'), 'utf8'));
      assert.deepEqual([byHand.manual_price, byHand.confirmed.price, byHand.confirmed.method], [299, 299, 'by hand']);
      assert.match(await run("return document.querySelector('#pieces .row[data-id=batch-1] .prices .chosen').textContent"), /Confirmed\$299/);
      await run("document.querySelector('#pieces .row[data-id=hoops] [data-act=price]').click();");
      assert.equal(await run("return $('pieceClear').hidden"), true, 'nothing to clear on an unpriced line');
      await run("$('pieceCancel').click(); document.querySelector('#pieces .row[data-id=batch-1] [data-act=price]').click(); $('pieceClear').click(); await new Promise((r) => setTimeout(r, 200));");
      assert.equal(await run("return $('askDlg').open"), true);
      await run("$('askYes').click(); await new Promise((r) => setTimeout(r, 400));");
      assert.equal(fs.existsSync(path.join(dataDir, 'pricing', 'items', 'batch-1.json')), false, 'cleared');
      assert.match(await run("return document.querySelector('#pieces .row[data-id=batch-1] .prices').textContent"), /no weight or materials yet/);
      // price it again for the rest of the run
      await run(`document.querySelector('#pieces .row[data-id=batch-1] [data-act=price]').click();
                 $('pMetal').value = 'sterling'; $('pWeight').value = '4.2'; $('partAdd').click();
                 $('partRows').children[0].querySelector('[data-part=name]').value = 'Moonstone'; $('partRows').children[0].querySelector('[data-part=unit_cost]').value = '31';
                 updatePiece(); $('pieceConfirm').click(); await new Promise((r) => setTimeout(r, 400));`);

      // settings: a new rate and a silver price change every price
      const before = await run("return document.querySelector('#pieces .row[data-id=batch-1] .prices .m:nth-child(3)').textContent");
      await run("$('settingsBtn').click(); await new Promise((r) => setTimeout(r, 200));");
      assert.equal(await run("return $('settingsDlg').open && $('sRate').value"), '50');
      assert.equal(await run("return $('metalRows').children.length"), 9);
      await shot('4-settings');
      // live spot prices land in the fields to be looked over, saved only by Save; a failure is said beside the button
      spotDown = true;
      await run("$('spotFetch').click(); await new Promise((r) => setTimeout(r, 300));");
      assert.deepEqual(await run("return [$('spotNote').textContent, $('spotNote').classList.contains('bad'), $('sSilver').value, $('spotFetch').disabled]"),
        ["Couldn't reach gold-api.com for the spot prices. Is this computer online?", true, '32', false]);
      spotDown = false;
      await run("$('spotFetch').click(); await new Promise((r) => setTimeout(r, 300));");
      assert.deepEqual(await run("return [$('sSilver').value, $('sGold').value, $('sPlatinum').value, $('spotNote').classList.contains('bad')]"), ['61.1', '4179.1', '1719', false]);
      assert.match(await run("return $('spotNote').textContent"), /^From gold-api\.com, as of .+\. Press Save to price with them\.$/);
      assert.equal(await run("return $('metalRows').children[0].querySelector('[data-m=per_gram]').value"), '2.0896', 'the per-gram column follows: 61.1 / 31.1035 x .925 x 1.15');
      assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'pricing', 'settings.json'), 'utf8')).spot.silver, 32, 'nothing saved yet');
      assert.equal(await run("return $('sAutoSpot').checked"), false, 'fetching at startup is off until asked for');
      await run("$('sAutoSpot').click()");
      await shot('4b-fetched');
      await run("$('sRate').value = '60'; $('sSilver').value = '40'; $('sOverhead').value = '35'; $('sRound').value = '5'; document.querySelector('input[name=sMethod][value=\"1\"]').checked = true; document.querySelector('input[name=sRoundMode][value=nearest]').checked = true;");
      await run("document.querySelector('#settingsForm button[type=submit]').click(); await new Promise((r) => setTimeout(r, 400));");
      const settings = JSON.parse(fs.readFileSync(path.join(dataDir, 'pricing', 'settings.json'), 'utf8'));
      assert.deepEqual([settings.labor_rate, settings.spot.silver, settings.overhead_share, settings.default_method, settings.metals.length, settings.round_to, settings.round_mode], [60, 40, 0.35, 1, 9, 5, 'nearest']);
      assert.deepEqual([settings.spot.gold, settings.spot_fetched, settings.auto_spot], [4179.1, null, true], 'the silver was typed over, so the spot prices are no longer as fetched');
      assert.match(await run("return document.querySelector('#pieces .row[data-id=batch-1] .prices .chosen').textContent"), /\$\d+[05]$/, 'a multiple of $5');
      assert.match(await run("return $('strip').textContent"), /35% TimeOverhead.*set by hand; BenchClock says 30\.1%/);
      const after = await run("return document.querySelector('#pieces .row[data-id=batch-1] .prices .m:nth-child(3)').textContent");
      assert.notEqual(before, after, 'the method figures follow the settings');
      assert.match(await run("return document.querySelector('#pieces .row[data-id=batch-1] .prices .chosen small').textContent"), /Confirmed, now/, 'the confirmed price holds');
      assert.match(await run("return document.querySelector('#pieces .row[data-id=hoops] .prices').textContent"), /no weight or materials yet/);

      // the bench, ticks, and the report box: which pieces, which days, then a CSV or a PDF
      await run("$('showBench').checked = true; $('showBench').onchange(); await new Promise((r) => setTimeout(r, 300));");
      assert.equal(await run("return document.querySelectorAll('#pieces .row').length"), 3);
      await run("document.querySelector('#pieces .row[data-id=pendant] input').click(); document.querySelector('#pieces .row[data-id=batch-1] input').click();");
      await run("$('reportBtn').click(); await new Promise((r) => setTimeout(r, 300));");
      assert.deepEqual(await run("const ticked = document.querySelector('[data-scope=ticked]'); return [$('reportDlg').open, ticked.textContent, ticked.getAttribute('aria-pressed')]"),
        [true, 'Ticked (2)', 'true'], 'ticked lines are what the report is most likely wanted for');
      assert.match(await run("return $('reportSummary').textContent"), /^All time: 3 pieces in 2 sets or singles, 5h 45m of making, \$[\d.]+ of materials, \$[\d,]+ at their prices; 1 not priced yet\.$/);
      await shot('5a-report-box');
      await run("document.querySelector('[data-scope=finished]').click(); await new Promise((r) => setTimeout(r, 300));");
      assert.match(await run("return $('reportSummary').textContent"), /^All time: 6 pieces in 2 sets or singles, 6h 15m of making/);
      await run("$('repFrom').value = '2026-09-11'; $('repTo').value = '2026-09-12'; await updateReport();");
      assert.match(await run("return $('reportSummary').textContent"), /^Finished Fri, Sep 11, 2026 to Sat, Sep 12, 2026: 2 pieces in 1 set, 4h 15m of making/);
      await run("document.querySelector('[data-scope=bench]').click(); await new Promise((r) => setTimeout(r, 300));");
      assert.match(await run("return $('reportSummary').textContent"), /nothing to report\. A line is left out unless a piece of it was finished on these days/);
      assert.equal(await run("return $('reportSave').disabled && $('reportCsv').disabled"), true);
      await run("$('repFrom').value = '2026-09-13'; await updateReport();");
      assert.match(await run("return $('reportSummary').textContent"), /on or before/);
      await run("document.querySelector('[data-preset=all-time]').click(); await new Promise((r) => setTimeout(r, 300));");
      assert.match(await run("return $('reportSummary').textContent"), /^All time: 1 piece, 1h 30m of making/);
      await run("$('reportDlg').close();");
      assert.match(await run("try { await api('exportPreview', { from: 'soon' }); return 'accepted' } catch (e) { return e.message }"), /Couldn't understand the date/);
      const ticked = await run('return [...selected]');
      for (const [name, choice] of [['finished', {}], ['ticked', { scope: 'ticked', ids: ticked }], ['all', { scope: 'all' }], ['days', { from: '2026-09-11', to: '2026-09-12' }], ['none', { scope: 'bench', to: '2026-09-30' }]]) {
        const file = path.join(dataDir, `report-${name}.pdf`);
        await writeReportPdf(file, choice);
        const bytes = fs.readFileSync(file);
        assert.equal(bytes.subarray(0, 5).toString(), '%PDF-', `${name} report`);
        assert.ok(bytes.length > 5000, `the ${name} report has content`);
      }
      const { PriceBook } = require('../src/core/pricing.js');
      const csv = path.join(dataDir, 'sheet.csv');
      assert.equal(new PriceBook(dataDir).exportCsv(csv, await run('return [...selected]')), 2);
      const lines = fs.readFileSync(csv, 'utf8').trim().split('\r\n');
      assert.equal(lines.length, 3);
      assert.ok(lines.some((l) => l.startsWith('batch-1,Moonstone ring,ring,,finished,2026-09-12T15:00:00-04:00,2,moonstone-ring-a; moonstone-ring-b,')), lines.join('\n'));
      // finished by mistake: one of a set is picked from a list, a single piece is just asked about
      assert.equal(await run("return !!document.querySelector('#pieces .row[data-id=pendant] [data-act=back]')"), false, 'nothing to send back on the bench');
      await run("document.querySelector('#pieces .row[data-id=batch-1] [data-act=back]').click();");
      assert.deepEqual(await run("return [$('backDlg').open, $('backRows').children.length, $('backSave').disabled]"), [true, 2, true]);
      await run("$('backRows').querySelectorAll('input')[1].click();");
      await shot('5-send-back');
      await run("$('backSave').click(); await new Promise((r) => setTimeout(r, 400));");
      const ringB = JSON.parse(fs.readFileSync(path.join(dataDir, 'items', 'moonstone-ring-b.json'), 'utf8'));
      assert.deepEqual([ringB.status, ringB.finished_at, ringB.total_seconds], ['not_started', null, 6300]);
      assert.match(await run("return document.querySelector('#pieces .row[data-id=batch-1] .meta').textContent"), /a set: 1 of 2 finished, one price/);
      assert.equal(fs.existsSync(path.join(dataDir, 'pricing', 'items', 'batch-1.json')), true, 'the pricing is kept');
      await run("document.querySelector('#pieces .row[data-id=hoops] [data-act=back]').click(); await new Promise((r) => setTimeout(r, 200));");
      assert.match(await run("return $('askDlg').open && $('askTitle').textContent"), /Send Hoop earrings back to the bench\?/);
      await run("$('askYes').click(); await new Promise((r) => setTimeout(r, 400));");
      assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'items', 'hoops.json'), 'utf8')).status, 'not_started');
      assert.equal(await run("return !!document.querySelector('#pieces .row[data-id=hoops] [data-act=back]')"), false);
      // a set divided into groups priced apart: each ring a line of its own, starting from what the set had
      const pricedFile = (id) => path.join(dataDir, 'pricing', 'items', `${id}.json`);
      const splitSets = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'pricing', 'splits.json'), 'utf8')).sets;
      assert.equal(await run("return !!document.querySelector('#pieces .row[data-id=hoops] [data-act=groups]')"), false, 'one piece file: nothing to divide');
      await run("document.querySelector('#pieces .row[data-id=batch-1] [data-act=groups]').click();");
      assert.deepEqual(await run("return [$('groupsDlg').open, $('groupRows').children.length, $('groupRows').querySelectorAll('input:checked').length, $('groupsNote').textContent]"),
        [true, 2, 2, 'All on one letter: Moonstone ring is one set with one price.']);
      await run("$('groupRows').children[1].querySelector('input[value=B]').click();");
      assert.equal(await run("return $('groupsNote').textContent"), '2 groups, each priced on its own: A with 1 piece, B with 1 piece.');
      await shot('6-groups');
      await run("$('groupsSave').click(); await new Promise((r) => setTimeout(r, 200));");
      assert.match(await run("return $('askDlg').open && $('askText').textContent"), /^The confirmed price of \$\d+ for the set is dropped, to be confirmed again\.$/);
      await run("$('askYes').click(); await new Promise((r) => setTimeout(r, 400));");
      assert.deepEqual(splitSets(), { 'batch-1': { 'moonstone-ring-a': 'A', 'moonstone-ring-b': 'B' } });
      assert.deepEqual(await run("return [...document.querySelectorAll('#pieces .row b')].map((b) => b.textContent)"),
        ['Moonstone ring (group A)', 'Hoop earrings', 'Moonstone ring (group B)', 'Opal pendant']);
      assert.match(await run("return document.querySelector('#pieces .row[data-id=batch-1-A] .meta').textContent"), /piece 1 of the set, priced apart/);
      assert.equal(fs.existsSync(pricedFile('batch-1')), false, "the set's own line is gone");
      const groupA = JSON.parse(fs.readFileSync(pricedFile('batch-1-A'), 'utf8'));
      assert.deepEqual([groupA.metal, groupA.weight_grams, groupA.components[0].name, groupA.confirmed], ['sterling', 4.2, 'Moonstone', null]);
      assert.equal(await run("return $('selCount').textContent"), '1 ticked', 'the tick on the set went with it');
      await run("document.querySelector('#pieces .row[data-id=batch-1-B] [data-act=price]').click();");
      assert.match(await run("return $('pieceHint').textContent"), /^Group B, piece 2 of the set, priced apart from the others\. 1h 45m of making time/);
      await run("$('pWeight').value = '6'; updatePiece(); $('pieceConfirm').click(); await new Promise((r) => setTimeout(r, 400));");
      assert.deepEqual([JSON.parse(fs.readFileSync(pricedFile('batch-1-B'), 'utf8')).confirmed.weight_grams, JSON.parse(fs.readFileSync(pricedFile('batch-1-A'), 'utf8')).weight_grams], [6, 4.2]);
      await shot('7-groups-main');
      // back on one letter it is one set again; it asks first, as group B's pricing goes
      await run("document.querySelector('#pieces .row[data-id=batch-1-B] [data-act=groups]').click();");
      assert.equal(await run("return $('groupRows').querySelectorAll('input:checked')[1].value"), 'B');
      await run("$('groupRows').children[1].querySelector('input[value=A]').click(); $('groupsSave').click(); await new Promise((r) => setTimeout(r, 200));");
      assert.match(await run("return $('askDlg').open && $('askText').textContent"), /^What was entered for group B is forgotten\. The confirmed price of \$\d+ for group B is dropped, to be confirmed again\.$/);
      await run("$('askYes').click(); await new Promise((r) => setTimeout(r, 400));");
      assert.deepEqual([splitSets(), fs.existsSync(pricedFile('batch-1-A')), fs.existsSync(pricedFile('batch-1-B'))], [{}, false, false]);
      assert.equal(JSON.parse(fs.readFileSync(pricedFile('batch-1'), 'utf8')).weight_grams, 4.2);
      assert.match(await run("return document.querySelector('#pieces .row[data-id=batch-1] .meta').textContent"), /a set: 1 of 2 finished, one price/);
      // the help page shows the methods with the settings as they stand, its example worked by the same arithmetic
      win.webContents.send('menu', 'help');
      await pause(300);
      assert.equal(await run("return $('helpDlg').open"), true);
      const helpText = await run("return $('helpBody').textContent");
      for (const said of [/Method 1: Cost-plus/, /Method 2: Loaded hourly/, /Method 3: Tiered materials/, /set by hand in Settings at 35%; BenchClock measures 30\.1%/,
        /Labor: 2\.5 h × \$60\$150\.00/, /Metal: 5 g × \$1\.37\$6\.84/, /now to the nearest \$5/]) assert.match(helpText, said);
      const example = await run("const { p } = helpExample(state); return [1, 2, 3].map((m) => money(p.methods[m].price))");
      for (const figure of example) assert.ok(helpText.includes(`the price${figure}`), `${figure} is on the help page`);
      await shot('8-help');
      await run("$('helpBody').scrollTop = 1150;");
      await shot('8b-help-methods');
      await run("$('helpClose').click()");
      // the menu reaches the page, and is ignored while a box is open
      win.webContents.send('menu', 'about');
      await pause(300);
      assert.equal(await run("return $('aboutDlg').open"), true);
      win.webContents.send('menu', 'settings');
      win.webContents.send('menu', 'report');
      await pause(200);
      assert.equal(await run("return $('settingsDlg').open || $('reportDlg').open"), false);
      await run("$('aboutClose').click()");
      win.webContents.send('menu', 'report');
      await pause(300);
      assert.equal(await run("return $('reportDlg').open"), true);
      await run("$('reportDlg').close()");
      // spot prices at startup, as Settings now says: a failure leaves the saved ones, then the window is opened afresh and they are fetched
      const savedSettings = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'pricing', 'settings.json'), 'utf8'));
      spotDown = true;
      await run("await autoSpot()");
      assert.equal(await run("return $('toast').textContent"), "Couldn't reach gold-api.com for the spot prices. Is this computer online? The prices here use the spot prices saved last.");
      assert.equal(savedSettings().spot.silver, 40);
      spotDown = false;
      win.webContents.reload();
      await pause(1200);
      assert.deepEqual([savedSettings().spot, savedSettings().spot_fetched], [{ silver: 61.1, gold: 4179.1, platinum: 1719 }, { at: '2026-10-01T20:00:53.000Z', source: 'gold-api.com' }]);
      assert.equal(await run("return $('toast').textContent"), 'Spot prices from gold-api.com: $61.10 silver, $4,179.10 gold, $1,719.00 platinum.');
      assert.match(await run("return $('strip').textContent"), /\$61\.10 silver, \$4,179\.10 gold, \$1,719 platinum per troy oz, from gold-api\.com /);
      await shot('9-auto-spot');
      console.log('SMOKE OK');
    } catch (error) {
      console.error('SMOKE FAILED\n', error);
      process.exitCode = 1;
    }
    app.quit();
  });
});
// Fetch live prices is answered here, so the run depends on neither the internet nor today's prices.
const spot = require('../src/core/spot.js');
spot.fetchSpot = async () => {
  if (spotDown) throw new PricingError("Couldn't reach gold-api.com for the spot prices. Is this computer online?");
  return { spot: { silver: 61.1, gold: 4179.1, platinum: 1719 }, source: 'gold-api.com', at: '2026-10-01T20:00:53.000Z' };
};
const { writeReportPdf } = require('../src/main/main.js');
