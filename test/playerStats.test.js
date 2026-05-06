"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ensureServerStats,
  closeAllActiveSessions,
  closeStaleSessions,
  updatePlayerDurations,
  buildPlayerViews,
  mergeDuplicatePlayerKeys,
  playerKeyFor
} = require("../src/lib/playerStats");

function freshStats() {
  return ensureServerStats({}, "s1");
}

test("updatePlayerDurations starts and ends sessions in full mode", () => {
  const stats = freshStats();
  const t0 = 1_000_000_000_000;
  updatePlayerDurations(stats, { mode: "full", players: [{ name: "Foo", id: "Foo" }] }, true, t0);
  assert.ok(stats.active.foo);
  updatePlayerDurations(stats, { mode: "full", players: [{ name: "Foo", id: "Foo" }] }, true, t0 + 60_000);
  updatePlayerDurations(stats, { mode: "full", players: [] }, true, t0 + 120_000);
  assert.ok(!stats.active.foo);
  // closeSession uses last-seen timestamp (60s after start) so we don't count
  // time the player was no longer in the snapshot.
  assert.equal(stats.players.foo.totalMs, 60_000);
});

test("partial mode does NOT close sessions implicitly, but stale timeout does", () => {
  const stats = freshStats();
  const t0 = 1_000_000_000_000;
  updatePlayerDurations(stats, { mode: "partial", players: [{ name: "Bar", id: "Bar" }] }, true, t0);
  updatePlayerDurations(stats, { mode: "partial", players: [] }, true, t0 + 30_000, { staleIdleMs: 60_000 });
  assert.ok(stats.active.bar, "still active before stale timeout");
  updatePlayerDurations(stats, { mode: "partial", players: [] }, true, t0 + 200_000, { staleIdleMs: 60_000 });
  assert.ok(!stats.active.bar, "closed after stale timeout");
});

test("closeAllActiveSessions ends every active session", () => {
  const stats = freshStats();
  const t0 = 2_000_000_000_000;
  updatePlayerDurations(stats, { mode: "full", players: [{ name: "A", id: "a" }, { name: "B", id: "b" }] }, true, t0);
  updatePlayerDurations(stats, { mode: "full", players: [{ name: "A", id: "a" }, { name: "B", id: "b" }] }, true, t0 + 60_000);
  closeAllActiveSessions(stats, t0 + 120_000);
  assert.equal(Object.keys(stats.active).length, 0);
  assert.equal(stats.players.a.totalMs, 60_000);
  assert.equal(stats.players.b.totalMs, 60_000);
});

test("buildPlayerViews exposes online and leaderboard sorted", () => {
  const stats = freshStats();
  stats.players = {
    a: { name: "A", totalMs: 10_000, sessions: 1, firstSeenAt: null, lastSeenAt: null },
    b: { name: "B", totalMs: 50_000, sessions: 2, firstSeenAt: null, lastSeenAt: null }
  };
  stats.active = { a: { name: "A", startedAt: Date.now() - 5_000, lastSeenAt: Date.now() } };
  const views = buildPlayerViews(stats, Date.now());
  assert.equal(views.online[0].name, "A");
  assert.equal(views.leaderboard[0].name, "B");
});

test("playerKeyFor prefers display name over id", () => {
  assert.equal(playerKeyFor({ name: "Couplarity", id: "abc-uuid-123" }), "couplarity");
  assert.equal(playerKeyFor({ name: "  IronGod777  " }), "irongod777");
  assert.equal(playerKeyFor({ id: "FALLBACK" }), "fallback");
  assert.equal(playerKeyFor({}), "");
});

test("mergeDuplicatePlayerKeys folds UUID-keyed records into name-keyed ones", () => {
  const stats = ensureServerStats({}, "s1");
  // Simulate state from older builds: same player tracked under two keys.
  stats.players = {
    couplarity: {
      name: "Couplarity", totalMs: 4_500_000, sessions: 3,
      firstSeenAt: "2026-04-01T00:00:00.000Z", lastSeenAt: "2026-04-29T00:00:00.000Z"
    },
    "abc-uuid-123": {
      name: "Couplarity", totalMs: 78_000, sessions: 1,
      firstSeenAt: "2026-04-30T00:00:00.000Z", lastSeenAt: "2026-04-30T00:01:18.000Z"
    },
    "deadbeef-uuid": {
      name: "IronGod777", totalMs: 0, sessions: 0,
      firstSeenAt: "2026-04-30T00:00:00.000Z", lastSeenAt: "2026-04-30T00:00:00.000Z"
    },
    irongod777: {
      name: "IronGod777", totalMs: 200_000_000, sessions: 12,
      firstSeenAt: "2026-04-01T00:00:00.000Z", lastSeenAt: "2026-04-29T00:00:00.000Z"
    }
  };
  mergeDuplicatePlayerKeys(stats);
  assert.equal(Object.keys(stats.players).length, 2);
  assert.ok(stats.players.couplarity);
  assert.ok(stats.players.irongod777);
  assert.equal(stats.players.couplarity.totalMs, 4_500_000 + 78_000);
  assert.equal(stats.players.couplarity.sessions, 4);
  assert.equal(stats.players.irongod777.totalMs, 200_000_000);
  assert.equal(stats.players.irongod777.sessions, 12);
  // firstSeenAt is the earlier of the merged pair
  assert.equal(stats.players.couplarity.firstSeenAt, "2026-04-01T00:00:00.000Z");
  // lastSeenAt is the later of the merged pair
  assert.equal(stats.players.couplarity.lastSeenAt, "2026-04-30T00:01:18.000Z");
});

test("mergeDuplicatePlayerKeys is idempotent", () => {
  const stats = ensureServerStats({}, "s1");
  stats.players = { foo: { name: "Foo", totalMs: 1000, sessions: 1 } };
  mergeDuplicatePlayerKeys(stats);
  mergeDuplicatePlayerKeys(stats);
  assert.equal(stats.players.foo.totalMs, 1000);
  assert.equal(Object.keys(stats.players).length, 1);
});

test("ensureServerStats runs the migration on every load", () => {
  const playerStats = {
    servers: {
      s1: {
        players: {
          "uuid-x": { name: "Alice", totalMs: 500, sessions: 1 },
          alice: { name: "Alice", totalMs: 1500, sessions: 2 }
        },
        active: {},
        importedSessions: {}
      }
    }
  };
  const stats = ensureServerStats(playerStats, "s1");
  assert.equal(Object.keys(stats.players).length, 1);
  assert.equal(stats.players.alice.totalMs, 2000);
  assert.equal(stats.players.alice.sessions, 3);
});

test("closeStaleSessions only closes sessions past idle threshold", () => {
  const stats = freshStats();
  const t0 = 3_000_000_000_000;
  stats.active = {
    fresh: { name: "Fresh", startedAt: t0 - 1000, lastSeenAt: t0 - 1000 },
    stale: { name: "Stale", startedAt: t0 - 1_000_000, lastSeenAt: t0 - 1_000_000 }
  };
  stats.players = {
    fresh: { name: "Fresh", totalMs: 0, sessions: 1, firstSeenAt: null, lastSeenAt: null },
    stale: { name: "Stale", totalMs: 0, sessions: 1, firstSeenAt: null, lastSeenAt: null }
  };
  closeStaleSessions(stats, t0, 60_000);
  assert.ok(stats.active.fresh);
  assert.ok(!stats.active.stale);
});
