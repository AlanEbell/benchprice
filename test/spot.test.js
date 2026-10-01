'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');

const { PricingError } = require('../src/core/pricing.js');
const { fetchSpot } = require('../src/core/spot.js');

/** gold-api.com as it answers, or as `change` makes it answer for one metal. */
function fakeFetch(change = {}) {
  const quotes = {
    XAG: { currency: 'USD', name: 'Silver', price: 61.101002, symbol: 'XAG', updatedAt: '2026-10-01T20:01:20Z' },
    XAU: { currency: 'USD', name: 'Gold', price: 4179.100098, symbol: 'XAU', updatedAt: '2026-10-01T20:01:20Z' },
    XPT: { currency: 'USD', name: 'Platinum', price: 1719.0, symbol: 'XPT', updatedAt: '2026-10-01T20:00:53Z' },
  };
  const asked = [];
  const get = async (url, options) => {
    asked.push(url);
    assert.ok(options.signal, 'every request has a time limit');
    const symbol = url.split('/').at(-1);
    if (change[symbol] instanceof Error) throw change[symbol];
    if (typeof change[symbol] === 'number') return { ok: false, status: change[symbol], json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ ...quotes[symbol], ...change[symbol] }) };
  };
  return { get, asked };
}

test('live spot prices come from gold-api.com, in dollars a troy ounce', async () => {
  const { get, asked } = fakeFetch();
  assert.deepEqual(await fetchSpot({ fetch: get }), {
    spot: { silver: 61.1, gold: 4179.1, platinum: 1719 }, source: 'gold-api.com', at: '2026-10-01T20:00:53.000Z', // the oldest quote
  });
  assert.deepEqual(asked.sort(), ['https://api.gold-api.com/price/XAG', 'https://api.gold-api.com/price/XAU', 'https://api.gold-api.com/price/XPT']);
});

test('no prices at all when one cannot be had, and the reason in plain words', async () => {
  const fails = (change, message) => assert.rejects(fetchSpot({ fetch: fakeFetch(change).get }), (error) => error instanceof PricingError && message.test(error.message));
  await fails({ XAU: new Error('getaddrinfo ENOTFOUND') }, /Couldn't reach gold-api\.com.*online\?/);
  await fails({ XPT: 503 }, /answered with an error \(503\) for the platinum price/);
  await fails({ XAG: { price: 0 } }, /no silver price that can be used/);
  await fails({ XAG: { price: 'n/a' } }, /no silver price that can be used/);
  await fails({ XAU: { currency: 'EUR' } }, /no gold price that can be used/);
  // a quote with no time on it is taken as of now
  const undated = await fetchSpot({ fetch: fakeFetch({ XAG: { updatedAt: undefined }, XAU: { updatedAt: undefined }, XPT: { updatedAt: 'soon' } }).get });
  assert.ok(Math.abs(Date.parse(undated.at) - Date.now()) < 5000);
});
