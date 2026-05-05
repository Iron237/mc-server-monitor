"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { isAuthorized, isPublicPath } = require("../src/lib/auth");

function req({ headers = {}, url = "/api/status" } = {}) {
  return { headers, url };
}

test("isAuthorized returns true when no token configured", () => {
  assert.equal(isAuthorized(req(), ""), true);
});

test("isAuthorized accepts Bearer token", () => {
  assert.equal(isAuthorized(req({ headers: { authorization: "Bearer abc" } }), "abc"), true);
  assert.equal(isAuthorized(req({ headers: { authorization: "Bearer xyz" } }), "abc"), false);
});

test("isAuthorized accepts ?token= query param", () => {
  assert.equal(isAuthorized(req({ url: "/api/status?token=abc" }), "abc"), true);
  assert.equal(isAuthorized(req({ url: "/api/status?token=wrong" }), "abc"), false);
});

test("isAuthorized accepts mc_token cookie", () => {
  assert.equal(isAuthorized(req({ headers: { cookie: "foo=bar; mc_token=abc; baz=qux" } }), "abc"), true);
});

test("isPublicPath matches expected", () => {
  assert.equal(isPublicPath("/health"), true);
  assert.equal(isPublicPath("/api/status"), false);
});
