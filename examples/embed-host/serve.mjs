// Dev harness for the embeddable engine: serves the example host page +
// the built engine bundle, and proxies everything else (the sideshow API, SSE,
// /s surface frames, /a assets) to a running sideshow server — so the embed
// page is same-origin with the API. Not shipped; a local test rig.
//
//   node examples/embed-host/serve.mjs            # proxies to :8228, serves :5180
//   ORIGIN=http://localhost:8228 PORT=5180 node examples/embed-host/serve.mjs
import { createServer, request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = join(here, "..", "..", "viewer", "dist-embed");
const ORIGIN = new URL(process.env.ORIGIN ?? "http://localhost:8228");
const PORT = Number(process.env.PORT ?? 5180);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

async function serveFile(res, path) {
  try {
    const body = await readFile(path);
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

function proxy(req, res) {
  const upstream = httpRequest(
    {
      hostname: ORIGIN.hostname,
      port: ORIGIN.port,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: ORIGIN.host },
    },
    (up) => {
      // Stream the response (works for SSE: no buffering, flush headers now).
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", () => {
    res.writeHead(502);
    res.end("upstream error");
  });
  req.pipe(upstream);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (path === "/" || path === "/index.html") {
    await serveFile(res, join(here, "index.html"));
    return;
  }
  if (path.startsWith("/engine/")) {
    // serve the built engine bundle + its lazy chunks
    const rel = normalize(path.slice("/engine/".length)).replace(/^(\.\.[/\\])+/, "");
    if (await serveFile(res, join(ENGINE_DIR, rel))) return;
    res.writeHead(404);
    res.end("engine asset not found");
    return;
  }
  // everything else → the sideshow server (API, SSE, /s frames, /a assets, /guide)
  proxy(req, res);
});

server.listen(PORT, () => {
  console.log(`embed host on http://localhost:${PORT}  →  proxying API to ${ORIGIN.origin}`);
});
