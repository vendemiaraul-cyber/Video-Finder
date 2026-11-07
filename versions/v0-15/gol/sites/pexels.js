import { util } from "../gol.js";

// Pexels: free stock video. MeoDeo's server searches it with the site's own
// key (/api/pexels): the key stays private on the server and never reaches
// the browser, so visitors don't need one.
export default {
  id: "pexels",
  name: "Pexels",
  domain: "pexels.com",
  color: "#05a081",
  ads: false,

  async search(q, { limit, fetchJSON, keys }) {
    const base = (keys.serverUrl || "").replace(/\/+$/, "");
    const data = await fetchJSON(`${base}/api/pexels?` + util.qs({ q }));
    return (data.videos || []).slice(0, limit).map((v) => ({
      id: v.id, title: v.title, url: v.url, thumbnail: v.thumbnail, duration: v.duration, channel: v.channel,
      play: { kind: "video", sources: (v.files || []).map((f) => ({ src: f.src, type: f.type || "video/mp4" })) },
    })).filter((v) => v.play.sources.length);
  },
};
