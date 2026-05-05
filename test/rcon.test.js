"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseTpsLine } = require("../src/lib/rcon");

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
