import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import type { FastifyInstance } from "fastify";

// Serves the staff app's web build from the same server as the API, so a course has one
// address to open on its iPads and computers. Anything that isn't a file falls back to the
// app's index page; /v1 and the health checks are left to the API.

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

export function serveWeb(app: FastifyInstance, root: string) {
  const base = normalize(root);
  app.setNotFoundHandler(async (req, reply) => {
    const path = req.url.split("?")[0] ?? "/";
    if (req.method !== "GET" || path.startsWith("/v1/") || path === "/health" || path === "/ready") {
      return reply.status(404).send({ error: { code: "not_found", message: "Not found" } });
    }
    let file = normalize(join(base, decodeURIComponent(path)));
    // Never leave the web build's folder, whatever the path says.
    if (file !== base && !file.startsWith(base + sep)) return reply.status(404).send({ error: { code: "not_found", message: "Not found" } });
    let info = await stat(file).catch(() => undefined);
    if (info?.isDirectory()) {
      file = join(file, "index.html");
      info = await stat(file).catch(() => undefined);
    }
    if (!info?.isFile()) {
      file = join(base, "index.html");
      info = await stat(file).catch(() => undefined);
      if (!info) return reply.status(404).send({ error: { code: "not_found", message: "Not found" } });
    }
    const ext = extname(file);
    reply.type(TYPES[ext] ?? "application/octet-stream");
    // Built files have hashed names, so browsers can keep them; the page itself must always be fresh.
    reply.header("cache-control", file.includes(`${sep}_expo${sep}`) ? "public, max-age=31536000, immutable" : "no-cache");
    return reply.send(createReadStream(file));
  });
}
