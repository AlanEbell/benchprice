'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage, protocol, shell } = require('electron');

const { PriceBook, PricingError, METHODS } = require('../core/pricing.js');
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
    dataDir: book.dataDir,
    app: { version, electron: process.versions.electron },
  };
}

let includeBench = false; // remembered for the state sent back after every call

const api = {
  state: ({ includeBench: wanted } = {}) => { if (wanted !== undefined) includeBench = !!wanted; return null; },
  saveSettings: (changes) => book.saveSettings(changes),
  savePricing: ({ id, ...changes }) => book.savePricing(id, changes),
  confirmPrice: ({ id, ...changes }) => book.confirmPrice(id, changes),
  clearPricing: ({ id }) => book.clearPricing(id),

  async exportCsv({ ids = [] } = {}) {
    const picked = await dialog.showSaveDialog(mainWindow, {
      title: 'Save price sheet',
      defaultPath: path.join(app.getPath('documents'), `BenchPrice ${new Date().toISOString().slice(0, 10)}.csv`),
      filters: [{ name: 'CSV file', extensions: ['csv'] }],
    });
    if (picked.canceled) return { file: null };
    return { file: picked.filePath, count: book.exportCsv(picked.filePath, ids) };
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
  return Menu.buildFromTemplate([
    ...(mac ? [{ label: app.name, submenu: [about, line, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, line, { role: 'quit' }] }] : []),
    {
      label: '&File',
      submenu: [
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: toPage('settings') },
        { label: 'Save price sheet…', accelerator: 'CmdOrCtrl+S', click: toPage('export') },
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
    ...(mac ? [] : [{ label: '&Help', role: 'help', submenu: [about] }]),
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
