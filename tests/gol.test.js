import { test } from "node:test";
import assert from "node:assert/strict";
import { Gol, interleave, isSafePlay } from "../gol/gol.js";
import sites from "../gol/sites/index.js";
import { buildVideos, findWithClaude, urlKey } from "../claude/finder.js";

const jsonFetch = (routes) => async (url) => {
  const hit = Object.entries(routes).find(([k]) => String(url).includes(k));
  if (!hit) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => hit[1] };
};
const gol = (routes = {}, keys = {}) => new Gol({ fetch: jsonFetch(routes), keys }).register(sites);

test("every site definition is valid and ids are unique", () => {
  const g = gol();
  assert.equal(g.sites.size, sites.length);
  for (const s of sites) assert.ok(s.search || s.match, s.id);
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
  assert.equal(r.videos[0].play.src, "https://www.youtube.com/embed/OFORsl11qSg?autoplay=1&rel=0");
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
  assert.equal(by.odysee.play.src, "https://odysee.com/$/embed/cats/abc123?autoplay=1");
  assert.equal(by.europeana.url, "https://archive.example/item");
  assert.equal(by.europeana.title, "Cats");
  assert.equal(by.europeana.play.kind, "link");
});

test("fromUrl recognises many sites and builds official embeds", () => {
  const g = gol();
  const cases = {
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1": ["youtube", "https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0"],
    "https://youtu.be/dQw4w9WgXcQ": ["youtube", null],
    "https://www.youtube.com/shorts/dQw4w9WgXcQ": ["youtube", null],
    "https://vimeo.com/76979871": ["vimeo", "https://player.vimeo.com/video/76979871?autoplay=1"],
    "https://www.dailymotion.com/video/x8qdsa6": ["dailymotion", null],
    "https://www.twitch.tv/videos/123456": ["twitch", "https://player.twitch.tv/?video=v123456&parent={parent}&autoplay=true"],
    "https://www.tiktok.com/@user/video/7300000000000000000": ["tiktok", null],
    "https://www.ted.com/talks/ken_robinson_do_schools_kill_creativity": ["ted", "https://embed.ted.com/talks/ken_robinson_do_schools_kill_creativity"],
    "https://streamable.com/abc12": ["streamable", null],
    "https://www.bilibili.com/video/BV1GJ411x7h7": ["bilibili", null],
    "https://www.facebook.com/somepage/videos/1234567890/": ["facebook", null],
    "https://www.instagram.com/reel/Cabc123/": ["instagram", null],
    "https://www.loom.com/share/0123456789abcdef0123456789abcdef": ["loom", null],
    "https://archive.org/details/night_of_the_living_dead": ["archive", null],
    "https://odysee.com/@chan:3/my-video:a1": ["odysee", "https://odysee.com/$/embed/my-video/a1?autoplay=1"],
    "https://tilvids.com/w/9c9de5e8-0a1e-484a-b099-e80766180a6d": ["peertube", "https://tilvids.com/videos/embed/9c9de5e8-0a1e-484a-b099-e80766180a6d?autoplay=1"],
    "https://commons.wikimedia.org/wiki/File:Cat_lapping.webm": ["commons", null],
    "https://www.nytimes.com/video/world/123.html": ["web", null],
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

test("Claude results keep only URLs that web search returned", () => {
  const g = gol();
  const seen = new Set([urlKey("https://vimeo.com/76979871"), urlKey("https://www.nytimes.com/video/123")]);
  const out = buildVideos([
    { url: "https://vimeo.com/76979871/", title: "V", site: "Vimeo", channel: "", why: "fits" },
    { url: "https://www.youtube.com/watch?v=madeupid123", title: "Hallucinated", site: "YouTube", channel: "", why: "" },
    { url: "https://nytimes.com/video/123", title: "News", site: "The New York Times", channel: "NYT", why: "news" },
  ], { gol: g, seen, count: 10 });
  assert.deepEqual(out.map((v) => [v.site, v.siteName]), [["vimeo", "Vimeo"], ["web", "The New York Times"]]);
  assert.equal(out[0].via, "claude");
  assert.equal(out[0].note, "fits");
});

test("findWithClaude drives web search, resumes pause_turn, and reads show_videos", async () => {
  const calls = [];
  const replies = [
    { stop_reason: "pause_turn", content: [
      { type: "server_tool_use", name: "web_search", id: "s1", input: {} },
      { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://vimeo.com/76979871" }] }] },
    { stop_reason: "tool_use", content: [{ type: "tool_use", name: "show_videos", id: "t1",
      input: { videos: [{ url: "https://vimeo.com/76979871", title: "V", site: "Vimeo", channel: "", why: "w" }] } }] },
  ];
  const client = { beta: { messages: { create: async (p) => { calls.push(structuredClone(p)); return replies.shift(); } } } };
  const vids = await findWithClaude("cats", { apiKey: "k", gol: gol(), createClient: async () => client });
  assert.equal(vids.length, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].model, "claude-opus-5-5");
  assert.equal(calls[0].fallbacks, "default");
  assert.equal(calls[0].tools[0].type, "web_search_20260209");
  assert.equal(calls[1].messages.length, 2); // assistant turn echoed back, no extra "continue" message
  assert.equal(calls[1].messages[1].role, "assistant");
});

test("findWithClaude needs a key and surfaces refusals", async () => {
  await assert.rejects(findWithClaude("x", { gol: gol() }), /API key/);
  const client = { beta: { messages: { create: async () => ({ stop_reason: "refusal", content: [], stop_details: { explanation: "nope" } }) } } };
  await assert.rejects(findWithClaude("x", { apiKey: "k", gol: gol(), model: "claude-haiku-5-5", createClient: async () => client }), /declined.*nope/);
});
