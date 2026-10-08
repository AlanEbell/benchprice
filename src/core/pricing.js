'use strict';
/*
 * BenchPrice: the pricing arithmetic and the files behind it. No interface here.
 *
 * BenchClock's data folder is read: pieces and their time come from items/<id>.json.
 * Two things are written there, each as BenchClock itself would write it: a piece sent
 * back to the bench (see sendBack), which does what BenchClock's own Reopen does, and a
 * piece made without the clock (see addPiece), added already finished with its time put
 * on by hand. Everything else BenchPrice adds lives in its own folder inside it:
 *
 *   <data dir>/pricing/settings.json     labor rate, spot prices, metals, the three methods
 *   <data dir>/pricing/items/<id>.json   weight, metal, stones and findings for one piece
 *   <data dir>/pricing/splits.json       the sets divided into groups priced apart, and what the groups are called
 *
 * So BenchClock never sees a file it doesn't expect, and one backup of the folder keeps both.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { METHODS, TROY_OUNCE_GRAMS, metalPerGram, tierFactor, roundTo, price, round2, round4 } = require('./arithmetic.js');

const APP_NAME = 'BenchClock'; // the data folder is BenchClock's
const SCHEMA_VERSION = 1;
const OVERHEAD_ID = 'time-overhead';
// BenchClock's other line that is not a piece: time pulled away from the bench, neither making nor overhead
const DISTRACTED_ID = 'time-distracted';
const ASIDE_IDS = [OVERHEAD_ID, DISTRACTED_ID];

// BenchClock's kinds of piece, for a piece added here.
const PIECE_TYPES = [
  { id: 'earrings', label: 'Earrings' }, { id: 'ring', label: 'Ring' }, { id: 'pendant', label: 'Pendant' },
  { id: 'chain', label: 'Chain' }, { id: 'bracelet', label: 'Bracelet' }, { id: 'cuff', label: 'Cuff / bangle' },
  { id: 'brooch', label: 'Brooch' }, { id: 'custom', label: 'Custom' }, { id: 'other', label: 'Other' },
];
const ADDED_HERE = 'benchprice'; // `origin` on a piece added here and not in BenchClock
const ADDED_NOTE = 'Made without the clock; time entered in BenchPrice';
const MAX_HOURS = 10000;
const GROUP_NAME_MAX = 40; // what a group of a divided set is called: a few words

/**
 * Starting settings. Spot prices are a placeholder: they move every day and are yours to
 * keep current. Premium is what a supplier charges over spot for sheet, wire and casting grain.
 */
const DEFAULT_SETTINGS = {
  schema_version: SCHEMA_VERSION,
  labor_rate: 50,
  default_method: 2,
  overhead_share: null, // null: worked out from BenchClock; a number from 0 to 1 overrides it
  spot: { silver: 32, gold: 2400, platinum: 1000 }, // dollars per troy ounce
  spot_fetched: null, // { at, source } while the spot prices are as they were fetched; null once typed in
  auto_spot: false, // fetch the spot prices each time the app starts (see spot.js)
  metals: [
    { id: 'sterling', name: 'Sterling silver', base: 'silver', purity: 0.925, premium: 0.15 },
    { id: 'fine-silver', name: 'Fine silver', base: 'silver', purity: 0.999, premium: 0.15 },
    { id: 'gold-10k', name: '10k gold', base: 'gold', purity: 0.417, premium: 0.08 },
    { id: 'gold-14k', name: '14k gold', base: 'gold', purity: 0.585, premium: 0.08 },
    { id: 'gold-18k', name: '18k gold', base: 'gold', purity: 0.75, premium: 0.08 },
    { id: 'platinum', name: 'Platinum', base: 'platinum', purity: 0.95, premium: 0.1 },
    { id: 'gold-filled', name: 'Gold-filled', base: null, per_gram: 1.5 },
    { id: 'brass', name: 'Brass or copper', base: null, per_gram: 0.1 },
    { id: 'other', name: 'Other', base: null, per_gram: 0 },
  ],
  cost_plus: { factor: 2 },
  loaded: { margin: 0.2 },
  tiered: {
    tiers: [{ up_to: 10, factor: 3 }, { up_to: 100, factor: 2 }, { up_to: null, factor: 1.4 }],
    studio_per_hour: 15,
    margin: 0.15,
  },
  fees: 0, // share of the price that goes to card processing, a marketplace, etc.
  round_to: 1,
  round_mode: 'up', // or 'nearest' or 'down'
};

/** A user-facing problem (bad input, missing file). Its message is shown as is. */
class PricingError extends Error {}

function defaultDataDir() {
  if (process.env.BENCHCLOCK_DATA_DIR) return process.env.BENCHCLOCK_DATA_DIR.replace(/^~(?=$|[\\/])/, os.homedir());
  let base;
  if (process.platform === 'win32') base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  else if (process.platform === 'darwin') base = path.join(os.homedir(), 'Library', 'Application Support');
  else base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, APP_NAME);
}

/** Local time with its UTC offset, to the second, as BenchClock writes it: 2026-09-17T14:05:00-04:00 */
function toIso(date) {
  const p = (n) => String(Math.trunc(Math.abs(n))).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}` +
    `${offset < 0 ? '-' : '+'}${p(offset / 60)}:${p(offset % 60)}`;
}

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'piece';

function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** A number, or an error in the user's words. `min` and `max` are inclusive. */
function num(value, what, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const n = typeof value === 'string' ? Number(value.trim()) : Number(value);
  if (value === '' || value === null || value === undefined || !Number.isFinite(n)) throw new PricingError(`${what} needs to be a number.`);
  if (n < min) throw new PricingError(`${what} can't be less than ${min}.`);
  if (n > max) throw new PricingError(`${what} can't be more than ${max}.`);
  if (integer && !Number.isInteger(n)) throw new PricingError(`${what} needs to be a whole number.`);
  return n;
}

/** "(1 of 3)" labels for pieces that were added together, the same as BenchClock shows them. */
function labelItems(items) {
  const byBatch = new Map();
  for (const item of items) {
    const key = item.batch_id || item.id;
    byBatch.set(key, [...(byBatch.get(key) || []), item]);
  }
  for (const group of byBatch.values()) {
    group.sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
    group.forEach((item, index) => {
      item.label = group.length === 1 ? item.name : `${item.name} (${index + 1} of ${group.length})`;
      item.number = index + 1;
    });
  }
  return items;
}

// ----- what a report or price sheet covers -------------------------------------

// Which lines a report or price sheet can be about.
const SCOPES = { finished: 'Finished pieces', ticked: 'Ticked pieces', bench: 'Pieces on the bench', all: 'Every piece' };

/** The days a report covers, checked: each of `from` and `to` is a 'YYYY-MM-DD' day or null. */
function checkPeriod({ from, to } = {}) {
  const clean = (value) => {
    if (value === undefined || value === null || value === '') return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new PricingError(`Couldn't understand the date '${value}'.`);
    return value;
  };
  const period = { from: clean(from), to: clean(to) };
  if (period.from && period.to && period.from > period.to) throw new PricingError('The "from" date has to be on or before the "to" date.');
  return period;
}

// BenchClock stores times as local time, so their first ten characters are the local day.
const inPeriod = (iso, { from, to }) => !!iso && (!from || iso.slice(0, 10) >= from) && (!to || iso.slice(0, 10) <= to);

/**
 * The figures a confirmed price stands on, in the shape price() gives, so a report or price
 * sheet shows the price as it was confirmed and not as today's spot prices and settings would
 * make it. Prices confirmed before 1.5.0 were saved without the three methods' figures; those
 * are worked out again from the saved inputs, with the method settings as they are now.
 */
function confirmedFigures(pricing, settings, overheadShare) {
  const c = pricing.confirmed;
  const byHand = c.method === 'by hand';
  const metal = c.metal ? { ...c.metal } : null;
  const stands = {
    hours: c.hours, rate: c.rate, labor: c.labor, metal, weight_grams: c.weight_grams, metal_cost: c.metal_cost,
    components: c.components, components_cost: c.components_cost, materials: c.materials, fees: c.fees,
    by_hand: byHand, manual_price: byHand ? c.price : null, price: c.price, complete: true, confirmed: c, spot: c.spot,
  };
  if (c.methods) return { ...stands, methods: c.methods, method: c.chosen };
  const then = {
    ...settings, labor_rate: c.rate, spot: c.spot, fees: c.fees, round_to: c.round_to, round_mode: c.round_mode,
    metals: metal ? [{ id: metal.id, name: metal.name, base: null, per_gram: metal.per_gram }] : [], // the premium is in the per-gram price
  };
  const again = price({ seconds_per_piece: c.hours * 3600 }, { metal: metal && metal.id, weight_grams: c.weight_grams, components: c.components,
    method: byHand ? pricing.method : c.method }, then, c.overhead_share ?? overheadShare);
  return { ...stands, methods: again.methods, method: again.method };
}

/** What some lines come to together: the headline figures of a report. A set counts every piece in it. */
function totals(lines) {
  const sum = (list, of) => list.reduce((n, g) => n + of(g), 0);
  const priced = lines.filter((g) => g.basis.complete);
  return {
    lines: lines.length,
    pieces: sum(lines, (g) => g.quantity),
    seconds: sum(lines, (g) => sum(g.pieces, (i) => i.total_seconds || 0)), // all the time clocked on them
    materials: round2(sum(lines, (g) => g.basis.materials * g.quantity)),
    value: round2(sum(priced, (g) => g.basis.price * g.quantity)),
    confirmed: lines.filter((g) => g.basis.confirmed).length,
    unpriced: lines.length - priced.length,
  };
}

// ----- the files -----------------------------------------------------------

const CSV_FIELDS = ['item_id', 'name', 'type', 'sku', 'status', 'finished_at', 'quantity', 'piece_ids', 'hours_per_piece', 'metal', 'weight_grams',
  'metal_cost', 'components', 'components_cost', 'materials', 'labor', 'price_cost_plus', 'price_loaded', 'price_tiered', 'method', 'price',
  'confirmed_at', 'price_now', 'notes'];

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

class PriceBook {
  constructor(dataDir) {
    this.dataDir = dataDir || defaultDataDir();
    this.itemsDir = path.join(this.dataDir, 'items');
    this.photosDir = path.join(this.dataDir, 'photos');
    this.pricingDir = path.join(this.dataDir, 'pricing');
    this.pricedDir = path.join(this.pricingDir, 'items');
    this.settingsFile = path.join(this.pricingDir, 'settings.json');
    this.splitsFile = path.join(this.pricingDir, 'splits.json');
    fs.mkdirSync(this.pricedDir, { recursive: true });
  }

  /** Is there a BenchClock time card here at all? */
  hasBenchClock() { return fs.existsSync(this.itemsDir); }

  // ----- settings ------------------------------------------------------

  settings() {
    const saved = fs.existsSync(this.settingsFile) ? readJson(this.settingsFile) : {};
    // Newer settings get their defaults without losing what was saved.
    return {
      ...DEFAULT_SETTINGS, ...saved,
      spot: { ...DEFAULT_SETTINGS.spot, ...(saved.spot || {}) },
      metals: Array.isArray(saved.metals) && saved.metals.length ? saved.metals : DEFAULT_SETTINGS.metals,
      cost_plus: { ...DEFAULT_SETTINGS.cost_plus, ...(saved.cost_plus || {}) },
      loaded: { ...DEFAULT_SETTINGS.loaded, ...(saved.loaded || {}) },
      tiered: { ...DEFAULT_SETTINGS.tiered, ...(saved.tiered || {}) },
    };
  }

  saveSettings(changes = {}) {
    const current = this.settings();
    const next = { ...current, schema_version: SCHEMA_VERSION };
    if (changes.labor_rate !== undefined) next.labor_rate = num(changes.labor_rate, 'Labor rate', { min: 0 });
    if (changes.default_method !== undefined) {
      next.default_method = num(changes.default_method, 'Default method', { min: 1, max: 3, integer: true });
    }
    if (changes.overhead_share !== undefined) {
      next.overhead_share = changes.overhead_share === null || changes.overhead_share === '' ? null :
        num(changes.overhead_share, 'TimeOverhead share', { min: 0, max: 0.95 });
    }
    if (changes.spot) {
      next.spot = { ...current.spot };
      for (const base of ['silver', 'gold', 'platinum']) {
        if (changes.spot[base] !== undefined) next.spot[base] = num(changes.spot[base], `${base[0].toUpperCase()}${base.slice(1)} spot price`, { min: 0 });
      }
      if (['silver', 'gold', 'platinum'].some((base) => next.spot[base] !== current.spot[base])) next.spot_fetched = null; // typed in, unless said otherwise below
    }
    if (changes.spot_fetched !== undefined) {
      const fetched = changes.spot_fetched;
      next.spot_fetched = fetched && Number.isFinite(Date.parse(fetched.at)) ? { at: new Date(fetched.at).toISOString(), source: String(fetched.source ?? '').trim() } : null;
    }
    if (changes.auto_spot !== undefined) next.auto_spot = changes.auto_spot === true;
    if (changes.metals !== undefined) {
      if (!Array.isArray(changes.metals) || !changes.metals.length) throw new PricingError('Keep at least one metal.');
      next.metals = changes.metals.map((m, i) => {
        const name = String(m.name ?? '').trim();
        if (!name) throw new PricingError(`Metal ${i + 1} needs a name.`);
        const id = String(m.id || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')) || `metal-${i + 1}`;
        if (m.base) {
          if (!['silver', 'gold', 'platinum'].includes(m.base)) throw new PricingError(`${name}: the base metal has to be silver, gold or platinum.`);
          return { id, name, base: m.base, purity: num(m.purity, `${name} purity`, { min: 0, max: 1 }), premium: num(m.premium ?? 0, `${name} premium`, { min: 0, max: 10 }) };
        }
        return { id, name, base: null, per_gram: num(m.per_gram ?? 0, `${name} price per gram`, { min: 0 }) };
      });
      if (new Set(next.metals.map((m) => m.id)).size !== next.metals.length) throw new PricingError('Two metals have the same name.');
    }
    if (changes.cost_plus) next.cost_plus = { factor: num(changes.cost_plus.factor, 'Cost-plus factor', { min: 1 }) };
    if (changes.loaded) next.loaded = { margin: num(changes.loaded.margin, 'Loaded hourly margin', { min: 0, max: 0.95 }) };
    if (changes.tiered) {
      const t = { ...current.tiered };
      if (changes.tiered.studio_per_hour !== undefined) t.studio_per_hour = num(changes.tiered.studio_per_hour, 'Studio overhead per hour', { min: 0 });
      if (changes.tiered.margin !== undefined) t.margin = num(changes.tiered.margin, 'Tiered margin', { min: 0, max: 0.95 });
      if (changes.tiered.tiers !== undefined) {
        if (!Array.isArray(changes.tiered.tiers) || !changes.tiered.tiers.length) throw new PricingError('Keep at least one tier.');
        t.tiers = changes.tiered.tiers.map((tier, i) => ({
          up_to: tier.up_to === null || tier.up_to === '' || tier.up_to === undefined ? null : num(tier.up_to, `Tier ${i + 1} limit`, { min: 0 }),
          factor: num(tier.factor, `Tier ${i + 1} factor`, { min: 0 }),
        }));
        t.tiers.sort((a, b) => (a.up_to === null) - (b.up_to === null) || a.up_to - b.up_to);
        if (t.tiers.at(-1).up_to !== null) t.tiers.push({ up_to: null, factor: t.tiers.at(-1).factor }); // everything above the last limit
      }
      next.tiered = t;
    }
    if (changes.fees !== undefined) next.fees = num(changes.fees, 'Fees', { min: 0, max: 0.95 });
    if (changes.round_to !== undefined) next.round_to = num(changes.round_to, 'Round to', { min: 0 });
    if (changes.round_mode !== undefined) {
      if (!['up', 'nearest', 'down'].includes(changes.round_mode)) throw new PricingError('Rounding has to go up, to the nearest, or down.');
      next.round_mode = changes.round_mode;
    }
    writeJson(this.settingsFile, next);
    return next;
  }

  // ----- BenchClock's pieces ------------------------------------------

  readItem(file) {
    const item = readJson(file);
    if (!item.type) item.type = 'other';
    if (item.photo === undefined) item.photo = null;
    if (item.batch_id === undefined) item.batch_id = null;
    if (!item.quantity) item.quantity = 1;
    if (item.seconds_per_piece === undefined) item.seconds_per_piece = (item.total_seconds || 0) / item.quantity;
    return item;
  }

  /** Every BenchClock piece (not TimeOverhead or TimeDistracted), labelled, finished ones first. */
  listItems() {
    if (!this.hasBenchClock()) return [];
    const items = fs.readdirSync(this.itemsDir)
      .filter((name) => name.endsWith('.json') && !ASIDE_IDS.includes(name.slice(0, -5)))
      .map((name) => this.readItem(path.join(this.itemsDir, name)));
    labelItems(items);
    items.sort((a, b) => (b.status === 'finished') - (a.status === 'finished') ||
      (b.finished_at || '').localeCompare(a.finished_at || '') ||
      a.name.toLowerCase().localeCompare(b.name.toLowerCase(), 'en', { numeric: true }) || (a.sequence || 0) - (b.sequence || 0));
    return items;
  }

  /**
   * Send finished pieces back to BenchClock's bench: they were marked finished by mistake.
   * The same change BenchClock's Reopen makes to the piece's file, and the only one BenchPrice
   * ever makes there. The time on the piece and whatever was entered for its price stay.
   * Returns the pieces sent back.
   */
  sendBack(itemIds) {
    if (!Array.isArray(itemIds) || !itemIds.length) throw new PricingError('Choose at least one piece to send back.');
    const files = [...new Set(itemIds.map(String))].map((id) => {
      if (!/^[\w-]+$/.test(id) || ASIDE_IDS.includes(id)) throw new PricingError(`No piece with id ${id}`);
      const file = path.join(this.itemsDir, `${id}.json`);
      if (!fs.existsSync(file)) throw new PricingError(`No piece with id ${id} in BenchClock.`);
      return [file, readJson(file)];
    }); // every one found before anything is saved
    const back = files.filter(([, item]) => item.status === 'finished');
    for (const [file, item] of back) {
      item.status = (item.time_entries || []).length ? 'in_progress' : 'not_started';
      item.finished_at = null;
      writeJson(file, item);
    }
    return back.map(([, item]) => ({ id: item.id, name: item.name }));
  }

  /**
   * Add pieces that never went through BenchClock (old stock, or work the clock was never
   * started for), already finished. They are written as BenchClock writes its own: `quantity`
   * separate pieces sharing a `batch_id`, so they are one line with one price, each carrying
   * `hours` of making as time put on by hand. `finished_on` is the 'YYYY-MM-DD' day they were
   * finished (today when left out), and the day reports count their time on. `origin` on each
   * file says it was added here. Returns the id of the line to price, and the pieces.
   */
  addPiece({ name, quantity = 1, type = 'other', sku = '', notes = '', hours = 0, finished_on } = {}) {
    name = String(name ?? '').trim();
    if (!name) throw new PricingError('A piece needs a name.');
    quantity = num(quantity, 'How many', { min: 1, max: 999, integer: true });
    if (!PIECE_TYPES.some((t) => t.id === type)) throw new PricingError(`Unknown kind of piece: ${type}`);
    hours = hours === '' || hours === null || hours === undefined ? 0 : num(hours, 'Hours of making', { min: 0, max: MAX_HOURS });
    const now = new Date();
    let finished = now;
    if (finished_on !== undefined && finished_on !== null && finished_on !== '') {
      const day = checkPeriod({ from: finished_on }).from;
      if (day > toIso(now).slice(0, 10)) throw new PricingError("The day it was finished can't be in the future.");
      if (day !== toIso(now).slice(0, 10)) finished = new Date(`${day}T12:00:00`);
      if (Number.isNaN(finished.getTime())) throw new PricingError(`Couldn't understand the date '${finished_on}'.`);
    }
    const stamp = toIso(finished);
    const seconds = Math.round(hours * 36000) / 10;
    const entry = seconds > 0 ? {
      session_id: `adjust-${crypto.randomBytes(4).toString('hex')}`, kind: 'adjustment', clock_in: stamp, clock_out: stamp,
      percent: 100, seconds, note: ADDED_NOTE,
    } : null;
    const batchId = quantity > 1 ? `batch-${crypto.randomBytes(4).toString('hex')}` : null;
    fs.mkdirSync(this.itemsDir, { recursive: true });
    let sequence = Math.max(0, ...fs.readdirSync(this.itemsDir).filter((file) => file.endsWith('.json'))
      .map((file) => readJson(path.join(this.itemsDir, file)).sequence || 0));
    const items = Array.from({ length: quantity }, () => {
      sequence += 1;
      return {
        schema_version: SCHEMA_VERSION, id: `${slug(name)}-${crypto.randomBytes(4).toString('hex')}`, sequence, name, sku: String(sku ?? '').trim(),
        type, photo: null, batch_id: batchId, quantity: 1, status: 'finished', notes: String(notes ?? '').trim(), created_at: toIso(now),
        started_at: entry ? stamp : null, finished_at: stamp, split_from: null, time_entries: entry ? [{ ...entry }] : [],
        total_seconds: seconds, seconds_per_piece: seconds, origin: ADDED_HERE,
      };
    });
    for (const item of items) writeJson(path.join(this.itemsDir, `${item.id}.json`), item);
    return { id: PriceBook.groupKey(items[0], this.splits()), items: items.map((i) => ({ id: i.id, name: i.name })) };
  }

  /**
   * The share of clocked time that went to TimeOverhead, from BenchClock's files. Time on
   * TimeDistracted (BenchClock 1.6.0 on) is left out of both sides: it is neither making nor
   * the work around it, and shouldn't be loaded onto the prices.
   */
  measuredOverheadShare() {
    const file = path.join(this.itemsDir, `${OVERHEAD_ID}.json`);
    if (!fs.existsSync(file)) return 0;
    const overhead = readJson(file).total_seconds || 0;
    const making = this.listItems().reduce((n, i) => n + (i.total_seconds || 0), 0);
    return making + overhead > 0 ? round4(overhead / (making + overhead)) : 0;
  }

  /** The share the prices use: the override in settings if there is one, else what BenchClock measured. */
  overheadShare(settings = this.settings()) {
    return settings.overhead_share === null || settings.overhead_share === undefined ? this.measuredOverheadShare() : Number(settings.overhead_share);
  }

  // ----- sets -----------------------------------------------------------

  /**
   * Pieces BenchClock added together are one set and carry one price; a piece added on its
   * own, or a custom piece, is priced alone. A set divided into groups (see setGroups) is one
   * line for each group, `<set>-<letter>`. The key is what the pricing file is named after.
   */
  static groupKey(item, splits = {}) {
    if (!item.batch_id || item.type === 'custom') return item.id;
    const letter = PriceBook.groupLetter(item, splits);
    return letter ? `${item.batch_id}-${letter}` : item.batch_id;
  }

  /** The group a piece is in, when its set is divided; a piece added to the set since goes in the first group. */
  static groupLetter(item, splits = {}) {
    const letters = item.batch_id && item.type !== 'custom' ? splits[item.batch_id] : null;
    return letters ? letters[item.id] || Object.values(letters).sort()[0] || null : null;
  }

  /** The sets divided into groups, and each piece's letter: { <set>: { <piece id>: 'A', ... } }. */
  splits() {
    return fs.existsSync(this.splitsFile) ? readJson(this.splitsFile).sets || {} : {};
  }

  /**
   * What the groups of divided sets are called. A group is called after the lines under "What"
   * on its price that the set's other groups don't all have (its stone, say), unless a name was
   * typed for it in the groups box. Returns, each as { <set>: { A: 'Aquamarine', ... } }:
   * `typed` the names typed, `derived` the ones taken from the prices, `names` the one in use,
   * and `what`, every "What" line of each group as { <set>: { A: ['Aquamarine'], ... } }.
   */
  groupNaming(sets = this.splits()) {
    const file = fs.existsSync(this.splitsFile) ? readJson(this.splitsFile) : {};
    const typed = file.typed || (file.typed === undefined && file.names) || {}; // before names were taken from the prices, `names` held the typed ones
    const derived = {};
    const what = {};
    const names = {};
    for (const [setId, letters] of Object.entries(sets)) {
      const used = [...new Set(Object.values(letters))].sort();
      what[setId] = Object.fromEntries(used.map((letter) => [letter,
        [...new Set(this.getPricing(`${setId}-${letter}`).components.map((c) => String(c.name || '').trim()).filter(Boolean))]]));
      const inAll = (name) => used.every((letter) => what[setId][letter].some((other) => other.toLowerCase() === name.toLowerCase()));
      derived[setId] = {};
      for (const letter of used) {
        let text = '';
        for (const name of what[setId][letter].filter((n) => !inAll(n))) {
          const longer = text ? `${text}, ${name}` : name;
          if (longer.length > GROUP_NAME_MAX) { text = text || name.slice(0, GROUP_NAME_MAX); break; }
          text = longer;
        }
        if (text) derived[setId][letter] = text;
      }
      names[setId] = { ...derived[setId], ...Object.fromEntries(Object.entries(typed[setId] || {}).filter(([letter]) => used.includes(letter))) };
    }
    return { typed, derived, names, what };
  }

  groupNames() { return this.groupNaming().names; }

  /**
   * Keep `names` in splits.json, which BenchClock and BenchCamera read, saying what the groups
   * are called now. Run after anything that can change it: a price saved, the groups changed.
   */
  syncGroupNames() {
    if (!fs.existsSync(this.splitsFile)) return;
    const file = readJson(this.splitsFile);
    const { typed, names } = this.groupNaming(file.sets || {});
    const kept = Object.fromEntries(Object.entries(names).filter(([, of]) => Object.keys(of).length));
    const next = { schema_version: SCHEMA_VERSION, sets: file.sets || {}, names: kept, typed };
    if (JSON.stringify(next) !== JSON.stringify(file)) writeJson(this.splitsFile, next);
  }

  /** A group's line, in words: "Spiral earrings (A: Aquamarine)", or "(group A)" while it has no name. */
  static groupLabel(name, letter, described) {
    return described ? `${name} (${letter}: ${described})` : `${name} (group ${letter})`;
  }

  /**
   * Divide a set into groups priced apart, for pieces that differ (other stones, say). `letters`
   * gives every piece of the set a letter, and the pieces sharing one become a line of their own.
   * All on one letter and the set is whole again. A new group starts with a copy of what was
   * entered where its first piece was, unconfirmed; a group left with no pieces is forgotten.
   * `names` are the names typed for the groups ({ A: 'Aquamarine' }), shown wherever the group is;
   * a group without one is called after its price (see groupNaming). Left out, the typed names stay.
   */
  setGroups(setId, letters = {}, names) {
    const lines = this.listGroups({ includeBench: true }).filter((g) => g.of_set && g.of_set.id === setId);
    if (!lines.length) throw new PricingError('Only a set of two or more pieces can be divided into groups.');
    const members = lines[0].of_set.pieces;
    for (const id of Object.keys(letters || {})) {
      if (!members.some((i) => i.id === id)) throw new PricingError(`No piece with id ${id} in this set.`);
    }
    const chosen = {};
    for (const piece of members) {
      const letter = String((letters || {})[piece.id] ?? '').trim().toUpperCase();
      if (!/^[A-Z]$/.test(letter)) throw new PricingError(`${piece.label} needs a group: a letter from A to Z.`);
      chosen[piece.id] = letter;
    } // every one checked before anything is saved
    const groups = [...new Set(Object.values(chosen))].sort();
    const splits = this.splits();
    const allNames = this.groupNaming().typed;
    const given = names === undefined ? allNames[setId] || {} : names || {};
    const described = {};
    for (const letter of groups) {
      const text = String(given[letter] ?? '').replace(/\s+/g, ' ').trim();
      if (text.length > GROUP_NAME_MAX) throw new PricingError(`The name of group ${letter} is too long: ${GROUP_NAME_MAX} letters at most.`);
      if (text) described[letter] = text;
    }
    if (groups.length > 1) splits[setId] = chosen; else delete splits[setId];
    if (groups.length > 1 && Object.keys(described).length) allNames[setId] = described; else delete allNames[setId];
    const keyOf = (piece) => PriceBook.groupKey({ id: piece.id, batch_id: setId }, splits);
    const started = new Set(lines.map((line) => line.id));
    for (const piece of members) { // in the set's order, so a new group's first piece decides
      const key = keyOf(piece);
      if (started.has(key)) continue;
      started.add(key);
      const from = lines.find((line) => line.id === piece.line).pricing;
      if (from.updated_at) writeJson(this.pricedPath(key), { ...from, item_id: key, confirmed: null, updated_at: new Date().toISOString() });
      else this.clearPricing(key);
    }
    const kept = new Set(members.map(keyOf));
    for (const line of lines) if (!kept.has(line.id)) this.clearPricing(line.id);
    writeJson(this.splitsFile, { schema_version: SCHEMA_VERSION, sets: splits, names: {}, typed: allNames });
    this.syncGroupNames();
    return { split: groups.length > 1, groups };
  }

  /**
   * Save what was entered, then write the price itself into the file: the figure, how it was
   * reached and when. That is the piece's price from now on, whatever spot prices and settings
   * do later, until it is confirmed again (repriced) or cleared.
   */
  confirmPrice(itemId, changes = {}) {
    this.savePricing(itemId, changes);
    const group = this.listGroups({ includeBench: true }).find((g) => g.id === itemId);
    if (!group) throw new PricingError(`No piece or set with id ${itemId} in BenchClock.`);
    const p = group.priced;
    if (!p.complete) throw new PricingError('Enter a weight, some materials, or a price of your own before confirming.');
    const settings = this.settings();
    const chosen = p.by_hand ? null : p.methods[p.method];
    const confirmed = {
      price: p.live_price, method: p.by_hand ? 'by hand' : p.method, method_name: p.by_hand ? 'Set by hand' : METHODS[p.method].name,
      at: new Date().toISOString(), per_piece: true, pieces: group.quantity,
      hours: p.hours, rate: p.rate, labor: p.labor, overhead_share: chosen && chosen.overhead_share !== undefined ? chosen.overhead_share : null,
      metal: p.metal ? { id: p.metal.id, name: p.metal.name, per_gram: p.metal.per_gram, premium: p.metal.premium } : null, weight_grams: p.weight_grams, metal_cost: p.metal_cost,
      components: p.components.map((c) => ({ name: c.name, quantity: c.quantity, unit_cost: c.unit_cost, total: c.total })), components_cost: p.components_cost,
      materials: p.materials, method_price: p.by_hand ? p.methods[p.method].price : null,
      fees: p.fees, round_to: settings.round_to, round_mode: settings.round_mode || 'up', spot: { ...settings.spot },
      methods: p.methods, chosen: p.method, // all three as they were, so a report can show them beside the price
    };
    const next = { ...this.getPricing(itemId), confirmed };
    writeJson(this.pricedPath(itemId), next);
    return confirmed;
  }

  /** Forget everything entered for a piece or set: its metal, weight, materials, method and any price set by hand. */
  clearPricing(itemId) {
    fs.rmSync(this.pricedPath(itemId), { force: true });
  }

  /**
   * Every set or single piece, with the pieces in it. The making time is the average per piece
   * over the finished ones (over all of them while none is finished), so the whole set prices
   * the same. Finished sets only, unless `includeBench`; a set counts as finished once any
   * piece in it is, and then the ones still on the bench are listed but don't change the price.
   * A group of a divided set is a line like any other, timed and priced on its own pieces;
   * `of_set` on a line says which set it belongs to and how that set is divided. `priced` is
   * today's figures; `basis` is what the price stands on, the figures saved when it was
   * confirmed, or today's while it is not.
   */
  listGroups({ includeBench = false } = {}) {
    const splits = this.splits();
    const naming = this.groupNaming(splits);
    const { names } = naming;
    const groups = new Map();
    const sets = new Map(); // every piece of a set, however it is divided
    const bySequence = (a, b) => (a.sequence || 0) - (b.sequence || 0);
    for (const item of this.listItems()) {
      const key = PriceBook.groupKey(item, splits);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
      if (key !== item.id) sets.set(item.batch_id, [...(sets.get(item.batch_id) || []), item].sort(bySequence));
    }
    const settings = this.settings();
    const share = this.overheadShare(settings);
    const all = [...groups].map(([key, members]) => {
      members.sort(bySequence);
      const finished = members.filter((i) => i.status === 'finished');
      const timed = finished.length ? finished : members;
      const quantity = (list) => list.reduce((n, i) => n + (i.quantity || 1), 0);
      const perPiece = quantity(timed) ? timed.reduce((n, i) => n + (i.total_seconds || 0), 0) / quantity(timed) : 0;
      const first = members[0];
      const pricing = this.pricingFor(key, members);
      const letter = PriceBook.groupLetter(first, splits);
      const whole = (key !== first.id && sets.get(first.batch_id)) || [];
      const described = (letter && (names[first.batch_id] || {})[letter]) || '';
      const group = {
        id: key, set: members.length > 1 || first.quantity > 1, name: first.name, label: letter ? PriceBook.groupLabel(first.name, letter, described) : first.name,
        group: letter, group_name: described, of_set: whole.length > 1 ? {
          id: first.batch_id, names: names[first.batch_id] || {}, typed: naming.typed[first.batch_id] || {}, derived: naming.derived[first.batch_id] || {}, what: naming.what[first.batch_id] || {},
          pieces: whole.map((i) => ({ id: i.id, label: i.label, number: i.number, status: i.status, total_seconds: i.total_seconds, group: PriceBook.groupLetter(i, splits), line: PriceBook.groupKey(i, splits) })),
        } : null,
        type: first.type, photo: first.photo,
        sku: first.sku, notes: first.notes, status: finished.length === members.length ? 'finished' : finished.length ? 'part_finished' :
          members.some((i) => i.status === 'in_progress') ? 'in_progress' : 'not_started',
        finished_at: finished.map((i) => i.finished_at).sort().at(-1) || null,
        quantity: quantity(members), finished: quantity(finished), seconds_per_piece: Math.round(perPiece * 10) / 10,
        pieces: members.map((i) => ({ id: i.id, label: i.label, status: i.status, finished_at: i.finished_at, quantity: i.quantity, total_seconds: i.total_seconds })),
        pricing,
      };
      group.priced = price(group, pricing, settings, share);
      // A confirmed price is the price; the live figure only says whether it has moved since.
      const confirmed = pricing.confirmed || null;
      group.priced.confirmed = confirmed;
      group.priced.live_price = group.priced.price;
      group.priced.moved = !!confirmed && confirmed.price !== group.priced.price;
      if (confirmed) group.priced.price = confirmed.price;
      group.basis = confirmed ? confirmedFigures(pricing, settings, share) : { ...group.priced, spot: settings.spot };
      return group;
    });
    // Every line of a set knows the set's other lines, on the bench or not: the groups box asks before one is forgotten.
    for (const g of all.filter((line) => line.of_set)) {
      g.of_set.lines = all.filter((line) => line.of_set && line.of_set.id === g.of_set.id).map((line) => ({
        id: line.id, label: line.label, group: line.group, entered: !!line.pricing.updated_at, confirmed: line.pricing.confirmed ? line.pricing.confirmed.price : null,
      }));
    }
    return all
      .filter((g) => includeBench || g.finished > 0)
      .sort((a, b) => (b.finished > 0) - (a.finished > 0) || (b.finished_at || '').localeCompare(a.finished_at || '') ||
        a.name.toLowerCase().localeCompare(b.name.toLowerCase(), 'en', { numeric: true }) || a.label.localeCompare(b.label));
  }

  /**
   * The lines a report or price sheet is about. `scope` picks them (`ids` are the ticked ones):
   * a line counts as finished once any piece in it is, as on the list. `from`/`to` keep only
   * the lines with a piece finished on those days, so nothing still on the bench.
   */
  chooseLines({ scope = 'finished', ids = [], from, to } = {}) {
    if (!Object.hasOwn(SCOPES, scope)) throw new PricingError(`Unknown choice of pieces: ${scope}`);
    const period = checkPeriod({ from, to });
    if (!Array.isArray(ids)) ids = [];
    const wanted = { finished: (g) => g.finished > 0, ticked: (g) => ids.includes(g.id), bench: (g) => !g.finished, all: () => true }[scope];
    const ranged = period.from || period.to;
    const lines = this.listGroups({ includeBench: scope !== 'finished' })
      .filter((g) => wanted(g) && (!ranged || g.pieces.some((i) => inPeriod(i.finished_at, period))));
    return { scope, period, lines };
  }

  /** A set's pricing is filed under its key; a set that was priced piece by piece before sets existed keeps its first piece's. */
  pricingFor(key, members) {
    if (!fs.existsSync(this.pricedPath(key))) {
      const priced = members.find((i) => i.id !== key && fs.existsSync(this.pricedPath(i.id)));
      if (priced) return { ...this.getPricing(priced.id), item_id: key };
    }
    return this.getPricing(key);
  }

  // ----- what BenchPrice knows about a piece or set -----------------------

  pricedPath(itemId) {
    if (!/^[\w-]+$/.test(String(itemId))) throw new PricingError(`No piece with id ${itemId}`);
    return path.join(this.pricedDir, `${itemId}.json`);
  }

  getPricing(itemId) {
    const file = this.pricedPath(itemId);
    const saved = fs.existsSync(file) ? readJson(file) : {};
    return { item_id: itemId, metal: null, weight_grams: 0, add_premium: true, components: [], method: null, manual_price: null, notes: '', confirmed: null, ...saved };
  }

  savePricing(itemId, { metal, weight_grams, add_premium, components, method, manual_price, notes } = {}) {
    const settings = this.settings();
    const current = this.getPricing(itemId);
    const next = { ...current, schema_version: SCHEMA_VERSION, item_id: itemId };
    if (metal !== undefined) {
      if (metal !== null && metal !== '' && !settings.metals.some((m) => m.id === metal)) throw new PricingError(`No metal called ${metal} in the settings.`);
      next.metal = metal || null;
    }
    if (weight_grams !== undefined) next.weight_grams = weight_grams === '' || weight_grams === null ? 0 : num(weight_grams, 'Weight', { min: 0, max: 100000 });
    if (add_premium !== undefined) next.add_premium = add_premium !== false;
    if (components !== undefined) {
      if (!Array.isArray(components)) throw new PricingError('Components need to be a list.');
      next.components = components
        .filter((c) => String(c.name ?? '').trim() || c.unit_cost || c.quantity)
        .map((c, i) => ({
          name: String(c.name ?? '').trim() || `Item ${i + 1}`,
          quantity: num(c.quantity ?? 1, `${c.name || `Item ${i + 1}`} quantity`, { min: 0 }),
          unit_cost: num(c.unit_cost ?? 0, `${c.name || `Item ${i + 1}`} cost`, { min: 0 }),
        }));
    }
    if (method !== undefined) next.method = method === null || method === '' ? null : num(method, 'Method', { min: 1, max: 3, integer: true });
    if (manual_price !== undefined) next.manual_price = manual_price === null || manual_price === '' ? null : num(manual_price, 'The price', { min: 0 });
    if (notes !== undefined) next.notes = String(notes ?? '').trim();
    next.updated_at = new Date().toISOString();
    writeJson(this.pricedPath(itemId), next);
    this.syncGroupNames();
    return next;
  }

  /**
   * Write a price sheet, one row per set or single piece, of these ids (every finished one when `ids` is empty).
   * The figures are the ones the price stands on; `price_now` says what today's would make a confirmed price. Returns the row count.
   */
  exportCsv(file, ids = []) {
    const wanted = new Set(ids);
    const groups = this.listGroups({ includeBench: wanted.size > 0 }).filter((g) => !wanted.size || wanted.has(g.id));
    const rows = groups.map(({ basis: p, priced, ...item }) => [
      item.id, item.label, item.type, item.sku, item.status, item.finished_at || '', item.quantity, item.pieces.map((i) => i.id).join('; '), p.hours,
      p.metal ? p.metal.name : '', p.weight_grams, p.metal_cost, p.components.map((c) => `${c.quantity} x ${c.name} @ ${c.unit_cost}`).join('; '),
      p.components_cost, p.materials, p.labor, p.methods[1].price, p.methods[2].price, p.methods[3].price,
      p.confirmed ? p.confirmed.method : p.by_hand ? 'by hand' : p.method, p.price,
      p.confirmed ? p.confirmed.at : '', p.confirmed ? priced.live_price : '', item.pricing.notes,
    ]);
    const text = [CSV_FIELDS, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
    fs.writeFileSync(file, text, 'utf8');
    return rows.length;
  }
}

module.exports = {
  PriceBook, PricingError, price, metalPerGram, tierFactor, roundTo, labelItems, defaultDataDir, checkPeriod, totals, confirmedFigures,
  DEFAULT_SETTINGS, METHODS, SCOPES, CSV_FIELDS, TROY_OUNCE_GRAMS, SCHEMA_VERSION, PIECE_TYPES,
};
