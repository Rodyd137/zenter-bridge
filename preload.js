const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ZBridge", {
  cfgGet: () => ipcRenderer.invoke("cfg:get"),
  cfgSet: (cfg) => ipcRenderer.invoke("cfg:set", cfg),

  bridgeStart: () => ipcRenderer.invoke("bridge:start"),
  bridgeStop: () => ipcRenderer.invoke("bridge:stop"),
  bridgeRestart: () => ipcRenderer.invoke("bridge:restart"),
  bridgeRunning: () => ipcRenderer.invoke("bridge:running"),

  configPath: () => ipcRenderer.invoke("paths:config"),

  onLog: (fn) => ipcRenderer.on("bridge-log", (_e, msg) => fn(msg)),
  onState: (fn) => ipcRenderer.on("bridge-state", (_e, st) => fn(st)),
});
