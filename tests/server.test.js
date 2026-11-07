import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Gol } from "../gol/gol.js";
import sites from "../gol/sites/index.js";
import { extract, allowsFraming, probe } from "../server/probe.js";
import { parseLength, querySearxng, toVideos } from "../server/searxng.js";
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

const opts = () => ({ gol, allowPrivate: true });

test("the probe refuses private addresses unless testing", async () => {
  assert.ok(isPrivateAddress("127.0.0.1") && isPrivateAddress("10.1.2.3") && isPrivateAddress("192.168.0.1"));
  assert.ok(isPrivateAddress("::1") && isPrivateAddress("::ffff:127.0.0.1") && isPrivateAddress("169.254.169.254"));
  assert.ok(!isPrivateAddress("93.184.216.34"));
  await assert.rejects(fetchPage(base + "/article"), /blocked|unsupported port/);
  const p = await probe(base + "/article", { gol });
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
  const { videos, stats } = await toVideos(results, { gol, probeOpts: { allowPrivate: true } });
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
