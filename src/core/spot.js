'use strict';
/*
 * Live spot prices. This is the one place BenchPrice goes online, and only when asked: by
 * Fetch live prices in Settings, or as the app starts when Settings says to. Three small
 * requests to gold-api.com, which is free and needs no key. Nothing is saved here.
 */

const { round2 } = require('./arithmetic.js');
const { PricingError } = require('./pricing.js');

const SOURCE = { name: 'gold-api.com', url: 'https://api.gold-api.com/price/' };
const SYMBOLS = { silver: 'XAG', gold: 'XAU', platinum: 'XPT' };

/**
 * Today's silver, gold and platinum in dollars a troy ounce: { spot, source, at }, `at` being
 * the oldest of the three quotes. All three or an error in the user's words; `fetch` is the
 * global one unless another is passed (Electron's, which follows the system's proxy; a test's).
 */
async function fetchSpot({ fetch: get = fetch, timeout = 15000 } = {}) {
  const one = async (base) => {
    let reply;
    try {
      reply = await get(`${SOURCE.url}${SYMBOLS[base]}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
    } catch {
      throw new PricingError(`Couldn't reach ${SOURCE.name} for the spot prices. Is this computer online?`);
    }
    if (!reply.ok) throw new PricingError(`${SOURCE.name} answered with an error (${reply.status}) for the ${base} price. Try again in a little while.`);
    const quote = await reply.json().catch(() => null);
    const dollars = quote && quote.currency === 'USD' ? Number(quote.price) : NaN;
    if (!Number.isFinite(dollars) || dollars <= 0) throw new PricingError(`${SOURCE.name} sent no ${base} price that can be used. Try again in a little while.`);
    const at = Date.parse(quote.updatedAt);
    return { price: round2(dollars), at: Number.isFinite(at) ? at : Date.now() };
  };
  const [silver, gold, platinum] = await Promise.all(['silver', 'gold', 'platinum'].map(one));
  return {
    spot: { silver: silver.price, gold: gold.price, platinum: platinum.price },
    source: SOURCE.name,
    at: new Date(Math.min(silver.at, gold.at, platinum.at)).toISOString(),
  };
}

module.exports = { fetchSpot, SOURCE, SYMBOLS };
