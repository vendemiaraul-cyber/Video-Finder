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

const DAY = 86_400_000;
const SESSION_DAYS = 30;
// Cloudflare's free plan allows 10 ms of CPU per request, so PBKDF2 can't use
// a very high iteration count there. Rate limits on log-in attempts make up
// for part of that.
export const PBKDF2_ITERATIONS = 20_000;
export const USERNAME = /^[a-z0-9_]{3,20}$/i;
export const LIMITS = { signupsPerIpPerDay: 5, loginFailsPerIpPerHour: 20, postsPerUserPerDay: 30, captionLength: 280 };

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
const ready = new WeakSet();
export async function ensureSchema(db) {
  if (ready.has(db)) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
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

export async function signup(db, { username, password } = {}, ip) {
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
    WHERE (?1 IS NULL OR posts.id < ?1) ORDER BY posts.id DESC LIMIT ?2`).bind(cursor, limit).all();
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
