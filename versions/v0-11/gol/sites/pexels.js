import { util } from "../gol.js";

// Pexels: free stock video. Needs a free API key (Settings).
export default {
  id: "pexels",
  name: "Pexels",
  domain: "pexels.com",
  color: "#05a081",
  ads: false,
  keys: [{ name: "pexelsKey", label: "Pexels API key", help: "https://www.pexels.com/api/" }],

  async search(q, { limit, fetchJSON, keys }) {
    const data = await fetchJSON("https://api.pexels.com/videos/search?" + util.qs({ query: q, per_page: limit }),
      { headers: { Authorization: keys.pexelsKey } });
    return (data.videos || []).map((v) => {
      const files = (v.video_files || []).filter((f) => f.file_type === "video/mp4")
        .sort((a, b) => Math.abs((a.width || 0) - 1280) - Math.abs((b.width || 0) - 1280));
      if (!files.length) return null;
      const slug = v.url?.match(/video\/([^/]+?)-?\d*\/?$/)?.[1];
      return {
        id: String(v.id), title: slug ? slug.replace(/-/g, " ") : `Pexels video ${v.id}`, url: v.url,
        thumbnail: v.image, duration: v.duration, channel: v.user?.name,
        play: { kind: "video", sources: files.slice(0, 2).map((f) => ({ src: f.link, type: "video/mp4" })) },
      };
    }).filter(Boolean);
  },
};
