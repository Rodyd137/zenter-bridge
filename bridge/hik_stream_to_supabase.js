// hik_stream_to_supabase.js (CommonJS)
// ✅ Hikvision alertStream multipart -> Supabase
// ✅ OFFLINE-SAFE: guarda eventos en disco (queue/) antes de insertar
// ✅ Reintenta pendientes automáticamente
// ✅ HEARTBEAT: upsert a access_device_heartbeats cada X ms
// ✅ CONFIG FILE: lee C:\ProgramData\ZenterBridge\config.json (PARTE 2.6)
//    - soporta JSONC/trailing commas porque usa bridge/config.js
// ✅ SAFE PATHS: queue/done se guardan en ProgramData (NO __dirname)
//
// Requiere (por config/env):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE
//   DEVICE_UUID   (uuid de access_devices.id)
//
// Opcionales:
//   HIK_IP, HIK_USER, HIK_PASS
//   SUPABASE_TABLE=access_events
//   START_MODE=now|all
//   RECONNECT_MS=1500
//   CURL_VERBOSE=0|1
//   FLUSH_INTERVAL_MS=5000
//   INSERT_CONCURRENCY=3
//   BRIDGE_ID=FEDI-PC-1
//   HEARTBEAT_MS=15000
//   HEARTBEAT_TABLE=access_device_heartbeats
//   BRIDGE_VERSION=zenter-bridge@1.0.0

const path = require("path");
const os = require("os");
const fs = require("fs");
const fsp = require("fs/promises");
const { spawn } = require("child_process");
const { createClient } = require("@supabase/supabase-js");

// ✅ Usa el config manager robusto (JSONC + merge + apply ALWAYS)
const {
  ROOT_DIR,
  CONFIG_PATH,
  ensureConfig,
  readConfig,
  applyConfigToEnv
} = require("./config");

// ---------- Utils ----------
function safeName(s) {
  return String(s || "").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
}

function isUniqueDuplicate(errMsg) {
  const m = String(errMsg || "").toLowerCase();
  return m.includes("duplicate") || m.includes("unique") || m.includes("violates unique");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nowIso() {
  return new Date().toISOString();
}

// ---------- Runtime state ----------
let streamConnected = false;
let lastEventIso = null;

let supabase = null;

// Valores (se cargan desde ENV después de aplicar config)
let HIK_IP = null;
let HIK_USER = null;
let HIK_PASS = null;

let SUPABASE_URL = null;
let SUPABASE_SERVICE_ROLE = null;

let TABLE = null;
let DEVICE_UUID = null;

let START_MODE = "now";
let RECONNECT_MS = 1500;
let CURL_VERBOSE = false;

let FLUSH_INTERVAL_MS = 5000;
let INSERT_CONCURRENCY = 3;

// Heartbeat
let BRIDGE_ID = null;
let HEARTBEAT_MS = 15000;
let HB_TABLE = "access_device_heartbeats";
let VERSION = "zenter-bridge@1.0.0";

// Backlog cutoff
let startCutoffMs = Date.now();

// Queue paths (ProgramData)
let DEVICE_DIR = null;
let QUEUE_DIR = null;
let DONE_DIR = null;
const USE_DONE_DIR = false;

// Parser buffers
let buf = Buffer.alloc(0);
let boundary = null;
let printedBoundary = false;

// ---------- Config + ENV ----------
function loadEnvFromConfig() {
  // 1) asegura config en ProgramData
  // 2) lee + merge + normaliza
  // 3) aplica al ENV SIEMPRE (no “si falta”)
  return ensureConfig()
    .then(() => readConfig())
    .then((cfg) => applyConfigToEnv(cfg));
}

function refreshSettingsFromEnv() {
  HIK_IP = process.env.HIK_IP || "192.168.20.170";
  HIK_USER = process.env.HIK_USER || "admin";
  HIK_PASS = process.env.HIK_PASS || "";

  SUPABASE_URL = process.env.SUPABASE_URL;
  SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

  TABLE = process.env.SUPABASE_TABLE || "access_events";
  DEVICE_UUID = process.env.DEVICE_UUID || null;

  START_MODE = (process.env.START_MODE || "now").toLowerCase() === "all" ? "all" : "now";
  RECONNECT_MS = Number(process.env.RECONNECT_MS || 1500);
  CURL_VERBOSE = String(process.env.CURL_VERBOSE ?? "0") === "1";

  FLUSH_INTERVAL_MS = Number(process.env.FLUSH_INTERVAL_MS || 5000);
  INSERT_CONCURRENCY = Math.max(1, Number(process.env.INSERT_CONCURRENCY || 3));

  BRIDGE_ID = process.env.BRIDGE_ID || os.hostname() || "bridge-1";
  HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 15000);
  HB_TABLE = process.env.HEARTBEAT_TABLE || "access_device_heartbeats";
  VERSION = process.env.BRIDGE_VERSION || "zenter-bridge@1.0.0";

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.error("❌ Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE.");
    console.error("   Config path:", CONFIG_PATH);
    process.exit(1);
  }
  if (!DEVICE_UUID) {
    console.error("❌ Falta DEVICE_UUID (uuid de access_devices.id).");
    console.error("   Config path:", CONFIG_PATH);
    process.exit(1);
  }

  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

  startCutoffMs = Date.now();
  if (START_MODE === "all") startCutoffMs = 0;

  // ✅ cola por dispositivo en ProgramData (evita cruces + permite multi-device futuro)
  DEVICE_DIR = path.join(ROOT_DIR, "devices", safeName(DEVICE_UUID));
  QUEUE_DIR = path.join(DEVICE_DIR, "queue");
  DONE_DIR = path.join(DEVICE_DIR, "done");
}

async function ensureDirs() {
  await fsp.mkdir(QUEUE_DIR, { recursive: true });
  if (USE_DONE_DIR) await fsp.mkdir(DONE_DIR, { recursive: true });
}

// ---------- Local Queue ----------
async function writeQueueFile(eventObj) {
  const serial = eventObj?.AccessControllerEvent?.serialNo ?? null;
  const dt = eventObj?.dateTime ? Date.parse(eventObj.dateTime) : Date.now();
  const ts = new Date(Number.isFinite(dt) ? dt : Date.now()).toISOString().replace(/[:.]/g, "-");
  const base = serial != null ? `serial_${serial}` : `time_${ts}_${Math.random().toString(16).slice(2)}`;

  const file = `${safeName(base)}.json`;
  const finalPath = path.join(QUEUE_DIR, file);
  const tmpPath = finalPath + ".tmp";

  const payload = {
    saved_at: nowIso(),
    device_id: DEVICE_UUID,
    raw: eventObj
  };

  await fsp.writeFile(tmpPath, JSON.stringify(payload), "utf8");
  await fsp.rename(tmpPath, finalPath);
  return finalPath;
}

async function removeOrArchive(filePath) {
  if (USE_DONE_DIR) {
    const name = path.basename(filePath);
    await fsp.rename(filePath, path.join(DONE_DIR, name));
  } else {
    await fsp.unlink(filePath).catch(() => {});
  }
}

async function listQueueFiles() {
  const entries = await fsp.readdir(QUEUE_DIR, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => path.join(QUEUE_DIR, e.name))
    .sort();
}

// ---------- Supabase insert ----------
async function insertToSupabaseFromRaw(rawPayload) {
  if (!rawPayload || rawPayload.eventType !== "AccessControllerEvent") return { ok: true, skipped: true };

  const t = rawPayload.dateTime ? Date.parse(rawPayload.dateTime) : NaN;
  if (!Number.isFinite(t)) return { ok: true, skipped: true };
  if (t < startCutoffMs) return { ok: true, skipped: true };

  const ace = rawPayload.AccessControllerEvent || {};
  const serialNo = ace.serialNo ?? null;

  const row = {
    device_id: DEVICE_UUID,
    event_time: new Date(t).toISOString(),
    event_type: rawPayload.eventType,
    employee_no: ace.employeeNoString ? String(ace.employeeNoString) : null,
    door_no: Number.isFinite(ace.doorNo) ? ace.doorNo : null,
    card_reader_no: Number.isFinite(ace.cardReaderNo) ? ace.cardReaderNo : null,
    major_event_type: Number.isFinite(ace.majorEventType) ? ace.majorEventType : null,
    sub_event_type: Number.isFinite(ace.subEventType) ? ace.subEventType : null,
    status_value: Number.isFinite(ace.statusValue) ? ace.statusValue : null,
    serial_no: serialNo,
    raw: rawPayload
  };

  const { error } = await supabase.from(TABLE).insert([row]);

  if (error) {
    if (isUniqueDuplicate(error.message)) return { ok: true, duplicate: true };
    return { ok: false, error: error.message || "insert_failed" };
  }

  console.log(
    "[OK] Guardado:",
    row.event_time,
    "| emp:",
    row.employee_no,
    "| sub:",
    row.sub_event_type,
    "| serial:",
    row.serial_no
  );
  return { ok: true };
}

// ---------- Flush queue ----------
let flushing = false;

async function flushQueueOnce() {
  if (flushing) return;
  flushing = true;

  try {
    const files = await listQueueFiles();
    if (files.length === 0) return;

    console.log(`[QUEUE] Cola pendiente: ${files.length} evento(s). Intentando subir...`);

    let idx = 0;
    let sent = 0;

    const workers = new Array(INSERT_CONCURRENCY).fill(null).map(async () => {
      while (idx < files.length) {
        const i = idx++;
        const file = files[i];

        let obj;
        try {
          const data = await fsp.readFile(file, "utf8");
          obj = JSON.parse(data);
        } catch {
          // si está corrupto, lo sacamos para no trancar
          await removeOrArchive(file);
          continue;
        }

        const raw = obj?.raw;
        const res = await insertToSupabaseFromRaw(raw);

        if (res.ok) {
          await removeOrArchive(file);
          sent += 1;
        } else {
          console.error("❌ Supabase insert error (cola):", res.error, "→ se queda en cola:", path.basename(file));
          // backoff pequeño
          await sleep(900);
        }
      }
    });

    await Promise.all(workers);

    if (sent > 0) console.log(`[FLUSH] subidos ${sent} evento(s) desde cola.`);
  } finally {
    flushing = false;
  }
}

// ---------- Heartbeat ----------
async function sendHeartbeat() {
  try {
    const files = await listQueueFiles();
    const queueDepth = files.length;

    const row = {
      device_id: DEVICE_UUID,
      bridge_id: BRIDGE_ID,
      last_seen: nowIso(),
      stream_connected: !!streamConnected,
      last_event_time: lastEventIso,
      queue_depth: queueDepth,
      ip: HIK_IP,
      host: os.hostname(),
      version: VERSION
    };

    const { error } = await supabase.from(HB_TABLE).upsert(row, { onConflict: "device_id,bridge_id" });
    if (error) console.error("heartbeat error:", error.message);
  } catch (e) {
    console.error("heartbeat fatal:", e.message);
  }
}

// ---------- Multipart parser ----------
function findDoubleCRLF(b) {
  for (let i = 0; i < b.length - 3; i++) {
    if (b[i] === 13 && b[i + 1] === 10 && b[i + 2] === 13 && b[i + 3] === 10) return i;
  }
  return -1;
}

function parseHeaders(txt) {
  const headers = {};
  txt.split("\r\n").forEach((line) => {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const k = line.slice(0, idx).trim().toLowerCase();
      const v = line.slice(idx + 1).trim();
      headers[k] = v;
    }
  });
  return headers;
}

function tryDetectBoundary() {
  if (boundary) return;
  const s = buf.toString("utf8");
  const m = s.match(/--([^\r\n]+)\r\nContent-Type:/i);
  if (m && m[1]) {
    boundary = `--${m[1]}`;
    streamConnected = true;

    if (!printedBoundary) {
      console.log("[OK] Boundary detectado:", boundary);
      printedBoundary = true;
    }
  }
}

async function onJsonEvent(payload) {
  if (payload?.dateTime) {
    const d = new Date(payload.dateTime);
    if (!Number.isNaN(d.getTime())) lastEventIso = d.toISOString();
  }

  // 1) guardar primero (offline-safe)
  const filePath = await writeQueueFile(payload);

  // 2) intentar subir
  const res = await insertToSupabaseFromRaw(payload);

  if (res.ok) {
    await removeOrArchive(filePath);
  } else {
    console.error(
      "❌ Supabase insert error (live):",
      res.error,
      "→ quedó en cola:",
      path.basename(filePath)
    );
  }
}

function consume() {
  tryDetectBoundary();
  if (!boundary) return;

  const bBuf = Buffer.from(boundary, "utf8");

  while (true) {
    const bIdx = buf.indexOf(bBuf);
    if (bIdx === -1) return;

    if (bIdx > 0) buf = buf.slice(bIdx);

    const maybeFinal = buf.slice(0, boundary.length + 2).toString("utf8");
    if (maybeFinal.startsWith(boundary + "--")) {
      buf = Buffer.alloc(0);
      return;
    }

    // boundary + CRLF
    if (buf.length < boundary.length + 2) return;
    if (!(buf[boundary.length] === 13 && buf[boundary.length + 1] === 10)) return;
    buf = buf.slice(boundary.length + 2);

    const hEnd = findDoubleCRLF(buf);
    if (hEnd === -1) return;

    const headerText = buf.slice(0, hEnd).toString("utf8");
    buf = buf.slice(hEnd + 4);

    const headers = parseHeaders(headerText);
    const ct = (headers["content-type"] || "").toLowerCase();
    const isJson = ct.includes("json");
    const cl = headers["content-length"];

    if (cl) {
      const len = parseInt(cl, 10);
      if (!Number.isFinite(len) || len <= 0) continue;
      if (buf.length < len) return;

      const bodyBuf = buf.slice(0, len);
      buf = buf.slice(len);

      if (!isJson) continue;

      const text = bodyBuf.toString("utf8").trim();
      try {
        const payload = JSON.parse(text);
        onJsonEvent(payload).catch((e) => console.error("Event fatal:", e.message));
      } catch {}
    } else {
      const nextIdx = buf.indexOf(bBuf);
      if (nextIdx === -1) return;

      const bodyBuf = buf.slice(0, nextIdx);
      buf = buf.slice(nextIdx);

      if (!isJson) continue;

      const text = bodyBuf.toString("utf8").trim();
      try {
        const payload = JSON.parse(text);
        onJsonEvent(payload).catch((e) => console.error("Event fatal:", e.message));
      } catch {}
    }
  }
}

// ---------- Stream ----------
function resolveCurlPath() {
  // prefer System32, fallback al PATH
  const p1 = "C:\\Windows\\System32\\curl.exe";
  if (fs.existsSync(p1)) return p1;
  return "curl.exe";
}

function startStream() {
  const url = `http://${HIK_IP}/ISAPI/Event/notification/alertStream`;

  console.log(" Escuchando:", url);
  console.log("   CONFIG_PATH =", CONFIG_PATH);
  console.log("   DEVICE_UUID =", DEVICE_UUID);
  console.log("   BRIDGE_ID =", BRIDGE_ID);
  console.log("   START_MODE =", START_MODE, "| cutoff =", new Date(startCutoffMs).toISOString());
  console.log("   Cola local =", QUEUE_DIR);

  streamConnected = false;

  buf = Buffer.alloc(0);
  boundary = null;
  printedBoundary = false;

  const CURL_PATH = resolveCurlPath();
  const args = [
    ...(CURL_VERBOSE ? ["-v"] : []),
    "-sS",
    "-N",
    "--digest",
    "-u",
    `${HIK_USER}:${HIK_PASS}`,
    url
  ];

  const p = spawn(CURL_PATH, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

  p.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    consume();
  });

  p.stderr.on("data", (chunk) => {
    const s = chunk.toString("utf8");
    if (CURL_VERBOSE) {
      if (s.trim()) process.stderr.write(s);
    } else {
      const t = s.trim();
      if (t && !t.startsWith("*")) console.error("curl:", t);
    }
  });

  p.on("close", (code) => {
    streamConnected = false;
    console.error("❌ Stream cerró. code =", code, "→ reconectando en", RECONNECT_MS, "ms...");
    setTimeout(startStream, RECONNECT_MS);
  });
}

// ---------- Main ----------
(async function main() {
  // Carga config desde ProgramData + aplica al ENV SIEMPRE
  await loadEnvFromConfig();

  // Ahora sí, levanta settings desde ENV
  refreshSettingsFromEnv();

  // Prepara dirs (en ProgramData, no en __dirname)
  await ensureDirs();

  // flush al iniciar
  await flushQueueOnce().catch(() => {});

  // flush periódico
  setInterval(() => {
    flushQueueOnce().catch(() => {});
  }, FLUSH_INTERVAL_MS).unref();

  // heartbeat periódico
  setInterval(() => {
    sendHeartbeat().catch(() => {});
  }, HEARTBEAT_MS).unref();

  // manda uno de inmediato al iniciar
  await sendHeartbeat().catch(() => {});

  startStream();
})().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
