#!/usr/bin/env node
/**
 * MeoDeo server - zero dependencies, Node 18+.
 *
 *   SEARXNG_URL=http://127.0.0.1:8888 node server/server.js
 *   (several SearXNG addresses, comma-separated, are tried in order)
 *
 * Serves the MeoDeo website and adds:
 *   GET /api/health          -> { ok, searxng, reason }  (reason: json-off, limiter-on, unreachable)
 *   GET /api/search?q=...    -> SearXNG video results that really offer a
 *                               video, as Gol videos
 */
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Gol } from "../gol/gol.js";
import sites from "../gol/sites/index.js";
import { querySearxngAny, toVideos, SearxngError, checkSearxng, searxngList } from "./searxng.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = ["index.html", "assets", "gol"]; // only these are served

export function config(env = process.env) {
  return {
    port: +(env.PORT || 8787),
    host: env.HOST || "127.0.0.1",
    searxngUrl: env.SEARXNG_URL || "http://127.0.0.1:8888",
    pages: Math.max(1, Math.min(5, +(env.SEARXNG_PAGES || 2))),
    categories: env.SEARXNG_CATEGORIES || "videos",
    safesearch: env.SEARXNG_SAFESEARCH ?? "1",
    probeLimit: +(env.PROBE_LIMIT || 16),
    allowOrigin: env.ALLOW_ORIGIN || "*",
    // Testing only: lets the probe open pages on this machine's network.
    allowPrivate: env.MEODEO_ALLOW_PRIVATE === "1",
  };
}

class TTLCache {
  constructor(ttlMs, max = 500) { this.ttl = ttlMs; this.max = max; this.map = new Map(); }
  get(k) {
    const hit = this.map.get(k);
    if (!hit) return undefined;
    if (Date.now() - hit.t > this.ttl) { this.map.delete(k); return undefined; }
    return hit.v;
  }
  set(k, v) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    this.map.set(k, { t: Date.now(), v });
  }
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
                ".svg": "image/svg+xml", ".json": "application/json", ".md": "text/markdown; charset=utf-8", ".png": "image/png" };

export function createServer(cfg = config(), { fetchImpl = fetch } = {}) {
  const gol = new Gol().register(sites);
  const searchCache = new TTLCache(5 * 60_000, 200);
  const probeCache = new TTLCache(30 * 60_000, 3000);
  let health = null;

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { "access-control-allow-origin": cfg.allowOrigin, "x-content-type-options": "nosniff", ...headers });
    res.end(body);
  };
  const json = (res, status, data) => send(res, status, JSON.stringify(data), { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });

  async function search(q) {
    const key = q.toLowerCase();
    const hit = searchCache.get(key);
    if (hit) return hit;
    const { results, unresponsive } = await querySearxngAny(q, {
      baseUrl: cfg.searxngUrl, pages: cfg.pages, categories: cfg.categories, safesearch: cfg.safesearch, fetchImpl,
    });
    const { videos, stats } = await toVideos(results, {
      gol, probeLimit: cfg.probeLimit, cache: probeCache, probeOpts: { allowPrivate: cfg.allowPrivate },
    });
    const out = { query: q, videos, stats, unresponsive };
    searchCache.set(key, out);
    return out;
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      if (req.method === "OPTIONS") return send(res, 204, "", { "access-control-allow-methods": "GET", "access-control-max-age": "86400" });
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");

      if (url.pathname === "/api/health") {
        // Cache for a minute: each check runs a tiny SearXNG search.
        if (!health || Date.now() - health.t > 60_000 || url.searchParams.has("fresh")) {
          const checks = await Promise.all(searxngList(cfg.searxngUrl).map((u) => checkSearxng(u, { fetchImpl })));
          const good = checks.find((c) => c.ok);
          health = { t: Date.now(), data: {
            ok: true, app: "meodeo",
            searxng: !!good,
            searxngUrl: good?.url || cfg.searxngUrl,
            reason: good ? undefined : (checks[0]?.reason || "not-set"),
          } };
        }
        return json(res, 200, health.data);
      }

      if (url.pathname === "/api/search") {
        const q = (url.searchParams.get("q") || "").trim();
        if (!q) return json(res, 400, { error: "missing q" });
        if (q.length > 300) return json(res, 400, { error: "query too long" });
        try {
          return json(res, 200, await search(q));
        } catch (err) {
          if (err instanceof SearxngError) return json(res, 502, { error: err.message });
          throw err;
        }
      }

      // static files
      let rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
      const file = path.resolve(ROOT, rel);
      const top = path.relative(ROOT, file).split(path.sep)[0];
      if (!file.startsWith(ROOT + path.sep) || !PUBLIC.includes(top)) return send(res, 404, "Not found");
      const stat = await fs.stat(file).catch(() => null);
      if (!stat || !stat.isFile()) return send(res, 404, "Not found");
      const body = req.method === "HEAD" ? "" : await fs.readFile(file);
      return send(res, 200, body, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    } catch (err) {
      console.error(err);
      json(res, 500, { error: "server error" });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const cfg = config();
  createServer(cfg).listen(cfg.port, cfg.host, () => {
    console.log(`MeoDeo running at http://${cfg.host}:${cfg.port}`);
    console.log(`Using SearXNG at ${cfg.searxngUrl}`);
  });
}
