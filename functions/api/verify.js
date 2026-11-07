// Cloudflare Pages Function: human verification with hCaptcha or Cloudflare Turnstile.
//   GET  /api/verify -> { required, verified, inApp, hcaptchaSiteKey, turnstileSiteKey }
//   POST /api/verify { method: "hcaptcha" | "turnstile", token }   (the widget's answer)
//                    { method: "inapp" }                           (TikTok, Instagram... browsers)
// Passing sets a signed cookie for 7 days.
import { secretFor, humanCookie, hasHumanCookie, isInAppBrowser, checkToken, configured, verificationOn } from "../../server/human.js";
import { rateLimit, sha256, ensureSchema, FeedError } from "../../server/feed.js";

const json = (status, data, headers = {}) => Response.json(data, { status, headers: { "cache-control": "no-store", ...headers } });

export async function onRequestGet({ request, env }) {
  if (!(await verificationOn(env))) return json(200, { required: false });
  const keys = configured(env);
  const inApp = isInAppBrowser(request.headers.get("user-agent"));
  return json(200, {
    required: true,
    inApp,
    verified: inApp || (await hasHumanCookie(request, await secretFor(env))),
    hcaptchaSiteKey: keys.hcaptcha || null,
    turnstileSiteKey: keys.turnstile || null,
  });
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return json(403, { error: "Requests must come from MeoDeo." });
  if (!(await verificationOn(env))) return json(503, { error: "Verification isn't set up on this site." });
  let body;
  try { body = await request.json(); } catch { return json(400, { error: "Send JSON." }); }
  const ip = request.headers.get("cf-connecting-ip") || "";

  if (env.DB) {
    await ensureSchema(env.DB);
    try { await rateLimit(env.DB, `verify:${(await sha256("meodeo-ip:" + ip)).slice(0, 24)}`, 600_000, 30); }
    catch (err) {
      if (err instanceof FeedError) return json(429, { error: "Too many tries. Wait a few minutes and try again." });
      throw err;
    }
  }

  let result;
  if (body?.method === "inapp") {
    result = isInAppBrowser(request.headers.get("user-agent")) ? { ok: true } : { ok: false, reason: "not-in-app" };
  } else if (body?.method === "hcaptcha" || body?.method === "turnstile") {
    result = await checkToken(body.method, env, body.token, ip);
  } else {
    return json(400, { error: "Unknown verification method." });
  }
  if (!result.ok) {
    const msg = { "not-set-up": "That option isn't set up on this site.", "not-in-app": "This isn't an in-app browser.",
      missing: "Please complete the check first." }[result.reason] || "Verification failed. Please try again.";
    return json(400, { error: msg, code: result.reason });
  }
  return json(200, { ok: true }, { "set-cookie": await humanCookie(await secretFor(env)) });
}
