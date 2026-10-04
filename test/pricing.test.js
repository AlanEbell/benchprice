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
  // without the premium it is the bare metal value; Rio Grande's $85 sterling at $64 spot is a 43.6% premium
  assert.equal(metalPerGram(sterling, { silver: 32 }, false), 0.9517);
  assert.equal(metalPerGram({ ...sterling, premium: 0.436 }, { silver: 64 }), 2.7332); // $85.01 an ounce
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
  // spot prices as fetched carry where and when from, until one is typed over; fetching at startup is off unless asked for
  assert.deepEqual([book.settings().auto_spot, book.settings().spot_fetched], [false, null]);
  book.saveSettings({ auto_spot: true, spot: { silver: 61.1, gold: 4179.1, platinum: 1719 }, spot_fetched: { at: '2026-10-01T20:00:53Z', source: 'gold-api.com' } });
  assert.deepEqual([book.settings().auto_spot, book.settings().spot_fetched], [true, { at: '2026-10-01T20:00:53.000Z', source: 'gold-api.com' }]);
  book.saveSettings({ labor_rate: 66, spot: { silver: 61.1, gold: 4179.1, platinum: 1719 } });
  assert.equal(book.settings().spot_fetched.source, 'gold-api.com', 'saved again unchanged: still as fetched');
  book.saveSettings({ spot: { gold: 4200 }, auto_spot: 'yes' });
  assert.deepEqual([book.settings().auto_spot, book.settings().spot_fetched, book.settings().labor_rate], [false, null, 66]);
  book.saveSettings({ labor_rate: 65, spot_fetched: { at: 'whenever', source: 'x' } });
  assert.equal(book.settings().spot_fetched, null);
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
  assert.deepEqual(book.getPricing('cuff-1'), { item_id: 'cuff-1', metal: null, weight_grams: 0, add_premium: true, components: [], method: null, manual_price: null, notes: '', confirmed: null });
});

test('the supplier premium can be left off a piece', () => {
  book.savePricing('hoops-1', { metal: 'sterling', weight_grams: 4.2 });
  const hoops = () => book.listGroups({ includeBench: true }).find((g) => g.id === 'hoops-1').priced;
  assert.deepEqual([hoops().metal_cost, hoops().metal.premium], [4.6, 0.15]);
  book.savePricing('hoops-1', { add_premium: false });
  assert.deepEqual([hoops().metal_cost, hoops().metal.premium, book.getPricing('hoops-1').add_premium], [4, 0, false]); // 4.2 g x 0.9517
  book.clearPricing('hoops-1');
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

test('a set divides into groups priced apart, and goes back to one', () => {
  const item = (extra) => ({
    schema_version: 1, sku: '', type: 'earrings', photo: null, quantity: 1, notes: '', created_at: '2026-09-01T09:00:00-04:00', name: 'Spiral earrings', batch_id: 'batch-e',
    started_at: '2026-09-01T09:00:00-04:00', status: 'finished', finished_at: '2026-09-20T10:00:00-04:00', split_from: null, time_entries: [], ...extra,
  });
  const write = (it) => fs.writeFileSync(path.join(dir, 'items', `${it.id}.json`), JSON.stringify(it));
  write(item({ id: 'e1', sequence: 20, total_seconds: 3600 }));
  write(item({ id: 'e2', sequence: 21, total_seconds: 3600 }));
  write(item({ id: 'e3', sequence: 22, total_seconds: 5400 }));
  write(item({ id: 'e4', sequence: 23, total_seconds: 1800, status: 'in_progress', finished_at: null }));
  write(item({ id: 'e5', sequence: 24, total_seconds: 900, type: 'custom' }));
  const priced = (id) => path.join(dir, 'pricing', 'items', `${id}.json`);
  const lines = () => book.listGroups({ includeBench: true }).filter((g) => g.of_set && g.of_set.id === 'batch-e');
  const line = (id) => lines().find((g) => g.id === id);

  // one set to start, priced and confirmed as one
  book.confirmPrice('batch-e', { metal: 'sterling', weight_grams: 3, components: [{ name: 'Garnet', quantity: 1, unit_cost: 12 }], notes: 'Garnets' });
  let whole = line('batch-e');
  assert.deepEqual([whole.group, whole.label, whole.of_set.pieces.map((i) => i.id).join(), whole.of_set.pieces[0].group], [null, 'Spiral earrings', 'e1,e2,e3,e4', null]);
  assert.deepEqual(whole.of_set.lines, [{ id: 'batch-e', label: 'Spiral earrings', group: null, entered: true, confirmed: whole.priced.price }]);
  assert.equal(book.listGroups().find((g) => g.id === 'moonstone-ring-1').of_set, null, 'a piece on its own has no groups');

  // two groups: each a line of its own, starting with what was entered for the set, unconfirmed
  assert.deepEqual(book.setGroups('batch-e', { e1: 'A', e2: 'a', e3: 'B', e4: 'B' }), { split: true, groups: ['A', 'B'] });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'pricing', 'splits.json'), 'utf8')).sets, { 'batch-e': { e1: 'A', e2: 'A', e3: 'B', e4: 'B' } });
  assert.deepEqual(lines().map((g) => [g.id, g.label, g.group, g.set, g.quantity, g.seconds_per_piece, g.status]), [
    ['batch-e-A', 'Spiral earrings (group A)', 'A', true, 2, 3600, 'finished'],
    ['batch-e-B', 'Spiral earrings (group B)', 'B', true, 2, 5400, 'part_finished'], // its own finished piece, not the set's average
  ]);
  assert.deepEqual(book.listGroups().filter((g) => g.name === 'Spiral earrings').map((g) => g.id), ['e5', 'batch-e-A', 'batch-e-B'], 'the custom piece still alone; group A before group B');
  for (const id of ['batch-e-A', 'batch-e-B']) {
    const p = book.getPricing(id);
    assert.deepEqual([p.item_id, p.metal, p.weight_grams, p.components.length, p.notes, p.confirmed], [id, 'sterling', 3, 1, 'Garnets', null]);
  }
  assert.equal(fs.existsSync(priced('batch-e')), false, "the set's own line is gone");
  assert.deepEqual(line('batch-e-A').of_set.pieces.map((i) => [i.group, i.line]), [['A', 'batch-e-A'], ['A', 'batch-e-A'], ['B', 'batch-e-B'], ['B', 'batch-e-B']]);

  // priced apart
  const b = book.confirmPrice('batch-e-B', { components: [{ name: 'Sapphire', quantity: 1, unit_cost: 60 }], notes: 'Sapphires' });
  assert.ok(b.price > line('batch-e-A').priced.price);
  assert.deepEqual([line('batch-e-A').pricing.notes, line('batch-e-A').priced.confirmed, b.pieces], ['Garnets', null, 2]);
  assert.deepEqual(line('batch-e-A').of_set.lines.map((l) => [l.group, l.entered, l.confirmed]), [['A', true, null], ['B', true, b.price]]);

  // a piece moved to a new group takes a copy of what its old group had; a group it only leaves keeps its confirmed price
  book.setGroups('batch-e', { e1: 'A', e2: 'A', e3: 'B', e4: 'C' });
  const c = line('batch-e-C');
  assert.deepEqual([c.set, c.label, c.pricing.notes, c.pricing.confirmed, c.seconds_per_piece, c.status], [false, 'Spiral earrings (group C)', 'Sapphires', null, 1800, 'in_progress']);
  assert.deepEqual([line('batch-e-B').pricing.confirmed.price, line('batch-e-B').set], [b.price, false]);
  const out = path.join(dir, 'groups.csv');
  assert.equal(book.exportCsv(out), 4, 'every finished line: the ring, groups A and B, the custom piece');
  const rows = fs.readFileSync(out, 'utf8').trim().split('\r\n').map((row) => row.split(','));
  const row = rows.find((r) => r[0] === 'batch-e-A');
  assert.deepEqual([row[1], row[rows[0].indexOf('quantity')], row[rows[0].indexOf('piece_ids')]], ['Spiral earrings (group A)', '2', 'e1; e2']);
  assert.deepEqual(book.sendBack(['e3']), [{ id: 'e3', name: 'Spiral earrings' }]);
  assert.equal(line('batch-e-B').status, 'not_started');

  // a group left with no pieces is forgotten
  book.setGroups('batch-e', { e1: 'A', e2: 'A', e3: 'C', e4: 'C' });
  assert.deepEqual(lines().map((g) => g.id), ['batch-e-A', 'batch-e-C']);
  assert.equal(fs.existsSync(priced('batch-e-B')), false);
  // a piece added to the set since goes in the first group
  write(item({ id: 'e6', sequence: 25, total_seconds: 3600 }));
  assert.deepEqual(line('batch-e-A').pieces.map((i) => i.id), ['e1', 'e2', 'e6']);
  assert.throws(() => book.setGroups('batch-e', { e1: 'A', e2: 'A', e3: 'C', e4: 'C' }), /Spiral earrings \(6 of 6\) needs a group/);

  // refused changes save nothing
  for (const bad of [{ e1: 'A', e2: 'A', e3: 'B' }, { e1: 'A', e2: 'A', e3: 'B', e4: '1', e6: 'A' }, { e1: 'A', e2: 'A', e3: 'B', e4: 'AB', e6: 'A' },
    { e1: 'A', e2: 'A', e3: 'B', e4: 'B', e6: 'A', e5: 'A' }]) {
    assert.throws(() => book.setGroups('batch-e', bad), PricingError);
  }
  for (const bad of ['moonstone-ring-1', 'batch-nobody', '../settings', 'e5']) assert.throws(() => book.setGroups(bad, { e1: 'A' }), /Only a set of two or more/);
  assert.deepEqual(lines().map((g) => g.id), ['batch-e-A', 'batch-e-C']);

  // all on one letter: one set with one price again, starting from what its first piece's group had
  book.confirmPrice('batch-e-A', {});
  assert.deepEqual(book.setGroups('batch-e', { e1: 'B', e2: 'B', e3: 'B', e4: 'B', e6: 'B' }), { split: false, groups: ['B'] });
  whole = line('batch-e');
  assert.deepEqual([lines().length, whole.group, whole.label, whole.quantity, whole.pricing.notes, whole.pricing.confirmed], [1, null, 'Spiral earrings', 5, 'Garnets', null]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'pricing', 'splits.json'), 'utf8')).sets, {});
  assert.deepEqual(fs.readdirSync(path.join(dir, 'pricing', 'items')), ['batch-e.json']);
  assert.deepEqual(book.setGroups('batch-e', Object.fromEntries(whole.of_set.pieces.map((i) => [i.id, 'A']))), { split: false, groups: ['A'] }, 'no change is fine');
  assert.equal(line('batch-e').pricing.notes, 'Garnets');
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

test('a piece finished by mistake goes back to the bench, and keeps its pricing', () => {
  book.confirmPrice('moonstone-ring-1', { metal: 'sterling', weight_grams: 4.2 });
  const file = path.join(dir, 'items', 'moonstone-ring-1.json');
  const before = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...before, time_entries: [{ session_id: 'a', seconds: 9000 }], kept: 'as it was' }));
  assert.deepEqual(book.sendBack(['moonstone-ring-1']), [{ id: 'moonstone-ring-1', name: 'Moonstone ring' }]);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual([after.status, after.finished_at, after.total_seconds, after.kept], ['in_progress', null, 9000, 'as it was']);
  assert.deepEqual(book.listGroups().map((g) => g.id), []); // nothing finished any more
  const [ring] = book.listGroups({ includeBench: true }).filter((g) => g.id === 'moonstone-ring-1');
  assert.equal(ring.pricing.confirmed.price, ring.priced.price); // still priced

  assert.deepEqual(book.sendBack(['hoops-1']), []); // wasn't finished: left alone
  for (const bad of [[], ['time-overhead'], ['../settings'], ['nobody-1']]) assert.throws(() => book.sendBack(bad), PricingError);
});

test('a piece with no time on it goes back as not started', () => {
  const file = path.join(dir, 'items', 'cuff-1.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), status: 'finished', finished_at: '2026-09-11T10:00:00-04:00' }));
  book.sendBack(['cuff-1']);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).status, 'not_started');
});

test('a piece made without the clock is added finished, as BenchClock would write it', () => {
  const added = book.addPiece({ name: ' Old stock ring ', type: 'ring', hours: 1.5, finished_on: '2026-03-02', sku: 'R-9', notes: 'from the case' });
  assert.equal(added.items.length, 1);
  assert.equal(added.id, added.items[0].id); // one piece is priced under its own id
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'items', `${added.id}.json`), 'utf8'));
  assert.match(file.id, /^old-stock-ring-[0-9a-f]{8}$/);
  assert.deepEqual([file.name, file.type, file.sku, file.notes, file.status, file.batch_id, file.quantity, file.origin],
    ['Old stock ring', 'ring', 'R-9', 'from the case', 'finished', null, 1, 'benchprice']);
  assert.equal(file.sequence, 4); // after BenchClock's own three
  assert.match(file.finished_at, /^2026-03-02T12:00:00[+-]\d\d:\d\d$/);
  assert.equal(file.started_at, file.finished_at);
  assert.deepEqual([file.total_seconds, file.seconds_per_piece], [5400, 5400]);
  const [entry] = file.time_entries;
  assert.deepEqual([entry.kind, entry.percent, entry.seconds, entry.clock_in, entry.clock_out], ['adjustment', 100, 5400, file.finished_at, file.finished_at]);
  assert.match(entry.session_id, /^adjust-[0-9a-f]{8}$/);

  // it is on the finished list and prices like any other piece: 1.5 h at $50
  const line = book.listGroups().find((g) => g.id === added.id);
  assert.deepEqual([line.status, line.quantity, line.priced.hours, line.priced.labor], ['finished', 1, 1.5, 75]);
  book.confirmPrice(added.id, { metal: 'sterling', weight_grams: 6 });
  assert.ok(book.listGroups().find((g) => g.id === added.id).pricing.confirmed.price > 0);
  // and it can go back to the bench like one of BenchClock's own
  assert.deepEqual(book.sendBack([added.id]), [{ id: added.id, name: 'Old stock ring' }]);
});

test('several added together are a set with one price, each with the hours given', () => {
  const added = book.addPiece({ name: 'Studs', type: 'earrings', quantity: 3, hours: 0.5 });
  assert.match(added.id, /^batch-[0-9a-f]{8}$/);
  assert.equal(added.items.length, 3);
  const files = added.items.map((i) => JSON.parse(fs.readFileSync(path.join(dir, 'items', `${i.id}.json`), 'utf8')));
  assert.deepEqual(files.map((f) => [f.batch_id, f.quantity, f.total_seconds, f.sequence]), [[added.id, 1, 1800, 4], [added.id, 1, 1800, 5], [added.id, 1, 1800, 6]]);
  assert.equal(new Set(files.map((f) => f.time_entries[0].session_id)).size, 1); // one entry of time, on each
  assert.equal(files[0].finished_at.slice(0, 10), new Date().toLocaleDateString('sv')); // today, when no day is given
  const line = book.listGroups().find((g) => g.id === added.id);
  assert.deepEqual([line.set, line.quantity, line.finished, line.seconds_per_piece, line.label], [true, 3, 3, 1800, 'Studs']);
});

test('a piece can be added with no time, and bad entries add nothing', () => {
  const added = book.addPiece({ name: 'Found in a drawer' });
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'items', `${added.id}.json`), 'utf8'));
  assert.deepEqual([file.time_entries, file.total_seconds, file.started_at, file.status], [[], 0, null, 'finished']);
  const before = fs.readdirSync(path.join(dir, 'items')).length;
  for (const bad of [{}, { name: '  ' }, { name: 'x', quantity: 0 }, { name: 'x', quantity: 1.5 }, { name: 'x', type: 'overhead' }, { name: 'x', hours: -1 },
    { name: 'x', hours: 'lots' }, { name: 'x', finished_on: 'yesterday' }, { name: 'x', finished_on: '2999-01-01' }]) {
    assert.throws(() => book.addPiece(bad), PricingError);
  }
  assert.equal(fs.readdirSync(path.join(dir, 'items')).length, before);
});

test('a piece can be added before BenchClock has ever run', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'benchprice-'));
  try {
    const alone = new PriceBook(empty);
    const added = alone.addPiece({ name: 'First', hours: 1 });
    assert.deepEqual(alone.listGroups().map((g) => g.id), [added.id]);
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});
