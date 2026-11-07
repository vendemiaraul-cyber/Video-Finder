// Cloudflare Pages Function: GET /api/health
// Tells MeoDeo whether SearXNG search is available on this site.
import { checkSearxng, searxngList } from "../../server/searxng.js";
import { authHeaders, setting } from "./search.js";

export async function onRequestGet({ env }) {
  const urls = searxngList(setting(env, "SEARXNG_URL"));
  if (!urls.length) return Response.json({ ok: true, app: "meodeo", searxng: false, searxngUrl: "", reason: "not-set" });
  const checks = await Promise.all(urls.map((u) => checkSearxng(u, { headers: authHeaders(env), timeoutMs: 25000 })));
  const good = checks.find((c) => c.ok);
  // TEMPORARY diagnostic: length + short fingerprint of the key in use (not reversible).
  const key = authHeaders(env)["x-meodeo-key"] || "";
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  const keyCheck = { length: key.length, fp: [...digest.slice(0, 3)].map((b) => b.toString(16).padStart(2, "0")).join("") };
  return Response.json({
    ok: true, app: "meodeo", searxng: !!good, searxngUrl: good?.url || urls[0],
    reason: good ? undefined : checks[0].reason, keyCheck,
  }, { headers: { "cache-control": "no-store" } });
}
