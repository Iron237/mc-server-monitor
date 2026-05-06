"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createAlertEngine } = require("../src/lib/alerts");

test("alert engine fires once after sustainedMs and not before", () => {
  const events = [];
  const engine = createAlertEngine({ tpsThreshold: 10, sustainedMs: 5 * 60 * 1000, onAlert: (e) => events.push(e) });
  const t0 = 1_000_000_000_000;
  // dip starts
  assert.equal(engine.evaluate("s1", 8.5, t0), null);
  // 4 minutes in: still below, but not long enough yet
  assert.equal(engine.evaluate("s1", 7.2, t0 + 4 * 60_000), null);
  assert.equal(events.length, 0);
  // 5 minutes in: should fire exactly once
  const fired = engine.evaluate("s1", 6.8, t0 + 5 * 60_000);
  assert.ok(fired);
  assert.equal(fired.type, "tps-low");
  assert.equal(fired.lowestTps, 6.8);
  assert.equal(events.length, 1);
  // 6 minutes in: incident still open but no duplicate alert
  assert.equal(engine.evaluate("s1", 6.5, t0 + 6 * 60_000), null);
  assert.equal(events.length, 1);
});

test("alert engine emits tps-recovered exactly once", () => {
  const events = [];
  const engine = createAlertEngine({ tpsThreshold: 10, sustainedMs: 60_000, onAlert: (e) => events.push(e) });
  const t0 = 2_000_000_000_000;
  engine.evaluate("s1", 5, t0);
  engine.evaluate("s1", 4, t0 + 90_000); // alert fires
  assert.equal(events[0].type, "tps-low");
  // recover
  const recovered = engine.evaluate("s1", 19.9, t0 + 200_000);
  assert.ok(recovered);
  assert.equal(recovered.type, "tps-recovered");
  assert.equal(recovered.recoveredTps, 19.9);
  // future >= threshold reads don't keep firing recovery
  assert.equal(engine.evaluate("s1", 20, t0 + 300_000), null);
  assert.equal(events.length, 2);
});

test("brief dip below threshold without sustain produces no events", () => {
  const events = [];
  const engine = createAlertEngine({ tpsThreshold: 10, sustainedMs: 60_000, onAlert: (e) => events.push(e) });
  const t0 = 3_000_000_000_000;
  engine.evaluate("s1", 9, t0);
  engine.evaluate("s1", 8, t0 + 10_000);
  // recovers within sustain window
  engine.evaluate("s1", 20, t0 + 30_000);
  assert.equal(events.length, 0);
});

test("alert engine isolates incidents per server", () => {
  const engine = createAlertEngine({ tpsThreshold: 10, sustainedMs: 60_000 });
  const t0 = 4_000_000_000_000;
  engine.evaluate("s1", 5, t0);
  engine.evaluate("s2", 25, t0); // healthy
  const fired = engine.evaluate("s1", 5, t0 + 90_000);
  assert.ok(fired && fired.serverId === "s1");
  assert.equal(engine.getIncident("s1").alerted, true);
  assert.equal(engine.getIncident("s2"), null);
});
