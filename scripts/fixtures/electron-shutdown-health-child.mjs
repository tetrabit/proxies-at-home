import http from "node:http";
import { appendFileSync } from "node:fs";

const options = new Map(
  process.argv.slice(2).map((argument) => {
    const [name, value] = argument.split("=", 2);
    return [name.replace(/^--/, ""), value];
  })
);
const traceFile = options.get("trace-file");
const port = Number(process.env.PORT);

if (!traceFile || !Number.isInteger(port) || port <= 0) {
  throw new Error("health child requires --trace-file and a positive PORT");
}

function record(event) {
  appendFileSync(traceFile, `${JSON.stringify({ event, pid: process.pid, at: Date.now() })}\n`);
}

const server = http.createServer((request, response) => {
  if (request.url !== "/health") {
    response.writeHead(404).end();
    return;
  }

  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      service: "scryfall-cache",
      status: "healthy",
      version: "shutdown-harness",
    })
  );
});

process.on("SIGTERM", () => {
  record("sigterm-ignored");
  console.log("health-child:sigterm-ignored");
});

server.listen(port, "127.0.0.1", () => {
  record("healthy");
  console.log(`health-child:healthy:${port}`);
});
