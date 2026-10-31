"use strict";

// Local dev server: serves the static page and the same API shapes as the
// Vercel functions in /api. Usage: QLOO_API_KEY=... node server.js
const http = require("http");
const fs = require("fs");
const path = require("path");
const { searchEntities, getPicks } = require("./lib/qloo");

const ROOT = __dirname;
const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml" };

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/api/search") {
      const results = await searchEntities(url.searchParams.get("q") || "");
      return sendJson(res, 200, { results });
    }
    if (url.pathname === "/api/picks" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", async () => {
        try {
          const body = JSON.parse(raw || "{}");
          const data = await getPicks(body);
          sendJson(res, 200, data);
        } catch (e) {
          sendJson(res, 502, { error: e.message || "Recommendation failed" });
        }
      });
      return;
    }
    const file = url.pathname === "/" ? "/index.html" : url.pathname;
    const full = path.join(ROOT, file);
    if (!full.startsWith(ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      res.writeHead(404); return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    sendJson(res, 502, { error: e.message || "Server error" });
  }
});

const port = process.env.PORT || 4173;
server.listen(port, () => console.log("Crave dev server on http://localhost:" + port));
