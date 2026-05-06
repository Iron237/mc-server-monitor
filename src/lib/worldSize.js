"use strict";

const fs = require("fs");
const path = require("path");

// Recursively sum up the byte size of `worldPath`. Skips symlinks (no `du -L`
// behaviour) so a misconfigured symlink loop can't hang the sampler. Designed
// to be cheap to run hourly even on >50 GB worlds — a single readdir + stat
// pass with sequential I/O.
async function measureDirectorySize(rootPath) {
  const stack = [rootPath];
  let totalBytes = 0;
  let fileCount = 0;
  let dirCount = 0;
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      if (error.code === "EACCES" || error.code === "EPERM") continue;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(full);
        dirCount += 1;
        continue;
      }
      if (entry.isFile()) {
        try {
          const stat = await fs.promises.stat(full);
          totalBytes += stat.size;
          fileCount += 1;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    }
  }
  return { bytes: totalBytes, files: fileCount, directories: dirCount };
}

// Per-server scheduler: only walks again when intervalMs has elapsed since
// the last successful sample, so a 15s poll loop does not actually `du`
// every 15s on a 60 GB world.
function createWorldSizeSampler({ intervalMs = 60 * 60 * 1000, historyLimit = 240 }) {
  const lastSampleAt = new Map();   // serverId -> ms
  const inflight = new Set();       // serverId currently sampling
  const histories = new Map();      // serverId -> [{ at, bytes, files, directories }]

  function loadHistory(serverId, history) {
    if (Array.isArray(history) && history.length) {
      histories.set(serverId, history.slice(-historyLimit));
    }
  }

  function getHistory(serverId) {
    return histories.get(serverId) || [];
  }

  function getLatest(serverId) {
    const list = histories.get(serverId);
    return list && list.length ? list[list.length - 1] : null;
  }

  function shouldSample(serverId, now) {
    if (inflight.has(serverId)) return false;
    const last = lastSampleAt.get(serverId) || 0;
    return now - last >= intervalMs;
  }

  async function sample(serverId, worldPath, now) {
    if (!worldPath) return null;
    if (!shouldSample(serverId, now)) return getLatest(serverId);
    inflight.add(serverId);
    try {
      const result = await measureDirectorySize(worldPath);
      const point = {
        at: new Date(now).toISOString(),
        bytes: result.bytes,
        files: result.files,
        directories: result.directories
      };
      const list = histories.get(serverId) || [];
      list.push(point);
      if (list.length > historyLimit) list.splice(0, list.length - historyLimit);
      histories.set(serverId, list);
      lastSampleAt.set(serverId, now);
      return point;
    } catch (error) {
      lastSampleAt.set(serverId, now);
      return { at: new Date(now).toISOString(), error: error.message };
    } finally {
      inflight.delete(serverId);
    }
  }

  // Linear regression on the last `windowMs` of (timestamp, bytes) samples to
  // estimate growth rate (bytes/day) and a rough days-until-full prediction
  // when given current free disk bytes.
  function projectGrowth(serverId, windowMs = 7 * 24 * 60 * 60 * 1000, freeBytes = null) {
    const list = histories.get(serverId);
    if (!list || list.length < 2) return null;
    const cutoff = Date.now() - windowMs;
    const points = list.filter((p) => p.bytes != null && new Date(p.at).getTime() >= cutoff);
    if (points.length < 2) return null;
    const t0 = new Date(points[0].at).getTime();
    let sumX = 0;
    let sumY = 0;
    let sumXX = 0;
    let sumXY = 0;
    for (const p of points) {
      const x = (new Date(p.at).getTime() - t0) / (24 * 60 * 60 * 1000); // days from t0
      const y = p.bytes;
      sumX += x;
      sumY += y;
      sumXX += x * x;
      sumXY += x * y;
    }
    const n = points.length;
    const denom = n * sumXX - sumX * sumX;
    if (denom === 0) return null;
    const slope = (n * sumXY - sumX * sumY) / denom; // bytes per day
    const projection = {
      bytesPerDay: slope,
      windowSamples: n,
      currentBytes: points[points.length - 1].bytes
    };
    if (freeBytes != null && slope > 0) {
      projection.daysUntilFull = freeBytes / slope;
    }
    return projection;
  }

  return { sample, getHistory, getLatest, projectGrowth, loadHistory };
}

module.exports = { createWorldSizeSampler, measureDirectorySize };
