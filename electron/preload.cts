const { contextBridge, ipcRenderer } = require('electron');
const { createElectronApi } = require('./preload-api.js');

contextBridge.exposeInMainWorld('electronAPI', createElectronApi(ipcRenderer));
