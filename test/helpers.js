"use strict";

const http = require("node:http");

/**
 * Start a throwaway HTTP server on a random port and hand back its base URL
 * plus a record of everything it was asked.
 *
 * A real socket rather than a stubbed fetch, so the tests exercise the actual
 * request building: headers, query strings, methods and bodies as they go over
 * the wire.
 */
async function startServer(handler) {
  const requests = [];

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const record = {
        method: req.method,
        url: req.url,
        path: req.url.split("?")[0],
        query: new URLSearchParams(req.url.split("?")[1] ?? ""),
        headers: req.headers,
        body: body || null,
      };
      requests.push(record);

      try {
        handler(record, res, requests);
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `mock handler threw: ${err.message}` }));
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    calls: () => requests.map((r) => `${r.method} ${r.url}`),
    called: (needle) => requests.some((r) => r.url.includes(needle)),
    countCalls: (needle) => requests.filter((r) => r.url.includes(needle)).length,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

module.exports = { startServer, json };
