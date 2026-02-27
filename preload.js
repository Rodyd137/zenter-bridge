// preload.js (CommonJS)
// Exponer API segura al renderer (contextIsolation ON)

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ZBridge", {
  // Config
  cfgGet: () => ipcRenderer.invoke("cfg:get"),
  cfgSet: (cfg) => ipcRenderer.invoke("cfg:set", cfg),

  // Bridge controls
  bridgeStart: () => ipcRenderer.invoke("bridge:start"),
  bridgeStop: () => ipcRenderer.invoke("bridge:stop"),
  bridgeRestart: () => ipcRenderer.invoke("bridge:restart"),
  bridgeRunning: () => ipcRenderer.invoke("bridge:running"),
  deviceStart: (deviceId) => ipcRenderer.invoke("device:start", deviceId),
  deviceStop: (deviceId) => ipcRenderer.invoke("device:stop", deviceId),
  deviceRestart: (deviceId) => ipcRenderer.invoke("device:restart", deviceId),
  deviceRefreshInfo: (deviceId) => ipcRenderer.invoke("device:refresh-info", deviceId),
  bridgeEnroll: (token) => ipcRenderer.invoke("bridge:enroll", token),
  bridgeEnrollDevice: (payload) => ipcRenderer.invoke("bridge:enroll-device", payload),
  bridgeDeleteDevice: (payload) => ipcRenderer.invoke("bridge:delete-device", payload),

  // Paths
  configPath: () => ipcRenderer.invoke("paths:config"),

  // Logs / state
  onLog: (fn) => ipcRenderer.on("bridge-log", (_e, msg) => fn(msg)),
  onState: (fn) => ipcRenderer.on("bridge-state", (_e, st) => fn(st)),
  onConfigUpdated: (fn) => ipcRenderer.on("config-updated", () => fn()),

  // Updates
  updatesCheck: () => ipcRenderer.invoke("updates:check"),
  updatesInstall: () => ipcRenderer.invoke("updates:install"),
  onUpdateState: (fn) => ipcRenderer.on("update-state", (_e, st) => fn(st)),
});
