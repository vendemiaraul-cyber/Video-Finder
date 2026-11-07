// Cloudflare Pages Function: POST /api/site-report  { url }
// "Not playing?" from MeoDeo's player: counts a black-screen report for that
// website. After a few reports (more than successes), searches flag the site.
import { ensureSchema, rateLimit, sha256 } from "../../server/feed.js";

const json = (status, data) => Response.json(data, { status, headers: { "cache-control": "no-store" } });

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return json(403, { error: "Requests must come from MeoDeo." });
  if (!env.DB) return json(200, { ok: true, stored: false });
  let domain;
  try { domain = new URL((await request.json()).url).hostname.replace(/^www\./, ""); } catch { return json(400, { error: "missing url" }); }
  await ensureSchema(env.DB);
  try {
    const ip = request.headers.get("cf-connecting-ip") || "";
    await rateLimit(env.DB, `report:${(await sha256("meodeo-ip:" + ip)).slice(0, 24)}`, 86_400_000, 40);
  } catch { return json(429, { error: "Too many reports today." }); }
  await env.DB.prepare(`INSERT INTO site_policy (domain, reports, updated) VALUES (?, 1, ?)
    ON CONFLICT(domain) DO UPDATE SET reports = reports + 1, updated = excluded.updated`).bind(domain, Date.now()).run();
  return json(200, { ok: true, stored: true });
}
