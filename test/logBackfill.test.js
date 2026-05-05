"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parsePlayerLogEvent,
  parseLogTimestamp,
  parseLogSessions,
  dateFromLogFileName,
  monthIndex,
  importLogBackfill,
  clearSessionCache
} = require("../src/lib/logBackfill");

const fs = require("fs");
const os = require("os");
const path = require("path");

test("parsePlayerLogEvent recognises join formats", () => {
  assert.deepEqual(
    parsePlayerLogEvent("Kang62[/127.0.0.1:1234] logged in with entity id 1"),
    { action: "join", player: "Kang62" }
  );
  assert.deepEqual(
    parsePlayerLogEvent("[Server thread/INFO]: IronGod777 joined the game"),
    { action: "join", player: "IronGod777" }
  );
});

test("parsePlayerLogEvent recognises leave formats", () => {
  assert.deepEqual(
    parsePlayerLogEvent("IronGod777 lost connection: Disconnected"),
    { action: "left", player: "IronGod777" }
  );
  assert.deepEqual(
    parsePlayerLogEvent("Kang62 left the game"),
    { action: "left", player: "Kang62" }
  );
});

test("parsePlayerLogEvent ignores unrelated lines", () => {
  assert.equal(parsePlayerLogEvent("Something else"), null);
});

test("parseLogTimestamp handles ISO timestamps", () => {
  const date = parseLogTimestamp("[2026-05-04T18:50:01.323] Some line");
  assert.ok(date instanceof Date);
  assert.equal(date.getFullYear(), 2026);
  assert.equal(date.getMonth(), 4);
  assert.equal(date.getDate(), 4);
});

test("parseLogTimestamp handles named-month format", () => {
  const date = parseLogTimestamp("[26Apr2026 11:48:55.373] x");
  assert.equal(date.getMonth(), 3);
  assert.equal(date.getDate(), 26);
});

test("parseLogTimestamp handles chinese compact (with marker)", () => {
  const date = parseLogTimestamp("[045月2026 18:50:01.323] x");
  assert.equal(date.getMonth(), 4);
  assert.equal(date.getDate(), 4);
  assert.equal(date.getHours(), 18);
});

test("parseLogTimestamp handles chinese compact (no marker)", () => {
  const date = parseLogTimestamp("[0452026 19:07:26.869] x");
  assert.equal(date.getMonth(), 4);
  assert.equal(date.getDate(), 4);
});

test("parseLogTimestamp falls back to time-only with date", () => {
  const fallback = new Date(2026, 0, 15);
  const date = parseLogTimestamp("[12:34:56] line", fallback);
  assert.equal(date.getDate(), 15);
  assert.equal(date.getHours(), 12);
});

test("dateFromLogFileName handles ISO and chinese forms", () => {
  assert.equal(dateFromLogFileName("2026-05-04-1.log").getMonth(), 4);
  assert.equal(dateFromLogFileName("20265月4.log").getMonth(), 4);
  assert.equal(dateFromLogFileName("foo.log"), null);
});

test("monthIndex maps abbreviations", () => {
  assert.equal(monthIndex("Apr"), 3);
  assert.equal(monthIndex("DEC"), 11);
  assert.equal(monthIndex("xyz"), null);
});

test("parseLogSessions pairs join/leave events", () => {
  clearSessionCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcsm-"));
  const file = path.join(dir, "2026-05-04-1.log");
  fs.writeFileSync(file, [
    "[2026-05-04T10:00:00] Foo joined the game",
    "[2026-05-04T10:30:00] Foo left the game",
    "[2026-05-04T11:00:00] Bar logged in with entity id 1",
    "[2026-05-04T11:15:00] Bar lost connection: Disconnected"
  ].join("\n"));
  const stat = fs.statSync(file);
  const sessions = parseLogSessions([{
    path: file,
    name: path.basename(file),
    size: stat.size,
    mtimeMs: stat.mtimeMs
  }]);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].playerName, "Foo");
  assert.equal(sessions[1].playerName, "Bar");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("importLogBackfill skips already-imported sessions", () => {
  clearSessionCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcsm-"));
  const file = path.join(dir, "2026-05-04-1.log");
  fs.writeFileSync(file, [
    "[2026-05-04T10:00:00] Foo joined the game",
    "[2026-05-04T10:30:00] Foo left the game"
  ].join("\n"));
  const stats = { players: {}, active: {}, importedSessions: {}, logBackfill: null, lastUpdatedAt: null };
  const cfg = { logBackfillEnabled: true, logPath: dir, logBackfillMaxFiles: 10, logBackfillMaxSessionHours: 24 };
  const first = importLogBackfill("s1", cfg, stats, Date.now(), {});
  assert.equal(first.importedSessions, 1);
  const second = importLogBackfill("s1", cfg, stats, Date.now(), {});
  assert.equal(second.importedSessions, 0);
  assert.equal(stats.players.foo.totalMs, 30 * 60 * 1000);
  fs.rmSync(dir, { recursive: true, force: true });
});
