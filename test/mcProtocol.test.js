"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  encodeVarInt,
  readVarInt,
  encodeString,
  createMinecraftPacket,
  readMinecraftPacket,
  extractDescriptionText,
  stripMinecraftFormatting
} = require("../src/lib/mcProtocol");

test("encodeVarInt round-trips small numbers", () => {
  for (const value of [0, 1, 127, 128, 255, 16384, 12345678, 2147483647]) {
    const buf = encodeVarInt(value);
    const decoded = readVarInt(buf, 0);
    assert.equal(decoded.value, value);
    assert.equal(decoded.size, buf.length);
  }
});

test("encodeString prefixes length", () => {
  const buf = encodeString("hi");
  assert.equal(buf[0], 2);
  assert.equal(buf.slice(1).toString("utf8"), "hi");
});

test("readVarInt rejects oversized varint", () => {
  const bad = Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80]);
  assert.throws(() => readVarInt(bad, 0));
});

test("createMinecraftPacket / readMinecraftPacket compose", () => {
  const packet = createMinecraftPacket(0x00, encodeString("ok"));
  const parsed = readMinecraftPacket(packet);
  assert.ok(parsed);
  assert.equal(parsed.bytesRead, packet.length);
});

test("readMinecraftPacket returns null on incomplete buffer", () => {
  const packet = createMinecraftPacket(0x00, encodeString("ok"));
  const partial = packet.slice(0, packet.length - 1);
  assert.equal(readMinecraftPacket(partial), null);
});

test("extractDescriptionText supports nested objects", () => {
  const out = extractDescriptionText({
    text: "Hello ",
    extra: [{ text: "world" }, " "]
  });
  assert.equal(out, "Hello world ");
});

test("stripMinecraftFormatting removes color codes", () => {
  assert.equal(stripMinecraftFormatting("§aWelcome §r§e!"), "Welcome !");
});
