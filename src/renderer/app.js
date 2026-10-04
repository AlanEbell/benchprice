'use strict';
/* global iconSvg, price, metalPerGram, METHODS, helpHtml */
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
const dollars = (n) => (Number.isInteger(Number(n)) ? money0(n) : money(n)); // $32, or $61.10: never $61.1
const pct = (share) => `${Math.round(share * 1000) / 10}%`;
const fmtWhen = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
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
    <span class="fact"><small>Spot</small> <b>${dollars(s.spot.silver)}</b> silver, <b>${dollars(s.spot.gold)}</b> gold, <b>${dollars(s.spot.platinum)}</b> platinum <small>per troy oz${s.spot_fetched ? `, from ${esc(s.spot_fetched.source)} ${fmtWhen(s.spot_fetched.at)}` : ''}</small></span>
    ${chips.join('')}`;
}

const STATUS = { finished: 'finished', part_finished: 'finished', in_progress: 'on the bench', not_started: 'not started' };

/** "pieces 1 and 3 of the set": a group's pieces, by the numbers on their labels. */
function whichOf(p) {
  const nos = p.pieces.map((i) => p.of_set.pieces.find((w) => w.id === i.id).number);
  return `piece${nos.length === 1 ? '' : 's'} ${nos.length > 1 ? `${nos.slice(0, -1).join(', ')} and ${nos.at(-1)}` : nos[0]} of the set`;
}

function rowHtml(p) {
  const finished = p.finished > 0;
  const meta = [
    p.group ? `${whichOf(p)}, ${!p.set ? 'priced apart' : p.status === 'part_finished' ? `${p.finished} of ${p.quantity} finished, one price` : 'one price'}` :
      p.set && (p.status === 'part_finished' ? `a set: ${p.finished} of ${p.quantity} finished, one price` : 'a set, one price'),
    finished ? `finished ${fmtDay(p.finished_at)}` : STATUS[p.status],
    p.sku && `SKU ${esc(p.sku)}`,
    p.priced.metal ? `${p.priced.weight_grams} g ${esc(p.priced.metal.name)}` : (p.priced.weight_grams ? `${p.priced.weight_grams} g` : ''),
    p.priced.components.length && `${p.priced.components.length} bought-in item${p.priced.components.length === 1 ? '' : 's'} ${money(p.priced.components_cost)}`,
    p.pricing.notes && esc(p.pricing.notes),
  ].filter(Boolean).join(' &middot; ');
  const qty = p.quantity > 1 ? `<span class="qty">&times;${p.quantity}</span>` : '';
  const hand = p.priced.by_hand;
  const c = p.priced.confirmed;
  // Three method figures, then the price that counts: confirmed (and whether it has moved since), or by hand, or the method's, unconfirmed.
  const last = c ? `<span class="m chosen confirmed ${p.priced.moved ? 'moved' : ''}"><small>Confirmed${p.priced.moved ? `, now ${money0(p.priced.live_price)}` : ''}</small>${money0(c.price)}</span>` :
    hand ? `<span class="m chosen hand"><small>Set by hand, unconfirmed</small>${money0(p.priced.price)}</span>` : '';
  const prices = p.priced.complete ?
    [1, 2, 3].map((m) => `<span class="m ${!c && !hand && p.priced.method === m ? 'chosen unconfirmed' : ''}"><small>${esc(state.methods[m].name)}${
      !c && !hand && p.priced.method === m ? ', unconfirmed' : ''}</small>${money0(p.priced.methods[m].price)}</span>`).join('') + last :
    `<span class="m none" style="grid-column: span 3">no weight or materials yet</span>`;
  return `<div class="row ${selected.has(p.id) ? 'selected' : ''}" data-id="${esc(p.id)}">
    <input type="checkbox" data-act="select" aria-label="Select ${esc(p.label)}" ${selected.has(p.id) ? 'checked' : ''}>
    ${tile(p)}
    <div class="name"><b>${esc(p.label)}</b>${qty}<div class="meta">${fmtDur(p.seconds_per_piece)}${p.set ? ' each' : ''} &middot; ${meta}</div></div>
    <div class="prices ${last ? 'by-hand' : ''}">${prices}</div>
    <div class="acts"><button class="quiet go" data-act="price">Price</button>${
      p.of_set ? '<button class="quiet" data-act="groups" title="Different stones in one set? Divide it into groups priced apart">Groups</button>' : ''}${
      finished ? '<button class="quiet" data-act="back" title="Finished by mistake? Send it back to the bench in BenchClock">Not finished</button>' : ''}</div>
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
      `BenchPrice reads the pieces from BenchClock's time card, and there isn't one on this computer yet. Install BenchClock, clock some work on a piece and finish it, then come back.
       <div class="actions" style="justify-content:center"><button type="button" id="getBenchClock">Get BenchClock</button></div>`}</div>`;
  if ($('getBenchClock')) $('getBenchClock').onclick = () => api('openBenchClockPage');
  const count = list.reduce((n, g) => n + g.quantity, 0);
  $('pieceCount').textContent = list.length ? `${pieces(count)}${count !== list.length ? ` in ${list.length} set${list.length === 1 ? '' : 's'} or single${list.length === 1 ? '' : 's'}` : ''}` : '';
  $('selCount').textContent = selected.size ? `${selected.size} ticked` : '';
  $('clearSel').hidden = !selected.size;
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
  else if (target.dataset.act === 'groups') openGroups(piece);
  else if (target.dataset.act === 'back') sendBack(piece);
});
$('clearSel').onclick = () => { selected.clear(); render(); };
$('showBench').onchange = () => api('state', { includeBench: $('showBench').checked });
$('dataDir').onclick = () => api('openDataFolder');

/** A yes/no question in the app's own style. Resolves true for yes. */
function ask(title, text, yesLabel) {
  $('askTitle').textContent = title;
  $('askText').textContent = text;
  $('askYes').textContent = yesLabel;
  $('askDlg').showModal();
  $('askNo').focus();
  return new Promise((resolve) => {
    const done = (answer) => { $('askDlg').close(); resolve(answer); };
    $('askYes').onclick = () => done(true);
    $('askNo').onclick = () => done(false);
    $('askDlg').oncancel = () => resolve(false);
  });
}

// ---- adding a piece that never went through BenchClock -----------------

function openAdd() {
  $('addForm').reset();
  $('aType').innerHTML = state.pieceTypes.map((t) => `<option value="${esc(t.id)}">${esc(t.label)}</option>`).join('');
  $('aType').value = 'other';
  $('aFinished').value = dayStr(new Date());
  $('aFinished').max = dayStr(new Date());
  $('addDlg').showModal();
  $('aName').focus();
}
$('addBtn').onclick = openAdd;
$('addCancel').onclick = () => $('addDlg').close();
$('addForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const added = await api('addPiece', {
    name: $('aName').value, type: $('aType').value, quantity: $('aQuantity').value, hours: $('aHours').value,
    finished_on: $('aFinished').value, sku: $('aSku').value, notes: $('aNotes').value,
  });
  $('addDlg').close();
  const line = findPiece(added.id);
  if (line) openPiece(line); // straight on to its metal, weight and price
});

// ---- sending a piece back to the bench ---------------------------------

let returning = null; // the set in the box

async function sendBackIds(piece, ids) {
  const back = await api('sendBack', { ids });
  toast(back.length === 1 && !piece.set ? `${piece.label} is back on the bench in BenchClock.` :
    `${pieces(back.length)} of ${piece.name} ${back.length === 1 ? 'is' : 'are'} back on the bench in BenchClock.`);
}

/** A piece finished by mistake: straight back if it stands alone, or a choice of which ones from a set. */
async function sendBack(piece) {
  const done = piece.pieces.filter((i) => i.status === 'finished');
  if (done.length > 1) {
    returning = piece;
    $('backTitle').textContent = `${piece.name}: which ones are not finished?`;
    $('backRows').innerHTML = done.map((i) => `<label class="choice"><input type="checkbox" data-id="${esc(i.id)}">
      <span class="who">${esc(i.label)}</span><span class="have">${fmtDur(i.total_seconds)} &middot; finished ${fmtDay(i.finished_at)}</span></label>`).join('');
    $('backSave').disabled = true;
    $('backDlg').showModal();
    return;
  }
  const kept = piece.pricing.updated_at ? ' What you entered for its price is kept.' : '';
  if (await ask(`Send ${piece.label} back to the bench?`,
    `It goes back on the bench in BenchClock with all its time, to be finished again when it is really done.${kept}`, 'Send back')) {
    await sendBackIds(piece, done.map((i) => i.id));
  }
}

const backTicked = () => [...document.querySelectorAll('#backRows input:checked')].map((box) => box.dataset.id);
$('backRows').addEventListener('change', () => { $('backSave').disabled = !backTicked().length; });
$('backCancel').onclick = () => $('backDlg').close();
$('backForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const ids = backTicked();
  if (!ids.length) return;
  await sendBackIds(returning, ids);
  $('backDlg').close();
});

// ---- dividing a set into groups ----------------------------------------

let grouping = null; // the set in the box: its id, name, pieces and the lines it is in now

const groupPicks = () => Object.fromEntries([...document.querySelectorAll('#groupRows input:checked')].map((radio) => [radio.dataset.id, radio.value]));

function updateGroups() {
  const counts = {};
  for (const letter of Object.values(groupPicks())) counts[letter] = (counts[letter] || 0) + 1;
  const used = Object.keys(counts).sort();
  $('groupsNote').textContent = used.length > 1 ?
    `${used.length} groups, each priced on its own: ${used.map((letter) => `${letter} with ${pieces(counts[letter])}`).join(', ')}.` :
    `All on one letter: ${grouping.name} is one set with one price.`;
}

function openGroups(piece) {
  const set = piece.of_set;
  grouping = { id: set.id, name: piece.name, pieces: set.pieces, lines: set.lines };
  // as many letters as there are pieces, so each can stand alone
  const letters = [...new Set([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.slice(0, set.pieces.length), ...set.pieces.map((i) => i.group).filter(Boolean)])].sort();
  $('groupsTitle').textContent = `${piece.name}: groups priced apart`;
  $('groupRows').innerHTML = set.pieces.map((i) => `<div class="choice"><span class="who">${esc(i.label)}</span>
    <span class="have">${fmtDur(i.total_seconds)} &middot; ${STATUS[i.status]}</span>
    <span class="segmented" role="radiogroup" aria-label="Group of ${esc(i.label)}">${letters.map((letter) =>
      `<label><input type="radio" name="group-${esc(i.id)}" data-id="${esc(i.id)}" value="${letter}" ${(i.group || 'A') === letter ? 'checked' : ''}><span>${letter}</span></label>`).join('')}</span></div>`).join('');
  updateGroups();
  $('groupsDlg').showModal();
}

$('groupRows').addEventListener('change', updateGroups);
$('groupsCancel').onclick = () => $('groupsDlg').close();
$('groupsForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const letters = groupPicks();
  const split = new Set(Object.values(letters)).size > 1;
  const next = Object.fromEntries(grouping.pieces.map((i) => [i.id, split ? `${grouping.id}-${letters[i.id]}` : grouping.id])); // the line each piece lands on
  if (grouping.pieces.every((i) => next[i.id] === i.line)) { $('groupsDlg').close(); return; } // nothing moved
  // A new group starts with a copy of what was entered where its first piece was; a line left with no pieces is forgotten.
  const started = new Set(grouping.lines.map((line) => line.id));
  const carried = new Set();
  for (const i of grouping.pieces) if (!started.has(next[i.id])) { started.add(next[i.id]); carried.add(i.line); }
  const gone = grouping.lines.filter((line) => !Object.values(next).includes(line.id));
  const called = (line) => (line.group ? `group ${line.group}` : 'the set');
  const warnings = [
    ...gone.filter((line) => line.entered && !carried.has(line.id)).map((line) => `What was entered for ${called(line)} is forgotten.`),
    ...gone.filter((line) => line.confirmed !== null).map((line) => `The confirmed price of ${money0(line.confirmed)} for ${called(line)} is dropped, to be confirmed again.`),
  ];
  if (warnings.length && !(await ask(`Change the groups of ${grouping.name}?`, warnings.join(' '), 'Change groups'))) return;
  const done = await api('setGroups', { id: grouping.id, letters });
  $('groupsDlg').close();
  toast(done.split ? `${grouping.name} is in ${done.groups.length} groups, ${done.groups.join(', ')}, each with a line of its own.` : `${grouping.name} is one set with one price again.`);
});

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
    add_premium: $('pPremium').checked,
    components: [...$('partRows').children].map((tr) => ({
      name: tr.querySelector('[data-part=name]').value,
      quantity: Number(tr.querySelector('[data-part=quantity]').value) || 0,
      unit_cost: Number(tr.querySelector('[data-part=unit_cost]').value) || 0,
    })),
    method: $('pMethod').value === '' ? null : Number($('pMethod').value),
    manual_price: $('pManual').value === '' ? null : Number($('pManual').value),
    notes: $('pNotes').value,
  };
}

function updatePiece() {
  const draft = pieceDraft();
  // the premium only means something for a metal priced from spot
  const picked = state.settings.metals.find((m) => m.id === draft.metal);
  $('pPremiumRow').hidden = !(picked && picked.base);
  if (picked && picked.base) {
    $('pPremiumText').textContent = `Add the supplier's premium over spot: ${pct(picked.premium || 0)}, ` +
      `${money(metalPerGram(picked, state.settings.spot))}/g instead of ${money(metalPerGram(picked, state.settings.spot, false))}/g`;
  }
  const p = price(editing, draft, state.settings, state.overheadShare);
  for (const tr of $('partRows').children) {
    const q = Number(tr.querySelector('[data-part=quantity]').value) || 0;
    const u = Number(tr.querySelector('[data-part=unit_cost]').value) || 0;
    tr.querySelector('.total').textContent = q * u ? money(q * u) : '';
  }
  const line = (label, value, extra = '') => `<div class="line ${extra}"><span>${label}</span><span>${value}</span></div>`;
  $('breakdown').innerHTML =
    line(`Metal${p.metal ? `: ${p.weight_grams} g of ${esc(p.metal.name)} at ${money(p.metal.per_gram)}/g${p.metal.premium ? `, with the ${pct(p.metal.premium)} premium` : ''}` : ''}`, money(p.metal_cost)) +
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
  $('methodCards').classList.toggle('overridden', p.by_hand);
  $('byHandNote').hidden = !p.by_hand;
  if (p.by_hand) {
    $('byHandNote').textContent = `Set by hand: ${money(p.price)} a piece. ${state.methods[chosen].name} would say ${money0(p.methods[chosen].price)}.`;
  }
  const live = p.price;
  $('pieceConfirm').textContent = p.complete ? `Confirm ${money0(live)}${editing.set ? ' each' : ''}` : 'Confirm price';
  $('pieceConfirm').disabled = !p.complete;
  const c = editing.pricing.confirmed;
  $('confirmedNote').hidden = !c;
  if (c) {
    const when = new Date(c.at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    const same = c.price === live;
    $('confirmedNote').classList.toggle('moved', !same);
    $('confirmedNote').innerHTML = `<b>Confirmed at ${money(c.price)}</b>${editing.set ? ' a piece' : ''} on ${when}, ${esc(c.method_name.toLowerCase())}.` +
      (same ? ' The figures below still come to the same.' : ` The figures below now come to <b>${money0(live)}</b>. Press Confirm to reprice, or Cancel to keep ${money0(c.price)}.`);
  }
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
    `${piece.group ? `Group ${piece.group}, ${whichOf(piece)}: these carry one price.` : `A set of ${piece.quantity}: every piece carries the same price.`} ` +
      `${fmtDur(piece.seconds_per_piece)} of making time each, the average from BenchClock over ` +
      `${piece.finished ? `the ${piece.finished} finished` : 'all of them, none finished yet'}. Everything below is per piece.` :
    `${piece.group ? `Group ${piece.group}, ${whichOf(piece)}, priced apart from the others. ` : ''}${fmtDur(piece.seconds_per_piece)} of making time from BenchClock${piece.finished ? `, finished ${fmtDay(piece.finished_at)}` : ', still on the bench'}. Everything below is per piece.`;
  $('pMetal').innerHTML = '<option value="">No metal</option>' + s.metals.map((m) =>
    `<option value="${esc(m.id)}">${esc(m.name)} (${money(metalPerGram(m, s.spot))}/g)</option>`).join('');
  $('pMetal').value = piece.pricing.metal || '';
  $('pWeight').value = piece.pricing.weight_grams || '';
  $('pPremium').checked = piece.pricing.add_premium !== false;
  $('partRows').replaceChildren(...piece.pricing.components.map(partRow));
  $('pMethod').innerHTML = `<option value="">Default: ${esc(state.methods[s.default_method].name)}</option>` +
    [1, 2, 3].map((id) => `<option value="${id}">${id}. ${esc(state.methods[id].name)}</option>`).join('');
  $('pMethod').value = piece.pricing.method || '';
  $('pManual').value = piece.pricing.manual_price ?? '';
  $('pNotes').value = piece.pricing.notes || '';
  $('pieceClear').hidden = !piece.pricing.updated_at; // nothing entered yet, nothing to clear
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
$('pieceClear').onclick = async () => {
  const what = editing.set && !editing.group ? `the set of ${editing.quantity} \u00d7 ${editing.name}` : editing.label;
  if (await ask(`Clear the pricing of ${what}?`, 'Its metal, weight, materials, method and any price set by hand are forgotten. The time from BenchClock stays.', 'Clear')) {
    await api('clearPricing', { id: editing.id });
    $('pieceDlg').close();
    toast(`${editing.label} is back to the start.`);
  }
};
$('pieceForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  await api('savePricing', { id: editing.id, ...pieceDraft() });
  $('pieceDlg').close();
  const p = findPiece(editing.id);
  toast(p && p.priced.confirmed ? `${p.label} saved. Its confirmed price is still ${money0(p.priced.confirmed.price)}.` : `${editing.label} saved, not yet confirmed.`);
});
$('pieceConfirm').onclick = async () => {
  const done = await api('confirmPrice', { id: editing.id, ...pieceDraft() });
  $('pieceDlg').close();
  toast(`${editing.label}${editing.set ? ` (each of ${editing.quantity})` : ''} confirmed at ${money0(done.price)}, ${done.method_name.toLowerCase()}. It is written in the piece's file.`);
};

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
  $('sAutoSpot').checked = s.auto_spot === true;
  fetchedSpot = null;
  spotNote('');
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

let fetchedSpot = null; // what Fetch live prices last put in the fields of the open settings box

function spotNote(text, bad = false) {
  $('spotNote').textContent = text;
  $('spotNote').classList.toggle('bad', bad);
}

/** Today's spot prices from the internet into the three fields, to be looked over: nothing is saved until Save. */
$('spotFetch').onclick = async () => {
  $('spotFetch').disabled = true;
  spotNote('Fetching\u2026');
  const reply = await window.pricebook.call('fetchSpot'); // not api(): a failure belongs in the box, beside the button
  $('spotFetch').disabled = false;
  if (!reply.ok) { spotNote(reply.error, true); return; }
  fetchedSpot = reply.result;
  const { spot, source, at } = fetchedSpot;
  $('sSilver').value = spot.silver;
  $('sGold').value = spot.gold;
  $('sPlatinum').value = spot.platinum;
  updateMetals();
  spotNote(`From ${source}, as of ${fmtWhen(at)}. Press Save to price with them.`);
};

/** As the app starts, when Settings says to: today's spot prices fetched and saved in one go. */
async function autoSpot() {
  try {
    const { spot, source } = await api('updateSpot');
    toast(`Spot prices from ${source}: ${money(spot.silver)} silver, ${money(spot.gold)} gold, ${money(spot.platinum)} platinum.`);
  } catch (error) {
    toast(`${error.message} The prices here use the spot prices saved last.`);
  }
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
    // still as fetched, or typed over since
    spot_fetched: fetchedSpot && ['silver', 'gold', 'platinum'].every((base) => settingsSpot()[base] === fetchedSpot.spot[base]) ? { at: fetchedSpot.at, source: fetchedSpot.source } : undefined,
    auto_spot: $('sAutoSpot').checked,
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

// ---- help ---------------------------------------------------------------

/** The help page (help.js), written afresh each time from the settings as they stand. */
function openHelp() {
  $('helpBody').innerHTML = helpHtml(state);
  $('helpDlg').showModal();
  $('helpBody').scrollTop = 0;
  $('helpClose').focus();
}
$('helpBtn').onclick = openHelp;
$('helpClose').onclick = () => $('helpDlg').close();

// ---- price report -------------------------------------------------------
// The same box as BenchClock's Report or export: which pieces, which days, then a PDF or a CSV.

const REPORT_PRESETS = [['this-week', 'This week'], ['last-week', 'Last week'], ['this-month', 'This month'],
  ['last-month', 'Last month'], ['this-year', 'This year'], ['all-time', 'All time']];
const dayStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtDate = (day) => new Date(`${day}T12:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

/** The day weeks start on where this computer is set up for: 0 is Sunday, 1 Monday. */
function weekStartsOn() {
  try {
    const locale = new Intl.Locale(navigator.language);
    return (locale.getWeekInfo ? locale.getWeekInfo() : locale.weekInfo).firstDay % 7;
  } catch { return 0; }
}

function presetDates(id) {
  const today = new Date();
  const [y, m, d] = [today.getFullYear(), today.getMonth(), today.getDate()];
  const week = d - (today.getDay() - weekStartsOn() + 7) % 7; // day of the month this week began; Date copes with 0 and below
  const span = (from, to) => ({ from: dayStr(from), to: dayStr(to) });
  if (id === 'this-week') return span(new Date(y, m, week), new Date(y, m, week + 6));
  if (id === 'last-week') return span(new Date(y, m, week - 7), new Date(y, m, week - 1));
  if (id === 'this-month') return span(new Date(y, m, 1), new Date(y, m + 1, 0));
  if (id === 'last-month') return span(new Date(y, m - 1, 1), new Date(y, m, 0));
  if (id === 'this-year') return span(new Date(y, 0, 1), new Date(y, 11, 31));
  return { from: '', to: '' };
}

// The days are remembered as "last week", not as dates, so next week it means next week's last week.
const remembered = (key, fallback) => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
const remember = (key, value) => { try { localStorage.setItem(key, value); } catch { /* a nicety, not a need */ } };
let reportPreset = remembered('reportPreset', 'all-time'); // null while the dates are the user's own
let reportScope = remembered('reportScope', 'finished');
const REPORT_SCOPES = [['finished', 'Finished'], ['ticked', 'Ticked'], ['bench', 'On the bench'], ['all', 'Everything']];

const reportChoice = () => ({ scope: reportScope, ids: [...selected], from: $('repFrom').value, to: $('repTo').value });

async function updateReport() {
  const { from, to } = reportChoice();
  const match = REPORT_PRESETS.find(([id]) => presetDates(id).from === from && presetDates(id).to === to);
  reportPreset = match ? match[0] : null;
  for (const button of $('reportPresets').children) button.setAttribute('aria-pressed', button.dataset.preset === reportPreset);
  for (const button of $('reportScopes').children) {
    const id = button.dataset.scope;
    button.setAttribute('aria-pressed', id === reportScope);
    if (id === 'ticked') {
      button.disabled = !selected.size;
      button.textContent = selected.size ? `Ticked (${selected.size})` : 'Ticked';
      button.title = selected.size ? '' : 'Tick lines on the list first, then come back here';
    }
  }
  const ranged = !!from || !!to;
  const days = from && to ? (from === to ? `Finished on ${fmtDate(from)}` : `Finished ${fmtDate(from)} to ${fmtDate(to)}`) :
    from ? `Finished since ${fmtDate(from)}` : to ? `Finished up to ${fmtDate(to)}` : 'All time';
  const backwards = !!from && !!to && from > to;
  let text = '"From" has to be on or before "To".';
  let empty = false;
  if (!backwards) {
    const found = await api('exportPreview', reportChoice());
    empty = !found.lines;
    text = empty ? `${days}: nothing to report.${ranged ? ' A line is left out unless a piece of it was finished on these days, so nothing still on the bench is here.' : ''}` :
      `${days}: ${pieces(found.pieces)}${found.pieces !== found.lines ? ` in ${found.lines} set${found.lines === 1 ? '' : 's or singles'}` : ''},
       ${fmtDur(found.seconds)} of making, ${money(found.materials)} of materials, ${money0(found.value)} at their prices${
        found.unpriced ? `; ${found.unpriced} not priced yet` : ''}.`;
  }
  $('reportSummary').textContent = text.replace(/\s+/g, ' ');
  $('reportSave').disabled = $('reportCsv').disabled = backwards || empty;
}

function openReport() {
  if (reportPreset) ({ from: $('repFrom').value, to: $('repTo').value } = presetDates(reportPreset)); // else: the dates typed last time
  // Lines ticked on the list are most likely what the report is wanted for.
  if (selected.size) reportScope = 'ticked';
  else if (reportScope === 'ticked') reportScope = 'finished';
  $('reportDlg').showModal();
  updateReport();
}

$('reportScopes').innerHTML = REPORT_SCOPES.map(([id, label]) => `<button type="button" data-scope="${id}" aria-pressed="false">${label}</button>`).join('');
$('reportPresets').innerHTML = REPORT_PRESETS.map(([id, label]) => `<button type="button" data-preset="${id}" aria-pressed="false">${label}</button>`).join('');
$('reportScopes').onclick = (ev) => {
  if (!ev.target.dataset.scope) return;
  reportScope = ev.target.dataset.scope;
  updateReport();
};
$('reportPresets').onclick = (ev) => {
  if (!ev.target.dataset.preset) return;
  ({ from: $('repFrom').value, to: $('repTo').value } = presetDates(ev.target.dataset.preset));
  updateReport();
};
$('repFrom').oninput = $('repTo').oninput = updateReport;
$('reportBtn').onclick = openReport;
$('reportCancel').onclick = () => $('reportDlg').close();

async function saveReport(method) {
  $('reportSave').disabled = $('reportCsv').disabled = true;
  try {
    const result = await api(method, reportChoice());
    if (!result.file) return; // backed out of choosing where to save: the choices are still there to change
    remember('reportPreset', reportPreset || '');
    if (reportScope !== 'ticked') remember('reportScope', reportScope);
    $('reportDlg').close();
    toast(method === 'exportCsv' ? `Wrote ${result.count} row${result.count === 1 ? '' : 's'} to ${result.file}` : `Saved the report to ${result.file}`);
  } finally { if ($('reportDlg').open) updateReport(); }
}
$('reportForm').addEventListener('submit', (ev) => { ev.preventDefault(); saveReport('exportReport'); });
$('reportCsv').onclick = () => saveReport('exportCsv');

// ---- about, menu --------------------------------------------------------

function openAbout() {
  $('aboutVersion').textContent = `Version ${state.app.version}`;
  $('aboutDetail').textContent = `Free software under the MIT license. Built on Electron ${state.app.electron}. Reads the BenchClock time card in ${state.dataDir}`;
  $('aboutDlg').showModal();
  $('aboutClose').focus();
}
$('aboutClose').onclick = () => $('aboutDlg').close();

const menuActions = { settings: openSettings, report: openReport, about: openAbout, help: openHelp, reload: () => api('state') };
window.pricebook.onMenu((action) => {
  if (document.querySelector('dialog[open]')) return; // one thing at a time
  menuActions[action]();
});

// ---- start -------------------------------------------------------------

api('state').then(() => { if (state.settings.auto_spot) autoSpot(); });
// Pick up pieces finished in BenchClock meanwhile when the window is returned to.
window.addEventListener('focus', () => { if (!document.querySelector('dialog[open]')) api('state'); });
