'use strict';
/* global iconSvg, price, metalPerGram, METHODS */
// The window. It keeps no data of its own: every action goes to the main process,
// which answers with the whole current state, and the page is redrawn from that.
// The price arithmetic (../core/arithmetic.js) is loaded here too, so the piece box
// can show prices as they are typed.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let state = { groups: [], settings: null, methods: METHODS, measuredOverhead: 0, overheadShare: 0, hasBenchClock: true };
const selected = new Set();

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 4500);
}

async function api(method, payload) {
  const reply = await window.pricebook.call(method, payload);
  if (!reply.ok) {
    toast(reply.error);
    throw new Error(reply.error);
  }
  state = reply.state;
  render();
  return reply.result;
}

const pad = (n) => String(n).padStart(2, '0');
const fmtDur = (secs) => { const m = Math.round(secs / 60); return `${Math.floor(m / 60)}h ${pad(m % 60)}m`; };
const money = (n) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const money0 = (n) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const pct = (share) => `${Math.round(share * 1000) / 10}%`;
const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const pieces = (n) => `${n} piece${n === 1 ? '' : 's'}`;
const photoUrl = (name) => `bench-photo://library/${encodeURIComponent(name)}`;
const findPiece = (id) => state.groups.find((p) => p.id === id);

function tile(item, extra = '') {
  if (item.photo) return `<span class="tile photo ${extra}"><img src="${photoUrl(item.photo)}" alt=""></span>`;
  return `<span class="tile ${extra}">${iconSvg(item.type)}</span>`;
}

// ---- main page ---------------------------------------------------------

function stripHtml() {
  const s = state.settings;
  const overrideOn = s.overhead_share !== null && s.overhead_share !== undefined;
  const chips = s.metals.filter((m) => m.base).map((m) => `<span class="metal-chip"><b>${esc(m.name)}</b> ${money(metalPerGram(m, s.spot))}/g</span>`);
  const noClock = state.hasBenchClock ? '' : '<span class="fact warn">No BenchClock time card found in this folder.</span>';
  return `${noClock}
    <span class="fact"><b>${money0(s.labor_rate)}</b> an hour</span>
    <span class="fact"><b>${pct(state.overheadShare)}</b> TimeOverhead<small>${overrideOn ? `set by hand; BenchClock says ${pct(state.measuredOverhead)}` : 'from BenchClock'}</small></span>
    <span class="fact"><b>${esc(state.methods[s.default_method].name)}</b><small>unless a piece says otherwise</small></span>
    <span class="fact"><small>Spot</small> <b>${money0(s.spot.silver)}</b> silver, <b>${money0(s.spot.gold)}</b> gold, <b>${money0(s.spot.platinum)}</b> platinum <small>per troy oz</small></span>
    ${chips.join('')}`;
}

const STATUS = { finished: 'finished', part_finished: 'finished', in_progress: 'on the bench', not_started: 'not started' };

function rowHtml(p) {
  const finished = p.finished > 0;
  const meta = [
    p.set && (p.status === 'part_finished' ? `a set: ${p.finished} of ${p.quantity} finished, one price` : 'a set, one price'),
    finished ? `finished ${fmtDay(p.finished_at)}` : STATUS[p.status],
    p.sku && `SKU ${esc(p.sku)}`,
    p.priced.metal ? `${p.priced.weight_grams} g ${esc(p.priced.metal.name)}` : (p.priced.weight_grams ? `${p.priced.weight_grams} g` : ''),
    p.priced.components.length && `${p.priced.components.length} bought-in item${p.priced.components.length === 1 ? '' : 's'} ${money(p.priced.components_cost)}`,
    p.pricing.notes && esc(p.pricing.notes),
  ].filter(Boolean).join(' &middot; ');
  const qty = p.quantity > 1 ? `<span class="qty">&times;${p.quantity}</span>` : '';
  const prices = p.priced.complete ?
    [1, 2, 3].map((m) => `<span class="m ${p.priced.method === m ? 'chosen' : ''}"><small>${esc(state.methods[m].name)}</small>${money0(p.priced.methods[m].price)}</span>`).join('') :
    `<span class="m none" style="grid-column: span 3">no weight or materials yet</span>`;
  return `<div class="row ${selected.has(p.id) ? 'selected' : ''}" data-id="${esc(p.id)}">
    <input type="checkbox" data-act="select" aria-label="Select ${esc(p.label)}" ${selected.has(p.id) ? 'checked' : ''}>
    ${tile(p)}
    <div class="name"><b>${esc(p.label)}</b>${qty}<div class="meta">${fmtDur(p.seconds_per_piece)}${p.set ? ' each' : ''} &middot; ${meta}</div></div>
    <div class="prices">${prices}</div>
    <div class="acts"><button class="quiet go" data-act="price">Price</button></div>
  </div>`;
}

function render() {
  $('strip').innerHTML = stripHtml();
  for (const id of [...selected]) if (!findPiece(id)) selected.delete(id);
  const list = state.groups;
  const showBench = $('showBench').checked;
  $('listTitle').firstChild.textContent = showBench ? 'All pieces ' : 'Finished pieces ';
  $('pieces').innerHTML = list.length ? list.map(rowHtml).join('') :
    `<div class="empty">${state.hasBenchClock ? 'Nothing finished in BenchClock yet. Tick "Show the bench too" to price pieces that are still being made.' :
      'BenchPrice reads the pieces from BenchClock\'s data folder, and there isn\'t one here.'}</div>`;
  const count = list.reduce((n, g) => n + g.quantity, 0);
  $('pieceCount').textContent = list.length ? `${pieces(count)}${count !== list.length ? ` in ${list.length} set${list.length === 1 ? '' : 's'} or single${list.length === 1 ? '' : 's'}` : ''}` : '';
  $('selCount').textContent = selected.size ? `${selected.size} ticked` : '';
  $('clearSel').hidden = !selected.size;
  $('exportBtn').textContent = selected.size ? `Save price sheet (${selected.size})` : 'Save price sheet';
  $('dataDir').textContent = `${state.dataDir}/pricing`;
}

document.addEventListener('click', (ev) => {
  const target = ev.target.closest && ev.target.closest('[data-act]');
  const row = target && target.closest('.row');
  if (!row) return;
  const piece = findPiece(row.dataset.id);
  if (target.dataset.act === 'select') {
    if (target.checked) selected.add(piece.id); else selected.delete(piece.id);
    render();
  } else if (target.dataset.act === 'price') openPiece(piece);
});
$('clearSel').onclick = () => { selected.clear(); render(); };
$('showBench').onchange = () => api('state', { includeBench: $('showBench').checked });
$('dataDir').onclick = () => api('openDataFolder');

// ---- pricing one piece -------------------------------------------------

let editing = null; // the piece or set in the box
const ROUNDING = { up: 'up to the next', nearest: 'to the nearest', down: 'down to the last' };

function partRow(part = { name: '', quantity: 1, unit_cost: '' }) {
  const tr = document.createElement('tr');
  tr.innerHTML = `<td><input type="text" data-part="name" placeholder="e.g. Moonstone cabochon 8 mm" aria-label="What"></td>
    <td class="num"><input type="number" data-part="quantity" min="0" step="any" aria-label="How many"></td>
    <td class="num"><div class="unit-field"><span class="unit">$</span><input type="number" data-part="unit_cost" min="0" step="0.01" aria-label="Cost of each"></div></td>
    <td class="total num"></td>
    <td><button type="button" class="quiet remove" title="Remove this line" aria-label="Remove">&times;</button></td>`;
  tr.querySelector('[data-part=name]').value = part.name;
  tr.querySelector('[data-part=quantity]').value = part.quantity;
  tr.querySelector('[data-part=unit_cost]').value = part.unit_cost;
  tr.querySelector('.remove').onclick = () => { tr.remove(); updatePiece(); };
  return tr;
}

/** What the box says right now, in the shape savePricing takes. */
function pieceDraft() {
  return {
    metal: $('pMetal').value || null,
    weight_grams: $('pWeight').value === '' ? 0 : Number($('pWeight').value),
    components: [...$('partRows').children].map((tr) => ({
      name: tr.querySelector('[data-part=name]').value,
      quantity: Number(tr.querySelector('[data-part=quantity]').value) || 0,
      unit_cost: Number(tr.querySelector('[data-part=unit_cost]').value) || 0,
    })),
    method: $('pMethod').value === '' ? null : Number($('pMethod').value),
    notes: $('pNotes').value,
  };
}

function updatePiece() {
  const draft = pieceDraft();
  const p = price(editing, draft, state.settings, state.overheadShare);
  for (const tr of $('partRows').children) {
    const q = Number(tr.querySelector('[data-part=quantity]').value) || 0;
    const u = Number(tr.querySelector('[data-part=unit_cost]').value) || 0;
    tr.querySelector('.total').textContent = q * u ? money(q * u) : '';
  }
  const line = (label, value, extra = '') => `<div class="line ${extra}"><span>${label}</span><span>${value}</span></div>`;
  $('breakdown').innerHTML =
    line(`Metal${p.metal ? `: ${p.weight_grams} g of ${esc(p.metal.name)} at ${money(p.metal.per_gram)}/g` : ''}`, money(p.metal_cost)) +
    line(`Stones and findings`, money(p.components_cost)) +
    line(`Materials`, money(p.materials), 'sum') +
    line(`Labor: ${p.hours} h at ${money0(p.rate)}/h`, money(p.labor)) +
    (p.fees || state.settings.round_to > 1 ? `<div class="muted">Prices ${[p.fees && `include ${pct(p.fees)} selling fees`,
      state.settings.round_to > 1 && `are rounded ${ROUNDING[state.settings.round_mode] || ROUNDING.up} ${money0(state.settings.round_to)}`].filter(Boolean).join(' and ')}.</div>` : '');
  const how = {
    1: (m) => [`(${money(p.materials)} materials + ${money(p.labor)} labor)`, `&times; ${m.factor}`],
    2: (m) => [`${money0(p.rate)}/h &divide; (1 &minus; ${pct(m.overhead_share)}) = ${money(m.loaded_rate)}/h`, `${p.hours} h &times; ${money(m.loaded_rate)} = ${money(m.labor)}`, `+ ${money(p.materials)} materials, &divide; (1 &minus; ${pct(m.margin)} margin)`],
    3: (m) => [`${m.lines.map((l) => `${esc(l.name)} &times;${l.factor}`).join(', ') || 'no materials'} = ${money(m.marked)}`, `+ ${money(p.labor)} labor + ${money(m.studio)} studio`, `&divide; (1 &minus; ${pct(m.margin)} margin)`],
  };
  const chosen = p.method;
  $('methodCards').innerHTML = [1, 2, 3].map((id) => {
    const m = p.methods[id];
    return `<button type="button" class="card ${chosen === id ? 'chosen' : ''}" data-method="${id}" title="Price this piece by ${esc(m.name)}">
      <span class="name">${id}. ${esc(m.name)}</span><span class="price">${money0(m.price)}</span>
      <span class="how">${how[id](m).map((t) => `<span>${t}</span>`).join('')}</span></button>`;
  }).join('');
}

function openPiece(piece) {
  editing = piece;
  const s = state.settings;
  $('pieceTitle').textContent = piece.set ? `${piece.label} \u00d7${piece.quantity}` : piece.label;
  $('pieceHint').textContent = piece.set ?
    `A set of ${piece.quantity}: every piece carries the same price. ${fmtDur(piece.seconds_per_piece)} of making time each, the average from BenchClock over ` +
      `${piece.finished ? `the ${piece.finished} finished` : 'all of them, none finished yet'}. Everything below is per piece.` :
    `${fmtDur(piece.seconds_per_piece)} of making time from BenchClock${piece.finished ? `, finished ${fmtDay(piece.finished_at)}` : ', still on the bench'}. Everything below is per piece.`;
  $('pMetal').innerHTML = '<option value="">No metal</option>' + s.metals.map((m) =>
    `<option value="${esc(m.id)}">${esc(m.name)} (${money(metalPerGram(m, s.spot))}/g)</option>`).join('');
  $('pMetal').value = piece.pricing.metal || '';
  $('pWeight').value = piece.pricing.weight_grams || '';
  $('partRows').replaceChildren(...piece.pricing.components.map(partRow));
  $('pMethod').innerHTML = `<option value="">Default: ${esc(state.methods[s.default_method].name)}</option>` +
    [1, 2, 3].map((id) => `<option value="${id}">${id}. ${esc(state.methods[id].name)}</option>`).join('');
  $('pMethod').value = piece.pricing.method || '';
  $('pNotes').value = piece.pricing.notes || '';
  updatePiece();
  $('pieceDlg').showModal();
  $('pWeight').focus();
}

$('partAdd').onclick = () => { const tr = partRow(); $('partRows').appendChild(tr); tr.querySelector('input').focus(); };
$('pieceDlg').addEventListener('input', updatePiece);
$('pieceDlg').addEventListener('change', updatePiece);
$('methodCards').addEventListener('click', (ev) => {
  const card = ev.target.closest('[data-method]');
  if (!card) return;
  const id = Number(card.dataset.method);
  $('pMethod').value = id === Number(state.settings.default_method) && $('pMethod').value === '' ? '' : String(id);
  updatePiece();
});
$('pieceCancel').onclick = () => $('pieceDlg').close();
$('pieceForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  await api('savePricing', { id: editing.id, ...pieceDraft() });
  $('pieceDlg').close();
  const p = findPiece(editing.id);
  toast(p && p.priced.complete ? `${p.label}${p.set ? ` (each of ${p.quantity})` : ''}: ${money0(p.priced.price)} by ${state.methods[p.priced.method].name}.` : `${editing.label} saved.`);
});

// ---- settings ----------------------------------------------------------

function metalRow(m = { name: '', base: 'silver', purity: '', premium: '', per_gram: '' }) {
  const tr = document.createElement('tr');
  tr.innerHTML = `<td><input type="text" data-m="name" aria-label="Metal name"></td>
    <td><select data-m="base" aria-label="Priced from"><option value="silver">Silver spot</option><option value="gold">Gold spot</option>
      <option value="platinum">Platinum spot</option><option value="">Price per gram</option></select></td>
    <td class="num"><input type="number" data-m="purity" min="0" max="1" step="0.001" placeholder="0.925" aria-label="Purity"></td>
    <td class="num"><div class="unit-field"><input type="number" data-m="premium" min="0" step="1" placeholder="0" aria-label="Premium over spot"><span class="unit">%</span></div></td>
    <td class="num"><div class="unit-field"><span class="unit">$</span><input type="number" data-m="per_gram" min="0" step="0.01" aria-label="Price per gram"></div></td>
    <td><button type="button" class="quiet remove" title="Remove this metal" aria-label="Remove">&times;</button></td>`;
  tr.dataset.id = m.id || '';
  tr.querySelector('[data-m=name]').value = m.name;
  tr.querySelector('[data-m=base]').value = m.base || '';
  tr.querySelector('[data-m=purity]').value = m.purity ?? '';
  tr.querySelector('[data-m=premium]').value = m.premium === '' || m.premium === undefined ? '' : Math.round(m.premium * 1000) / 10;
  tr.querySelector('[data-m=per_gram]').value = m.per_gram ?? '';
  tr.querySelector('.remove').onclick = () => { tr.remove(); updateMetals(); };
  return tr;
}

/** A metal row's fields, as saveSettings takes them. */
function metalFromRow(tr) {
  const base = tr.querySelector('[data-m=base]').value;
  const name = tr.querySelector('[data-m=name]').value;
  if (base) {
    return { id: tr.dataset.id || undefined, name, base, purity: tr.querySelector('[data-m=purity]').value, premium: (Number(tr.querySelector('[data-m=premium]').value) || 0) / 100 };
  }
  return { id: tr.dataset.id || undefined, name, base: null, per_gram: tr.querySelector('[data-m=per_gram]').value };
}

function settingsSpot() {
  return { silver: Number($('sSilver').value) || 0, gold: Number($('sGold').value) || 0, platinum: Number($('sPlatinum').value) || 0 };
}

/** Which fields a metal row needs depends on where its price comes from; the $/g column follows the spot prices. */
function updateMetals() {
  const spot = settingsSpot();
  for (const tr of $('metalRows').children) {
    const m = metalFromRow(tr);
    const fromSpot = !!m.base;
    tr.querySelector('[data-m=purity]').disabled = !fromSpot;
    tr.querySelector('[data-m=premium]').disabled = !fromSpot;
    tr.querySelector('[data-m=per_gram]').disabled = fromSpot;
    if (fromSpot) tr.querySelector('[data-m=per_gram]').value = metalPerGram({ ...m, purity: Number(m.purity) || 0 }, spot).toFixed(4);
  }
}

function tierRows(tiers) {
  const html = [];
  const bands = tiers.filter((t) => t.up_to !== null);
  const last = tiers.find((t) => t.up_to === null) || { factor: 1.4 };
  bands.forEach((t, i) => {
    html.push(`<span>${i === 0 ? 'Up to' : 'then up to'}</span>
      <div class="unit-field"><span class="unit">$</span><input type="number" data-tier="up_to" min="0" step="1" value="${t.up_to}" aria-label="Band ${i + 1} limit"></div>
      <span>marked up</span>
      <div class="unit-field"><span class="unit">&times;</span><input type="number" data-tier="factor" min="0" step="0.1" value="${t.factor}" aria-label="Band ${i + 1} factor"></div>`);
  });
  html.push(`<span>above that</span><span class="muted">everything else</span><span>marked up</span>
    <div class="unit-field"><span class="unit">&times;</span><input type="number" data-tier="last" min="0" step="0.1" value="${last.factor}" aria-label="Top band factor"></div>`);
  return html.join('');
}

function openSettings() {
  const s = state.settings;
  $('sRate').value = s.labor_rate;
  $('sOverhead').value = s.overhead_share === null || s.overhead_share === undefined ? '' : Math.round(s.overhead_share * 1000) / 10;
  $('sOverhead').placeholder = `${pct(state.measuredOverhead)} from BenchClock`;
  $('sMethods').innerHTML = [1, 2, 3].map((id) => `<label><input type="radio" name="sMethod" value="${id}" ${s.default_method === id ? 'checked' : ''}><span>${id}. ${esc(state.methods[id].name)}</span></label>`).join('');
  $('sSilver').value = s.spot.silver;
  $('sGold').value = s.spot.gold;
  $('sPlatinum').value = s.spot.platinum;
  $('metalRows').replaceChildren(...s.metals.map(metalRow));
  updateMetals();
  $('sFactor').value = s.cost_plus.factor;
  $('sMargin2').value = Math.round(s.loaded.margin * 1000) / 10;
  $('tiers').innerHTML = tierRows(s.tiered.tiers);
  $('sStudio').value = s.tiered.studio_per_hour;
  $('sMargin3').value = Math.round(s.tiered.margin * 1000) / 10;
  $('sFees').value = Math.round(s.fees * 1000) / 10;
  $('sRound').value = s.round_to;
  (document.querySelector(`input[name=sRoundMode][value=${s.round_mode || 'up'}]`) || {}).checked = true;
  $('settingsDlg').showModal();
  $('sRate').focus();
}

$('settingsBtn').onclick = openSettings;
$('metalAdd').onclick = () => { const tr = metalRow(); $('metalRows').appendChild(tr); updateMetals(); tr.querySelector('input').focus(); };
$('settingsDlg').addEventListener('input', (ev) => { if (ev.target.closest('#metalRows') || ev.target.closest('.three')) updateMetals(); });
$('settingsCancel').onclick = () => $('settingsDlg').close();
$('settingsForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const tierInputs = [...$('tiers').querySelectorAll('input')];
  const bands = [];
  for (let i = 0; i < tierInputs.length - 1; i += 2) bands.push({ up_to: tierInputs[i].value, factor: tierInputs[i + 1].value });
  bands.push({ up_to: null, factor: tierInputs.at(-1).value });
  await api('saveSettings', {
    labor_rate: $('sRate').value,
    overhead_share: $('sOverhead').value === '' ? null : Number($('sOverhead').value) / 100,
    default_method: Number((document.querySelector('input[name=sMethod]:checked') || {}).value || 2),
    spot: settingsSpot(),
    metals: [...$('metalRows').children].map(metalFromRow),
    cost_plus: { factor: $('sFactor').value },
    loaded: { margin: Number($('sMargin2').value) / 100 },
    tiered: { tiers: bands, studio_per_hour: $('sStudio').value, margin: Number($('sMargin3').value) / 100 },
    fees: Number($('sFees').value) / 100,
    round_to: $('sRound').value,
    round_mode: (document.querySelector('input[name=sRoundMode]:checked') || {}).value || 'up',
  });
  $('settingsDlg').close();
  toast('Settings saved. Every price is worked out afresh.');
});

// ---- export, about, menu -----------------------------------------------

async function exportSheet() {
  const ids = [...selected];
  const result = await api('exportCsv', { ids });
  if (result.file) toast(`Wrote ${result.count} row${result.count === 1 ? '' : 's'} to ${result.file}`);
}
$('exportBtn').onclick = exportSheet;

function openAbout() {
  $('aboutVersion').textContent = `Version ${state.app.version}`;
  $('aboutDetail').textContent = `Free software under the MIT license. Built on Electron ${state.app.electron}. Reads the BenchClock time card in ${state.dataDir}`;
  $('aboutDlg').showModal();
  $('aboutClose').focus();
}
$('aboutClose').onclick = () => $('aboutDlg').close();

const menuActions = { settings: openSettings, export: exportSheet, about: openAbout, reload: () => api('state') };
window.pricebook.onMenu((action) => {
  if (document.querySelector('dialog[open]')) return; // one thing at a time
  menuActions[action]();
});

// ---- start -------------------------------------------------------------

api('state');
// Pick up pieces finished in BenchClock meanwhile when the window is returned to.
window.addEventListener('focus', () => { if (!document.querySelector('dialog[open]')) api('state'); });
