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
//   SUPABASE_ANON_KEY
//   DEVICE_UUID   (uuid de access_devices.id)
//   DEVICE_KEY
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function getBridgeTzOffsetMinutes() {
  return -new Date().getTimezoneOffset();
}

async function edgePost(fn, payload) {
  const url = `${SUPABASE_URL}/functions/v1/${fn}`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY || "",
      Authorization: `Bearer ${SUPABASE_ANON_KEY || ""}`,
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
    return { ok: false, error: data?.error || `http_${r.status}`, data };
  }
  return { ok: true, data };
}

async function curlRequest({ method = "GET", url, headers = [], body = null }) {
  const CURL_PATH = resolveCurlPath();
  const args = [
    "-sS",
    "--digest",
    "-u",
    `${HIK_USER}:${HIK_PASS}`,
  ];

  if (method && method !== "GET") {
    args.push("-X", method);
  }

  for (const h of headers) {
    args.push("-H", h);
  }

  if (body != null) {
    args.push("-H", "Expect:");
    args.push("--data-binary", "@-");
  }

  args.push(url);

  return await new Promise((resolve) => {
    const p = spawn(CURL_PATH, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString("utf8")));
    p.stderr.on("data", (d) => (err += d.toString("utf8")));
    p.on("close", (code) => resolve({ code, out, err }));
    if (body != null) {
      p.stdin.write(body);
      p.stdin.end();
    } else {
      p.stdin.end();
    }
  });
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

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------- Runtime state ----------
let streamConnected = false;
let lastEventIso = null;


// Valores (se cargan desde ENV después de aplicar config)
let HIK_IP = null;
let HIK_USER = null;
let HIK_PASS = null;

let SUPABASE_URL = null;
let SUPABASE_ANON_KEY = null;

let TABLE = null;
let DEVICE_UUID = null;
let DEVICE_KEY = null;

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

// Jobs
let JOB_POLL_MS = 4000;
let JOB_LIMIT = 5;

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
  SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

  TABLE = process.env.SUPABASE_TABLE || "access_events";
  DEVICE_UUID = process.env.DEVICE_UUID || null;
  DEVICE_KEY = process.env.DEVICE_KEY || null;

  START_MODE = (process.env.START_MODE || "now").toLowerCase() === "all" ? "all" : "now";
  RECONNECT_MS = Number(process.env.RECONNECT_MS || 1500);
  CURL_VERBOSE = String(process.env.CURL_VERBOSE ?? "0") === "1";

  FLUSH_INTERVAL_MS = Number(process.env.FLUSH_INTERVAL_MS || 5000);
  INSERT_CONCURRENCY = Math.max(1, Number(process.env.INSERT_CONCURRENCY || 3));

  BRIDGE_ID = process.env.BRIDGE_ID || os.hostname() || "bridge-1";
  HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 15000);
  HB_TABLE = process.env.HEARTBEAT_TABLE || "access_device_heartbeats";
  VERSION = process.env.BRIDGE_VERSION || "zenter-bridge@1.0.0";

  JOB_POLL_MS = Math.max(1500, Number(process.env.JOB_POLL_MS || 4000));
  JOB_LIMIT = Math.max(1, Number(process.env.JOB_LIMIT || 5));

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error("ERR Faltan SUPABASE_URL o SUPABASE_ANON_KEY.");
    console.error("   Config path:", CONFIG_PATH);
    process.exit(1);
  }
  if (!DEVICE_UUID || !DEVICE_KEY) {
    console.error("ERR Falta DEVICE_UUID o DEVICE_KEY.");
    console.error("   Config path:", CONFIG_PATH);
    process.exit(1);
  }

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
async function writeQueueFile(eventObj, savedAt, bridgeTzOffsetMinutes) {
  const serial = eventObj?.AccessControllerEvent?.serialNo ?? null;
  const dt = eventObj?.dateTime ? Date.parse(eventObj.dateTime) : Date.now();
  const ts = new Date(Number.isFinite(dt) ? dt : Date.now()).toISOString().replace(/[:.]/g, "-");
  const base = serial != null ? `serial_${serial}` : `time_${ts}_${Math.random().toString(16).slice(2)}`;

  const file = `${safeName(base)}.json`;
  const finalPath = path.join(QUEUE_DIR, file);
  const tmpPath = finalPath + ".tmp";

  const tz = Number.isFinite(bridgeTzOffsetMinutes)
    ? bridgeTzOffsetMinutes
    : getBridgeTzOffsetMinutes();
  const payload = {
    saved_at: savedAt || nowIso(),
    device_id: DEVICE_UUID,
    bridge_tz_offset_minutes: tz,
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
async function insertToSupabaseFromRaw(rawPayload, receivedAtIso, bridgeTzOffsetMinutes) {
  if (!rawPayload || rawPayload.eventType !== "AccessControllerEvent") return { ok: true, skipped: true };

  const t = receivedAtIso
    ? Date.parse(receivedAtIso)
    : rawPayload.dateTime
    ? Date.parse(rawPayload.dateTime)
    : NaN;
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

  const tz = Number.isFinite(bridgeTzOffsetMinutes)
    ? bridgeTzOffsetMinutes
    : getBridgeTzOffsetMinutes();
  const res = await edgePost("bridgeIngestEvents", {
    device_id: DEVICE_UUID,
    device_key: DEVICE_KEY,
    event: rawPayload,
    received_at: receivedAtIso || null,
    bridge_tz_offset_minutes: tz
  });

  if (!res.ok) return { ok: false, error: res.error || "insert_failed" };

  const inserted = Number(res.data?.inserted || 0);
  const duplicates = Number(res.data?.duplicates || 0);
  if (inserted === 0 && duplicates > 0) return { ok: true, duplicate: true };

  if (inserted > 0) {
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
  }
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
        const res = await insertToSupabaseFromRaw(
          raw,
          obj?.saved_at || null,
          obj?.bridge_tz_offset_minutes
        );

        if (res.ok) {
          await removeOrArchive(file);
          sent += 1;
        } else {
          console.error("ERR Ingest error (cola):", res.error, "-> se queda en cola:", path.basename(file));
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

    const res = await edgePost("bridgeHeartbeat", {
      device_id: DEVICE_UUID,
      device_key: DEVICE_KEY,
      bridge_id: BRIDGE_ID,
      last_seen: row.last_seen,
      stream_connected: row.stream_connected,
      last_event_time: row.last_event_time,
      queue_depth: row.queue_depth,
      ip: row.ip,
      host: row.host,
      version: row.version
    });
    if (!res.ok) console.error("heartbeat error:", res.error || "unknown_error");
  } catch (e) {
    console.error("heartbeat fatal:", e.message);
  }
}

// ---------- Jobs (pull + execute) ----------
let jobPolling = false;

function trimErr(s, max = 500) {
  const t = String(s || "").trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + "...";
}

function isOkResponse(out) {
  const j = parseJsonSafe(out);
  if (j) {
    if (Number(j.statusCode) === 1) return true;
    if (String(j.statusString || "").toLowerCase() === "ok") return true;
    const list = j?.FingerPrintStatus?.StatusList;
    if (Array.isArray(list)) {
      if (list.some((x) => Number(x?.cardReaderRecvStatus) === 1)) return true;
    }
  }
  const sc = xmlTag(out, "statusCode");
  if (sc && Number(sc) === 1) return true;
  const ss = xmlTag(out, "statusString");
  if (ss && String(ss).toLowerCase() === "ok") return true;
  return false;
}

async function ensureUser(job) {
  const employeeNo = String(job?.employee_no || "").trim();
  if (!employeeNo) return { ok: false, error: "missing_employee_no" };

  const fullName = String(job?.full_name || "Empleado").trim();
  const payload = {
    UserInfo: {
      employeeNo,
      name: fullName,
      userType: "normal",
      Valid: {
        enable: true,
        beginTime: "2024-01-01T00:00:00",
        endTime: "2036-12-31T23:59:59"
      }
    }
  };

  const url = `http://${HIK_IP}/ISAPI/AccessControl/UserInfo/Record?format=json`;
  const res = await curlRequest({
    method: "POST",
    url,
    headers: ["Content-Type: application/json", "Accept: application/json"],
    body: JSON.stringify(payload),
  });

  if (res.code !== 0 && !res.out) {
    return { ok: false, error: "user_upsert_failed", detail: trimErr(res.err) };
  }

  if (!isOkResponse(res.out)) {
    const outLower = String(res.out || "").toLowerCase();
    if (outLower.includes("deviceuseralreadyexist") || outLower.includes("useralreadyexist") || outLower.includes("empnoalreadyexist")) {
      return { ok: true, exists: true };
    }
    return { ok: false, error: "user_upsert_failed", detail: trimErr(res.out || res.err) };
  }

  return { ok: true };
}

async function ensureCard(job) {
  const cardNo = String(job?.card_no || "").trim();
  if (!cardNo) return { ok: true };

  const employeeNo = String(job?.employee_no || "").trim();
  if (!employeeNo) return { ok: false, error: "missing_employee_no" };

  const payload = {
    CardInfo: {
      employeeNo,
      cardNo,
      cardType: "normalCard"
    }
  };

  const url = `http://${HIK_IP}/ISAPI/AccessControl/CardInfo/Record?format=json`;
  const res = await curlRequest({
    method: "POST",
    url,
    headers: ["Content-Type: application/json", "Accept: application/json"],
    body: JSON.stringify(payload),
  });

  if (res.code !== 0 && !res.out) {
    return { ok: false, error: "card_upsert_failed", detail: trimErr(res.err) };
  }

  if (!isOkResponse(res.out)) {
    const outLower = String(res.out || "").toLowerCase();
    if (outLower.includes("cardnoalreadyexist") || outLower.includes("cardalreadyexist")) {
      return { ok: true, exists: true };
    }
    return { ok: false, error: "card_upsert_failed", detail: trimErr(res.out || res.err) };
  }

  return { ok: true };
}

async function deleteCard(job) {
  const employeeNo = String(job?.employee_no || "").trim();
  const cardNo = String(job?.card_no || "").trim();
  if (!employeeNo && !cardNo) return { ok: true };

  const delCond = { CardInfoDelCond: {} };
  if (employeeNo) {
    delCond.CardInfoDelCond.EmployeeNoList = [{ employeeNo }];
  }
  if (cardNo) {
    delCond.CardInfoDelCond.CardNoList = [{ cardNo }];
  }

  const url = `http://${HIK_IP}/ISAPI/AccessControl/CardInfo/Delete?format=json`;
  let res = await curlRequest({
    method: "PUT",
    url,
    headers: ["Content-Type: application/json", "Accept: application/json"],
    body: JSON.stringify(delCond),
  });

  if (!isOkResponse(res.out)) {
    // fallback: CardInfo/SetUp with deleteCard=true (según guía ISAPI)
    const payload = {
      CardInfo: {
        employeeNo: employeeNo || undefined,
        cardNo: cardNo || undefined,
        deleteCard: true,
        cardType: "normalCard",
      },
    };
    const url2 = `http://${HIK_IP}/ISAPI/AccessControl/CardInfo/SetUp?format=json`;
    res = await curlRequest({
      method: "PUT",
      url: url2,
      headers: ["Content-Type: application/json", "Accept: application/json"],
      body: JSON.stringify(payload),
    });
  }

  if (res.code !== 0 && !res.out) {
    return { ok: false, error: "card_delete_failed", detail: trimErr(res.err) };
  }
  if (!isOkResponse(res.out)) {
    const outLower = String(res.out || "").toLowerCase();
    if (outLower.includes("notexist") || outLower.includes("not exist")) {
      return { ok: true, missing: true };
    }
    return { ok: false, error: "card_delete_failed", detail: trimErr(res.out || res.err) };
  }
  return { ok: true };
}

async function deleteUser(job) {
  const employeeNo = String(job?.employee_no || "").trim();
  if (!employeeNo) return { ok: false, error: "missing_employee_no" };

  const payload = {
    UserInfoDelCond: {
      EmployeeNoList: [{ employeeNo }],
    },
  };

  const urls = [
    `http://${HIK_IP}/ISAPI/AccessControl/UserInfo/Delete?format=json`,
    `http://${HIK_IP}/ISAPI/AccessControl/UserInfoDetail/Delete?format=json`,
  ];

  let res = null;
  for (const url of urls) {
    res = await curlRequest({
      method: "PUT",
      url,
      headers: ["Content-Type: application/json", "Accept: application/json"],
      body: JSON.stringify(payload),
    });
    if (isOkResponse(res.out)) break;
  }

  if (!res || (res.code !== 0 && !res.out)) {
    return { ok: false, error: "user_delete_failed", detail: trimErr(res?.err) };
  }
  if (!isOkResponse(res.out)) {
    const outLower = String(res.out || "").toLowerCase();
    if (outLower.includes("notexist") || outLower.includes("not exist")) {
      return { ok: true, missing: true };
    }
    return { ok: false, error: "user_delete_failed", detail: trimErr(res.out || res.err) };
  }
  return { ok: true };
}

async function deleteFingerprint(job, fingerNo) {
  const employeeNo = String(job?.employee_no || "").trim();
  if (!employeeNo) return { ok: false, error: "missing_employee_no" };
  const fn = Number(fingerNo || 0);
  if (!Number.isFinite(fn) || fn < 1 || fn > 10) {
    return { ok: false, error: "invalid_finger_no" };
  }

  const urls = [
    `http://${HIK_IP}/ISAPI/AccessControl/FingerPrint/Delete?format=json`,
    `http://${HIK_IP}/ISAPI/AccessControl/FingerPrint/Delete`,
  ];

  const payloads = [
    // employeeNo as object list + finger list (numbers)
    {
      FingerPrintDeleteCond: {
        EmployeeNoList: [{ employeeNo }],
        fingerPrintIDList: [fn],
      },
    },
    // employeeNo as object list + finger list (objects)
    {
      FingerPrintDeleteCond: {
        EmployeeNoList: [{ employeeNo }],
        fingerPrintIDList: [{ fingerPrintID: fn }],
      },
    },
    // employeeNo as object list + finger list (objects, alternate key)
    {
      FingerPrintDeleteCond: {
        EmployeeNoList: [{ employeeNo }],
        FingerPrintIDList: [{ fingerPrintID: fn }],
      },
    },
    // employeeNo as array of strings + finger list
    {
      FingerPrintDeleteCond: {
        EmployeeNoList: [employeeNo],
        fingerPrintIDList: [fn],
      },
    },
    // lowercase employeeNoList variants
    {
      FingerPrintDeleteCond: {
        employeeNoList: [{ employeeNo }],
        fingerPrintIDList: [fn],
      },
    },
    {
      FingerPrintDeleteCond: {
        employeeNoList: [{ employeeNo }],
        fingerPrintIDList: [{ fingerPrintID: fn }],
      },
    },
    {
      FingerPrintDeleteCond: {
        employeeNoList: [employeeNo],
        fingerPrintIDList: [fn],
      },
    },
    // single fingerPrintID (no list)
    {
      FingerPrintDeleteCond: {
        EmployeeNoList: [{ employeeNo }],
        fingerPrintID: fn,
      },
    },
    {
      FingerPrintDeleteCond: {
        employeeNoList: [{ employeeNo }],
        fingerPrintID: fn,
      },
    },
    // optional reader hint (some firmwares expect this)
    {
      FingerPrintDeleteCond: {
        EmployeeNoList: [{ employeeNo }],
        fingerPrintIDList: [{ fingerPrintID: fn, enableCardReader: [1] }],
      },
    },
  ];

  const methods = ["PUT", "POST", "DELETE"];
  let res = null;
  for (const url of urls) {
    for (const method of methods) {
      for (const payload of payloads) {
        res = await curlRequest({
          method,
          url,
          headers: ["Content-Type: application/json", "Accept: application/json"],
          body: JSON.stringify(payload),
        });
        if (isOkResponse(res.out)) break;
      }
      if (res && isOkResponse(res.out)) break;
    }
    if (res && isOkResponse(res.out)) break;
  }

  if (res && !isOkResponse(res.out)) {
    const xmlPayloads = [
      `<FingerPrintDeleteCond version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><EmployeeNoList><employeeNo>${employeeNo}</employeeNo></EmployeeNoList><fingerPrintIDList><fingerPrintID>${fn}</fingerPrintID></fingerPrintIDList></FingerPrintDeleteCond>`,
      `<FingerPrintDeleteCond version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><employeeNo>${employeeNo}</employeeNo><fingerPrintID>${fn}</fingerPrintID></FingerPrintDeleteCond>`,
      `<FingerPrintDeleteCond><EmployeeNoList><employeeNo>${employeeNo}</employeeNo></EmployeeNoList><fingerPrintIDList><fingerPrintID>${fn}</fingerPrintID></fingerPrintIDList></FingerPrintDeleteCond>`,
    ];
    for (const url of urls) {
      for (const xml of xmlPayloads) {
        res = await curlRequest({
          method: "POST",
          url,
          headers: ["Content-Type: application/xml", "Accept: application/xml"],
          body: xml,
        });
        if (isOkResponse(res.out)) break;
      }
      if (res && isOkResponse(res.out)) break;
    }
  }

  if (!res || (res.code !== 0 && !res.out)) {
    return { ok: false, error: "finger_delete_failed", detail: trimErr(res?.err) };
  }
  if (!isOkResponse(res.out)) {
    const outLower = String(res.out || "").toLowerCase();
    if (
      outLower.includes("notexist") ||
      outLower.includes("not exist") ||
      outLower.includes("notfound") ||
      outLower.includes("not found") ||
      outLower.includes("no record") ||
      outLower.includes("no data")
    ) {
      return { ok: true, missing: true };
    }
    return { ok: false, error: "finger_delete_failed", detail: trimErr(res.out || res.err) };
  }
  return { ok: true };
}

async function captureFinger(fingerNo) {
  const xml = `<CaptureFingerPrintCond version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><fingerNo>${fingerNo}</fingerNo></CaptureFingerPrintCond>`;
  const url = `http://${HIK_IP}/ISAPI/AccessControl/CaptureFingerPrint`;
  const res = await curlRequest({
    method: "POST",
    url,
    headers: ["Content-Type: application/xml", "Accept: application/xml"],
    body: xml,
  });

  const fingerData = xmlTag(res.out, "fingerData");
  const qualityStr = xmlTag(res.out, "fingerPrintQuality");
  const quality = qualityStr ? Number(qualityStr) : null;

  if (!fingerData) {
    return { ok: false, error: "finger_capture_failed", detail: trimErr(res.out || res.err) };
  }

  return { ok: true, fingerData, quality };
}

async function applyFinger(job, fingerNo, fingerData) {
  const employeeNo = String(job?.employee_no || "").trim();
  if (!employeeNo) return { ok: false, error: "missing_employee_no" };

  const payload = {
    FingerPrintCfg: {
      employeeNo,
      enableCardReader: [1],
      fingerPrintID: fingerNo,
      fingerType: "normalFP",
      fingerData
    }
  };

  const url = `http://${HIK_IP}/ISAPI/AccessControl/FingerPrint/SetUp?format=json`;
  const res = await curlRequest({
    method: "POST",
    url,
    headers: ["Content-Type: application/json", "Accept: application/json"],
    body: JSON.stringify(payload),
  });

  if (!isOkResponse(res.out)) {
    return { ok: false, error: "finger_apply_failed", detail: trimErr(res.out || res.err) };
  }

  return { ok: true };
}

async function storeFingerprintTemplate(job, fingerNo, fingerData) {
  const employeeNo = String(job?.employee_no || "").trim();
  if (!employeeNo) return { ok: false, error: "missing_employee_no" };
  const res = await edgePost("bridgeStoreFingerprintTemplate", {
    device_id: DEVICE_UUID,
    device_key: DEVICE_KEY,
    employee_no: employeeNo,
    finger_no: fingerNo,
    finger_data: fingerData,
  });
  if (!res.ok) {
    return { ok: false, error: res.error, detail: res.data };
  }
  return { ok: true };
}

async function getFingerprintTemplate(job, fingerNo) {
  const employeeNo = String(job?.employee_no || "").trim();
  if (!employeeNo) return { ok: false, error: "missing_employee_no" };
  const res = await edgePost("bridgeGetFingerprintTemplate", {
    device_id: DEVICE_UUID,
    device_key: DEVICE_KEY,
    employee_no: employeeNo,
    finger_no: fingerNo,
  });
  if (!res.ok) {
    return { ok: false, error: res.error || "template_fetch_failed", detail: res.data };
  }
  const fingerData = res.data?.finger_data;
  if (!fingerData) return { ok: false, error: "template_missing" };
  return { ok: true, fingerData };
}

async function completeJob(job, status, error, result, retryInSec) {
  await edgePost("bridgeCompleteEmployeeJob", {
    device_id: DEVICE_UUID,
    device_key: DEVICE_KEY,
    job_id: job.id,
    status,
    error,
    result,
    retry_in_sec: retryInSec || 0
  });
}

async function handleJob(job) {
  const action = String(job?.action || "");

  if (action === "upsert") {
    console.log("[JOB] upsert ->", job?.employee_no || job?.employee_id || "");
    const userRes = await ensureUser(job);
    if (!userRes.ok) {
      await completeJob(job, "error", userRes.error, { detail: userRes.detail }, 5);
      console.error("[JOB] upsert error:", userRes.error);
      return;
    }
    const cardRes = await ensureCard(job);
    if (!cardRes.ok) {
      await completeJob(job, "error", cardRes.error, { detail: cardRes.detail }, 5);
      console.error("[JOB] card error:", cardRes.error);
      return;
    }
    await completeJob(job, "success", null, { ok: true });
    console.log("[JOB] upsert OK");
    return;
  }

  if (action === "fingerprint_capture") {
    console.log("[JOB] fingerprint_capture ->", job?.employee_no || job?.employee_id || "");
    const fingerNo = Number(job?.payload?.finger_no || 1);
    // Asegura que el usuario exista antes de aplicar huella
    const userRes = await ensureUser(job);
    if (!userRes.ok) {
      await completeJob(job, "error", userRes.error, { detail: userRes.detail }, 5);
      console.error("[JOB] upsert error:", userRes.error);
      return;
    }
    const cardRes = await ensureCard(job);
    if (!cardRes.ok) {
      await completeJob(job, "error", cardRes.error, { detail: cardRes.detail }, 5);
      console.error("[JOB] card error:", cardRes.error);
      return;
    }
    const cap = await captureFinger(fingerNo);
    if (!cap.ok) {
      await completeJob(job, "error", cap.error, { detail: cap.detail }, 5);
      console.error("[JOB] capture error:", cap.error, cap.detail || "");
      return;
    }
    const app = await applyFinger(job, fingerNo, cap.fingerData);
    if (!app.ok) {
      await completeJob(job, "error", app.error, { detail: app.detail }, 5);
      console.error("[JOB] apply error:", app.error, app.detail || "");
      return;
    }
    const store = await storeFingerprintTemplate(job, fingerNo, cap.fingerData);
    if (!store.ok) {
      console.error("[JOB] template store failed:", store.error, store.detail || "");
    }
    await completeJob(job, "success", null, { quality: cap.quality ?? null });
    console.log("[JOB] fingerprint OK | quality:", cap.quality ?? "n/a");
    return;
  }

  if (action === "fingerprint_apply") {
    console.log("[JOB] fingerprint_apply ->", job?.employee_no || job?.employee_id || "");
    const fingerNo = Number(job?.payload?.finger_no || 1);
    const userRes = await ensureUser(job);
    if (!userRes.ok) {
      await completeJob(job, "error", userRes.error, { detail: userRes.detail }, 5);
      console.error("[JOB] upsert error:", userRes.error);
      return;
    }
    const cardRes = await ensureCard(job);
    if (!cardRes.ok) {
      await completeJob(job, "error", cardRes.error, { detail: cardRes.detail }, 5);
      console.error("[JOB] card error:", cardRes.error);
      return;
    }
    const tpl = await getFingerprintTemplate(job, fingerNo);
    if (!tpl.ok) {
      await completeJob(job, "error", tpl.error || "finger_template_missing", { detail: tpl.detail }, 5);
      console.error("[JOB] template error:", tpl.error, tpl.detail || "");
      return;
    }
    const app = await applyFinger(job, fingerNo, tpl.fingerData);
    if (!app.ok) {
      await completeJob(job, "error", app.error, { detail: app.detail }, 5);
      console.error("[JOB] apply error:", app.error, app.detail || "");
      return;
    }
    await completeJob(job, "success", null, { ok: true });
    console.log("[JOB] fingerprint_apply OK");
    return;
  }

  if (action === "delete_fingerprint") {
    const fingerNo = Number(job?.payload?.finger_no || 1);
    console.log("[JOB] delete_fingerprint ->", job?.employee_no || job?.employee_id || "", "finger", fingerNo);
    const del = await deleteFingerprint(job, fingerNo);
    if (!del.ok) {
      await completeJob(job, "error", del.error, { detail: del.detail }, 5);
      console.error("[JOB] delete_fingerprint error:", del.error, del.detail || "");
      return;
    }
    await completeJob(job, "success", null, { ok: true });
    console.log("[JOB] delete_fingerprint OK");
    return;
  }

  if (action === "clear_card") {
    console.log("[JOB] clear_card ->", job?.employee_no || job?.employee_id || "");
    const del = await deleteCard(job);
    if (!del.ok) {
      await completeJob(job, "error", del.error, { detail: del.detail }, 5);
      console.error("[JOB] clear_card error:", del.error, del.detail || "");
      return;
    }
    await completeJob(job, "success", null, { ok: true });
    console.log("[JOB] clear_card OK");
    return;
  }

  if (action === "delete_user") {
    console.log("[JOB] delete_user ->", job?.employee_no || job?.employee_id || "");
    const del = await deleteUser(job);
    if (!del.ok) {
      await completeJob(job, "error", del.error, { detail: del.detail }, 5);
      console.error("[JOB] delete_user error:", del.error, del.detail || "");
      return;
    }
    await completeJob(job, "success", null, { ok: true });
    console.log("[JOB] delete_user OK");
    return;
  }

  await completeJob(job, "error", "unknown_action", { action });
}

async function pollJobsOnce() {
  if (jobPolling) return;
  jobPolling = true;
  try {
    const res = await edgePost("bridgePullEmployeeJobs", {
      device_id: DEVICE_UUID,
      device_key: DEVICE_KEY,
      bridge_id: BRIDGE_ID,
      limit: JOB_LIMIT
    });
    if (!res.ok) return;
    const jobs = Array.isArray(res.data?.jobs) ? res.data.jobs : [];
    if (jobs.length) console.log(`[JOBS] recibidos ${jobs.length}`);
    for (const j of jobs) {
      await handleJob(j);
    }
  } finally {
    jobPolling = false;
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
  const receivedAt = nowIso();
  const tz = getBridgeTzOffsetMinutes();
  const filePath = await writeQueueFile(payload, receivedAt, tz);

  // 2) intentar subir
  const res = await insertToSupabaseFromRaw(payload, receivedAt, tz);

  if (res.ok) {
    await removeOrArchive(filePath);
  } else {
    console.error(
      "ERR Ingest error (live):",
      res.error,
      "-> quedo en cola:",
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
    console.error("ERR Stream cerro. code =", code, "-> reconectando en", RECONNECT_MS, "ms...");
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

  // jobs pull periódico
  setInterval(() => {
    pollJobsOnce().catch(() => {});
  }, JOB_POLL_MS).unref();

  // uno inmediato
  await pollJobsOnce().catch(() => {});

  startStream();
})().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});

