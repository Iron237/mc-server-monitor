"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { parseJsonc, loadJsoncFile } = require("../src/lib/env");
const { resolveServersFile, parseServersFile, loadServerConfigs } = require("../src/lib/config");

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcsm-cfg-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("parseJsonc strips // line comments", () => {
  const text = `{
    // pre-key comment
    "a": 1, // trailing
    "b": "// inside string stays" // also trailing
  }`;
  const parsed = parseJsonc(text);
  assert.equal(parsed.a, 1);
  assert.equal(parsed.b, "// inside string stays");
});

test("parseJsonc strips /* block */ comments", () => {
  const text = `{
    "a": /* ignored */ 1,
    /* block
       across lines */
    "b": 2
  }`;
  assert.deepEqual(parseJsonc(text), { a: 1, b: 2 });
});

test("parseJsonc accepts trailing commas in objects and arrays", () => {
  const text = `{
    "list": [1, 2, 3,],
    "nested": { "x": 1, },
  }`;
  assert.deepEqual(parseJsonc(text), { list: [1, 2, 3], nested: { x: 1 } });
});

test("parseJsonc preserves slashes inside strings", () => {
  // path with // and /* */ embedded
  const text = `{ "path": "C:/Users/has//slashes/and/* not a comment */" }`;
  const parsed = parseJsonc(text);
  assert.equal(parsed.path, "C:/Users/has//slashes/and/* not a comment */");
});

test("loadJsoncFile returns null when missing", () => {
  assert.equal(loadJsoncFile("/no/such/file/here.jsonc"), null);
});

test("resolveServersFile prefers SERVERS_FILE override", () => {
  withTempDir((dir) => {
    const target = path.join(dir, "alt.jsonc");
    fs.writeFileSync(target, "[]");
    const previous = process.env.SERVERS_FILE;
    process.env.SERVERS_FILE = "alt.jsonc";
    try {
      assert.equal(resolveServersFile(dir), target);
    } finally {
      if (previous === undefined) delete process.env.SERVERS_FILE;
      else process.env.SERVERS_FILE = previous;
    }
  });
});

test("resolveServersFile falls back to servers.jsonc then servers.json", () => {
  withTempDir((dir) => {
    const previous = process.env.SERVERS_FILE;
    delete process.env.SERVERS_FILE;
    try {
      assert.equal(resolveServersFile(dir), null, "no file present yet");

      const jsonPath = path.join(dir, "servers.json");
      fs.writeFileSync(jsonPath, "[]");
      assert.equal(resolveServersFile(dir), jsonPath);

      const jsoncPath = path.join(dir, "servers.jsonc");
      fs.writeFileSync(jsoncPath, "[]");
      // .jsonc wins over .json
      assert.equal(resolveServersFile(dir), jsoncPath);
    } finally {
      if (previous !== undefined) process.env.SERVERS_FILE = previous;
    }
  });
});

test("resolveServersFile throws when SERVERS_FILE points at missing file", () => {
  withTempDir((dir) => {
    const previous = process.env.SERVERS_FILE;
    process.env.SERVERS_FILE = "missing.jsonc";
    try {
      assert.throws(() => resolveServersFile(dir), /does not exist/);
    } finally {
      if (previous === undefined) delete process.env.SERVERS_FILE;
      else process.env.SERVERS_FILE = previous;
    }
  });
});

test("parseServersFile accepts a top-level {servers:[...]} wrapper", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "s.jsonc");
    fs.writeFileSync(file, `{
      // wrapper form
      "servers": [
        { "id": "main", "name": "Main", "host": "127.0.0.1", "port": 25565 },
      ]
    }`);
    const servers = parseServersFile(file);
    assert.equal(servers.length, 1);
    assert.equal(servers[0].id, "main");
    assert.equal(servers[0].port, 25565);
  });
});

test("loadServerConfigs honors servers.jsonc over SERVERS env", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "servers.jsonc");
    fs.writeFileSync(file, `[
      { "id": "fromfile", "name": "FromFile", "host": "127.0.0.1", "port": 25565 }
    ]`);
    const previousServers = process.env.SERVERS;
    const previousFile = process.env.SERVERS_FILE;
    process.env.SERVERS = '[{"id":"fromenv","host":"127.0.0.1","port":1}]';
    delete process.env.SERVERS_FILE;
    try {
      const servers = loadServerConfigs(dir);
      assert.equal(servers.length, 1);
      assert.equal(servers[0].id, "fromfile");
    } finally {
      if (previousServers === undefined) delete process.env.SERVERS;
      else process.env.SERVERS = previousServers;
      if (previousFile !== undefined) process.env.SERVERS_FILE = previousFile;
    }
  });
});
