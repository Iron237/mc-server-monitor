"use strict";

function slug(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "server";
}

function percent(value, total) {
  return total > 0 ? round((value / total) * 100, 1) : null;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sumNumbers(values) {
  let hasValue = false;
  const total = values.reduce((sum, value) => {
    if (Number.isFinite(value)) {
      hasValue = true;
      return sum + value;
    }
    return sum;
  }, 0);
  return hasValue ? round(total, 1) : null;
}

function normalizePlayerKey(player) {
  const raw = player.id || player.name;
  return raw ? String(raw).trim().toLowerCase() : "";
}

function minIso(currentIso, timestamp) {
  if (!currentIso) return new Date(timestamp).toISOString();
  return new Date(currentIso).getTime() <= timestamp ? currentIso : new Date(timestamp).toISOString();
}

function maxIso(currentIso, timestamp) {
  if (!currentIso) return new Date(timestamp).toISOString();
  return new Date(currentIso).getTime() >= timestamp ? currentIso : new Date(timestamp).toISOString();
}

module.exports = { slug, percent, round, sumNumbers, normalizePlayerKey, minIso, maxIso };
