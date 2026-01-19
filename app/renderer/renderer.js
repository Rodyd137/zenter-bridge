const ids = ["SUPABASE_URL","SUPABASE_SERVICE_ROLE","DEVICE_UUID","HIK_IP","HIK_USER","HIK_PASS"];

function el(id){ return document.getElementById(id); }

function appendLog(msg) {
  if (!msg) return;
  const box = el("logs");
  box.textContent = (box.textContent + "\n" + msg).trim();
  box.scrollTop = box.scrollHeight;
}

async function load() {
  const p = await window.ZBridge.configPath();
  el("configPath").textContent = `Config:\n${p.configPath}\nDir:\n${p.configDir}`;

  const cfg = await window.ZBridge.cfgGet();
  ids.forEach(k => { if (cfg[k] != null) el(k).value = String(cfg[k]); });

  const st = await window.ZBridge.bridgeRunning();
  el("state").textContent = st.running ? "RUNNING" : "STOPPED";
}

async function save() {
  const cfg = await window.ZBridge.cfgGet();
  ids.forEach(k => cfg[k] = el(k).value.trim());

  const res = await window.ZBridge.cfgSet(cfg);

  if (!res || !res.ok) {
    alert("❌ No se pudo guardar.\n\n" + (res?.error || "unknown_error"));
    appendLog("ERR: cfg:set failed -> " + (res?.error || "unknown_error"));
    return;
  }

  alert("✅ Guardado.\n\n" + res.configPath);
  appendLog("✅ Guardado config en: " + res.configPath);

  // recarga para asegurar que lo que quedó escrito se vea
  await load();
}

el("btnSave").onclick = () => save().catch(e => alert("save error: " + e.message));
el("btnStart").onclick = () => window.ZBridge.bridgeStart();
el("btnStop").onclick = () => window.ZBridge.bridgeStop();
el("btnRestart").onclick = () => window.ZBridge.bridgeRestart();

window.ZBridge.onLog((msg) => appendLog(msg));
window.ZBridge.onState((st) => {
  el("state").textContent = st.running ? "RUNNING" : "STOPPED";
});

load().catch((e) => {
  appendLog("ERR: load failed -> " + e.message);
  console.error(e);
});
