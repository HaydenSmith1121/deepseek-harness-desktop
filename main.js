'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const { registerIpc } = require('./main/ipc');

let mainWindow = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    registerIpc({ getWindow: () => mainWindow });
    mainWindow = new BrowserWindow({
      width: 1340,
      height: 880,
      minWidth: 1120,
      minHeight: 720,
      backgroundColor: '#0d1117',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    mainWindow.on('closed', () => { mainWindow = null; });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
