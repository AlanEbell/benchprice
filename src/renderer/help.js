'use strict';
/* global esc, money, money0, pct, price, metalPerGram, TROY_OUNCE_GRAMS, ROUNDING */
// The help page: how the app works, and how each price is reached. The figures in it are the
// settings as they stand, and the worked example goes through the same arithmetic as every
// price (../core/arithmetic.js), so the page can't fall out of step with what the app does.

/** The piece the help page prices: 2h 30m of making, 5 g of silver, a stone and four jump rings. */
function helpExample(state) {
  const s = state.settings;
  const metal = s.metals.find((m) => m.id === 'sterling') || s.metals.find((m) => m.base) || s.metals[0];
  const pricing = {
    metal: metal.id, weight_grams: 5, method: null,
    components: [{ name: 'Moonstone cabochon', quantity: 1, unit_cost: 30 }, { name: 'Jump rings', quantity: 4, unit_cost: 0.25 }],
  };
  return { metal, p: price({ seconds_per_piece: 9000 }, pricing, s, state.overheadShare) };
}

function helpHtml(state) {
  const s = state.settings;
  const { metal, p } = helpExample(state);
  const [m1, m2, m3] = [p.methods[1], p.methods[2], p.methods[3]];
  const line = (label, value, extra = '') => `<div class="line ${extra}"><span>${label}</span><span>${value}</span></div>`;
  const steps = (...lines) => `<div class="breakdown">${lines.join('')}</div>`;
  const formula = (text) => `<p class="formula">${text}</p>`;
  const rounds = Number(s.round_to) > 0;
  // fees and rounding, the same last steps for every method
  const finish = (m) => (p.fees ? line(`&divide; (1 &minus; ${pct(p.fees)} selling fees)`, money(m.with_fees)) : '') +
    line(rounds ? `Rounded ${ROUNDING[s.round_mode] || ROUNDING.up} ${money0(s.round_to)}: the price` : 'The price', money(m.price), 'sum');
  const overridden = s.overhead_share !== null && s.overhead_share !== undefined;
  const bands = s.tiered.tiers.map((t, i, all) => (t.up_to === null ?
    `${all.length > 1 ? 'anything dearer' : 'every line'} &times;${t.factor}` : `a line costing up to ${money0(t.up_to)} &times;${t.factor}`)).join(', ');

  return `
  <p>BenchPrice puts a price on each piece on your BenchClock time card. BenchClock knows how long a piece took to make.
    You tell BenchPrice what it is made of, and it works the price out three ways, side by side, for you to choose from.</p>

  <h3>Using it, start to finish</h3>
  <ol>
    <li><b>Finish a piece in BenchClock.</b> It appears here under <i>Finished pieces</i> with its making time. Press <kbd>F5</kbd> if it was finished while BenchPrice was open.
      Tick <i>Show the bench too</i> to price something still being made, for a quote.</li>
    <li><b>Press Price on its line.</b> Choose the metal, type the weight of metal in grams, and list the stones, findings and anything else bought in, at what you paid.
      The three prices update as you type, and each card shows how its figure was reached.</li>
    <li><b>Choose the method.</b> The highlighted card is the one that counts. Press another card to price this piece that way, or type a price of your own under
      <i>Or set the price yourself</i>, which wins over every method.</li>
    <li><b>Confirm price.</b> That writes the price into the piece's file with the figures behind it and the date. From then on it is the piece's price,
      whatever spot prices and settings do later. If the live figure moves, the line says <i>Confirmed, now $X</i>; confirm again to reprice. <i>Save</i> keeps what you entered without confirming.</li>
    <li><b>Save price sheet</b> writes a spreadsheet file (CSV) of the ticked lines, or of every finished piece when none is ticked, with all three prices and the costs behind them.</li>
  </ol>

  <h3>Sets, groups and single pieces</h3>
  <ul>
    <li><b>A set carries one price.</b> Pieces added together in BenchClock (<i>Moonstone ring &times;3</i>) are one line, priced once. The making time is the average per piece
      over the finished ones, so every piece in the set sells for the same.</li>
    <li><b>Groups</b> divides a set whose pieces are not all alike, such as earrings made together with different stones. Give each piece a letter: the pieces sharing a letter
      become a line of their own, priced on their own time and materials. All on one letter and the set is one line again.</li>
    <li><b>A custom piece</b> is always priced on its own.</li>
    <li><b>Not finished</b> sends a piece marked finished by mistake back to the bench in BenchClock, with its time and whatever was entered for its price.</li>
  </ul>

  <h3>What every price starts from</h3>
  <p>All figures are for one piece. The example on this page is a ring that took 2h 30m to make, with 5 g of ${esc(metal.name)}, a $30 moonstone and four jump rings at $0.25,
    priced with your settings as they are now.</p>
  <ul>
    <li><b>Making time</b> comes from BenchClock, in hours.</li>
    <li><b>Labor</b> is the making time at your labor rate, now ${money0(p.rate)} an hour.</li>
    <li><b>Metal</b> is its weight at the metal's price per gram. For a metal priced from spot:
      ${formula('price per gram = spot price per troy ounce &divide; 31.1035 &times; purity &times; (1 + supplier&rsquo;s premium)')}
      ${metal.base ? `${esc(metal.name)} now: ${money(s.spot[metal.base])} &divide; ${TROY_OUNCE_GRAMS.toFixed(4)} &times; ${metal.purity} &times; (1 + ${pct(metal.premium || 0)}) = ${money(metalPerGram(metal, s.spot))} a gram.` : ''}
      The premium is what your supplier charges over the bare value of the metal; untick <i>Add the supplier's premium</i> on a piece to leave it off.
      Gold-filled, brass and the like have a plain price per gram instead.</li>
    <li><b>Stones and findings</b> are each line's quantity times what you paid for one.</li>
    <li><b>Materials</b> are the metal plus the stones and findings.</li>
  </ul>
  ${steps(
    line(`Labor: ${p.hours} h &times; ${money0(p.rate)}`, money(p.labor)),
    line(`Metal: ${p.weight_grams} g &times; ${money(p.metal.per_gram)}`, money(p.metal_cost)),
    line(`Stones and findings: ${p.components.map((c) => `${c.quantity} &times; ${money(c.unit_cost)}`).join(' + ')}`, money(p.components_cost)),
    line('Materials', money(p.materials), 'sum'))}

  <h3>Method 1: Cost-plus</h3>
  <p>The simplest: add up what the piece cost you and multiply. The factor has to cover everything else, your overhead and your profit alike. Yours is &times;${m1.factor}.</p>
  ${formula('price = (materials + labor) &times; factor')}
  ${steps(
    line(`${money(p.materials)} materials + ${money(p.labor)} labor`, money(m1.cost)),
    line(`&times; ${m1.factor}`, money(m1.raw)),
    finish(m1))}

  <h3>Method 2: Loaded hourly</h3>
  <p>Not every hour in the workshop goes into a piece: ordering, photographs, cleaning up and the rest are clocked in BenchClock as TimeOverhead. This method makes the making hours pay
    for those hours too, by raising the hourly rate. If ${pct(m2.overhead_share)} of your time is overhead, only ${pct(1 - m2.overhead_share)} of it earns, so the rate is divided by that share.
    The TimeOverhead share is ${overridden ? `set by hand in Settings at ${pct(m2.overhead_share)}; BenchClock measures ${pct(state.measuredOverhead)}` :
    `measured from BenchClock: the time on TimeOverhead divided by all the time clocked, now ${pct(m2.overhead_share)}`}.</p>
  <p>Then a profit margin is added, yours being ${pct(m2.margin)}. A margin is a share of the price, not of the cost, which is why the cost is divided by (1 &minus; margin)
    rather than multiplied: a 20% margin on $100 of cost gives $125, of which $25 is 20%.</p>
  ${formula('loaded rate = labor rate &divide; (1 &minus; TimeOverhead share)<br>price = (hours &times; loaded rate + materials) &divide; (1 &minus; margin)')}
  ${steps(
    line(`Loaded rate: ${money0(p.rate)} &divide; (1 &minus; ${pct(m2.overhead_share)})`, `${money(m2.loaded_rate)} an hour`),
    line(`Labor: ${p.hours} h &times; ${money(m2.loaded_rate)}`, money(m2.labor)),
    line(`+ ${money(p.materials)} materials`, money(m2.cost)),
    line(`&divide; (1 &minus; ${pct(m2.margin)} margin)`, money(m2.raw)),
    finish(m2))}

  <h3>Method 3: Tiered materials</h3>
  <p>The way many jewelers mark up: cheap things are marked up a lot, expensive things less, so a costly stone doesn't price the piece out of reach while small findings still earn their handling.
    Each material line (the metal, and each line of stones and findings) is multiplied by the factor for the band its cost falls in. Your bands: ${bands}.</p>
  <p>To the marked-up materials are added plain labor at your rate and a studio overhead for each hour of making (rent, tools, power: now ${money0(s.tiered.studio_per_hour)} an hour),
    then a profit margin of ${pct(m3.margin)}, worked as in method 2.</p>
  ${formula('price = (each material &times; its band&rsquo;s factor + labor + hours &times; studio overhead) &divide; (1 &minus; margin)')}
  ${steps(
    ...m3.lines.map((l) => line(`${esc(l.name)}: ${money(l.cost)} &times; ${l.factor}`, money(l.marked))),
    line('Materials, marked up', money(m3.marked), 'sum'),
    line(`+ ${money(p.labor)} labor + ${p.hours} h &times; ${money0(s.tiered.studio_per_hour)} studio`, money(m3.cost)),
    line(`&divide; (1 &minus; ${pct(m3.margin)} margin)`, money(m3.raw)),
    finish(m3))}

  <h3>Last, for every method: fees and rounding</h3>
  <ul>
    <li><b>Selling fees</b> are the share of the price that a card processor or marketplace keeps, now ${pct(p.fees)}. The price is divided by (1 &minus; fees), so that what is left after the fees is the figure the method came to.</li>
    <li><b>Rounding</b> comes after that: ${rounds ? `now ${ROUNDING[s.round_mode] || ROUNDING.up} ${money0(s.round_to)}` : 'now off, so prices are left to the cent'}.
      Rounding to $5 gives prices like $270 and $275; it can go up, to the nearest, or down.</li>
  </ul>

  <h3>Which method?</h3>
  <p>That is yours to judge, which is why all three are shown. Cost-plus is quick and rough. Loaded hourly follows your own time card most closely, and suits work where the hours are the main cost.
    Tiered materials suits pieces where a stone or the metal is the main cost. Settings chooses the one used unless a piece says otherwise, now ${esc(state.methods[s.default_method].name)}.
    On this example they come to ${money0(m1.price)}, ${money0(m2.price)} and ${money0(m3.price)}.</p>

  <h3>Spot prices and settings</h3>
  <p><b>Settings</b> (<kbd>Ctrl</kbd>+<kbd>,</kbd>) holds everything used above: the labor rate, the factor, margins and bands, fees and rounding, the metals, and the spot prices of silver, gold and platinum
    in dollars a troy ounce. Spot prices move every day. Type them in, or press <b>Fetch live prices</b> there to look up today's on gold-api.com; nothing changes until you press Save.
    Tick <i>Fetch them each time BenchPrice starts</i> to have that done for you as the app opens. Those are the only times BenchPrice goes online.
    Changing a setting reworks every price that is not confirmed. A confirmed price stays as it is until you confirm it again.</p>`;
}
