"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseTpsLine, parseMsptLine, parsePingLines } = require("../src/lib/rcon");

test("parseTpsLine reads forge-style format", () => {
  const line = "Dim 0 : Mean tick time: 12.345 ms. Mean TPS: 19.85";
  const out = parseTpsLine(line);
  assert.ok(out);
  assert.deepEqual([out.tps1m, out.tps5m], [12.345, 19.85]);
});

test("parseTpsLine reads vanilla three-bucket TPS", () => {
  const out = parseTpsLine("§aTPS from last 1m, 5m, 15m: 20.0, 19.8, 19.5");
  assert.deepEqual([out.tps1m, out.tps5m, out.tps15m], [20, 19.8, 19.5]);
});

test("parseTpsLine returns null for empty", () => {
  assert.equal(parseTpsLine(""), null);
});

test("parseMsptLine reads spark-style avg/peak with formatting", () => {
  const out = parseMsptLine("§7Tick lengths (ms) from last 5s: avg §a5.21§7, peak §c12.4§7.");
  assert.ok(out);
  assert.equal(out.avg, 5.21);
  assert.equal(out.peak, 12.4);
});

test("parseMsptLine handles paper-style format", () => {
  const out = parseMsptLine("Server tick: avg 5.21ms, max 12.4ms");
  assert.equal(out.avg, 5.21);
  assert.equal(out.peak, 12.4);
});

test("parseMsptLine returns null for empty or non-matching", () => {
  assert.equal(parseMsptLine(""), null);
  assert.equal(parseMsptLine("nothing relevant"), null);
});

test("parsePingLines extracts and dedups player pings", () => {
  const text = [
    "Player Pings:",
    "> IronGod777: 23ms",
    "  Couplarity - 45 ms",
    "> Couplarity: 50ms",
    "  kaguyautsuki: 12 ms"
  ].join("\n");
  const out = parsePingLines(text);
  assert.equal(out.length, 3);
  assert.equal(out[0].name, "kaguyautsuki");
  assert.equal(out[0].ms, 12);
  const couplarity = out.find((p) => p.name === "Couplarity");
  assert.equal(couplarity.ms, 45);
});

test("parsePingLines tolerates colon vs dash separators", () => {
  assert.equal(parsePingLines("foo: 10ms").length, 1);
  assert.equal(parsePingLines("foo - 10 ms").length, 1);
});
