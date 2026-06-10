// ТИТРИ — десктоп-обёртка: поднимает продакшен-сервер Next.js
// внутри Electron и открывает его в нативном окне.
const { app, BrowserWindow, shell, dialog, ipcMain } = require("electron");
const { createServer } = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");

// единственный экземпляр приложения
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const APP_DIR = path.join(__dirname, "..");
const BASE_PORT = 3210;

// данные (workspace) — в профиле пользователя, когда приложение упаковано
if (app.isPackaged) {
  process.env.TYTRY_WORKSPACE = path.join(app.getPath("userData"), "workspace");
}
process.env.TYTRY_APP_DIR = APP_DIR;

let mainWindow = null;

function findFreePort(start) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", () => {
      if (start > BASE_PORT + 20) reject(new Error("No free port found"));
      else resolve(findFreePort(start + 1));
    });
    srv.once("listening", () => {
      srv.close(() => resolve(start));
    });
    srv.listen(start, "127.0.0.1");
  });
}

async function startNextServer() {
  if (!fs.existsSync(path.join(APP_DIR, ".next", "BUILD_ID"))) {
    dialog.showErrorBox(
      "TYTRY — no build found",
      'Run "npm run build" in the project folder first (or use ТИТРИ.bat — it builds automatically).'
    );
    app.quit();
    return null;
  }

  process.env.NODE_ENV = "production";
  const next = require(path.join(APP_DIR, "node_modules", "next"));
  const nextApp = next({ dev: false, dir: APP_DIR });
  const handle = nextApp.getRequestHandler();
  await nextApp.prepare();

  const port = await findFreePort(BASE_PORT);
  await new Promise((resolve) => {
    createServer((req, res) => handle(req, res)).listen(port, "127.0.0.1", resolve);
  });
  return port;
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1680,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#0a0b0d",
    autoHideMenuBar: true,
    title: "ТИТРИ",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());

  // внешние ссылки — в системный браузер
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}`);
}

ipcMain.handle("pick-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle("show-in-folder", async (_event, filePath) => {
  if (typeof filePath === "string" && fs.existsSync(filePath)) {
    shell.showItemInFolder(filePath);
  }
});

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  // первая попытка может упасть, пока антивирус сканирует свежие файлы — пробуем ещё раз
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const port = await startNextServer();
      if (port) createWindow(port);
      return;
    } catch (err) {
      const message = String(err?.stack ?? err);
      try {
        fs.appendFileSync(
          path.join(os.tmpdir(), "tytry-error.log"),
          `[${new Date().toISOString()}] attempt ${attempt}\n${message}\n\n`
        );
      } catch {
        // ignore
      }
      if (attempt === 3) {
        dialog.showErrorBox("TYTRY — startup error", message);
        app.quit();
      } else {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
});

app.on("window-all-closed", () => {
  app.quit();
});
