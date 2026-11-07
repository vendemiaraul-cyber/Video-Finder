// Cloudflare Pages Function: GET /api/health
// Tells MeoDeo whether SearXNG search is available on this site.
import { checkSearxng, searxngList } from "../../server/searxng.js";
import { authHeaders } from "./search.js";

export async function onRequestGet({ env }) {
  const urls = searxngList(String(env.SEARXNG_URL || "").trim());
  if (!urls.length) return Response.json({ ok: true, app: "meodeo", searxng: false, searxngUrl: "", reason: "not-set" });
  const checks = await Promise.all(urls.map((u) => checkSearxng(u, { headers: authHeaders(env), timeoutMs: 25000 })));
  const good = checks.find((c) => c.ok);
  return Response.json({
    ok: true, app: "meodeo", searxng: !!good, searxngUrl: good?.url || urls[0],
    reason: good ? undefined : checks[0].reason,
  }, { headers: { "cache-control": "no-store" } });
}
