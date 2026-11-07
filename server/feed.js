/**
 * MeoDeo public feed: accounts, posts and the feed itself, on Cloudflare D1
 * (SQLite). Everyone can read the feed; posting needs a MeoDeo account.
 *
 * Security notes:
 * - Passwords are stored as salted PBKDF2-SHA-256 hashes, never in clear.
 * - Session cookies are random 256-bit tokens; the database keeps only their
 *   SHA-256 hash, so a database leak doesn't reveal live sessions.
 * - IP addresses are only used, hashed, for rate limits.
 */

import { unsafeReason, canonicalUrl, domainOf } from "../gol/safety.js";

const DAY = 86_400_000;
const SESSION_DAYS = 30;
// Cloudflare's free plan allows 10 ms of CPU per request, so PBKDF2 can't use
// a very high iteration count there. Rate limits on log-in attempts make up
// for part of that.
export const PBKDF2_ITERATIONS = 20_000;
export const USERNAME = /^[a-z0-9_]{3,20}$/i;
export const LIMITS = { signupsPerIpPerDay: 5, loginFailsPerIpPerHour: 20, postsPerUserPerDay: 30, captionLength: 280,
  reportsPerIpPerDay: 30, reportsToHide: 3, takedownsPerIpPerDay: 10 };
export const REPORT_REASONS = ["copyright", "adult", "violence", "hate", "spam", "other"];

export class FeedError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
     pass_hash TEXT NOT NULL, salt TEXT NOT NULL, iterations INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, url TEXT NOT NULL,
     caption TEXT NOT NULL DEFAULT '', video_json TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS posts_user_time ON posts (user_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS rate_limits (key TEXT NOT NULL, window_start INTEGER NOT NULL, count INTEGER NOT NULL,
     PRIMARY KEY (key, window_start))`,
  `CREATE TABLE IF NOT EXISTS site_policy (domain TEXT PRIMARY KEY, allowed INTEGER NOT NULL DEFAULT 0, inside INTEGER NOT NULL DEFAULT 0,
     blocked INTEGER NOT NULL DEFAULT 0, cookies INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0)`,
];
// Added after the first release: applied one by one, ignoring "already exists".
const MIGRATIONS = [
  "ALTER TABLE site_policy ADD COLUMN reports INTEGER NOT NULL DEFAULT 0",
  "CREATE TABLE IF NOT EXISTS probe_cache (url TEXT PRIMARY KEY, result_json TEXT NOT NULL, checked_at INTEGER NOT NULL)",
  // Moderation: reported posts are hidden after a few reports; takedown requests hide a link at once.
  "ALTER TABLE posts ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0",
  `CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL, reporter TEXT NOT NULL,
     reason TEXT NOT NULL, details TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, UNIQUE (post_id, reporter))`,
  `CREATE TABLE IF NOT EXISTS takedowns (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, canonical TEXT NOT NULL,
     name TEXT NOT NULL, contact TEXT NOT NULL, work TEXT NOT NULL, kind TEXT NOT NULL, details TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'removed', created_at INTEGER NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS takedowns_canonical ON takedowns (canonical, status)",
  // Cached answers from APIs with small free allowances (Pexels).
  "CREATE TABLE IF NOT EXISTS api_cache (key TEXT PRIMARY KEY, result_json TEXT NOT NULL, checked_at INTEGER NOT NULL)",
  // Websites MeoDeo's owner banned (on top of the built-in list in gol/safety.js).
  "CREATE TABLE IF NOT EXISTS banned_sites (domain TEXT PRIMARY KEY, reason TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)",
];
const ready = new WeakSet();
export async function ensureSchema(db) {
  if (ready.has(db)) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  for (const sql of MIGRATIONS) {
    try { await db.prepare(sql).run(); } catch { /* already applied */ }
  }
  ready.add(db);
}

/* ---------- crypto helpers (Web Crypto: Cloudflare and Node 18+) ---------- */
const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
export async function sha256(text) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function hashPassword(password, salt = randomToken(16), iterations = PBKDF2_ITERATIONS) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations }, key, 256);
  return { hash: b64url(bits), salt, iterations };
}
function sameText(a, b) { // constant-time comparison
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ---------- rate limits ---------- */
export async function rateLimit(db, key, windowMs, max, now = Date.now()) {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const row = await db.prepare(`INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
    ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1 RETURNING count`).bind(key, windowStart).first();
  if (row.count > max) throw new FeedError(429, "rate-limited", "Too many tries. Please wait a while and try again.");
}
const ipKey = async (kind, ip) => `${kind}:${(await sha256("meodeo-ip:" + (ip || "unknown"))).slice(0, 24)}`;

/* ---------- accounts ---------- */
async function createSession(db, userId, now = Date.now()) {
  const token = randomToken();
  await db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256(token), userId, now + SESSION_DAYS * DAY).run();
  return token;
}

export async function signup(db, { username, password, agree } = {}, ip) {
  if (agree !== true) throw new FeedError(400, "terms", "Please confirm you're 13 or older and agree to MeoDeo's Terms and Rules.");
  username = String(username || "").trim();
  password = String(password || "");
  if (!USERNAME.test(username)) throw new FeedError(400, "bad-username", "Usernames are 3 to 20 letters, numbers or _.");
  if (password.length < 8) throw new FeedError(400, "weak-password", "Use a password of at least 8 characters.");
  if (password.length > 200) throw new FeedError(400, "long-password", "That password is too long.");
  await rateLimit(db, await ipKey("signup", ip), DAY, LIMITS.signupsPerIpPerDay);
  if (await db.prepare("SELECT 1 FROM users WHERE username = ?").bind(username).first()) {
    throw new FeedError(409, "taken", "That username is taken.");
  }
  const { hash, salt, iterations } = await hashPassword(password);
  const user = await db.prepare(`INSERT INTO users (username, pass_hash, salt, iterations, created_at) VALUES (?, ?, ?, ?, ?)
    RETURNING id, username`).bind(username, hash, salt, iterations, Date.now()).first();
  return { user: { id: user.id, username: user.username }, token: await createSession(db, user.id) };
}

export async function login(db, { username, password } = {}, ip) {
  username = String(username || "").trim();
  password = String(password || "");
  const failKey = await ipKey("loginfail", ip);
  const user = await db.prepare("SELECT id, username, pass_hash, salt, iterations FROM users WHERE username = ?").bind(username).first();
  const check = await hashPassword(password, user?.salt || "no-such-user", user?.iterations || PBKDF2_ITERATIONS);
  if (!user || !sameText(check.hash, user.pass_hash)) {
    await rateLimit(db, failKey, DAY / 24, LIMITS.loginFailsPerIpPerHour);
    throw new FeedError(401, "bad-login", "Wrong username or password.");
  }
  return { user: { id: user.id, username: user.username }, token: await createSession(db, user.id) };
}

export function sessionToken(request) {
  const m = (request.headers.get("cookie") || "").match(/(?:^|;\s*)meodeo_session=([A-Za-z0-9_-]{20,})/);
  return m ? m[1] : null;
}

export async function currentUser(db, request, now = Date.now()) {
  const token = sessionToken(request);
  if (!token) return null;
  return await db.prepare(`SELECT users.id AS id, users.username AS username FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?`).bind(await sha256(token), now).first();
}

export async function logout(db, request) {
  const token = sessionToken(request);
  if (token) await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
}

/* ---------- posts and feed ---------- */
const KEEP = ["id", "site", "siteName", "domain", "ads", "needsCookies", "title", "url", "thumbnail", "duration", "channel", "published", "play", "via", "note"];
const slim = (v) => Object.fromEntries(KEEP.filter((k) => v[k] !== undefined).map((k) => [k, v[k]]));

/** Plays inside MeoDeo: a player, a video file, or a page that may be shown inside it. */
export const playsInMeoDeo = (v) => v.play.kind !== "link" || !!v.play.inside;

/**
 * Post a video link to the feed.
 * resolveVideo(url) turns the link into a Gol video (or null).
 */
export async function createPost(db, user, { url, caption } = {}, { resolveVideo }) {
  if (!user) throw new FeedError(401, "login-required", "Sign in to post.");
  url = String(url || "").trim();
  caption = String(caption || "").trim().slice(0, LIMITS.captionLength);
  let parsed;
  try { parsed = new URL(url); } catch { throw new FeedError(400, "bad-url", "That doesn't look like a link."); }
  if (parsed.protocol !== "https:") throw new FeedError(400, "bad-url", "Use an https:// link.");
  const since = Date.now() - DAY;
  const recent = await db.prepare("SELECT COUNT(*) AS n FROM posts WHERE user_id = ? AND created_at > ?").bind(user.id, since).first();
  if (recent.n >= LIMITS.postsPerUserPerDay) throw new FeedError(429, "rate-limited", `You can post up to ${LIMITS.postsPerUserPerDay} videos a day.`);
  if (await db.prepare("SELECT 1 FROM posts WHERE user_id = ? AND url = ? AND created_at > ?").bind(user.id, parsed.href, since).first()) {
    throw new FeedError(409, "duplicate", "You already posted that video today.");
  }
  const video = await resolveVideo(parsed.href);
  if (!video) throw new FeedError(422, "no-video", "MeoDeo couldn't find a video at that link.");
  if (!playsInMeoDeo(video)) throw new FeedError(422, "not-embeddable", `${video.domain} doesn't let its videos play in MeoDeo, so it can't go in the feed.`);
  const bannedSites = await listBannedSites(db);
  if (unsafeReason({ ...video, description: caption + " " + (video.description || "") }, { bannedSites })
      || unsafeReason({ url: parsed.href }, { bannedSites })) {
    throw new FeedError(422, "not-allowed", "That video breaks MeoDeo's rules (no adult, shock or pirated content), so it can't go in the feed.");
  }
  if (await isTakenDown(db, [parsed.href, video.url])) throw new FeedError(451, "taken-down", "That video was removed from MeoDeo after a copyright or legal request.");
  const row = await db.prepare(`INSERT INTO posts (user_id, url, caption, video_json, created_at) VALUES (?, ?, ?, ?, ?)
    RETURNING id, created_at`).bind(user.id, parsed.href, caption, JSON.stringify(slim(video)), Date.now()).first();
  return { id: row.id, username: user.username, caption, createdAt: row.created_at, video: slim(video), mine: true };
}

export async function listFeed(db, { before, limit = 20, user } = {}) {
  limit = Math.max(1, Math.min(50, Number(limit) || 20));
  const cursor = Number(before) > 0 ? Number(before) : null;
  const { results } = await db.prepare(`SELECT posts.id AS id, posts.user_id AS user_id, posts.caption AS caption, posts.video_json AS video_json,
      posts.created_at AS created_at, users.username AS username
    FROM posts JOIN users ON users.id = posts.user_id
    WHERE posts.hidden = 0 AND (?1 IS NULL OR posts.id < ?1) ORDER BY posts.id DESC LIMIT ?2`).bind(cursor, limit).all();
  const posts = results.map((r) => ({
    id: r.id, username: r.username, caption: r.caption, createdAt: r.created_at,
    video: JSON.parse(r.video_json), mine: !!user && user.id === r.user_id,
  }));
  return { posts, next: posts.length === limit ? posts[posts.length - 1].id : null };
}

export async function deletePost(db, user, id) {
  if (!user) throw new FeedError(401, "login-required", "Sign in first.");
  const res = await db.prepare("DELETE FROM posts WHERE id = ? AND user_id = ?").bind(Number(id), user.id).run();
  if (!res.meta?.changes) throw new FeedError(404, "not-found", "That post doesn't exist or isn't yours.");
}

/* ---------- moderation: reports and takedowns ---------- */

/** Who is reporting: the account when signed in, otherwise a hashed IP (never the IP itself). */
const reporterKey = async (user, ip) => (user ? `user:${user.id}` : await ipKey("reporter", ip));

/**
 * Report a feed post. After LIMITS.reportsToHide different people report it,
 * the post is hidden from the feed (the owner can restore it in the D1 console).
 */
export async function reportPost(db, user, { postId, reason, details } = {}, ip) {
  const id = Number(postId);
  if (!(id > 0)) throw new FeedError(400, "bad-post", "Which post?");
  if (!REPORT_REASONS.includes(reason)) throw new FeedError(400, "bad-reason", "Pick a reason for the report.");
  details = String(details || "").trim().slice(0, 1000);
  await rateLimit(db, await ipKey("report", ip), DAY, LIMITS.reportsPerIpPerDay);
  const post = await db.prepare("SELECT id, user_id FROM posts WHERE id = ?").bind(id).first();
  if (!post) throw new FeedError(404, "not-found", "That post doesn't exist anymore.");
  const reporter = await reporterKey(user, ip);
  await db.prepare(`INSERT INTO reports (post_id, reporter, reason, details, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (post_id, reporter) DO UPDATE SET reason = excluded.reason, details = excluded.details`).bind(id, reporter, reason, details, Date.now()).run();
  const { n } = await db.prepare("SELECT COUNT(*) AS n FROM reports WHERE post_id = ?").bind(id).first();
  const hidden = n >= LIMITS.reportsToHide;
  if (hidden) await db.prepare("UPDATE posts SET hidden = 1 WHERE id = ?").bind(id).run();
  return { ok: true, hidden };
}

/** Links removed after a takedown request (canonical form). */
export async function isTakenDown(db, urls) {
  const keys = [...new Set(urls.map(canonicalUrl).filter(Boolean))];
  if (!keys.length) return false;
  const row = await db.prepare(`SELECT 1 FROM takedowns WHERE status = 'removed' AND canonical IN (${keys.map(() => "?").join(",")}) LIMIT 1`).bind(...keys).first();
  return !!row;
}

export const TAKEDOWN_KINDS = ["copyright", "trademark", "privacy", "illegal", "other"];

/**
 * A takedown request (copyright / DMCA-style notice, privacy, illegal content).
 * The link is removed from MeoDeo straight away: feed posts with it are hidden
 * and it's left out of search results. The owner reviews requests in the D1
 * console and can restore a link by setting its status to 'rejected'.
 */
export async function requestTakedown(db, { url, name, contact, work, kind, details, sworn } = {}, ip) {
  const clean = (v, max) => String(v || "").trim().slice(0, max);
  url = clean(url, 2000); name = clean(name, 200); contact = clean(contact, 300); work = clean(work, 1000); details = clean(details, 3000);
  const canonical = canonicalUrl(url);
  if (!canonical || !/^https:\/\//.test(canonical)) throw new FeedError(400, "bad-url", "Give the https:// link of the video (on MeoDeo or on its website).");
  if (!name || !contact) throw new FeedError(400, "who", "Your name and a way to contact you (email or address) are needed.");
  if (!work) throw new FeedError(400, "work", "Describe the work or right this is about.");
  if (!TAKEDOWN_KINDS.includes(kind)) throw new FeedError(400, "kind", "Pick what kind of request this is.");
  if (sworn !== true) throw new FeedError(400, "sworn", "Please confirm the statement at the end of the form.");
  await rateLimit(db, await ipKey("takedown", ip), DAY, LIMITS.takedownsPerIpPerDay);
  const now = Date.now();
  const row = await db.prepare(`INSERT INTO takedowns (url, canonical, name, contact, work, kind, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).bind(url, canonical, name, contact, work, kind, details, now).first();
  // Hide feed posts of that video: matched by the posted link or the video's own link,
  // or by a MeoDeo post link (…/#post-<id>).
  const postId = Number((url.match(/#post-(\d+)$/) || [])[1]);
  const { results } = await db.prepare("SELECT id, url, video_json FROM posts WHERE hidden = 0").all();
  const hide = results.filter((p) => p.id === postId || canonicalUrl(p.url) === canonical
    || (() => { try { return canonicalUrl(JSON.parse(p.video_json).url) === canonical; } catch { return false; } })());
  for (const p of hide) await db.prepare("UPDATE posts SET hidden = 1 WHERE id = ?").bind(p.id).run();
  return { ok: true, id: row.id, hiddenPosts: hide.length };
}

/** Removed links, for leaving them out of search results. */
export async function listTakenDown(db) {
  const { results } = await db.prepare("SELECT DISTINCT canonical FROM takedowns WHERE status = 'removed' ORDER BY id DESC LIMIT 5000").all();
  return results.map((r) => r.canonical);
}

/* ---------- the owner's ban list and moderation tools ---------- */

export async function listBannedSites(db) {
  const { results } = await db.prepare("SELECT domain FROM banned_sites ORDER BY domain").all();
  return results.map((r) => r.domain);
}

/** Ban a website (and its subdomains): it disappears from search and the feed, and can't be posted. */
export async function banSite(db, input, reason = "") {
  const domain = domainOf(input);
  if (!domain) throw new FeedError(400, "bad-domain", "That isn't a website address. Example: badsite.com");
  await db.prepare(`INSERT INTO banned_sites (domain, reason, created_at) VALUES (?, ?, ?)
    ON CONFLICT(domain) DO UPDATE SET reason = excluded.reason`).bind(domain, String(reason || "").trim().slice(0, 300), Date.now()).run();
  // Hide feed posts from it straight away.
  const { results } = await db.prepare("SELECT id, url, video_json FROM posts WHERE hidden = 0").all();
  let hidden = 0;
  for (const p of results) {
    let v = {};
    try { v = JSON.parse(p.video_json); } catch { /* keep {} */ }
    if (unsafeReason({ ...v, url: v.url || p.url }, { bannedSites: [domain] }) || unsafeReason({ url: p.url }, { bannedSites: [domain] })) {
      await db.prepare("UPDATE posts SET hidden = 1 WHERE id = ?").bind(p.id).run();
      hidden++;
    }
  }
  return { domain, hiddenPosts: hidden };
}

export async function unbanSite(db, input) {
  const domain = domainOf(input);
  const res = await db.prepare("DELETE FROM banned_sites WHERE domain = ?").bind(domain).run();
  if (!res.meta?.changes) throw new FeedError(404, "not-banned", "That website isn't on the ban list.");
  return { domain };
}

/** Everything the owner reviews, as text only (no thumbnails or players). */
export async function moderationOverview(db) {
  const banned = (await db.prepare("SELECT domain, reason, created_at FROM banned_sites ORDER BY created_at DESC").all()).results;
  const takedowns = (await db.prepare(`SELECT id, url, kind, name, contact, work, details, status, created_at
    FROM takedowns ORDER BY id DESC LIMIT 100`).all()).results;
  const reports = (await db.prepare(`SELECT reports.post_id AS post_id, reports.reason AS reason, reports.details AS details, reports.created_at AS created_at,
      posts.url AS url, posts.hidden AS hidden
    FROM reports LEFT JOIN posts ON posts.id = reports.post_id ORDER BY reports.id DESC LIMIT 200`).all()).results;
  const hiddenPosts = (await db.prepare(`SELECT posts.id AS id, posts.url AS url, posts.caption AS caption, users.username AS username
    FROM posts JOIN users ON users.id = posts.user_id WHERE posts.hidden = 1 ORDER BY posts.id DESC LIMIT 100`).all()).results;
  return { banned, takedowns, reports, hiddenPosts };
}

export async function setPostHidden(db, id, hidden) {
  const res = await db.prepare("UPDATE posts SET hidden = ? WHERE id = ?").bind(hidden ? 1 : 0, Number(id)).run();
  if (!res.meta?.changes) throw new FeedError(404, "not-found", "No post with that number.");
  return { id: Number(id), hidden: !!hidden };
}

export async function deletePostAsOwner(db, id) {
  const res = await db.prepare("DELETE FROM posts WHERE id = ?").bind(Number(id)).run();
  if (!res.meta?.changes) throw new FeedError(404, "not-found", "No post with that number.");
  await db.prepare("DELETE FROM reports WHERE post_id = ?").bind(Number(id)).run();
  return { id: Number(id), deleted: true };
}

export async function setTakedownStatus(db, id, status) {
  if (!["removed", "rejected"].includes(status)) throw new FeedError(400, "bad-status", "Status is removed or rejected.");
  const res = await db.prepare("UPDATE takedowns SET status = ? WHERE id = ?").bind(status, Number(id)).run();
  if (!res.meta?.changes) throw new FeedError(404, "not-found", "No request with that number.");
  return { id: Number(id), status };
}

/** Constant-time check of the owner's admin password (ADMIN_KEY), with a limit on wrong tries. */
export async function checkAdmin(db, given, adminKey, ip) {
  if (!adminKey) throw new FeedError(503, "admin-off", "The admin page isn't set up: add an ADMIN_KEY secret in Cloudflare.");
  const a = await sha256("meodeo-admin:" + String(given || "")), b = await sha256("meodeo-admin:" + adminKey);
  if (!sameText(a, b)) {
    await rateLimit(db, await ipKey("adminfail", ip), DAY / 24, 10);
    throw new FeedError(401, "bad-admin", "Wrong admin password.");
  }
}
