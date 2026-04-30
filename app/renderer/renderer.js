// ── Toast ──────────────────────────────────────────────────────────────────────
function toast(msg, type = "info", duration = 3800) {
  const container = document.getElementById("toasts");
  if (!container) { console.warn("[toast]", msg); return; }
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.textContent = msg;
  container.appendChild(t);
  const remove = () => {
    t.classList.add("out");
    setTimeout(() => t.remove(), 230);
  };
  const timer = setTimeout(remove, duration);
  t.onclick = () => { clearTimeout(timer); remove(); };
}

// ── Confirm modal ──────────────────────────────────────────────────────────────
function confirmModal(msg, opts = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const title = opts.title ? `<div class="modal-title">${String(opts.title).replaceAll("<","&lt;")}</div>` : "";
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        ${title}
        <p class="modal-msg">${String(msg).replaceAll("<","&lt;").replaceAll("\n","<br>")}</p>
        <div class="modal-actions">
          <button class="btn ghost" id="mCancel">Cancelar</button>
          <button class="btn ${opts.danger ? "danger" : "primary"}" id="mConfirm">${opts.confirmLabel || "Confirmar"}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const finish = (v) => { overlay.remove(); resolve(v); };
    overlay.querySelector("#mConfirm").onclick = () => finish(true);
    overlay.querySelector("#mCancel").onclick  = () => finish(false);
    overlay.onclick = (e) => { if (e.target === overlay) finish(false); };
    overlay.querySelector("#mConfirm").focus();
  });
}

// ── Log colorizer ──────────────────────────────────────────────────────────────
function logClass(msg) {
  const m = (msg || "").toUpperCase();
  if (/\b(ERR|ERROR|FAILED|FAIL|FALLO|EXCEPTION)\b/.test(m)) return "log-err";
  if (/\b(WARN|WARNING|ADVERTENCIA)\b/.test(m)) return "log-warn";
  if (/(^|\b)(OK\b|SUCCESS|ACTIVO|SYNCED|REGISTRADO|GUARDADO|INSERTED|FLUSHED|CONECTADO|DEMO COMPLETO)/.test(m)) return "log-ok";
  if (/\b(BOUNDARY|HEARTBEAT|EVENT|INICIANDO|STARTING|STREAM|BOUNDARY DETECTADO)\b/.test(m)) return "log-accent";
  return "";
}

function appendLog(msg) {
  if (!msg) return;
  const box = el("logs");
  if (!box) return;
  const line = document.createElement("div");
  line.className = "log-line " + logClass(msg);
  line.textContent = msg;
  box.appendChild(line);
  while (box.children.length > 600) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

// ── Device stats (populated by IPC poll) ──────────────────────────────────────
let allDeviceStats = {};

function fmtRelTime(isoStr) {
  if (!isoStr) return null;
  const diff = Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000);
  if (diff < 5)   return "justo ahora";
  if (diff < 60)  return `hace ${diff}s`;
  if (diff < 3600) return `hace ${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `hace ${Math.floor(diff / 3600)}h`;
  return `hace ${Math.floor(diff / 86400)}d`;
}

function statsChips(deviceId) {
  const s = allDeviceStats[deviceId];
  if (!s) return "";

  const connected = s.stream_connected;
  const connChip = connected
    ? `<span class="stat-chip ok">Stream activo</span>`
    : `<span class="stat-chip err">Stream desconectado</span>`;

  const lastEvt = fmtRelTime(s.last_event_at);
  const evtChip = lastEvt
    ? `<span class="stat-chip">Último evento <b>${lastEvt}</b></span>`
    : `<span class="stat-chip warn">Sin eventos aún</span>`;

  const q = Number(s.queue_depth || 0);
  const qChip = q > 0
    ? `<span class="stat-chip warn">Cola offline <b>${q}</b></span>`
    : `<span class="stat-chip ok">Cola vacía</span>`;

  const sess = Number(s.events_session || 0);
  const sessChip = `<span class="stat-chip">Sesión <b>${sess}</b> evento${sess !== 1 ? "s" : ""}</span>`;

  return `<div class="device-stats">${connChip}${evtChip}${qChip}${sessChip}</div>`;
}

async function refreshStats() {
  try {
    allDeviceStats = (await window.ZBridge.bridgeStats()) || {};
    // Patch only the stats rows without rebuilding cards
    document.querySelectorAll(".device-card").forEach((card, i) => {
      const d = stateDevices[i];
      if (!d?.DEVICE_UUID) return;
      let statsRow = card.querySelector(".device-stats");
      const html = statsChips(d.DEVICE_UUID);
      if (!html) { if (statsRow) statsRow.remove(); return; }
      if (statsRow) {
        statsRow.outerHTML = html;
      } else {
        const footer = card.querySelector(".device-footer");
        if (footer) footer.insertAdjacentHTML("afterend", html);
      }
    });
  } catch {}
}

// ── Shared ─────────────────────────────────────────────────────────────────────
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

function setUpdateUI(state) {
  const s = String(state || "idle");
  const pill = el("updatePill");
  const label = el("updateState");
  const map = {
    idle: null,
    checking: "Buscando actualizaciones",
    available: "Actualización disponible",
    downloading: "Descargando actualización",
    downloaded: "Actualización lista — reinicia para instalar",
    error: "Error de actualización"
  };
  const text = map[s] !== undefined ? map[s] : s.toUpperCase();
  if (pill) pill.style.display = text ? "inline-flex" : "none";
  if (label) label.textContent = text || "";

  const btnCheck   = el("btnUpdateCheck");
  const btnInstall = el("btnUpdateInstall");
  if (btnCheck)   btnCheck.disabled   = (s === "checking" || s === "downloading");
  if (btnInstall) btnInstall.disabled = (s !== "downloaded");
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
    LABEL:       String(d?.LABEL       || d?.label       || "").trim(),
    DEVICE_UUID: String(d?.DEVICE_UUID || d?.device_uuid || d?.device_id || "").trim(),
    DEVICE_KEY:  String(d?.DEVICE_KEY  || d?.device_key  || "").trim(),
    ENROLL_TOKEN:String(d?.ENROLL_TOKEN|| d?.enroll_token|| "").trim(),
    HIK_IP:      String(d?.HIK_IP      || d?.hik_ip      || "").trim(),
    HIK_USER:    String(d?.HIK_USER    || d?.hik_user    || "admin").trim() || "admin",
    HIK_PASS:    String(d?.HIK_PASS    || d?.hik_pass    || "").trim(),
    HIK_TIME_ZONE:  String(d?.HIK_TIME_ZONE  || d?.hik_time_zone  || "").trim(),
    HIK_TIME_MODE:  String(d?.HIK_TIME_MODE  || d?.hik_time_mode  || "").trim(),
    HIK_LOCAL_TIME: String(d?.HIK_LOCAL_TIME || d?.hik_local_time || "").trim(),
    HIK_MODEL:   String(d?.HIK_MODEL   || d?.hik_model   || "").trim(),
    HIK_SERIAL:  String(d?.HIK_SERIAL  || d?.hik_serial  || "").trim(),
    HIK_MAC:     String(d?.HIK_MAC     || d?.hik_mac     || "").trim(),
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
  const hasDevice = !!(
    String(d.DEVICE_UUID || "").trim() &&
    String(d.DEVICE_KEY  || "").trim()
  );
  const key       = deviceKey(d, i);
  const isEditing = editingKeys.has(key);
  const showAdvanced = !hasDevice || isEditing;
  const showEnroll   = !hasDevice;
  const isLocked     = hasDevice && !isEditing;
  const disabledAttr = isLocked ? "disabled" : "";

  const model    = String(d.HIK_MODEL  || "").trim();
  const serial   = String(d.HIK_SERIAL || "").trim();
  const modelSerial = (model || serial) ? `${model || "—"} · ${serial || "—"}` : "";
  const title    = modelSerial || (d.LABEL ? d.LABEL : "Dispositivo");
  const tz       = d.HIK_TIME_ZONE || "";

  const isRunning = runningIds.has(deviceKey(d, i));
  const dotClass  = isRunning ? "good" : (hasDevice ? "bad" : "idle");

  const toggleLabel  = isRunning ? "Detener" : "Iniciar";
  const toggleAction = isRunning ? "stop" : "start";
  const toggleClass  = isRunning ? "btn danger" : "btn";

  const saveBtn   = hasDevice && isEditing
    ? `<button class="btn primary" data-action="save" data-index="${i}">Guardar</button>`
    : "";
  const editBtn   = hasDevice
    ? `<button class="btn ghost" data-action="edit" data-index="${i}">${isEditing ? "Cerrar" : "Editar"}</button>`
    : `<button class="btn ghost" data-action="enroll" data-index="${i}">Registrar</button>`;
  const toggleBtn = hasDevice && !isEditing
    ? `<button class="${toggleClass}" data-action="${toggleAction}" data-index="${i}">${toggleLabel}</button>`
    : "";
  const restartBtn = hasDevice && !isEditing && isRunning
    ? `<button class="btn" data-action="restart" data-index="${i}">Reiniciar</button>`
    : "";
  const removeBtn = (hasDevice && isEditing) || !hasDevice
    ? `<button class="btn danger" data-action="remove" data-index="${i}">Eliminar</button>`
    : "";

  const hidden = (field, value) =>
    `<input type="hidden" data-field="${field}" data-index="${i}" value="${esc(value)}" />`;

  const statusText = isRunning
    ? `<span style="font-size:11px;color:var(--good);font-weight:600">Activo</span>`
    : hasDevice
      ? `<span style="font-size:11px;color:var(--muted)">Detenido</span>`
      : `<span style="font-size:11px;color:var(--muted)">Sin registrar</span>`;

  return `
    <div class="device-card" data-index="${i}">
      <div class="device-head">
        <div class="device-title">
          <span class="device-status-dot ${dotClass}"></span>
          <div>
            <div><strong>${esc(title)}</strong></div>
            ${statusText}
          </div>
        </div>
        <div class="actions">
          ${removeBtn}
          ${restartBtn}
          ${toggleBtn}
          ${saveBtn}
          ${editBtn}
        </div>
      </div>

      <div class="device-grid">
        ${hasDevice ? `
        <div>
          <label>Nombre</label>
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
          <input class="field" data-field="HIK_PASS" data-index="${i}" ${disabledAttr} type="password" placeholder="••••••••" value="${esc(d.HIK_PASS)}" />
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
        ${hidden("HIK_USER",     d.HIK_USER)}
        ${hidden("HIK_PASS",     d.HIK_PASS)}
        ${hidden("DEVICE_UUID",  d.DEVICE_UUID)}
        ${hidden("DEVICE_KEY",   d.DEVICE_KEY)}
        ${hidden("ENROLL_TOKEN", d.ENROLL_TOKEN)}
        `}
        ${hidden("HIK_TIME_ZONE",  d.HIK_TIME_ZONE)}
        ${hidden("HIK_TIME_MODE",  d.HIK_TIME_MODE)}
        ${hidden("HIK_LOCAL_TIME", d.HIK_LOCAL_TIME)}
        ${hidden("HIK_MODEL",  d.HIK_MODEL)}
        ${hidden("HIK_SERIAL", d.HIK_SERIAL)}
        ${hidden("HIK_MAC",    d.HIK_MAC)}
      </div>

      ${hasDevice ? `
      <div class="device-footer">
        <span class="hint">
          ${tz ? `Zona: ${esc(tz)}` : "Zona: sin detectar"}
          ${model  ? ` · ${esc(model)}`  : ""}
          ${serial ? ` · S/N ${esc(serial)}` : ""}
          ${d.HIK_MAC ? ` · ${esc(d.HIK_MAC)}` : ""}
        </span>
      </div>
      ${statsChips(d.DEVICE_UUID)}
      ` : ""}
    </div>
  `;
}

function nextDefaultLabel(devices) {
  let max = 0;
  devices.forEach((d) => {
    const m = /^Dispositivo\s+(\d+)/i.exec(String(d?.LABEL || "").trim());
    if (m) { const n = Number(m[1]); if (Number.isFinite(n) && n > max) max = n; }
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

  return devices.map((d) => {
    if (String(d?.LABEL || "").trim()) return d;
    if (!assignedBridge && !anyLabel && bridgeId) {
      assignedBridge = true;
      return { ...d, LABEL: bridgeId };
    }
    return { ...d, LABEL: pickNext() };
  });
}

function patchRunningState() {
  if (!editingKeys.size) {
    renderDevices();
    return;
  }
  // Cards in edit mode keep their DOM; only rebuild the rest
  const cards = Array.from(document.querySelectorAll(".device-card"));
  cards.forEach((card, i) => {
    const d = stateDevices[i];
    if (!d) return;
    if (editingKeys.has(deviceKey(d, i))) return;
    const tmp = document.createElement("div");
    tmp.innerHTML = deviceCard(d, i).trim();
    card.replaceWith(tmp.firstElementChild);
  });
}

function renderDevices() {
  const list = el("devicesList");
  if (!list) return;

  if (!stateDevices.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>
          </svg>
        </div>
        <div class="empty-title">Sin dispositivos configurados</div>
        <div class="empty-sub">Usa "+ Agregar dispositivo" para registrar tu primer equipo Hikvision.</div>
      </div>`;
    return;
  }

  const ordered = [...stateDevices].sort((a, b) => {
    const aEmpty = !String(a?.DEVICE_UUID || "").trim();
    const bEmpty = !String(b?.DEVICE_UUID || "").trim();
    if (aEmpty === bEmpty) return 0;
    return aEmpty ? -1 : 1;
  });
  list.innerHTML = ordered.map(deviceCard).join("");
}

function collectDevices() {
  return Array.from(document.querySelectorAll(".device-card")).map((card) => {
    const obj = { ...deviceDefaults };
    card.querySelectorAll("[data-field]").forEach((input) => {
      obj[input.getAttribute("data-field")] = String(input.value || "").trim();
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
    elState.textContent = "Detenido";
    return;
  }
  isBridgeRunning = !!st.running;
  runningIds = new Set(st.device_running_ids || []);
  const count = Number(st.count || 0);
  const total = Number(st.total || 0);
  if (isBridgeRunning) {
    elState.textContent = total ? `Activo (${count}/${total})` : "Activo";
  } else {
    elState.textContent = total ? `Detenido (0/${total})` : "Detenido";
  }
}

async function load() {
  const cfg = await window.ZBridge.cfgGet();
  stateDevices = ensureDefaultLabels(normalizeDevices(cfg), String(cfg?.BRIDGE_ID || "").trim());

  const st = await window.ZBridge.bridgeRunning();
  setStateLabel(st);
  renderDevices();

  setUpdateUI("idle");

  try {
    const v = await window.ZBridge.appVersion();
    const badge = el("versionBadge");
    if (badge && v) badge.textContent = `v${v}`;
  } catch {}
}

async function reloadDevicesFromConfig() {
  const cfg = await window.ZBridge.cfgGet();
  stateDevices = ensureDefaultLabels(normalizeDevices(cfg), String(cfg?.BRIDGE_ID || "").trim());
  renderDevices();
}

async function refreshRunningState() {
  const st = await window.ZBridge.bridgeRunning();
  setStateLabel(st);
  patchRunningState();
}

async function persistDevices(devices, opts = {}) {
  const cfg = await window.ZBridge.cfgGet();
  cfg.DEVICES = devices;

  const first = devices[0] || {};
  cfg.DEVICE_UUID  = first.DEVICE_UUID  || "";
  cfg.DEVICE_KEY   = first.DEVICE_KEY   || "";
  cfg.ENROLL_TOKEN = first.ENROLL_TOKEN || "";
  cfg.HIK_IP   = first.HIK_IP   || "";
  cfg.HIK_USER = first.HIK_USER || "admin";
  cfg.HIK_PASS = first.HIK_PASS || "";

  const res = await window.ZBridge.cfgSet(cfg);

  if (!res || !res.ok) {
    if (!opts.silent) toast("No se pudo guardar: " + (res?.error || "error desconocido"), "err");
    appendLog("ERR: cfg:set failed -> " + (res?.error || "unknown_error"));
    return { ok: false, error: res?.error || "unknown_error" };
  }

  if (!opts.silent) {
    toast("Configuración guardada", "ok");
    appendLog("Config guardada.");
  }

  return { ok: true, saved: res.saved };
}

async function enroll(index) {
  try {
    const devices = collectDevices();
    const dev = devices[index];
    const token = String(dev?.ENROLL_TOKEN || "").trim();
    if (!token) {
      toast("Falta el token de activación.", "warn");
      return;
    }

    appendLog(`Registrando dispositivo #${index + 1}...`);
    const res = await window.ZBridge.bridgeEnrollDevice({ index, token, device: dev, devices });

    if (!res || !res.ok) {
      toast("No se pudo registrar: " + (res?.error || "error desconocido"), "err");
      appendLog("ERR: enroll failed -> " + (res?.error || "unknown_error"));
      return;
    }

    toast("Dispositivo registrado correctamente", "ok");
    appendLog("Dispositivo registrado: " + res.device_id);

    if (res.device) {
      devices[index] = { ...devices[index], ...res.device };
      stateDevices = ensureDefaultLabels(devices);
      renderDevices();
    }

    setTimeout(() => { load().catch(() => {}); }, 1500);

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
    toast("Error al registrar: " + e.message, "err");
  }
}

// ── Button handlers ────────────────────────────────────────────────────────────
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
    const idx    = Number(btn.getAttribute("data-index"));
    if (!Number.isFinite(idx)) return;

    const devices  = collectDevices();
    const dev      = devices[idx];
    const deviceId = String(dev?.DEVICE_UUID || `idx-${idx}`).trim();

    if (action === "remove") {
      stateDevices = devices;
      const hasId  = !!String(dev?.DEVICE_UUID || "").trim();
      const hasKey = !!String(dev?.DEVICE_KEY  || "").trim();

      if (hasId && !hasKey) {
        const ok = await confirmModal(
          "Falta la llave del dispositivo, no se puede eliminar de la base de datos. ¿Eliminar solo del bridge?",
          { danger: true, confirmLabel: "Eliminar del bridge" }
        );
        if (!ok) return;
      }

      if (hasId && hasKey) {
        const ok = await confirmModal(
          "¿Eliminar este dispositivo? También se eliminará de la base de datos.",
          { title: "Eliminar dispositivo", danger: true, confirmLabel: "Eliminar" }
        );
        if (!ok) return;

        try {
          const res = await window.ZBridge.bridgeDeleteDevice({ device: dev });
          if (!res || !res.ok) {
            const errMsg = String(res?.error || "").toLowerCase();
            if (errMsg.includes("invalid device key")) {
              const okLocal = await confirmModal(
                "No se pudo eliminar de la base de datos (llave inválida). ¿Eliminar solo del bridge?",
                { danger: true, confirmLabel: "Eliminar del bridge" }
              );
              if (!okLocal) return;
              appendLog("WARN: delete device db failed (invalid device key). Se eliminó solo en el bridge.");
            } else {
              toast("No se pudo eliminar de la base de datos: " + (res?.error || "error"), "err");
              appendLog("ERR: delete device -> " + (res?.error || "unknown_error"));
              return;
            }
          }
        } catch (e) {
          const errMsg = String(e?.message || e || "").toLowerCase();
          if (errMsg.includes("invalid device key")) {
            const okLocal = await confirmModal(
              "No se pudo eliminar de la base de datos (llave inválida). ¿Eliminar solo del bridge?",
              { danger: true, confirmLabel: "Eliminar del bridge" }
            );
            if (!okLocal) return;
            appendLog("WARN: delete device db failed (invalid device key). Se eliminó solo en el bridge.");
          } else {
            toast("No se pudo eliminar: " + (e?.message || e), "err");
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
      if (!saved?.ok) return;
      toast("Dispositivo eliminado", "ok");
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

    if (action === "save") {
      stateDevices = devices;
      const key = deviceKey(stateDevices[idx], idx);
      editingKeys.delete(key);
      const res = await persistDevices(stateDevices, { silent: true });
      if (res?.ok) toast("Cambios guardados", "ok");
      else toast(res?.error || "No se pudo guardar", "err");
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

const btnUpdateCheck = el("btnUpdateCheck");
if (btnUpdateCheck) {
  btnUpdateCheck.onclick = async () => {
    try {
      appendLog("Buscando actualizaciones...");
      await window.ZBridge.updatesCheck();
    } catch (e) {
      appendLog("ERR: updatesCheck -> " + e.message);
      toast("Error al buscar actualizaciones: " + e.message, "err");
    }
  };
}

const btnUpdateInstall = el("btnUpdateInstall");
if (btnUpdateInstall) {
  btnUpdateInstall.onclick = async () => {
    try {
      appendLog("Instalando actualización...");
      await window.ZBridge.updatesInstall();
    } catch (e) {
      appendLog("ERR: updatesInstall -> " + e.message);
      toast("Error al instalar actualización: " + e.message, "err");
    }
  };
}

// ── IPC listeners ──────────────────────────────────────────────────────────────
window.ZBridge.onLog((msg) => appendLog(msg));

window.ZBridge.onState((st) => {
  setStateLabel(st);
  patchRunningState();
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
    if (state !== "idle") appendLog("Estado actualización: " + state);
  });
}

load().catch((e) => {
  appendLog("ERR: load failed -> " + e.message);
  console.error(e);
});

// Actualizar stats cada 20 segundos
setInterval(() => refreshStats(), 20000);
