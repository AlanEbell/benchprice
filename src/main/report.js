'use strict';
// Builds the printable price report as one self-contained HTML page. No Electron in here,
// so it can be tested on its own; main.js turns the page into a PDF.

const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { iconSvg } = require('../renderer/icons.js');
const { METHODS, SCOPES, checkPeriod, totals } = require('../core/pricing.js');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const duration = (secs) => { const m = Math.round(secs / 60); return `${Math.floor(m / 60)}h ${pad(m % 60)}m`; };
const hours = (secs) => (secs / 3600).toFixed(2);
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '');
const plural = (n, word, words = `${word}s`) => `${n} ${n === 1 ? word : words}`;
const money = (n) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dollars = (n) => (Number.isInteger(Number(n)) ? `$${Number(n).toLocaleString('en-US')}` : money(n)); // $32, or $61.10: never $61.1
const pct = (share) => `${Math.round(share * 1000) / 10}%`;

// The kinds of piece, as BenchClock names them (PIECE_TYPES in its timecard.js).
const TYPES = {
  earrings: 'Earrings', ring: 'Ring', pendant: 'Pendant', chain: 'Chain', bracelet: 'Bracelet', cuff: 'Cuff / bangle',
  brooch: 'Brooch', custom: 'Custom', other: 'Other',
};
const STATUS = { not_started: 'Getting started', in_progress: 'In progress', finished: 'Finished' };
const ROUNDING = { up: 'up to the next', nearest: 'to the nearest', down: 'down to the last' };

/** What a report covers, in words: "Pieces finished Sep 7, 2026 – Sep 13, 2026", "Ticked pieces". */
function coversLabel(scope, { from, to } = {}) {
  const calendarDay = (d) => day(`${d}T12:00:00`);
  const days = from && to ? (from === to ? calendarDay(from) : `${calendarDay(from)} – ${calendarDay(to)}`) :
    from ? `from ${calendarDay(from)}` : to ? `up to ${calendarDay(to)}` : '';
  if (!days) return SCOPES[scope];
  return scope === 'finished' ? `Pieces finished ${days}` : `${SCOPES[scope]} · finished ${days}`;
}

/** How each method reached its figure, in the words of the cards in the app. */
const HOW = {
  1: (p, m) => `(${money(p.materials)} materials + ${money(p.labor)} labor) &times; ${m.factor}`,
  2: (p, m) => `${dollars(p.rate)}/h &divide; (1 &minus; ${pct(m.overhead_share)} TimeOverhead) = ${money(m.loaded_rate)}/h; ` +
    `${p.hours} h &times; ${money(m.loaded_rate)} = ${money(m.labor)}, + ${money(p.materials)} materials, &divide; (1 &minus; ${pct(m.margin)} margin)`,
  3: (p, m) => `${m.lines.map((l) => `${esc(l.name)} &times;${l.factor}`).join(', ') || 'no materials'} = ${money(m.marked)}, ` +
    `+ ${money(p.labor)} labor + ${money(m.studio)} studio, &divide; (1 &minus; ${pct(m.margin)} margin)`,
};

/**
 * `lines` are the sets and single pieces to report on, as listGroups gives them; `scope` and
 * `period` say which they are (see chooseLines). `photosDir` is where a line's photo lives.
 * A confirmed price stands with the figures it was confirmed from, whatever spot prices and
 * settings have done since; only a price not yet confirmed is worked from today's.
 */
function buildReportHtml({ lines, settings, overheadShare, scope = 'finished', period, photosDir, generatedAt = new Date() }) {
  period = checkPeriod(period);
  const covers = coversLabel(scope, period);
  const picture = (g) => (g.photo ?
    `<span class="tile"><img src="${esc(pathToFileURL(path.join(photosDir, g.photo)).href)}" alt=""></span>` :
    `<span class="tile">${iconSvg(g.type)}</span>`);
  const spotWords = (spot) => `${dollars(spot.silver)} silver, ${dollars(spot.gold)} gold, ${dollars(spot.platinum)} platinum a troy ounce`;
  // the spot prices every confirmed price rests on, when they are all the same; else each block gives its own
  const confirmedOn = lines.filter((g) => g.basis.confirmed);
  const same = (of) => new Set(confirmedOn.map((g) => JSON.stringify(of(g.basis)))).size === 1;
  const oneSpot = confirmedOn.length > 0 && same((b) => b.spot);
  const row = (what, detail, amount, cls = '') => `<tr class="${cls}"><td>${what}${detail ? `<div class="sub">${detail}</div>` : ''}</td><td class="num">${amount}</td></tr>`;

  function block(g) {
    const p = g.basis;
    const c = p.confirmed;
    const each = g.quantity > 1 ? ' each' : '';
    const about = [
      TYPES[g.type] || TYPES.other,
      g.group ? `group ${esc(g.group)} of the set` : g.set && `a set of ${g.quantity}, one price`,
      g.finished ? `${g.finished < g.quantity ? `${g.finished} of ${g.quantity} finished, ` : 'finished '}${day(g.finished_at)}` : (STATUS[g.status] || g.status).toLowerCase(),
      g.sku && `SKU ${esc(g.sku)}`, esc(g.notes), esc(g.pricing.notes),
    ].filter(Boolean).join(' &middot; ');
    const standing = !p.complete ? 'Not priced yet' :
      c ? `Confirmed ${day(c.at)} &middot; ${esc(c.method_name)}${oneSpot ? '' : `<div>on spot ${spotWords(c.spot)}</div>`}` :
        `${p.by_hand ? 'Set by hand' : esc(METHODS[p.method].name)}, not confirmed`;
    const head = `<div class="head">${picture(g)}
      <div class="grow"><b>${esc(g.label)}</b>${g.quantity > 1 ? ` <span class="qty">&times;${g.quantity}</span>` : ''}<div class="sub">${about}</div></div>
      <div class="price"><div class="figure">${p.complete ? `${dollars(p.price)}<small>${each}</small>` : '&mdash;'}</div>
        <div class="sub">${standing}${p.complete && g.quantity > 1 ? `<div>${g.quantity} pieces: ${dollars(p.price * g.quantity)}</div>` : ''}</div></div></div>`;

    const costs = `<table class="costs"><thead><tr><th>What goes into ${g.quantity > 1 ? 'each piece' : 'it'}</th><th class="num">Cost</th></tr></thead><tbody>
      ${row('Labor', `${duration(g.seconds_per_piece)} of making (${p.hours} h) at ${dollars(p.rate)} an hour`, money(p.labor))}
      ${p.metal || p.weight_grams ? row(`Metal${p.metal ? `: ${esc(p.metal.name)}` : ''}`,
        `${p.weight_grams} g${p.metal ? ` at ${money(p.metal.per_gram)} a gram${p.metal.premium ? `, with the ${pct(p.metal.premium)} premium` : ''}` : ', no metal chosen'}`, money(p.metal_cost)) : ''}
      ${p.components.map((part) => row(esc(part.name), `${part.quantity} &times; ${money(part.unit_cost)}`, money(part.total))).join('')}
      ${p.complete ? '' : row('<span class="none">No weight or materials entered yet</span>', '', '')}
      ${row('Materials', p.components.length ? `metal ${money(p.metal_cost)}, stones and findings ${money(p.components_cost)}` : '', money(p.materials), 'sum')}
      ${row('Labor and materials', '', money(p.methods[1].cost), 'sum')}</tbody></table>`;

    const ways = !p.complete ? '' : `<table class="ways"><thead><tr><th>Priced three ways</th><th class="num">Price</th></tr></thead><tbody>
      ${[1, 2, 3].map((id) => row(`${esc(METHODS[id].name)}${!p.by_hand && p.method === id ? ' <span class="chosen">chosen</span>' : ''}`,
        HOW[id](p, p.methods[id]), dollars(p.methods[id].price), !p.by_hand && p.method === id ? 'chosen' : '')).join('')}
      ${p.by_hand ? row('Set by hand <span class="chosen">chosen</span>', 'wins over every method', dollars(p.manual_price), 'chosen') : ''}</tbody></table>`;

    // the time behind the labor: each piece of a set, or the lot when they were clocked as one
    const which = (i) => (i.label.startsWith(`${g.name} (`) ? `Piece ${i.label.slice(g.name.length + 2, -1)}` : i.quantity > 1 ? `All ${i.quantity} together` : i.label);
    const timed = g.finished ? g.pieces.filter((i) => i.status === 'finished') : g.pieces;
    const spent = g.pieces.reduce((n, i) => n + (i.total_seconds || 0), 0);
    const time = g.quantity === 1 ? '' : `<table class="time"><thead><tr><th>Making time</th><th>Finished</th><th class="num">Time</th><th class="num">Hours</th></tr></thead><tbody>
      ${g.pieces.map((i) => `<tr><td>${esc(which(i))}</td>
        <td>${day(i.finished_at) || esc(STATUS[i.status] || i.status)}</td><td class="num">${duration(i.total_seconds || 0)}</td><td class="num">${hours(i.total_seconds || 0)}</td></tr>`).join('')}
      <tr class="sum"><td colspan="2">${duration(g.seconds_per_piece)} each${g.pieces.length > 1 ? `, the average over ${g.finished ? `the ${timed.length} finished` : 'all of them'}` : ''}</td>
        <td class="num">${duration(spent)}</td><td class="num">${hours(spent)}</td></tr></tbody></table>`;

    // beside the costs when nothing else is, else under the shorter of the two columns: the costs, unless they run long
    const left = !!ways && (p.metal || p.weight_grams ? 1 : 0) + p.components.length < 3;
    return `<section class="line">${head}<div class="cols"><div>${costs}${left ? time : ''}</div>${ways || time ? `<div>${ways}${left ? '' : time}</div>` : ''}</div></section>`;
  }

  /** One row a line: the report at a glance, before each line is gone through. */
  function section(title, list) {
    if (!list.length) return '';
    const t = totals(list);
    const rows = list.map((g) => {
      const p = g.basis;
      return `<tr><td class="pic">${picture(g)}</td>
        <td><b>${esc(g.label)}</b>${g.quantity > 1 ? ` <span class="qty">&times;${g.quantity}</span>` : ''}
          <div class="sub">${[TYPES[g.type] || TYPES.other, g.sku && `SKU ${esc(g.sku)}`, esc(g.notes), esc(g.pricing.notes)].filter(Boolean).join(' &middot; ')}</div></td>
        <td>${g.finished ? day(g.finished_at) : esc(STATUS[g.status] || g.status)}${g.finished && g.finished < g.quantity ? `<div class="sub">${g.finished} of ${g.quantity}</div>` : ''}</td>
        <td class="num">${duration(g.seconds_per_piece)}<div class="sub">${hours(g.seconds_per_piece)} h</div></td>
        <td class="num">${money(p.labor)}</td><td class="num">${p.complete ? money(p.materials) : '&mdash;'}</td>
        <td class="num">${p.complete ? `<b>${dollars(p.price)}</b><div class="sub">${p.confirmed ? 'confirmed' : 'not confirmed'}</div>` : '<div class="sub">not priced yet</div>'}</td>
        <td class="num">${p.complete ? dollars(p.price * g.quantity) : '&mdash;'}</td></tr>`;
    }).join('');
    return `<h2>${title} <small>${plural(t.pieces, 'piece')} &middot; ${duration(t.seconds)} of making${t.value ? ` &middot; ${dollars(t.value)}` : ''}</small></h2>
      <table class="summary"><colgroup><col class="pic"><col><col class="date"><col class="time"><col class="cost"><col class="wide"><col class="wide"><col class="cost"></colgroup>
      <thead><tr><th></th><th>Piece</th><th>Finished</th><th class="num">Time each</th><th class="num">Labor</th><th class="num">Materials</th>
        <th class="num">Price</th><th class="num">Total</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  const t = totals(lines);
  const done = lines.filter((g) => g.finished > 0);
  const open = lines.filter((g) => !g.finished);
  const stat = (label, value, note = '') => `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div><div class="note">${note}</div></div>`;
  const s = settings;
  const byHand = s.overhead_share !== null && s.overhead_share !== undefined;
  const extras = (fees, roundTo, roundMode) => [fees ? `include ${pct(fees)} selling fees` : '',
    Number(roundTo) > 0 ? `are rounded ${ROUNDING[roundMode] || ROUNDING.up} ${dollars(roundTo)}` : ''].filter(Boolean);
  // what the prices rest on: confirmed ones on the figures of their day, the rest on today's
  const first = confirmedOn.length ? confirmedOn[0].basis : null;
  const basis = [
    confirmedOn.length ? `<b>Confirmed prices</b> stand as confirmed${oneSpot ? `, on spot ${spotWords(first.spot)}` : ', each on the spot prices of its day, given with the piece'}${
      same((b) => b.rate) ? `, labor ${dollars(first.rate)} an hour` : ''}${
      same((b) => [b.fees, b.confirmed.round_to, b.confirmed.round_mode]) && extras(first.fees, first.confirmed.round_to, first.confirmed.round_mode).length ?
        `; they ${extras(first.fees, first.confirmed.round_to, first.confirmed.round_mode).join(' and ')}` : ''}.` : '',
    confirmedOn.length < lines.length ? `<b>${confirmedOn.length ? 'Prices not yet confirmed' : 'Prices'}</b> are worked from today's figures: spot ${spotWords(s.spot)}${
      s.spot_fetched ? ` from ${esc(s.spot_fetched.source)} ${day(s.spot_fetched.at)}` : ''}, labor ${dollars(s.labor_rate)} an hour, TimeOverhead ${pct(overheadShare)} of clocked time ${
      byHand ? 'set by hand' : 'from BenchClock'}${extras(s.fees, s.round_to, s.round_mode).length ? `; they ${extras(s.fees, s.round_to, s.round_mode).join(' and ')}` : ''}.` : '',
  ].filter(Boolean).map((line) => `<div>${line}</div>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>BenchPrice price report</title><style>
    * { box-sizing: border-box; }
    body { font: 10.5pt/1.45 "Helvetica Neue", Helvetica, Arial, "Noto Sans", sans-serif; color: #2b2621; margin: 0; }
    h1 { font: 600 20pt Georgia, "Times New Roman", serif; margin: 0; }
    h2 { font: 600 13pt Georgia, "Times New Roman", serif; margin: 20pt 0 6pt; break-after: avoid; }
    h2 small { font: 9.5pt Helvetica, Arial, sans-serif; color: #776d62; margin-left: 6pt; }
    .period { font: 600 12.5pt Georgia, "Times New Roman", serif; color: #1f6b62; margin-top: 3pt; }
    .made { color: #776d62; font-size: 9.5pt; margin-top: 2pt; }
    .stats { display: flex; gap: 8pt; margin-top: 14pt; }
    .stat { flex: 1; border: 1px solid #e4dccd; border-radius: 6pt; padding: 8pt 10pt; }
    .stat .label { font-size: 8pt; text-transform: uppercase; letter-spacing: .08em; color: #776d62; }
    .stat .value { font: 600 15pt Georgia, serif; }
    .stat .note { font-size: 8.5pt; color: #776d62; min-height: 10pt; }
    .basis { margin-top: 8pt; font-size: 8.5pt; color: #776d62; }
    .line { break-inside: avoid; border-top: 1.5px solid #2b2621; margin-top: 12pt; padding-top: 8pt; }
    h2 + .line { margin-top: 0; }
    table.summary { table-layout: fixed; }
    table.summary thead { display: table-header-group; }
    table.summary th { border-bottom: 1.5px solid #2b2621; }
    table.summary td { padding: 5pt 6pt; vertical-align: middle; }
    table.summary tr { break-inside: avoid; }
    table.summary th, table.summary td { padding-left: 4pt; padding-right: 4pt; }
    table.summary td:nth-child(3) { white-space: nowrap; }
    col.pic { width: 34pt; } col.date { width: 68pt; } col.time { width: 52pt; } col.cost { width: 56pt; } col.wide { width: 64pt; }
    td.pic { padding-right: 0; }
    .head { display: flex; align-items: flex-start; gap: 10pt; }
    .head .grow { flex: 1; min-width: 0; font-size: 11.5pt; }
    .price { text-align: right; flex: none; max-width: 45%; }
    .price .figure { font: 600 17pt Georgia, serif; color: #1f6b62; line-height: 1.15; font-variant-numeric: tabular-nums; }
    .price .figure small { font: 9.5pt Helvetica, Arial, sans-serif; color: #776d62; }
    .cols { display: flex; gap: 16pt; align-items: flex-start; margin-top: 8pt; }
    .cols > div { flex: 1; min-width: 0; }
    table { width: 100%; border-collapse: collapse; }
    th { font-size: 8pt; text-transform: uppercase; letter-spacing: .06em; color: #776d62; text-align: left; font-weight: 600;
         padding: 3pt 6pt; border-bottom: 1px solid #b9ae9c; }
    td { padding: 2.5pt 6pt; vertical-align: top; border-bottom: 1px solid #e4dccd; line-height: 1.3; }
    tr.sum td { font-weight: 600; }
    tr.sum .sub { font-weight: 400; }
    tr.chosen td { background: #dcebe7; }
    span.chosen { font-size: 8pt; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: #1f6b62; margin-left: 4pt; }
    table + table.time { margin-top: 8pt; }
    table.time td { font-size: 9.5pt; color: #4a433b; padding-top: 2pt; padding-bottom: 2pt; }
    table.time td:nth-child(2) { white-space: nowrap; }
    .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    th.num { text-align: right; }
    .tile { display: inline-flex; width: 28pt; height: 28pt; border-radius: 5pt; background: #dcebe7; color: #1f6b62; padding: 6pt; overflow: hidden; flex: none; }
    .tile:has(img) { padding: 0; }
    .tile img, .tile svg { width: 100%; height: 100%; display: block; object-fit: cover; }
    .sub { font-size: 8.5pt; color: #776d62; line-height: 1.35; }
    .qty { font-size: 8.5pt; font-weight: 600; color: #a87a2a; border: 1px solid #a87a2a; border-radius: 99px; padding: 0 5pt; }
    .none { color: #776d62; }
    .none.gap { margin-top: 18pt; }
  </style></head><body>
  <h1>BenchPrice price report</h1>
  <div class="period">${esc(covers)}</div>
  <div class="made">Made ${esc(generatedAt.toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' }))} &middot; every cost and price is for one piece</div>
  <div class="stats">
    ${stat('Pieces', t.pieces, [t.lines !== t.pieces && `in ${t.lines} ${t.lines === 1 ? 'set' : 'sets or singles'}`,
      open.length && done.length && `${totals(open).pieces} on the bench`].filter(Boolean).join(', '))}
    ${stat('Making time', duration(t.seconds), `${hours(t.seconds)} hours`)}
    ${stat('Materials', money(t.materials), 'metal, stones and findings')}
    ${stat('At these prices', dollars(t.value), !t.lines ? '' : t.unpriced ? `${t.unpriced} of ${t.lines} not priced yet` :
      t.confirmed === t.lines ? 'all confirmed' : `${t.confirmed} of ${t.lines} confirmed`)}
  </div>
  <div class="basis">${basis}</div>

  ${lines.length ? '' : '<p class="none gap">No pieces to report on.</p>'}
  ${section('Finished', done)}
  ${section('On the bench', open)}
  ${lines.length ? `<h2>How each price is reached <small>${plural(lines.length, 'set or single', 'sets or singles')} &middot; costs and prices for one piece</small></h2>
  ${lines.map(block).join('')}` : ''}
  </body></html>`;
}

module.exports = { buildReportHtml, coversLabel };
