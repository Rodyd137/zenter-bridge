const deviceDefaults = {
  LABEL: "",
  DEVICE_UUID: "",
  DEVICE_KEY: "",
  ENROLL_TOKEN: "",
  HIK_IP: "",
  HIK_USER: "admin",
  HIK_PASS: "",
};

function el(id){ return document.getElementById(id); }

function esc(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function appendLog(msg) {
  if (!msg) return;
  const box = el("logs");
  box.textContent = (box.textContent + "\n" + msg).trim();
  box.scrollTop = box.scrollHeight;
}

function setUpdateUI(state) {
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
    if (legacy.DEVICE_UUID || legacy.DEVICE_KEY || legacy.HIK_IP || legacy.ENROLL_TOKEN) {
      devices = [legacy];
    }
  }

  if (!devices.length) devices = [ { ...deviceDefaults } ];

  return devices.map((d) => ({
    ...deviceDefaults,
    LABEL: String(d?.LABEL || d?.label || "").trim(),
    DEVICE_UUID: String(d?.DEVICE_UUID || d?.device_uuid || d?.device_id || "").trim(),
    DEVICE_KEY: String(d?.DEVICE_KEY || d?.device_key || "").trim(),
    ENROLL_TOKEN: String(d?.ENROLL_TOKEN || d?.enroll_token || "").trim(),
    HIK_IP: String(d?.HIK_IP || d?.hik_ip || "").trim(),
    HIK_USER: String(d?.HIK_USER || d?.hik_user || "admin").trim() || "admin",
    HIK_PASS: String(d?.HIK_PASS || d?.hik_pass || "").trim(),
  }));
}

let stateDevices = [];

function deviceCard(d, i) {
  const idMeta = d.DEVICE_UUID ? d.DEVICE_UUID : "sin registrar";

  return `
    <div class="device-card" data-index="${i}">
      <div class="device-head">
        <div class="device-title">
          <input class="field" data-field="LABEL" data-index="${i}" placeholder="Nombre del dispositivo" value="${esc(d.LABEL)}" />
          <div class="device-meta">#${i + 1} · ${esc(idMeta)}</div>
        </div>
        <div class="actions">
          <button class="btn ghost" data-action="enroll" data-index="${i}">Registrar</button>
          <button class="btn danger" data-action="remove" data-index="${i}">Eliminar</button>
        </div>
      </div>

      <div class="device-grid">
        <div>
          <label>HIK IP <span class="hint">IP del equipo</span></label>
          <input class="field" data-field="HIK_IP" data-index="${i}" placeholder="192.168.20.10" value="${esc(d.HIK_IP)}" />
        </div>
        <div>
          <label>Usuario <span class="hint">Hikvision</span></label>
          <input class="field" data-field="HIK_USER" data-index="${i}" placeholder="admin" value="${esc(d.HIK_USER)}" />
        </div>
        <div>
          <label>Contraseña <span class="hint">Hikvision</span></label>
          <input class="field" data-field="HIK_PASS" data-index="${i}" type="password" placeholder="password" value="${esc(d.HIK_PASS)}" />
        </div>
        <div>
          <label>DEVICE UUID <span class="hint">Access Devices ID</span></label>
          <input class="field" data-field="DEVICE_UUID" data-index="${i}" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value="${esc(d.DEVICE_UUID)}" />
        </div>
        <div>
          <label>DEVICE KEY <span class="hint">Key del dispositivo</span></label>
          <input class="field" data-field="DEVICE_KEY" data-index="${i}" placeholder="device_key" value="${esc(d.DEVICE_KEY)}" />
        </div>
        <div>
          <label>ENROLL TOKEN <span class="hint">Token de activación</span></label>
          <input class="field" data-field="ENROLL_TOKEN" data-index="${i}" placeholder="token" value="${esc(d.ENROLL_TOKEN)}" />
        </div>
      </div>
    </div>
  `;
}

function renderDevices() {
  const list = el("devicesList");
  if (!list) return;
  list.innerHTML = stateDevices.map(deviceCard).join("");
  const count = el("devicesCount");
  if (count) count.textContent = String(stateDevices.length || 0);
}

function collectDevices() {
  const cards = Array.from(document.querySelectorAll(".device-card"));
  return cards.map((card) => {
    const obj = { ...deviceDefaults };
    card.querySelectorAll("[data-field]").forEach((input) => {
      const key = input.getAttribute("data-field");
      obj[key] = String(input.value || "").trim();
    });
    if (!obj.HIK_USER) obj.HIK_USER = "admin";
    return obj;
  });
}

function setStateLabel(st) {
  const elState = el("state");
  if (!elState) return;
  if (!st) {
    elState.textContent = "STOPPED";
    return;
  }
  const running = !!st.running;
  const count = Number(st.count || 0);
  const total = Number(st.total || 0);
  if (running) {
    elState.textContent = total ? `RUNNING (${count}/${total})` : "RUNNING";
  } else {
    elState.textContent = total ? `STOPPED (0/${total})` : "STOPPED";
  }
}

async function load() {
  const cfg = await window.ZBridge.cfgGet();
  stateDevices = normalizeDevices(cfg);
  renderDevices();

  const st = await window.ZBridge.bridgeRunning();
  setStateLabel(st);

  const paths = await window.ZBridge.configPath();
  const pathEl = el("configPath");
  if (pathEl) pathEl.textContent = paths?.configPath || "—";

  setUpdateUI("idle");
}

async function save() {
  const cfg = await window.ZBridge.cfgGet();
  const devices = collectDevices();
  cfg.DEVICES = devices;

  const first = devices[0] || {};
  cfg.DEVICE_UUID = first.DEVICE_UUID || "";
  cfg.DEVICE_KEY = first.DEVICE_KEY || "";
  cfg.ENROLL_TOKEN = first.ENROLL_TOKEN || "";
  cfg.HIK_IP = first.HIK_IP || "";
  cfg.HIK_USER = first.HIK_USER || "admin";
  cfg.HIK_PASS = first.HIK_PASS || "";

  const res = await window.ZBridge.cfgSet(cfg);

  if (!res || !res.ok) {
    alert("No se pudo guardar.\n\n" + (res?.error || "unknown_error"));
    appendLog("ERR: cfg:set failed -> " + (res?.error || "unknown_error"));
    return;
  }

  alert("Guardado.");
  appendLog("Config guardada.");

  await load();
}

async function enroll(index) {
  try {
    const devices = collectDevices();
    const dev = devices[index];
    const token = String(dev?.ENROLL_TOKEN || "").trim();
    if (!token) return alert("Falta el token de activación.");

    appendLog(`Registrando dispositivo #${index + 1}...`);
    const res = await window.ZBridge.bridgeEnrollDevice({ index, token, device: dev });
    if (!res || !res.ok) {
      alert("No se pudo registrar.\n\n" + (res?.error || "unknown_error"));
      appendLog("ERR: enroll failed -> " + (res?.error || "unknown_error"));
      return;
    }
    appendLog("Dispositivo registrado: " + res.device_id);
    await load();
  } catch (e) {
    alert("enroll error: " + e.message);
  }
}

// =====================
// Buttons
// =====================
el("btnSave").onclick = () => save().catch(e => alert("save error: " + e.message));
el("btnStart").onclick = () => window.ZBridge.bridgeStart();
el("btnStop").onclick = () => window.ZBridge.bridgeStop();
el("btnRestart").onclick = () => window.ZBridge.bridgeRestart();

const btnAdd = el("btnAddDevice");
if (btnAdd) {
  btnAdd.onclick = () => {
    stateDevices = collectDevices();
    stateDevices.push({ ...deviceDefaults });
    renderDevices();
  };
}

const list = el("devicesList");
if (list) {
  list.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    const idx = Number(btn.getAttribute("data-index"));
    if (!Number.isFinite(idx)) return;

    if (action === "remove") {
      stateDevices = collectDevices();
      if (stateDevices.length <= 1) {
        alert("Debe existir al menos un dispositivo.");
        return;
      }
      stateDevices.splice(idx, 1);
      renderDevices();
    }

    if (action === "enroll") {
      enroll(idx);
    }
  });
}

// Updates buttons
const btnUpdateCheck = el("btnUpdateCheck");
if (btnUpdateCheck) {
  btnUpdateCheck.onclick = async () => {
    try {
      appendLog("Checking updates...");
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
      appendLog("Installing update...");
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
  setStateLabel(st);
});

if (window.ZBridge.onUpdateState) {
  window.ZBridge.onUpdateState((st) => {
    const state = st?.state || "idle";
    setUpdateUI(state);
    appendLog("Update state: " + state);
  });
}

load().catch((e) => {
  appendLog("ERR: load failed -> " + e.message);
  console.error(e);
});
