"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");

const { loadEnvFile } = require("./lib/env");
const { loadAppConfig, publicServerConfig, resourceSelector } = require("./lib/config");
const { sumNumbers } = require("./lib/util");
const { pingMinecraftServer } = require("./lib/mcProtocol");
const { queryMinecraftServer } = require("./lib/mcQuery");
const { readServerTps } = require("./lib/rcon");
const { collectSystemResources, collectAllServerProcesses } = require("./lib/processMon");
const { importLogBackfill } = require("./lib/logBackfill");
const {
  loadPlayerStats,
  ensureServerStats,
  closeAllActiveSessions,
  updatePlayerDurations,
  buildPlayerViews,
  createPersister
} = require("./lib/playerStats");
const { isAuthorized, isPublicPath } = require("./lib/auth");
const { createSseHub } = require("./lib/sse");

const rootDir = path.resolve(__dirname, "..");
loadEnvFile(path.join(rootDir, ".env"));

const config = loadAppConfig(rootDir);
const publicDir = path.join(rootDir, "public");
const statsPath = path.join(config.dataDir, "player-stats.json");
const startTime = Date.now();
const sseHub = createSseHub();

const state = {
  app: {
    name: config.appName,
    startedAt: new Date(startTime).toISOString()
  },
  pollIntervalMs: config.pollIntervalMs,
  lastUpdatedAt: null,
  nextPollAt: null,
  resources: emptyResources(),
  servers: config.servers.map(createServerState)
};

let playerStats = loadPlayerStats(statsPath);
let pollTimer = null;
let polling = false;
let started = false;

fs.mkdirSync(config.dataDir, { recursive: true });
const persister = createPersister(statsPath, () => playerStats);

hydratePersistedState(Date.now());

const server = http.createServer(async (request, response) => {
  try {
    const parsed = new URL(request.url, "http://localhost");
    if (config.authToken && !isPublicPath(parsed.pathname) && !isAuthorized(request, config.authToken)) {
      response.writeHead(401, {
        "Content-Type": "application/json; charset=utf-8",
        "WWW-Authenticate": "Bearer realm=\"mc-server-monitor\""
      });
      response.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    if (parsed.pathname === "/api/status") {
      sendJson(response, 200, buildStatusPayload());
      return;
    }
    if (parsed.pathname.startsWith("/api/status/")) {
      const serverState = findServerState(decodeURIComponent(parsed.pathname.slice("/api/status/".length)));
      if (!serverState) {
        sendJson(response, 404, { error: "Unknown server id" });
        return;
      }
      sendJson(response, 200, serverState);
      return;
    }
    if (parsed.pathname === "/api/players") {
      sendJson(response, 200, state.servers.map((item) => ({
        id: item.id,
        name: item.name,
        online: item.players.online,
        leaderboard: item.players.leaderboard,
        tracking: item.tracking,
        updatedAt: item.lastUpdatedAt
      })));
      return;
    }
    if (parsed.pathname.startsWith("/api/players/")) {
      const serverState = findServerState(decodeURIComponent(parsed.pathname.slice("/api/players/".length)));
      if (!serverState) {
        sendJson(response, 404, { error: "Unknown server id" });
        return;
      }
      sendJson(response, 200, {
        online: serverState.players.online,
        leaderboard: serverState.players.leaderboard,
        tracking: serverState.tracking,
        updatedAt: serverState.lastUpdatedAt
      });
      return;
    }
    if (parsed.pathname.startsWith("/api/backfill/")) {
      const serverId = decodeURIComponent(parsed.pathname.slice("/api/backfill/".length));
      const serverState = findServerState(serverId);
      const serverConfig = findServerConfig(serverId);
      if (!serverState || !serverConfig) {
        sendJson(response, 404, { error: "Unknown server id" });
        return;
      }
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "Use POST to sync log backfill." });
        return;
      }
      const stats = ensureServerStats(playerStats, serverState.id);
      serverState.backfill = importLogBackfill(serverState.id, serverConfig, stats, Date.now(), { force: true });
      serverState.players = buildPlayerViews(stats, Date.now());
      persister.markDirty();
      broadcastServer(serverState);
      sendJson(response, 200, {
        backfill: serverState.backfill,
        players: serverState.players
      });
      return;
    }
    if (parsed.pathname === "/api/leaderboard") {
      sendJson(response, 200, buildCombinedLeaderboard());
      return;
    }
    if (parsed.pathname === "/api/events") {
      if (!config.sseEnabled) {
        sendJson(response, 404, { error: "SSE disabled" });
        return;
      }
      sseHub.add(response);
      sseHub.broadcast("status", buildStatusPayload());
      return;
    }
    if (parsed.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        onlineServers: state.servers.filter((item) => item.server.online).length,
        servers: state.servers.length,
        sseClients: sseHub.size()
      });
      return;
    }
    await serveStatic(parsed.pathname, response);
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
});

if (require.main === module) {
  startServer();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

module.exports = {
  buildStatusPayload,
  config,
  server,
  startServer,
  stopServer
};

function shutdown() {
  stopServer(() => process.exit(0));
}

function startServer(callback) {
  if (started) {
    if (callback) callback();
    return;
  }
  hydratePersistedState(Date.now());
  started = true;
  server.listen(config.port, config.host, () => {
    console.log(`${config.appName} listening on http://${config.host}:${config.port}${config.authToken ? " (auth required)" : ""}`);
    console.log(`Loaded ${config.servers.length} server(s) from ${config.serversSource}`);
    pollNow();
    if (callback) callback();
  });
}

function stopServer(callback) {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  persister.flushSync();
  if (!started) {
    if (callback) callback();
    return;
  }
  started = false;
  server.close(callback);
}

async function pollNow() {
  if (polling) return;
  polling = true;
  const pollStartedAt = Date.now();
  try {
    const diskPaths = [config.dataDir, ...state.servers.map((srv) => srv.config.worldPath || srv.config.logPath).filter(Boolean)];
    const [systemResources, processMap] = await Promise.all([
      collectSystemResources(diskPaths),
      collectAllServerProcesses(config.servers)
    ]);

    const results = await Promise.all(state.servers.map((serverState) =>
      pollServer(serverState, pollStartedAt, processMap.get(serverState.id) || [])
    ));
    state.resources = systemResources;
    state.servers = results;
    state.lastUpdatedAt = new Date(pollStartedAt).toISOString();
    persister.markDirty();
    sseHub.broadcast("status", buildStatusPayload());
  } catch (error) {
    state.lastUpdatedAt = new Date().toISOString();
    console.warn(`Poll failed: ${error.message}`);
  } finally {
    polling = false;
    if (started) {
      state.nextPollAt = new Date(Date.now() + config.pollIntervalMs).toISOString();
      pollTimer = setTimeout(pollNow, config.pollIntervalMs);
    } else {
      state.nextPollAt = null;
    }
  }
}

async function pollServer(serverState, now, processes) {
  const serverConfig = findServerConfig(serverState.id);
  try {
    const statusResult = await pingMinecraftServer(serverConfig, { timeoutMs: config.pingTimeoutMs });
    applyStatusResult(serverState, statusResult, now);

    let queryResult = null;
    if (serverConfig.queryEnabled && statusResult.online) {
      queryResult = await queryMinecraftServer(serverConfig, { timeoutMs: config.pingTimeoutMs });
      serverState.query = {
        enabled: true,
        ok: queryResult.ok,
        error: queryResult.ok ? null : queryResult.error,
        players: queryResult.players || [],
        metadata: queryResult.metadata || {}
      };
    } else {
      serverState.query = {
        enabled: serverConfig.queryEnabled,
        ok: false,
        error: serverConfig.queryEnabled ? "Server is offline or status ping failed." : null,
        players: [],
        metadata: {}
      };
    }

    if (serverConfig.rconEnabled && serverConfig.rconPort && statusResult.online) {
      const tps = await readServerTps({
        host: serverConfig.rconHost || serverConfig.host,
        port: serverConfig.rconPort,
        password: serverConfig.rconPassword,
        timeoutMs: config.rconTimeoutMs
      });
      serverState.tps = tps;
    } else {
      serverState.tps = { ok: false, error: serverConfig.rconEnabled ? "RCON not configured" : null };
    }

    const observed = chooseObservedPlayers(serverState, statusResult, queryResult);
    const stats = ensureServerStats(playerStats, serverState.id);
    const staleIdleMs = config.pollIntervalMs * config.staleSessionMultiplier;
    updatePlayerDurations(stats, observed, statusResult.online, now, { staleIdleMs });
    serverState.backfill = importLogBackfill(serverState.id, serverConfig, stats, now, { dryRun: true });
    serverState.players = buildPlayerViews(stats, now);

    serverState.resources = {
      collectedAt: new Date(now).toISOString(),
      mode: serverConfig.resourceMode,
      selector: resourceSelector(serverConfig),
      processes
    };
    serverState.lastUpdatedAt = new Date(now).toISOString();
    addHistoryPoint(serverState, now);
  } catch (error) {
    serverState.server.online = false;
    serverState.server.status = "error";
    serverState.server.error = error.message;
    serverState.connection.consecutiveFailures += 1;
    serverState.connection.lastFailureAt = new Date(now).toISOString();
    const stats = ensureServerStats(playerStats, serverState.id);
    closeAllActiveSessions(stats, now);
    serverState.players = buildPlayerViews(stats, now);
  }
  return serverState;
}

function applyStatusResult(serverState, result, now) {
  if (result.online) {
    serverState.server = {
      online: true,
      status: "online",
      error: null,
      latencyMs: result.latencyMs,
      version: result.versionName,
      protocol: result.protocol,
      motd: result.motd,
      playersOnline: result.playersOnline,
      playersMax: result.playersMax
    };
    serverState.connection.consecutiveFailures = 0;
    serverState.connection.lastSuccessAt = new Date(now).toISOString();
    return;
  }

  serverState.server = {
    online: false,
    status: "offline",
    error: result.error,
    latencyMs: null,
    version: null,
    protocol: null,
    motd: "",
    playersOnline: null,
    playersMax: null
  };
  serverState.connection.consecutiveFailures += 1;
  serverState.connection.lastFailureAt = new Date(now).toISOString();
}

function chooseObservedPlayers(serverState, statusResult, queryResult) {
  if (queryResult && queryResult.ok && Array.isArray(queryResult.players)) {
    serverState.tracking = {
      source: "minecraft-query",
      accuracy: "full",
      note: "Full player list from Minecraft Query."
    };
    return {
      mode: "full",
      players: queryResult.players.map((name) => ({ name, id: name }))
    };
  }

  if (statusResult.online && statusResult.samplePlayers.length > 0) {
    serverState.tracking = {
      source: "status-sample",
      accuracy: "partial",
      note: "Tracking visible status sample only. Enable Minecraft Query for exact durations."
    };
    return {
      mode: "partial",
      players: statusResult.samplePlayers.map((player) => ({
        name: player.name || player.id || "Unknown",
        id: player.id || player.name
      }))
    };
  }

  serverState.tracking = {
    source: statusResult.online ? "player-count" : "offline",
    accuracy: statusResult.online ? "count-only" : "full",
    note: statusResult.online
      ? "The server reports player counts but not player names."
      : "Server offline; active sessions were closed."
  };
  return {
    mode: statusResult.online ? "none" : "offline",
    players: []
  };
}

function hydratePersistedState(now) {
  for (const serverState of state.servers) {
    const stats = ensureServerStats(playerStats, serverState.id);
    if (stats.logBackfill) {
      serverState.backfill = { ...serverState.backfill, ...stats.logBackfill };
    }
    serverState.players = buildPlayerViews(stats, now);
    if (stats.lastUpdatedAt) serverState.lastUpdatedAt = stats.lastUpdatedAt;
    if (playerStats.history && Array.isArray(playerStats.history[serverState.id])) {
      serverState.history = playerStats.history[serverState.id].slice(-config.historyLimit);
    }
  }
}

function addHistoryPoint(serverState, now) {
  const processCpu = sumNumbers(serverState.resources.processes.map((item) => item.cpuPercent));
  const processMemory = sumNumbers(serverState.resources.processes.map((item) => item.memoryBytes));
  serverState.history.push({
    at: new Date(now).toISOString(),
    online: serverState.server.online,
    latencyMs: serverState.server.latencyMs,
    playersOnline: serverState.server.playersOnline,
    playersMax: serverState.server.playersMax,
    processCpuPercent: processCpu,
    processMemoryBytes: processMemory,
    tps: serverState.tps && serverState.tps.ok ? serverState.tps.tps1m : null
  });
  if (serverState.history.length > config.historyLimit) {
    serverState.history.splice(0, serverState.history.length - config.historyLimit);
  }
  if (!playerStats.history) playerStats.history = {};
  playerStats.history[serverState.id] = serverState.history.slice(-config.historyLimit);
}

function buildStatusPayload() {
  return {
    app: {
      ...state.app,
      uptimeMs: Date.now() - startTime
    },
    pollIntervalMs: state.pollIntervalMs,
    lastUpdatedAt: state.lastUpdatedAt,
    nextPollAt: state.nextPollAt,
    resources: state.resources,
    summary: {
      servers: state.servers.length,
      onlineServers: state.servers.filter((item) => item.server.online).length,
      playersOnline: state.servers.reduce((sum, item) => sum + (item.server.playersOnline || 0), 0)
    },
    servers: state.servers
  };
}

function buildCombinedLeaderboard() {
  const merged = new Map();
  for (const serverState of state.servers) {
    for (const entry of serverState.players.leaderboard || []) {
      const key = entry.key;
      if (!merged.has(key)) {
        merged.set(key, {
          key,
          name: entry.name,
          totalMs: 0,
          sessions: 0,
          servers: []
        });
      }
      const item = merged.get(key);
      item.totalMs += entry.totalMs;
      item.sessions += entry.sessions;
      item.servers.push({ id: serverState.id, name: serverState.name, totalMs: entry.totalMs });
    }
  }
  return [...merged.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, 100);
}

function broadcastServer(serverState) {
  sseHub.broadcast("server", { id: serverState.id, server: serverState });
}

function emptyResources() {
  return {
    collectedAt: null,
    system: {
      platform: null,
      hostname: null,
      uptimeSeconds: null,
      loadAverage: [],
      cpuPercent: null,
      cpuCount: null,
      memoryTotal: null,
      memoryUsed: null,
      memoryFree: null,
      memoryUsedPercent: null,
      disk: null,
      disks: []
    }
  };
}

function createServerState(serverConfig) {
  return {
    id: serverConfig.id,
    name: serverConfig.name,
    config: publicServerConfig(serverConfig),
    target: publicServerConfig(serverConfig),
    lastUpdatedAt: null,
    server: {
      online: false,
      status: "starting",
      error: null,
      latencyMs: null,
      version: null,
      protocol: null,
      motd: "",
      playersOnline: null,
      playersMax: null
    },
    connection: {
      consecutiveFailures: 0,
      lastSuccessAt: null,
      lastFailureAt: null
    },
    query: {
      enabled: serverConfig.queryEnabled,
      ok: false,
      error: null,
      players: [],
      metadata: {}
    },
    tps: { ok: false, error: null },
    tracking: {
      source: "unavailable",
      accuracy: "none",
      note: "Waiting for the first poll."
    },
    resources: {
      collectedAt: null,
      mode: serverConfig.resourceMode,
      selector: resourceSelector(serverConfig),
      processes: []
    },
    players: { online: [], leaderboard: [] },
    backfill: {
      enabled: serverConfig.logBackfillEnabled,
      path: serverConfig.logPath || null,
      ok: true,
      importedSessions: 0,
      importedMs: 0,
      scannedFiles: 0,
      lastImportedAt: null,
      error: null
    },
    history: []
  };
}

function findServerState(id) {
  return state.servers.find((item) => item.id === id);
}

function findServerConfig(id) {
  return config.servers.find((item) => item.id === id);
}

async function serveStatic(requestPath, response) {
  const cleanPath = requestPath === "/" ? "/index.html" : requestPath;
  const decoded = decodeURIComponent(cleanPath);
  const safeRelative = decoded.replace(/^[/\\]+/, "");
  const filePath = path.resolve(publicDir, safeRelative);
  const publicRoot = publicDir.endsWith(path.sep) ? publicDir : `${publicDir}${path.sep}`;
  if (filePath !== publicDir && !filePath.startsWith(publicRoot)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  try {
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile()) {
      sendText(response, 404, "Not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Cache-Control": filePath.endsWith("index.html") ? "no-store" : "public, max-age=60"
    });
    fs.createReadStream(filePath).pipe(response);
  } catch {
    sendText(response, 404, "Not found");
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendText(response, statusCode, text) {
  response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(text);
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml"
  };
  return types[extension] || "application/octet-stream";
}
