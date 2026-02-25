// main.js (CommonJS)
// ✅ Tray app + Settings window
// ✅ SINGLE INSTANCE (evita múltiples apps en segundo plano)
// ✅ Bridge corre como Node dentro del mismo electron.exe (ELECTRON_RUN_AS_NODE=1) → NO duplica
// ✅ Auto-start con Windows (login) usando --autostart (arranca silencioso)
// ✅ Auto-update (electron-updater) + menú "Check for updates"
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

// Args
const IS_AUTOSTART = process.argv.includes("--autostart");

// =============================
// SINGLE INSTANCE
// =============================
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      win.show();
      win.focus();
    }
  });
}

// Windows: ayuda a que el tray/instalador se comporte mejor
try {
  if (process.platform === "win32") app.setAppUserModelId("com.zenter.bridge");
} catch {}

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
    SUPABASE_URL: "https://zeucdfkwrdrskmypqpwt.supabase.co",
    SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpldWNkZmt3cmRyc2tteXBxcHd0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjUyMDg4OTMsImV4cCI6MjA4MDc4NDg5M30.1Y2lfH34eO_peuvbYjJAgezkWDKDDOwayzr9QTk3aVI",
    DEVICE_UUID: "",
    DEVICE_KEY: "",
    ENROLL_TOKEN: "",

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
    BRIDGE_VERSION: `zenter-bridge@${app.getVersion()}`,
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
    const merged = { ...defaultCfg(), ...cfg };
    if ("SUPABASE_SERVICE_ROLE" in merged) delete merged.SUPABASE_SERVICE_ROLE;
    return merged;
  } catch (e) {
    dialog.showErrorBox(APP_NAME, `config.json roto o inválido:\n${CONFIG_PATH}\n\n${e.message}`);
    return { ...defaultCfg() };
  }
}

async function writeConfig(cfg) {
  ensureConfig();
  const merged = { ...defaultCfg(), ...(cfg || {}) };
  if ("SUPABASE_SERVICE_ROLE" in merged) delete merged.SUPABASE_SERVICE_ROLE;

  const tmp = CONFIG_PATH + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(merged, null, 2), "utf8");
  await fsp.rename(tmp, CONFIG_PATH);

  return merged;
}

// =============================
// Auto start on Windows
// =============================
function setupAutoLaunch() {
  // En Windows (NSIS perMachine) esto suele funcionar bien.
  // Pasamos --autostart para arrancar silencioso.
  try {
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: true,
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
  if (!cfg.SUPABASE_ANON_KEY) missing.push("SUPABASE_ANON_KEY");
  if (!cfg.DEVICE_UUID) missing.push("DEVICE_UUID");
  if (!cfg.DEVICE_KEY) missing.push("DEVICE_KEY");
  return missing;
}

async function edgePost(cfg, fn, payload) {
  const url = `${cfg.SUPABASE_URL}/functions/v1/${fn}`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: cfg.SUPABASE_ANON_KEY || "",
      Authorization: `Bearer ${cfg.SUPABASE_ANON_KEY || ""}`,
    },
    body: JSON.stringify(payload || {}),
  });
  let data = null;
  try {
    data = await r.json();
  } catch {
    data = { error: "invalid_json" };
  }
  if (!r.ok || data?.ok === false) {
    return { ok: false, error: data?.error || `http_${r.status}` };
  }
  return { ok: true, data };
}

async function enrollDevice(token) {
  const cfg = readConfig();
  if (!cfg.SUPABASE_URL) return { ok: false, error: "missing_supabase_url" };
  if (!token) return { ok: false, error: "missing_token" };

  const res = await edgePost(cfg, "bridgeEnrollDevice", {
    token,
    device_ip: cfg.HIK_IP,
    device_name: cfg.HIK_IP || "Dispositivo",
    bridge_id: cfg.BRIDGE_ID || os.hostname(),
  });

  if (!res.ok) return res;

  const device_id = String(res.data?.device_id || "");
  const device_key = String(res.data?.device_key || "");
  if (!device_id || !device_key) return { ok: false, error: "invalid_enroll_response" };

  const saved = await writeConfig({
    ...cfg,
    DEVICE_UUID: device_id,
    DEVICE_KEY: device_key,
    ENROLL_TOKEN: "",
  });

  return { ok: true, device_id, saved };
}

function startBridge() {
  const cfg = readConfig();

  // DEBUG (solo consola)
  console.log("CONFIG_PATH =", CONFIG_PATH);
  console.log("CFG(core) =", {
    SUPABASE_URL: cfg.SUPABASE_URL ? "[OK]" : "",
    SUPABASE_ANON_KEY: cfg.SUPABASE_ANON_KEY ? "[OK]" : "",
    DEVICE_UUID: cfg.DEVICE_UUID || "",
    DEVICE_KEY: cfg.DEVICE_KEY ? "[OK]" : ""
  });

  const missing = missingCoreFields(cfg);
  if (missing.length) {
    dialog.showErrorBox(
      APP_NAME,
      `Faltan settings: ${missing.join(", ")}.\n\nAbre Settings y completa.\n\nConfig file:\n${CONFIG_PATH}`
    );
    if (win) win.show();
    return;
  }

  if (isBridgeRunning()) return;

  // 🔥 CLAVE: correr el script como Node dentro del electron.exe
  // Esto evita abrir otro "Zenter Bridge" en segundo plano.
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
    width: 980,
    height: 700,
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

  // En tray apps, el close solo oculta (a menos que estemos quitando la app)
  win.on("close", (e) => {
    if (app.isQuiting) return;
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
    { label: "Open Settings", click: () => { win.show(); win.focus(); } },

    { type: "separator" },
    { label: "Check for updates", click: () => triggerUpdateCheck(true) },

    { type: "separator" },
    { label: "Open Config Folder", click: () => shell.openPath(CONFIG_DIR) },
    { label: "Open Config File", click: () => shell.openPath(CONFIG_PATH) },

    { type: "separator" },
    { label: "Quit", click: () => { app.isQuiting = true; stopBridge(); app.quit(); } }
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
    win.show();
    return;
  }

  tray = new Tray(ICON_PATH);
  tray.on("click", () => { win.show(); win.focus(); });
  updateTrayMenu();
}

// =============================
// Auto Update (electron-updater)
// =============================
let updateTimer = null;

function setUpdateState(s) {
  updateState = s;
  updateTrayMenu();
  if (win) win.webContents.send("update-state", { state: s });
}

function setupAutoUpdater() {
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

    dialog
      .showMessageBox({
        type: "info",
        title: APP_NAME,
        message: "Actualización descargada. ¿Quieres instalarla ahora?",
        buttons: ["Instalar ahora", "Luego"],
        defaultId: 0
      })
      .then((r) => {
        if (r.response === 0) {
          autoUpdater.quitAndInstall();
        }
      })
      .catch(() => {});
  });
}

function triggerUpdateCheck(userInitiated = false) {
  if (!app.isPackaged) {
    if (userInitiated) {
      dialog.showMessageBox({
        type: "info",
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
  }
}

function scheduleUpdateChecks() {
  if (!app.isPackaged) return;

  // cada 6 horas
  const MS = 6 * 60 * 60 * 1000;
  if (updateTimer) clearInterval(updateTimer);
  updateTimer = setInterval(() => triggerUpdateCheck(false), MS);
  updateTimer.unref();
}

// =============================
// IPC
// =============================
ipcMain.handle("cfg:get", () => readConfig());

ipcMain.handle("cfg:set", async (_evt, cfg) => {
  try {
    const saved = await writeConfig(cfg);
    const wasRunning = isBridgeRunning();
    if (wasRunning) restartBridge();
    return { ok: true, configPath: CONFIG_PATH, saved, restarted: wasRunning };
  } catch (e) {
    return { ok: false, configPath: CONFIG_PATH, error: e.message };
  }
});

ipcMain.handle("bridge:start", () => startBridge());
ipcMain.handle("bridge:stop", () => stopBridge());
ipcMain.handle("bridge:restart", () => restartBridge());
ipcMain.handle("bridge:running", () => ({ running: isBridgeRunning() }));
ipcMain.handle("bridge:enroll", async (_evt, token) => {
  try {
    const res = await enrollDevice(String(token || "").trim());
    if (res?.ok) {
      if (isBridgeRunning()) restartBridge();
      else startBridge();
    }
    return res;
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});
ipcMain.handle("paths:config", () => ({ configPath: CONFIG_PATH, configDir: CONFIG_DIR }));

ipcMain.handle("updates:check", () => { triggerUpdateCheck(true); return { ok: true }; });
ipcMain.handle("updates:install", () => { autoUpdater.quitAndInstall(); return { ok: true }; });

// =============================
// App lifecycle
// =============================
app.whenReady().then(() => {
  ensureConfig();
  setupAutoLaunch();

  createWindow();
  createTray();

  // Auto-start Bridge (siempre)
  startBridge();

  // Auto-update
  setupAutoUpdater();
  scheduleUpdateChecks();
  triggerUpdateCheck(false);

  // Si NO es autostart, muéstrame la ventana la primera vez (opcional)
  if (!IS_AUTOSTART) {
    // Puedes comentar esto si quieres que siempre quede oculto hasta click en tray
    // win.show();
  }
});

// Evita cerrar completamente cuando se cierran todas las ventanas (tray app)
app.on("window-all-closed", (e) => {
  e.preventDefault();
});

// Limpieza
app.on("before-quit", () => {
  app.isQuiting = true;
  stopBridge();
});
