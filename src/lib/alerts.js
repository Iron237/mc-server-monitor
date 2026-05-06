"use strict";

// Sustained-low-TPS detector.
//
// Each call to evaluate() reports the server's most recent TPS. The first
// time TPS dips under the threshold we open an "incident" and remember when
// it started. If TPS stays under threshold for `sustainedMs`, we emit a
// `tps-low` event exactly once. When TPS recovers, we emit `tps-recovered`
// once and reset. Brief recoveries below `sustainedMs` close the incident
// without an alert (we never noise-up the user for a one-tick blip).
function createAlertEngine({ tpsThreshold = 10, sustainedMs = 5 * 60 * 1000, onAlert } = {}) {
  const incidents = new Map();

  function evaluate(serverId, tps, now) {
    if (!Number.isFinite(tps)) return null;

    if (tps < tpsThreshold) {
      let inc = incidents.get(serverId);
      if (!inc) {
        inc = { startedAt: now, lowestTps: tps, alerted: false };
        incidents.set(serverId, inc);
      } else {
        inc.lowestTps = Math.min(inc.lowestTps, tps);
      }
      if (!inc.alerted && now - inc.startedAt >= sustainedMs) {
        inc.alerted = true;
        const event = {
          type: "tps-low",
          serverId,
          startedAt: new Date(inc.startedAt).toISOString(),
          firedAt: new Date(now).toISOString(),
          durationMs: now - inc.startedAt,
          currentTps: tps,
          lowestTps: inc.lowestTps,
          threshold: tpsThreshold,
          sustainedMs
        };
        if (onAlert) onAlert(event);
        return event;
      }
      return null;
    }

    // tps >= threshold
    const inc = incidents.get(serverId);
    if (!inc) return null;
    incidents.delete(serverId);
    if (!inc.alerted) return null; // brief dip, never alerted → no recovery event
    const event = {
      type: "tps-recovered",
      serverId,
      startedAt: new Date(inc.startedAt).toISOString(),
      recoveredAt: new Date(now).toISOString(),
      durationMs: now - inc.startedAt,
      recoveredTps: tps,
      lowestTps: inc.lowestTps,
      threshold: tpsThreshold
    };
    if (onAlert) onAlert(event);
    return event;
  }

  function getIncident(serverId) {
    return incidents.get(serverId) || null;
  }

  function snapshot() {
    return [...incidents.entries()].map(([serverId, inc]) => ({
      serverId,
      startedAt: new Date(inc.startedAt).toISOString(),
      durationMs: Date.now() - inc.startedAt,
      lowestTps: inc.lowestTps,
      alerted: inc.alerted
    }));
  }

  function reset(serverId) {
    if (serverId) incidents.delete(serverId);
    else incidents.clear();
  }

  return { evaluate, getIncident, snapshot, reset };
}

module.exports = { createAlertEngine };
