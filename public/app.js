"use strict";

const $ = (sel) => document.querySelector(sel);
const elements = {
  appName: $("#appName"),
  targetAddress: $("#targetAddress"),
  statusPill: $("#statusPill"),
  statusText: $("#statusText"),
  refreshButton: $("#refreshButton"),
  themeButton: $("#themeButton"),
  langButton: $("#langButton"),
  onlineMetric: $("#onlineMetric"),
  motdMetric: $("#motdMetric"),
  latencyMetric: $("#latencyMetric"),
  connectionMetric: $("#connectionMetric"),
  playersMetric: $("#playersMetric"),
  trackingMetric: $("#trackingMetric"),
  resourceMetric: $("#resourceMetric"),
  memoryMetric: $("#memoryMetric"),
  serverGrid: $("#serverGrid"),
  selectedTitle: $("#selectedTitle"),
  versionLine: $("#versionLine"),
  updatedAt: $("#updatedAt"),
  hostLine: $("#hostLine"),
  cpuValue: $("#cpuValue"),
  cpuBar: $("#cpuBar"),
  ramValue: $("#ramValue"),
  ramBar: $("#ramBar"),
  diskGroup: $("#diskGroup"),
  diskValue: $("#diskValue"),
  diskBar: $("#diskBar"),
  tpsLine: $("#tpsLine"),
  processList: $("#processList"),
  onlinePlayersLine: $("#onlinePlayersLine"),
  syncLogsButton: $("#syncLogsButton"),
  backfillBox: $("#backfillBox"),
  onlinePlayersTable: $("#onlinePlayersTable"),
  leaderboardLine: $("#leaderboardLine"),
  leaderboard: $("#leaderboard"),
  historyChart: $("#historyChart")
};

let refreshTimer = null;
let resizeTimer = null;
let latestPayload = null;
let combinedLeaderboard = null;
let selectedServerId = null;
let leaderboardMode = localStorage.getItem("mc-board") || "server";
let sse = null;

initTheme();
window.applyI18n();
elements.refreshButton.addEventListener("click", () => fetchStatus(true));
elements.themeButton.addEventListener("click", cycleTheme);
elements.langButton.addEventListener("click", () => { window.toggleLang(); render(latestPayload); });
elements.syncLogsButton.addEventListener("click", () => syncSelectedLogs());
document.querySelectorAll(".seg-btn").forEach((btn) => {
  if (btn.dataset.board === leaderboardMode) btn.classList.add("selected"); else btn.classList.remove("selected");
  btn.addEventListener("click", () => {
    leaderboardMode = btn.dataset.board;
    localStorage.setItem("mc-board", leaderboardMode);
    document.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("selected", b === btn));
    if (leaderboardMode === "combined") fetchCombinedLeaderboard();
    render(latestPayload);
  });
});
window.addEventListener("resize", () => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const selected = getSelectedServer();
    if (selected) drawHistory(selected.history || []);
  }, 80);
});

fetchStatus(false).then(() => connectSse());

function connectSse() {
  if (typeof EventSource === "undefined") return;
  try {
    sse = new EventSource("/api/events");
    sse.addEventListener("status", (event) => {
      try {
        const payload = JSON.parse(event.data);
        latestPayload = payload;
        ensureSelectedServer(payload);
        render(payload);
      } catch { /* ignore */ }
    });
    sse.addEventListener("server", (event) => {
      try {
        const data = JSON.parse(event.data);
        if (!latestPayload) return;
        const idx = latestPayload.servers.findIndex((s) => s.id === data.id);
        if (idx >= 0) latestPayload.servers[idx] = data.server;
        render(latestPayload);
      } catch { /* ignore */ }
    });
    sse.onerror = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => fetchStatus(false), 5000);
    };
  } catch { /* SSE optional */ }
}

async function fetchStatus(manual) {
  if (manual) elements.refreshButton.disabled = true;
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (response.status === 401) {
      renderUnauthorized();
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    latestPayload = payload;
    ensureSelectedServer(payload);
    render(payload);
    scheduleRefresh(payload.pollIntervalMs);
  } catch (error) {
    renderError(error);
    scheduleRefresh(10000);
  } finally {
    elements.refreshButton.disabled = false;
  }
}

async function fetchCombinedLeaderboard() {
  try {
    const response = await fetch("/api/leaderboard", { cache: "no-store" });
    if (!response.ok) return;
    combinedLeaderboard = await response.json();
    render(latestPayload);
  } catch { /* ignore */ }
}

function ensureSelectedServer(payload) {
  if (!payload || !payload.servers) return;
  if (!selectedServerId && payload.servers.length) selectedServerId = payload.servers[0].id;
  if (!payload.servers.some((item) => item.id === selectedServerId) && payload.servers.length) {
    selectedServerId = payload.servers[0].id;
  }
}

async function syncSelectedLogs() {
  const selected = getSelectedServer();
  if (!selected) return;
  elements.syncLogsButton.disabled = true;
  elements.syncLogsButton.textContent = window.t("syncing");
  try {
    const response = await fetch(`/api/backfill/${encodeURIComponent(selected.id)}`, {
      method: "POST",
      cache: "no-store"
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    selected.backfill = payload.backfill;
    selected.players = payload.players;
    render(latestPayload);
  } catch (error) {
    elements.backfillBox.replaceChildren(emptyDiv(window.t("syncFailed", { msg: error.message })));
  } finally {
    elements.syncLogsButton.disabled = false;
    elements.syncLogsButton.textContent = window.t("syncLogs");
  }
}

function scheduleRefresh(intervalMs) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => fetchStatus(false), Math.max(5000, intervalMs || 15000));
}

function render(payload) {
  if (!payload) return;
  const selected = getSelectedServer();
  const system = (payload.resources && payload.resources.system) || {};
  const summary = payload.summary || { servers: 0, onlineServers: 0, playersOnline: 0 };

  elements.appName.textContent = payload.app.name || window.t("title");
  elements.targetAddress.textContent = payload.servers.map((item) => `${item.name} ${item.config.host}:${item.config.port}`).join(" · ");
  elements.statusPill.classList.toggle("online", summary.onlineServers > 0);
  elements.statusPill.classList.toggle("offline", summary.onlineServers === 0);
  elements.statusText.textContent = `${summary.onlineServers}/${summary.servers} ${window.t("onlineSlash")}`;

  elements.onlineMetric.textContent = `${summary.onlineServers}/${summary.servers}`;
  elements.motdMetric.textContent = selected ? `${selected.name}: ${selected.server.motd || selected.server.error || window.t("noMotd")}` : window.t("noServers");
  elements.latencyMetric.textContent = selected && selected.server.latencyMs !== null ? `${selected.server.latencyMs} ms` : "--";
  elements.connectionMetric.textContent = selected && selected.server.online
    ? `${window.t("lastSuccess")} ${formatDateTime(selected.connection.lastSuccessAt)}`
    : selected ? window.t("failures", { n: selected.connection.consecutiveFailures }) : "--";

  elements.playersMetric.textContent = `${summary.playersOnline}`;
  elements.trackingMetric.textContent = selected ? trackingText(selected.tracking) : "--";
  elements.resourceMetric.textContent = percentText(system.cpuPercent);
  elements.memoryMetric.textContent = `${window.t("memoryLabel")} ${percentText(system.memoryUsedPercent)}`;

  renderServerCards(payload.servers);
  renderSelected(selected, payload);
}

function renderServerCards(servers) {
  const existing = new Map();
  for (const child of elements.serverGrid.children) {
    if (child.dataset && child.dataset.serverId) existing.set(child.dataset.serverId, child);
  }
  const seen = new Set();
  servers.forEach((item) => {
    seen.add(item.id);
    let card = existing.get(item.id);
    if (!card) {
      card = document.createElement("button");
      card.type = "button";
      card.className = "server-card";
      card.dataset.serverId = item.id;
      card.addEventListener("click", () => {
        selectedServerId = item.id;
        render(latestPayload);
      });
      const top = el("span", "server-card-top",
        el("strong", "", document.createTextNode("")),
        el("span", "mini-status", document.createTextNode(""))
      );
      card.append(
        top,
        el("span", "card-host"),
        el("span", "card-players"),
        el("span", "card-resource")
      );
      elements.serverGrid.appendChild(card);
    }
    card.classList.toggle("selected", item.id === selectedServerId);
    const top = card.firstElementChild;
    top.firstElementChild.textContent = item.name;
    const status = top.lastElementChild;
    status.textContent = item.server.online ? window.t("online") : window.t("offline");
    status.className = "mini-status " + (item.server.online ? "online" : "offline");
    const [, host, players, res] = card.children;
    host.textContent = `${item.config.host}:${item.config.port}`;
    const count = Number.isFinite(item.server.playersOnline) ? item.server.playersOnline : item.players.online.length;
    const max = Number.isFinite(item.server.playersMax) ? item.server.playersMax : null;
    players.textContent = `${window.t("player")} ${max === null ? count : `${count}/${max}`} · ${item.server.latencyMs === null ? "--" : `${item.server.latencyMs} ms`}`;
    res.textContent = `${window.t("resourceMode", { sel: item.resources.selector || "none" })}`;
  });
  for (const [id, node] of existing) {
    if (!seen.has(id)) node.remove();
  }
}

function renderSelected(selected, payload) {
  if (!selected) return;
  const system = (payload.resources && payload.resources.system) || {};
  const players = selected.players || { online: [], leaderboard: [] };

  elements.selectedTitle.textContent = `${selected.name} ${window.t("trendTitle")}`;
  elements.versionLine.textContent = selected.server.version
    ? `${selected.server.version}${selected.server.protocol ? ` · protocol ${selected.server.protocol}` : ""}`
    : window.t("noVersion");
  elements.updatedAt.textContent = selected.lastUpdatedAt ? window.t("updateAt", { t: formatDateTime(selected.lastUpdatedAt) }) : window.t("waitingUpdate");

  renderResources(payload, selected);
  renderTps(selected.tps);
  renderPlayers(players, selected.tracking, selected.server.playersOnline || 0);
  renderBackfill(selected);
  renderLeaderboard(selected, players);
  drawHistory(selected.history || []);

  elements.hostLine.textContent = system.hostname
    ? `${system.hostname} · ${system.platform} · ${selected.resources.selector}`
    : window.t("resourceMode", { sel: selected.resources.selector });
}

function renderResources(payload, selected) {
  const system = (payload.resources && payload.resources.system) || {};
  setBar(elements.cpuValue, elements.cpuBar, system.cpuPercent);
  setBar(elements.ramValue, elements.ramBar, system.memoryUsedPercent);

  const disks = Array.isArray(system.disks) && system.disks.length ? system.disks : (system.disk ? [system.disk] : []);
  if (disks.length === 0) {
    elements.diskValue.textContent = "--";
    elements.diskBar.style.width = "0%";
  } else {
    const primary = disks.find((d) => d.path === selected.config.worldPath || d.path === selected.config.logPath) || disks[0];
    if (primary && Number.isFinite(primary.usedPercent)) {
      setBar(elements.diskValue, elements.diskBar, primary.usedPercent);
      elements.diskGroup.title = primary.path || "";
    } else {
      elements.diskValue.textContent = primary && primary.error ? "n/a" : "--";
      elements.diskBar.style.width = "0%";
    }
  }

  const processes = selected.resources.processes || [];
  if (!processes.length) {
    elements.processList.replaceChildren(emptyDiv(window.t("noProcs", { sel: selected.resources.selector || "none" })));
    return;
  }

  const totalMemory = processes.reduce((sum, item) => sum + (Number.isFinite(item.memoryBytes) ? item.memoryBytes : 0), 0);
  const totalCpu = processes.reduce((sum, item) => sum + (Number.isFinite(item.cpuPercent) ? item.cpuPercent : 0), 0);
  const items = [
    el("div", "process-item",
      el("strong", "", document.createTextNode(window.t("matchedProcs", { n: processes.length }))),
      el("div", "process-meta", document.createTextNode(`CPU ${percentText(totalCpu)} · ${window.t("memoryLabel")} ${formatBytes(totalMemory)}`))
    ),
    ...processes.map((process) => el("div", "process-item",
      el("strong", "", document.createTextNode(`${process.name} · PID ${process.pid}`)),
      el("div", "process-meta", document.createTextNode(`CPU ${percentText(process.cpuPercent)} · ${window.t("memoryLabel")} ${formatBytes(process.memoryBytes)}`))
    ))
  ];
  elements.processList.replaceChildren(...items);
}

function renderTps(tps) {
  if (!tps || !tps.ok) {
    elements.tpsLine.textContent = "";
    elements.tpsLine.classList.remove("show");
    return;
  }
  elements.tpsLine.classList.add("show");
  const fmt = (n) => Number.isFinite(n) ? n.toFixed(1) : "--";
  elements.tpsLine.textContent = `${window.t("tps")} 1m ${fmt(tps.tps1m)} · 5m ${fmt(tps.tps5m)} · 15m ${fmt(tps.tps15m)}`;
}

function renderBackfill(selected) {
  const backfill = selected.backfill || {};
  elements.syncLogsButton.disabled = !backfill.enabled;
  if (!backfill.enabled) {
    elements.backfillBox.replaceChildren(emptyDiv(window.t("backfillDisabled")));
    return;
  }

  if (!backfill.ok) {
    elements.backfillBox.replaceChildren(
      el("div", "backfill-summary",
        el("span", "", document.createTextNode(window.t("logPathLabel", { p: backfill.path || "--" }))),
        el("span", "log-status error", document.createTextNode(window.t("failedShort")))
      ),
      emptyDiv(backfill.error || window.t("cantReadLogs"))
    );
    return;
  }

  const files = backfill.files || [];
  const summary = el("div", "backfill-summary",
    el("span", "", document.createTextNode(window.t("logPathLabel", { p: backfill.path || "--" }))),
    el("span", "", document.createTextNode(window.t("files", { n: backfill.scannedFiles || 0, parsed: backfill.parsedSessions || 0, imported: backfill.importedSessions || 0 })))
  );

  if (!files.length) {
    elements.backfillBox.replaceChildren(summary, emptyDiv(window.t("noLogsScanned")));
    return;
  }

  const list = el("div", "log-list", ...files.map((file) => el("div", "log-item",
    el("div", "",
      el("div", "log-name", document.createTextNode(file.name)),
      el("div", "log-meta", document.createTextNode(window.t("sessionsLabel", {
        parsed: file.parsedSessions, imported: file.importedSessions, pending: file.pendingSessions, t: formatDateTime(file.mtime)
      })))
    ),
    el("span", `log-status ${file.synced ? "" : "pending"}`, document.createTextNode(window.t(file.synced ? "synced" : "pending")))
  )));

  const pending = files.filter((f) => !f.synced).length;
  const footer = el("div", "backfill-summary",
    el("span", "", document.createTextNode(pending === 0 ? window.t("logsAllSynced") : window.t("logsPending", { n: pending }))),
    el("span", "", document.createTextNode(backfill.lastImportedAt ? window.t("lastImported", { t: formatDateTime(backfill.lastImportedAt) }) : window.t("notImported")))
  );

  elements.backfillBox.replaceChildren(summary, list, footer);
}

function renderPlayers(players, tracking, reportedCount) {
  const selected = getSelectedServer();
  let backfillSuffix = "";
  if (selected && selected.backfill && selected.backfill.enabled) {
    const body = selected.backfill.ok
      ? window.t("backfillRound", { n: selected.backfill.importedSessions || 0 })
      : window.t("backfillFailed");
    backfillSuffix = window.t("backfillSuffix", { body });
  }
  elements.onlinePlayersLine.textContent = window.t("onlineCountTrack", {
    n: players.online.length,
    tracking: trackingText(tracking)
  }) + backfillSuffix;

  if (!players.online.length) {
    const message = reportedCount > 0 ? window.t("serverHasPlayersNoNames") : window.t("noOnline");
    elements.onlinePlayersTable.replaceChildren(rowSpan(4, message));
    return;
  }

  elements.onlinePlayersTable.replaceChildren(...players.online.map((player) => el("tr", "",
    el("td", "", el("span", "player-name", document.createTextNode(player.name))),
    el("td", "", document.createTextNode(formatDuration(player.currentSessionMs))),
    el("td", "", document.createTextNode(formatDuration(player.totalMs))),
    el("td", "", document.createTextNode(String(player.sessions)))
  )));
}

function renderLeaderboard(selected, players) {
  let board = players.leaderboard || [];
  if (leaderboardMode === "combined" && combinedLeaderboard) board = combinedLeaderboard;

  elements.leaderboardLine.textContent = board.length
    ? window.t("leaderboardCount", { n: board.length })
    : window.t("noLeaderboard");

  if (!board.length) {
    elements.leaderboard.replaceChildren(emptyDiv(window.t("waitingDuration")));
    return;
  }

  elements.leaderboard.replaceChildren(...board.slice(0, 10).map((player, index) => el("div", "leaderboard-item",
    el("span", "rank", document.createTextNode(String(index + 1))),
    el("span", "leaderboard-name", document.createTextNode(player.name + (player.online ? ` · ${window.t("online")}` : ""))),
    el("span", "leaderboard-time", document.createTextNode(formatDuration(player.totalMs)))
  )));
}

function drawHistory(history) {
  const canvas = elements.historyChart;
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight || 210;
  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);

  const styles = getComputedStyle(document.documentElement);
  const lineColor = styles.getPropertyValue("--line").trim() || "#dbe3df";
  const muted = styles.getPropertyValue("--muted").trim() || "#61706a";
  const text = styles.getPropertyValue("--text").trim() || "#17201b";
  const green = styles.getPropertyValue("--green").trim() || "#1c8f5a";
  const blue = styles.getPropertyValue("--blue").trim() || "#2864b4";

  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const padding = { left: 50, right: 50, top: 22, bottom: 28 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let index = 0; index <= 4; index += 1) {
    const y = padding.top + (plotHeight / 4) * index;
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
  }
  ctx.stroke();

  ctx.fillStyle = muted;
  ctx.font = "12px Segoe UI, Microsoft YaHei, Arial";
  ctx.fillText(window.t("chartPlayers"), 6, padding.top - 4);
  ctx.textAlign = "right";
  ctx.fillText(window.t("chartLatency"), width - 6, padding.top - 4);
  ctx.textAlign = "left";

  if (history.length < 2) {
    ctx.fillStyle = muted;
    ctx.fillText(window.t("waitingTrend"), padding.left + 12, padding.top + plotHeight / 2);
    return;
  }

  const maxPlayers = Math.max(1, ...history.map((point) => point.playersMax || point.playersOnline || 0));
  const maxLatency = Math.max(100, ...history.map((point) => point.latencyMs || 0));
  const xFor = (index) => padding.left + (plotWidth * index) / Math.max(1, history.length - 1);
  const yForPlayers = (value) => padding.top + plotHeight - (plotHeight * (value || 0)) / maxPlayers;
  const yForLatency = (value) => padding.top + plotHeight - (plotHeight * Math.min(value || 0, maxLatency)) / maxLatency;

  ctx.fillStyle = muted;
  for (let i = 0; i <= 4; i += 1) {
    const ratioY = i / 4;
    const y = padding.top + plotHeight * ratioY;
    const playerVal = Math.round(maxPlayers * (1 - ratioY));
    const latencyVal = Math.round(maxLatency * (1 - ratioY));
    ctx.textAlign = "right";
    ctx.fillText(String(playerVal), padding.left - 6, y + 4);
    ctx.textAlign = "left";
    ctx.fillText(`${latencyVal}ms`, width - padding.right + 4, y + 4);
  }
  ctx.textAlign = "left";

  drawLine(ctx, history, xFor, (point) => yForPlayers(point.playersOnline), green);
  drawLine(ctx, history, xFor, (point) => yForLatency(point.latencyMs), blue);

  const latest = history[history.length - 1];
  ctx.fillStyle = text;
  ctx.fillText(`${window.t("chartPlayers")} ${latest.playersOnline ?? "--"}`, padding.left, height - 9);
  ctx.fillText(`${window.t("chartLatency")} ${latest.latencyMs ?? "--"} ms`, padding.left + 110, height - 9);
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
  elements.statusText.textContent = window.t("pageFailed");
  elements.motdMetric.textContent = error.message;
}

function renderUnauthorized() {
  document.body.innerHTML = `<main class="shell"><article class="panel"><h2>401 Unauthorized</h2><p>This monitor requires a token. Append <code>?token=YOUR_TOKEN</code> to the URL or send a <code>Bearer</code> header.</p></article></main>`;
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
  if (tracking.accuracy === "full") return window.t("full");
  if (tracking.accuracy === "partial") return window.t("partial");
  if (tracking.accuracy === "count-only") return window.t("countOnly");
  return window.t("none");
}

function formatDateTime(value) {
  if (!value) return "--";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  }).format(new Date(value));
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return window.t("zeroMinutes");
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return window.t("daysHours", { d: days, h: hours });
  if (hours > 0) return window.t("hoursMinutes", { h: hours, m: minutes });
  return window.t("minutes", { n: minutes });
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

function el(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children) {
    if (child == null) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function emptyDiv(text) {
  const div = document.createElement("div");
  div.className = "empty";
  div.textContent = text;
  return div;
}

function rowSpan(cols, text) {
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.colSpan = cols;
  td.textContent = text;
  tr.appendChild(td);
  return tr;
}

function initTheme() {
  const saved = localStorage.getItem("mc-theme") || "auto";
  document.documentElement.dataset.theme = saved;
  setThemeButton(saved);
}

function cycleTheme() {
  const order = ["auto", "light", "dark"];
  const current = document.documentElement.dataset.theme || "auto";
  const next = order[(order.indexOf(current) + 1) % order.length];
  document.documentElement.dataset.theme = next;
  localStorage.setItem("mc-theme", next);
  setThemeButton(next);
  if (latestPayload) drawHistory((getSelectedServer() || {}).history || []);
}

function setThemeButton(mode) {
  const map = { auto: "◐", light: "☀", dark: "☾" };
  elements.themeButton.textContent = map[mode] || "◐";
}
