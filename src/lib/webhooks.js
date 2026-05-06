"use strict";

const http = require("http");
const https = require("https");

// One generic dispatcher with per-target format adapters. Built-in types:
//
//   discord     POST {content}                                 to incoming-webhook URL
//   slack       POST {text}                                    same shape as discord
//   serverchan  POST title= & desp=                            sct.ftqq.com (Server酱)
//   pushplus    POST {token,title,content,template:"markdown"} pushplus.plus
//   wxpusher    POST {appToken,content,summary,contentType,topicIds|uids}
//   generic     POST raw event JSON
//
// Targets are loaded from `webhooks.jsonc` (preferred) or the WEBHOOKS env
// variable as a JSON array. Each target: { type, url, token?, options?,
// events? } where `events` is an optional array of event-type filters
// (default = all). Failures are logged and never throw — alerts must keep
// firing even if Discord is down.

const ADAPTERS = {
  discord: ({ url, options }, event) => ({
    method: "POST",
    url,
    body: JSON.stringify({
      content: formatPlain(event),
      username: (options && options.username) || "MC Monitor",
      ...((options && options.extra) || {})
    }),
    headers: { "Content-Type": "application/json" }
  }),

  slack: ({ url, options }, event) => ({
    method: "POST",
    url,
    body: JSON.stringify({
      text: formatPlain(event),
      ...((options && options.extra) || {})
    }),
    headers: { "Content-Type": "application/json" }
  }),

  // Server酱 (sct.ftqq.com). URL like "https://sctapi.ftqq.com/SCTxxx.send".
  // Payload form-encoded: title + desp (markdown body).
  serverchan: ({ url }, event) => {
    const params = new URLSearchParams();
    params.set("title", formatTitle(event));
    params.set("desp", formatMarkdown(event));
    return {
      method: "POST",
      url,
      body: params.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" }
    };
  },

  // PushPlus (pushplus.plus). Token comes from the user account.
  pushplus: ({ token, options }, event) => ({
    method: "POST",
    url: "https://www.pushplus.plus/send",
    body: JSON.stringify({
      token,
      title: formatTitle(event),
      content: formatMarkdown(event),
      template: (options && options.template) || "markdown",
      ...((options && options.extra) || {})
    }),
    headers: { "Content-Type": "application/json" }
  }),

  // WxPusher (wxpusher.zjiecode.com). Either topicIds or uids must be set
  // via the target's options block.
  wxpusher: ({ token, options }, event) => ({
    method: "POST",
    url: "https://wxpusher.zjiecode.com/api/send/message",
    body: JSON.stringify({
      appToken: token,
      content: formatMarkdown(event),
      summary: formatTitle(event).slice(0, 100),
      contentType: 3, // markdown
      topicIds: (options && options.topicIds) || [],
      uids: (options && options.uids) || [],
      ...((options && options.extra) || {})
    }),
    headers: { "Content-Type": "application/json" }
  }),

  // Bare-bones JSON POST so users can wire up anything else (n8n, IFTTT, …).
  generic: ({ url, options }, event) => ({
    method: (options && options.method) || "POST",
    url,
    body: JSON.stringify({ event, ...((options && options.extra) || {}) }),
    headers: { "Content-Type": "application/json", ...((options && options.headers) || {}) }
  })
};

function formatTitle(event) {
  if (event.type === "tps-low") {
    return `[MC] ${event.serverName || event.serverId}: TPS 跌至 ${fmt(event.lowestTps)}`;
  }
  if (event.type === "tps-recovered") {
    return `[MC] ${event.serverName || event.serverId}: TPS 已恢复`;
  }
  if (event.type === "crash") {
    return `[MC] ${event.serverName || event.serverId}: 检测到崩溃`;
  }
  return `[MC] ${event.serverName || event.serverId}: ${event.type}`;
}

function formatPlain(event) {
  return `${formatTitle(event)}\n${formatBody(event)}`;
}

function formatMarkdown(event) {
  const head = `**${formatTitle(event)}**`;
  return `${head}\n\n${formatBody(event)}`;
}

function formatBody(event) {
  if (event.type === "tps-low") {
    const minutes = Math.round((event.durationMs || 0) / 60000);
    return [
      `- 服务器: ${event.serverName || event.serverId}`,
      `- 阈值: ${event.threshold} TPS`,
      `- 已持续: ${minutes} 分钟`,
      `- 最低 TPS: ${fmt(event.lowestTps)}`,
      `- 当前 TPS: ${fmt(event.currentTps)}`,
      `- 起始时间: ${event.startedAt}`
    ].join("\n");
  }
  if (event.type === "tps-recovered") {
    const minutes = Math.round((event.durationMs || 0) / 60000);
    return [
      `- 服务器: ${event.serverName || event.serverId}`,
      `- 持续时长: ${minutes} 分钟`,
      `- 恢复 TPS: ${fmt(event.recoveredTps)}`,
      `- 最低 TPS: ${fmt(event.lowestTps)}`,
      `- 恢复时间: ${event.recoveredAt}`
    ].join("\n");
  }
  return JSON.stringify(event, null, 2);
}

function fmt(n) {
  return Number.isFinite(n) ? Number(n).toFixed(1) : "?";
}

function buildRequest(target, event) {
  const adapter = ADAPTERS[target.type];
  if (!adapter) throw new Error(`Unknown webhook type: ${target.type}`);
  return adapter(target, event);
}

function postOnce(req, timeoutMs) {
  return new Promise((resolve) => {
    let urlObj;
    try {
      urlObj = new URL(req.url);
    } catch (error) {
      resolve({ ok: false, error: `Invalid URL: ${req.url}` });
      return;
    }
    const lib = urlObj.protocol === "https:" ? https : http;
    const options = {
      method: req.method,
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
      path: `${urlObj.pathname}${urlObj.search}`,
      headers: { "Content-Length": Buffer.byteLength(req.body || ""), ...req.headers },
      timeout: timeoutMs
    };
    const request = lib.request(options, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve({ ok: true, status: response.statusCode, body });
        } else {
          resolve({ ok: false, status: response.statusCode, body, error: `HTTP ${response.statusCode}` });
        }
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error("timeout"));
    });
    request.on("error", (error) => resolve({ ok: false, error: error.message }));
    if (req.body) request.write(req.body);
    request.end();
  });
}

function targetFilters(target) {
  if (!target.events || !Array.isArray(target.events) || target.events.length === 0) return null;
  return new Set(target.events);
}

function createWebhookDispatcher({ targets = [], timeoutMs = 5000, onResult } = {}) {
  const validated = targets
    .filter((t) => t && typeof t === "object" && t.type && ADAPTERS[t.type])
    .map((t) => ({ ...t, _filter: targetFilters(t) }));

  async function dispatch(event) {
    if (!event || !event.type) return [];
    const results = [];
    for (const target of validated) {
      if (target._filter && !target._filter.has(event.type)) continue;
      let req;
      try {
        req = buildRequest(target, event);
      } catch (error) {
        const result = { target: target.type, ok: false, error: error.message };
        results.push(result);
        if (onResult) onResult(result, target);
        continue;
      }
      const result = await postOnce(req, timeoutMs);
      const annotated = { target: target.type, name: target.name || target.type, ...result };
      results.push(annotated);
      if (onResult) onResult(annotated, target);
      if (!result.ok) {
        console.warn(`webhook ${target.type} (${target.name || target.url || ""}) failed: ${result.error || result.status}`);
      }
    }
    return results;
  }

  return { dispatch, targets: validated.length };
}

module.exports = { createWebhookDispatcher, ADAPTERS, formatTitle, formatBody, formatMarkdown, formatPlain };
