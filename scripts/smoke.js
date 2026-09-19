'use strict';
// Developer tool: drives the real app through its real window-to-main bridge on a throwaway
// data folder, checks what lands on disk, and saves screenshots of each screen beside it.
//   npx electron scripts/smoke.js --data-dir=/tmp/x
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

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

app.on('browser-window-created', (event, win) => {
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
      assert.match(await run("return $('breakdown').textContent"), /4\.2 g of Sterling silver at \$1\.09\/g/);
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
      await run("$('sRate').value = '60'; $('sSilver').value = '40'; $('sOverhead').value = '35'; $('sRound').value = '5'; document.querySelector('input[name=sMethod][value=\"1\"]').checked = true; document.querySelector('input[name=sRoundMode][value=nearest]').checked = true;");
      await run("document.querySelector('#settingsForm button[type=submit]').click(); await new Promise((r) => setTimeout(r, 400));");
      const settings = JSON.parse(fs.readFileSync(path.join(dataDir, 'pricing', 'settings.json'), 'utf8'));
      assert.deepEqual([settings.labor_rate, settings.spot.silver, settings.overhead_share, settings.default_method, settings.metals.length, settings.round_to, settings.round_mode], [60, 40, 0.35, 1, 9, 5, 'nearest']);
      assert.match(await run("return document.querySelector('#pieces .row[data-id=batch-1] .prices .chosen').textContent"), /\$\d+[05]$/, 'a multiple of $5');
      assert.match(await run("return $('strip').textContent"), /35% TimeOverhead.*set by hand; BenchClock says 30\.1%/);
      const after = await run("return document.querySelector('#pieces .row[data-id=batch-1] .prices .m:nth-child(3)').textContent");
      assert.notEqual(before, after, 'the method figures follow the settings');
      assert.match(await run("return document.querySelector('#pieces .row[data-id=batch-1] .prices .chosen small').textContent"), /Confirmed, now/, 'the confirmed price holds');
      assert.match(await run("return document.querySelector('#pieces .row[data-id=hoops] .prices').textContent"), /no weight or materials yet/);

      // the bench, ticks, and the price sheet
      await run("$('showBench').checked = true; $('showBench').onchange(); await new Promise((r) => setTimeout(r, 300));");
      assert.equal(await run("return document.querySelectorAll('#pieces .row').length"), 3);
      await run("document.querySelector('#pieces .row[data-id=pendant] input').click(); document.querySelector('#pieces .row[data-id=batch-1] input').click();");
      assert.equal(await run("return $('exportBtn').textContent"), 'Save price sheet (2)');
      const { PriceBook } = require('../src/core/pricing.js');
      const csv = path.join(dataDir, 'sheet.csv');
      assert.equal(new PriceBook(dataDir).exportCsv(csv, await run('return [...selected]')), 2);
      const lines = fs.readFileSync(csv, 'utf8').trim().split('\r\n');
      assert.equal(lines.length, 3);
      assert.ok(lines.some((l) => l.startsWith('batch-1,Moonstone ring,ring,,finished,2026-09-12T15:00:00-04:00,2,moonstone-ring-a; moonstone-ring-b,')), lines.join('\n'));
      // the menu reaches the page, and is ignored while a box is open
      win.webContents.send('menu', 'about');
      await pause(300);
      assert.equal(await run("return $('aboutDlg').open"), true);
      win.webContents.send('menu', 'settings');
      await pause(200);
      assert.equal(await run("return $('settingsDlg').open"), false);
      console.log('SMOKE OK');
    } catch (error) {
      console.error('SMOKE FAILED\n', error);
      process.exitCode = 1;
    }
    app.quit();
  });
});
require('../src/main/main.js');
