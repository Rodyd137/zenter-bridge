const ids = ["DEVICE_UUID", "HIK_IP", "HIK_USER", "HIK_PASS"];

function el(id){ return document.getElementById(id); }

function appendLog(msg) {
  if (!msg) return;
  const box = el("logs");
  box.textContent = (box.textContent + "\n" + msg).trim();
  box.scrollTop = box.scrollHeight;
}

function setUpdateUI(state) {
  // state: idle | checking | available | downloading | downloaded | error
  const s = String(state || "idle");

  const label = el("updateState");
  if (label) label.textContent = "Updates: " + s.toUpperCase();

  const btnCheck = el("btnUpdateCheck");
  const btnInstall = el("btnUpdateInstall");

  if (btnCheck) {
    btnCheck.disabled = (s === "checking" || s === "downloading");
  }

  if (btnInstall) {
    btnInstall.disabled = (s !== "downloaded");
  }
}

async function load() {
  const cfg = await window.ZBridge.cfgGet();
  ids.forEach(k => { if (cfg[k] != null) el(k).value = String(cfg[k]); });

  const st = await window.ZBridge.bridgeRunning();
  el("state").textContent = st.running ? "RUNNING" : "STOPPED";

  // default updates UI
  setUpdateUI("idle");
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

  alert("✅ Guardado.");
  appendLog("✅ Config guardada.");

  await load();
}

// =====================
// Buttons
// =====================
el("btnSave").onclick = () => save().catch(e => alert("save error: " + e.message));
el("btnStart").onclick = () => window.ZBridge.bridgeStart();
el("btnStop").onclick = () => window.ZBridge.bridgeStop();
el("btnRestart").onclick = () => window.ZBridge.bridgeRestart();

// Updates buttons (si existen en el HTML)
const btnUpdateCheck = el("btnUpdateCheck");
if (btnUpdateCheck) {
  btnUpdateCheck.onclick = async () => {
    try {
      appendLog("🔎 Checking updates...");
      await window.ZBridge.updatesCheck();
    } catch (e) {
      appendLog("ERR: updatesCheck -> " + e.message);
      alert("updatesCheck error: " + e.message);
    }
  };
}

const btnUpdateInstall = el("btnUpdateInstall");
if (btnUpdateInstall) {
  btnUpdateInstall.onclick = async () => {
    try {
      appendLog("⬇️ Installing update...");
      await window.ZBridge.updatesInstall();
    } catch (e) {
      appendLog("ERR: updatesInstall -> " + e.message);
      alert("updatesInstall error: " + e.message);
    }
  };
}

// =====================
// IPC listeners
// =====================
window.ZBridge.onLog((msg) => appendLog(msg));

window.ZBridge.onState((st) => {
  el("state").textContent = st.running ? "RUNNING" : "STOPPED";
});

// Updates state listener (si preload lo expone)
if (window.ZBridge.onUpdateState) {
  window.ZBridge.onUpdateState((st) => {
    const state = st?.state || "idle";
    setUpdateUI(state);
    appendLog("🧩 Update state: " + state);
  });
}

load().catch((e) => {
  appendLog("ERR: load failed -> " + e.message);
  console.error(e);
});
