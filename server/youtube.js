/**
 * YouTube search for MeoDeo's backends (Cloudflare Pages Function and the
 * Node server). Plain fetch, no dependencies, works in both.
 *
 * - With an official YouTube Data API key (YOUTUBE_API_KEY), it uses the
 *   official API.
 * - Without one, it asks YouTube's own web search (the same endpoint
 *   youtube.com and SearXNG use). That isn't an official API, so it can
 *   change without notice; the official key is the stable option.
 */

const WEB_CLIENT = { clientName: "WEB", clientVersion: "2.20251101.00.00", hl: "en", gl: "US" };
const ONLY_VIDEOS = "EgIQAQ%3D%3D"; // YouTube's "Type: Video" search filter

const text = (t) => t?.simpleText ?? t?.runs?.map((r) => r.text).join("") ?? "";

/** "1:02:03" -> 3723 */
export function clock(s) {
  if (!/^\d+(:\d{1,2}){1,2}$/.test(s || "")) return undefined;
  return s.split(":").reduce((t, p) => t * 60 + +p, 0) || undefined;
}

/** "3,163,291 views" -> 3163291 */
export function count(s) {
  const n = String(s || "").replace(/[^\d]/g, "");
  return n ? +n : undefined;
}

/** Pull videoRenderer entries out of YouTube's search response. */
export function parseWebResults(data, limit) {
  const out = [];
  (function walk(n) {
    if (out.length >= limit) return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === "object") {
      if (n.videoRenderer) {
        const v = n.videoRenderer;
        if (v.videoId && !v.upcomingEventData) {
          out.push({
            id: v.videoId,
            title: text(v.title),
            channel: text(v.ownerText) || undefined,
            duration: clock(text(v.lengthText)),
            views: count(text(v.viewCountText)),
            live: !!v.badges?.some((b) => /LIVE/.test(b.metadataBadgeRenderer?.style || "")),
            description: (text(v.detailedMetadataSnippets?.[0]?.snippetText) || text(v.descriptionSnippet) || "").slice(0, 300) || undefined,
          });
        }
        return;
      }
      for (const k in n) walk(n[k]);
    }
  })(data);
  return out;
}

export async function searchYouTube(query, { limit = 12, apiKey, fetchImpl = fetch } = {}) {
  if (apiKey) {
    const u = new URL("https://www.googleapis.com/youtube/v3/search");
    Object.entries({ part: "snippet", type: "video", maxResults: Math.min(limit, 50), q: query, key: apiKey, safeSearch: "moderate" })
      .forEach(([k, v]) => u.searchParams.set(k, v));
    const res = await fetchImpl(u);
    if (!res.ok) throw new Error(`YouTube Data API answered HTTP ${res.status}`);
    const data = await res.json();
    return (data.items || []).map((it) => ({
      id: it.id.videoId, title: it.snippet.title, channel: it.snippet.channelTitle, description: (it.snippet.description || "").slice(0, 300) || undefined,
      published: (it.snippet.publishedAt || "").slice(0, 10) || undefined,
    }));
  }
  const res = await fetchImpl("https://www.youtube.com/youtubei/v1/search?prettyPrint=false", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 (compatible; MeoDeo)" },
    body: JSON.stringify({ context: { client: WEB_CLIENT }, query, params: ONLY_VIDEOS }),
  });
  if (!res.ok) throw new Error(`YouTube search answered HTTP ${res.status}`);
  return parseWebResults(await res.json(), limit);
}
