// main.js (CommonJS)
// ✅ Tray app + Settings window
// ✅ SINGLE INSTANCE (evita múltiples apps en segundo plano)
// ✅ Bridge corre como Node dentro del mismo electron.exe (ELECTRON_RUN_AS_NODE=1) → NO duplica
// ✅ Auto-start con Windows (login) + arranque silencioso con --autostart
// ✅ Auto-update (electron-updater) + menú "Check updates" + "Install update"
// ✅ Icon: dev -> app/renderer/icon.ico | instalado -> resources/assets/icon.ico
// ✅ Config: ProgramData si se puede, si no userData (fallback)

const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const fsp = require("fs/promises");
const { spawn } = require("child_process");

// Auto-updater
const { autoUpdater } = require("electron-updater");

let tray = null;
let win = null;
let bridgeProc = null;

const APP_NAME = "Zenter Bridge";
let quitting = false;

// =============================
// Args
// =============================
const argv = process.argv.slice(1);
const isAutoStart = argv.includes("--autostart") || argv.includes("--hidden");

// =============================
// SINGLE INSTANCE
// =============================
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // Si alguien intenta abrir otra instancia, mostramos la existente
    if (win) {
      win.show();
      win.focus();
    }
  });
}

// =============================
// Paths
// =============================
const PROGRAMDATA_DIR = path.join(process.env.ProgramData || "C:\\ProgramData", "ZenterBridge");
const USERDATA_DIR = path.join(app.getPath("userData"), "ZenterBridge");

let CONFIG_DIR = PROGRAMDATA_DIR;
let CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

// Bridge script (dentro del app.asar también existe)
const BRIDGE_PATH = path.join(__dirname, "bridge", "hik_stream_to_supabase.js");

// UI
const UI_DIR = path.join(__dirname, "app", "renderer");
const UI_HTML = path.join(UI_DIR, "index.html");

// Icon path:
// - dev: app/renderer/icon.ico
// - installed: resources/assets/icon.ico  (por extraResources)
function resolveIconPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, "assets", "icon.ico");
  return path.join(UI_DIR, "icon.ico");
}

// =============================
// Config helpers
// =============================
function defaultCfg() {
  return {
    SUPABASE_URL: "",
    SUPABASE_SERVICE_ROLE: "",
    DEVICE_UUID: "",

    HIK_IP: "192.168.20.170",
    HIK_USER: "admin",
    HIK_PASS: "",

    SUPABASE_TABLE: "access_events",
    START_MODE: "now",

    RECONNECT_MS: 1500,
    CURL_VERBOSE: 0,
    FLUSH_INTERVAL_MS: 5000,
    INSERT_CONCURRENCY: 3,

    BRIDGE_ID: os.hostname(),
    HEARTBEAT_MS: 15000,
    HEARTBEAT_TABLE: "access_device_heartbeats",
    BRIDGE_VERSION: `zenter-bridge@${app.getVersion()}`
  };
}

function canWriteDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const testFile = path.join(dir, ".write_test");
    fs.writeFileSync(testFile, "ok", "utf8");
    fs.unlinkSync(testFile);
    return true;
  } catch {
    return false;
  }
}

function resolveConfigLocation() {
  // 1) ProgramData (ideal para perMachine)
  if (canWriteDir(PROGRAMDATA_DIR)) {
    CONFIG_DIR = PROGRAMDATA_DIR;
  } else {
    // 2) fallback a userData
    CONFIG_DIR = USERDATA_DIR;
    try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); } catch {}
  }
  CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
}

function ensureConfig() {
  resolveConfigLocation();
  try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); } catch {}

  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultCfg(), null, 2), "utf8");
  }
}

function readConfig() {
  ensureConfig();
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const cfg = JSON.parse(raw);
    return { ...defaultCfg(), ...cfg };
  } catch (e) {
    dialog.showErrorBox(APP_NAME, `config.json roto o inválido:\n${CONFIG_PATH}\n\n${e.message}`);
    return { ...defaultCfg() };
  }
}

async function writeConfig(cfg) {
  ensureConfig();
  const merged = { ...defaultCfg(), ...(cfg || {}) };

  const tmp = CONFIG_PATH + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(merged, null, 2), "utf8");
  await fsp.rename(tmp, CONFIG_PATH);

  return merged;
}

// =============================
// Auto start on Windows
// =============================
function setupAutoLaunch() {
  // Arranca con Windows (login)
  try {
    const exe = process.execPath; // en instalado es Zenter Bridge.exe
    app.setLoginItemSettings({
      openAtLogin: true,
      path: exe,
      args: ["--autostart"]
    });
  } catch (e) {
    console.error("autoLaunch error:", e.message);
  }
}

// =============================
// Bridge process
// =============================
function isBridgeRunning() {
  return !!(bridgeProc && !bridgeProc.killed);
}

function stopBridge() {
  if (!bridgeProc) return;
  try { bridgeProc.kill(); } catch {}
  bridgeProc = null;
  updateTrayMenu();
  if (win) win.webContents.send("bridge-state", { running: false });
}

function missingCoreFields(cfg) {
  const missing = [];
  if (!cfg.SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!cfg.SUPABASE_SERVICE_ROLE) missing.push("SUPABASE_SERVICE_ROLE");
  if (!cfg.DEVICE_UUID) missing.push("DEVICE_UUID");
  return missing;
}

function startBridge() {
  const cfg = readConfig();

  console.log("CONFIG_PATH =", CONFIG_PATH);
  console.log("CFG(core) =", {
    SUPABASE_URL: cfg.SUPABASE_URL ? "[OK]" : "",
    SUPABASE_SERVICE_ROLE: cfg.SUPABASE_SERVICE_ROLE ? "[OK]" : "",
    DEVICE_UUID: cfg.DEVICE_UUID || ""
  });

  const missing = missingCoreFields(cfg);
  if (missing.length) {
    // Si viene por autostart, NO spamees dialog al usuario
    if (!isAutoStart) {
      dialog.showErrorBox(
        APP_NAME,
        `Faltan settings: ${missing.join(", ")}.\n\nAbre Settings y completa.\n\nConfig file:\n${CONFIG_PATH}`
      );
      if (win) win.show();
    } else {
      console.error("Missing config fields:", missing.join(", "), "|", CONFIG_PATH);
    }
    return;
  }

  if (isBridgeRunning()) return;

  // 🔥 CLAVE: correr el script como Node dentro del electron.exe
  // Esto evita abrir otro "Zenter Bridge" (ventana/instancia) en segundo plano.
  const env = {
    ...process.env,
    ...cfg,
    ZENTER_CONFIG: CONFIG_PATH,
    ELECTRON_RUN_AS_NODE: "1"
  };

  bridgeProc = spawn(process.execPath, [BRIDGE_PATH], {
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  bridgeProc.stdout.on("data", (d) => {
    const s = d.toString("utf8").trim();
    if (s) console.log("[bridge]", s);
    if (win && s) win.webContents.send("bridge-log", s);
  });

  bridgeProc.stderr.on("data", (d) => {
    const s = d.toString("utf8").trim();
    if (s) console.error("[bridge]", s);
    if (win && s) win.webContents.send("bridge-log", "ERR: " + s);
  });

  bridgeProc.on("close", () => {
    bridgeProc = null;
    updateTrayMenu();
    if (win) win.webContents.send("bridge-state", { running: false });
  });

  updateTrayMenu();
  if (win) win.webContents.send("bridge-state", { running: true });
}

function restartBridge() {
  stopBridge();
  setTimeout(() => startBridge(), 400);
}

// =============================
// Window + Tray
// =============================
function createWindow() {
  win = new BrowserWindow({
    width: 900,
    height: 650,
    show: false,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (!fs.existsSync(UI_HTML)) {
    dialog.showErrorBox(
      APP_NAME,
      `No encuentro el UI:\n${UI_HTML}\n\nRevisa que exista: app\\renderer\\index.html`
    );
  } else {
    win.loadFile(UI_HTML);
  }

  // Close = hide (tray app)
  win.on("close", (e) => {
    if (quitting) return; // deja cerrar normal cuando el usuario elige Quit
    e.preventDefault();
    win.hide();
  });
}

let updateState = "idle"; // idle | checking | available | downloading | downloaded | error

function updateTrayMenu() {
  if (!tray) return;

  const running = isBridgeRunning();

  const menu = Menu.buildFromTemplate([
    { label: `${APP_NAME} (${running ? "RUNNING" : "STOPPED"})`, enabled: false },
    { label: `Updates: ${updateState}`, enabled: false },
    { type: "separator" },

    { label: running ? "Stop" : "Start", click: () => (running ? stopBridge() : startBridge()) },
    { label: "Restart", click: () => restartBridge(), enabled: running },
    { label: "Open Settings", click: () => { if (win) { win.show(); win.focus(); } } },

    { type: "separator" },
    { label: "Check for updates", click: () => triggerUpdateCheck(true) },
    { label: "Install update now", click: () => triggerInstallNow(), enabled: updateState === "downloaded" },

    { type: "separator" },
    { label: "Open Config Folder", click: () => shell.openPath(CONFIG_DIR) },
    { label: "Open Config File", click: () => shell.openPath(CONFIG_PATH) },

    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        quitting = true;
        stopBridge();
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(menu);
  tray.setToolTip(`${APP_NAME} - ${running ? "Running" : "Stopped"}`);
}

function createTray() {
  const ICON_PATH = resolveIconPath();

  if (!fs.existsSync(ICON_PATH)) {
    dialog.showErrorBox(
      APP_NAME,
      `No encuentro icon.ico en:\n${ICON_PATH}\n\nDev: app\\renderer\\icon.ico\nInstalado: resources\\assets\\icon.ico`
    );
    if (win) win.show();
    return;
  }

  tray = new Tray(ICON_PATH);
  tray.on("click", () => {
    if (!win) return;
    win.show();
    win.focus();
  });
  updateTrayMenu();
}

// =============================
// Auto Update (electron-updater)
// =============================
function setUpdateState(s) {
  updateState = s;
  updateTrayMenu();
  if (win) win.webContents.send("update-state", { state: s });
}

function setupAutoUpdater() {
  // Solo tiene sentido en app instalada
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => setUpdateState("checking"));
  autoUpdater.on("update-available", () => setUpdateState("available"));
  autoUpdater.on("update-not-available", () => setUpdateState("idle"));
  autoUpdater.on("error", (err) => {
    console.error("autoUpdater error:", err?.message || err);
    setUpdateState("error");
  });
  autoUpdater.on("download-progress", () => setUpdateState("downloading"));
  autoUpdater.on("update-downloaded", () => {
    setUpdateState("downloaded");

    // Si vino por autostart, no molestes con dialog
    if (isAutoStart) return;

    dialog
      .showMessageBox({
        type: "info",
        title: APP_NAME,
        message: "Actualización descargada. ¿Quieres instalarla ahora?",
        buttons: ["Instalar ahora", "Luego"],
        defaultId: 0
      })
      .then((r) => {
        if (r.response === 0) triggerInstallNow();
      })
      .catch(() => {});
  });
}

function triggerUpdateCheck(userInitiated = false) {
  if (!app.isPackaged) {
    if (userInitiated) {
      dialog.showMessageBox({
        title: APP_NAME,
        message: "Auto-update solo funciona en la app instalada (build).",
        buttons: ["OK"]
      });
    }
    return;
  }
  try {
    autoUpdater.checkForUpdates();
  } catch (e) {
    console.error("checkForUpdates error:", e.message);
    setUpdateState("error");
  }
}

function triggerInstallNow() {
  if (!app.isPackaged) return;
  try {
    // Cierra todo e instala
    quitting = true;
    stopBridge();
    autoUpdater.quitAndInstall();
  } catch (e) {
    console.error("quitAndInstall error:", e.message);
  }
}

function scheduleUpdateChecks() {
  if (!app.isPackaged) return;

  // cada 6 horas
  const MS = 6 * 60 * 60 * 1000;
  setInterval(() => triggerUpdateCheck(false), MS).unref();
}

// =============================
// IPC
// =============================
ipcMain.handle("cfg:get", () => readConfig());

ipcMain.handle("cfg:set", async (_evt, cfg) => {
  try {
    const saved = await writeConfig(cfg);
    return { ok: true, configPath: CONFIG_PATH, saved };
  } catch (e) {
    return { ok: false, configPath: CONFIG_PATH, error: e.message };
  }
});

ipcMain.handle("bridge:start", () => startBridge());
ipcMain.handle("bridge:stop", () => stopBridge());
ipcMain.handle("bridge:restart", () => restartBridge());
ipcMain.handle("bridge:running", () => ({ running: isBridgeRunning() }));
ipcMain.handle("paths:config", () => ({ configPath: CONFIG_PATH, configDir: CONFIG_DIR }));

ipcMain.handle("updates:check", () => { triggerUpdateCheck(true); return { ok: true }; });
ipcMain.handle("updates:install", () => { triggerInstallNow(); return { ok: true }; });

// =============================
// App lifecycle
// =============================
app.whenReady().then(() => {
  ensureConfig();
  setupAutoLaunch();

  createWindow();
  createTray();

  // Si NO es autostart, abre la ventana una vez
  if (!isAutoStart) {
    win.show();
    win.focus();
  }

  // Bridge auto-start
  startBridge();

  // Auto-update
  setupAutoUpdater();
  scheduleUpdateChecks();
  triggerUpdateCheck(false);
});

// Evita cerrar completamente cuando se cierran todas las ventanas (tray app)
app.on("window-all-closed", (e) => {
  e.preventDefault();
});
