"use strict";

const fs = require("fs");
const path = require("path");

const { envString, envInt, envBool, toInt, toBool, loadJsoncFile } = require("./env");
const { slug } = require("./util");

function resourceSelector(serverConfig) {
  if (serverConfig.pid) return `pid:${serverConfig.pid}`;
  if (serverConfig.processPort) return `port:${serverConfig.processPort}`;
  if (serverConfig.processName) return `name:${serverConfig.processName}`;
  return "none";
}

function normalizeServerConfig(item, index) {
  const id = slug(item.id || item.name || `server-${index + 1}`);
  const port = toInt(item.port, index === 1 ? 2000 : 25565);
  const pid = toInt(item.pid || item.processPid, 0) || null;
  const processPort = toInt(item.processPort, port) || null;
  const logPath = item.logPath ? String(item.logPath) : "";
  const worldPath = item.worldPath ? String(item.worldPath) : "";
  const rconHost = item.rconHost ? String(item.rconHost) : "";
  const rconPort = toInt(item.rconPort, 0) || null;
  const rconPassword = item.rconPassword ? String(item.rconPassword) : "";
  return {
    id,
    name: String(item.name || id),
    host: String(item.host || "127.0.0.1"),
    port,
    protocolVersion: toInt(item.protocolVersion, envInt("MC_PROTOCOL_VERSION", 767)),
    queryEnabled: toBool(item.queryEnabled, false),
    queryHost: String(item.queryHost || item.host || "127.0.0.1"),
    queryPort: toInt(item.queryPort, port),
    processName: item.processName ? String(item.processName) : "",
    pid,
    processPort,
    logBackfillEnabled: toBool(item.logBackfillEnabled, false),
    logPath,
    logBackfillMaxFiles: Math.max(1, toInt(item.logBackfillMaxFiles, envInt("LOG_BACKFILL_MAX_FILES", 80))),
    logBackfillMaxSessionHours: Math.max(1, toInt(item.logBackfillMaxSessionHours, envInt("LOG_BACKFILL_MAX_SESSION_HOURS", 24))),
    deathTrackingEnabled: toBool(item.deathTrackingEnabled, false),
    worldPath,
    rconEnabled: toBool(item.rconEnabled, Boolean(rconPort && rconPassword)),
    rconHost: rconHost || String(item.host || "127.0.0.1"),
    rconPort,
    rconPassword,
    resourceMode: pid ? "pid" : processPort ? "port" : item.processName ? "name" : "none"
  };
}

function parseServersFile(filePath) {
  let data;
  try {
    data = loadJsoncFile(filePath);
  } catch (error) {
    throw new Error(`Failed to parse ${filePath}: ${error.message}`);
  }
  const servers = Array.isArray(data)
    ? data
    : data && Array.isArray(data.servers)
      ? data.servers
      : null;
  if (!servers || servers.length === 0) {
    throw new Error(`${filePath} must contain a non-empty array (or {"servers": [...]}).`);
  }
  return servers.map((item, index) => normalizeServerConfig(item, index));
}

function resolveServersFile(rootDir) {
  const base = rootDir || process.cwd();
  const explicit = envString("SERVERS_FILE", "");
  if (explicit) {
    const full = path.resolve(base, explicit);
    if (!fs.existsSync(full)) {
      throw new Error(`SERVERS_FILE points to ${full} but the file does not exist.`);
    }
    return full;
  }
  for (const name of ["servers.jsonc", "servers.json"]) {
    const full = path.resolve(base, name);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function loadWebhookTargets(rootDir) {
  const base = rootDir || process.cwd();
  const explicit = envString("WEBHOOKS_FILE", "");
  if (explicit) {
    const full = path.resolve(base, explicit);
    if (!fs.existsSync(full)) {
      throw new Error(`WEBHOOKS_FILE points to ${full} but the file does not exist.`);
    }
    return parseWebhooksFile(full);
  }
  for (const name of ["webhooks.jsonc", "webhooks.json"]) {
    const full = path.resolve(base, name);
    if (fs.existsSync(full)) return parseWebhooksFile(full);
  }
  const raw = envString("WEBHOOKS", "");
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("WEBHOOKS must be a JSON array");
      return parsed;
    } catch (error) {
      throw new Error(`Invalid WEBHOOKS env: ${error.message}`);
    }
  }
  return [];
}

function parseWebhooksFile(filePath) {
  let data;
  try {
    data = loadJsoncFile(filePath);
  } catch (error) {
    throw new Error(`Failed to parse ${filePath}: ${error.message}`);
  }
  const list = Array.isArray(data) ? data : data && Array.isArray(data.targets) ? data.targets : null;
  if (!list) throw new Error(`${filePath} must be an array (or {"targets": [...]}).`);
  return list;
}

function loadServerConfigs(rootDir) {
  const fromFile = resolveServersFile(rootDir);
  if (fromFile) return parseServersFile(fromFile);

  const raw = envString("SERVERS", "");
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error("SERVERS must be a non-empty JSON array.");
      }
      return parsed.map((item, index) => normalizeServerConfig(item, index));
    } catch (error) {
      throw new Error(`Invalid SERVERS config: ${error.message}`);
    }
  }

  return [normalizeServerConfig({
    id: envString("MC_ID", "default"),
    name: envString("MC_NAME", "Minecraft Server"),
    host: envString("MC_HOST", "127.0.0.1"),
    port: envInt("MC_PORT", 25565),
    protocolVersion: envInt("MC_PROTOCOL_VERSION", 767),
    queryEnabled: envBool("MC_QUERY_ENABLED", false),
    queryHost: envString("MC_QUERY_HOST", envString("MC_HOST", "127.0.0.1")),
    queryPort: envInt("MC_QUERY_PORT", envInt("MC_PORT", 25565)),
    processName: envString("MC_PROCESS_NAME", ""),
    pid: envInt("MC_PROCESS_PID", 0) || null,
    processPort: envInt("MC_PROCESS_PORT", envInt("MC_PORT", 25565)),
    logBackfillEnabled: envBool("MC_LOG_BACKFILL_ENABLED", false),
    logPath: envString("MC_LOG_PATH", ""),
    logBackfillMaxFiles: envInt("MC_LOG_BACKFILL_MAX_FILES", envInt("LOG_BACKFILL_MAX_FILES", 80)),
    logBackfillMaxSessionHours: envInt("MC_LOG_BACKFILL_MAX_SESSION_HOURS", envInt("LOG_BACKFILL_MAX_SESSION_HOURS", 24)),
    deathTrackingEnabled: envBool("MC_DEATH_TRACKING_ENABLED", false),
    worldPath: envString("MC_WORLD_PATH", ""),
    rconEnabled: envBool("MC_RCON_ENABLED", false),
    rconHost: envString("MC_RCON_HOST", ""),
    rconPort: envInt("MC_RCON_PORT", 0),
    rconPassword: envString("MC_RCON_PASSWORD", "")
  }, 0)];
}

function publicServerConfig(serverConfig) {
  return {
    id: serverConfig.id,
    name: serverConfig.name,
    host: serverConfig.host,
    port: serverConfig.port,
    queryEnabled: serverConfig.queryEnabled,
    queryPort: serverConfig.queryPort,
    processName: serverConfig.processName || null,
    pid: serverConfig.pid,
    processPort: serverConfig.processPort,
    logBackfillEnabled: serverConfig.logBackfillEnabled,
    logPath: serverConfig.logPath || null,
    deathTrackingEnabled: Boolean(serverConfig.deathTrackingEnabled),
    worldPath: serverConfig.worldPath || null,
    rconEnabled: serverConfig.rconEnabled,
    resourceMode: serverConfig.resourceMode
  };
}

function loadAppConfig(rootDir) {
  return {
    appName: envString("APP_NAME", "Minecraft Server Monitor"),
    host: envString("HOST", "0.0.0.0"),
    port: envInt("PORT", envInt("HTTP_PORT", 3000)),
    mcProtocolVersion: envInt("MC_PROTOCOL_VERSION", 767),
    pingTimeoutMs: envInt("PING_TIMEOUT_MS", 3500),
    pollIntervalMs: Math.max(5000, envInt("POLL_INTERVAL_MS", 15000)),
    dataDir: path.resolve(rootDir, envString("DATA_DIR", "./data")),
    historyLimit: Math.max(24, envInt("HISTORY_LIMIT", 240)),
    logBackfillMaxFiles: Math.max(1, envInt("LOG_BACKFILL_MAX_FILES", 80)),
    logBackfillMaxSessionHours: Math.max(1, envInt("LOG_BACKFILL_MAX_SESSION_HOURS", 24)),
    authToken: envString("AUTH_TOKEN", ""),
    sseEnabled: envBool("SSE_ENABLED", true),
    staleSessionMultiplier: Math.max(2, envInt("STALE_SESSION_POLL_MULTIPLIER", 4)),
    rconTimeoutMs: envInt("RCON_TIMEOUT_MS", 3000),
    alertTpsThreshold: Math.max(0.1, envInt("ALERT_TPS_THRESHOLD", 10)),
    alertTpsDurationMs: Math.max(30_000, envInt("ALERT_TPS_DURATION_MS", 5 * 60 * 1000)),
    worldSizeIntervalMs: Math.max(60_000, envInt("WORLD_SIZE_INTERVAL_MS", 60 * 60 * 1000)),
    worldSizeHistoryLimit: Math.max(24, envInt("WORLD_SIZE_HISTORY_LIMIT", 720)),
    webhookTimeoutMs: envInt("WEBHOOK_TIMEOUT_MS", 5000),
    webhooks: loadWebhookTargets(rootDir),
    serversSource: resolveServersFile(rootDir) || (envString("SERVERS", "") ? "SERVERS env" : "single-server env"),
    servers: loadServerConfigs(rootDir)
  };
}

module.exports = {
  loadAppConfig,
  loadServerConfigs,
  resolveServersFile,
  parseServersFile,
  normalizeServerConfig,
  publicServerConfig,
  resourceSelector
};
