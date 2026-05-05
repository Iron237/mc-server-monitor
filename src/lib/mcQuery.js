"use strict";

const dgram = require("dgram");

function splitNullStrings(buffer) {
  return buffer.toString("utf8").split("\0").map((part) => part.trim()).filter(Boolean);
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

function queryMinecraftServer(serverConfig, options = {}) {
  const timeout = options.timeoutMs || 3500;
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const sessionId = Math.floor(Math.random() * 0x7fffffff);
    let timer = null;
    let step = "challenge";

    const finish = (result) => {
      if (timer) clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      resolve(result);
    };

    const resetTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        finish({ ok: false, error: `Query ${step} timed out`, players: [] });
      }, timeout);
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

module.exports = { queryMinecraftServer, parseQueryFullStat, splitNullStrings };
