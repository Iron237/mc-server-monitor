"use strict";

function createSseHub() {
  const clients = new Set();
  let counter = 0;

  function add(response) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    response.write(": connected\n\n");
    counter += 1;
    const client = { id: counter, response };
    clients.add(client);
    response.on("close", () => clients.delete(client));
    return client;
  }

  function broadcast(event, data) {
    if (!clients.size) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) {
      try { client.response.write(payload); } catch { clients.delete(client); }
    }
  }

  function size() { return clients.size; }

  return { add, broadcast, size };
}

module.exports = { createSseHub };
