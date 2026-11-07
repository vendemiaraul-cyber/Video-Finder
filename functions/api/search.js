// Cloudflare Pages Function: GET /api/search?q=...
// SearXNG video search for MeoDeo on Cloudflare. Set in the Pages project:
//   SEARXNG_URL  your SearXNG address (e.g. the Render service from searxng-host/)
//   SEARXNG_KEY  (secret) the key the searxng-host gate expects
//   HF_TOKEN     (secret, optional) for SearXNG on a private Hugging Face Space
import { Gol } from "../../gol/gol.js";
import sites from "../../gol/sites/index.js";
import { querySearxngAny, toVideos, SearxngError, skipList } from "../../server/searxng.js";
import { workerFetchPage } from "../../server/worker-fetch.js";
import { CachePolicy, D1Policy } from "../../server/site-policy.js";

// Trim: keys pasted on a phone often pick up a space or line break.
const clean = (v) => String(v || "").trim();
/** env.NAME, or a numbered copy such as NAME1 (Cloudflare suggests one when a name is taken). */
export function setting(env, name) {
  if (clean(env[name])) return clean(env[name]);
  const alt = Object.keys(env).filter((k) => new RegExp(`^${name}_?\\d+$`).test(k)).sort()[0];
  return alt ? clean(env[alt]) : "";
}
export const authHeaders = (env) => ({
  ...(setting(env, "SEARXNG_KEY") ? { "x-meodeo-key": setting(env, "SEARXNG_KEY") } : {}),
  ...(setting(env, "HF_TOKEN") ? { authorization: `Bearer ${setting(env, "HF_TOKEN")}` } : {}),
});

export async function onRequestGet({ request, env }) {
  const q = (new URL(request.url).searchParams.get("q") || "").trim();
  if (!q || q.length > 300) return Response.json({ error: "missing or too long q" }, { status: 400 });
  if (!setting(env, "SEARXNG_URL")) return Response.json({ error: "SEARXNG_URL is not set in this Cloudflare project" }, { status: 503 });
  const gol = new Gol().register(sites);
  const budget = { left: 45 };
  try {
    const { results, unresponsive } = await querySearxngAny(q, {
      baseUrl: setting(env, "SEARXNG_URL"), pages: 1, headers: authHeaders(env), timeoutMs: 75000, // free servers wake slowly
      // videos + the general web: the probe keeps only pages that really offer a video
      // videos, news (many news stories carry videos) and the general web
      categories: setting(env, "SEARXNG_CATEGORIES") || "videos,news,general",
    });
    const { videos, stats } = await toVideos(results, {
      // 50 outside requests per search on the free plan: 1 went to SearXNG, keep a margin
      // remembers which sites allow or refuse embedding (D1 when set up, else Cloudflare's cache)
      policy: env.DB ? new D1Policy(env.DB) : (globalThis.caches?.default ? new CachePolicy(caches.default) : undefined),
      gol, probeLimit: 30, concurrency: 8,
      probeOpts: { fetch: (u, o) => workerFetchPage(u, { ...o, budget }), timeoutMs: 5000 },
      skip: skipList(setting(env, "SEARXNG_SKIP")),
    });
    return Response.json({ query: q, videos, stats, unresponsive }, { headers: { "cache-control": "public, max-age=300" } });
  } catch (err) {
    const status = err instanceof SearxngError ? 502 : 500;
    return Response.json({ error: err.message }, { status });
  }
}
