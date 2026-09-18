'use strict';
// The only bridge between the window and the rest of the computer. The page itself
// runs sandboxed, with no access to files or Node.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pricebook', {
  call: (method, payload) => ipcRenderer.invoke('api', method, payload),
  onMenu: (handler) => { ipcRenderer.on('menu', (event, action) => handler(action)); },
});
