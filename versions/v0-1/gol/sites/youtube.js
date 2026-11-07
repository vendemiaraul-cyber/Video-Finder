import { util } from "../gol.js";

// Search goes through the official YouTube Data API when you add a key in
// Settings. Without one, Gol asks a public Piped instance for search results.
// Either way, playback always uses YouTube's own embed player, so YouTube's
// ads run as normal.
const PIPED = ["https://api.piped.private.coffee", "https://pipedapi.kavin.rocks", "https://pipedapi.adminforge.de"];
const embed = (id) => ({ kind: "iframe", src: `https://www.youtube.com/embed/${id}?autoplay=1&rel=0` });
const ID = "([A-Za-z0-9_-]{11})";

export default {
  id: "youtube",
  name: "YouTube",
  domain: "youtube.com",
  color: "#e62117",
  ads: true,
  embedHosts: ["www.youtube.com"],
  keys: [{ name: "youtubeKey", label: "YouTube Data API key", optional: true,
           help: "https://developers.google.com/youtube/v3/getting-started" }],

  async search(q, { limit, fetchJSON, keys }) {
    if (keys.youtubeKey) {
      const data = await fetchJSON("https://www.googleapis.com/youtube/v3/search?" +
        util.qs({ part: "snippet", type: "video", maxResults: limit, q, key: keys.youtubeKey, safeSearch: "moderate" }));
      return (data.items || []).map((it) => ({
        id: it.id.videoId,
        title: decodeEntities(it.snippet.title),
        url: `https://www.youtube.com/watch?v=${it.id.videoId}`,
        thumbnail: it.snippet.thumbnails?.high?.url || it.snippet.thumbnails?.default?.url,
        channel: it.snippet.channelTitle,
        published: util.date(it.snippet.publishedAt),
        play: embed(it.id.videoId),
      }));
    }
    let lastErr;
    for (const base of PIPED) {
      try {
        const data = await fetchJSON(`${base}/search?` + util.qs({ q, filter: "videos" }));
        return (data.items || [])
          .filter((it) => it.type === "stream" && /[?&]v=/.test(it.url || ""))
          .slice(0, limit)
          .map((it) => {
            const id = new URLSearchParams(it.url.split("?")[1]).get("v");
            return {
              id, title: it.title, url: `https://www.youtube.com/watch?v=${id}`,
              thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
              duration: it.duration > 0 ? it.duration : undefined,
              channel: it.uploaderName, views: it.views >= 0 ? it.views : undefined,
              published: it.uploaded > 0 ? new Date(it.uploaded).toISOString().slice(0, 10) : undefined,
              play: embed(id),
            };
          });
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error("no search backend answered - add a YouTube API key in Settings (" + (lastErr?.message || "") + ")");
  },

  match: [
    { re: new RegExp(`^https?://(?:www\\.|m\\.|music\\.)?youtube\\.com/(?:watch\\?(?:.*&)?v=|shorts/|embed/|live/)${ID}`),
      video: (m) => ({ id: m[1], url: `https://www.youtube.com/watch?v=${m[1]}`,
                       thumbnail: `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg`, play: embed(m[1]) }) },
    { re: new RegExp(`^https?://youtu\\.be/${ID}`),
      video: (m) => ({ id: m[1], url: `https://www.youtube.com/watch?v=${m[1]}`,
                       thumbnail: `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg`, play: embed(m[1]) }) },
  ],
};

function decodeEntities(s) {
  return String(s || "").replace(/&(#39|quot|amp|lt|gt);/g, (_, e) =>
    ({ "#39": "'", quot: '"', amp: "&", lt: "<", gt: ">" })[e]);
}
