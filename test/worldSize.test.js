"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createWorldSizeSampler, measureDirectorySize } = require("../src/lib/worldSize");

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcsm-ws-"));
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("measureDirectorySize sums file bytes recursively", async () => {
  await withTempDir(async (dir) => {
    fs.writeFileSync(path.join(dir, "a.bin"), Buffer.alloc(100));
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "sub", "b.bin"), Buffer.alloc(250));
    const r = await measureDirectorySize(dir);
    assert.equal(r.bytes, 350);
    assert.equal(r.files, 2);
  });
});

test("measureDirectorySize returns 0 for missing path", async () => {
  await withTempDir(async (dir) => {
    const r = await measureDirectorySize(path.join(dir, "missing"));
    assert.equal(r.bytes, 0);
    assert.equal(r.files, 0);
  });
});

test("sampler skips re-walk inside intervalMs and reuses cached point", async () => {
  await withTempDir(async (dir) => {
    fs.writeFileSync(path.join(dir, "a"), Buffer.alloc(50));
    const sampler = createWorldSizeSampler({ intervalMs: 60_000 });
    const t0 = Date.now();
    const first = await sampler.sample("s1", dir, t0);
    assert.equal(first.bytes, 50);
    // Append more bytes — but next sample call is well within intervalMs so
    // sampler should NOT re-walk.
    fs.writeFileSync(path.join(dir, "b"), Buffer.alloc(500));
    const second = await sampler.sample("s1", dir, t0 + 1000);
    assert.equal(second.bytes, 50);
    assert.equal(sampler.getHistory("s1").length, 1);
  });
});

test("sampler walks again after intervalMs elapses and accumulates history", async () => {
  await withTempDir(async (dir) => {
    fs.writeFileSync(path.join(dir, "a"), Buffer.alloc(100));
    const sampler = createWorldSizeSampler({ intervalMs: 1 });
    const t0 = Date.now();
    await sampler.sample("s1", dir, t0);
    fs.writeFileSync(path.join(dir, "b"), Buffer.alloc(900));
    const second = await sampler.sample("s1", dir, t0 + 1000);
    assert.equal(second.bytes, 1000);
    assert.equal(sampler.getHistory("s1").length, 2);
  });
});

test("projectGrowth fits a slope and predicts daysUntilFull", () => {
  const sampler = createWorldSizeSampler({ intervalMs: 1 });
  // Manually plant a 4-day linear growth: +100MB/day
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const history = [
    { at: new Date(now - 4 * day).toISOString(), bytes: 1_000_000_000 },
    { at: new Date(now - 3 * day).toISOString(), bytes: 1_100_000_000 },
    { at: new Date(now - 2 * day).toISOString(), bytes: 1_200_000_000 },
    { at: new Date(now - 1 * day).toISOString(), bytes: 1_300_000_000 },
    { at: new Date(now).toISOString(),           bytes: 1_400_000_000 }
  ];
  sampler.loadHistory("s1", history);
  const proj = sampler.projectGrowth("s1", 7 * day, 500_000_000);
  assert.ok(proj);
  // Slope ≈ 100,000,000 bytes/day (within 1%)
  assert.ok(Math.abs(proj.bytesPerDay - 100_000_000) / 100_000_000 < 0.01);
  // 500 MB free / 100 MB/day = 5 days until full
  assert.ok(Math.abs(proj.daysUntilFull - 5) < 0.5);
});
