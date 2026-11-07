import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createPost, LIMITS } from "../server/feed.js";
import { humanCookie, checkToken, isInAppBrowser } from "../server/human.js";
import { onRequestGet as verifyGet, onRequestPost as verifyPost } from "../functions/api/verify.js";
import { onRequestPost as signupFn } from "../functions/api/auth/signup.js";
import { onRequestPost as loginFn } from "../functions/api/auth/login.js";
import { onRequestPost as logoutFn } from "../functions/api/auth/logout.js";
import { onRequestGet as meFn } from "../functions/api/me.js";
import { onRequestGet as feedFn } from "../functions/api/feed.js";
import { onRequestPost as postFn } from "../functions/api/posts/index.js";
import { onRequestDelete as deleteFn } from "../functions/api/posts/[id].js";
import { onRequestPost as postReportFn } from "../functions/api/report.js";
import { onRequestPost as takedownPost, onRequestGet as takedownGet } from "../functions/api/takedown.js";

/** A small stand-in for Cloudflare D1, on Node's built-in SQLite. */
function fakeD1() {
  const db = new DatabaseSync(":memory:");
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return { prepare: (sql) => stmt(sql), batch: async (list) => { for (const s of list) await s.run(); } };
}

const SITE = "https://meodeo.pages.dev";
// Test visitors have passed verification (env.MEODEO_SECRET signs the cookie).
const SECRET = "test-secret";
const HUMAN = (await humanCookie(SECRET)).split(";")[0];
const req = (path, { method = "GET", body, cookie, origin = SITE, ip = "203.0.113.7", human = true, ua } = {}) => new Request(SITE + path, {
  method,
  headers: { ...(body ? { "content-type": "application/json" } : {}), cookie: [human ? HUMAN : "", cookie || ""].filter(Boolean).join("; "),
             ...(origin ? { origin } : {}), "cf-connecting-ip": ip, ...(ua ? { "user-agent": ua } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});
const cookieOf = (res) => (res.headers.get("set-cookie") || "").split(";")[0];

test("sign up, who am I, log out, log in", async () => {
  const env = { DB: fakeD1(), MEODEO_SECRET: SECRET };
  const up = await signupFn({ request: req("/api/auth/signup", { method: "POST", body: { username: "raul", password: "correct horse", agree: true } }), env });
  assert.equal(up.status, 200);
  const setCookie = up.headers.get("set-cookie");
  assert.match(setCookie, /^meodeo_session=[\w-]{40,}; Path=\/; HttpOnly; Secure; SameSite=Lax/);
  const cookie = cookieOf(up);
  assert.deepEqual(await (await meFn({ request: req("/api/me", { cookie }), env })).json(), { feed: true, user: { username: "raul" } });

  assert.equal((await signupFn({ request: req("/api/auth/signup", { method: "POST", body: { username: "RAUL", password: "another one", agree: true } }), env })).status, 409);
  assert.equal((await signupFn({ request: req("/api/auth/signup", { method: "POST", body: { username: "x", password: "longenough", agree: true } }), env })).status, 400);
  assert.equal((await signupFn({ request: req("/api/auth/signup", { method: "POST", body: { username: "bob", password: "short", agree: true } }), env })).status, 400);

  await logoutFn({ request: req("/api/auth/logout", { method: "POST", cookie }), env });
  assert.deepEqual((await (await meFn({ request: req("/api/me", { cookie }), env })).json()).user, null);
  assert.equal((await loginFn({ request: req("/api/auth/login", { method: "POST", body: { username: "raul", password: "wrong pass" } }), env })).status, 401);
  const back = await loginFn({ request: req("/api/auth/login", { method: "POST", body: { username: "Raul", password: "correct horse" } }), env });
  assert.equal(back.status, 200);
  assert.equal((await back.json()).user.username, "raul");
});

test("passwords are stored hashed, never in clear", async () => {
  const env = { DB: fakeD1(), MEODEO_SECRET: SECRET };
  await signupFn({ request: req("/api/auth/signup", { method: "POST", body: { username: "ana", password: "my secret pw", agree: true } }), env });
  const row = await env.DB.prepare("SELECT * FROM users WHERE username = 'ana'").first();
  assert.ok(!JSON.stringify(row).includes("my secret pw"));
  assert.equal(row.iterations, 20000);
  const session = await env.DB.prepare("SELECT token_hash FROM sessions").first();
  assert.match(session.token_hash, /^[0-9a-f]{64}$/);
});

test("post, public feed, and deleting only your own posts", async () => {
  const env = { DB: fakeD1(), MEODEO_SECRET: SECRET };
  const a = cookieOf(await signupFn({ request: req("/api/auth/signup", { method: "POST", body: { username: "alice", password: "password1", agree: true } }), env }));
  const b = cookieOf(await signupFn({ request: req("/api/auth/signup", { method: "POST", body: { username: "bob", password: "password2", agree: true }, ip: "198.51.100.2" }), env }));

  assert.equal((await postFn({ request: req("/api/posts", { method: "POST", body: { url: "https://youtu.be/dQw4w9WgXcQ" } }), env })).status, 401);
  const res = await postFn({ request: req("/api/posts", { method: "POST", cookie: a, body: { url: "https://youtu.be/dQw4w9WgXcQ?t=42", caption: "  A classic  " } }), env });
  assert.equal(res.status, 201);
  const { post } = await res.json();
  assert.equal(post.caption, "A classic");
  assert.equal(post.video.site, "youtube");
  assert.equal(post.video.via, undefined, "a posted video isn't tagged as a SearXNG result");
  assert.equal(post.video.play.youtube.start, 42);
  assert.equal((await postFn({ request: req("/api/posts", { method: "POST", cookie: a, body: { url: "https://youtu.be/dQw4w9WgXcQ?t=42" } }), env })).status, 409);
  assert.equal((await postFn({ request: req("/api/posts", { method: "POST", cookie: a, body: { url: "http://insecure.example/v" } }), env })).status, 400);

  const anon = await (await feedFn({ request: req("/api/feed"), env })).json();
  assert.equal(anon.posts.length, 1);
  assert.equal(anon.posts[0].username, "alice");
  assert.equal(anon.posts[0].mine, false);
  assert.equal((await (await feedFn({ request: req("/api/feed", { cookie: a }), env })).json()).posts[0].mine, true);

  const del = (cookie) => deleteFn({ request: req(`/api/posts/${post.id}`, { method: "DELETE", cookie }), env, params: { id: String(post.id) } });
  assert.equal((await del(b)).status, 404);
  assert.equal((await del(a)).status, 200);
  assert.equal((await (await feedFn({ request: req("/api/feed"), env })).json()).posts.length, 0);
});

test("videos that can't play in MeoDeo aren't accepted in the feed", async () => {
  const env = { DB: fakeD1(), MEODEO_SECRET: SECRET };
  await signupFn({ request: req("/api/auth/signup", { method: "POST", body: { username: "carl", password: "password3", agree: true } }), env });
  const user = await env.DB.prepare("SELECT id, username FROM users").first();
  const siteOnly = async () => ({ id: "x", site: "web", domain: "blocked.example", title: "X", url: "https://blocked.example/v", play: { kind: "link" } });
  await assert.rejects(createPost(env.DB, user, { url: "https://blocked.example/v" }, { resolveVideo: siteOnly }), (e) => e.code === "not-embeddable");
  await assert.rejects(createPost(env.DB, user, { url: "https://nothing.example/" }, { resolveVideo: async () => null }), (e) => e.code === "no-video");
});

test("cross-site writes, missing database, and sign-up limits", async () => {
  const env = { DB: fakeD1(), MEODEO_SECRET: SECRET };
  const evil = await signupFn({ request: req("/api/auth/signup", { method: "POST", origin: "https://evil.example", body: { username: "eve", password: "password4", agree: true } }), env });
  assert.equal(evil.status, 403);
  assert.equal((await feedFn({ request: req("/api/feed"), env: {} })).status, 503);
  assert.deepEqual(await (await meFn({ request: req("/api/me"), env: {} })).json(), { feed: false, user: null });
  for (let i = 0; i < LIMITS.signupsPerIpPerDay; i++) {
    assert.equal((await signupFn({ request: req("/api/auth/signup", { method: "POST", body: { username: "user" + i, password: "password5", agree: true }, ip: "192.0.2.9" }), env })).status, 200);
  }
  assert.equal((await signupFn({ request: req("/api/auth/signup", { method: "POST", body: { username: "onemore", password: "password5", agree: true }, ip: "192.0.2.9" }), env })).status, 429);
});

import { onRequestPost as probeFn } from "../functions/api/probe.js";
import { onRequestPost as reportFn } from "../functions/api/site-report.js";

test("page checks are saved in D1 and reused", async () => {
  const env = { DB: fakeD1(), MEODEO_SECRET: SECRET };
  const call = () => probeFn({ request: req("/api/probe", { method: "POST", body: { result: { url: "https://vimeo.com/76979871", title: "Vimeo one", category: "videos" } } }), env });
  const first = await (await call()).json();
  assert.equal(first.video.site, "vimeo");
  assert.equal(first.cached, undefined);
  const second = await (await call()).json();
  assert.equal(second.cached, true);
  assert.equal(second.video.title, "Vimeo one");
  assert.equal((await probeFn({ request: req("/api/probe", { method: "POST", origin: "https://evil.example", body: { result: { url: "https://vimeo.com/1" } } }), env })).status, 403);
});

test("Not playing? reports are counted per site", async () => {
  const env = { DB: fakeD1(), MEODEO_SECRET: SECRET };
  for (let i = 0; i < 3; i++) {
    assert.equal((await reportFn({ request: req("/api/site-report", { method: "POST", body: { url: "https://www.blackscreen.example/v/" + i } }), env })).status, 200);
  }
  const row = await env.DB.prepare("SELECT reports FROM site_policy WHERE domain = 'blackscreen.example'").first();
  assert.equal(row.reports, 3);
});

// hCaptcha's and Cloudflare's published test keys (their widgets always pass with these).
const TEST_KEYS = {
  HCAPTCHA_SITE_KEY: "10000000-ffff-ffff-ffff-000000000001", HCAPTCHA_SECRET: "0x0000000000000000000000000000000000000000",
  TURNSTILE_SITE_KEY: "1x00000000000000000000AA", TURNSTILE_SECRET: "1x0000000000000000000000000000000AA",
};
/** Stand-in for hCaptcha's and Cloudflare's servers: the answer "good-token" passes. */
function fakeVerifiers() {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), body: String(init?.body || "") });
    return { json: async () => ({ success: init.body.get("response") === "good-token" }) };
  };
  return { seen, restore: () => (globalThis.fetch = real) };
}

test("hCaptcha and Turnstile answers are checked with their own servers", async () => {
  const env = { ...TEST_KEYS };
  let sent;
  const svc = async (url, init) => { sent = { url, body: String(init.body) }; return { json: async () => ({ success: init.body.get("response") === "ok", "error-codes": ["invalid-input-response"] }) }; };
  assert.deepEqual(await checkToken("hcaptcha", env, "ok", "1.2.3.4", svc), { ok: true });
  assert.equal(sent.url, "https://api.hcaptcha.com/siteverify");
  assert.match(sent.body, /secret=0x0+&response=ok&remoteip=1.2.3.4&sitekey=10000000-ffff-ffff-ffff-000000000001/);
  assert.deepEqual(await checkToken("turnstile", env, "ok", "", svc), { ok: true });
  assert.equal(sent.url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
  assert.deepEqual(await checkToken("turnstile", env, "nope", "", svc), { ok: false, reason: "invalid-input-response" });
  assert.equal((await checkToken("hcaptcha", {}, "ok", "", svc)).reason, "not-set-up");
  assert.equal((await checkToken("turnstile", env, "", "", svc)).reason, "missing");
});

test("verification: passing sets the cookie, unverified visitors can't sign up, in-app browsers skip", async () => {
  const env = { DB: fakeD1(), MEODEO_SECRET: SECRET, ...TEST_KEYS };
  const status = await (await verifyGet({ request: req("/api/verify", { human: false }), env })).json();
  assert.deepEqual(status, { required: true, inApp: false, verified: false, hcaptchaSiteKey: TEST_KEYS.HCAPTCHA_SITE_KEY, turnstileSiteKey: TEST_KEYS.TURNSTILE_SITE_KEY });
  const blocked = await signupFn({ request: req("/api/auth/signup", { method: "POST", human: false, body: { username: "bot", password: "password9", agree: true } }), env });
  assert.equal(blocked.status, 401);
  assert.equal((await blocked.json()).code, "verify-required");

  const svc = fakeVerifiers();
  try {
    assert.equal((await verifyPost({ request: req("/api/verify", { method: "POST", human: false, body: { method: "hcaptcha", token: "bad" } }), env })).status, 400);
    for (const method of ["hcaptcha", "turnstile"]) {
      const ok = await verifyPost({ request: req("/api/verify", { method: "POST", human: false, body: { method, token: "good-token" } }), env });
      assert.equal(ok.status, 200, method);
      assert.match(ok.headers.get("set-cookie"), /^meodeo_human=\d+\.[\w-]+; Path=\/; HttpOnly; Secure; SameSite=Lax/);
    }
    assert.ok(svc.seen.some((c) => c.url.includes("hcaptcha.com")) && svc.seen.some((c) => c.url.includes("challenges.cloudflare.com")));
  } finally { svc.restore(); }

  const signedUp = await signupFn({ request: req("/api/auth/signup", { method: "POST", body: { username: "real_person", password: "password9", agree: true } }), env });
  assert.equal(signedUp.status, 200);

  const tiktok = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 musical_ly_37.5.0 BytedanceWebview/d8a21c6";
  assert.ok(isInAppBrowser(tiktok) && isInAppBrowser("Instagram 350.0") && !isInAppBrowser("Mozilla/5.0 Safari/604.1"));
  assert.equal((await (await verifyGet({ request: req("/api/verify", { human: false, ua: tiktok }), env })).json()).verified, true);
  assert.equal((await signupFn({ request: req("/api/auth/signup", { method: "POST", human: false, ua: tiktok, body: { username: "tiktok_user", password: "password9", agree: true } }), env })).status, 200);
  assert.equal((await verifyPost({ request: req("/api/verify", { method: "POST", human: false, body: { method: "inapp" } }), env })).status, 400);
});

test("only the services with keys are offered", async () => {
  const env = { DB: fakeD1(), MEODEO_SECRET: SECRET, TURNSTILE_SITE_KEY: "1x00000000000000000000AA", TURNSTILE_SECRET: "1x0000000000000000000000000000000AA" };
  const st = await (await verifyGet({ request: req("/api/verify", { human: false }), env })).json();
  assert.equal(st.hcaptchaSiteKey, null);
  assert.equal(st.turnstileSiteKey, "1x00000000000000000000AA");
});

test("verification stays off until a service has its keys", async () => {
  assert.deepEqual(await (await verifyGet({ request: req("/api/verify", { human: false }), env: {} })).json(), { required: false });
  const env = { DB: fakeD1(), MEODEO_SECRET: SECRET }; // database, but no keys yet
  assert.deepEqual(await (await verifyGet({ request: req("/api/verify", { human: false }), env })).json(), { required: false });
  assert.equal((await signupFn({ request: req("/api/auth/signup", { method: "POST", human: false, body: { username: "early_bird", password: "password9", agree: true } }), env })).status, 200);
});

test("sign-up needs the 13+ and Terms agreement", async () => {
  const env = { DB: fakeD1(), MEODEO_SECRET: SECRET };
  const res = await signupFn({ request: req("/api/auth/signup", { method: "POST", body: { username: "kid", password: "password10" } }), env });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "terms");
});

test("reported posts are hidden after three different reporters", async () => {
  const env = { DB: fakeD1(), MEODEO_SECRET: SECRET };
  const a = cookieOf(await signupFn({ request: req("/api/auth/signup", { method: "POST", body: { username: "poster", password: "password11", agree: true } }), env }));
  const { post } = await (await postFn({ request: req("/api/posts", { method: "POST", cookie: a, body: { url: "https://youtu.be/dQw4w9WgXcQ" } }), env })).json();
  const report = (ip, reason = "spam") => postReportFn({ request: req("/api/report", { method: "POST", ip, body: { postId: post.id, reason } }), env });
  assert.equal((await report("192.0.2.1", "not-a-reason")).status, 400);
  assert.equal((await (await report("192.0.2.1")).json()).hidden, false);
  assert.equal((await (await report("192.0.2.1")).json()).hidden, false, "the same person reporting twice counts once");
  assert.equal((await (await report("192.0.2.2", "copyright")).json()).hidden, false);
  assert.equal((await (await feedFn({ request: req("/api/feed"), env })).json()).posts.length, 1);
  assert.equal((await (await report("192.0.2.3", "adult")).json()).hidden, true);
  assert.equal((await (await feedFn({ request: req("/api/feed"), env })).json()).posts.length, 0);
  assert.equal((await postReportFn({ request: req("/api/report", { method: "POST", origin: "https://evil.example", body: { postId: post.id, reason: "spam" } }), env })).status, 403);
});

test("takedown requests remove the link from the feed and future posts", async () => {
  const env = { DB: fakeD1(), MEODEO_SECRET: SECRET };
  const a = cookieOf(await signupFn({ request: req("/api/auth/signup", { method: "POST", body: { username: "uploader", password: "password12", agree: true } }), env }));
  await postFn({ request: req("/api/posts", { method: "POST", cookie: a, body: { url: "https://youtu.be/dQw4w9WgXcQ" } }), env });
  const notice = { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=abc", name: "Rights Holder Ltd", contact: "legal@example.com",
                   work: "Our music video", kind: "copyright", sworn: true };
  assert.equal((await takedownPost({ request: req("/api/takedown", { method: "POST", body: { ...notice, sworn: false } }), env })).status, 400);
  const res = await takedownPost({ request: req("/api/takedown", { method: "POST", body: notice }), env });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).hiddenPosts, 1);
  assert.equal((await (await feedFn({ request: req("/api/feed"), env })).json()).posts.length, 0);
  assert.deepEqual((await (await takedownGet({ request: req("/api/takedown"), env })).json()).removed, ["https://youtube.com/watch?v=dQw4w9WgXcQ"]);
  const again = await postFn({ request: req("/api/posts", { method: "POST", cookie: a, body: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } }), env });
  assert.equal(again.status, 451);
});

test("adult or shock videos aren't accepted in the feed", async () => {
  const env = { DB: fakeD1(), MEODEO_SECRET: SECRET };
  await signupFn({ request: req("/api/auth/signup", { method: "POST", body: { username: "dave", password: "password13", agree: true } }), env });
  const user = await env.DB.prepare("SELECT id, username FROM users").first();
  const vid = (title, url = "https://vimeo.com/1") => async () => ({ id: "1", site: "vimeo", domain: "vimeo.com", title, url, play: { kind: "iframe", src: "https://player.vimeo.com/video/1" } });
  await assert.rejects(createPost(env.DB, user, { url: "https://vimeo.com/1" }, { resolveVideo: vid("NSFW compilation") }), (e) => e.code === "not-allowed");
  await assert.rejects(createPost(env.DB, user, { url: "https://vimeo.com/2", caption: "hot nudes" }, { resolveVideo: vid("Holiday") }), (e) => e.code === "not-allowed");
  const ok = await createPost(env.DB, user, { url: "https://vimeo.com/3" }, { resolveVideo: vid("Moon visible to the naked eye") });
  assert.equal(ok.video.title, "Moon visible to the naked eye");
});

test("Pexels key stays private on the server", async () => {
  const { onRequestGet: pexelsFn } = await import("../functions/api/pexels.js");
  const KEY = "secret-pexels-key-123";
  const env = { DB: fakeD1(), PEXELS_API_KEY: KEY };
  let calls = 0, sentKey = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls++; sentKey = opts.headers.authorization;
    assert.match(String(url), /^https:\/\/api\.pexels\.com\/videos\/search\?/);
    return Response.json({ videos: [
      { id: 1, url: "https://www.pexels.com/video/moon-rising-123/", image: "https://images.pexels.com/1.jpg", duration: 9, user: { name: "Ana" },
        video_files: [{ file_type: "video/mp4", width: 1280, link: "https://videos.pexels.com/1.mp4" }] },
      { id: 2, url: "https://www.pexels.com/video/nsfw-thing-2/", image: "https://images.pexels.com/2.jpg",
        video_files: [{ file_type: "video/mp4", width: 1280, link: "https://videos.pexels.com/2.mp4" }] },
    ] });
  };
  try {
    const get = (opts) => pexelsFn({ request: req("/api/pexels?q=Moon", opts), env });
    assert.deepEqual(await (await pexelsFn({ request: req("/api/pexels?check=1"), env })).json(), { ready: true });
    const res = await get();
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.ok(!body.includes(KEY), "the key never reaches the browser");
    assert.equal(sentKey, KEY, "the key is only sent to Pexels");
    const { videos } = JSON.parse(body);
    assert.deepEqual(videos.map((v) => v.title), ["moon rising"], "the content filter applies");
    await get(); // same search again: served from the cache
    assert.equal(calls, 1);
    assert.equal((await get({ origin: "https://evil.example" })).status, 403, "other websites can't spend the key");
    assert.equal((await pexelsFn({ request: req("/api/pexels?q=x"), env: { DB: fakeD1() } })).status, 503);
    assert.deepEqual(await (await pexelsFn({ request: req("/api/pexels?check=1"), env: {} })).json(), { ready: false });
  } finally {
    globalThis.fetch = realFetch;
  }
});
