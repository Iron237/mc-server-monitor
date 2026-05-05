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
  serverGrid: document.querySelector("#serverGrid"),
  selectedTitle: document.querySelector("#selectedTitle"),
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
let selectedServerId = null;

elements.refreshButton.addEventListener("click", () => fetchStatus(true));
window.addEventListener("resize", () => {
  const selected = getSelectedServer();
  if (selected) drawHistory(selected.history || []);
});

fetchStatus(false);

async function fetchStatus(manual) {
  if (manual) elements.refreshButton.disabled = true;
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    latestPayload = payload;
    if (!selectedServerId && payload.servers.length) selectedServerId = payload.servers[0].id;
    if (!payload.servers.some((item) => item.id === selectedServerId) && payload.servers.length) {
      selectedServerId = payload.servers[0].id;
    }
    render(payload);
    scheduleRefresh(payload.pollIntervalMs);
  } catch (error) {
    renderError(error);
    scheduleRefresh(10000);
  } finally {
    elements.refreshButton.disabled = false;
  }
}

function scheduleRefresh(intervalMs) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => fetchStatus(false), Math.max(5000, intervalMs || 15000));
}

function render(payload) {
  const selected = getSelectedServer();
  const system = payload.resources.system || {};
  const summary = payload.summary || { servers: 0, onlineServers: 0, playersOnline: 0 };

  elements.appName.textContent = payload.app.name || "服务器集群状态";
  elements.targetAddress.textContent = payload.servers.map((item) => `${item.name} ${item.config.host}:${item.config.port}`).join(" · ");
  elements.statusPill.classList.toggle("online", summary.onlineServers > 0);
  elements.statusPill.classList.toggle("offline", summary.onlineServers === 0);
  elements.statusText.textContent = `${summary.onlineServers}/${summary.servers} 在线`;

  elements.onlineMetric.textContent = `${summary.onlineServers}/${summary.servers}`;
  elements.motdMetric.textContent = selected ? `${selected.name}: ${selected.server.motd || selected.server.error || "无 MOTD"}` : "没有服务器";
  elements.latencyMetric.textContent = selected && selected.server.latencyMs !== null ? `${selected.server.latencyMs} ms` : "--";
  elements.connectionMetric.textContent = selected && selected.server.online
    ? `最近成功 ${formatDateTime(selected.connection.lastSuccessAt)}`
    : selected ? `失败 ${selected.connection.consecutiveFailures} 次` : "--";

  elements.playersMetric.textContent = `${summary.playersOnline}`;
  elements.trackingMetric.textContent = selected ? trackingText(selected.tracking) : "--";
  elements.resourceMetric.textContent = percentText(system.cpuPercent);
  elements.memoryMetric.textContent = `内存 ${percentText(system.memoryUsedPercent)}`;

  renderServerCards(payload.servers);
  renderSelected(selected, payload);
}

function renderServerCards(servers) {
  elements.serverGrid.innerHTML = servers.map((item) => {
    const count = Number.isFinite(item.server.playersOnline) ? item.server.playersOnline : item.players.online.length;
    const max = Number.isFinite(item.server.playersMax) ? item.server.playersMax : null;
    return `
      <button class="server-card ${item.id === selectedServerId ? "selected" : ""}" data-server-id="${escapeHtml(item.id)}">
        <span class="server-card-top">
          <strong>${escapeHtml(item.name)}</strong>
          <span class="mini-status ${item.server.online ? "online" : "offline"}">${item.server.online ? "在线" : "离线"}</span>
        </span>
        <span>${escapeHtml(item.config.host)}:${item.config.port}</span>
        <span>玩家 ${max === null ? count : `${count}/${max}`} · 延迟 ${item.server.latencyMs === null ? "--" : `${item.server.latencyMs} ms`}</span>
        <span>资源 ${escapeHtml(item.resources.selector || "none")}</span>
      </button>
    `;
  }).join("");

  elements.serverGrid.querySelectorAll(".server-card").forEach((button) => {
    button.addEventListener("click", () => {
      selectedServerId = button.dataset.serverId;
      render(latestPayload);
    });
  });
}

function renderSelected(selected, payload) {
  if (!selected) return;
  const system = payload.resources.system || {};
  const players = selected.players || { online: [], leaderboard: [] };

  elements.selectedTitle.textContent = `${selected.name} 连接趋势`;
  elements.versionLine.textContent = selected.server.version
    ? `${selected.server.version}${selected.server.protocol ? ` · protocol ${selected.server.protocol}` : ""}`
    : "暂无版本信息";
  elements.updatedAt.textContent = selected.lastUpdatedAt ? `更新 ${formatDateTime(selected.lastUpdatedAt)}` : "等待更新";

  renderResources(payload, selected);
  renderPlayers(players, selected.tracking, selected.server.playersOnline || 0);
  drawHistory(selected.history || []);

  elements.hostLine.textContent = system.hostname
    ? `${system.hostname} · ${system.platform} · ${selected.resources.selector}`
    : `资源识别：${selected.resources.selector}`;
}

function renderResources(payload, selected) {
  const system = payload.resources.system || {};
  setBar(elements.cpuValue, elements.cpuBar, system.cpuPercent);
  setBar(elements.ramValue, elements.ramBar, system.memoryUsedPercent);

  const disk = system.disk;
  if (disk && Number.isFinite(disk.usedPercent)) {
    setBar(elements.diskValue, elements.diskBar, disk.usedPercent);
  } else {
    elements.diskValue.textContent = disk && disk.error ? "不可用" : "--";
    elements.diskBar.style.width = "0%";
  }

  const processes = selected.resources.processes || [];
  if (!processes.length) {
    elements.processList.innerHTML = `<div class="empty">未找到匹配进程：${escapeHtml(selected.resources.selector || "none")}</div>`;
    return;
  }

  const totalMemory = processes.reduce((sum, item) => sum + (Number.isFinite(item.memoryBytes) ? item.memoryBytes : 0), 0);
  const totalCpu = processes.reduce((sum, item) => sum + (Number.isFinite(item.cpuPercent) ? item.cpuPercent : 0), 0);
  elements.processList.innerHTML = `
    <div class="process-item">
      <strong>匹配进程 ${processes.length} 个</strong>
      <div class="process-meta">CPU ${percentText(totalCpu)} · 内存 ${formatBytes(totalMemory)}</div>
    </div>
    ${processes.map((process) => `
      <div class="process-item">
        <strong>${escapeHtml(process.name)} · PID ${process.pid}</strong>
        <div class="process-meta">
          CPU ${percentText(process.cpuPercent)} · 内存 ${formatBytes(process.memoryBytes)}
        </div>
      </div>
    `).join("")}
  `;
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
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function getSelectedServer() {
  if (!latestPayload) return null;
  return latestPayload.servers.find((item) => item.id === selectedServerId) || latestPayload.servers[0] || null;
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
  if (!tracking) return "--";
  if (tracking.accuracy === "full") return "完整玩家列表";
  if (tracking.accuracy === "partial") return "样本统计";
  if (tracking.accuracy === "count-only") return "仅人数";
  return "未统计";
}

function formatDateTime(value) {
  if (!value) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0 分钟";
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  return `${minutes} 分钟`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "--";
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
