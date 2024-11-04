const { app, Menu, BrowserWindow } = require('electron');
const path = require('path');

if (require('electron-squirrel-startup')) { // eslint-disable-line global-require
  app.quit();
}

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 466,
    minWidth: 466,
    maxWidth: 466,
    height: 466,
    minHeight: 466,
    maxHeight: 466,
    show: false,
    icon: path.join(__dirname, 'assets/img/icon.png'),
    webPreferences: {
      nodeIntegration: true
    },
    transparent: true,
    frame: false
  });

  if (process.env.DEBUG) {
    win.toggleDevTools();
  }

  Menu.setApplicationMenu(null);
  win.loadURL(`file://${__dirname}/index.html`);
  win.on('closed', () => win = null);
  win.once('ready-to-show', () => win.show());
};

app.on('ready', () => setTimeout(createWindow, 400));
app.on('window-all-closed', () => app.quit());

