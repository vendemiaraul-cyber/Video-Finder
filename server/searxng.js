/**
 * Ask a SearXNG instance (JSON API) for videos, then keep only results that
 * really offer a video, turning each into a Gol video.
 */
import { probe, isoDuration } from "./probe.js";
import { outcomeOf, refusesEmbedding } from "./site-policy.js";
import { isSafe } from "../gol/safety.js";

// Adult, shock and piracy results never reach MeoDeo (on top of SearXNG safe search).
const safeResults = (results) => (results || []).filter((r) => r && isSafe({ url: r.url, title: r.title, description: r.content }));

export class SearxngError extends Error {}

/** SearXNG "length" is seconds (number) or "H:MM:SS" / "MM:SS" / ISO-8601. */
export function parseLength(v) {
  if (typeof v === "number") return v > 0 ? Math.round(v) : undefined;
  const s = String(v || "").trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(+s) || undefined;
  if (/^\d+(:\d{1,2}){1,2}$/.test(s)) return s.split(":").reduce((t, p) => t * 60 + +p, 0) || undefined;
  return isoDuration(s);
}

const https = (u) => (typeof u === "string" && u ? u.replace(/^http:\/\//, "https://") : undefined);
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

/**
 * Sites MeoDeo already searches on its own (plus TikTok): SearXNG's job is to
 * find videos on OTHER websites, so results from these are skipped.
 * Override with SEARXNG_SKIP ("none" keeps everything).
 */
export const DEFAULT_SKIP = ["youtube", "dailymotion", "peertube", "odysee", "archive", "commons", "nasa", "europeana", "pexels", "tiktok"];
export function skipList(v) {
  if (v === undefined || v === null || String(v).trim() === "") return new Set(DEFAULT_SKIP);
  if (String(v).trim().toLowerCase() === "none") return new Set();
  return new Set(String(v).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}

/** Split SEARXNG_URL ("http://a:8080, http://b:8888") into a list. */
export const searxngList = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);

/**
 * Is SearXNG reachable with its JSON API on?
 * @returns {Promise<{ok: boolean, url: string, reason?: string}>}
 */
export async function checkSearxng(baseUrl, { fetchImpl = fetch, timeoutMs = 8000, headers = {} } = {}) {
  const u = new URL("search", baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
  u.searchParams.set("q", "meodeo");
  u.searchParams.set("format", "json");
  try {
    const res = await fetchImpl(u, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 401) return { ok: false, url: baseUrl, reason: "auth" };
    if (res.status === 403) return { ok: false, url: baseUrl, reason: "json-off" };
    if (res.status === 429) return { ok: false, url: baseUrl, reason: "limiter-on" };
    if (!res.ok) return { ok: false, url: baseUrl, reason: `http-${res.status}` };
    if (!(res.headers.get("content-type") || "").includes("json")) return { ok: false, url: baseUrl, reason: "json-off" };
    return { ok: true, url: baseUrl };
  } catch (e) {
    return { ok: false, url: baseUrl, reason: "unreachable" };
  }
}

/** Ask each SearXNG in turn; the first one that answers wins. */
export async function querySearxngAny(query, opts) {
  const urls = searxngList(opts.baseUrl);
  let lastErr = new SearxngError("No SearXNG address is set (SEARXNG_URL).");
  for (const baseUrl of urls) {
    try {
      return { ...(await querySearxng(query, { ...opts, baseUrl })), searxngUrl: baseUrl };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** Fetch one or more result pages from SearXNG. */
export async function querySearxng(query, { baseUrl, pages = 2, firstPage = 1, categories = "videos", safesearch = 1, language = "all", fetchImpl = fetch, timeoutMs = 15000, headers = {} }) {
  const results = [];
  const unresponsive = new Set();
  const replies = await Promise.allSettled(Array.from({ length: pages }, async (_, i) => {
    const u = new URL("search", baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
    Object.entries({ q: query, format: "json", categories, pageno: firstPage + i, safesearch, language })
      .forEach(([k, v]) => u.searchParams.set(k, v));
    const res = await fetchImpl(u, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 401) throw new SearxngError("SearXNG refused MeoDeo's key (check SEARXNG_KEY).");
    if (res.status === 403) throw new SearxngError("SearXNG refused JSON. Turn the JSON API on: add \"json\" under search.formats in its settings.yml.");
    if (res.status === 429) throw new SearxngError("SearXNG is rate limiting this server (its limiter is on). Turn server.limiter off for your own instance.");
    if (!res.ok) throw new SearxngError(`SearXNG answered HTTP ${res.status}`);
    const type = res.headers.get("content-type") || "";
    if (!type.includes("json")) throw new SearxngError("SearXNG didn't return JSON. Is the JSON API on (search.formats: json)?");
    return res.json();
  }));
  const firstError = replies.find((r) => r.status === "rejected");
  if (replies.every((r) => r.status === "rejected")) {
    const e = firstError.reason;
    throw e instanceof SearxngError ? e : new SearxngError(`Can't reach SearXNG at ${baseUrl} (${e.cause?.code || e.message})`);
  }
  const seen = new Set();
  for (const r of replies) {
    if (r.status !== "fulfilled") continue;
    for (const item of r.value.results || []) {
      if (!item?.url || seen.has(item.url)) continue;
      seen.add(item.url);
      results.push(item);
    }
    for (const e of r.value.unresponsive_engines || []) unresponsive.add(Array.isArray(e) ? e[0] : e);
  }
  return { results, unresponsive: [...unresponsive] };
}

/** Run a small async pool. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

/**
 * Turn SearXNG results into Gol videos.
 *  - links Gol recognises play in that site's official player right away
 *  - other links are probed; pages with no video are dropped
 */
export async function toVideos(results, { gol, probeLimit = 16, concurrency = 6, probeOpts = {}, cache, skip = new Set(DEFAULT_SKIP), perSite = 3, policy }) {
  results = safeResults(results);
  const stats = { results: results.length, recognised: 0, skipped: 0, probed: 0, remembered: 0, kept: 0, dropped: 0, cookies: 0 };
  let probes = 0;
  // Check results from video sources before general web pages: they're the
  // likeliest to have a playable video, and only probeLimit pages get checked.
  const isVideoResult = (r) => r.category === "videos" || r.template === "videos.html";
  results = [...results.filter(isVideoResult), ...results.filter((r) => !isVideoResult(r))];
  // At most perSite results from one website, so one source (e.g. a site that
  // answers every query with its own videos) can't fill the list.
  const perHost = new Map();
  results = results.filter((r) => {
    const h = host(r.url);
    perHost.set(h, (perHost.get(h) || 0) + 1);
    return perHost.get(h) <= perSite;
  });
  const videos = await pool(results, concurrency, async (r) => {
    const common = {
      title: r.title || undefined,
      thumbnail: https(r.thumbnail || r.thumbnail_src || r.img_src),
      duration: parseLength(r.length),
      channel: r.author || undefined,
      published: typeof r.publishedDate === "string" ? r.publishedDate.slice(0, 10) : undefined,
      via: "searxng",
      description: typeof r.content === "string" && r.content ? r.content.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) : undefined,
      foundBy: [].concat(r.engines || r.engine || []).join(", ") || undefined,
    };
    const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ""));

    const known = gol.fromUrl(r.url, clean(common));
    if (known && known.site !== "web") {
      // Already covered by MeoDeo's own search of that site: skip it.
      if (skip.has(known.site)) { stats.skipped++; return null; }
      stats.recognised++;
      return known;
    }
    // A site remembered as refusing embedding: don't spend a check on it.
    // Keep it (flagged "site only") if SearXNG listed it as a video, else drop it.
    const siteHost = host(r.url);
    if (policy && refusesEmbedding(await policy.get(siteHost))) {
      stats.remembered++;
      if (!isVideoResult(r)) return null;
      const flagged = gol.fromUrl(r.url, clean(common));
      return flagged ? { ...flagged, play: { kind: "link" }, embed: "refused" } : null;
    }
    if (probes >= probeLimit) return null;
    probes++;
    stats.probed++;
    const key = "probe:" + r.url;
    let p = cache?.get(key);
    if (p === undefined) {
      p = await probe(r.url, { gol, ...probeOpts });
      if (!(p && p.reason === "budget")) cache?.set(key, p);
      if (policy) await policy.record(host(p?.finalUrl || r.url), outcomeOf(p));
    }
    if (!p) return null;
    const pageHost = host(p.finalUrl || r.url);
    const page = clean({
      ...common,
      title: common.title || p.title,
      thumbnail: common.thumbnail || https(p.thumbnail),
      duration: common.duration || p.duration,
      channel: common.channel || p.channel,
      published: common.published || p.published,
    });
    // A page that only embeds a video from a site MeoDeo already covers (e.g. an
    // article with a YouTube player) isn't a new source: skip it too.
    if (p.kind === "gol" && skip.has(p.video.site)) { stats.skipped++; return null; }
    if (p.kind === "gol") {
      // e.g. an article embedding a YouTube video: play that player, credit the page
      return { ...p.video, ...page, url: r.url, id: p.video.id, domain: pageHost,
               note: `${p.video.siteName} video on ${pageHost}` };
    }
    const web = gol.fromUrl(r.url, page);
    if (!web) return null;
    if (p.kind === "iframe") return { ...web, play: { kind: "iframe", src: p.src } };
    if (p.kind === "file") return { ...web, play: { kind: "video", sources: p.sources } };
    // "inside": the page itself may be shown in MeoDeo's player (to accept its cookies there)
    const insidePlay = p.inside ? { inside: { kind: "iframe", src: p.inside } } : {};
    if (p.kind === "cookies") { stats.cookies++; return { ...web, needsCookies: true, play: { kind: "link", ...insidePlay } }; }
    if (p.kind === "link") return { ...web, play: { kind: "link", ...insidePlay } };
    // Couldn't check the page (timeout, refused, out of checks): keep it only if one of
    // SearXNG's video sources listed it, since that's our only sign it really is a video.
    if (p.kind === "unreachable" && isVideoResult(r) && p.reason !== "blocked" && p.reason !== "budget") return { ...web, play: { kind: "link" } };
    return null;
  });
  // Videos that play in MeoDeo first, then pages that open inside it, then site-only.
  const rank = (v) => (v.play.kind !== "link" ? 0 : v.play.inside ? 1 : 2);
  const kept = videos.filter(Boolean).map((v, i) => [v, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([v]) => v);
  stats.kept = kept.length;
  stats.dropped = results.length - kept.length;
  return { videos: kept, stats };
}

/**
 * Split SearXNG results without checking any page (cheap, for one request):
 *  - videos:     links to sites Gol knows (played right away)
 *  - candidates: other pages, to be checked one by one with checkCandidate()
 *                (each check can run as its own request, so a search isn't
 *                limited by one request's allowance)
 * Sites remembered as refusing embedding are dropped (or kept flagged, when
 * a video source listed them).
 */
export async function splitResults(results, { gol, skip = new Set(DEFAULT_SKIP), perSite = 3, policy } = {}) {
  results = safeResults(results);
  const isVideoResult = (r) => r.category === "videos" || r.template === "videos.html";
  const ordered = [...results.filter(isVideoResult), ...results.filter((r) => !isVideoResult(r))];
  const perHost = new Map();
  const capped = ordered.filter((r) => {
    const h = host(r.url);
    perHost.set(h, (perHost.get(h) || 0) + 1);
    return perHost.get(h) <= perSite;
  });
  const records = policy?.getMany ? await policy.getMany([...new Set(capped.map((r) => host(r.url)))]) : {};
  const videos = [], candidates = [];
  const stats = { results: results.length, recognised: 0, skipped: 0, remembered: 0, candidates: 0 };
  for (const r of capped) {
    const known = gol.fromUrl(r.url, { title: r.title || undefined, via: "searxng" });
    if (known && known.site !== "web") {
      if (skip.has(known.site)) { stats.skipped++; continue; }
      const [v] = (await toVideos([r], { gol, skip, perSite: 1, probeLimit: 0 })).videos;
      if (v) { videos.push(v); stats.recognised++; }
      continue;
    }
    if (refusesEmbedding(records[host(r.url)])) {
      stats.remembered++;
      if (isVideoResult(r) && known) videos.push({ ...gol.fromUrl(r.url, { title: r.title || undefined, via: "searxng" }), play: { kind: "link" }, embed: "refused" });
      continue;
    }
    // keep only what the check needs
    candidates.push(Object.fromEntries(["url", "title", "content", "thumbnail", "thumbnail_src", "img_src", "length", "author", "publishedDate", "engines", "engine", "category", "template"]
      .filter((k) => r[k] !== undefined && r[k] !== null && r[k] !== "").map((k) => [k, r[k]])));
  }
  stats.candidates = candidates.length;
  return { videos, candidates, stats };
}

/** Check one candidate page (see splitResults). Returns a Gol video or null. */
export async function checkCandidate(result, { gol, skip = new Set(DEFAULT_SKIP), policy, probeOpts, cache } = {}) {
  if (!result || typeof result.url !== "string" || !/^https?:\/\//.test(result.url)) return null;
  const { videos } = await toVideos([result], { gol, skip, policy, probeOpts, cache, probeLimit: 1, perSite: 1 });
  return videos[0] || null;
}
