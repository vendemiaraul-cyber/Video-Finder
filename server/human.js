/**
 * Human verification for MeoDeo, with two real services (both free):
 *  - hCaptcha: the classic CAPTCHA (pick the matching pictures).
 *    Keys: HCAPTCHA_SITE_KEY, HCAPTCHA_SECRET   (dashboard.hcaptcha.com)
 *  - Cloudflare Turnstile: usually invisible, sometimes one click.
 *    Keys: TURNSTILE_SITE_KEY, TURNSTILE_SECRET (Cloudflare dashboard -> Turnstile)
 * Verification is on as soon as one service has both keys. In-app browsers
 * (TikTok, Instagram, Facebook...) skip it.
 *
 * Passing gives a signed cookie (7 days), signed with a random secret MeoDeo
 * creates once and keeps in D1 (or MEODEO_SECRET).
 */
const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const COOKIE = "meodeo_human";
export const COOKIE_DAYS = 7;

/** In-app browsers of social apps: verification is skipped there. */
export const IN_APP = /\b(TikTok|musical_ly|Bytedance|BytedanceWebview|Instagram|FBAN|FBAV|FB_IAB|FBIOS|Snapchat|Twitter|LinkedInApp|Line\/|MicroMessenger|Pinterest|Threads)\b/i;
export const isInAppBrowser = (ua) => IN_APP.test(ua || "");

/* ---------- providers ---------- */
const clean = (v) => String(v || "").trim();
/** env.NAME, or a numbered copy such as NAME1 (Cloudflare suggests one when a name is taken). */
export function setting(env, name) {
  if (clean(env[name])) return clean(env[name]);
  const alt = Object.keys(env).filter((k) => new RegExp(`^${name}_?\\d+$`).test(k)).sort()[0];
  return alt ? clean(env[alt]) : "";
}
export const PROVIDERS = {
  hcaptcha: { site: "HCAPTCHA_SITE_KEY", secret: "HCAPTCHA_SECRET", verifyUrl: "https://api.hcaptcha.com/siteverify" },
  turnstile: { site: "TURNSTILE_SITE_KEY", secret: "TURNSTILE_SECRET", verifyUrl: "https://challenges.cloudflare.com/turnstile/v0/siteverify" },
};
/** Providers with both keys set: { hcaptcha: siteKey, turnstile: siteKey }. */
export function configured(env) {
  const out = {};
  for (const [id, p] of Object.entries(PROVIDERS)) if (setting(env, p.site) && setting(env, p.secret)) out[id] = setting(env, p.site);
  return out;
}

/** Ask hCaptcha or Turnstile whether this widget answer is real. */
export async function checkToken(provider, env, token, remoteip, fetchImpl = fetch) {
  const p = PROVIDERS[provider];
  if (!p || !configured(env)[provider]) return { ok: false, reason: "not-set-up" };
  if (!token || typeof token !== "string" || token.length > 4096) return { ok: false, reason: "missing" };
  const body = new URLSearchParams({ secret: setting(env, p.secret), response: token, ...(remoteip ? { remoteip } : {}),
    ...(provider === "hcaptcha" ? { sitekey: setting(env, p.site) } : {}) });
  try {
    const res = await fetchImpl(p.verifyUrl, { method: "POST", body });
    const data = await res.json();
    return data.success ? { ok: true } : { ok: false, reason: (data["error-codes"] || ["failed"]).join(",") };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}

/* ---------- signing secret + HMAC ---------- */
let cachedSecret = null;
export async function secretFor(env) {
  if (env.MEODEO_SECRET) return env.MEODEO_SECRET;
  if (cachedSecret) return cachedSecret;
  if (!env.DB) throw new Error("no secret: set MEODEO_SECRET or bind a D1 database");
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS app_secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL)").run();
  await env.DB.prepare("INSERT OR IGNORE INTO app_secrets (name, value) VALUES ('human', ?)").bind(b64url(crypto.getRandomValues(new Uint8Array(32)))).run();
  cachedSecret = (await env.DB.prepare("SELECT value FROM app_secrets WHERE name = 'human'").first()).value;
  return cachedSecret;
}
async function hmac(secret, text) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
}
function same(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/* ---------- verified cookie ---------- */
export async function humanCookie(secret, now = Date.now()) {
  const exp = now + COOKIE_DAYS * 86_400_000;
  return `${COOKIE}=${exp}.${await hmac(secret, "human:" + exp)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_DAYS * 86400}`;
}
export async function hasHumanCookie(request, secret, now = Date.now()) {
  const m = (request.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=(\\d+)\\.([\\w-]+)`));
  if (!m || Number(m[1]) < now) return false;
  return same(m[2], await hmac(secret, "human:" + m[1]));
}

/** Is verification on here? (a service has keys, and MeoDeo can sign cookies) */
export async function verificationOn(env) {
  if (!Object.keys(configured(env)).length) return false;
  try { await secretFor(env); return true; } catch { return false; }
}

/**
 * Is this request allowed past verification? In-app browsers are let through.
 * (A user agent can be faked, so the in-app skip is a convenience, not a lock;
 * rate limits still apply.)
 */
export async function isVerified(request, env) {
  if (!(await verificationOn(env))) return true;
  if (isInAppBrowser(request.headers.get("user-agent"))) return true;
  return hasHumanCookie(request, await secretFor(env));
}

/** For endpoints that need a verified visitor: a 401 response, or null when allowed. */
export async function requireHuman(request, env) {
  if (await isVerified(request, env)) return null;
  return Response.json({ error: "Please verify you're human first.", code: "verify-required" }, { status: 401, headers: { "cache-control": "no-store" } });
}
