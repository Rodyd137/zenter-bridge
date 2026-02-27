const deviceDefaults = {
  LABEL: "",
  DEVICE_UUID: "",
  DEVICE_KEY: "",
  ENROLL_TOKEN: "",
  HIK_IP: "",
  HIK_USER: "admin",
  HIK_PASS: "",
  HIK_TIME_ZONE: "",
  HIK_TIME_MODE: "",
  HIK_LOCAL_TIME: "",
  HIK_MODEL: "",
  HIK_SERIAL: "",
  HIK_MAC: "",
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
  const pill = el("updatePill");
  const label = el("updateState");
  const map = {
    idle: "Actualizado",
    checking: "Buscando actualizaciones",
    available: "Actualizacion disponible",
    downloading: "Descargando actualizacion",
    downloaded: "Actualizacion lista",
    error: "Error de actualizacion"
  };
  if (pill) pill.style.display = "inline-flex";
  if (label) label.textContent = map[s] || s.toUpperCase();

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

  if (!devices.length) devices = [];

  return devices.map((d) => ({
    ...deviceDefaults,
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

let stateDevices = [];
const editingKeys = new Set();
let isBridgeRunning = false;
let runningIds = new Set();

function deviceKey(d, i) {
  const id = String(d?.DEVICE_UUID || "").trim();
  return id || `idx-${i}`;
}

function deviceCard(d, i) {
  const idMeta = d.DEVICE_UUID ? d.DEVICE_UUID : "sin registrar";
  const hasDevice = !!String(d.DEVICE_UUID || "").trim();
  const key = deviceKey(d, i);
  const isEditing = editingKeys.has(key);
  const showAdvanced = !hasDevice || isEditing;
  const showEnroll = !hasDevice;
  const isLocked = hasDevice && !isEditing;
  const disabledAttr = isLocked ? "disabled" : "";
  const model = String(d.HIK_MODEL || "").trim();
  const serial = String(d.HIK_SERIAL || "").trim();
  const modelSerial = (model || serial) ? `${model || "-"} | ${serial || "-"}` : "";
  const title = modelSerial || (d.LABEL ? d.LABEL : "Dispositivo");
  const isDeviceRunning = runningIds.has(deviceKey(d, i));
  const toggleLabel = isDeviceRunning ? "Detener" : "Iniciar";
  const toggleAction = isDeviceRunning ? "stop" : "start";
  const toggleClass = isDeviceRunning ? "btn danger" : "btn";
  const editBtn = hasDevice
    ? `<button class="btn ghost" data-action="edit" data-index="${i}">${isEditing ? "Cerrar" : "Editar"}</button>`
    : `<button class="btn ghost" data-action="enroll" data-index="${i}">Registrar</button>`;
  const toggleBtn = hasDevice && !isEditing
    ? `<button class="${toggleClass}" data-action="${toggleAction}" data-index="${i}">${toggleLabel}</button>`
    : "";
  const restartBtn = hasDevice && !isEditing && isDeviceRunning
    ? `<button class="btn" data-action="restart" data-index="${i}">Reiniciar</button>`
    : "";
  const removeBtn = (hasDevice && isEditing) || !hasDevice
    ? `<button class="btn danger" data-action="remove" data-index="${i}">Eliminar</button>`
    : "";

  const hidden = (field, value) =>
    `<input type="hidden" data-field="${field}" data-index="${i}" value="${esc(value)}" />`;

  return `
    <div class="device-card" data-index="${i}">
      <div class="device-head">
        <div class="device-title">
          <div class="small"><strong>${esc(title)}</strong></div>
        </div>
        <div class="actions">
          ${removeBtn}
          ${restartBtn}
          ${toggleBtn}
          ${editBtn}
        </div>
      </div>

      <div class="device-grid">
        ${hasDevice ? `
        <div>
          <label>Nombre de dispositivo</label>
          <input class="field" data-field="LABEL" data-index="${i}" ${disabledAttr} placeholder="Nombre del dispositivo" value="${esc(d.LABEL)}" />
        </div>
        ` : ``}
        <div>
          <label>Dirección IP</label>
          <input class="field" data-field="HIK_IP" data-index="${i}" ${disabledAttr} placeholder="192.168.20.10" value="${esc(d.HIK_IP)}" />
        </div>
        ${showAdvanced ? `
        <div>
          <label>Usuario</label>
          <input class="field" data-field="HIK_USER" data-index="${i}" ${disabledAttr} placeholder="admin" value="${esc(d.HIK_USER)}" />
        </div>
        <div>
          <label>Contraseña</label>
          <input class="field" data-field="HIK_PASS" data-index="${i}" ${disabledAttr} type="password" placeholder="password" value="${esc(d.HIK_PASS)}" />
        </div>
        ${hasDevice ? `
        <div>
          <label>ID del dispositivo</label>
          <input class="field" data-field="DEVICE_UUID" data-index="${i}" ${disabledAttr} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value="${esc(d.DEVICE_UUID)}" />
        </div>
        <div>
          <label>Llave del dispositivo</label>
          <input class="field" data-field="DEVICE_KEY" data-index="${i}" ${disabledAttr} placeholder="device_key" value="${esc(d.DEVICE_KEY)}" />
        </div>
        ` : ``}
        ${showEnroll ? `
        <div>
          <label>Token de activación</label>
          <input class="field" data-field="ENROLL_TOKEN" data-index="${i}" ${disabledAttr} placeholder="token" value="${esc(d.ENROLL_TOKEN)}" />
        </div>
        ` : ``}
        ` : `
        ${hidden("HIK_USER", d.HIK_USER)}
        ${hidden("HIK_PASS", d.HIK_PASS)}
        ${hidden("DEVICE_UUID", d.DEVICE_UUID)}
        ${hidden("DEVICE_KEY", d.DEVICE_KEY)}
        ${hidden("ENROLL_TOKEN", d.ENROLL_TOKEN)}
        `}
        ${hidden("HIK_TIME_ZONE", d.HIK_TIME_ZONE)}
        ${hidden("HIK_TIME_MODE", d.HIK_TIME_MODE)}
        ${hidden("HIK_LOCAL_TIME", d.HIK_LOCAL_TIME)}
        ${hidden("HIK_MODEL", d.HIK_MODEL)}
        ${hidden("HIK_SERIAL", d.HIK_SERIAL)}
        ${hidden("HIK_MAC", d.HIK_MAC)}
      </div>
      <div class="device-footer">
        <div class="hint">Zona horaria: ${esc(d.HIK_TIME_ZONE || "sin detectar")} - Modelo: ${esc(d.HIK_MODEL || "-")} - S/N: ${esc(d.HIK_SERIAL || "-")} - MAC: ${esc(d.HIK_MAC || "-")}</div>
      </div>
    </div>
  `;
}

function nextDefaultLabel(devices) {
  let max = 0;
  devices.forEach((d) => {
    const m = /^Dispositivo\s+(\d+)/i.exec(String(d?.LABEL || "").trim());
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > max) max = n;
    }
  });
  return `Dispositivo ${max + 1}`;
}

function ensureDefaultLabels(devices, bridgeId) {
  const used = new Set();
  devices.forEach((d) => {
    const m = /^Dispositivo\s+(\d+)/i.exec(String(d?.LABEL || "").trim());
    if (m) used.add(Number(m[1]));
  });

  let next = 1;
  const pickNext = () => {
    while (used.has(next)) next += 1;
    used.add(next);
    return `Dispositivo ${next}`;
  };

  let assignedBridge = false;
  const anyLabel = devices.some((d) => String(d?.LABEL || "").trim());

  return devices.map((d, idx) => {
    if (String(d?.LABEL || "").trim()) return d;
    if (!assignedBridge && !anyLabel && bridgeId) {
      assignedBridge = true;
      return { ...d, LABEL: bridgeId };
    }
    return { ...d, LABEL: pickNext() };
  });
}

function renderDevices() {
  const list = el("devicesList");
  if (!list) return;
  const ordered = [...stateDevices].sort((a, b) => {
    const aEmpty = !String(a?.DEVICE_UUID || "").trim();
    const bEmpty = !String(b?.DEVICE_UUID || "").trim();
    if (aEmpty === bEmpty) return 0;
    return aEmpty ? -1 : 1;
  });
  list.innerHTML = ordered.map(deviceCard).join("");
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
    isBridgeRunning = false;
    runningIds = new Set();
    elState.textContent = "DETENIDO";
    return;
  }
  const running = !!st.running;
  isBridgeRunning = running;
  runningIds = new Set(st.device_running_ids || []);
  const count = Number(st.count || 0);
  const total = Number(st.total || 0);
  if (running) {
    elState.textContent = total ? `Activo (${count}/${total})` : "Activo";
  } else {
    elState.textContent = total ? `DETENIDO (0/${total})` : "DETENIDO";
  }
}

async function load() {
  const cfg = await window.ZBridge.cfgGet();
  stateDevices = ensureDefaultLabels(normalizeDevices(cfg), String(cfg?.BRIDGE_ID || "").trim());

  const st = await window.ZBridge.bridgeRunning();
  setStateLabel(st);
  renderDevices();

  setUpdateUI("idle");
}

async function reloadDevicesFromConfig() {
  const cfg = await window.ZBridge.cfgGet();
  stateDevices = ensureDefaultLabels(normalizeDevices(cfg), String(cfg?.BRIDGE_ID || "").trim());
  renderDevices();
}

async function refreshRunningState() {
  const st = await window.ZBridge.bridgeRunning();
  setStateLabel(st);
  renderDevices();
}

async function persistDevices(devices, opts = {}) {
  const cfg = await window.ZBridge.cfgGet();
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
    if (!opts.silent) {
      alert("No se pudo guardar.\n\n" + (res?.error || "unknown_error"));
    }
    appendLog("ERR: cfg:set failed -> " + (res?.error || "unknown_error"));
    return { ok: false, error: res?.error || "unknown_error" };
  }

  if (!opts.silent) {
    alert("Guardado.");
    appendLog("Config guardada.");
  }

  return { ok: true, saved: res.saved };
}

async function save() {
  const devices = collectDevices();
  const res = await persistDevices(devices, { silent: false });
  if (!res || !res.ok) return;
  await load();
}

async function enroll(index) {
  try {
    const devices = collectDevices();
    const dev = devices[index];
    const token = String(dev?.ENROLL_TOKEN || "").trim();
    if (!token) return alert("Falta el token de activación.");

    appendLog(`Registrando dispositivo #${index + 1}...`);
    const res = await window.ZBridge.bridgeEnrollDevice({
      index,
      token,
      device: dev,
      devices
    });
    if (!res || !res.ok) {
      alert("No se pudo registrar.\n\n" + (res?.error || "unknown_error"));
      appendLog("ERR: enroll failed -> " + (res?.error || "unknown_error"));
      return;
    }
    appendLog("Dispositivo registrado: " + res.device_id);
    if (res.device) {
      devices[index] = { ...devices[index], ...res.device };
      stateDevices = ensureDefaultLabels(devices);
      renderDevices();
    }
    setTimeout(() => {
      load().catch(() => {});
    }, 1500);
    setTimeout(async () => {
      try {
        const info = await window.ZBridge.deviceRefreshInfo(res.device_id);
        if (info?.ok && info?.updated) {
          devices[index] = { ...devices[index], ...info.updated };
          stateDevices = ensureDefaultLabels(devices);
          renderDevices();
        }
      } catch {}
    }, 3500);
  } catch (e) {
    alert("enroll error: " + e.message);
  }
}

// =====================
// Buttons
// =====================
const btnSave = el("btnSave");
if (btnSave) btnSave.onclick = () => save().catch(e => alert("save error: " + e.message));
const btnStart = el("btnStart");
if (btnStart) btnStart.onclick = async () => { await window.ZBridge.bridgeStart(); await refreshRunningState(); };
const btnStop = el("btnStop");
if (btnStop) btnStop.onclick = async () => { await window.ZBridge.bridgeStop(); await refreshRunningState(); };
const btnRestart = el("btnRestart");
if (btnRestart) btnRestart.onclick = async () => { await window.ZBridge.bridgeRestart(); await refreshRunningState(); };

const btnAdd = el("btnAddDevice");
if (btnAdd) {
  btnAdd.onclick = () => {
    stateDevices = ensureDefaultLabels(collectDevices());
    stateDevices.unshift({ ...deviceDefaults, LABEL: "" });
    renderDevices();
  };
}

const list = el("devicesList");
if (list) {
  list.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    const idx = Number(btn.getAttribute("data-index"));
    if (!Number.isFinite(idx)) return;
    const devices = collectDevices();
    const dev = devices[idx];
    const deviceId = String(dev?.DEVICE_UUID || `idx-${idx}`).trim();

    if (action === "remove") {
      stateDevices = devices;
      const hasId = !!String(dev?.DEVICE_UUID || "").trim();
      const hasKey = !!String(dev?.DEVICE_KEY || "").trim();
      if (hasId && !hasKey) {
        const okLocal = confirm("No se pudo eliminar en la base de datos porque falta DEVICE KEY. ¿Eliminar solo del bridge?");
        if (!okLocal) return;
      }
      if (hasId && hasKey) {
        const ok = confirm("¿Eliminar este dispositivo? También se eliminará de la base de datos.");
        if (!ok) return;
        try {
          const res = await window.ZBridge.bridgeDeleteDevice({ device: dev });
          if (!res || !res.ok) {
            const errMsg = String(res?.error || "unknown_error").toLowerCase();
            if (errMsg.includes("invalid device key")) {
              const okLocal = confirm("No se pudo eliminar en la base de datos (device key inválido). ¿Eliminar solo del bridge?");
              if (!okLocal) return;
              appendLog("WARN: delete device db failed (invalid device key). Se eliminó solo en el bridge.");
            } else {
              alert("No se pudo eliminar en la base de datos.\n\n" + (res?.error || "unknown_error"));
              appendLog("ERR: delete device -> " + (res?.error || "unknown_error"));
              return;
            }
          }
        } catch (e) {
          const errMsg = String(e?.message || e || "").toLowerCase();
          if (errMsg.includes("invalid device key")) {
            const okLocal = confirm("No se pudo eliminar en la base de datos (device key inválido). ¿Eliminar solo del bridge?");
            if (!okLocal) return;
            appendLog("WARN: delete device db failed (invalid device key). Se eliminó solo en el bridge.");
          } else {
            alert("No se pudo eliminar en la base de datos.\n\n" + (e?.message || e));
            appendLog("ERR: delete device -> " + (e?.message || e));
            return;
          }
        }
      }
      const key = deviceKey(dev, idx);
      editingKeys.delete(key);
      stateDevices.splice(idx, 1);
      renderDevices();
      const saved = await persistDevices(stateDevices, { silent: true });
      if (!saved || !saved.ok) return;
      await load();
    }

    if (action === "enroll") {
      enroll(idx);
    }

    if (action === "edit") {
      stateDevices = devices;
      const key = deviceKey(stateDevices[idx], idx);
      if (editingKeys.has(key)) editingKeys.delete(key);
      else editingKeys.add(key);
      renderDevices();
    }

    if (action === "start") {
      if (!deviceId) return;
      await window.ZBridge.deviceStart(deviceId);
      await refreshRunningState();
    }

    if (action === "stop") {
      if (!deviceId) return;
      await window.ZBridge.deviceStop(deviceId);
      await refreshRunningState();
    }

    if (action === "restart") {
      if (!deviceId) return;
      await window.ZBridge.deviceRestart(deviceId);
      await refreshRunningState();
    }
  });
}

// Updates buttons
const btnUpdateCheck = el("btnUpdateCheck");
if (btnUpdateCheck) {
  btnUpdateCheck.onclick = async () => {
    try {
      appendLog("Buscando actualizaciones...");
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
      appendLog("Instalando actualizacion...");
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
  renderDevices();
});

if (window.ZBridge.onConfigUpdated) {
  window.ZBridge.onConfigUpdated(() => {
    if (editingKeys.size) return;
    reloadDevicesFromConfig().catch(() => {});
  });
}

if (window.ZBridge.onUpdateState) {
  window.ZBridge.onUpdateState((st) => {
    const state = st?.state || "idle";
    setUpdateUI(state);
    appendLog("Estado actualizacion: " + state);
  });
}

load().catch((e) => {
  appendLog("ERR: load failed -> " + e.message);
  console.error(e);
});






















