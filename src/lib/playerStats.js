"use strict";

const fs = require("fs");
const path = require("path");

function loadPlayerStats(statsPath) {
  try {
    if (fs.existsSync(statsPath)) {
      const parsed = JSON.parse(fs.readFileSync(statsPath, "utf8"));
      if (parsed.servers) return parsed;
      return {
        servers: {
          default: {
            players: parsed.players || {},
            active: parsed.active || {},
            importedSessions: parsed.importedSessions || {},
            lastUpdatedAt: parsed.lastUpdatedAt || null
          }
        },
        history: parsed.history || {}
      };
    }
  } catch (error) {
    console.warn(`Could not load ${statsPath}: ${error.message}`);
  }
  return { servers: {}, history: {} };
}

function ensureServerStats(playerStats, serverId) {
  if (!playerStats.servers) playerStats.servers = {};
  if (!playerStats.servers[serverId]) {
    playerStats.servers[serverId] = {
      players: {},
      active: {},
      importedSessions: {},
      logBackfill: null,
      lastUpdatedAt: null
    };
  }
  const stats = playerStats.servers[serverId];
  if (!stats.players) stats.players = {};
  if (!stats.active) stats.active = {};
  if (!stats.importedSessions) stats.importedSessions = {};
  return stats;
}

function closeSession(stats, key, fallbackEndTime) {
  const active = stats.active[key];
  if (!active) return;
  const endTime = active.lastSeenAt || fallbackEndTime;
  const duration = Math.max(0, endTime - active.startedAt);
  const record = stats.players[key] || {
    name: active.name,
    totalMs: 0,
    sessions: 0,
    firstSeenAt: new Date(active.startedAt).toISOString(),
    lastSeenAt: null
  };
  record.totalMs += duration;
  record.lastSeenAt = new Date(endTime).toISOString();
  stats.players[key] = record;
  delete stats.active[key];
}

function closeAllActiveSessions(stats, now) {
  for (const key of Object.keys(stats.active)) closeSession(stats, key, now);
  stats.lastUpdatedAt = new Date(now).toISOString();
}

function closeStaleSessions(stats, now, maxIdleMs) {
  for (const [key, active] of Object.entries(stats.active)) {
    if (!active.lastSeenAt) continue;
    if (now - active.lastSeenAt > maxIdleMs) closeSession(stats, key, active.lastSeenAt);
  }
}

function updatePlayerDurations(stats, observed, serverOnline, now, options = {}) {
  if (!serverOnline) {
    closeAllActiveSessions(stats, now);
    return;
  }
  if (observed.mode === "none") {
    if (options.staleIdleMs) closeStaleSessions(stats, now, options.staleIdleMs);
    return;
  }

  const seenKeys = new Set();
  for (const player of observed.players) {
    const key = (player.id || player.name || "").trim().toLowerCase();
    if (!key) continue;
    seenKeys.add(key);
    const existing = stats.players[key] || {
      name: player.name,
      totalMs: 0,
      sessions: 0,
      firstSeenAt: new Date(now).toISOString(),
      lastSeenAt: null
    };
    existing.name = player.name || existing.name;
    existing.lastSeenAt = new Date(now).toISOString();
    stats.players[key] = existing;

    if (!stats.active[key]) {
      stats.active[key] = {
        name: existing.name,
        startedAt: now,
        lastSeenAt: now
      };
      existing.sessions += 1;
    } else {
      stats.active[key].name = existing.name;
      stats.active[key].lastSeenAt = now;
    }
  }

  if (observed.mode === "full") {
    for (const key of Object.keys(stats.active)) {
      if (!seenKeys.has(key)) closeSession(stats, key, now);
    }
  } else if (options.staleIdleMs) {
    closeStaleSessions(stats, now, options.staleIdleMs);
  }

  stats.lastUpdatedAt = new Date(now).toISOString();
}

function buildPlayerViews(stats, now) {
  const online = Object.entries(stats.active)
    .map(([key, active]) => {
      const record = stats.players[key] || { totalMs: 0, sessions: 0 };
      const currentMs = Math.max(0, now - active.startedAt);
      return {
        key,
        name: active.name,
        currentSessionMs: currentMs,
        totalMs: record.totalMs + currentMs,
        sessions: record.sessions,
        startedAt: new Date(active.startedAt).toISOString(),
        lastSeenAt: new Date(active.lastSeenAt).toISOString()
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const leaderboard = Object.entries(stats.players)
    .map(([key, record]) => {
      const active = stats.active[key];
      const currentMs = active ? Math.max(0, now - active.startedAt) : 0;
      return {
        key,
        name: record.name,
        totalMs: record.totalMs + currentMs,
        sessions: record.sessions,
        firstSeenAt: record.firstSeenAt,
        lastSeenAt: active ? new Date(active.lastSeenAt).toISOString() : record.lastSeenAt,
        online: Boolean(active)
      };
    })
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, 100);

  return { online, leaderboard };
}

function createPersister(statsPath, getPayload) {
  let dirty = false;
  let writing = false;
  let queued = false;

  fs.mkdirSync(path.dirname(statsPath), { recursive: true });

  async function write() {
    writing = true;
    queued = false;
    dirty = false;
    const tempPath = `${statsPath}.tmp`;
    try {
      const payload = getPayload();
      await fs.promises.writeFile(tempPath, JSON.stringify(payload, null, 2));
      await fs.promises.rename(tempPath, statsPath);
    } catch (error) {
      console.warn(`Could not save ${statsPath}: ${error.message}`);
    } finally {
      writing = false;
      if (queued) write();
    }
  }

  function markDirty() {
    dirty = true;
    if (writing) {
      queued = true;
      return;
    }
    write();
  }

  function flushSync() {
    if (!dirty && !writing) return;
    try {
      fs.writeFileSync(statsPath, JSON.stringify(getPayload(), null, 2));
      dirty = false;
    } catch (error) {
      console.warn(`Could not flush ${statsPath}: ${error.message}`);
    }
  }

  return { markDirty, flushSync };
}

module.exports = {
  loadPlayerStats,
  ensureServerStats,
  closeSession,
  closeAllActiveSessions,
  closeStaleSessions,
  updatePlayerDurations,
  buildPlayerViews,
  createPersister
};
