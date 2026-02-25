// bridge/config.js (CommonJS)
// ✅ Lee/escribe config en C:\ProgramData\ZenterBridge\config.json
// ✅ Aplica config al env (SIEMPRE) para que cambios del usuario surtan efecto
// ✅ Soporta JSONC/trailing commas (sin romper http://)
// ✅ Mantiene defaults + merge sin borrar settings del usuario
// ✅ IMPORTANTE: NO PEGAR KEYS NI "set ..." AQUI. TODO ESO VA EN config.json

const path = require("path");
const os = require("os");
const fs = require("fs");
const fsp = require("fs/promises");

let ROOT_DIR = path.join(process.env.ProgramData || "C:\\ProgramData", "ZenterBridge");
let CONFIG_PATH = path.join(ROOT_DIR, "config.json");
const ENV_CONFIG_PATH = process.env.ZENTER_CONFIG || process.env.ZB_CONFIG_PATH || "";
if (ENV_CONFIG_PATH) {
  CONFIG_PATH = ENV_CONFIG_PATH;
  ROOT_DIR = path.dirname(CONFIG_PATH);
}

const DEFAULT_CONFIG = {
  // Supabase
  SUPABASE_URL: "https://zeucdfkwrdrskmypqpwt.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpldWNkZmt3cmRyc2tteXBxcHd0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjUyMDg4OTMsImV4cCI6MjA4MDc4NDg5M30.1Y2lfH34eO_peuvbYjJAgezkWDKDDOwayzr9QTk3aVI",
  DEVICE_UUID: "",
  DEVICE_KEY: "",
  ENROLL_TOKEN: "",

  // Hikvision
  HIK_IP: "192.168.20.170",
  HIK_USER: "admin",
  HIK_PASS: "",

  // Bridge behavior
  SUPABASE_TABLE: "access_events",
  START_MODE: "now", // now|all

  RECONNECT_MS: 1500,
  CURL_VERBOSE: 0,

  FLUSH_INTERVAL_MS: 5000,
  INSERT_CONCURRENCY: 3,

  // Heartbeat
  BRIDGE_ID: os.hostname(),
  HEARTBEAT_MS: 15000,
  HEARTBEAT_TABLE: "access_device_heartbeats",
  BRIDGE_VERSION: "zenter-bridge@1.0.0"
};

function getConfigPath() {
  return CONFIG_PATH;
}

/**
 * Quita comentarios tipo // y /* ... *\/ sin romper strings (ej: http://...)
 * + quita trailing commas.
 */
function stripJsonc(input) {
  let s = String(input ?? "");

  // BOM
  s = s.replace(/^\uFEFF/, "");

  let out = "";
  let i = 0;

  let inStr = false;
  let strQuote = null;
  let escape = false;

  let inLineComment = false;
  let inBlockComment = false;

  while (i < s.length) {
    const ch = s[i];
    const next = i + 1 < s.length ? s[i + 1] : "";

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out += ch;
      }
      i++;
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (inStr) {
      out += ch;
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === strQuote) {
        inStr = false;
        strQuote = null;
      }
      i++;
      continue;
    }

    if (ch === `"` || ch === `'`) {
      inStr = true;
      strQuote = ch;
      out += ch;
      i++;
      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 2;
      continue;
    }

    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }

    out += ch;
    i++;
  }

  // trailing commas: , }  o , ]
  out = out.replace(/,\s*([}\]])/g, "$1");

  return out;
}

function parseJsonLenient(text) {
  const cleaned = stripJsonc(text);
  return JSON.parse(cleaned);
}

function normalizeConfig(cfg) {
  const merged = { ...DEFAULT_CONFIG, ...(cfg || {}) };

  if (!merged.BRIDGE_ID || String(merged.BRIDGE_ID).trim() === "") {
    merged.BRIDGE_ID = os.hostname();
  }

  const toNum = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  merged.RECONNECT_MS = toNum(merged.RECONNECT_MS, DEFAULT_CONFIG.RECONNECT_MS);
  merged.CURL_VERBOSE = toNum(merged.CURL_VERBOSE, DEFAULT_CONFIG.CURL_VERBOSE);
  merged.FLUSH_INTERVAL_MS = toNum(merged.FLUSH_INTERVAL_MS, DEFAULT_CONFIG.FLUSH_INTERVAL_MS);
  merged.INSERT_CONCURRENCY = Math.max(
    1,
    toNum(merged.INSERT_CONCURRENCY, DEFAULT_CONFIG.INSERT_CONCURRENCY)
  );
  merged.HEARTBEAT_MS = toNum(merged.HEARTBEAT_MS, DEFAULT_CONFIG.HEARTBEAT_MS);

  const sm = String(merged.START_MODE || "now").toLowerCase();
  merged.START_MODE = sm === "all" ? "all" : "now";

  [
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "DEVICE_UUID",
    "DEVICE_KEY",
    "ENROLL_TOKEN",
    "HIK_IP",
    "HIK_USER",
    "HIK_PASS",
    "SUPABASE_TABLE",
    "HEARTBEAT_TABLE",
    "BRIDGE_VERSION",
    "BRIDGE_ID"
  ].forEach((k) => {
    if (merged[k] == null) merged[k] = "";
    merged[k] = String(merged[k]);
  });

  return merged;
}

async function ensureConfig() {
  await fsp.mkdir(ROOT_DIR, { recursive: true });

  if (!fs.existsSync(CONFIG_PATH)) {
    const normalized = normalizeConfig(DEFAULT_CONFIG);
    await writeConfig(normalized);
    return CONFIG_PATH;
  }

  const current = await readConfig();
  const merged = normalizeConfig(current);

  const curStr = JSON.stringify(normalizeConfig(current));
  const merStr = JSON.stringify(merged);

  if (curStr !== merStr) {
    await writeConfig(merged);
  }

  return CONFIG_PATH;
}

async function readConfig() {
  try {
    const s = await fsp.readFile(CONFIG_PATH, "utf8");
    const obj = parseJsonLenient(s);
    return normalizeConfig(obj);
  } catch (e) {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const bak = path.join(
          ROOT_DIR,
          `config.broken.${new Date().toISOString().replace(/[:.]/g, "-")}.json`
        );
        await fsp.copyFile(CONFIG_PATH, bak).catch(() => {});
      }
    } catch {}

    return normalizeConfig(DEFAULT_CONFIG);
  }
}

async function writeConfig(cfg) {
  await fsp.mkdir(ROOT_DIR, { recursive: true });

  const merged = normalizeConfig(cfg);

  const tmp = CONFIG_PATH + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(merged, null, 2), "utf8");
  await fsp.rename(tmp, CONFIG_PATH);

  return merged;
}

function applyConfigToEnv(cfg) {
  const c = normalizeConfig(cfg);

  const set = (k, v) => {
    if (v === undefined || v === null) {
      delete process.env[k];
      return;
    }
    process.env[k] = String(v);
  };

  set("SUPABASE_URL", c.SUPABASE_URL);
  set("SUPABASE_ANON_KEY", c.SUPABASE_ANON_KEY);
  set("DEVICE_UUID", c.DEVICE_UUID);
  set("DEVICE_KEY", c.DEVICE_KEY);
  set("ENROLL_TOKEN", c.ENROLL_TOKEN);

  set("HIK_IP", c.HIK_IP);
  set("HIK_USER", c.HIK_USER);
  set("HIK_PASS", c.HIK_PASS);

  set("SUPABASE_TABLE", c.SUPABASE_TABLE);
  set("START_MODE", c.START_MODE);
  set("RECONNECT_MS", c.RECONNECT_MS);
  set("CURL_VERBOSE", c.CURL_VERBOSE);
  set("FLUSH_INTERVAL_MS", c.FLUSH_INTERVAL_MS);
  set("INSERT_CONCURRENCY", c.INSERT_CONCURRENCY);

  set("BRIDGE_ID", c.BRIDGE_ID || os.hostname());
  set("HEARTBEAT_MS", c.HEARTBEAT_MS);
  set("HEARTBEAT_TABLE", c.HEARTBEAT_TABLE);
  set("BRIDGE_VERSION", c.BRIDGE_VERSION);

  return c;
}

module.exports = {
  ROOT_DIR,
  CONFIG_PATH,
  DEFAULT_CONFIG,
  getConfigPath,
  ensureConfig,
  readConfig,
  writeConfig,
  applyConfigToEnv
};
