import { util } from "../gol.js";

export default {
  id: "odysee",
  name: "Odysee",
  domain: "odysee.com",
  color: "#e50054",
  ads: true,
  embedHosts: ["odysee.com"],

  async search(q, { limit, fetchJSON }) {
    const data = await fetchJSON("https://lighthouse.odysee.tv/search?" +
      util.qs({ s: q, size: limit, mediaType: "video", nsfw: "false", free_only: "true", resolve: "true" }));
    return (Array.isArray(data) ? data : []).filter((it) => it.claimId && it.name).map((it) => {
      const path = (it.channel ? `${it.channel}/` : "") + `${it.name}:${it.claimId}`;
      return {
        id: it.claimId, title: it.title || it.name, url: `https://odysee.com/${path}`,
        thumbnail: it.thumbnail_url, duration: it.duration, channel: it.channel,
        published: util.date(it.release_time),
        play: { kind: "iframe", src: `https://odysee.com/$/embed/${encodeURIComponent(it.name)}/${it.claimId}?autoplay=1` },
      };
    });
  },

  match: [
    { re: /^https?:\/\/odysee\.com\/(?:@[^/]+\/)?([^/:?#]+):([0-9a-f]+)/i,
      video: (m) => ({ id: m[2], play: { kind: "iframe", src: `https://odysee.com/$/embed/${m[1]}/${m[2]}?autoplay=1` } }) },
  ],
};
