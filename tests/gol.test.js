import { test } from "node:test";
import assert from "node:assert/strict";
import { Gol, interleave, isSafePlay } from "../gol/gol.js";
import sites from "../gol/sites/index.js";
import { parseStart, ERRORS } from "../gol/sites/youtube.js";

const jsonFetch = (routes) => async (url) => {
  const hit = Object.entries(routes).find(([k]) => String(url).includes(k));
  if (!hit) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => hit[1] };
};
const gol = (routes = {}, keys = {}) => new Gol({ fetch: jsonFetch(routes), keys }).register(sites);

test("every site definition is valid and ids are unique", () => {
  const g = gol();
  assert.equal(g.sites.size, sites.length);
  for (const s of sites) assert.ok(s.search || s.match || s.generic, s.id);
});

test("sites that need keys are not searchable without them", () => {
  assert.ok(!gol().searchableSites().some((s) => s.id === "pexels"));
  assert.ok(gol({}, { pexelsKey: "k" }).searchableSites().some((s) => s.id === "pexels"));
});

const fakeV = (site, id) => ({ site, id });
test("interleave is round-robin and de-duplicates", () => {
  const out = interleave([[fakeV("a", 1), fakeV("a", 2), fakeV("a", 3)], [fakeV("b", 1)], [fakeV("a", 1)]]);
  assert.deepEqual(out.map((v) => v.site + v.id), ["a1", "b1", "a2", "a3"]);
});

test("search merges sites and isolates failures", async () => {
  const g = gol({
    "api.dailymotion.com": { list: [{ id: "x1", title: "D", url: "https://www.dailymotion.com/video/x1", created_time: 0 }] },
    "archive.org/advancedsearch": { response: { docs: [{ identifier: "film", title: ["Film"], creator: ["A", "B"] }] } },
  });
  const parts = [];
  const r = await g.search("cats", { sites: ["dailymotion", "archive", "nasa"], onPartial: (id) => parts.push(id) });
  assert.deepEqual(r.videos.map((v) => v.site), ["dailymotion", "archive"]);
  assert.equal(r.status.nasa.ok, false);
  assert.equal(parts.length, 3);
  const [d, a] = r.videos;
  assert.equal(d.published, "1970-01-01");
  assert.equal(d.ads, true);
  assert.equal(a.channel, "A, B");
  assert.equal(a.play.src, "https://archive.org/embed/film?autoplay=1");
});

test("slow sites time out", async () => {
  const g = new Gol({ deadlineMs: 50, fetch: (u, { signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")))) }).register(sites);
  const r = await g.search("x", { sites: ["nasa"] });
  assert.equal(r.status.nasa.error, "timed out");
});

test("YouTube falls back to Piped without a key, and always plays via youtube.com/embed", async () => {
  const g = gol({ "/search?q=": { items: [
    { type: "stream", url: "/watch?v=OFORsl11qSg", title: "Cats", uploaderName: "C", duration: 61, views: 5, uploaded: 0 },
    { type: "channel", url: "/channel/UC123" },
  ] } });
  const r = await g.search("cats", { sites: ["youtube"] });
  assert.equal(r.videos.length, 1);
  assert.equal(r.videos[0].play.src, "https://www.youtube.com/embed/OFORsl11qSg?autoplay=1&rel=0&playsinline=1");
  assert.equal(r.videos[0].ads, true);
});

test("YouTube uses the Data API when a key is set", async () => {
  const g = gol({ "googleapis.com/youtube": { items: [{ id: { videoId: "abcdefghijk" }, snippet: { title: "It&#39;s", channelTitle: "Ch", publishedAt: "2024-01-02T00:00:00Z", thumbnails: {} } }] } }, { youtubeKey: "k" });
  const [v] = (await g.search("x", { sites: ["youtube"] })).videos;
  assert.equal(v.title, "It's");
  assert.equal(v.published, "2024-01-02");
});

test("PeerTube shows the real instance domain and rejects unsafe embeds", async () => {
  const g = gol({ "sepiasearch.org": { data: [
    { uuid: "u1", name: "T", url: "https://tube.example/w/u1", embedUrl: "https://tube.example/videos/embed/u1" },
    { uuid: "u2", name: "Bad", url: "https://x.example/w/u2", embedUrl: "javascript:alert(1)" },
    { uuid: "u3", name: "Bad path", url: "https://x.example/w/u3", embedUrl: "https://x.example/evil/page" },
  ] } });
  const r = await g.search("x", { sites: ["peertube"] });
  assert.deepEqual(r.videos.map((v) => v.domain), ["tube.example"]);
});

test("Commons, NASA, Odysee and Europeana parse", async () => {
  const g = gol({
    "commons.wikimedia.org": { query: { pages: { 1: { pageid: 1, index: 1, title: "File:Cat_video.webm", imageinfo: [
      { mime: "video/webm", url: "https://upload.wikimedia.org/c.webm", descriptionurl: "https://commons.wikimedia.org/wiki/File:Cat_video.webm", duration: 3.6 }] } } } },
    "images-api.nasa.gov": { collection: { items: [{ data: [{ nasa_id: "A B", title: "Moon", center: "HQ", date_created: "2019-03-11T00:00:00Z" }] }] } },
    "lighthouse.odysee.tv": [{ claimId: "abc123", name: "cats", title: "Cats", channel: "@c" }],
    "api.europeana.eu": { items: [{ id: "/1/x", title: ["SERIES TITLE:", "Cats"], edmIsShownAt: ["http://archive.example/item"] }] },
  });
  const r = await g.search("x", { sites: ["commons", "nasa", "odysee", "europeana"] });
  const by = Object.fromEntries(r.videos.map((v) => [v.site, v]));
  assert.equal(by.commons.title, "Cat video");
  assert.equal(by.commons.play.kind, "video");
  assert.equal(by.nasa.play.sources[0].src, "https://images-assets.nasa.gov/video/A%20B/A%20B~medium.mp4");
  assert.equal(by.odysee.play.src, "https://odysee.com/$/embed/cats/abc123"); // no ?autoplay: it breaks Odysee's player
  assert.equal(by.europeana.url, "https://archive.example/item");
  assert.equal(by.europeana.title, "Cats");
  assert.equal(by.europeana.play.kind, "link");
});

test("fromUrl recognises many sites and builds official embeds", () => {
  const g = gol();
  const cases = {
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s": ["youtube", "https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0&playsinline=1&start=90"],
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ": ["youtube", null],
    "https://youtu.be/dQw4w9WgXcQ": ["youtube", null],
    "https://www.youtube.com/shorts/dQw4w9WgXcQ": ["youtube", null],
    "https://vimeo.com/76979871": ["vimeo", "https://player.vimeo.com/video/76979871?autoplay=1"],
    "https://www.dailymotion.com/video/x8qdsa6": ["dailymotion", null],
    "https://www.twitch.tv/videos/123456": ["twitch", "https://player.twitch.tv/?video=v123456&parent={parent}&autoplay=true"],
    "https://www.tiktok.com/@user/video/7300000000000000000": ["tiktok", "https://www.tiktok.com/player/v1/7300000000000000000?music_info=1&description=1&rel=0&playsinline=1"],
    "https://www.ted.com/talks/ken_robinson_do_schools_kill_creativity": ["ted", "https://embed.ted.com/talks/ken_robinson_do_schools_kill_creativity"],
    "https://streamable.com/abc12": ["streamable", null],
    "https://www.bilibili.com/video/BV1GJ411x7h7": ["bilibili", null],
    "https://www.facebook.com/somepage/videos/1234567890/": ["facebook", null],
    "https://www.instagram.com/reel/Cabc123/": ["instagram", null],
    "https://www.loom.com/share/0123456789abcdef0123456789abcdef": ["loom", null],
    "https://archive.org/details/night_of_the_living_dead": ["archive", null],
    "https://odysee.com/@chan:3/my-video:a1": ["odysee", "https://odysee.com/$/embed/my-video/a1"],
    "https://tilvids.com/w/9c9de5e8-0a1e-484a-b099-e80766180a6d": ["peertube", "https://tilvids.com/videos/embed/9c9de5e8-0a1e-484a-b099-e80766180a6d?autoplay=1"],
    "https://commons.wikimedia.org/wiki/File:Cat_lapping.webm": ["commons", null],
    "https://www.nytimes.com/video/world/123.html": ["web", null],
    "https://www.facebook.com/watch/?v=123456": ["facebook", null],
  };
  for (const [url, [site, src]] of Object.entries(cases)) {
    const v = g.fromUrl(url);
    assert.equal(v?.site, site, url);
    if (src) assert.equal(v.play.src, src, url);
  }
  assert.equal(g.fromUrl("javascript:alert(1)"), null);
  assert.equal(g.fromUrl("http://insecure.example/video"), null);
});

test("isSafePlay only allows listed embed hosts", () => {
  const yt = sites.find((s) => s.id === "youtube");
  assert.ok(isSafePlay(yt, { kind: "iframe", src: "https://www.youtube.com/embed/x" }));
  assert.ok(!isSafePlay(yt, { kind: "iframe", src: "https://evil.example/embed/x" }));
  assert.ok(!isSafePlay(yt, { kind: "video", sources: [{ src: "http://x/a.mp4" }] }));
});

test("Facebook and Instagram are marked as needing cookies", () => {
  const g = gol();
  assert.equal(g.fromUrl("https://www.facebook.com/watch/?v=123456").needsCookies, true);
  assert.equal(g.fromUrl("https://www.instagram.com/reel/Cabc123/").needsCookies, true);
  assert.equal(g.fromUrl("https://vimeo.com/76979871").needsCookies, false);
});

test("SearXNG results keep their own site and are checked against it", async () => {
  const g = gol({ "/api/search?": { videos: [
    { id: "dQw4w9WgXcQ", site: "youtube", title: "Y", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", via: "searxng",
      play: { kind: "iframe", src: "https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0&playsinline=1" } },
    { id: "https://news.example/v/1", site: "web", siteName: "news.example", domain: "news.example", title: "N", url: "https://news.example/v/1",
      play: { kind: "iframe", src: "https://player.news.example/embed/1" } },
    { id: "evil", site: "youtube", title: "E", url: "https://www.youtube.com/watch?v=evil", play: { kind: "iframe", src: "https://evil.example/x" } },
    { id: "x", site: "unknown-site", title: "U", url: "https://u.example", play: { kind: "link" } },
  ] } });
  const r = await g.search("x", { sites: ["searxng"] });
  assert.deepEqual(r.videos.map((v) => [v.site, v.siteName, v.ads]), [["youtube", "YouTube", true], ["web", "news.example", false]]);
});

test("sites marked unavailable are skipped", async () => {
  const g = gol();
  g.unavailable.set("searxng", "no server");
  assert.ok(!g.searchableSites().some((s) => s.id === "searxng"));
  const r = await g.search("x", { sites: ["searxng"] });
  assert.deepEqual(r.status, {});
});

test("YouTube links keep their start time, Shorts play vertically, and embed errors are explained", () => {
  const g = gol();
  assert.equal(parseStart("90"), 90);
  assert.equal(parseStart("1h2m3s"), 3723);
  assert.equal(parseStart("45s"), 45);
  assert.equal(parseStart("junk"), 0);
  const short = g.fromUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ");
  assert.equal(short.play.youtube.vertical, true);
  const timed = g.fromUrl("https://youtu.be/dQw4w9WgXcQ?t=42");
  assert.equal(timed.play.youtube.start, 42);
  assert.equal(timed.url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s");
  assert.match(ERRORS[150], /won't play this video here/);
  assert.equal(typeof g.sites.get("youtube").mount, "function");
});

test("YouTube search tries MeoDeo's own backend before public Piped servers", async () => {
  const asked = [];
  const g = new Gol({ fetch: async (url) => {
    asked.push(String(url));
    if (String(url).startsWith("/api/youtube")) return { ok: true, status: 200, json: async () => ({ videos: [{ id: "xc1SzgGhMKc", title: "Apollo", duration: 1192, views: 5 }] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  } }).register(sites);
  const r = await g.search("apollo", { sites: ["youtube"] });
  assert.equal(asked[0], "/api/youtube?q=apollo");
  assert.equal(asked.length, 1);
  assert.equal(r.videos[0].play.src, "https://www.youtube.com/embed/xc1SzgGhMKc?autoplay=1&rel=0&playsinline=1");
  assert.equal(r.videos[0].duration, 1192);
});

test("SearXNG checks each candidate page separately and shows results as they arrive", async () => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push(String(url));
    const ok = (data) => ({ ok: true, status: 200, json: async () => data });
    if (String(url).includes("/api/search?mode=candidates&page=1")) return ok({
      videos: [{ id: "76979871", site: "vimeo", title: "Vimeo", url: "https://vimeo.com/76979871", via: "searxng", play: { kind: "iframe", src: "https://player.vimeo.com/video/76979871" } }],
      candidates: [{ url: "https://a.example/1" }, { url: "https://b.example/1" }, { url: "https://c.example/1" }] });
    if (String(url).includes("page=2")) return ok({ videos: [], candidates: [] });
    if (String(url).endsWith("/api/probe")) {
      const u = JSON.parse(init.body).result.url;
      if (u.startsWith("https://c.")) return ok({ video: null });
      return ok({ video: { id: u, site: "web", siteName: new URL(u).hostname, domain: new URL(u).hostname, title: u, url: u, via: "searxng",
        play: u.startsWith("https://a.") ? { kind: "link" } : { kind: "video", sources: [{ src: u + ".mp4", type: "video/mp4" }] } } });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const g = new Gol({ fetch }).register(sites);
  const partials = [];
  const r = await g.search("x", { sites: ["searxng"], onPartial: (id, list) => list && partials.push(list.length) });
  assert.equal(calls.filter((c) => c.endsWith("/api/probe")).length, 3);
  assert.ok(partials.length >= 3, "results shown progressively");
  // playable first: vimeo + b (video file), then a (site only); c had no video
  assert.deepEqual(r.videos.map((v) => v.domain), ["vimeo.com", "b.example", "a.example"]);
});

import { pickSources, learn, words } from "../gol/autofilter.js";

test("Auto-Filter picks sources from the topic of the search", () => {
  const all = ["searxng", "youtube", "dailymotion", "peertube", "odysee", "archive", "commons", "nasa", "europeana"];
  assert.deepEqual(pickSources("apollo moon landing", all).sources, ["searxng", "youtube", "archive", "commons", "nasa"]);
  assert.deepEqual(pickSources("lofi music", all).topics, ["music"]);
  assert.ok(!pickSources("lofi music", all).sources.includes("nasa"));
  assert.ok(pickSources("1920s silent film", all).sources.includes("europeana"));
  assert.deepEqual(pickSources("stock drone footage", all).sources.includes("pexels"), false); // not available without a key
  assert.deepEqual(pickSources("zxqv", all).sources, ["searxng", "youtube", "dailymotion", "peertube", "odysee"]);
});

test("Auto-Filter learns which sources find things for your words", () => {
  const all = ["searxng", "youtube", "dailymotion", "peertube", "odysee", "archive", "nasa"];
  let t = {};
  for (let i = 0; i < 3; i++) t = learn(t, "zxqv capybara", { archive: { ok: true, count: 4 }, odysee: { ok: true, count: 0 }, nasa: { ok: false, count: 0 } });
  const picked = pickSources("capybara", all, t).sources;
  assert.ok(picked.includes("archive"), "archive found capybaras before");
  assert.ok(!picked.includes("odysee"), "odysee kept finding nothing");
  assert.equal(t.capybara.nasa, undefined, "a source that was down isn't judged");
  assert.deepEqual(words("The best Video of cats"), ["cats"]);
});
