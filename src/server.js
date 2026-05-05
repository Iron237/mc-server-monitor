"use strict";

const childProcess = require("child_process");
const dgram = require("dgram");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
loadEnvFile(path.join(rootDir, ".env"));

const config = {
  appName: envString("APP_NAME", "Minecraft Server Monitor"),
  host: envString("HOST", "0.0.0.0"),
  port: envInt("PORT", envInt("HTTP_PORT", 3000)),
  mcHost: envString("MC_HOST", "127.0.0.1"),
  mcPort: envInt("MC_PORT", 25565),
  mcProtocolVersion: envInt("MC_PROTOCOL_VERSION", 767),
  pingTimeoutMs: envInt("PING_TIMEOUT_MS", 3500),
  pollIntervalMs: Math.max(5000, envInt("POLL_INTERVAL_MS", 15000)),
  queryEnabled: envBool("MC_QUERY_ENABLED", false),
  queryHost: envString("MC_QUERY_HOST", envString("MC_HOST", "127.0.0.1")),
  queryPort: envInt("MC_QUERY_PORT", envInt("MC_PORT", 25565)),
  processName: envString("MC_PROCESS_NAME", ""),
  dataDir: path.resolve(rootDir, envString("DATA_DIR", "./data")),
  historyLimit: Math.max(24, envInt("HISTORY_LIMIT", 240))
};

const publicDir = path.join(rootDir, "public");
const statsPath = path.join(config.dataDir, "player-stats.json");
const startTime = Date.now();

const state = {
  app: {
    name: config.appName,
    startedAt: new Date(startTime).toISOString()
  },
  target: publicConfig(),
  lastUpdatedAt: null,
  nextPollAt: null,
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
    enabled: config.queryEnabled,
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
  resources: emptyResources(),
  players: {
    online: [],
    leaderboard: []
  },
  history: []
};

let playerStats = loadPlayerStats();
let previousCpuSnapshot = null;
let previousProcessSamples = new Map();
let pollTimer = null;
let polling = false;
let started = false;

fs.mkdirSync(config.dataDir, { recursive: true });

const server = http.createServer(async (request, response) => {
  try {
    const parsed = new URL(request.url, "http://localhost");
    if (parsed.pathname === "/api/status") {
      sendJson(response, 200, buildStatusPayload());
      return;
    }
    if (parsed.pathname === "/api/players") {
      sendJson(response, 200, {
        online: state.players.online,
        leaderboard: state.players.leaderboard,
        tracking: state.tracking,
        updatedAt: state.lastUpdatedAt
      });
      return;
    }
    if (parsed.pathname === "/health") {
      sendJson(response, 200, { ok: true, serverOnline: state.server.online });
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
    if (callback) {
      callback();
    }
    return;
  }
  started = true;
  server.listen(config.port, config.host, () => {
    console.log(`${config.appName} listening on http://${config.host}:${config.port}`);
    pollNow();
    if (callback) {
      callback();
    }
  });
}

function stopServer(callback) {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  persistPlayerStats();
  if (!started) {
    if (callback) {
      callback();
    }
    return;
  }
  started = false;
  server.close(callback);
}

async function pollNow() {
  if (polling) {
    return;
  }
  polling = true;
  const pollStartedAt = Date.now();
  try {
    const [statusResult, resources] = await Promise.all([
      pingMinecraftServer(),
      collectResources()
    ]);

    applyStatusResult(statusResult, pollStartedAt);

    let queryResult = null;
    if (config.queryEnabled && statusResult.online) {
      queryResult = await queryMinecraftServer();
      state.query = {
        enabled: true,
        ok: queryResult.ok,
        error: queryResult.ok ? null : queryResult.error,
        players: queryResult.players || [],
        metadata: queryResult.metadata || {}
      };
    } else {
      state.query = {
        enabled: config.queryEnabled,
        ok: false,
        error: config.queryEnabled ? "Server is offline or status ping failed." : null,
        players: [],
        metadata: {}
      };
    }

    const observed = chooseObservedPlayers(statusResult, queryResult);
    updatePlayerDurations(observed, statusResult.online, pollStartedAt);
    updatePlayerViews(pollStartedAt);

    state.resources = resources;
    state.lastUpdatedAt = new Date(pollStartedAt).toISOString();
    addHistoryPoint(pollStartedAt);
    persistPlayerStats();
  } catch (error) {
    state.server.online = false;
    state.server.status = "error";
    state.server.error = error.message;
    state.connection.consecutiveFailures += 1;
    state.connection.lastFailureAt = new Date().toISOString();
    closeAllActiveSessions(Date.now());
    updatePlayerViews(Date.now());
    persistPlayerStats();
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

function applyStatusResult(result, now) {
  if (result.online) {
    state.server = {
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
    state.connection.consecutiveFailures = 0;
    state.connection.lastSuccessAt = new Date(now).toISOString();
    return;
  }

  state.server = {
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
  state.connection.consecutiveFailures += 1;
  state.connection.lastFailureAt = new Date(now).toISOString();
}

function chooseObservedPlayers(statusResult, queryResult) {
  if (queryResult && queryResult.ok && Array.isArray(queryResult.players)) {
    state.tracking = {
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
    state.tracking = {
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

  state.tracking = {
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

function updatePlayerDurations(observed, serverOnline, now) {
  if (!serverOnline) {
    closeAllActiveSessions(now);
    return;
  }

  if (observed.mode === "none") {
    return;
  }

  const seenKeys = new Set();
  for (const player of observed.players) {
    const key = normalizePlayerKey(player);
    if (!key) {
      continue;
    }
    seenKeys.add(key);
    const existing = playerStats.players[key] || {
      name: player.name,
      totalMs: 0,
      sessions: 0,
      firstSeenAt: new Date(now).toISOString(),
      lastSeenAt: null
    };
    existing.name = player.name || existing.name;
    existing.lastSeenAt = new Date(now).toISOString();
    playerStats.players[key] = existing;

    if (!playerStats.active[key]) {
      playerStats.active[key] = {
        name: existing.name,
        startedAt: now,
        lastSeenAt: now
      };
      existing.sessions += 1;
    } else {
      playerStats.active[key].name = existing.name;
      playerStats.active[key].lastSeenAt = now;
    }
  }

  if (observed.mode === "full") {
    for (const key of Object.keys(playerStats.active)) {
      if (!seenKeys.has(key)) {
        closeSession(key, now);
      }
    }
  }

  playerStats.lastUpdatedAt = new Date(now).toISOString();
}

function closeAllActiveSessions(now) {
  for (const key of Object.keys(playerStats.active)) {
    closeSession(key, now);
  }
  playerStats.lastUpdatedAt = new Date(now).toISOString();
}

function closeSession(key, fallbackEndTime) {
  const active = playerStats.active[key];
  if (!active) {
    return;
  }
  const endTime = active.lastSeenAt || fallbackEndTime;
  const duration = Math.max(0, endTime - active.startedAt);
  const record = playerStats.players[key] || {
    name: active.name,
    totalMs: 0,
    sessions: 0,
    firstSeenAt: new Date(active.startedAt).toISOString(),
    lastSeenAt: null
  };
  record.totalMs += duration;
  record.lastSeenAt = new Date(endTime).toISOString();
  playerStats.players[key] = record;
  delete playerStats.active[key];
}

function updatePlayerViews(now) {
  const online = Object.entries(playerStats.active)
    .map(([key, active]) => {
      const record = playerStats.players[key] || { totalMs: 0, sessions: 0 };
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

  const leaderboard = Object.entries(playerStats.players)
    .map(([key, record]) => {
      const active = playerStats.active[key];
      const currentMs = active ? Math.max(0, now - active.startedAt) : 0;
      return {
        key,
        name: record.name,
        totalMs: record.totalMs + currentMs,
        sessions: record.sessions,
        firstSeenAt: record.firstSeenAt,
        lastSeenAt: active
          ? new Date(active.lastSeenAt).toISOString()
          : record.lastSeenAt,
        online: Boolean(active)
      };
    })
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, 100);

  state.players = { online, leaderboard };
}

function addHistoryPoint(now) {
  state.history.push({
    at: new Date(now).toISOString(),
    online: state.server.online,
    latencyMs: state.server.latencyMs,
    playersOnline: state.server.playersOnline,
    playersMax: state.server.playersMax,
    cpuPercent: state.resources.system.cpuPercent,
    memoryUsedPercent: state.resources.system.memoryUsedPercent
  });
  if (state.history.length > config.historyLimit) {
    state.history.splice(0, state.history.length - config.historyLimit);
  }
}

function buildStatusPayload() {
  return {
    app: {
      ...state.app,
      uptimeMs: Date.now() - startTime
    },
    target: state.target,
    lastUpdatedAt: state.lastUpdatedAt,
    nextPollAt: state.nextPollAt,
    server: state.server,
    connection: state.connection,
    query: state.query,
    tracking: state.tracking,
    resources: state.resources,
    players: state.players,
    history: state.history
  };
}

function pingMinecraftServer() {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = net.createConnection({
      host: config.mcHost,
      port: config.mcPort,
      timeout: config.pingTimeoutMs
    });
    let buffer = Buffer.alloc(0);
    let finished = false;

    const finish = (result) => {
      if (finished) {
        return;
      }
      finished = true;
      socket.destroy();
      resolve(result);
    };

    socket.on("connect", () => {
      const handshake = createMinecraftPacket(0x00, Buffer.concat([
        encodeVarInt(config.mcProtocolVersion),
        encodeString(config.mcHost),
        encodeUnsignedShort(config.mcPort),
        encodeVarInt(1)
      ]));
      const request = createMinecraftPacket(0x00, Buffer.alloc(0));
      socket.write(Buffer.concat([handshake, request]));
    });

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const packet = readMinecraftPacket(buffer);
      if (!packet) {
        return;
      }
      try {
        const id = readVarInt(packet.data, 0);
        if (id.value !== 0) {
          finish({
            online: false,
            error: `Unexpected status packet id ${id.value}`,
            samplePlayers: []
          });
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
          protocol: parsed.version && Number.isFinite(parsed.version.protocol)
            ? parsed.version.protocol
            : null,
          motd: stripMinecraftFormatting(extractDescriptionText(parsed.description)),
          playersOnline: parsed.players ? parsed.players.online : null,
          playersMax: parsed.players ? parsed.players.max : null,
          samplePlayers: parsed.players && Array.isArray(parsed.players.sample)
            ? parsed.players.sample
            : []
        });
      } catch (error) {
        finish({
          online: false,
          error: error.message,
          samplePlayers: []
        });
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

function queryMinecraftServer() {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const sessionId = Math.floor(Math.random() * 0x7fffffff);
    let timer = null;
    let step = "challenge";

    const finish = (result) => {
      if (timer) {
        clearTimeout(timer);
      }
      socket.close();
      resolve(result);
    };

    const resetTimer = () => {
      if (timer) {
        clearTimeout(timer);
      }
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
          socket.send(packet, config.queryPort, config.queryHost);
          return;
        }

        const parsed = parseQueryFullStat(message);
        finish({
          ok: true,
          error: null,
          players: parsed.players,
          metadata: parsed.metadata
        });
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
    socket.send(packet, config.queryPort, config.queryHost);
  });
}

function parseQueryFullStat(message) {
  const marker = Buffer.from([0x00, 0x01, 0x70, 0x6c, 0x61, 0x79, 0x65, 0x72, 0x5f, 0x00, 0x00]);
  const markerIndex = message.indexOf(marker, 5);
  if (markerIndex === -1) {
    throw new Error("Query response did not include a player section.");
  }

  const metadataTokens = splitNullStrings(message.slice(5, markerIndex));
  const firstKey = metadataTokens.findIndex((token) => token === "hostname" || token === "gametype");
  const metadata = {};
  if (firstKey !== -1) {
    for (let index = firstKey; index < metadataTokens.length - 1; index += 2) {
      metadata[metadataTokens[index]] = metadataTokens[index + 1];
    }
  }

  const players = splitNullStrings(message.slice(markerIndex + marker.length))
    .filter((name) => name.length > 0);

  return { metadata, players };
}

async function collectResources() {
  const system = collectSystemResources();
  const processes = config.processName ? await collectProcessResources(config.processName) : [];
  return {
    collectedAt: new Date().toISOString(),
    system,
    processes
  };
}

function collectSystemResources() {
  const memoryTotal = os.totalmem();
  const memoryFree = os.freemem();
  const memoryUsed = memoryTotal - memoryFree;
  const cpu = sampleCpuPercent();
  const disk = sampleDiskUsage();

  return {
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
  if (typeof fs.statfsSync !== "function") {
    return null;
  }
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
    return {
      path: config.dataDir,
      error: error.message
    };
  }
}

function collectProcessResources(processName) {
  if (os.platform() === "win32") {
    return collectWindowsProcesses(processName);
  }
  return collectUnixProcesses(processName);
}

function collectWindowsProcesses(processName) {
  return new Promise((resolve) => {
    const command = [
      "$ErrorActionPreference='SilentlyContinue';",
      `$items=Get-Process -Name ${JSON.stringify(processName)} | Select-Object Id,ProcessName,CPU,WorkingSet64,PrivateMemorySize64,StartTime;`,
      "if($items){$items | ConvertTo-Json -Compress}"
    ].join(" ");

    childProcess.execFile(
      "powershell.exe",
      ["-NoProfile", "-Command", command],
      { timeout: 3000, windowsHide: true },
      (error, stdout) => {
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
      }
    );
  });
}

function collectUnixProcesses(processName) {
  return new Promise((resolve) => {
    childProcess.execFile(
      "ps",
      ["-C", processName, "-o", "pid=,comm=,pcpu=,rss=,etime="],
      { timeout: 3000 },
      (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve([]);
          return;
        }
        const rows = stdout.trim().split(/\r?\n/).map((line) => {
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
        resolve(rows);
      }
    );
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
    previousProcessSamples.set(sample.pid, {
      cpuSeconds: sample.cpuSeconds,
      sampledAt: now
    });
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
    if (buffer.length < packetEnd) {
      return null;
    }
    return {
      data: buffer.slice(packetStart, packetEnd),
      bytesRead: packetEnd
    };
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
    if (unsigned !== 0) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (unsigned !== 0);
  return Buffer.from(bytes);
}

function readVarInt(buffer, offset) {
  let value = 0;
  let size = 0;
  let byte = 0;
  do {
    if (offset + size >= buffer.length) {
      throw new Error("Incomplete VarInt");
    }
    byte = buffer[offset + size];
    value |= (byte & 0x7f) << (7 * size);
    size += 1;
    if (size > 5) {
      throw new Error("VarInt is too big");
    }
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
  if (!description) {
    return "";
  }
  if (typeof description === "string") {
    return description;
  }
  if (Array.isArray(description)) {
    return description.map(extractDescriptionText).join("");
  }
  const parts = [];
  if (description.text) {
    parts.push(description.text);
  }
  if (description.translate) {
    parts.push(description.translate);
  }
  if (Array.isArray(description.extra)) {
    parts.push(description.extra.map(extractDescriptionText).join(""));
  }
  return parts.join("");
}

function stripMinecraftFormatting(value) {
  return String(value || "").replace(/§[0-9A-FK-OR]/gi, "");
}

function splitNullStrings(buffer) {
  return buffer
    .toString("utf8")
    .split("\0")
    .map((part) => part.trim())
    .filter(Boolean);
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
    },
    processes: []
  };
}

function loadPlayerStats() {
  try {
    if (fs.existsSync(statsPath)) {
      const parsed = JSON.parse(fs.readFileSync(statsPath, "utf8"));
      return {
        players: parsed.players || {},
        active: parsed.active || {},
        lastUpdatedAt: parsed.lastUpdatedAt || null
      };
    }
  } catch (error) {
    console.warn(`Could not load ${statsPath}: ${error.message}`);
  }
  return { players: {}, active: {}, lastUpdatedAt: null };
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

function publicConfig() {
  return {
    host: config.mcHost,
    port: config.mcPort,
    queryEnabled: config.queryEnabled,
    queryPort: config.queryPort,
    pollIntervalMs: config.pollIntervalMs,
    processName: config.processName || null
  };
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) {
      continue;
    }
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
  const value = process.env[name];
  if (value === undefined || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function normalizePlayerKey(player) {
  const raw = player.id || player.name;
  return raw ? String(raw).trim().toLowerCase() : "";
}

function percent(value, total) {
  return total > 0 ? round((value / total) * 100, 1) : null;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
