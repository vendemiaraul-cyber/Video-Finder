// Cloudflare Pages Function: GET /api/search?q=...
// SearXNG video search for MeoDeo on Cloudflare. Set in the Pages project:
//   SEARXNG_URL  your SearXNG address (e.g. a private Hugging Face Space)
//   HF_TOKEN     (secret) a Hugging Face read token, if that Space is private
import { Gol } from "../../gol/gol.js";
import sites from "../../gol/sites/index.js";
import { querySearxngAny, toVideos, SearxngError } from "../../server/searxng.js";
import { workerFetchPage } from "../../server/worker-fetch.js";

export const authHeaders = (env) => (env.HF_TOKEN ? { authorization: `Bearer ${env.HF_TOKEN}` } : {});

export async function onRequestGet({ request, env }) {
  const q = (new URL(request.url).searchParams.get("q") || "").trim();
  if (!q || q.length > 300) return Response.json({ error: "missing or too long q" }, { status: 400 });
  if (!env.SEARXNG_URL) return Response.json({ error: "SEARXNG_URL is not set in this Cloudflare project" }, { status: 503 });
  const gol = new Gol().register(sites);
  try {
    const { results, unresponsive } = await querySearxngAny(q, {
      baseUrl: env.SEARXNG_URL, pages: 2, headers: authHeaders(env),
    });
    const { videos, stats } = await toVideos(results, {
      gol, probeLimit: 8, concurrency: 4, probeOpts: { fetch: workerFetchPage, timeoutMs: 5000 },
    });
    return Response.json({ query: q, videos, stats, unresponsive }, { headers: { "cache-control": "public, max-age=300" } });
  } catch (err) {
    const status = err instanceof SearxngError ? 502 : 500;
    return Response.json({ error: err.message }, { status });
  }
}
