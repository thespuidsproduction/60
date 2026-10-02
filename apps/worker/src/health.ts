import { createServer, type Server } from "node:http"

/** Minimal liveness endpoint so Docker/deploy health checks can see the worker. */
export function startHealthServer(port: number, isHealthy: () => boolean): Server {
  const server = createServer((req, res) => {
    if (req.url !== "/health") {
      res.writeHead(404).end()
      return
    }
    const ok = isHealthy()
    res.writeHead(ok ? 200 : 503, { "content-type": "application/json" })
    res.end(JSON.stringify({ status: ok ? "ok" : "unhealthy", service: "worker" }))
  })
  server.listen(port)
  return server
}
