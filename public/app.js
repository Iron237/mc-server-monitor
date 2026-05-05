"use strict";

const elements = {
  appName: document.querySelector("#appName"),
  targetAddress: document.querySelector("#targetAddress"),
  statusPill: document.querySelector("#statusPill"),
  statusText: document.querySelector("#statusText"),
  refreshButton: document.querySelector("#refreshButton"),
  onlineMetric: document.querySelector("#onlineMetric"),
  motdMetric: document.querySelector("#motdMetric"),
  latencyMetric: document.querySelector("#latencyMetric"),
  connectionMetric: document.querySelector("#connectionMetric"),
  playersMetric: document.querySelector("#playersMetric"),
  trackingMetric: document.querySelector("#trackingMetric"),
  resourceMetric: document.querySelector("#resourceMetric"),
  memoryMetric: document.querySelector("#memoryMetric"),
  versionLine: document.querySelector("#versionLine"),
  updatedAt: document.querySelector("#updatedAt"),
  hostLine: document.querySelector("#hostLine"),
  cpuValue: document.querySelector("#cpuValue"),
  cpuBar: document.querySelector("#cpuBar"),
  ramValue: document.querySelector("#ramValue"),
  ramBar: document.querySelector("#ramBar"),
  diskValue: document.querySelector("#diskValue"),
  diskBar: document.querySelector("#diskBar"),
  processList: document.querySelector("#processList"),
  onlinePlayersLine: document.querySelector("#onlinePlayersLine"),
  onlinePlayersTable: document.querySelector("#onlinePlayersTable"),
  leaderboardLine: document.querySelector("#leaderboardLine"),
  leaderboard: document.querySelector("#leaderboard"),
  historyChart: document.querySelector("#historyChart")
};

let refreshTimer = null;
let latestPayload = null;

elements.refreshButton.addEventListener("click", () => fetchStatus(true));
window.addEventListener("resize", () => {
  if (latestPayload) {
    drawHistory(latestPayload.history || []);
  }
});

fetchStatus(false);

async function fetchStatus(manual) {
  if (manual) {
    elements.refreshButton.disabled = true;
  }
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    latestPayload = payload;
    render(payload);
    scheduleRefresh(payload.target.pollIntervalMs);
  } catch (error) {
    renderError(error);
    scheduleRefresh(10000);
  } finally {
    elements.refreshButton.disabled = false;
  }
}

function scheduleRefresh(intervalMs) {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }
  refreshTimer = setTimeout(() => fetchStatus(false), Math.max(5000, intervalMs || 15000));
}

function render(payload) {
  const server = payload.server;
  const target = payload.target;
  const resources = payload.resources || {};
  const system = resources.system || {};
  const players = payload.players || { online: [], leaderboard: [] };

  elements.appName.textContent = payload.app.name || "服务器状态";
  elements.targetAddress.textContent = `${target.host}:${target.port}`;
  elements.statusPill.classList.toggle("online", server.online);
  elements.statusPill.classList.toggle("offline", !server.online);
  elements.statusText.textContent = server.online ? "在线" : "离线";

  elements.onlineMetric.textContent = server.online ? "在线" : "离线";
  elements.motdMetric.textContent = server.motd || server.error || "无 MOTD";
  elements.latencyMetric.textContent = server.latencyMs === null ? "--" : `${server.latencyMs} ms`;
  elements.connectionMetric.textContent = server.online
    ? `最近成功 ${formatDateTime(payload.connection.lastSuccessAt)}`
    : `失败 ${payload.connection.consecutiveFailures} 次`;

  const count = Number.isFinite(server.playersOnline) ? server.playersOnline : players.online.length;
  const max = Number.isFinite(server.playersMax) ? server.playersMax : null;
  elements.playersMetric.textContent = max === null ? `${count ?? "--"}` : `${count}/${max}`;
  elements.trackingMetric.textContent = trackingText(payload.tracking);

  elements.resourceMetric.textContent = percentText(system.cpuPercent);
  elements.memoryMetric.textContent = `内存 ${percentText(system.memoryUsedPercent)}`;
  elements.versionLine.textContent = server.version
    ? `${server.version}${server.protocol ? ` · protocol ${server.protocol}` : ""}`
    : "暂无版本信息";
  elements.updatedAt.textContent = payload.lastUpdatedAt
    ? `更新 ${formatDateTime(payload.lastUpdatedAt)}`
    : "等待更新";

  renderResources(payload);
  renderPlayers(players, payload.tracking, count);
  drawHistory(payload.history || []);
}

function renderResources(payload) {
  const system = payload.resources.system || {};
  elements.hostLine.textContent = system.hostname
    ? `${system.hostname} · ${system.platform}`
    : "等待资源采样";

  setBar(elements.cpuValue, elements.cpuBar, system.cpuPercent);
  setBar(elements.ramValue, elements.ramBar, system.memoryUsedPercent);

  const disk = system.disk;
  if (disk && Number.isFinite(disk.usedPercent)) {
    setBar(elements.diskValue, elements.diskBar, disk.usedPercent);
  } else {
    elements.diskValue.textContent = disk && disk.error ? "不可用" : "--";
    elements.diskBar.style.width = "0%";
  }

  const processes = payload.resources.processes || [];
  if (!processes.length) {
    const processName = payload.target.processName;
    elements.processList.innerHTML = processName
      ? `<div class="empty">未找到进程：${escapeHtml(processName)}</div>`
      : `<div class="empty">未配置进程名</div>`;
    return;
  }

  elements.processList.innerHTML = processes.map((process) => `
    <div class="process-item">
      <strong>${escapeHtml(process.name)} · PID ${process.pid}</strong>
      <div class="process-meta">
        CPU ${percentText(process.cpuPercent)} · 内存 ${formatBytes(process.memoryBytes)}
      </div>
    </div>
  `).join("");
}

function renderPlayers(players, tracking, reportedCount) {
  elements.onlinePlayersLine.textContent = `${players.online.length} 名已识别 · ${trackingText(tracking)}`;

  if (!players.online.length) {
    const message = reportedCount > 0
      ? "服务器有玩家在线，但当前协议没有返回玩家名"
      : "暂无在线玩家";
    elements.onlinePlayersTable.innerHTML = `<tr><td colspan="4">${message}</td></tr>`;
  } else {
    elements.onlinePlayersTable.innerHTML = players.online.map((player) => `
      <tr>
        <td><span class="player-name">${escapeHtml(player.name)}</span></td>
        <td>${formatDuration(player.currentSessionMs)}</td>
        <td>${formatDuration(player.totalMs)}</td>
        <td>${player.sessions}</td>
      </tr>
    `).join("");
  }

  elements.leaderboardLine.textContent = players.leaderboard.length
    ? `记录 ${players.leaderboard.length} 名玩家`
    : "暂无累计数据";

  if (!players.leaderboard.length) {
    elements.leaderboard.innerHTML = `<div class="empty">等待在线时长数据</div>`;
    return;
  }

  elements.leaderboard.innerHTML = players.leaderboard.slice(0, 10).map((player, index) => `
    <div class="leaderboard-item">
      <span class="rank">${index + 1}</span>
      <span class="leaderboard-name">${escapeHtml(player.name)}${player.online ? " · 在线" : ""}</span>
      <span class="leaderboard-time">${formatDuration(player.totalMs)}</span>
    </div>
  `).join("");
}

function drawHistory(history) {
  const canvas = elements.historyChart;
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight || 190;
  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);

  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const padding = { left: 42, right: 16, top: 18, bottom: 28 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  ctx.strokeStyle = "#dbe3df";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let index = 0; index <= 4; index += 1) {
    const y = padding.top + (plotHeight / 4) * index;
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
  }
  ctx.stroke();

  ctx.fillStyle = "#61706a";
  ctx.font = "12px Segoe UI, Microsoft YaHei, Arial";
  ctx.fillText("玩家", 8, padding.top + 4);
  ctx.fillText("延迟", 8, padding.top + 22);

  if (history.length < 2) {
    ctx.fillStyle = "#61706a";
    ctx.fillText("等待趋势数据", padding.left + 12, padding.top + 30);
    return;
  }

  const maxPlayers = Math.max(1, ...history.map((point) => point.playersMax || point.playersOnline || 0));
  const maxLatency = Math.max(100, ...history.map((point) => point.latencyMs || 0));
  const xFor = (index) => padding.left + (plotWidth * index) / Math.max(1, history.length - 1);
  const yForPlayers = (value) => padding.top + plotHeight - (plotHeight * (value || 0)) / maxPlayers;
  const yForLatency = (value) => padding.top + plotHeight - (plotHeight * Math.min(value || 0, maxLatency)) / maxLatency;

  drawLine(ctx, history, xFor, (point) => yForPlayers(point.playersOnline), "#1c8f5a");
  drawLine(ctx, history, xFor, (point) => yForLatency(point.latencyMs), "#2864b4");

  const latest = history[history.length - 1];
  ctx.fillStyle = "#17201b";
  ctx.fillText(`玩家 ${latest.playersOnline ?? "--"}`, padding.left, height - 9);
  ctx.fillText(`延迟 ${latest.latencyMs ?? "--"} ms`, padding.left + 92, height - 9);
}

function drawLine(ctx, history, xFor, yFor, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  history.forEach((point, index) => {
    const x = xFor(index);
    const y = yFor(point);
    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();
}

function renderError(error) {
  elements.statusPill.classList.remove("online");
  elements.statusPill.classList.add("offline");
  elements.statusText.textContent = "页面连接失败";
  elements.motdMetric.textContent = error.message;
}

function setBar(valueElement, barElement, value) {
  valueElement.textContent = percentText(value);
  const width = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  barElement.style.width = `${width}%`;
  barElement.classList.toggle("warn", width >= 70 && width < 88);
  barElement.classList.toggle("hot", width >= 88);
}

function trackingText(tracking) {
  if (!tracking) {
    return "--";
  }
  if (tracking.accuracy === "full") {
    return "完整玩家列表";
  }
  if (tracking.accuracy === "partial") {
    return "样本统计";
  }
  if (tracking.accuracy === "count-only") {
    return "仅人数";
  }
  return "未统计";
}

function formatDateTime(value) {
  if (!value) {
    return "--";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "0 分钟";
  }
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return `${days} 天 ${hours} 小时`;
  }
  if (hours > 0) {
    return `${hours} 小时 ${minutes} 分钟`;
  }
  return `${minutes} 分钟`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "--";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function percentText(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : "--";
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
