"use strict";

const net = require("net");

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

function pingMinecraftServer(serverConfig, options = {}) {
  const timeout = options.timeoutMs || 3500;
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = net.createConnection({
      host: serverConfig.host,
      port: serverConfig.port,
      timeout
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
      error: `Timed out after ${timeout} ms`,
      samplePlayers: []
    }));
    socket.on("error", (error) => finish({
      online: false,
      error: error.message,
      samplePlayers: []
    }));
  });
}

module.exports = {
  encodeVarInt,
  readVarInt,
  encodeString,
  encodeUnsignedShort,
  createMinecraftPacket,
  readMinecraftPacket,
  extractDescriptionText,
  stripMinecraftFormatting,
  pingMinecraftServer
};
