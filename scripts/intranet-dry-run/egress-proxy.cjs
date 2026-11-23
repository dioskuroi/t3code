// Loopback-only egress recorder for the intranet dry run. The server under test has to send every
// HTTP(S) request through it (NODE_USE_ENV_PROXY); each request is appended to the log file with
// its time and target host and answered with 502, so nothing leaves the machine.
const http = require("http");
const fs = require("fs");
const LOG = process.argv[2];
const log = (entry) =>
  fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");

const server = http.createServer((request, response) => {
  log({ kind: "http", host: request.headers.host, path: request.url });
  response.writeHead(502);
  response.end();
});
server.on("connect", (request, socket) => {
  log({ kind: "connect", host: request.url });
  socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
});
server.listen(18476, "127.0.0.1", () => console.log("egress-proxy listening"));
