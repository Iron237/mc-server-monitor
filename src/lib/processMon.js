"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");

const { round, percent } = require("./util");

const previousProcessSamples = new Map();
let previousCpuSnapshot = null;

function sampleCpuPercent() {
  const snapshot = os.cpus().map((cpu) => ({ ...cpu.times }));
  if (!previousCpuSnapshot) {
    previousCpuSnapshot = snapshot;
    return null;
  }

  let idle = 0;
  let total = 0;
  for (let index = 0; index < snapshot.length; index += 1) {
    const current = snapshot[index];
    const previous = previousCpuSnapshot[index] || current;
    const currentTotal = Object.values(current).reduce((sum, value) => sum + value, 0);
    const previousTotal = Object.values(previous).reduce((sum, value) => sum + value, 0);
    idle += current.idle - previous.idle;
    total += currentTotal - previousTotal;
  }
  previousCpuSnapshot = snapshot;
  return total > 0 ? round(100 - percent(idle, total), 1) : null;
}

function sampleDiskUsage(targetPath) {
  if (typeof fs.statfsSync !== "function") return null;
  try {
    const stats = fs.statfsSync(targetPath);
    const total = stats.blocks * stats.bsize;
    const free = stats.bavail * stats.bsize;
    const used = total - free;
    return {
      path: targetPath,
      total,
      used,
      free,
      usedPercent: percent(used, total)
    };
  } catch (error) {
    return { path: targetPath, error: error.message };
  }
}

function sampleDiskUsages(paths) {
  const seen = new Set();
  const results = [];
  for (const candidate of paths) {
    if (!candidate) continue;
    const key = String(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    const sample = sampleDiskUsage(candidate);
    if (sample) results.push(sample);
  }
  return results;
}

async function collectSystemResources(diskPaths) {
  const memoryTotal = os.totalmem();
  const memoryFree = os.freemem();
  const memoryUsed = memoryTotal - memoryFree;
  const cpu = sampleCpuPercent();
  const disks = sampleDiskUsages(diskPaths);

  return {
    collectedAt: new Date().toISOString(),
    system: {
      platform: `${os.platform()} ${os.release()}`,
      hostname: os.hostname(),
      uptimeSeconds: os.uptime(),
      loadAverage: os.loadavg(),
      cpuPercent: cpu,
      cpuCount: os.cpus().length,
      memoryTotal,
      memoryUsed,
      memoryFree,
      memoryUsedPercent: percent(memoryUsed, memoryTotal),
      disk: disks[0] || null,
      disks
    }
  };
}

function findPidsByListeningPorts(ports) {
  const unique = [...new Set(ports.map(Number).filter((p) => Number.isFinite(p) && p > 0))];
  if (!unique.length) return Promise.resolve(new Map());
  if (os.platform() === "win32") {
    return findWindowsPidsByPorts(unique);
  }
  return findUnixPidsByPorts(unique);
}

function findWindowsPidsByPorts(ports) {
  return new Promise((resolve) => {
    const portList = ports.join(",");
    const command = [
      "$ErrorActionPreference='SilentlyContinue';",
      `$ports=@(${portList});`,
      "$rows=Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort } | Select-Object LocalPort,OwningProcess;",
      "if($rows){$rows | ConvertTo-Json -Compress}"
    ].join(" ");
    childProcess.execFile("powershell.exe", ["-NoProfile", "-Command", command], { timeout: 5000, windowsHide: true }, (error, stdout) => {
      const result = new Map();
      if (error || !stdout.trim()) {
        resolve(result);
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        for (const row of rows) {
          const port = Number(row.LocalPort);
          const pid = Number(row.OwningProcess);
          if (!Number.isFinite(port) || !Number.isFinite(pid)) continue;
          if (!result.has(port)) result.set(port, []);
          if (!result.get(port).includes(pid)) result.get(port).push(pid);
        }
      } catch { /* ignore */ }
      resolve(result);
    });
  });
}

function findUnixPidsByPorts(ports) {
  return new Promise((resolve) => {
    const result = new Map();
    let pending = ports.length;
    if (!pending) { resolve(result); return; }
    for (const port of ports) {
      childProcess.execFile("sh", ["-c",
        `lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null || ss -ltnp 2>/dev/null | awk '/:${port} / {print $NF}' | sed -n 's/.*pid=\\([0-9][0-9]*\\).*/\\1/p'`
      ], { timeout: 3000 }, (error, stdout) => {
        if (!error || stdout.trim()) {
          const pids = [...new Set(stdout.trim().split(/\s+/).map(Number).filter(Number.isFinite))];
          if (pids.length) result.set(port, pids);
        }
        pending -= 1;
        if (pending === 0) resolve(result);
      });
    }
  });
}

function collectProcessesByPids(pids) {
  const unique = [...new Set(pids.map(Number).filter(Number.isFinite))];
  if (!unique.length) return Promise.resolve([]);
  if (os.platform() === "win32") {
    return runWindowsProcessCommand(`Get-Process -Id ${unique.join(",")}`);
  }
  return new Promise((resolve) => {
    childProcess.execFile("ps", ["-p", unique.join(","), "-o", "pid=,comm=,pcpu=,rss=,etime="], { timeout: 3000 }, (error, stdout) => {
      if (error || !stdout.trim()) { resolve([]); return; }
      resolve(parseUnixProcessRows(stdout));
    });
  });
}

function collectProcessesByNames(names) {
  const unique = [...new Set(names.filter(Boolean))];
  if (!unique.length) return Promise.resolve(new Map());
  if (os.platform() === "win32") {
    return new Promise((resolve) => {
      const list = unique.map((name) => JSON.stringify(name)).join(",");
      const command = [
        "$ErrorActionPreference='SilentlyContinue';",
        `$names=@(${list});`,
        "$rows=Get-Process -Name $names -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,CPU,WorkingSet64,PrivateMemorySize64,StartTime;",
        "if($rows){$rows | ConvertTo-Json -Compress}"
      ].join(" ");
      childProcess.execFile("powershell.exe", ["-NoProfile", "-Command", command], { timeout: 5000, windowsHide: true }, (error, stdout) => {
        const result = new Map();
        if (error || !stdout.trim()) { resolve(result); return; }
        try {
          const parsed = JSON.parse(stdout);
          const rows = Array.isArray(parsed) ? parsed : [parsed];
          for (const row of rows) {
            const sample = normalizeWindowsProcessSample(row);
            if (!result.has(sample.name)) result.set(sample.name, []);
            result.get(sample.name).push(sample);
          }
        } catch { /* ignore */ }
        resolve(result);
      });
    });
  }
  return new Promise((resolve) => {
    const result = new Map();
    let pending = unique.length;
    for (const name of unique) {
      childProcess.execFile("ps", ["-C", name, "-o", "pid=,comm=,pcpu=,rss=,etime="], { timeout: 3000 }, (error, stdout) => {
        if (!error && stdout.trim()) {
          result.set(name, parseUnixProcessRows(stdout));
        }
        pending -= 1;
        if (pending === 0) resolve(result);
      });
    }
  });
}

function runWindowsProcessCommand(selector) {
  return new Promise((resolve) => {
    const command = [
      "$ErrorActionPreference='SilentlyContinue';",
      `$items=${selector} | Select-Object Id,ProcessName,CPU,WorkingSet64,PrivateMemorySize64,StartTime;`,
      "if($items){$items | ConvertTo-Json -Compress}"
    ].join(" ");
    childProcess.execFile("powershell.exe", ["-NoProfile", "-Command", command], { timeout: 5000, windowsHide: true }, (error, stdout) => {
      if (error || !stdout.trim()) { resolve([]); return; }
      try {
        const parsed = JSON.parse(stdout);
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        resolve(rows.map(normalizeWindowsProcessSample));
      } catch { resolve([]); }
    });
  });
}

function normalizeWindowsProcessSample(row) {
  return normalizeProcessSample({
    pid: row.Id,
    name: row.ProcessName,
    cpuSeconds: Number(row.CPU || 0),
    memoryBytes: Number(row.WorkingSet64 || 0),
    privateMemoryBytes: Number(row.PrivateMemorySize64 || 0),
    startedAt: row.StartTime || null
  });
}

function parseUnixProcessRows(stdout) {
  return stdout.trim().split(/\r?\n/).map((line) => {
    const parts = line.trim().split(/\s+/);
    return normalizeProcessSample({
      pid: Number(parts[0]),
      name: parts[1],
      cpuPercent: Number(parts[2]),
      memoryBytes: Number(parts[3]) * 1024,
      privateMemoryBytes: null,
      startedAt: parts.slice(4).join(" ")
    });
  });
}

function normalizeProcessSample(sample) {
  const now = Date.now();
  const previous = previousProcessSamples.get(sample.pid);
  let cpuPercent = Number.isFinite(sample.cpuPercent) ? sample.cpuPercent : null;
  if (previous && Number.isFinite(sample.cpuSeconds)) {
    const cpuDelta = sample.cpuSeconds - previous.cpuSeconds;
    const wallDelta = (now - previous.sampledAt) / 1000;
    if (wallDelta > 0 && cpuDelta >= 0) {
      cpuPercent = round((cpuDelta / wallDelta / os.cpus().length) * 100, 1);
    }
  }
  if (Number.isFinite(sample.cpuSeconds)) {
    previousProcessSamples.set(sample.pid, { cpuSeconds: sample.cpuSeconds, sampledAt: now });
  }
  return {
    pid: sample.pid,
    name: sample.name,
    cpuPercent,
    cpuSeconds: Number.isFinite(sample.cpuSeconds) ? sample.cpuSeconds : null,
    memoryBytes: sample.memoryBytes,
    privateMemoryBytes: sample.privateMemoryBytes,
    startedAt: sample.startedAt
  };
}

async function collectAllServerProcesses(serverConfigs) {
  const result = new Map();
  const portConfigs = serverConfigs.filter((cfg) => !cfg.pid && cfg.processPort);
  const pidConfigs = serverConfigs.filter((cfg) => cfg.pid);
  const nameConfigs = serverConfigs.filter((cfg) => !cfg.pid && !cfg.processPort && cfg.processName);

  const portToPids = portConfigs.length
    ? await findPidsByListeningPorts(portConfigs.map((cfg) => cfg.processPort))
    : new Map();

  const allPids = new Set(pidConfigs.map((cfg) => cfg.pid));
  for (const pids of portToPids.values()) {
    for (const pid of pids) allPids.add(pid);
  }

  const pidProcesses = allPids.size
    ? await collectProcessesByPids([...allPids])
    : [];
  const pidMap = new Map(pidProcesses.map((proc) => [proc.pid, proc]));

  const nameMap = nameConfigs.length
    ? await collectProcessesByNames(nameConfigs.map((cfg) => cfg.processName))
    : new Map();

  for (const cfg of serverConfigs) {
    let processes = [];
    if (cfg.pid) {
      const proc = pidMap.get(cfg.pid);
      if (proc) processes = [proc];
    } else if (cfg.processPort && portToPids.has(cfg.processPort)) {
      processes = portToPids.get(cfg.processPort)
        .map((pid) => pidMap.get(pid))
        .filter(Boolean);
    } else if (cfg.processName) {
      processes = nameMap.get(cfg.processName) || [];
    }
    processes.sort((a, b) => (b.cpuPercent || 0) - (a.cpuPercent || 0) || (b.memoryBytes || 0) - (a.memoryBytes || 0));
    result.set(cfg.id, processes);
  }
  return result;
}

module.exports = {
  collectSystemResources,
  collectAllServerProcesses,
  sampleCpuPercent,
  sampleDiskUsage,
  sampleDiskUsages
};
