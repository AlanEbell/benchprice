'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, beforeEach, afterEach } = require('node:test');

const { PriceBook, PricingError, price, metalPerGram, roundTo, DEFAULT_SETTINGS } = require('../src/core/pricing.js');

let dir, book;

/** A BenchClock data folder with the moonstone ring from the pricing talk: 2h 30m of making, 30% TimeOverhead. */
function writeBenchClock(folder) {
  fs.mkdirSync(path.join(folder, 'items'), { recursive: true });
  const item = (extra) => ({
    schema_version: 1, sequence: 1, sku: '', type: 'ring', photo: null, batch_id: null, quantity: 1, notes: '',
    created_at: '2026-09-01T09:00:00-04:00', started_at: '2026-09-01T09:00:00-04:00', finished_at: null, split_from: null, time_entries: [], ...extra,
  });
  const ring = item({ id: 'moonstone-ring-1', name: 'Moonstone ring', status: 'finished', finished_at: '2026-09-10T15:00:00-04:00', total_seconds: 9000, seconds_per_piece: 9000 });
  const hoops = item({ id: 'hoops-1', name: 'Hoops', type: 'earrings', status: 'in_progress', quantity: 4, total_seconds: 7200, seconds_per_piece: 1800, sequence: 2 });
  const untouched = item({ id: 'cuff-1', name: 'Cuff', type: 'cuff', status: 'not_started', total_seconds: 0, seconds_per_piece: 0, sequence: 3 });
  // 16200 s of making; 30% overhead means 16200 * 0.3 / 0.7
  const overhead = item({ id: 'time-overhead', name: 'TimeOverhead', type: 'overhead', status: 'overhead', total_seconds: 6942.9, seconds_per_piece: 6942.9, sequence: 0 });
  for (const it of [ring, hoops, untouched, overhead]) fs.writeFileSync(path.join(folder, 'items', `${it.id}.json`), JSON.stringify(it));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchprice-'));
  writeBenchClock(dir);
  book = new PriceBook(dir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test('metal price per gram comes from spot, purity and premium', () => {
  const sterling = DEFAULT_SETTINGS.metals.find((m) => m.id === 'sterling');
  // $32 an ounce -> $1.0288 a gram fine, x .925 x 1.15
  assert.equal(metalPerGram(sterling, { silver: 32 }), 1.0944);
  assert.equal(metalPerGram({ id: 'x', name: 'x', base: null, per_gram: 2.5 }, {}), 2.5);
  assert.equal(metalPerGram(null, {}), 0);
  assert.equal(roundTo(273.14, 1), 274);
  assert.equal(roundTo(273.14, 5), 275);
  assert.equal(roundTo(273.14, 0), 273.14);
  assert.equal(roundTo(273.14, 5, 'nearest'), 275);
  assert.equal(roundTo(272.49, 5, 'nearest'), 270);
  assert.equal(roundTo(279.99, 5, 'down'), 275);
  assert.equal(roundTo(280, 5, 'down'), 280);
  assert.equal(roundTo(280, 5, 'up'), 280);
});

test('the three methods on the moonstone ring', () => {
  // $40 of materials as in the worked example: metal that comes to $10 and a $30 stone.
  const settings = { ...DEFAULT_SETTINGS, metals: [{ id: 'm', name: 'Metal', base: null, per_gram: 2 }], round_to: 0 };
  const item = { seconds_per_piece: 9000 };
  const pricing = { metal: 'm', weight_grams: 5, components: [{ name: 'Moonstone', quantity: 1, unit_cost: 30 }] };
  const p = price(item, pricing, settings, 0.3);
  assert.deepEqual([p.hours, p.labor, p.metal_cost, p.components_cost, p.materials], [2.5, 125, 10, 30, 40]);
  assert.deepEqual([p.methods[1].cost, p.methods[1].price], [165, 330]);
  assert.equal(p.methods[2].loaded_rate, 71.43);
  assert.deepEqual([p.methods[2].labor, p.methods[2].cost, p.methods[2].price], [178.58, 218.58, 273.23]);
  // tiered: metal $10 at 3x (up to $10), stone $30 at 2x, + labor 125 + studio 2.5 * 15
  assert.deepEqual(p.methods[3].lines.map((l) => [l.name, l.factor, l.marked]), [['Metal', 3, 30], ['Moonstone', 2, 60]]);
  assert.deepEqual([p.methods[3].studio, p.methods[3].cost, p.methods[3].price], [37.5, 252.5, 297.06]);
  assert.deepEqual([p.method, p.price], [2, 273.23]);
  assert.equal(price(item, { ...pricing, method: 3 }, settings, 0.3).price, 297.06);
  assert.equal(price(item, pricing, { ...settings, default_method: 1 }, 0.3).price, 330);
  // fees and rounding come last
  const fees = price(item, pricing, { ...settings, fees: 0.06, round_to: 5 }, 0.3);
  assert.deepEqual([fees.methods[2].with_fees, fees.methods[2].price], [290.66, 295]);
  assert.equal(price(item, pricing, { ...settings, fees: 0.06, round_to: 5, round_mode: 'down' }, 0.3).methods[2].price, 290);
  assert.equal(price(item, pricing, { ...settings, fees: 0.06, round_to: 5, round_mode: 'nearest' }, 0.3).methods[2].price, 290);
  assert.equal(price(item, {}, settings, 0.3).complete, false);
  // a price set by hand wins, and the methods are still there to compare
  const hand = price(item, { ...pricing, manual_price: '299.5' }, settings, 0.3);
  assert.deepEqual([hand.by_hand, hand.price, hand.methods[2].price, hand.complete], [true, 299.5, 273.23, true]);
  assert.equal(price(item, { manual_price: 120 }, settings, 0.3).complete, true, 'a hand price alone is a complete price');
  assert.equal(price(item, { ...pricing, manual_price: '' }, settings, 0.3).by_hand, false);
});

test('the TimeOverhead share is measured from BenchClock unless overridden', () => {
  assert.equal(book.measuredOverheadShare(), 0.3);
  assert.equal(book.overheadShare(), 0.3);
  book.saveSettings({ overhead_share: 0.4 });
  assert.equal(book.overheadShare(), 0.4);
  book.saveSettings({ overhead_share: null });
  assert.equal(book.overheadShare(), 0.3);
});

test('settings are checked and keep their defaults for anything not saved', () => {
  assert.equal(book.settings().labor_rate, 50);
  book.saveSettings({ labor_rate: '65', spot: { silver: 30 }, loaded: { margin: 0.25 } });
  const s = book.settings();
  assert.deepEqual([s.labor_rate, s.spot.silver, s.spot.gold, s.loaded.margin, s.default_method], [65, 30, 2400, 0.25, 2]);
  for (const bad of [{ labor_rate: 'lots' }, { labor_rate: -1 }, { default_method: 4 }, { loaded: { margin: 1 } }, { metals: [] },
    { metals: [{ name: 'Gold', base: 'lead', purity: 0.5 }] }, { fees: 2 }, { round_mode: 'sideways' }]) {
    assert.throws(() => book.saveSettings(bad), PricingError);
  }
  assert.equal(book.settings().labor_rate, 65, 'a refused change saves nothing');
  book.saveSettings({ metals: [{ name: 'Argentium', base: 'silver', purity: 0.935, premium: 0.2 }, { name: 'Titanium', per_gram: 0.3 }] });
  assert.deepEqual(book.settings().metals.map((m) => m.id), ['argentium', 'titanium']);
  book.saveSettings({ round_to: 5, round_mode: 'nearest' });
  assert.deepEqual([book.settings().round_to, book.settings().round_mode], [5, 'nearest']);
  book.saveSettings({ tiered: { tiers: [{ up_to: 50, factor: 2.5 }, { up_to: 5, factor: 3 }] } });
  assert.deepEqual(book.settings().tiered.tiers, [{ up_to: 5, factor: 3 }, { up_to: 50, factor: 2.5 }, { up_to: null, factor: 2.5 }]);
});

test('pricing a piece is saved beside BenchClock without touching its files', () => {
  const before = fs.readFileSync(path.join(dir, 'items', 'moonstone-ring-1.json'), 'utf8');
  book.savePricing('moonstone-ring-1', {
    metal: 'sterling', weight_grams: '4.2', method: '',
    components: [{ name: 'Moonstone 8mm', quantity: 1, unit_cost: 30 }, { name: '', quantity: 0, unit_cost: 0 }, { name: 'Jump rings', quantity: 4, unit_cost: 0.25 }],
    notes: 'Bezel set',
  });
  assert.equal(fs.readFileSync(path.join(dir, 'items', 'moonstone-ring-1.json'), 'utf8'), before);
  assert.ok(fs.existsSync(path.join(dir, 'pricing', 'items', 'moonstone-ring-1.json')));
  const saved = book.getPricing('moonstone-ring-1');
  assert.deepEqual([saved.metal, saved.weight_grams, saved.method, saved.components.length, saved.notes], ['sterling', 4.2, null, 2, 'Bezel set']);
  assert.throws(() => book.savePricing('moonstone-ring-1', { metal: 'unobtainium' }), PricingError);
  assert.throws(() => book.savePricing('moonstone-ring-1', { weight_grams: -1 }), PricingError);
  assert.throws(() => book.savePricing('../settings', {}), PricingError);
  assert.throws(() => book.savePricing('moonstone-ring-1', { manual_price: -5 }), PricingError);
  book.savePricing('moonstone-ring-1', { manual_price: '310' });
  assert.equal(book.getPricing('moonstone-ring-1').manual_price, 310);
  assert.deepEqual([book.listGroups()[0].priced.by_hand, book.listGroups()[0].priced.price], [true, 310]);
  book.savePricing('moonstone-ring-1', { manual_price: null });
  assert.equal(book.listGroups()[0].priced.by_hand, false);
  book.clearPricing('moonstone-ring-1');
  assert.equal(fs.existsSync(path.join(dir, 'pricing', 'items', 'moonstone-ring-1.json')), false);
  assert.equal(book.listGroups()[0].priced.complete, false, 'cleared: back to the start');
  book.clearPricing('moonstone-ring-1'); // clearing twice is fine
  assert.deepEqual(book.getPricing('cuff-1'), { item_id: 'cuff-1', metal: null, weight_grams: 0, components: [], method: null, manual_price: null, notes: '', confirmed: null });
});

test('the list is finished pieces first with prices, and the bench on request', () => {
  book.savePricing('moonstone-ring-1', { metal: 'sterling', weight_grams: 4.2, components: [{ name: 'Moonstone', quantity: 1, unit_cost: 30 }] });
  const finished = book.listGroups();
  assert.deepEqual(finished.map((p) => p.label), ['Moonstone ring']);
  assert.equal(finished[0].priced.metal_cost, 4.6); // 4.2 g x 1.0944
  assert.ok(finished[0].priced.price > 250);
  assert.equal(finished[0].set, false);
  const all = book.listGroups({ includeBench: true });
  assert.deepEqual(all.map((p) => p.label), ['Moonstone ring', 'Cuff', 'Hoops']);
  const hoops = all.find((p) => p.id === 'hoops-1');
  assert.deepEqual([hoops.priced.hours, hoops.set, hoops.quantity], [0.5, true, 4], 'an old-style batch entry is priced per piece');
  assert.equal(hoops.priced.complete, false);
});

test('pieces added together are one set with one price; custom pieces stand alone', () => {
  const item = (extra) => ({
    schema_version: 1, sku: '', type: 'ring', photo: null, quantity: 1, notes: '', created_at: '2026-09-01T09:00:00-04:00',
    started_at: '2026-09-01T09:00:00-04:00', finished_at: null, split_from: null, time_entries: [], ...extra,
  });
  const write = (it) => fs.writeFileSync(path.join(dir, 'items', `${it.id}.json`), JSON.stringify(it));
  write(item({ id: 'band-a', sequence: 10, name: 'Band', batch_id: 'batch-x', status: 'finished', finished_at: '2026-09-11T10:00:00-04:00', total_seconds: 3600, seconds_per_piece: 3600 }));
  write(item({ id: 'band-b', sequence: 11, name: 'Band', batch_id: 'batch-x', status: 'finished', finished_at: '2026-09-13T10:00:00-04:00', total_seconds: 5400, seconds_per_piece: 5400 }));
  write(item({ id: 'band-c', sequence: 12, name: 'Band', batch_id: 'batch-x', status: 'in_progress', total_seconds: 600, seconds_per_piece: 600 }));
  write(item({ id: 'band-d', sequence: 13, name: 'Band', batch_id: 'batch-x', type: 'custom', status: 'finished', finished_at: '2026-09-13T12:00:00-04:00', total_seconds: 9000, seconds_per_piece: 9000 }));
  const groups = book.listGroups();
  const set = groups.find((g) => g.id === 'batch-x');
  assert.ok(set, 'the set is filed under its batch id');
  assert.deepEqual([set.set, set.quantity, set.finished, set.status, set.finished_at], [true, 3, 2, 'part_finished', '2026-09-13T10:00:00-04:00']);
  assert.equal(set.seconds_per_piece, 4500, 'the average over the finished pieces; the one on the bench does not drag it down');
  assert.deepEqual(set.pieces.map((i) => i.id), ['band-a', 'band-b', 'band-c']);
  const custom = groups.find((g) => g.id === 'band-d');
  assert.deepEqual([custom.set, custom.seconds_per_piece], [false, 9000], 'a custom piece is priced on its own');
  book.savePricing('batch-x', { metal: 'sterling', weight_grams: 3 });
  assert.ok(fs.existsSync(path.join(dir, 'pricing', 'items', 'batch-x.json')));
  const priced = book.listGroups().find((g) => g.id === 'batch-x');
  assert.equal(priced.priced.hours, 1.25);
  assert.ok(priced.priced.complete);
  // a set priced piece by piece before sets existed keeps that pricing until the set is saved
  fs.rmSync(path.join(dir, 'pricing', 'items', 'batch-x.json'));
  book.savePricing('band-b', { metal: 'gold-14k', weight_grams: 2 });
  assert.equal(book.listGroups().find((g) => g.id === 'batch-x').pricing.metal, 'gold-14k');
  const out = path.join(dir, 'sets.csv');
  book.exportCsv(out, ['batch-x']);
  const [header, row] = fs.readFileSync(out, 'utf8').trim().split('\r\n').map((line) => line.split(','));
  assert.equal(row[header.indexOf('quantity')], '3');
  assert.equal(row[header.indexOf('piece_ids')], 'band-a; band-b; band-c');
});

test('confirming writes the price into the file, and it holds until repriced', () => {
  assert.throws(() => book.confirmPrice('moonstone-ring-1', {}), /before confirming/);
  const done = book.confirmPrice('moonstone-ring-1', { metal: 'sterling', weight_grams: 4.2, components: [{ name: 'Moonstone', quantity: 1, unit_cost: 30 }] });
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'pricing', 'items', 'moonstone-ring-1.json'), 'utf8'));
  assert.equal(file.confirmed.price, done.price);
  assert.deepEqual([file.confirmed.method, file.confirmed.method_name, file.confirmed.hours, file.confirmed.materials, file.confirmed.metal.name, file.confirmed.spot.silver],
    [2, 'Loaded hourly', 2.5, 34.6, 'Sterling silver', 32]);
  assert.match(file.confirmed.at, /^\d{4}-\d\d-\d\dT/);
  let [ring] = book.listGroups();
  assert.deepEqual([ring.priced.price, ring.priced.moved, ring.priced.confirmed.price], [done.price, false, done.price]);
  // the silver price doubles: the confirmed price stands, the live one moves
  book.saveSettings({ spot: { silver: 64 } });
  [ring] = book.listGroups();
  assert.equal(ring.priced.price, done.price, 'confirmed price holds');
  assert.ok(ring.priced.live_price > done.price);
  assert.equal(ring.priced.moved, true);
  const out = path.join(dir, 'confirmed.csv');
  book.exportCsv(out);
  const [header, row] = fs.readFileSync(out, 'utf8').trim().split('\r\n').map((line) => line.split(','));
  assert.equal(row[header.indexOf('price')], String(done.price));
  assert.equal(row[header.indexOf('price_now')], String(ring.priced.live_price));
  assert.ok(row[header.indexOf('confirmed_at')].startsWith(file.confirmed.at.slice(0, 10)));
  // repricing replaces it; a hand price can be confirmed too; clearing forgets it
  const again = book.confirmPrice('moonstone-ring-1', {});
  assert.equal(again.price, ring.priced.live_price);
  assert.equal(book.listGroups()[0].priced.moved, false);
  const hand = book.confirmPrice('moonstone-ring-1', { manual_price: 350 });
  assert.deepEqual([hand.price, hand.method, hand.method_price > 0], [350, 'by hand', true]);
  book.clearPricing('moonstone-ring-1');
  assert.equal(book.listGroups()[0].priced.confirmed, null);
});

test('a folder without BenchClock in it is empty, not an error', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'benchprice-empty-'));
  try {
    const lonely = new PriceBook(empty);
    assert.equal(lonely.hasBenchClock(), false);
    assert.deepEqual(lonely.listGroups(), []);
    assert.equal(lonely.measuredOverheadShare(), 0);
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});

test('CSV price sheet', () => {
  book.savePricing('moonstone-ring-1', { metal: 'sterling', weight_grams: 4.2, components: [{ name: 'Moonstone, "AAA"', quantity: 1, unit_cost: 30 }] });
  const out = path.join(dir, 'prices.csv');
  assert.equal(book.exportCsv(out), 1);
  const [header, row] = fs.readFileSync(out, 'utf8').trim().split('\r\n');
  assert.ok(header.startsWith('item_id,name,type,sku,status,finished_at,quantity,piece_ids,hours_per_piece,metal,weight_grams'));
  assert.ok(row.startsWith('moonstone-ring-1,Moonstone ring,ring,,finished,2026-09-10T15:00:00-04:00,1,moonstone-ring-1,2.5,Sterling silver,4.2,4.6,'));
  assert.ok(row.includes('"1 x Moonstone, ""AAA"" @ 30"'));
  assert.equal(book.exportCsv(out, ['hoops-1', 'moonstone-ring-1']), 2, 'chosen pieces can be on the bench');
});
