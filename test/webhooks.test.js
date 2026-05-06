"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

const { createWebhookDispatcher, ADAPTERS, formatTitle } = require("../src/lib/webhooks");

function startCapturingServer() {
  const captured = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      captured.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, port, captured, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

test("Server酱 adapter encodes title + desp as form data", () => {
  const req = ADAPTERS.serverchan({ url: "https://sctapi.ftqq.com/X.send" }, {
    type: "tps-low", serverId: "s1", serverName: "生存", threshold: 10, lowestTps: 6.5, durationMs: 360000
  });
  assert.equal(req.method, "POST");
  assert.match(req.headers["Content-Type"], /application\/x-www-form-urlencoded/);
  assert.match(req.body, /title=/);
  assert.match(req.body, /desp=/);
});

test("Discord adapter posts content JSON", () => {
  const req = ADAPTERS.discord({ url: "https://discord.com/api/webhooks/X/Y" }, {
    type: "tps-low", serverId: "s1", serverName: "Survival", threshold: 10, lowestTps: 6.5
  });
  const parsed = JSON.parse(req.body);
  assert.ok(parsed.content);
  assert.match(parsed.content, /TPS/);
});

test("PushPlus adapter forwards token + markdown content", () => {
  const req = ADAPTERS.pushplus({ token: "abc123", options: { template: "markdown" } }, {
    type: "tps-low", serverId: "s1", serverName: "S1", threshold: 10, lowestTps: 5
  });
  const parsed = JSON.parse(req.body);
  assert.equal(parsed.token, "abc123");
  assert.equal(parsed.template, "markdown");
  assert.match(parsed.content, /TPS/);
});

test("WxPusher adapter requires appToken and forwards topicIds", () => {
  const req = ADAPTERS.wxpusher({ token: "AT_XYZ", options: { topicIds: [42] } }, {
    type: "server-offline", serverId: "s1", serverName: "S1"
  });
  const parsed = JSON.parse(req.body);
  assert.equal(parsed.appToken, "AT_XYZ");
  assert.deepEqual(parsed.topicIds, [42]);
});

test("dispatcher fans out only to webhooks subscribed to the event type", async () => {
  const cap = await startCapturingServer();
  try {
    const dispatcher = createWebhookDispatcher({
      targets: [
        { name: "all-events",     type: "generic", url: cap.baseUrl + "/a" },
        { name: "only-tps-low",   type: "generic", url: cap.baseUrl + "/b", events: ["tps-low"] },
        { name: "only-recovered", type: "generic", url: cap.baseUrl + "/c", events: ["tps-recovered"] }
      ],
      timeoutMs: 1000
    });
    await dispatcher.dispatch({ type: "tps-low", serverId: "s1" });
    const paths = cap.captured.map((c) => c.url);
    assert.deepEqual(paths.sort(), ["/a", "/b"]);
  } finally {
    cap.server.close();
  }
});

test("dispatcher records a failure result when target returns 5xx", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(500); res.end("boom");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const dispatcher = createWebhookDispatcher({
    targets: [{ type: "generic", url: `http://127.0.0.1:${port}/x` }],
    timeoutMs: 1000
  });
  const results = await dispatcher.dispatch({ type: "tps-low", serverId: "s1" });
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].status, 500);
  server.close();
});

test("dispatcher silently drops events with unknown / missing type targets", async () => {
  const dispatcher = createWebhookDispatcher({
    targets: [{ type: "nonexistent-format", url: "http://example.com" }],
    timeoutMs: 100
  });
  // Should not throw.
  const results = await dispatcher.dispatch({ type: "tps-low" });
  assert.deepEqual(results, []);
});

test("formatTitle adapts to event kind", () => {
  assert.match(formatTitle({ type: "tps-low", serverName: "Foo", lowestTps: 5 }), /TPS/);
  assert.match(formatTitle({ type: "tps-recovered", serverName: "Foo" }), /恢复/);
  assert.match(formatTitle({ type: "server-offline", serverName: "Foo" }), /Foo/);
});
