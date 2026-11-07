// Cloudflare Pages Function: POST /api/probe  { result: <one SearXNG result> }
// Checks one page for a playable video. The browser calls this once per page,
// so a search can check many more pages than one request's allowance (50 outside
// requests on the free plan) would let it. Answers are kept 3 days in D1.
import { Gol } from "../../gol/gol.js";
import sites from "../../gol/sites/index.js";
import { checkCandidate, skipList } from "../../server/searxng.js";
import { workerFetchPage } from "../../server/worker-fetch.js";
import { ensureSchema, banSite } from "../../server/feed.js";
import { setting, policyFor } from "./search.js";
import { requireHuman } from "../../server/human.js";

const TTL = 3 * 86_400_000;
const json = (status, data) => Response.json(data, { status, headers: { "cache-control": "no-store" } });

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return json(403, { error: "Requests must come from MeoDeo." });
  const notHuman = await requireHuman(request, env);
  if (notHuman) return notHuman;
  let body;
  try { body = await request.json(); } catch { return json(400, { error: "Send JSON." }); }
  const result = body?.result;
  if (!result || typeof result.url !== "string" || result.url.length > 2000 || !/^https?:\/\//.test(result.url)) return json(400, { error: "missing result.url" });

  const db = env.DB;
  if (db) {
    await ensureSchema(db);
    const hit = await db.prepare("SELECT result_json, checked_at FROM probe_cache WHERE url = ?").bind(result.url).first().catch(() => null);
    if (hit && Date.now() - hit.checked_at < TTL) return json(200, { video: JSON.parse(hit.result_json), cached: true });
  }
  const gol = new Gol().register(sites);
  const budget = { left: 40 };
  const video = await checkCandidate(result, {
    gol, skip: skipList(setting(env, "SEARXNG_SKIP")), policy: policyFor(env),
    probeOpts: { fetch: (u, o) => workerFetchPage(u, { ...o, budget }), timeoutMs: 6000 },
    // Adult-labelled website: ban it for everyone, so nobody has to look at it to decide.
    onAdult: db ? (domain) => banSite(db, domain, "automatic: the website labels itself adult-only").catch(() => {}) : undefined,
  });
  if (db && budget.left > 0) {
    await db.prepare(`INSERT INTO probe_cache (url, result_json, checked_at) VALUES (?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET result_json = excluded.result_json, checked_at = excluded.checked_at`)
      .bind(result.url, JSON.stringify(video), Date.now()).run().catch(() => {});
  }
  return json(200, { video });
}
