'use strict';
/*
 * The pricing arithmetic on its own: no files, no Node, so the window can load it too and
 * show prices as they are typed. pricing.js uses the same code to fill the price sheet.
 */

const TROY_OUNCE_GRAMS = 31.1034768;
const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;

const METHODS = {
  1: { id: 1, name: 'Cost-plus', short: 'Materials and labor, times a factor' },
  2: { id: 2, name: 'Loaded hourly', short: 'Labor carries the TimeOverhead share, then a profit margin' },
  3: { id: 3, name: 'Tiered materials', short: 'Materials marked up by cost band, plus labor and studio overhead, then a margin' },
};

/** Dollars per gram of a metal, from spot and purity, or its own per-gram price. */
function metalPerGram(metal, spot) {
  if (!metal) return 0;
  if (!metal.base) return round4(Number(metal.per_gram) || 0);
  const ounce = Number((spot || {})[metal.base]) || 0;
  return round4(ounce / TROY_OUNCE_GRAMS * (Number(metal.purity) || 0) * (1 + (Number(metal.premium) || 0)));
}

function tierFactor(tiers, cost) {
  for (const tier of tiers) if (tier.up_to === null || tier.up_to === undefined || cost <= tier.up_to) return Number(tier.factor) || 1;
  return 1;
}

const roundTo = (price, step) => (step > 0 ? Math.ceil(price / step - 1e-9) * step : price);

/**
 * Everything the three methods say about one piece. `item` is a BenchClock piece, `pricing`
 * is what BenchPrice knows about it (metal, weight, components), `overheadShare` the share
 * of clocked time that was TimeOverhead (0 to 1). All figures are per piece.
 */
function price(item, pricing, settings, overheadShare) {
  const hours = round4((item.seconds_per_piece || 0) / 3600);
  const rate = Number(settings.labor_rate) || 0;
  const labor = round2(hours * rate);
  const metal = settings.metals.find((m) => m.id === (pricing && pricing.metal)) || null;
  const perGram = metalPerGram(metal, settings.spot);
  const weight = Number(pricing && pricing.weight_grams) || 0;
  const metalCost = round2(weight * perGram);
  const components = ((pricing && pricing.components) || []).map((c) => ({
    ...c, total: round2((Number(c.quantity) || 0) * (Number(c.unit_cost) || 0)),
  }));
  const componentsCost = round2(components.reduce((n, c) => n + c.total, 0));
  const materials = round2(metalCost + componentsCost);
  const fees = Math.min(Math.max(Number(settings.fees) || 0, 0), 0.95);
  const finish = (raw) => {
    const withFees = raw / (1 - fees);
    return { raw: round2(raw), with_fees: round2(withFees), price: round2(roundTo(withFees, Number(settings.round_to) || 0)) };
  };

  const factor = Number(settings.cost_plus.factor) || 1;
  const cost1 = labor + materials;
  const m1 = { ...METHODS[1], cost: round2(cost1), factor, ...finish(cost1 * factor) };

  const share = Math.min(Math.max(Number(overheadShare) || 0, 0), 0.95);
  const loadedRate = round2(rate / (1 - share));
  const labor2 = round2(hours * loadedRate);
  const margin2 = Math.min(Math.max(Number(settings.loaded.margin) || 0, 0), 0.95);
  const cost2 = labor2 + materials;
  const m2 = { ...METHODS[2], overhead_share: share, loaded_rate: loadedRate, labor: labor2, cost: round2(cost2), margin: margin2, ...finish(cost2 / (1 - margin2)) };

  const tiers = settings.tiered.tiers || [];
  const lines = [
    ...(metalCost > 0 ? [{ name: metal ? metal.name : 'Metal', cost: metalCost }] : []),
    ...components.filter((c) => c.total > 0).map((c) => ({ name: c.name, cost: c.total })),
  ].map((line) => ({ ...line, factor: tierFactor(tiers, line.cost), marked: round2(line.cost * tierFactor(tiers, line.cost)) }));
  const marked = round2(lines.reduce((n, l) => n + l.marked, 0));
  const studio = round2(hours * (Number(settings.tiered.studio_per_hour) || 0));
  const margin3 = Math.min(Math.max(Number(settings.tiered.margin) || 0, 0), 0.95);
  const cost3 = marked + labor + studio;
  const m3 = { ...METHODS[3], lines, marked, studio, cost: round2(cost3), margin: margin3, ...finish(cost3 / (1 - margin3)) };

  const chosen = [1, 2, 3].includes(Number(pricing && pricing.method)) ? Number(pricing.method) : Number(settings.default_method) || 2;
  const methods = { 1: m1, 2: m2, 3: m3 };
  return {
    hours, rate, labor, metal: metal ? { id: metal.id, name: metal.name, per_gram: perGram } : null, weight_grams: weight,
    metal_cost: metalCost, components, components_cost: componentsCost, materials, fees, methods, method: chosen,
    price: methods[chosen].price, complete: weight > 0 || componentsCost > 0,
  };
}

if (typeof module !== 'undefined') module.exports = { METHODS, TROY_OUNCE_GRAMS, metalPerGram, tierFactor, roundTo, price, round2, round4 };
