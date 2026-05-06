"use strict";

const fs = require("fs");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

// Strip JSONC extras (// line comments, /* block */ comments, trailing
// commas) without touching contents inside strings, then JSON.parse.
function parseJsonc(text) {
  let out = "";
  let i = 0;
  let inStr = false;
  let strCh = "";
  let esc = false;
  while (i < text.length) {
    const ch = text[i];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === strCh) inStr = false;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      strCh = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  const cleaned = out.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(cleaned);
}

function loadJsoncFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf8");
  return parseJsonc(raw);
}

function envString(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function envInt(name, fallback) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isFinite(value) ? value : fallback;
}

function envBool(name, fallback) {
  return toBool(process.env[name], fallback);
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

module.exports = { loadEnvFile, envString, envInt, envBool, toInt, toBool, parseJsonc, loadJsoncFile };
