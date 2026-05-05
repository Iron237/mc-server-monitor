"use strict";

const childProcess = require("child_process");
const dgram = require("dgram");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const rootDir = path.resolve(__dirname, "..");
loadEnvFile(path.join(rootDir, ".env"));

const config = {
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
  servers: loadServerConfigs()
};

const publicDir = path.join(rootDir, "public");
const statsPath = path.join(config.dataDir, "player-stats.json");
const startTime = Date.now();

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

let playerStats = loadPlayerStats();
let previousCpuSnapshot = null;
let previousProcessSamples = new Map();
let pollTimer = null;
let polling = false;
let started = false;

fs.mkdirSync(config.dataDir, { recursive: true });
hydratePersistedState(Date.now());

const server = http.createServer(async (request, response) => {
  try {
    const parsed = new URL(request.url, "http://localhost");
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
      serverState.backfill = importLogBackfill(serverState.id, serverConfig, Date.now(), { force: true });
      updatePlayerViews(serverState, Date.now());
      persistPlayerStats();
      sendJson(response, 200, {
        backfill: serverState.backfill,
        players: serverState.players
      });
      return;
    }
    if (parsed.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        onlineServers: state.servers.filter((item) => item.server.online).length,
        servers: state.servers.length
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
  importLogBackfill,
  parseLogSessions,
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
    console.log(`${config.appName} listening on http://${config.host}:${config.port}`);
    pollNow();
    if (callback) callback();
  });
}

function stopServer(callback) {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  persistPlayerStats();
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
    const systemResources = await collectSystemResources();
    const results = await Promise.all(state.servers.map((serverState) => pollServer(serverState, pollStartedAt)));
    state.resources = systemResources;
    state.servers = results;
    state.lastUpdatedAt = new Date(pollStartedAt).toISOString();
    persistPlayerStats();
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

async function pollServer(serverState, now) {
  const serverConfig = serverState.config;
  try {
    const [statusResult, processResources] = await Promise.all([
      pingMinecraftServer(serverConfig),
      collectServerProcesses(serverConfig)
    ]);

    applyStatusResult(serverState, statusResult, now);

    let queryResult = null;
    if (serverConfig.queryEnabled && statusResult.online) {
      queryResult = await queryMinecraftServer(serverConfig);
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

    const observed = chooseObservedPlayers(serverState, statusResult, queryResult);
    updatePlayerDurations(serverState.id, observed, statusResult.online, now);
    serverState.backfill = importLogBackfill(serverState.id, serverConfig, now, { dryRun: true });
    updatePlayerViews(serverState, now);

    serverState.resources = {
      collectedAt: new Date(now).toISOString(),
      mode: serverConfig.resourceMode,
      selector: resourceSelector(serverConfig),
      processes: processResources
    };
    serverState.lastUpdatedAt = new Date(now).toISOString();
    addHistoryPoint(serverState, now);
  } catch (error) {
    serverState.server.online = false;
    serverState.server.status = "error";
    serverState.server.error = error.message;
    serverState.connection.consecutiveFailures += 1;
    serverState.connection.lastFailureAt = new Date(now).toISOString();
    closeAllActiveSessions(serverState.id, now);
    updatePlayerViews(serverState, now);
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

function updatePlayerDurations(serverId, observed, serverOnline, now) {
  const stats = ensureServerStats(serverId);
  if (!serverOnline) {
    closeAllActiveSessions(serverId, now);
    return;
  }

  if (observed.mode === "none") return;

  const seenKeys = new Set();
  for (const player of observed.players) {
    const key = normalizePlayerKey(player);
    if (!key) continue;
    seenKeys.add(key);
    const existing = stats.players[key] || {
      name: player.name,
      totalMs: 0,
      sessions: 0,
      firstSeenAt: new Date(now).toISOString(),
      lastSeenAt: null
    };
    existing.name = player.name || existing.name;
    existing.lastSeenAt = new Date(now).toISOString();
    stats.players[key] = existing;

    if (!stats.active[key]) {
      stats.active[key] = {
        name: existing.name,
        startedAt: now,
        lastSeenAt: now
      };
      existing.sessions += 1;
    } else {
      stats.active[key].name = existing.name;
      stats.active[key].lastSeenAt = now;
    }
  }

  if (observed.mode === "full") {
    for (const key of Object.keys(stats.active)) {
      if (!seenKeys.has(key)) closeSession(serverId, key, now);
    }
  }

  stats.lastUpdatedAt = new Date(now).toISOString();
}

function closeAllActiveSessions(serverId, now) {
  const stats = ensureServerStats(serverId);
  for (const key of Object.keys(stats.active)) {
    closeSession(serverId, key, now);
  }
  stats.lastUpdatedAt = new Date(now).toISOString();
}

function closeSession(serverId, key, fallbackEndTime) {
  const stats = ensureServerStats(serverId);
  const active = stats.active[key];
  if (!active) return;
  const endTime = active.lastSeenAt || fallbackEndTime;
  const duration = Math.max(0, endTime - active.startedAt);
  const record = stats.players[key] || {
    name: active.name,
    totalMs: 0,
    sessions: 0,
    firstSeenAt: new Date(active.startedAt).toISOString(),
    lastSeenAt: null
  };
  record.totalMs += duration;
  record.lastSeenAt = new Date(endTime).toISOString();
  stats.players[key] = record;
  delete stats.active[key];
}

function updatePlayerViews(serverState, now) {
  const stats = ensureServerStats(serverState.id);
  const online = Object.entries(stats.active)
    .map(([key, active]) => {
      const record = stats.players[key] || { totalMs: 0, sessions: 0 };
      const currentMs = Math.max(0, now - active.startedAt);
      return {
        key,
        name: active.name,
        currentSessionMs: currentMs,
        totalMs: record.totalMs + currentMs,
        sessions: record.sessions,
        startedAt: new Date(active.startedAt).toISOString(),
        lastSeenAt: new Date(active.lastSeenAt).toISOString()
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const leaderboard = Object.entries(stats.players)
    .map(([key, record]) => {
      const active = stats.active[key];
      const currentMs = active ? Math.max(0, now - active.startedAt) : 0;
      return {
        key,
        name: record.name,
        totalMs: record.totalMs + currentMs,
        sessions: record.sessions,
        firstSeenAt: record.firstSeenAt,
        lastSeenAt: active ? new Date(active.lastSeenAt).toISOString() : record.lastSeenAt,
        online: Boolean(active)
      };
    })
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, 100);

  serverState.players = { online, leaderboard };
}

function hydratePersistedState(now) {
  for (const serverState of state.servers) {
    const stats = ensureServerStats(serverState.id);
    if (stats.logBackfill) {
      serverState.backfill = {
        ...serverState.backfill,
        ...stats.logBackfill
      };
    }
    updatePlayerViews(serverState, now);
    if (stats.lastUpdatedAt) {
      serverState.lastUpdatedAt = stats.lastUpdatedAt;
    }
  }
}

function importLogBackfill(serverId, serverConfig, now, options = {}) {
  if (!serverConfig.logBackfillEnabled || !serverConfig.logPath) {
    return {
      enabled: Boolean(serverConfig.logBackfillEnabled),
      path: serverConfig.logPath || null,
      ok: true,
      importedSessions: 0,
      importedMs: 0,
      scannedFiles: 0,
      parsedSessions: 0,
      files: [],
      lastImportedAt: null,
      error: null
    };
  }

  const startedAt = Date.now();
  const stats = ensureServerStats(serverId);
  if (!stats.importedSessions) stats.importedSessions = {};

  try {
    const files = listLogFiles(serverConfig.logPath, serverConfig.logBackfillMaxFiles);
    const sessions = parseLogSessions(files);
    let importedSessions = 0;
    let importedMs = 0;

    for (const session of sessions) {
      const key = sessionKey(session);
      if (stats.importedSessions[key]) continue;
      const duration = session.endAt - session.startAt;
      const maxDuration = serverConfig.logBackfillMaxSessionHours * 60 * 60 * 1000;
      if (duration <= 0 || duration > maxDuration) continue;
      if (options.dryRun) continue;

      const record = stats.players[session.playerKey] || {
        name: session.playerName,
        totalMs: 0,
        sessions: 0,
        firstSeenAt: new Date(session.startAt).toISOString(),
        lastSeenAt: null
      };
      record.name = session.playerName;
      record.totalMs += duration;
      record.sessions += 1;
      record.firstSeenAt = minIso(record.firstSeenAt, session.startAt);
      record.lastSeenAt = maxIso(record.lastSeenAt, session.endAt);
      stats.players[session.playerKey] = record;
      stats.importedSessions[key] = {
        player: session.playerName,
        startAt: new Date(session.startAt).toISOString(),
        endAt: new Date(session.endAt).toISOString(),
        durationMs: duration,
        source: session.source
      };
      importedSessions += 1;
      importedMs += duration;
    }

    const result = {
      enabled: true,
      path: serverConfig.logPath,
      ok: true,
      mode: options.dryRun ? "scan" : options.force ? "manual" : "auto",
      importedSessions,
      importedMs,
      scannedFiles: files.length,
      parsedSessions: sessions.length,
      files: summarizeLogFiles(files, sessions, stats),
      durationMs: Date.now() - startedAt,
      lastImportedAt: importedSessions > 0 ? new Date(now).toISOString() : stats.logBackfill?.lastImportedAt || null,
      error: null
    };
    stats.logBackfill = result;
    if (!options.dryRun) {
      stats.lastUpdatedAt = new Date(now).toISOString();
    }
    return result;
  } catch (error) {
    const result = {
      enabled: true,
      path: serverConfig.logPath,
      ok: false,
      importedSessions: 0,
      importedMs: 0,
      scannedFiles: 0,
      parsedSessions: 0,
      files: [],
      durationMs: Date.now() - startedAt,
      lastImportedAt: stats.logBackfill?.lastImportedAt || null,
      error: error.message
    };
    stats.logBackfill = result;
    return result;
  }
}

function listLogFiles(logPath, maxFiles) {
  const resolved = path.resolve(logPath);
  const stat = fs.statSync(resolved);
  const files = stat.isDirectory()
    ? fs.readdirSync(resolved)
      .filter((name) => /\.(log|txt|log\.gz)$/i.test(name))
      .map((name) => path.join(resolved, name))
    : [resolved];

  return files
    .map((filePath) => {
      const fileStat = fs.statSync(filePath);
      return {
        path: filePath,
        name: path.basename(filePath),
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxFiles)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
}

function parseLogSessions(files) {
  const openSessions = new Map();
  const completed = [];
  for (const file of files) {
    const fallbackDate = dateFromLogFileName(file.name) || new Date(file.mtimeMs);
    const text = readLogFile(file.path);
    let previousTimestamp = null;
    let dayOffsetMs = 0;

    for (const line of text.split(/\r?\n/)) {
      const event = parsePlayerLogEvent(line);
      if (!event) continue;
      let timestamp = parseLogTimestamp(line, fallbackDate);
      if (!timestamp) continue;
      if (previousTimestamp && timestamp.getTime() + dayOffsetMs < previousTimestamp - 12 * 60 * 60 * 1000) {
        dayOffsetMs += 24 * 60 * 60 * 1000;
      }
      const eventTime = timestamp.getTime() + dayOffsetMs;
      previousTimestamp = eventTime;
      const playerKey = event.player.toLowerCase();

      if (event.action === "join") {
        openSessions.set(playerKey, {
          playerKey,
          playerName: event.player,
          startAt: eventTime,
          source: file.name,
          sourceFile: file.name,
          sourcePath: file.path
        });
        continue;
      }

      const open = openSessions.get(playerKey);
      if (!open) continue;
      completed.push({
        ...open,
        playerName: event.player,
        endAt: eventTime,
        source: `${open.source} -> ${file.name}`,
        sourceFile: file.name,
        sourcePath: file.path,
        sourceFiles: [...new Set([open.sourceFile, file.name])]
      });
      openSessions.delete(playerKey);
    }
  }
  return completed;
}

function summarizeLogFiles(files, sessions, stats) {
  const summaries = new Map(files.map((file) => [file.name, {
    name: file.name,
    path: file.path,
    size: file.size,
    mtime: new Date(file.mtimeMs).toISOString(),
    parsedSessions: 0,
    importedSessions: 0,
    pendingSessions: 0,
    synced: true
  }]));

  for (const session of sessions) {
    const key = sessionKey(session);
    const imported = Boolean(stats.importedSessions && stats.importedSessions[key]);
    const sourceFiles = session.sourceFiles || [session.sourceFile].filter(Boolean);
    for (const fileName of sourceFiles) {
      const summary = summaries.get(fileName);
      if (!summary) continue;
      summary.parsedSessions += 1;
      if (imported) summary.importedSessions += 1;
      else summary.pendingSessions += 1;
    }
  }

  for (const summary of summaries.values()) {
    summary.synced = summary.pendingSessions === 0;
  }

  return [...summaries.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function sessionKey(session) {
  return `${session.playerKey}:${session.startAt}:${session.endAt}`;
}

function readLogFile(filePath) {
  const content = fs.readFileSync(filePath);
  if (/\.gz$/i.test(filePath)) {
    return zlib.gunzipSync(content).toString("utf8");
  }
  return content.toString("utf8");
}

function parsePlayerLogEvent(line) {
  const loggedIn = line.match(/\b([A-Za-z0-9_]{3,16})(?:\[[^\]]+\])?\s+logged in with entity id\b/);
  if (loggedIn) return { action: "join", player: loggedIn[1] };
  const join = line.match(/\b([A-Za-z0-9_]{3,16}) joined the game\b/);
  if (join) return { action: "join", player: join[1] };
  const lostConnection = line.match(/\b([A-Za-z0-9_]{3,16}) lost connection:/);
  if (lostConnection) return { action: "left", player: lostConnection[1] };
  const left = line.match(/\b([A-Za-z0-9_]{3,16}) left the game\b/);
  if (left) return { action: "left", player: left[1] };
  return null;
}

function parseLogTimestamp(line, fallbackDate) {
  const iso = line.match(/\[(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?/);
  if (iso) {
    return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), Number(iso[4]), Number(iso[5]), Number(iso[6]), toMillis(iso[7]));
  }

  const named = line.match(/\[(\d{1,2})([A-Za-z]{3})(\d{4})\s+(\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?/);
  if (named) {
    const month = monthIndex(named[2]);
    if (month !== null) {
      return new Date(Number(named[3]), month, Number(named[1]), Number(named[4]), Number(named[5]), Number(named[6]), toMillis(named[7]));
    }
  }

  const chineseCompact = line.match(/\[(\d{1,2})(\d{1,2})月(\d{4})\s+(\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?/);
  if (chineseCompact) {
    return new Date(Number(chineseCompact[3]), Number(chineseCompact[2]) - 1, Number(chineseCompact[1]), Number(chineseCompact[4]), Number(chineseCompact[5]), Number(chineseCompact[6]), toMillis(chineseCompact[7]));
  }

  const chineseCompactNoMarker = line.match(/\[(\d{3,4})(\d{4})\s+(\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?/);
  if (chineseCompactNoMarker) {
    const dayMonth = chineseCompactNoMarker[1];
    const day = Number(dayMonth.slice(0, 2));
    const month = Number(dayMonth.slice(2));
    if (month >= 1 && month <= 12) {
      return new Date(Number(chineseCompactNoMarker[2]), month - 1, day, Number(chineseCompactNoMarker[3]), Number(chineseCompactNoMarker[4]), Number(chineseCompactNoMarker[5]), toMillis(chineseCompactNoMarker[6]));
    }
  }

  const timeOnly = line.match(/\[(\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?\]/);
  if (timeOnly && fallbackDate) {
    return new Date(fallbackDate.getFullYear(), fallbackDate.getMonth(), fallbackDate.getDate(), Number(timeOnly[1]), Number(timeOnly[2]), Number(timeOnly[3]), toMillis(timeOnly[4]));
  }

  return null;
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
    processMemoryBytes: processMemory
  });
  if (serverState.history.length > config.historyLimit) {
    serverState.history.splice(0, serverState.history.length - config.historyLimit);
  }
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

function pingMinecraftServer(serverConfig) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = net.createConnection({
      host: serverConfig.host,
      port: serverConfig.port,
      timeout: config.pingTimeoutMs
    });
    let buffer = Buffer.alloc(0);
    let finished = false;

    const finish = (result) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve(result);
    };

    socket.on("connect", () => {
      const handshake = createMinecraftPacket(0x00, Buffer.concat([
        encodeVarInt(serverConfig.protocolVersion),
        encodeString(serverConfig.host),
        encodeUnsignedShort(serverConfig.port),
        encodeVarInt(1)
      ]));
      const request = createMinecraftPacket(0x00, Buffer.alloc(0));
      socket.write(Buffer.concat([handshake, request]));
    });

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const packet = readMinecraftPacket(buffer);
      if (!packet) return;
      try {
        const id = readVarInt(packet.data, 0);
        if (id.value !== 0) {
          finish({ online: false, error: `Unexpected status packet id ${id.value}`, samplePlayers: [] });
          return;
        }
        const jsonStart = id.size;
        const jsonLength = readVarInt(packet.data, jsonStart);
        const json = packet.data
          .slice(jsonStart + jsonLength.size, jsonStart + jsonLength.size + jsonLength.value)
          .toString("utf8");
        const parsed = JSON.parse(json);
        finish({
          online: true,
          latencyMs: Date.now() - startedAt,
          versionName: parsed.version && parsed.version.name ? parsed.version.name : null,
          protocol: parsed.version && Number.isFinite(parsed.version.protocol) ? parsed.version.protocol : null,
          motd: stripMinecraftFormatting(extractDescriptionText(parsed.description)),
          playersOnline: parsed.players ? parsed.players.online : null,
          playersMax: parsed.players ? parsed.players.max : null,
          samplePlayers: parsed.players && Array.isArray(parsed.players.sample) ? parsed.players.sample : []
        });
      } catch (error) {
        finish({ online: false, error: error.message, samplePlayers: [] });
      }
    });

    socket.on("timeout", () => finish({
      online: false,
      error: `Timed out after ${config.pingTimeoutMs} ms`,
      samplePlayers: []
    }));
    socket.on("error", (error) => finish({
      online: false,
      error: error.message,
      samplePlayers: []
    }));
  });
}

function queryMinecraftServer(serverConfig) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const sessionId = Math.floor(Math.random() * 0x7fffffff);
    let timer = null;
    let step = "challenge";

    const finish = (result) => {
      if (timer) clearTimeout(timer);
      socket.close();
      resolve(result);
    };

    const resetTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        finish({ ok: false, error: `Query ${step} timed out`, players: [] });
      }, config.pingTimeoutMs);
    };

    socket.on("message", (message) => {
      try {
        if (step === "challenge") {
          const challenge = parseInt(message.slice(5).toString("ascii").replace(/\0/g, ""), 10);
          if (!Number.isFinite(challenge)) {
            finish({ ok: false, error: "Invalid query challenge token", players: [] });
            return;
          }
          step = "full-stat";
          resetTimer();
          const packet = Buffer.alloc(15);
          packet[0] = 0xfe;
          packet[1] = 0xfd;
          packet[2] = 0x00;
          packet.writeInt32BE(sessionId, 3);
          packet.writeInt32BE(challenge, 7);
          socket.send(packet, serverConfig.queryPort, serverConfig.queryHost);
          return;
        }

        const parsed = parseQueryFullStat(message);
        finish({ ok: true, error: null, players: parsed.players, metadata: parsed.metadata });
      } catch (error) {
        finish({ ok: false, error: error.message, players: [] });
      }
    });

    socket.on("error", (error) => finish({ ok: false, error: error.message, players: [] }));
    resetTimer();
    const packet = Buffer.alloc(7);
    packet[0] = 0xfe;
    packet[1] = 0xfd;
    packet[2] = 0x09;
    packet.writeInt32BE(sessionId, 3);
    socket.send(packet, serverConfig.queryPort, serverConfig.queryHost);
  });
}

function parseQueryFullStat(message) {
  const marker = Buffer.from([0x00, 0x01, 0x70, 0x6c, 0x61, 0x79, 0x65, 0x72, 0x5f, 0x00, 0x00]);
  const markerIndex = message.indexOf(marker, 5);
  if (markerIndex === -1) throw new Error("Query response did not include a player section.");

  const metadataTokens = splitNullStrings(message.slice(5, markerIndex));
  const firstKey = metadataTokens.findIndex((token) => token === "hostname" || token === "gametype");
  const metadata = {};
  if (firstKey !== -1) {
    for (let index = firstKey; index < metadataTokens.length - 1; index += 2) {
      metadata[metadataTokens[index]] = metadataTokens[index + 1];
    }
  }

  const players = splitNullStrings(message.slice(markerIndex + marker.length)).filter((name) => name.length > 0);
  return { metadata, players };
}

async function collectSystemResources() {
  const memoryTotal = os.totalmem();
  const memoryFree = os.freemem();
  const memoryUsed = memoryTotal - memoryFree;
  const cpu = sampleCpuPercent();
  const disk = sampleDiskUsage();

  return {
    collectedAt: new Date().toISOString(),
    system: {
      platform: `${os.platform()} ${os.release()}`,
      hostname: os.hostname(),
      uptimeSeconds: os.uptime(),
      loadAverage: os.loadavg(),
      cpuPercent: cpu,
      cpuCount: os.cpus().length,
      memoryTotal,
      memoryUsed,
      memoryFree,
      memoryUsedPercent: percent(memoryUsed, memoryTotal),
      disk
    }
  };
}

async function collectServerProcesses(serverConfig) {
  try {
    if (serverConfig.pid) {
      return collectProcessesByPid([serverConfig.pid]);
    }
    if (serverConfig.processPort) {
      const pids = await findPidsByListeningPort(serverConfig.processPort);
      if (pids.length > 0) {
        return collectProcessesByPid(pids);
      }
    }
    if (serverConfig.processName) {
      return collectProcessesByName(serverConfig.processName);
    }
  } catch (error) {
    console.warn(`Process resource collection failed for ${serverConfig.id}: ${error.message}`);
  }
  return [];
}

function collectProcessesByPid(pids) {
  const unique = [...new Set(pids.map((pid) => Number(pid)).filter(Number.isFinite))];
  if (!unique.length) return Promise.resolve([]);
  if (os.platform() === "win32") {
    return collectWindowsProcessesByPid(unique);
  }
  return collectUnixProcessesByPid(unique);
}

function collectProcessesByName(processName) {
  if (os.platform() === "win32") {
    return collectWindowsProcessesByName(processName);
  }
  return collectUnixProcessesByName(processName);
}

function findPidsByListeningPort(port) {
  if (os.platform() === "win32") {
    return new Promise((resolve) => {
      const command = [
        "$ErrorActionPreference='SilentlyContinue';",
        `$items=Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen | Select-Object -ExpandProperty OwningProcess -Unique;`,
        "if($items){$items | ConvertTo-Json -Compress}"
      ].join(" ");
      childProcess.execFile("powershell.exe", ["-NoProfile", "-Command", command], { timeout: 3000, windowsHide: true }, (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve([]);
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          resolve((Array.isArray(parsed) ? parsed : [parsed]).map(Number).filter(Number.isFinite));
        } catch {
          resolve([]);
        }
      });
    });
  }

  return new Promise((resolve) => {
    childProcess.execFile("sh", ["-c", `lsof -tiTCP:${Number(port)} -sTCP:LISTEN 2>/dev/null || ss -ltnp 2>/dev/null | awk '/:${Number(port)} / {print $NF}' | sed -n 's/.*pid=\\([0-9][0-9]*\\).*/\\1/p'`], { timeout: 3000 }, (error, stdout) => {
      if (error && !stdout.trim()) {
        resolve([]);
        return;
      }
      resolve([...new Set(stdout.trim().split(/\s+/).map(Number).filter(Number.isFinite))]);
    });
  });
}

function collectWindowsProcessesByPid(pids) {
  const list = pids.join(",");
  return runWindowsProcessCommand(`Get-Process -Id ${list}`);
}

function collectWindowsProcessesByName(processName) {
  return runWindowsProcessCommand(`Get-Process -Name ${JSON.stringify(processName)}`);
}

function runWindowsProcessCommand(selector) {
  return new Promise((resolve) => {
    const command = [
      "$ErrorActionPreference='SilentlyContinue';",
      `$items=${selector} | Select-Object Id,ProcessName,CPU,WorkingSet64,PrivateMemorySize64,StartTime;`,
      "if($items){$items | ConvertTo-Json -Compress}"
    ].join(" ");
    childProcess.execFile("powershell.exe", ["-NoProfile", "-Command", command], { timeout: 3000, windowsHide: true }, (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve([]);
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        resolve(rows.map((row) => normalizeProcessSample({
          pid: row.Id,
          name: row.ProcessName,
          cpuSeconds: Number(row.CPU || 0),
          memoryBytes: Number(row.WorkingSet64 || 0),
          privateMemoryBytes: Number(row.PrivateMemorySize64 || 0),
          startedAt: row.StartTime || null
        })));
      } catch {
        resolve([]);
      }
    });
  });
}

function collectUnixProcessesByPid(pids) {
  return new Promise((resolve) => {
    childProcess.execFile("ps", ["-p", pids.join(","), "-o", "pid=,comm=,pcpu=,rss=,etime="], { timeout: 3000 }, (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve([]);
        return;
      }
      resolve(parseUnixProcessRows(stdout));
    });
  });
}

function collectUnixProcessesByName(processName) {
  return new Promise((resolve) => {
    childProcess.execFile("ps", ["-C", processName, "-o", "pid=,comm=,pcpu=,rss=,etime="], { timeout: 3000 }, (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve([]);
        return;
      }
      resolve(parseUnixProcessRows(stdout));
    });
  });
}

function parseUnixProcessRows(stdout) {
  return stdout.trim().split(/\r?\n/).map((line) => {
    const parts = line.trim().split(/\s+/);
    return normalizeProcessSample({
      pid: Number(parts[0]),
      name: parts[1],
      cpuPercent: Number(parts[2]),
      memoryBytes: Number(parts[3]) * 1024,
      privateMemoryBytes: null,
      startedAt: parts.slice(4).join(" ")
    });
  });
}

function normalizeProcessSample(sample) {
  const now = Date.now();
  const previous = previousProcessSamples.get(sample.pid);
  let cpuPercent = Number.isFinite(sample.cpuPercent) ? sample.cpuPercent : null;
  if (previous && Number.isFinite(sample.cpuSeconds)) {
    const cpuDelta = sample.cpuSeconds - previous.cpuSeconds;
    const wallDelta = (now - previous.sampledAt) / 1000;
    if (wallDelta > 0 && cpuDelta >= 0) {
      cpuPercent = round((cpuDelta / wallDelta / os.cpus().length) * 100, 1);
    }
  }
  if (Number.isFinite(sample.cpuSeconds)) {
    previousProcessSamples.set(sample.pid, { cpuSeconds: sample.cpuSeconds, sampledAt: now });
  }
  return {
    pid: sample.pid,
    name: sample.name,
    cpuPercent,
    cpuSeconds: Number.isFinite(sample.cpuSeconds) ? sample.cpuSeconds : null,
    memoryBytes: sample.memoryBytes,
    privateMemoryBytes: sample.privateMemoryBytes,
    startedAt: sample.startedAt
  };
}

function createMinecraftPacket(id, payload) {
  const body = Buffer.concat([encodeVarInt(id), payload]);
  return Buffer.concat([encodeVarInt(body.length), body]);
}

function readMinecraftPacket(buffer) {
  try {
    const length = readVarInt(buffer, 0);
    const packetStart = length.size;
    const packetEnd = packetStart + length.value;
    if (buffer.length < packetEnd) return null;
    return { data: buffer.slice(packetStart, packetEnd), bytesRead: packetEnd };
  } catch {
    return null;
  }
}

function encodeVarInt(value) {
  let unsigned = value < 0 ? value >>> 0 : value;
  const bytes = [];
  do {
    let byte = unsigned & 0x7f;
    unsigned >>>= 7;
    if (unsigned !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (unsigned !== 0);
  return Buffer.from(bytes);
}

function readVarInt(buffer, offset) {
  let value = 0;
  let size = 0;
  let byte = 0;
  do {
    if (offset + size >= buffer.length) throw new Error("Incomplete VarInt");
    byte = buffer[offset + size];
    value |= (byte & 0x7f) << (7 * size);
    size += 1;
    if (size > 5) throw new Error("VarInt is too big");
  } while ((byte & 0x80) === 0x80);
  return { value, size };
}

function encodeString(value) {
  const content = Buffer.from(value, "utf8");
  return Buffer.concat([encodeVarInt(content.length), content]);
}

function encodeUnsignedShort(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value, 0);
  return buffer;
}

function extractDescriptionText(description) {
  if (!description) return "";
  if (typeof description === "string") return description;
  if (Array.isArray(description)) return description.map(extractDescriptionText).join("");
  const parts = [];
  if (description.text) parts.push(description.text);
  if (description.translate) parts.push(description.translate);
  if (Array.isArray(description.extra)) parts.push(description.extra.map(extractDescriptionText).join(""));
  return parts.join("");
}

function stripMinecraftFormatting(value) {
  return String(value || "").replace(/§[0-9A-FK-OR]/gi, "");
}

function splitNullStrings(buffer) {
  return buffer.toString("utf8").split("\0").map((part) => part.trim()).filter(Boolean);
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
      disk: null
    }
  };
}

function sampleCpuPercent() {
  const snapshot = os.cpus().map((cpu) => ({ ...cpu.times }));
  if (!previousCpuSnapshot) {
    previousCpuSnapshot = snapshot;
    return null;
  }

  let idle = 0;
  let total = 0;
  for (let index = 0; index < snapshot.length; index += 1) {
    const current = snapshot[index];
    const previous = previousCpuSnapshot[index] || current;
    const currentTotal = Object.values(current).reduce((sum, value) => sum + value, 0);
    const previousTotal = Object.values(previous).reduce((sum, value) => sum + value, 0);
    idle += current.idle - previous.idle;
    total += currentTotal - previousTotal;
  }
  previousCpuSnapshot = snapshot;
  return total > 0 ? round(100 - percent(idle, total), 1) : null;
}

function sampleDiskUsage() {
  if (typeof fs.statfsSync !== "function") return null;
  try {
    const stats = fs.statfsSync(config.dataDir);
    const total = stats.blocks * stats.bsize;
    const free = stats.bavail * stats.bsize;
    const used = total - free;
    return {
      path: config.dataDir,
      total,
      used,
      free,
      usedPercent: percent(used, total)
    };
  } catch (error) {
    return { path: config.dataDir, error: error.message };
  }
}

function loadPlayerStats() {
  try {
    if (fs.existsSync(statsPath)) {
      const parsed = JSON.parse(fs.readFileSync(statsPath, "utf8"));
      if (parsed.servers) return parsed;
      return {
        servers: {
          default: {
            players: parsed.players || {},
            active: parsed.active || {},
            importedSessions: parsed.importedSessions || {},
            lastUpdatedAt: parsed.lastUpdatedAt || null
          }
        }
      };
    }
  } catch (error) {
    console.warn(`Could not load ${statsPath}: ${error.message}`);
  }
  return { servers: {} };
}

function ensureServerStats(serverId) {
  if (!playerStats.servers) playerStats.servers = {};
  if (!playerStats.servers[serverId]) {
    playerStats.servers[serverId] = {
      players: {},
      active: {},
      importedSessions: {},
      logBackfill: null,
      lastUpdatedAt: null
    };
  }
  if (!playerStats.servers[serverId].players) playerStats.servers[serverId].players = {};
  if (!playerStats.servers[serverId].active) playerStats.servers[serverId].active = {};
  if (!playerStats.servers[serverId].importedSessions) playerStats.servers[serverId].importedSessions = {};
  return playerStats.servers[serverId];
}

function persistPlayerStats() {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(statsPath, JSON.stringify(playerStats, null, 2));
  } catch (error) {
    console.warn(`Could not save ${statsPath}: ${error.message}`);
  }
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

function loadServerConfigs() {
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
    logBackfillMaxSessionHours: envInt("MC_LOG_BACKFILL_MAX_SESSION_HOURS", envInt("LOG_BACKFILL_MAX_SESSION_HOURS", 24))
  }, 0)];
}

function normalizeServerConfig(item, index) {
  const id = slug(item.id || item.name || `server-${index + 1}`);
  const port = toInt(item.port, index === 1 ? 2000 : 25565);
  const pid = toInt(item.pid || item.processPid, 0) || null;
  const processPort = toInt(item.processPort, port) || null;
  const logPath = item.logPath ? String(item.logPath) : "";
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
    resourceMode: pid ? "pid" : processPort ? "port" : item.processName ? "name" : "none"
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
    players: {
      online: [],
      leaderboard: []
    },
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
    resourceMode: serverConfig.resourceMode
  };
}

function resourceSelector(serverConfig) {
  if (serverConfig.pid) return `pid:${serverConfig.pid}`;
  if (serverConfig.processPort) return `port:${serverConfig.processPort}`;
  if (serverConfig.processName) return `name:${serverConfig.processName}`;
  return "none";
}

function findServerState(id) {
  return state.servers.find((item) => item.id === id);
}

function findServerConfig(id) {
  return config.servers.find((item) => item.id === id);
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

function envString(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function envInt(name, fallback) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isFinite(value) ? value : fallback;
}

function envBool(name, fallback) {
  return toBool(process.env[name], fallback);
}

function normalizePlayerKey(player) {
  const raw = player.id || player.name;
  return raw ? String(raw).trim().toLowerCase() : "";
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function slug(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "server";
}

function percent(value, total) {
  return total > 0 ? round((value / total) * 100, 1) : null;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sumNumbers(values) {
  let hasValue = false;
  const total = values.reduce((sum, value) => {
    if (Number.isFinite(value)) {
      hasValue = true;
      return sum + value;
    }
    return sum;
  }, 0);
  return hasValue ? round(total, 1) : null;
}

function toMillis(value) {
  if (!value) return 0;
  return Number(String(value).padEnd(3, "0").slice(0, 3));
}

function monthIndex(value) {
  const months = {
    jan: 0,
    feb: 1,
    mar: 2,
    apr: 3,
    may: 4,
    jun: 5,
    jul: 6,
    aug: 7,
    sep: 8,
    oct: 9,
    nov: 10,
    dec: 11
  };
  const key = String(value || "").slice(0, 3).toLowerCase();
  return Object.prototype.hasOwnProperty.call(months, key) ? months[key] : null;
}

function dateFromLogFileName(name) {
  const match = String(name).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function minIso(currentIso, timestamp) {
  if (!currentIso) return new Date(timestamp).toISOString();
  return new Date(currentIso).getTime() <= timestamp ? currentIso : new Date(timestamp).toISOString();
}

function maxIso(currentIso, timestamp) {
  if (!currentIso) return new Date(timestamp).toISOString();
  return new Date(currentIso).getTime() >= timestamp ? currentIso : new Date(timestamp).toISOString();
}
