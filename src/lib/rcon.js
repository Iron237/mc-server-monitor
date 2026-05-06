"use strict";

const net = require("net");

const TYPE_AUTH = 3;
const TYPE_AUTH_RESPONSE = 2;
const TYPE_COMMAND = 2;
const TYPE_RESPONSE = 0;

function encodePacket(id, type, body) {
  const payload = Buffer.from(body, "utf8");
  const length = 4 + 4 + payload.length + 2;
  const buffer = Buffer.alloc(4 + length);
  buffer.writeInt32LE(length, 0);
  buffer.writeInt32LE(id, 4);
  buffer.writeInt32LE(type, 8);
  payload.copy(buffer, 12);
  buffer.writeInt8(0, 12 + payload.length);
  buffer.writeInt8(0, 13 + payload.length);
  return buffer;
}

function tryReadPacket(buffer) {
  if (buffer.length < 4) return null;
  const length = buffer.readInt32LE(0);
  if (buffer.length < length + 4) return null;
  const id = buffer.readInt32LE(4);
  const type = buffer.readInt32LE(8);
  const body = buffer.slice(12, 4 + length - 2).toString("utf8");
  return { id, type, body, total: 4 + length };
}

function rconCommand(options, command) {
  const timeout = options.timeoutMs || 3000;
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: options.host, port: options.port, timeout });
    let buffer = Buffer.alloc(0);
    let authed = false;
    let finished = false;

    const finish = (result) => {
      if (finished) return;
      finished = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(result);
    };

    socket.on("connect", () => {
      socket.write(encodePacket(1, TYPE_AUTH, options.password || ""));
    });

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let packet = tryReadPacket(buffer);
      while (packet) {
        buffer = buffer.slice(packet.total);
        if (!authed) {
          if (packet.type !== TYPE_AUTH_RESPONSE) continue;
          if (packet.id === -1) {
            finish({ ok: false, error: "RCON auth failed" });
            return;
          }
          authed = true;
          socket.write(encodePacket(2, TYPE_COMMAND, command));
          packet = tryReadPacket(buffer);
          continue;
        }
        if (packet.type === TYPE_RESPONSE) {
          finish({ ok: true, body: packet.body });
          return;
        }
        packet = tryReadPacket(buffer);
      }
    });

    socket.on("timeout", () => finish({ ok: false, error: `RCON timed out after ${timeout} ms` }));
    socket.on("error", (error) => finish({ ok: false, error: error.message }));
  });
}

function stripFormatting(text) {
  return String(text || "").replace(/§[0-9A-FK-OR]/gi, "").trim();
}

function parseTpsLine(text) {
  if (!text) return null;
  const stripped = stripFormatting(text);
  const matches = [...stripped.matchAll(/(\d+\.\d+)/g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 30);
  if (matches.length === 0) return null;
  const [tps1m = null, tps5m = null, tps15m = null] = matches;
  return { tps1m, tps5m, tps15m, raw: stripped };
}

// MSPT (millisecond-per-tick) output examples:
//   spark:  "Tick lengths (ms) from last 5s ... avg 5.21, peak 12.4"
//   paper:  "Server tick: avg 5.21ms, max 12.4ms"
//   forge:  "Mean tick time: 5.21 ms"
// First number is avg/current, second (if present) is peak.
function parseMsptLine(text) {
  if (!text) return null;
  const stripped = stripFormatting(text);
  if (!/mspt|tick|ms\b/i.test(stripped)) return null;
  const numbers = [...stripped.matchAll(/(\d+\.\d+)/g)].map((m) => Number(m[1]));
  if (numbers.length === 0) return null;
  const [avg, peak = null] = numbers;
  if (!Number.isFinite(avg) || avg <= 0 || avg > 5000) return null;
  return { avg, peak: Number.isFinite(peak) ? peak : null, raw: stripped };
}

// Per-player ping output via spark / similar:
//   "> player1: 23ms"
//   "  player1 - 45 ms"
//   "player1: 23"
// Returns dedup'd array sorted ascending by latency.
function parsePingLines(text) {
  if (!text) return [];
  const stripped = stripFormatting(text);
  const out = [];
  const re = /\b([A-Za-z0-9_]{3,16})\s*[:\-]\s*(\d+(?:\.\d+)?)\s*ms?\b/g;
  let match;
  while ((match = re.exec(stripped)) !== null) {
    const ms = Number(match[2]);
    if (Number.isFinite(ms) && ms >= 0 && ms < 60000) {
      out.push({ name: match[1], ms });
    }
  }
  const seen = new Map();
  for (const item of out) if (!seen.has(item.name.toLowerCase())) seen.set(item.name.toLowerCase(), item);
  return [...seen.values()].sort((a, b) => a.ms - b.ms);
}

// `neoforge tps` first because NeoForge dropped the `forge` namespace.
// `forge tps` still works on classic Forge servers.
const TPS_CANDIDATES = ["neoforge tps", "forge tps", "tps", "spark tps"];

async function readServerTps(rconConfig) {
  for (const cmd of TPS_CANDIDATES) {
    const result = await rconCommand(rconConfig, cmd);
    if (!result.ok) continue;
    const parsed = parseTpsLine(result.body);
    if (parsed) return { ok: true, command: cmd, raw: stripFormatting(result.body), ...parsed };
  }
  return { ok: false, error: "No supported TPS command responded" };
}

// Per-dimension TPS / entity-count from `forge tps` / `neoforge tps`. Three
// known shapes:
//
//   classic Forge:   Dim 0 (minecraft:overworld): Mean tick time: 5.21 ms. Mean TPS: 19.92
//   newer Forge:     Dim minecraft:overworld: Mean tick time: 5.21 ms. Mean TPS: 19.92. Loaded chunks: 441. Entities: 84
//   NeoForge 1.21+:  minecraft:overworld: Mean tick time: 5.21 ms. Mean TPS: 19.92.
//
// We split into lines and accept any line that contains both "Mean tick time"
// and "Mean TPS", excluding the synthetic "Overall:" summary line.
function parseDimensionStats(text) {
  if (!text) return [];
  const stripped = stripFormatting(text);
  const out = [];
  for (const rawLine of stripped.split(/\r?\n/)) {
    if (!/Mean tick time/i.test(rawLine) || !/Mean TPS/i.test(rawLine)) continue;
    if (/^\s*Overall\b/i.test(rawLine)) continue;

    let id = null;
    let name = null;

    // Try classic Forge: "Dim N (namespace:path): ..."
    let m = rawLine.match(/Dim(?:ension)?\s+(-?\d+)\s*\(([A-Za-z][\w:.\-]*?)\)/i);
    if (m) { id = Number(m[1]); name = m[2]; }

    // Older with bare numeric id only: "Dim 0: Mean tick time: ..."
    if (!name) {
      m = rawLine.match(/^\s*Dim(?:ension)?\s+(-?\d+)\s*:/i);
      if (m) { id = Number(m[1]); name = `dim_${id}`; }
    }

    // Forge with namespace but no numeric id: "Dim minecraft:overworld: ..."
    if (!name) {
      m = rawLine.match(/^\s*Dim(?:ension)?\s+([A-Za-z][\w]*:[A-Za-z][\w.\-]*)\s*:/i);
      if (m) name = m[1];
    }

    // NeoForge 1.21+: bare "minecraft:overworld: Mean tick time: ..."
    if (!name) {
      m = rawLine.match(/^\s*([A-Za-z][\w]*:[A-Za-z][\w.\-]*)\s*:\s*Mean tick time/i);
      if (m) name = m[1];
    }

    if (!name) continue;

    const msptMatch = rawLine.match(/Mean tick time:\s*(\d+\.?\d*)\s*ms/i);
    const tpsMatch = rawLine.match(/Mean TPS:\s*(\d+\.?\d*)/i);
    const entityMatch = rawLine.match(/Entities?\s*:\s*(\d+)/i) || rawLine.match(/(\d+)\s*entities\b/i);
    const chunkMatch = rawLine.match(/Loaded\s+chunks?\s*:\s*(\d+)/i) || rawLine.match(/(\d+)\s*chunks\b/i);

    out.push({
      id,
      name,
      mspt: msptMatch ? Number(msptMatch[1]) : null,
      tps: tpsMatch ? Number(tpsMatch[1]) : null,
      entities: entityMatch ? Number(entityMatch[1]) : null,
      loadedChunks: chunkMatch ? Number(chunkMatch[1]) : null
    });
  }
  return out;
}

async function readDimensionStats(rconConfig) {
  for (const cmd of TPS_CANDIDATES) {
    const result = await rconCommand(rconConfig, cmd);
    if (!result.ok) continue;
    const dims = parseDimensionStats(result.body);
    if (dims.length > 0) return { ok: true, command: cmd, dimensions: dims, raw: stripFormatting(result.body) };
  }
  return { ok: false, error: "No per-dimension data in TPS output", dimensions: [] };
}

async function readServerMspt(rconConfig) {
  const candidates = ["spark mspt", "mspt", "tick"];
  for (const cmd of candidates) {
    const result = await rconCommand(rconConfig, cmd);
    if (!result.ok) continue;
    const parsed = parseMsptLine(result.body);
    if (parsed) return { ok: true, command: cmd, ...parsed };
  }
  return { ok: false, error: "No supported MSPT command responded" };
}

async function readServerPings(rconConfig) {
  const candidates = ["spark ping", "ping"];
  for (const cmd of candidates) {
    const result = await rconCommand(rconConfig, cmd);
    if (!result.ok) continue;
    const players = parsePingLines(result.body);
    if (players.length > 0) return { ok: true, command: cmd, players };
  }
  return { ok: false, error: "No supported ping command responded", players: [] };
}

// One call gathers everything we know how to read; failures are surfaced
// per-field instead of aborting the whole probe.
async function readServerHealth(rconConfig) {
  const [tps, mspt, pings] = await Promise.all([
    readServerTps(rconConfig),
    readServerMspt(rconConfig),
    readServerPings(rconConfig)
  ]);
  // Try to reuse the TPS reply for dimension data first (so we don't
  // double-issue the same RCON command). If that yields nothing — typically
  // when `spark tps` won the race and gave only the overall figure — fall
  // back to a dedicated probe through the full TPS_CANDIDATES list.
  let dimensions = { ok: false, dimensions: [] };
  if (tps && tps.ok && tps.raw) {
    const dims = parseDimensionStats(tps.raw);
    if (dims.length > 0) {
      dimensions = { ok: true, command: tps.command, dimensions: dims, raw: tps.raw };
    }
  }
  if (!dimensions.ok) {
    const probed = await readDimensionStats(rconConfig);
    if (probed.ok || probed.raw) dimensions = probed;
  }
  return { tps, mspt, pings, dimensions };
}

module.exports = {
  rconCommand,
  readServerTps,
  readServerMspt,
  readServerPings,
  readServerHealth,
  readDimensionStats,
  parseTpsLine,
  parseMsptLine,
  parsePingLines,
  parseDimensionStats
};
