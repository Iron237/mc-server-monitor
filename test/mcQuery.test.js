"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseQueryFullStat, splitNullStrings } = require("../src/lib/mcQuery");

test("splitNullStrings filters empty entries", () => {
  const buf = Buffer.from("foo\0bar\0\0baz\0", "utf8");
  assert.deepEqual(splitNullStrings(buf), ["foo", "bar", "baz"]);
});

test("parseQueryFullStat returns metadata and players", () => {
  const header = Buffer.from([0x00, 0xde, 0xad, 0xbe, 0xef, 0x00]);
  const padding = Buffer.from([0x73, 0x70, 0x6c, 0x69, 0x74, 0x6e, 0x75, 0x6d, 0x00, 0x80, 0x00]);
  const metadataPairs = [
    "hostname", "A Server",
    "gametype", "SMP",
    "game_id", "MINECRAFT",
    "version", "",
    "plugins", "",
    "map", "world",
    "numplayers", "2",
    "maxplayers", "20",
    "hostport", "25565",
    "hostip", "127.0.0.1",
    ""
  ];
  const metadata = Buffer.from(metadataPairs.join("\0"), "utf8");
  const playerSection = Buffer.from([0x01, 0x70, 0x6c, 0x61, 0x79, 0x65, 0x72, 0x5f, 0x00, 0x00]);
  const players = Buffer.from("Foo\0Bar\0\0", "utf8");
  const message = Buffer.concat([header, padding, metadata, playerSection, players]);
  const out = parseQueryFullStat(message);
  assert.deepEqual(out.players, ["Foo", "Bar"]);
  assert.equal(out.metadata.hostname, "A Server");
  assert.equal(out.metadata.numplayers, "2");
});
