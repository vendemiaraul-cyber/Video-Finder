// Cloudflare Pages Function: GET /api/pexels?q=...
// Searches Pexels with the site's own key, kept private: set PEXELS_API_KEY as an
// encrypted Secret in the Pages project (Settings > Variables and Secrets).
// The key never reaches the browser. Only MeoDeo's own pages may use this
// route, each visitor has an hourly limit, and results are cached for a day,
// so the free Pexels allowance (200 requests an hour) isn't used up.
import { searchPexels, PexelsError } from "../../server/pexels.js";
import { ensureSchema, rateLimit, sha256, FeedError } from "../../server/feed.js";
import { setting } from "./search.js";

const CACHE_MS = 24 * 3600_000;
const PER_IP_PER_HOUR = 60;

const json = (status, data, extra = {}) => Response.json(data, { status, headers: { "cache-control": "no-store", ...extra } });

/** Only MeoDeo's own pages: other websites can't spend the key. */
function fromThisSite(request) {
  const origin = request.headers.get("origin");
  if (origin) return origin === new URL(request.url).origin;
  const site = request.headers.get("sec-fetch-site");
  return site === "same-origin" || site === "none" || site === null;
}

export async function onRequestGet({ request, env }) {
  // ?check=1: is Pexels set up here? (answers yes/no, never anything about the key)
  if (new URL(request.url).searchParams.has("check")) return json(200, { ready: !!setting(env, "PEXELS_API_KEY") });
  const q = (new URL(request.url).searchParams.get("q") || "").trim().toLowerCase();
  if (!q || q.length > 300) return json(400, { error: "missing or too long q" });
  if (!fromThisSite(request)) return json(403, { error: "Only MeoDeo can use this.", code: "cross-site" });
  const apiKey = setting(env, "PEXELS_API_KEY");
  if (!apiKey) return json(503, { error: "Pexels isn't set up on this MeoDeo yet.", code: "no-key" });
  const db = env.DB;
  try {
    if (db) {
      await ensureSchema(db);
      const hit = await db.prepare("SELECT result_json, checked_at FROM api_cache WHERE key = ?").bind("pexels:" + q).first();
      if (hit && Date.now() - hit.checked_at < CACHE_MS) return json(200, { videos: JSON.parse(hit.result_json), cached: true });
      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      await rateLimit(db, "pexels:" + (await sha256("meodeo-ip:" + ip)).slice(0, 24), 3600_000, PER_IP_PER_HOUR);
    }
    const videos = await searchPexels(q, { apiKey, limit: 15 });
    if (db) {
      await db.prepare(`INSERT INTO api_cache (key, result_json, checked_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET result_json = excluded.result_json, checked_at = excluded.checked_at`)
        .bind("pexels:" + q, JSON.stringify(videos), Date.now()).run();
    }
    return json(200, { videos });
  } catch (err) {
    if (err instanceof PexelsError || err instanceof FeedError) return json(err.status, { error: err.message, code: err.code });
    console.error("pexels", err?.name); // never log the key or the request headers
    return json(502, { error: "Pexels search failed.", code: "server" });
  }
}
