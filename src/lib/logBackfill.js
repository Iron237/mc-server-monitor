"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const { minIso, maxIso } = require("./util");

const sessionCache = new Map();

function listLogFiles(logPath, maxFiles) {
  const resolved = path.resolve(logPath);
  const stat = fs.statSync(resolved);
  const files = stat.isDirectory()
    ? fs.readdirSync(resolved)
      .filter((name) => /\.(log|txt|log\.gz)$/i.test(name))
      .map((name) => path.join(resolved, name))
    : [resolved];

  return files
    .map((filePath) => {
      const fileStat = fs.statSync(filePath);
      return {
        path: filePath,
        name: path.basename(filePath),
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxFiles)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
}

function readLogFile(filePath) {
  const content = fs.readFileSync(filePath);
  if (/\.gz$/i.test(filePath)) {
    return zlib.gunzipSync(content).toString("utf8");
  }
  return content.toString("utf8");
}

function parsePlayerLogEvent(line) {
  const loggedIn = line.match(/\b([A-Za-z0-9_]{3,16})(?:\[[^\]]+\])?\s+logged in with entity id\b/);
  if (loggedIn) return { action: "join", player: loggedIn[1] };
  const join = line.match(/\b([A-Za-z0-9_]{3,16}) joined the game\b/);
  if (join) return { action: "join", player: join[1] };
  const lostConnection = line.match(/\b([A-Za-z0-9_]{3,16}) lost connection:/);
  if (lostConnection) return { action: "left", player: lostConnection[1] };
  const left = line.match(/\b([A-Za-z0-9_]{3,16}) left the game\b/);
  if (left) return { action: "left", player: left[1] };
  return null;
}

// Vanilla / NeoForge death message phrases. Order matters within an
// alternation: longer / more specific phrases must come before their prefix
// matches (e.g. "was killed by magic" before "was killed by"). The full
// message tail (with killer / context) is preserved as `cause`.
const DEATH_PHRASES = [
  "was burnt to a crisp whilst fighting",
  "was killed while trying to hurt",
  "was knocked into the void by",
  "was frozen to death by",
  "was poked to death by a sweet berry bush",
  "didn't want to live in the same world as",
  "didnt want to live in the same world as",
  "fell from a high place",
  "fell out of the world",
  "discovered the floor was lava",
  "experienced kinetic energy",
  "tried to swim in lava",
  "was blown up by",
  "was burnt to a crisp",
  "was struck by lightning",
  "was doomed to fall by",
  "was doomed to fall",
  "was knocked into the void",
  "was killed by magic",
  "was killed by",
  "was slain by",
  "was shot by",
  "was squashed by",
  "was impaled by",
  "was stung to death",
  "was pricked to death",
  "was squished too much",
  "was squished by",
  "was impaled on a stalagmite",
  "was impaled",
  "walked into a cactus while trying to escape",
  "walked into a cactus",
  "walked into fire whilst fighting",
  "walked into fire",
  "went up in flames",
  "burned to death",
  "froze to death",
  "starved to death",
  "suffocated in a wall",
  "withered away",
  "hit the ground too hard",
  "drowned",
  "blew up",
  "died"
];

function parsePlayerDeathEvent(line) {
  // Skip chat (always shown with angle-bracketed name) and the join / leave /
  // connect events the session parser already owns.
  if (/<[A-Za-z0-9_]{3,16}>/.test(line)) return null;
  if (/joined the game|left the game|lost connection|logged in with entity id/.test(line)) return null;

  // Trim down to the message body. Server logs prefix lines with one or more
  // "[...]" segments terminated by "]:". We anchor on the last such marker so
  // timestamps and thread/category labels can never masquerade as a player.
  let body = line;
  const colonIdx = line.lastIndexOf("]:");
  if (colonIdx !== -1) body = line.slice(colonIdx + 2);
  body = body.trim();

  const m = body.match(/^([A-Za-z0-9_]{3,16})\s+(.+)$/);
  if (!m) return null;
  const player = m[1];
  const tail = m[2];
  for (const phrase of DEATH_PHRASES) {
    if (tail.startsWith(phrase)) {
      return { action: "death", player, cause: tail };
    }
  }
  return null;
}

function toMillis(value) {
  if (!value) return 0;
  return Number(String(value).padEnd(3, "0").slice(0, 3));
}

function monthIndex(value) {
  const months = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
  };
  const key = String(value || "").slice(0, 3).toLowerCase();
  return Object.prototype.hasOwnProperty.call(months, key) ? months[key] : null;
}

function parseLogTimestamp(line, fallbackDate) {
  const iso = line.match(/\[(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?/);
  if (iso) {
    return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), Number(iso[4]), Number(iso[5]), Number(iso[6]), toMillis(iso[7]));
  }

  const named = line.match(/\[(\d{1,2})([A-Za-z]{3})(\d{4})\s+(\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?/);
  if (named) {
    const month = monthIndex(named[2]);
    if (month !== null) {
      return new Date(Number(named[3]), month, Number(named[1]), Number(named[4]), Number(named[5]), Number(named[6]), toMillis(named[7]));
    }
  }

  const chineseCompact = line.match(/\[(\d{1,2})(\d{1,2})月(\d{4})\s+(\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?/);
  if (chineseCompact) {
    return new Date(Number(chineseCompact[3]), Number(chineseCompact[2]) - 1, Number(chineseCompact[1]), Number(chineseCompact[4]), Number(chineseCompact[5]), Number(chineseCompact[6]), toMillis(chineseCompact[7]));
  }

  const chineseCompactNoMarker = line.match(/\[(\d{3,4})(\d{4})\s+(\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?/);
  if (chineseCompactNoMarker) {
    const dayMonth = chineseCompactNoMarker[1];
    const day = Number(dayMonth.slice(0, 2));
    const month = Number(dayMonth.slice(2));
    if (month >= 1 && month <= 12) {
      return new Date(Number(chineseCompactNoMarker[2]), month - 1, day, Number(chineseCompactNoMarker[3]), Number(chineseCompactNoMarker[4]), Number(chineseCompactNoMarker[5]), toMillis(chineseCompactNoMarker[6]));
    }
  }

  const timeOnly = line.match(/\[(\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?\]/);
  if (timeOnly && fallbackDate) {
    return new Date(fallbackDate.getFullYear(), fallbackDate.getMonth(), fallbackDate.getDate(), Number(timeOnly[1]), Number(timeOnly[2]), Number(timeOnly[3]), toMillis(timeOnly[4]));
  }

  return null;
}

function dateFromLogFileName(name) {
  const isoMatch = String(name).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
  }
  const chineseNamed = String(name).match(/(\d{4})(\d{1,2})月(\d{1,2})/);
  if (chineseNamed) {
    return new Date(Number(chineseNamed[1]), Number(chineseNamed[2]) - 1, Number(chineseNamed[3]));
  }
  return null;
}

function fileCacheKey(file) {
  return `${file.path}|${file.size}|${file.mtimeMs}`;
}

// Per-file path → most recent cacheKey, so we can evict the previous entry
// when a file (typically `latest.log`) changes size / mtime. Without this,
// every poll inserts a fresh entry for `latest.log`, the historical
// `.log.gz` archives eventually fall off the LRU end, and the next poll
// re-reads + gunzips dozens of MB. Old behavior leaked ~5 MB/s of heap.
const sessionCacheKeyByPath = new Map();

// Force a fresh allocation so V8 doesn't keep a multi-MB parent string
// alive through a tiny substring (`String#match` / `slice` results in V8
// can be sliced strings that retain their parent until GC visits them).
function detach(s) {
  return s == null ? s : (" " + s).slice(1);
}

function parseFileSessions(file) {
  const cacheKey = fileCacheKey(file);
  const cached = sessionCache.get(cacheKey);
  if (cached) return cached;

  // Drop any prior cache entry for the same path before we add the new one.
  // This bounds the cache at "one entry per source file" — no LRU churn.
  const previousKey = sessionCacheKeyByPath.get(file.path);
  if (previousKey && previousKey !== cacheKey) {
    sessionCache.delete(previousKey);
  }

  const fallbackDate = dateFromLogFileName(file.name) || new Date(file.mtimeMs);
  const text = readLogFile(file.path);
  const events = [];
  let previousTimestamp = null;
  let dayOffsetMs = 0;
  for (const line of text.split(/\r?\n/)) {
    const sessionEvent = parsePlayerLogEvent(line);
    const deathEvent = sessionEvent ? null : parsePlayerDeathEvent(line);
    const event = sessionEvent || deathEvent;
    if (!event) continue;
    const timestamp = parseLogTimestamp(line, fallbackDate);
    if (!timestamp) continue;
    if (previousTimestamp && timestamp.getTime() + dayOffsetMs < previousTimestamp - 12 * 60 * 60 * 1000) {
      dayOffsetMs += 24 * 60 * 60 * 1000;
    }
    const eventTime = timestamp.getTime() + dayOffsetMs;
    previousTimestamp = eventTime;
    const record = {
      player: detach(event.player),
      action: event.action,
      eventTime,
      // Only keep light file metadata, not a reference to the file object
      // (which Node may keep alive longer than necessary inside the closure).
      sourceFile: file.name,
      sourcePath: file.path
    };
    if (event.action === "death") record.cause = detach(event.cause);
    events.push(record);
  }
  // Hard ceiling as a safety net for setups with thousands of files. With
  // the per-path eviction above we expect ≤ logBackfillMaxFiles entries.
  if (sessionCache.size > 512) {
    const oldestKey = sessionCache.keys().next().value;
    sessionCache.delete(oldestKey);
  }
  sessionCache.set(cacheKey, events);
  sessionCacheKeyByPath.set(file.path, cacheKey);
  return events;
}

function parseLogSessions(files) {
  const openSessions = new Map();
  const completed = [];
  for (const file of files) {
    const events = parseFileSessions(file);
    for (const event of events) {
      if (event.action !== "join" && event.action !== "left") continue;
      const playerKey = event.player.toLowerCase();
      if (event.action === "join") {
        openSessions.set(playerKey, {
          playerKey,
          playerName: event.player,
          startAt: event.eventTime,
          source: file.name,
          sourceFile: file.name,
          sourcePath: file.path
        });
        continue;
      }
      const open = openSessions.get(playerKey);
      if (!open) continue;
      completed.push({
        ...open,
        playerName: event.player,
        endAt: event.eventTime,
        source: `${open.source} -> ${file.name}`,
        sourceFile: file.name,
        sourcePath: file.path,
        sourceFiles: [...new Set([open.sourceFile, file.name])]
      });
      openSessions.delete(playerKey);
    }
  }
  return completed;
}

function parseLogDeaths(files) {
  const deaths = [];
  for (const file of files) {
    const events = parseFileSessions(file);
    for (const event of events) {
      if (event.action !== "death") continue;
      deaths.push({
        playerKey: event.player.toLowerCase(),
        playerName: event.player,
        eventTime: event.eventTime,
        cause: event.cause,
        sourceFile: file.name,
        sourcePath: file.path
      });
    }
  }
  return deaths;
}

function sessionKey(session) {
  return `${session.playerKey}:${session.startAt}:${session.endAt}`;
}

function deathKey(death) {
  return `${death.playerKey}:${death.eventTime}`;
}

function summarizeLogFiles(files, sessions, stats) {
  const summaries = new Map(files.map((file) => [file.name, {
    name: file.name,
    path: file.path,
    size: file.size,
    mtime: new Date(file.mtimeMs).toISOString(),
    parsedSessions: 0,
    importedSessions: 0,
    pendingSessions: 0,
    synced: true
  }]));

  for (const session of sessions) {
    const key = sessionKey(session);
    const imported = Boolean(stats.importedSessions && stats.importedSessions[key]);
    const sourceFiles = session.sourceFiles || [session.sourceFile].filter(Boolean);
    for (const fileName of sourceFiles) {
      const summary = summaries.get(fileName);
      if (!summary) continue;
      summary.parsedSessions += 1;
      if (imported) summary.importedSessions += 1;
      else summary.pendingSessions += 1;
    }
  }

  for (const summary of summaries.values()) {
    summary.synced = summary.pendingSessions === 0;
  }

  return [...summaries.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function emptyBackfill(serverConfig) {
  return {
    enabled: Boolean(serverConfig.logBackfillEnabled),
    path: serverConfig.logPath || null,
    ok: true,
    importedSessions: 0,
    importedMs: 0,
    scannedFiles: 0,
    parsedSessions: 0,
    files: [],
    lastImportedAt: null,
    error: null
  };
}

function importLogBackfill(serverId, serverConfig, stats, now, options = {}) {
  if (!serverConfig.logBackfillEnabled || !serverConfig.logPath) {
    return emptyBackfill(serverConfig);
  }

  const startedAt = Date.now();
  if (!stats.importedSessions) stats.importedSessions = {};
  if (!stats.importedDeaths) stats.importedDeaths = {};
  if (!stats.deaths) stats.deaths = {};

  try {
    const files = listLogFiles(serverConfig.logPath, serverConfig.logBackfillMaxFiles);
    const sessions = parseLogSessions(files);
    let importedSessions = 0;
    let importedMs = 0;

    for (const session of sessions) {
      const key = sessionKey(session);
      if (stats.importedSessions[key]) continue;
      const duration = session.endAt - session.startAt;
      const maxDuration = serverConfig.logBackfillMaxSessionHours * 60 * 60 * 1000;
      if (duration <= 0 || duration > maxDuration) continue;
      if (options.dryRun) continue;

      const record = stats.players[session.playerKey] || {
        name: session.playerName,
        totalMs: 0,
        sessions: 0,
        firstSeenAt: new Date(session.startAt).toISOString(),
        lastSeenAt: null
      };
      record.name = session.playerName;
      record.totalMs += duration;
      record.sessions += 1;
      record.firstSeenAt = minIso(record.firstSeenAt, session.startAt);
      record.lastSeenAt = maxIso(record.lastSeenAt, session.endAt);
      stats.players[session.playerKey] = record;
      stats.importedSessions[key] = {
        player: session.playerName,
        startAt: new Date(session.startAt).toISOString(),
        endAt: new Date(session.endAt).toISOString(),
        durationMs: duration,
        source: session.source
      };
      importedSessions += 1;
      importedMs += duration;
    }

    let importedDeaths = 0;
    let parsedDeaths = 0;
    if (serverConfig.deathTrackingEnabled) {
      const deaths = parseLogDeaths(files);
      parsedDeaths = deaths.length;
      for (const death of deaths) {
        const key = deathKey(death);
        if (stats.importedDeaths[key]) continue;
        if (options.dryRun) continue;

        const record = stats.deaths[death.playerKey] || {
          name: death.playerName,
          count: 0,
          firstAt: new Date(death.eventTime).toISOString(),
          lastAt: null,
          lastCause: null
        };
        record.name = death.playerName;
        record.count += 1;
        record.firstAt = minIso(record.firstAt, death.eventTime);
        // Always keep the most recent cause as the "headline".
        if (!record.lastAt || new Date(record.lastAt).getTime() <= death.eventTime) {
          record.lastAt = new Date(death.eventTime).toISOString();
          record.lastCause = death.cause;
        }
        stats.deaths[death.playerKey] = record;
        stats.importedDeaths[key] = {
          player: death.playerName,
          at: new Date(death.eventTime).toISOString(),
          cause: death.cause,
          source: death.sourceFile
        };
        importedDeaths += 1;
      }
    }

    const result = {
      enabled: true,
      path: serverConfig.logPath,
      ok: true,
      mode: options.dryRun ? "scan" : options.force ? "manual" : "auto",
      importedSessions,
      importedMs,
      importedDeaths,
      parsedDeaths,
      deathTrackingEnabled: Boolean(serverConfig.deathTrackingEnabled),
      scannedFiles: files.length,
      parsedSessions: sessions.length,
      files: summarizeLogFiles(files, sessions, stats),
      durationMs: Date.now() - startedAt,
      lastImportedAt: (importedSessions > 0 || importedDeaths > 0) ? new Date(now).toISOString() : stats.logBackfill?.lastImportedAt || null,
      error: null
    };
    stats.logBackfill = result;
    if (!options.dryRun) {
      stats.lastUpdatedAt = new Date(now).toISOString();
    }
    return result;
  } catch (error) {
    const result = {
      enabled: true,
      path: serverConfig.logPath,
      ok: false,
      importedSessions: 0,
      importedMs: 0,
      scannedFiles: 0,
      parsedSessions: 0,
      files: [],
      durationMs: Date.now() - startedAt,
      lastImportedAt: stats.logBackfill?.lastImportedAt || null,
      error: error.message
    };
    stats.logBackfill = result;
    return result;
  }
}

function clearSessionCache() {
  sessionCache.clear();
  sessionCacheKeyByPath.clear();
}

module.exports = {
  listLogFiles,
  parsePlayerLogEvent,
  parsePlayerDeathEvent,
  parseLogTimestamp,
  parseLogSessions,
  parseLogDeaths,
  parseFileSessions,
  dateFromLogFileName,
  monthIndex,
  sessionKey,
  deathKey,
  summarizeLogFiles,
  importLogBackfill,
  emptyBackfill,
  clearSessionCache,
  DEATH_PHRASES
};
