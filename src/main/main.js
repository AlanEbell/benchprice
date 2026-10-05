'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage, net, protocol, shell } = require('electron');

const { PriceBook, PricingError, METHODS, PIECE_TYPES, totals } = require('../core/pricing.js');
const { buildReportHtml, coversLabel } = require('./report.js');
const spot = require('../core/spot.js');
const { version, homepage } = require('../../package.json');

const PHOTO_NAME = /^[0-9a-f]{16}\.jpg$/;
const dataDirArg = process.argv.find((arg) => arg.startsWith('--data-dir='));
let book;
let mainWindow;

protocol.registerSchemesAsPrivileged([{ scheme: 'bench-photo', privileges: { secure: true } }]);

function buildState({ includeBench = false } = {}) {
  const settings = book.settings();
  return {
    hasBenchClock: book.hasBenchClock(),
    settings,
    measuredOverhead: book.measuredOverheadShare(),
    overheadShare: book.overheadShare(settings),
    groups: book.listGroups({ includeBench }),
    methods: METHODS,
    pieceTypes: PIECE_TYPES,
    dataDir: book.dataDir,
    app: { version, electron: process.versions.electron },
  };
}

let includeBench = false; // remembered for the state sent back after every call

/** For the names of saved files: "ticked from 2026-09-07 to 2026-09-13", or today's date when there is nothing to say. */
function fileWords({ scope, period }) {
  const words = [scope !== 'finished' && scope, period.from && `from ${period.from}`, period.to && `to ${period.to}`].filter(Boolean);
  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return words.length ? words.join(' ') : `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
}

/** Lay the report out in a hidden window and print that to a PDF file. `choice` is what chooseLines takes; leave it out for every finished piece. */
async function writeReportPdf(file, choice = {}) {
  const { scope, period, lines } = book.chooseLines(choice);
  const settings = book.settings();
  const html = buildReportHtml({ lines, settings, overheadShare: book.overheadShare(settings), scope, period, photosDir: book.photosDir });
  const page = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'benchprice-report-')), 'report.html');
  fs.writeFileSync(page, html, 'utf8');
  const printer = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  try {
    await printer.loadFile(page);
    const letter = ['US', 'CA', 'MX'].includes(app.getLocaleCountryCode());
    const small = 'font-size:8px; color:#776d62; width:100%; padding:0 14mm;';
    fs.writeFileSync(file, await printer.webContents.printToPDF({
      pageSize: letter ? 'Letter' : 'A4', printBackground: true,
      margins: { top: 0.6, bottom: 0.7, left: 0.55, right: 0.55 }, // inches
      displayHeaderFooter: true, headerTemplate: '<span></span>',
      footerTemplate: `<div style="${small} display:flex; justify-content:space-between;"><span>BenchPrice price report \u00b7 ${coversLabel(scope, period)}</span>` +
        '<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>',
    }));
  } finally {
    printer.destroy();
    fs.rmSync(path.dirname(page), { recursive: true, force: true });
  }
}

const api = {
  state: ({ includeBench: wanted } = {}) => { if (wanted !== undefined) includeBench = !!wanted; return null; },
  saveSettings: (changes) => book.saveSettings(changes),
  savePricing: ({ id, ...changes }) => book.savePricing(id, changes),
  confirmPrice: ({ id, ...changes }) => book.confirmPrice(id, changes),
  clearPricing: ({ id }) => { book.clearPricing(id); book.syncGroupNames(); },
  sendBack: ({ ids }) => book.sendBack(ids),
  addPiece: (piece) => book.addPiece(piece),
  setGroups: ({ id, letters, names }) => book.setGroups(id, letters, names),
  fetchSpot: () => spot.fetchSpot({ fetch: net.fetch }), // Electron's fetch follows the system's proxy
  /** Fetched and saved in one go, as the app starts when Settings says to. */
  async updateSpot() {
    const live = await spot.fetchSpot({ fetch: net.fetch });
    book.saveSettings({ spot: live.spot, spot_fetched: { at: live.at, source: live.source } });
    return live;
  },

  /** What the choices in the report box come to, before anything is saved. */
  exportPreview: (choice) => totals(book.chooseLines(choice).lines),

  async exportCsv(choice) {
    const chosen = book.chooseLines(choice);
    if (!chosen.lines.length) throw new PricingError('Nothing to export.');
    const picked = await dialog.showSaveDialog(mainWindow, {
      title: 'Export CSV', defaultPath: path.join(app.getPath('documents'), `BenchPrice ${fileWords(chosen)}.csv`),
      filters: [{ name: 'CSV file', extensions: ['csv'] }],
    });
    if (picked.canceled) return { file: null };
    return { file: picked.filePath, count: book.exportCsv(picked.filePath, chosen.lines.map((g) => g.id)) };
  },

  async exportReport(choice) {
    const picked = await dialog.showSaveDialog(mainWindow, {
      title: 'Save price report', defaultPath: path.join(app.getPath('documents'), `BenchPrice report ${fileWords(book.chooseLines(choice))}.pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (picked.canceled) return { file: null };
    await writeReportPdf(picked.filePath, choice);
    shell.openPath(picked.filePath); // show it straight away in the computer's PDF viewer
    return { file: picked.filePath };
  },

  openDataFolder: () => { shell.openPath(book.pricingDir); },
  openHomepage: () => { if (homepage) shell.openExternal(homepage); },
  openBenchClockPage: () => { shell.openExternal('https://github.com/AlanEbell/benchclock'); },
};

ipcMain.handle('api', async (event, method, payload) => {
  try {
    if (!Object.hasOwn(api, method)) throw new PricingError(`Unknown request: ${method}`);
    const result = await api[method](payload || {});
    return { ok: true, result: result ?? null, state: buildState({ includeBench }) };
  } catch (error) {
    if (error instanceof PricingError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: `Something went wrong: ${error.message}` };
  }
});

const windowIcon = () => nativeImage.createFromBuffer(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'icon.png')));

function buildMenu() {
  const mac = process.platform === 'darwin';
  const toPage = (action) => () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.webContents.send('menu', action);
  };
  const line = { type: 'separator' };
  const about = { label: 'About BenchPrice', click: toPage('about') };
  const help = { label: 'How BenchPrice works', accelerator: 'F1', click: toPage('help') };
  return Menu.buildFromTemplate([
    ...(mac ? [{ label: app.name, submenu: [about, line, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, line, { role: 'quit' }] }] : []),
    {
      label: '&File',
      submenu: [
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: toPage('settings') },
        { label: 'Report or export…', accelerator: 'CmdOrCtrl+P', click: toPage('report') },
        line,
        { label: 'Open the pricing folder', click: () => { shell.openPath(book.pricingDir); } },
        ...(mac ? [] : [line, { role: 'quit' }]),
      ],
    },
    { label: '&Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, line, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    {
      label: '&View',
      submenu: [
        { label: 'Reload from BenchClock', accelerator: 'F5', click: toPage('reload') }, line,
        { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, line, { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [line, { role: 'reload' }, { role: 'toggleDevTools' }]),
      ],
    },
    { label: '&Help', role: 'help', submenu: mac ? [help] : [help, line, about] },
  ]);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040, height: 860, minWidth: 680, minHeight: 520, show: false,
    title: 'BenchPrice', backgroundColor: '#f5f1e8', icon: windowIcon(),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(() => {
    book = new PriceBook(dataDirArg ? dataDirArg.slice('--data-dir='.length) : undefined);
    book.syncGroupNames(); // for sets divided before groups were called after their prices
    protocol.handle('bench-photo', (request) => {
      const name = new URL(request.url).pathname.replace(/^\//, '');
      const file = path.join(book.photosDir, name);
      if (!PHOTO_NAME.test(name) || !fs.existsSync(file)) return new Response('', { status: 404 });
      return new Response(fs.readFileSync(file), { headers: { 'content-type': 'image/jpeg' } });
    });
    Menu.setApplicationMenu(buildMenu());
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => app.quit());
}

module.exports = { writeReportPdf }; // for scripts/smoke.js
