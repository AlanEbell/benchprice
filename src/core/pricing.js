'use strict';
/*
 * BenchPrice: the pricing arithmetic and the files behind it. No interface here.
 *
 * BenchClock's data folder is read, never written: pieces and their time come from
 * items/<id>.json. Everything BenchPrice adds lives in its own folder inside it:
 *
 *   <data dir>/pricing/settings.json     labor rate, spot prices, metals, the three methods
 *   <data dir>/pricing/items/<id>.json   weight, metal, stones and findings for one piece
 *
 * So BenchClock never sees a file it doesn't expect, and one backup of the folder keeps both.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { METHODS, TROY_OUNCE_GRAMS, metalPerGram, tierFactor, roundTo, price, round4 } = require('./arithmetic.js');

const APP_NAME = 'BenchClock'; // the data folder is BenchClock's
const SCHEMA_VERSION = 1;
const OVERHEAD_ID = 'time-overhead';

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
    });
  }
  return items;
}

// ----- the files -----------------------------------------------------------

const CSV_FIELDS = ['item_id', 'name', 'type', 'sku', 'status', 'finished_at', 'quantity', 'hours_per_piece', 'metal', 'weight_grams',
  'metal_cost', 'components', 'components_cost', 'materials', 'labor', 'price_cost_plus', 'price_loaded', 'price_tiered', 'method', 'price', 'notes'];

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
    }
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

  /** Every BenchClock piece (not TimeOverhead), labelled, finished ones first. */
  listItems() {
    if (!this.hasBenchClock()) return [];
    const items = fs.readdirSync(this.itemsDir)
      .filter((name) => name.endsWith('.json') && name !== `${OVERHEAD_ID}.json`)
      .map((name) => this.readItem(path.join(this.itemsDir, name)));
    labelItems(items);
    items.sort((a, b) => (b.status === 'finished') - (a.status === 'finished') ||
      (b.finished_at || '').localeCompare(a.finished_at || '') ||
      a.name.toLowerCase().localeCompare(b.name.toLowerCase(), 'en', { numeric: true }) || (a.sequence || 0) - (b.sequence || 0));
    return items;
  }

  /** The share of all clocked time that went to TimeOverhead, from BenchClock's files. */
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

  // ----- what BenchPrice knows about a piece ----------------------------

  pricedPath(itemId) {
    if (!/^[\w-]+$/.test(String(itemId))) throw new PricingError(`No piece with id ${itemId}`);
    return path.join(this.pricedDir, `${itemId}.json`);
  }

  getPricing(itemId) {
    const file = this.pricedPath(itemId);
    const saved = fs.existsSync(file) ? readJson(file) : {};
    return { item_id: itemId, metal: null, weight_grams: 0, components: [], method: null, notes: '', ...saved };
  }

  savePricing(itemId, { metal, weight_grams, components, method, notes } = {}) {
    const settings = this.settings();
    const current = this.getPricing(itemId);
    const next = { ...current, schema_version: SCHEMA_VERSION, item_id: itemId };
    if (metal !== undefined) {
      if (metal !== null && metal !== '' && !settings.metals.some((m) => m.id === metal)) throw new PricingError(`No metal called ${metal} in the settings.`);
      next.metal = metal || null;
    }
    if (weight_grams !== undefined) next.weight_grams = weight_grams === '' || weight_grams === null ? 0 : num(weight_grams, 'Weight', { min: 0, max: 100000 });
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
    if (notes !== undefined) next.notes = String(notes ?? '').trim();
    next.updated_at = new Date().toISOString();
    writeJson(this.pricedPath(itemId), next);
    return next;
  }

  /** Every piece with its pricing and its prices worked out. Finished pieces only, unless `includeBench`. */
  listPieces({ includeBench = false } = {}) {
    const settings = this.settings();
    const share = this.overheadShare(settings);
    return this.listItems()
      .filter((item) => includeBench || item.status === 'finished')
      .map((item) => {
        const pricing = this.getPricing(item.id);
        return { ...item, pricing, priced: price(item, pricing, settings, share) };
      });
  }

  /** Write a price sheet of the pieces with these ids (every finished piece when `ids` is empty). Returns the row count. */
  exportCsv(file, ids = []) {
    const wanted = new Set(ids);
    const pieces = this.listPieces({ includeBench: wanted.size > 0 }).filter((p) => !wanted.size || wanted.has(p.id));
    const rows = pieces.map(({ priced: p, ...item }) => [
      item.id, item.label, item.type, item.sku, item.status, item.finished_at || '', item.quantity, p.hours,
      p.metal ? p.metal.name : '', p.weight_grams, p.metal_cost, p.components.map((c) => `${c.quantity} x ${c.name} @ ${c.unit_cost}`).join('; '),
      p.components_cost, p.materials, p.labor, p.methods[1].price, p.methods[2].price, p.methods[3].price, p.method, p.price, item.pricing.notes,
    ]);
    const text = [CSV_FIELDS, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
    fs.writeFileSync(file, text, 'utf8');
    return rows.length;
  }
}

module.exports = {
  PriceBook, PricingError, price, metalPerGram, tierFactor, roundTo, labelItems, defaultDataDir,
  DEFAULT_SETTINGS, METHODS, CSV_FIELDS, TROY_OUNCE_GRAMS, SCHEMA_VERSION,
};
