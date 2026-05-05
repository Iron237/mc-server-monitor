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

function parseTpsLine(text) {
  if (!text) return null;
  const matches = [...text.matchAll(/(\d+\.\d+)/g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 30);
  if (matches.length === 0) return null;
  const [tps1m = null, tps5m = null, tps15m = null] = matches;
  return { tps1m, tps5m, tps15m, raw: text.replace(/§[0-9A-FK-OR]/gi, "").trim() };
}

async function readServerTps(rconConfig) {
  const candidates = ["forge tps", "tps", "spark tps"];
  for (const cmd of candidates) {
    const result = await rconCommand(rconConfig, cmd);
    if (!result.ok) continue;
    const parsed = parseTpsLine(result.body);
    if (parsed) return { ok: true, command: cmd, ...parsed };
  }
  return { ok: false, error: "No supported TPS command responded" };
}

module.exports = { rconCommand, readServerTps, parseTpsLine };
