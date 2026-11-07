import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Gol } from "../gol/gol.js";
import sites from "../gol/sites/index.js";
import { extract, allowsFraming, probe } from "../server/probe.js";
import { parseLength, querySearxng, querySearxngAny, checkSearxng, toVideos, skipList, DEFAULT_SKIP } from "../server/searxng.js";
import { fetchPage, isPrivateAddress } from "../server/net.js";
import { createServer, config } from "../server/server.js";

const gol = new Gol().register(sites);

/* ---------- a fake website, served locally ---------- */
const PAGES = {
  "/article": `<html><head><title>News story</title><meta property="og:image" content="https://img.example/a.jpg"></head>
    <body><iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe></body></html>`,
  "/file": `<html><head><meta property="og:title" content="Clip &amp; more"></head><body>
    <video controls><source src="https://cdn.example/clip.mp4" type="video/mp4"></video></body></html>`,
  "/jsonld": `<html><head><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"VideoObject",
    "name":"LD video","duration":"PT1M30S","thumbnailUrl":"https://img.example/ld.jpg","contentUrl":"https://cdn.example/ld.webm"}]}</script></head></html>`,
  "/novideo": `<html><head><title>Just text</title></head><body><p>Nothing to watch.</p></body></html>`,
  "/consent": `<html><body>Please accept cookies to continue.</body></html>`,
  "/wall": `<html><body><h1>Cookies are disabled</h1><p>Please enable cookies.</p></body></html>`,
};
let site, base;
before(async () => {
  site = http.createServer((req, res) => {
    if (req.url === "/gated") { res.writeHead(302, { location: "/consent?continue=/gated" }); return res.end(); }
    if (req.url === "/loop") { res.writeHead(302, { location: "/loop", "set-cookie": "check=1" }); return res.end(); }
    const body = PAGES[req.url.split("?")[0]];
    res.writeHead(body ? 200 : 404, { "content-type": "text/html" });
    res.end(body || "nope");
  });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${site.address().port}`;
});
after(() => site.close());

const opts = () => ({ gol, allowPrivate: true, fetch: fetchPage });

test("the probe refuses private addresses unless testing", async () => {
  assert.ok(isPrivateAddress("127.0.0.1") && isPrivateAddress("10.1.2.3") && isPrivateAddress("192.168.0.1"));
  assert.ok(isPrivateAddress("::1") && isPrivateAddress("::ffff:127.0.0.1") && isPrivateAddress("169.254.169.254"));
  assert.ok(!isPrivateAddress("93.184.216.34"));
  await assert.rejects(fetchPage(base + "/article"), /blocked|unsupported port/);
  const p = await probe(base + "/article", { gol, fetch: fetchPage });
  assert.equal(p.kind, "unreachable");
  assert.equal(p.reason, "blocked");
});

test("a page embedding a YouTube player plays through YouTube's own player", async () => {
  const p = await probe(base + "/article", opts());
  assert.equal(p.kind, "gol");
  assert.equal(p.video.site, "youtube");
  assert.equal(p.title, "News story");
});

test("plain video files and JSON-LD videos are found", async () => {
  const f = await probe(base + "/file", opts());
  assert.equal(f.kind, "file");
  assert.equal(f.title, "Clip & more");
  assert.deepEqual(f.sources, [{ src: "https://cdn.example/clip.mp4", type: "video/mp4" }]);
  const ld = await probe(base + "/jsonld", opts());
  assert.equal(ld.kind, "file");
  assert.equal(ld.duration, 90);
  assert.equal(ld.sources[0].type, "video/webm");
});

test("pages without video are dropped", async () => {
  assert.equal(await probe(base + "/novideo", opts()), null);
});

test("consent redirects, cookie walls and cookie-check loops mean 'needs cookies'", async () => {
  assert.equal((await probe(base + "/gated", opts())).kind, "cookies");
  assert.equal((await probe(base + "/wall", opts())).kind, "cookies");
  assert.equal((await probe(base + "/loop", opts())).kind, "cookies");
});

test("a page's own player is used only if it allows embedding", async () => {
  const page = `<meta property="og:video" content="https://player.example/embed/1"><meta property="og:video:type" content="text/html">`;
  const fake = (headers) => async (url) => url.includes("player.example")
    ? { status: 200, headers, body: "", url, chain: [url] }
    : { status: 200, headers: {}, body: page, url, chain: [url] };
  assert.equal((await probe("https://site.example/v", { gol, fetch: fake({}) })).kind, "iframe");
  assert.equal((await probe("https://site.example/v", { gol, fetch: fake({ "x-frame-options": "SAMEORIGIN" }) })).kind, "link");
  assert.equal((await probe("https://site.example/v", { gol, fetch: fake({ "content-security-policy": "frame-ancestors 'self'" }) })).kind, "link");
  assert.ok(allowsFraming({ "content-security-policy": "frame-ancestors *" }));
});

test("extract reads og, twitter and iframe data", () => {
  const x = extract(`<meta name="twitter:player" content="/embed/9"><meta property="og:image" content="//img.example/t.jpg"><iframe src="https://player.vimeo.com/video/76979871"></iframe>`, "https://s.example/page");
  assert.deepEqual(x.embeds, ["https://s.example/embed/9"]);
  assert.equal(x.thumbnail, "https://img.example/t.jpg");
  assert.equal(gol.fromUrl(x.iframes[0]).site, "vimeo");
});

test("SearXNG lengths parse in every format it uses", () => {
  assert.equal(parseLength(754.0), 754);
  assert.equal(parseLength("12:34"), 754);
  assert.equal(parseLength("1:02:03"), 3723);
  assert.equal(parseLength("PT2M"), 120);
  assert.equal(parseLength(""), undefined);
});

/* ---------- fake SearXNG ---------- */
const searxReply = (results) => ({
  query: "cats", number_of_results: 0, answers: [], corrections: [], infoboxes: [], suggestions: [],
  unresponsive_engines: [["vimeo", "timeout"]], results,
});
const jsonResponse = (status, data, type = "application/json") =>
  new Response(typeof data === "string" ? data : JSON.stringify(data), { status, headers: { "content-type": type } });

test("querySearxng asks the videos category in JSON and explains common misconfigurations", async () => {
  const urls = [];
  const ok = async (u) => { urls.push(String(u)); return jsonResponse(200, searxReply([{ url: "https://vimeo.com/1" }, { url: "https://vimeo.com/1" }])); };
  const r = await querySearxng("cats", { baseUrl: "http://sx.local", pages: 2, fetchImpl: ok });
  assert.equal(r.results.length, 1);
  assert.deepEqual(r.unresponsive, ["vimeo"]);
  assert.match(urls[0], /format=json/);
  assert.match(urls[0], /categories=videos/);
  assert.match(urls[1], /pageno=2/);
  await assert.rejects(querySearxng("x", { baseUrl: "http://sx.local", pages: 1, fetchImpl: async () => jsonResponse(403, "Forbidden", "text/html") }), /search\.formats/);
  await assert.rejects(querySearxng("x", { baseUrl: "http://sx.local", pages: 1, fetchImpl: async () => jsonResponse(200, "<html>", "text/html") }), /JSON/);
  await assert.rejects(querySearxng("x", { baseUrl: "http://sx.local", pages: 1, fetchImpl: async () => { throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }); } }), /ECONNREFUSED/);
});

test("toVideos keeps only results that offer a video", async () => {
  const results = [
    { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "Known", length: "3:33", author: "Rick", engines: ["youtube"],
      thumbnail: "http://i.ytimg.com/vi/dQw4w9WgXcQ/hq.jpg", publishedDate: "2009-10-25T00:00:00" },
    { url: base + "/article", title: "Article" },
    { url: base + "/novideo", title: "No video" },
    { url: base + "/gated", title: "Gated" },
  ];
  const { videos, stats } = await toVideos(results, { gol, probeOpts: { allowPrivate: true, fetch: fetchPage }, skip: new Set() });
  assert.equal(stats.recognised, 1);
  assert.equal(stats.probed, 3);
  assert.equal(stats.dropped, 2); // /novideo has no video; /gated is http, and Gol only keeps https links
  const [known, article] = videos;
  assert.equal(known.duration, 213);
  assert.equal(known.thumbnail, "https://i.ytimg.com/vi/dQw4w9WgXcQ/hq.jpg");
  assert.equal(known.published, "2009-10-25");
  assert.equal(known.via, "searxng");
  assert.equal(article.site, "youtube");
  assert.equal(article.url, base + "/article");
  // the local test pages are http, so Gol only keeps https results; check the gated one directly
  assert.equal((await toVideos([{ url: "https://gated.example/x" }], { gol, probeOpts: {}, cache: new Map([["probe:https://gated.example/x", { kind: "cookies" }]]) })).videos[0].needsCookies, true);
});

test("the server serves the app, health and search", async () => {
  const fakeSearx = async (u) => {
    u = String(u);
    if (u.endsWith("/config")) return jsonResponse(200, {});
    return jsonResponse(200, searxReply([{ url: "https://vimeo.com/76979871", title: "Vimeo one", length: 61 }]));
  };
  const srv = createServer({ ...config({}), searxngUrl: "http://sx.local" }, { fetchImpl: fakeSearx });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const at = `http://127.0.0.1:${srv.address().port}`;
  try {
    const home = await fetch(at + "/");
    assert.equal(home.status, 200);
    assert.match(await home.text(), /MeoDeo/);
    assert.equal((await fetch(at + "/gol/gol.js")).headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal((await fetch(at + "/server/server.js")).status, 404);
    assert.equal((await fetch(at + "/%2e%2e/%2e%2e/etc/passwd")).status, 404);
    assert.deepEqual(await (await fetch(at + "/api/health")).json(), { ok: true, app: "meodeo", searxng: true, searxngUrl: "http://sx.local" });
    const data = await (await fetch(at + "/api/search?q=cats")).json();
    assert.equal(data.videos[0].site, "vimeo");
    assert.equal(data.videos[0].duration, 61);
    assert.equal((await fetch(at + "/api/search")).status, 400);
    assert.equal((await fetch(at + "/api/search?q=x")).headers.get("access-control-allow-origin"), "*");
  } finally {
    srv.close();
  }
});

test("checkSearxng explains why SearXNG is off", async () => {
  const at = (status, body, type) => async () => jsonResponse(status, body, type);
  assert.deepEqual(await checkSearxng("http://sx", { fetchImpl: at(200, searxReply([])) }), { ok: true, url: "http://sx" });
  assert.equal((await checkSearxng("http://sx", { fetchImpl: at(403, "Forbidden", "text/html") })).reason, "json-off");
  assert.equal((await checkSearxng("http://sx", { fetchImpl: at(200, "<html>", "text/html") })).reason, "json-off");
  assert.equal((await checkSearxng("http://sx", { fetchImpl: at(429, "Too many", "text/html") })).reason, "limiter-on");
  assert.equal((await checkSearxng("http://sx", { fetchImpl: async () => { throw new Error("ECONNREFUSED"); } })).reason, "unreachable");
});

test("several SearXNG addresses are tried in order", async () => {
  const fetchImpl = async (u) => String(u).startsWith("http://down")
    ? (() => { throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }); })()
    : jsonResponse(200, searxReply([{ url: "https://vimeo.com/1" }]));
  const r = await querySearxngAny("x", { baseUrl: "http://down:8080, http://up:8080", pages: 1, fetchImpl });
  assert.equal(r.searxngUrl, "http://up:8080");
  assert.equal(r.results.length, 1);
});

test("health reports the reason when SearXNG's JSON API is off", async () => {
  const srv = createServer({ ...config({}), searxngUrl: "http://sx.local" }, { fetchImpl: async () => jsonResponse(403, "Forbidden", "text/html") });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const h = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/health`)).json();
    assert.equal(h.searxng, false);
    assert.equal(h.reason, "json-off");
    assert.equal((await fetch(`http://127.0.0.1:${srv.address().port}/searxng/settings.yml`)).status, 404);
  } finally {
    srv.close();
  }
});

import { parseWebResults, clock, count, searchYouTube } from "../server/youtube.js";
import { onRequestGet } from "../functions/api/youtube.js";

test("YouTube web results parse into videos", () => {
  const data = { contents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [
    { videoRenderer: { videoId: "xc1SzgGhMKc", title: { runs: [{ text: "Apollo 11" }] }, ownerText: { runs: [{ text: "AFJ" }] },
      lengthText: { simpleText: "19:52" }, viewCountText: { simpleText: "3,163,291 views" } } },
    { adSlotRenderer: {} },
    { videoRenderer: { videoId: "upcoming123", title: { runs: [{ text: "Soon" }] }, upcomingEventData: {} } },
    { videoRenderer: { videoId: "hzApsIPHRwo", title: { simpleText: "Footage" } } },
  ] } }] } } };
  const v = parseWebResults(data, 10);
  assert.deepEqual(v.map((x) => x.id), ["xc1SzgGhMKc", "hzApsIPHRwo"]);
  assert.equal(v[0].duration, 1192);
  assert.equal(v[0].views, 3163291);
  assert.equal(clock("1:02:03"), 3723);
  assert.equal(count("12 views"), 12);
});

test("YouTube search uses the official API when a key is set", async () => {
  let asked;
  const fetchImpl = async (u) => { asked = String(u); return jsonResponse(200, { items: [{ id: { videoId: "abcdefghijk" }, snippet: { title: "T", channelTitle: "C", publishedAt: "2024-05-01T00:00:00Z" } }] }); };
  const v = await searchYouTube("x", { apiKey: "KEY", fetchImpl });
  assert.match(asked, /googleapis\.com\/youtube\/v3\/search/);
  assert.equal(v[0].published, "2024-05-01");
});

test("the Cloudflare Pages Function answers like the Node server", async () => {
  const bad = await onRequestGet({ request: new Request("https://x.pages.dev/api/youtube"), env: {} });
  assert.equal(bad.status, 400);
});

import { workerFetchPage } from "../server/worker-fetch.js";
import { onRequestGet as searchFn } from "../functions/api/search.js";
import { onRequestGet as healthFn } from "../functions/api/health.js";

test("the Cloudflare page fetcher follows redirects like the Node one", async () => {
  const gated = await workerFetchPage(base + "/gated");
  assert.equal(gated.chain.length, 2);
  assert.match(gated.chain[1], /consent/);
  const loop = await workerFetchPage(base + "/loop");
  assert.equal(loop.loop, true);
  const file = await probe(base + "/file", { gol, fetch: workerFetchPage });
  assert.equal(file.kind, "file");
  assert.equal((await probe(base + "/novideo", { gol, fetch: workerFetchPage })), null);
});

test("the Cloudflare SearXNG functions use SEARXNG_URL and the Hugging Face token", async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (u, init = {}) => {
    seen.push({ url: String(u), auth: init.headers?.authorization, key: init.headers?.["x-meodeo-key"] });
    return jsonResponse(200, searxReply([{ url: "https://vimeo.com/76979871", title: "Vimeo one", length: 61 }]));
  };
  try {
    const env = { SEARXNG_URL: " https://someone-meodeo-searxng.hf.space\n", HF_TOKEN: "hf_test", SEARXNG_KEY: " k1\n" };
    const r = await searchFn({ request: new Request("https://x.pages.dev/api/search?q=cats"), env });
    const d = await r.json();
    assert.equal(d.videos[0].site, "vimeo");
    assert.ok(seen.every((s) => s.auth === "Bearer hf_test" && s.key === "k1"));
    assert.match(seen[0].url, /^https:\/\/someone-meodeo-searxng\.hf\.space\/search\?q=cats&format=json/);
    const h = await (await healthFn({ env })).json();
    assert.equal(h.searxng, true);
    const none = await (await healthFn({ env: {} })).json();
    assert.equal(none.reason, "not-set");
    assert.equal((await searchFn({ request: new Request("https://x.pages.dev/api/search?q=x"), env: {} })).status, 503);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Cloudflare settings saved with a number (SEARXNG_URL1) still work", async () => {
  const { setting, authHeaders } = await import("../functions/api/search.js");
  const env = { SEARXNG_URL1: " https://meodeo-searxng.onrender.com/ ", SEARXNG_KEY1: "abc\n" };
  assert.equal(setting(env, "SEARXNG_URL"), "https://meodeo-searxng.onrender.com/");
  assert.deepEqual(authHeaders(env), { "x-meodeo-key": "abc" });
  assert.equal(setting({ SEARXNG_URL: "a", SEARXNG_URL1: "b" }, "SEARXNG_URL"), "a");
  assert.equal(setting({ SEARXNG_URLX: "b" }, "SEARXNG_URL"), "");
});

test("SearXNG results from sites MeoDeo already searches are skipped, other websites are kept", async () => {
  const results = [
    { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "YouTube copy" },
    { url: "https://tilvids.com/w/9c9de5e8-0a1e-484a-b099-e80766180a6d", title: "PeerTube copy" },
    { url: "https://www.tiktok.com/@user/video/7300000000000000000", title: "TikTok" },
    { url: "https://vimeo.com/76979871", title: "Vimeo" },
    { url: base + "/article", title: "Article embedding YouTube" },
  ];
  const { videos, stats } = await toVideos(results, { gol, probeOpts: { allowPrivate: true, fetch: fetchPage } });
  assert.deepEqual(videos.map((v) => v.site), ["vimeo"]);
  assert.equal(stats.skipped, 4);
  assert.deepEqual([...skipList("")], DEFAULT_SKIP);
  assert.equal(skipList("none").size, 0);
  assert.deepEqual([...skipList("youtube, TikTok")], ["youtube", "tiktok"]);
});

test("at most 3 SearXNG results per website", async () => {
  const results = Array.from({ length: 6 }, (_, i) => ({ url: `https://vimeo.com/7697987${i}`, title: "V" + i }));
  const { videos } = await toVideos(results, { gol, probeOpts: { fetch: fetchPage } });
  assert.equal(videos.length, 3);
});
