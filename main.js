// main.js (CommonJS)
// ✅ Tray app + Settings window
// ✅ SINGLE INSTANCE (evita múltiples apps en segundo plano)
// ✅ Bridge corre como Node dentro del mismo electron.exe (ELECTRON_RUN_AS_NODE=1) → NO duplica
// ✅ Auto-start con Windows (login) usando --autostart (arranca silencioso)
// ✅ Auto-update (electron-updater) + menú "Check for updates"
// ✅ Icon: dev -> assets/logo.ico | instalado -> resources/assets/logo.ico
// ✅ Config: ProgramData si se puede, si no userData (fallback)
// ✅ Multi-device: un mismo Bridge puede manejar múltiples dispositivos

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
let bridgeStopRequested = false;
let bridgeProcs = new Map();
let lastDeviceCount = 0;

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
// - dev: assets/logo.ico
// - installed: resources/assets/logo.ico  (por extraResources)
function resolveIconPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, "assets", "logo.ico");
  return path.join(__dirname, "assets", "logo.ico");
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

    DEVICES: [],
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

function safeName(s) {
  return String(s || "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 120) || "device";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function resolveCurlPath() {
  const p1 = "C:\\Windows\\System32\\curl.exe";
  if (fs.existsSync(p1)) return p1;
  return "curl.exe";
}

function xmlTag(xml, tag) {
  const safe = String(tag || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `<(?:\\w+:)?${safe}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${safe}>`,
    "i"
  );
  const m = String(xml || "").match(re);
  return m ? m[1].trim() : null;
}

function parseDeviceInfo(xml) {
  if (!xml) return null;
  const info = {
    deviceName: xmlTag(xml, "deviceName"),
    deviceID: xmlTag(xml, "deviceID"),
    model: xmlTag(xml, "model"),
    serialNumber: xmlTag(xml, "serialNumber"),
    macAddress: xmlTag(xml, "macAddress"),
    firmwareVersion: xmlTag(xml, "firmwareVersion"),
    firmwareReleasedDate: xmlTag(xml, "firmwareReleasedDate"),
    deviceType: xmlTag(xml, "deviceType"),
    supportBeep: xmlTag(xml, "supportBeep"),
  };
  const hasAny = Object.values(info).some((v) => v != null && String(v).trim() !== "");
  return hasAny ? info : null;
}

function parseTimeInfo(xml) {
  if (!xml) return null;
  const info = {
    timeMode: xmlTag(xml, "timeMode"),
    localTime: xmlTag(xml, "localTime"),
    timeZone: xmlTag(xml, "timeZone"),
  };
  const hasAny = Object.values(info).some((v) => v != null && String(v).trim() !== "");
  return hasAny ? info : null;
}

function mergeDeviceInfo(deviceInfo, deviceTime) {
  if (!deviceInfo && !deviceTime) return null;
  return { ...(deviceInfo || {}), ...(deviceTime || {}) };
}

async function fetchDeviceInfoBundle(device, opts) {
  const [deviceInfo, deviceTime] = await Promise.all([
    fetchDeviceInfo(device, opts),
    fetchDeviceTime(device, opts)
  ]);
  return {
    deviceInfo,
    deviceTime,
    merged: mergeDeviceInfo(deviceInfo, deviceTime)
  };
}

async function fetchIsapiXml(device, endpoint, label, opts = {}) {
  const ip = String(device?.HIK_IP || "").trim();
  if (!ip) return null;
  const user = String(device?.HIK_USER || "admin").trim() || "admin";
  const pass = String(device?.HIK_PASS || "").trim();
  const connectTimeout = Number(opts.connectTimeoutSec ?? 3);
  const maxTime = Number(opts.maxTimeSec ?? 8);
  const url = `http://${ip}${endpoint}`;
  const args = [
    "-sS",
    "--digest",
    "--write-out",
    "\nCURL_HTTP_CODE:%{http_code}",
    "--connect-timeout",
    String(connectTimeout),
    "--max-time",
    String(maxTime),
    "-u",
    `${user}:${pass}`,
    url
  ];
  return await new Promise((resolve) => {
    const p = spawn(resolveCurlPath(), args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let buf = "";
    let err = "";
    p.stdout.on("data", (d) => (buf += d.toString("utf8")));
    p.stderr.on("data", (d) => (err += d.toString("utf8")));
    p.on("close", (code) => {
      let out = String(buf || "").trim();
      let httpCode = "";
      const codeMatch = out.match(/CURL_HTTP_CODE:(\d+)/);
      if (codeMatch) {
        httpCode = codeMatch[1];
        out = out.replace(/\s*CURL_HTTP_CODE:\d+\s*$/i, "").trim();
      }
      if (!out) {
        const msg = `[WARN] ${label || "ISAPI"} vacio (${ip}) curl=${code}`;
        console.log(msg);
        if (err && err.trim()) console.log(`[WARN] ${label || "ISAPI"} stderr:`, err.trim());
        if (httpCode && httpCode !== "200") {
          const httpMsg = `[WARN] ${label || "ISAPI"} http=${httpCode} (${ip})`;
          console.log(httpMsg);
          if (win) win.webContents.send("bridge-log", httpMsg);
        }
      }
      if (httpCode && httpCode !== "200" && out) {
        const httpMsg = `[WARN] ${label || "ISAPI"} http=${httpCode} (${ip})`;
        console.log(httpMsg);
        if (win) win.webContents.send("bridge-log", httpMsg);
      }
      resolve(out || "");
    });
  });
}

async function fetchDeviceInfo(device, opts) {
  const out = await fetchIsapiXml(device, "/ISAPI/System/deviceInfo", "deviceInfo", opts);
  const parsed = parseDeviceInfo(out);
  if (!parsed && out) {
    const msg = `[WARN] deviceInfo parse vacío (${device?.HIK_IP || "ip?"})`;
    console.log(msg);
    if (win) win.webContents.send("bridge-log", msg);
    const snippet = String(out).replace(/\s+/g, " ").slice(0, 200);
    if (snippet) {
      const sn = `[WARN] deviceInfo raw: ${snippet}`;
      console.log(sn);
      if (win) win.webContents.send("bridge-log", sn);
    }
  }
  return parsed;
}

async function fetchDeviceTime(device, opts) {
  const out = await fetchIsapiXml(device, "/ISAPI/System/time", "deviceTime", opts);
  const parsed = parseTimeInfo(out);
  if (!parsed && out) {
    const msg = `[WARN] deviceTime parse vacío (${device?.HIK_IP || "ip?"})`;
    console.log(msg);
    if (win) win.webContents.send("bridge-log", msg);
    const snippet = String(out).replace(/\s+/g, " ").slice(0, 200);
    if (snippet) {
      const sn = `[WARN] deviceTime raw: ${snippet}`;
      console.log(sn);
      if (win) win.webContents.send("bridge-log", sn);
    }
  }
  return parsed;
}

function normalizeDevices(cfg) {
  let devices = Array.isArray(cfg?.DEVICES) ? cfg.DEVICES : [];

  if (!devices.length) {
    const legacy = {
      LABEL: String(cfg?.DEVICE_LABEL || "").trim(),
      DEVICE_UUID: String(cfg?.DEVICE_UUID || "").trim(),
      DEVICE_KEY: String(cfg?.DEVICE_KEY || "").trim(),
      ENROLL_TOKEN: String(cfg?.ENROLL_TOKEN || "").trim(),
      HIK_IP: String(cfg?.HIK_IP || "").trim(),
      HIK_USER: String(cfg?.HIK_USER || "admin").trim(),
      HIK_PASS: String(cfg?.HIK_PASS || "").trim(),
    };
    if (
      legacy.DEVICE_UUID ||
      legacy.DEVICE_KEY ||
      legacy.HIK_IP ||
      legacy.ENROLL_TOKEN
    ) {
      devices = [legacy];
    }
  }

  if (!devices.length) {
    devices = [];
  }

  return devices.map((d) => ({
    LABEL: String(d?.LABEL || d?.label || "").trim(),
    DEVICE_UUID: String(d?.DEVICE_UUID || d?.device_uuid || d?.device_id || "").trim(),
    DEVICE_KEY: String(d?.DEVICE_KEY || d?.device_key || "").trim(),
    ENROLL_TOKEN: String(d?.ENROLL_TOKEN || d?.enroll_token || "").trim(),
    HIK_IP: String(d?.HIK_IP || d?.hik_ip || "").trim(),
    HIK_USER: String(d?.HIK_USER || d?.hik_user || "admin").trim() || "admin",
    HIK_PASS: String(d?.HIK_PASS || d?.hik_pass || "").trim(),
    HIK_TIME_ZONE: String(d?.HIK_TIME_ZONE || d?.hik_time_zone || "").trim(),
    HIK_TIME_MODE: String(d?.HIK_TIME_MODE || d?.hik_time_mode || "").trim(),
    HIK_LOCAL_TIME: String(d?.HIK_LOCAL_TIME || d?.hik_local_time || "").trim(),
    HIK_MODEL: String(d?.HIK_MODEL || d?.hik_model || "").trim(),
    HIK_SERIAL: String(d?.HIK_SERIAL || d?.hik_serial || "").trim(),
    HIK_MAC: String(d?.HIK_MAC || d?.hik_mac || "").trim(),
  }));
}

function normalizeCfgForSave(cfg) {
  const merged = { ...defaultCfg(), ...(cfg || {}) };
  const devices = normalizeDevices(merged);
  merged.DEVICES = devices;

  const first = devices[0] || {};
  merged.DEVICE_UUID = first.DEVICE_UUID || "";
  merged.DEVICE_KEY = first.DEVICE_KEY || "";
  merged.ENROLL_TOKEN = first.ENROLL_TOKEN || "";
  merged.HIK_IP = first.HIK_IP || "";
  merged.HIK_USER = first.HIK_USER || "admin";
  merged.HIK_PASS = first.HIK_PASS || "";

  if ("SUPABASE_SERVICE_ROLE" in merged) delete merged.SUPABASE_SERVICE_ROLE;
  return merged;
}

function readConfig() {
  ensureConfig();
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const cfg = JSON.parse(raw);
    const merged = normalizeCfgForSave(cfg);
    return merged;
  } catch (e) {
    dialog.showErrorBox(APP_NAME, `config.json roto o invalido:\n${CONFIG_PATH}\n\n${e.message}`);
    return normalizeCfgForSave({});
  }
}

async function writeConfig(cfg) {
  ensureConfig();
  const merged = normalizeCfgForSave(cfg || {});

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
// Bridge process (multi-device)
// =============================
function runningCount() {
  let n = 0;
  for (const entry of bridgeProcs.values()) {
    if (entry?.proc && !entry.proc.killed) n += 1;
  }
  return n;
}

function isBridgeRunning() {
  return runningCount() > 0;
}

function deviceIdFor(device, index) {
  return device?.DEVICE_UUID || `idx-${index}`;
}

function deviceLabel(device, index) {
  return device?.LABEL || device?.HIK_IP || device?.DEVICE_UUID || `Device ${index + 1}`;
}

function isDeviceReady(device) {
  return !!(device?.DEVICE_UUID && device?.DEVICE_KEY && device?.HIK_IP);
}

function missingCoreFields(devices) {
  const missing = [];
  devices.forEach((d, i) => {
    const label = deviceLabel(d, i);
    if (!d.HIK_IP) missing.push(`${label}: HIK_IP`);
    if (!d.DEVICE_UUID) missing.push(`${label}: DEVICE_UUID`);
    if (!d.DEVICE_KEY) missing.push(`${label}: DEVICE_KEY`);
  });
  return missing;
}

async function writeDeviceConfig(cfg, device, index) {
  const name = safeName(device?.DEVICE_UUID || device?.LABEL || `device_${index + 1}`);
  const dir = path.join(CONFIG_DIR, "devices", name);
  await fsp.mkdir(dir, { recursive: true });

  const file = path.join(dir, "config.json");
  const payload = {
    SUPABASE_URL: cfg.SUPABASE_URL,
    SUPABASE_ANON_KEY: cfg.SUPABASE_ANON_KEY,
    DEVICE_UUID: device.DEVICE_UUID,
    DEVICE_KEY: device.DEVICE_KEY,
    ENROLL_TOKEN: "",

    HIK_IP: device.HIK_IP,
    HIK_USER: device.HIK_USER || "admin",
    HIK_PASS: device.HIK_PASS || "",

    SUPABASE_TABLE: cfg.SUPABASE_TABLE || "access_events",
    START_MODE: cfg.START_MODE || "now",

    RECONNECT_MS: cfg.RECONNECT_MS ?? 1500,
    CURL_VERBOSE: cfg.CURL_VERBOSE ?? 0,
    FLUSH_INTERVAL_MS: cfg.FLUSH_INTERVAL_MS ?? 5000,
    INSERT_CONCURRENCY: cfg.INSERT_CONCURRENCY ?? 3,

    BRIDGE_ID: cfg.BRIDGE_ID || os.hostname(),
    HEARTBEAT_MS: cfg.HEARTBEAT_MS ?? 15000,
    HEARTBEAT_TABLE: cfg.HEARTBEAT_TABLE || "access_device_heartbeats",
    BRIDGE_VERSION: `zenter-bridge@${app.getVersion()}`,
  };

  await fsp.writeFile(file, JSON.stringify(payload, null, 2), "utf8");
  return file;
}

function stopAllProcs() {
  for (const entry of bridgeProcs.values()) {
    if (entry?.restartTimer) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = null;
    }
    if (entry) entry.stopRequested = true;
    try { entry?.proc?.kill(); } catch {}
  }
  bridgeProcs.clear();
}

function scheduleDeviceRestart(id) {
  const entry = bridgeProcs.get(id);
  if (!entry || entry.restartTimer || entry.stopRequested || app.isQuiting) return;
  entry.restartTimer = setTimeout(() => {
    entry.restartTimer = null;
    if (!bridgeStopRequested && !entry.stopRequested) startDevice(entry.device, entry.index, entry.cfg);
  }, 5000);
}

function startDevice(device, index, cfg) {
  const deviceId = deviceIdFor(device, index);
  if (!isDeviceReady(device)) return;

  if (bridgeProcs.has(deviceId)) {
    const existing = bridgeProcs.get(deviceId);
    if (existing?.proc && !existing.proc.killed) return;
  }

  writeDeviceConfig(cfg, device, index)
    .then((deviceConfigPath) => {
      const env = {
        ...process.env,
        ZB_CONFIG_PATH: deviceConfigPath,
        ELECTRON_RUN_AS_NODE: "1"
      };

      const proc = spawn(process.execPath, [BRIDGE_PATH], {
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });

      const label = deviceLabel(device, index);
      const entry = { proc, device, index, cfg, label, configPath: deviceConfigPath, restartTimer: null, stopRequested: false };
      bridgeProcs.set(deviceId, entry);

      proc.stdout.on("data", (d) => {
        const s = d.toString("utf8").trim();
        if (s) console.log(`[${label}]`, s);
        if (win && s) win.webContents.send("bridge-log", `[${label}] ${s}`);
      });

      proc.stderr.on("data", (d) => {
        const s = d.toString("utf8").trim();
        if (s) console.error(`[${label}]`, s);
        if (win && s) win.webContents.send("bridge-log", `[${label}] ERR: ${s}`);
      });

      proc.on("close", () => {
        const cur = bridgeProcs.get(deviceId);
        if (cur && cur.proc === proc) {
          cur.proc = null;
        }
        updateTrayMenu();
        if (win) win.webContents.send("bridge-state", bridgeState());
        if (!bridgeStopRequested && !app.isQuiting) scheduleDeviceRestart(deviceId);
      });

      updateTrayMenu();
      if (win) win.webContents.send("bridge-state", bridgeState());
    })
    .catch((e) => {
      console.error("device start error:", e.message);
    });
}

function startBridge() {
  bridgeStopRequested = false;
  stopAllProcs();

  const cfg = readConfig();
  const devices = normalizeDevices(cfg);
  lastDeviceCount = devices.length;

  const ready = devices.filter((d) => isDeviceReady(d));
  const missing = devices.filter((d) => !isDeviceReady(d));

  if (!ready.length) {
    const miss = missingCoreFields(devices);
    dialog.showErrorBox(
      APP_NAME,
      `Faltan settings para iniciar el Bridge.\n\n${miss.join("\n")}\n\nConfig file:\n${CONFIG_PATH}`
    );
    if (win) win.show();
    return;
  }

  if (missing.length && win) {
    const list = missingCoreFields(missing);
    win.webContents.send("bridge-log", `WARN: Dispositivos incompletos (no iniciaron): ${list.join(" | ")}`);
  }

  ready.forEach((d, i) => startDevice(d, i, cfg));
  ready.forEach((d) => scheduleDeviceInfoRefresh(cfg, d));
}

function stopBridge() {
  bridgeStopRequested = true;
  stopAllProcs();
  updateTrayMenu();
  if (win) win.webContents.send("bridge-state", bridgeState());
}

function restartBridge() {
  stopBridge();
  setTimeout(() => startBridge(), 400);
}

function startDeviceById(deviceId) {
  const id = String(deviceId || "").trim();
  if (!id) return { ok: false, error: "missing_device_id" };
  const cfg = readConfig();
  const devices = normalizeDevices(cfg);
  const idx = devices.findIndex((d, i) => deviceIdFor(d, i) === id);
  if (idx < 0) return { ok: false, error: "device_not_found" };
  const device = devices[idx];
  if (!isDeviceReady(device)) return { ok: false, error: "device_not_ready" };
  bridgeStopRequested = false;
  startDevice(device, idx, cfg);
  return { ok: true };
}

function stopDeviceById(deviceId) {
  const id = String(deviceId || "").trim();
  if (!id) return { ok: false, error: "missing_device_id" };
  const entry = bridgeProcs.get(id);
  if (!entry) return { ok: false, error: "device_not_found" };
  if (entry.restartTimer) {
    clearTimeout(entry.restartTimer);
    entry.restartTimer = null;
  }
  entry.stopRequested = true;
  try { entry?.proc?.kill(); } catch {}
  if (entry.proc) entry.proc = null;
  updateTrayMenu();
  if (win) win.webContents.send("bridge-state", bridgeState());
  return { ok: true };
}

function restartDeviceById(deviceId) {
  const res = stopDeviceById(deviceId);
  if (!res.ok) return res;
  setTimeout(() => startDeviceById(deviceId), 400);
  return { ok: true };
}

function runningDeviceIds() {
  const ids = [];
  for (const [id, entry] of bridgeProcs.entries()) {
    if (entry?.proc && !entry.proc.killed) ids.push(id);
  }
  return ids;
}

function bridgeState() {
  return {
    running: isBridgeRunning(),
    count: runningCount(),
    total: lastDeviceCount || 0,
    device_running_ids: runningDeviceIds()
  };
}

function missingCoreFieldsForEnroll(device) {
  const missing = [];
  if (!device?.HIK_IP) missing.push("HIK_IP");
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

async function deleteDeviceByKey(device, cfg) {
  const device_id = String(device?.DEVICE_UUID || "").trim();
  const device_key = String(device?.DEVICE_KEY || "").trim();
  if (!device_id || !device_key) return { ok: false, error: "missing_device_auth" };
  return await edgePost(cfg, "bridgeDeleteDeviceByKey", { device_id, device_key });
}

async function enrollDeviceFor(token, device, cfg) {
  if (!cfg?.SUPABASE_URL) return { ok: false, error: "missing_supabase_url" };
  if (!token) return { ok: false, error: "missing_token" };

  const miss = missingCoreFieldsForEnroll(device);
  if (miss.length) return { ok: false, error: `missing_${miss.join("_")}` };

  const bundle = await fetchDeviceInfoBundle(device, { connectTimeoutSec: 3, maxTimeSec: 8 });
  if (!bundle.deviceInfo) console.log("[WARN] No se pudo leer deviceInfo.");
  if (!bundle.deviceTime) console.log("[WARN] No se pudo leer deviceTime.");
  const mergedInfo = bundle.merged;
  let resolvedLabel = String(device?.LABEL || "").trim();
  const model = String(bundle.deviceInfo?.model || "").trim();
  const serial = String(bundle.deviceInfo?.serialNumber || "").trim();
  const modelSerial = [model, serial].filter(Boolean).join(" | ");
  if (!resolvedLabel && modelSerial) resolvedLabel = modelSerial;
  if (!resolvedLabel && serial) resolvedLabel = serial;
  if (!resolvedLabel && device?.HIK_IP) resolvedLabel = String(device.HIK_IP || "").trim();

  const res = await edgePost(cfg, "bridgeEnrollDevice", {
    token,
    device_ip: device.HIK_IP,
    device_name: resolvedLabel || device.HIK_IP || "Dispositivo",
    device_info: mergedInfo,
    bridge_id: cfg.BRIDGE_ID || os.hostname(),
  });

  if (!res.ok) return res;

  const device_id = String(res.data?.device_id || "");
  const device_key = String(res.data?.device_key || "");
  if (!device_id || !device_key) return { ok: false, error: "invalid_enroll_response" };

  return {
    ok: true,
    device_id,
    device_key,
    label: resolvedLabel || "",
    time_zone: bundle.deviceTime?.timeZone || "",
    time_mode: bundle.deviceTime?.timeMode || "",
    local_time: bundle.deviceTime?.localTime || "",
    hik_model: bundle.deviceInfo?.model || "",
    hik_serial: bundle.deviceInfo?.serialNumber || "",
    hik_mac: bundle.deviceInfo?.macAddress || "",
  };
}

async function refreshDeviceInfoAfterEnroll(cfg, device, device_id, device_key, opts = {}) {
  try {
    let merged = null;
    let info = null;
    let time = null;

    const attempts = Array.isArray(opts.attempts) && opts.attempts.length
      ? opts.attempts
      : [
      { connectTimeoutSec: 4, maxTimeSec: 12 },
      { connectTimeoutSec: 5, maxTimeSec: 18 },
      { connectTimeoutSec: 6, maxTimeSec: 25 }
    ];
    for (let i = 0; i < attempts.length; i += 1) {
      const bundle = await fetchDeviceInfoBundle(device, attempts[i]);
      info = bundle.deviceInfo;
      time = bundle.deviceTime;
      merged = bundle.merged;
      if (merged) break;
      await sleep(800);
    }

    if (!merged) {
      console.log("[WARN] No se pudo leer deviceInfo/time para actualizar DB.");
      if (win) win.webContents.send("bridge-log", "[WARN] No se pudo leer deviceInfo/time para actualizar DB.");
      return { ok: false, error: "no_device_info" };
    }

    const updated = {
      HIK_TIME_ZONE: time?.timeZone || merged?.timeZone || "",
      HIK_TIME_MODE: time?.timeMode || merged?.timeMode || "",
      HIK_LOCAL_TIME: time?.localTime || merged?.localTime || "",
      HIK_MODEL: info?.model || merged?.model || "",
      HIK_SERIAL: info?.serialNumber || merged?.serialNumber || "",
      HIK_MAC: info?.macAddress || merged?.macAddress || ""
    };
    const modelSerial = [updated.HIK_MODEL, updated.HIK_SERIAL].filter(Boolean).join(" | ");

    try {
      const cfgNow = readConfig();
      const devices = normalizeDevices(cfgNow);
      const idx = devices.findIndex((d) => String(d?.DEVICE_UUID || "").trim() === String(device_id || "").trim());
      if (idx >= 0) {
        const d = devices[idx];
        const setIf = (key, value) => {
          const v = String(value || "").trim();
          if (v) d[key] = v;
        };
        setIf("HIK_TIME_ZONE", updated.HIK_TIME_ZONE);
        setIf("HIK_TIME_MODE", updated.HIK_TIME_MODE);
        setIf("HIK_LOCAL_TIME", updated.HIK_LOCAL_TIME);
        setIf("HIK_MODEL", updated.HIK_MODEL);
        setIf("HIK_SERIAL", updated.HIK_SERIAL);
        setIf("HIK_MAC", updated.HIK_MAC);
        if (modelSerial) {
          const curLabel = String(d.LABEL || "").trim();
          const bridgeId = String(cfgNow?.BRIDGE_ID || "").trim();
          if (!curLabel || curLabel === bridgeId) {
            d.LABEL = modelSerial;
            updated.LABEL = modelSerial;
          }
        }
        await writeConfig({ ...cfgNow, DEVICES: devices });
        if (win) win.webContents.send("config-updated");
      }
    } catch (e) {
      console.log("[WARN] update local config failed:", e?.message || String(e));
    }

    if (opts.updateDb !== false) {
      if (win) win.webContents.send("bridge-log", `[INFO] Enviando deviceInfo a DB (${device_id})`);
      const res = await edgePost(cfg, "bridgeUpdateDeviceInfo", {
        device_id,
        device_key,
        device_info: merged
      });
      if (!res?.ok) {
        console.log("[WARN] bridgeUpdateDeviceInfo failed:", res?.error || "unknown_error");
        if (win) win.webContents.send("bridge-log", `[WARN] bridgeUpdateDeviceInfo failed: ${res?.error || "unknown_error"}`);
        return { ok: false, error: res?.error || "update_db_failed", updated };
      }
      console.log("[OK] deviceInfo actualizado en DB.");
      if (win) win.webContents.send("bridge-log", "[OK] deviceInfo actualizado en DB.");
    }

    return { ok: true, updated };
  } catch (e) {
    console.log("[WARN] refreshDeviceInfoAfterEnroll error:", e?.message || String(e));
    return { ok: false, error: e?.message || String(e) };
  }
}

function shouldRefreshDeviceInfo(device) {
  const fields = [
    device?.HIK_TIME_ZONE,
    device?.HIK_TIME_MODE,
    device?.HIK_LOCAL_TIME,
    device?.HIK_MODEL,
    device?.HIK_SERIAL,
    device?.HIK_MAC
  ];
  return fields.some((v) => !String(v || "").trim());
}

function scheduleDeviceInfoRefresh(cfg, device) {
  if (!device?.DEVICE_UUID || !device?.DEVICE_KEY) return;
  if (!shouldRefreshDeviceInfo(device)) return;
  let tries = 0;
  const attempts = [
    { connectTimeoutSec: 5, maxTimeSec: 18 },
    { connectTimeoutSec: 6, maxTimeSec: 25 },
    { connectTimeoutSec: 8, maxTimeSec: 35 }
  ];
  const run = async () => {
    tries += 1;
    const res = await refreshDeviceInfoAfterEnroll(
      cfg,
      device,
      device.DEVICE_UUID,
      device.DEVICE_KEY,
      { attempts, updateDb: true }
    );
    const updated = res?.updated || {};
    const hasAny = [
      updated.HIK_TIME_ZONE,
      updated.HIK_TIME_MODE,
      updated.HIK_LOCAL_TIME,
      updated.HIK_MODEL,
      updated.HIK_SERIAL,
      updated.HIK_MAC
    ].some((v) => String(v || "").trim());
    if (res?.ok && hasAny) return;
    if (tries < 5) setTimeout(run, 8000).unref?.();
  };
  setTimeout(run, 2500).unref?.();
}

async function refreshDeviceInfoForDevice(deviceId) {
  const id = String(deviceId || "").trim();
  if (!id) return { ok: false, error: "missing_device_id" };
  const cfg = readConfig();
  const devices = normalizeDevices(cfg);
  const idx = devices.findIndex((d, i) => deviceIdFor(d, i) === id);
  if (idx < 0) return { ok: false, error: "device_not_found" };
  const device = devices[idx];
  if (!device?.HIK_IP) return { ok: false, error: "missing_device_ip" };
  if (!device?.DEVICE_KEY) return { ok: false, error: "missing_device_key" };
  const attempts = [
    { connectTimeoutSec: 5, maxTimeSec: 15 },
    { connectTimeoutSec: 6, maxTimeSec: 22 },
    { connectTimeoutSec: 8, maxTimeSec: 30 }
  ];
  return await refreshDeviceInfoAfterEnroll(cfg, device, id, device.DEVICE_KEY, { attempts, updateDb: true });
}

async function enrollDeviceByIndex(token, index, deviceOverride, devicesOverride) {
  const cfg = readConfig();
  const devices = Array.isArray(devicesOverride)
    ? normalizeDevices({ DEVICES: devicesOverride })
    : normalizeDevices(cfg);
  const idx = Number.isFinite(index) ? index : 0;

  while (devices.length <= idx) {
    devices.push({
      LABEL: "",
      DEVICE_UUID: "",
      DEVICE_KEY: "",
      ENROLL_TOKEN: "",
      HIK_IP: "",
      HIK_USER: "admin",
      HIK_PASS: "",
    });
  }

  const current = devices[idx] || {};
  const next = { ...current, ...(deviceOverride || {}) };

  const res = await enrollDeviceFor(token, next, cfg);
  if (!res.ok) return res;

  next.DEVICE_UUID = res.device_id;
  next.DEVICE_KEY = res.device_key;
  next.ENROLL_TOKEN = "";
  if (!next.LABEL && res.label) next.LABEL = res.label;
  if (res.time_zone) next.HIK_TIME_ZONE = res.time_zone;
  if (res.time_mode) next.HIK_TIME_MODE = res.time_mode;
  if (res.local_time) next.HIK_LOCAL_TIME = res.local_time;
  if (res.hik_model) next.HIK_MODEL = res.hik_model;
  if (res.hik_serial) next.HIK_SERIAL = res.hik_serial;
  if (res.hik_mac) next.HIK_MAC = res.hik_mac;

  devices[idx] = next;

  const saved = await writeConfig({ ...cfg, DEVICES: devices });

  if (isBridgeRunning()) restartBridge();
  else startBridge();

  refreshDeviceInfoAfterEnroll(cfg, next, res.device_id, res.device_key).catch(() => {});

  return { ok: true, device_id: res.device_id, device: next, saved };
}

// =============================
// Window + Tray
// =============================
function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
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

  const count = runningCount();
  const total = lastDeviceCount || 0;
  const running = count > 0;
  const statusLabel = total > 0
    ? `${APP_NAME} (${running ? "RUNNING" : "STOPPED"}) - ${count}/${total}`
    : `${APP_NAME} (${running ? "RUNNING" : "STOPPED"})`;

  const menu = Menu.buildFromTemplate([
    { label: statusLabel, enabled: false },
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
      `No encuentro logo.ico en:\n${ICON_PATH}\n\nDev: assets\\logo.ico\nInstalado: resources\\assets\\logo.ico`
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
let updateTimerTimeout = null;

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
        message: "Actualizacion descargada. Quieres instalarla ahora?",
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

  const MS_WEEK = 7 * 24 * 60 * 60 * 1000;
  const now = new Date();
  const target = new Date(now);
  target.setHours(3, 0, 0, 0);
  let daysUntil = (7 - now.getDay()) % 7; // 0 = Sunday
  if (daysUntil === 0 && now >= target) daysUntil = 7;
  target.setDate(now.getDate() + daysUntil);
  const delay = Math.max(0, target.getTime() - now.getTime());

  if (updateTimer) clearInterval(updateTimer);
  if (updateTimerTimeout) clearTimeout(updateTimerTimeout);

  updateTimerTimeout = setTimeout(() => {
    triggerUpdateCheck(false);
    updateTimer = setInterval(() => triggerUpdateCheck(false), MS_WEEK);
    updateTimer.unref();
  }, delay);
  updateTimerTimeout.unref();
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
ipcMain.handle("bridge:running", () => bridgeState());
ipcMain.handle("device:start", (_e, deviceId) => startDeviceById(deviceId));
ipcMain.handle("device:stop", (_e, deviceId) => stopDeviceById(deviceId));
ipcMain.handle("device:restart", (_e, deviceId) => restartDeviceById(deviceId));
ipcMain.handle("device:refresh-info", (_e, deviceId) => refreshDeviceInfoForDevice(deviceId));

ipcMain.handle("bridge:enroll", async (_evt, token) => {
  try {
    const res = await enrollDeviceByIndex(String(token || "").trim(), 0, null);
    return res;
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle("bridge:enroll-device", async (_evt, payload) => {
  try {
    const idx = Number(payload?.index ?? 0);
    const token = String(payload?.token || "").trim();
    const device = payload?.device || null;
    const devices = Array.isArray(payload?.devices) ? payload.devices : null;
    if (!token) return { ok: false, error: "missing_token" };
    return await enrollDeviceByIndex(token, idx, device, devices);
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle("bridge:delete-device", async (_evt, payload) => {
  try {
    const cfg = readConfig();
    const device = payload?.device || null;
    if (!device) return { ok: false, error: "missing_device" };
    const res = await deleteDeviceByKey(device, cfg);
    if (!res?.ok) return { ok: false, error: res?.error || "delete_failed" };
    return { ok: true, data: res.data || null };
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

