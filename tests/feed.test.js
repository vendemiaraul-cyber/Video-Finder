import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createPost, LIMITS } from "../server/feed.js";
import { onRequestPost as signupFn } from "../functions/api/auth/signup.js";
import { onRequestPost as loginFn } from "../functions/api/auth/login.js";
import { onRequestPost as logoutFn } from "../functions/api/auth/logout.js";
import { onRequestGet as meFn } from "../functions/api/me.js";
import { onRequestGet as feedFn } from "../functions/api/feed.js";
import { onRequestPost as postFn } from "../functions/api/posts/index.js";
import { onRequestDelete as deleteFn } from "../functions/api/posts/[id].js";

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
const req = (path, { method = "GET", body, cookie, origin = SITE, ip = "203.0.113.7" } = {}) => new Request(SITE + path, {
  method,
  headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), "cf-connecting-ip": ip },
  body: body ? JSON.stringify(body) : undefined,
});
const cookieOf = (res) => (res.headers.get("set-cookie") || "").split(";")[0];

test("sign up, who am I, log out, log in", async () => {
  const env = { DB: fakeD1() };
  const up = await signupFn({ request: req("/api/auth/signup", { method: "POST", body: { username: "raul", password: "correct horse" } }), env });
  assert.equal(up.status, 200);
  const setCookie = up.headers.get("set-cookie");
  assert.match(setCookie, /^meodeo_session=[\w-]{40,}; Path=\/; HttpOnly; Secure; SameSite=Lax/);
  const cookie = cookieOf(up);
  assert.deepEqual(await (await meFn({ request: req("/api/me", { cookie }), env })).json(), { feed: true, user: { username: "raul" } });

  assert.equal((await signupFn({ request: req("/api/auth/signup", { method: "POST", body: { username: "RAUL", password: "another one" } }), env })).status, 409);
  assert.equal((await signupFn({ request: req("/api/auth/signup", { method: "POST", body: { username: "x", password: "longenough" } }), env })).status, 400);
  assert.equal((await signupFn({ request: req("/api/auth/signup", { method: "POST", body: { username: "bob", password: "short" } }), env })).status, 400);

  await logoutFn({ request: req("/api/auth/logout", { method: "POST", cookie }), env });
  assert.deepEqual((await (await meFn({ request: req("/api/me", { cookie }), env })).json()).user, null);
  assert.equal((await loginFn({ request: req("/api/auth/login", { method: "POST", body: { username: "raul", password: "wrong pass" } }), env })).status, 401);
  const back = await loginFn({ request: req("/api/auth/login", { method: "POST", body: { username: "Raul", password: "correct horse" } }), env });
  assert.equal(back.status, 200);
  assert.equal((await back.json()).user.username, "raul");
});

test("passwords are stored hashed, never in clear", async () => {
  const env = { DB: fakeD1() };
  await signupFn({ request: req("/api/auth/signup", { method: "POST", body: { username: "ana", password: "my secret pw" } }), env });
  const row = await env.DB.prepare("SELECT * FROM users WHERE username = 'ana'").first();
  assert.ok(!JSON.stringify(row).includes("my secret pw"));
  assert.equal(row.iterations, 20000);
  const session = await env.DB.prepare("SELECT token_hash FROM sessions").first();
  assert.match(session.token_hash, /^[0-9a-f]{64}$/);
});

test("post, public feed, and deleting only your own posts", async () => {
  const env = { DB: fakeD1() };
  const a = cookieOf(await signupFn({ request: req("/api/auth/signup", { method: "POST", body: { username: "alice", password: "password1" } }), env }));
  const b = cookieOf(await signupFn({ request: req("/api/auth/signup", { method: "POST", body: { username: "bob", password: "password2" }, ip: "198.51.100.2" }), env }));

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
  const env = { DB: fakeD1() };
  await signupFn({ request: req("/api/auth/signup", { method: "POST", body: { username: "carl", password: "password3" } }), env });
  const user = await env.DB.prepare("SELECT id, username FROM users").first();
  const siteOnly = async () => ({ id: "x", site: "web", domain: "blocked.example", title: "X", url: "https://blocked.example/v", play: { kind: "link" } });
  await assert.rejects(createPost(env.DB, user, { url: "https://blocked.example/v" }, { resolveVideo: siteOnly }), (e) => e.code === "not-embeddable");
  await assert.rejects(createPost(env.DB, user, { url: "https://nothing.example/" }, { resolveVideo: async () => null }), (e) => e.code === "no-video");
});

test("cross-site writes, missing database, and sign-up limits", async () => {
  const env = { DB: fakeD1() };
  const evil = await signupFn({ request: req("/api/auth/signup", { method: "POST", origin: "https://evil.example", body: { username: "eve", password: "password4" } }), env });
  assert.equal(evil.status, 403);
  assert.equal((await feedFn({ request: req("/api/feed"), env: {} })).status, 503);
  assert.deepEqual(await (await meFn({ request: req("/api/me"), env: {} })).json(), { feed: false, user: null });
  for (let i = 0; i < LIMITS.signupsPerIpPerDay; i++) {
    assert.equal((await signupFn({ request: req("/api/auth/signup", { method: "POST", body: { username: "user" + i, password: "password5" }, ip: "192.0.2.9" }), env })).status, 200);
  }
  assert.equal((await signupFn({ request: req("/api/auth/signup", { method: "POST", body: { username: "onemore", password: "password5" }, ip: "192.0.2.9" }), env })).status, 429);
});

import { onRequestPost as probeFn } from "../functions/api/probe.js";
import { onRequestPost as reportFn } from "../functions/api/site-report.js";

test("page checks are saved in D1 and reused", async () => {
  const env = { DB: fakeD1() };
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
  const env = { DB: fakeD1() };
  for (let i = 0; i < 3; i++) {
    assert.equal((await reportFn({ request: req("/api/site-report", { method: "POST", body: { url: "https://www.blackscreen.example/v/" + i } }), env })).status, 200);
  }
  const row = await env.DB.prepare("SELECT reports FROM site_policy WHERE domain = 'blackscreen.example'").first();
  assert.equal(row.reports, 3);
});
