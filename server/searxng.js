/**
 * Ask a SearXNG instance (JSON API) for videos, then keep only results that
 * really offer a video, turning each into a Gol video.
 */
import { probe, isoDuration } from "./probe.js";

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

/** Fetch one or more result pages from SearXNG. */
export async function querySearxng(query, { baseUrl, pages = 2, categories = "videos", safesearch = 1, language = "all", fetchImpl = fetch, timeoutMs = 10000 }) {
  const results = [];
  const unresponsive = new Set();
  const replies = await Promise.allSettled(Array.from({ length: pages }, async (_, i) => {
    const u = new URL("search", baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
    Object.entries({ q: query, format: "json", categories, pageno: i + 1, safesearch, language })
      .forEach(([k, v]) => u.searchParams.set(k, v));
    const res = await fetchImpl(u, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
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
export async function toVideos(results, { gol, probeLimit = 16, concurrency = 6, probeOpts = {}, cache }) {
  const stats = { results: results.length, recognised: 0, probed: 0, kept: 0, dropped: 0, cookies: 0 };
  let probes = 0;
  const videos = await pool(results, concurrency, async (r) => {
    const common = {
      title: r.title || undefined,
      thumbnail: https(r.thumbnail || r.thumbnail_src || r.img_src),
      duration: parseLength(r.length),
      channel: r.author || undefined,
      published: typeof r.publishedDate === "string" ? r.publishedDate.slice(0, 10) : undefined,
      via: "searxng",
      foundBy: [].concat(r.engines || r.engine || []).join(", ") || undefined,
    };
    const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ""));

    const known = gol.fromUrl(r.url, clean(common));
    if (known && known.site !== "web") {
      stats.recognised++;
      return known;
    }
    if (probes >= probeLimit) return null;
    probes++;
    stats.probed++;
    const key = "probe:" + r.url;
    let p = cache?.get(key);
    if (p === undefined) {
      p = await probe(r.url, { gol, ...probeOpts });
      cache?.set(key, p);
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
    if (p.kind === "gol") {
      // e.g. an article embedding a YouTube video: play that player, credit the page
      return { ...p.video, ...page, url: r.url, id: p.video.id, domain: pageHost,
               note: `${p.video.siteName} video on ${pageHost}` };
    }
    const web = gol.fromUrl(r.url, page);
    if (!web) return null;
    if (p.kind === "iframe") return { ...web, play: { kind: "iframe", src: p.src } };
    if (p.kind === "file") return { ...web, play: { kind: "video", sources: p.sources } };
    if (p.kind === "cookies") { stats.cookies++; return { ...web, needsCookies: true, play: { kind: "link" } }; }
    if (p.kind === "link") return { ...web, play: { kind: "link" } };
    // unreachable from the server (timeout, blocked): SearXNG listed it as a video, so keep it as a link
    if (p.kind === "unreachable" && p.reason !== "blocked") return { ...web, play: { kind: "link" } };
    return null;
  });
  const kept = videos.filter(Boolean);
  stats.kept = kept.length;
  stats.dropped = results.length - kept.length;
  return { videos: kept, stats };
}
