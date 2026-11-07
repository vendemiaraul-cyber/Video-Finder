import { util } from "../gol.js";

// PeerTube is federated: thousands of independent sites. Gol searches them
// all through the SepiaSearch index and shows the real instance each video
// lives on.
export default {
  id: "peertube",
  name: "PeerTube",
  domain: "joinpeertube.org",
  color: "#e8730b",
  ads: false,
  embedHosts: ["*"],
  embedPath: /^\/videos\/embed\/[A-Za-z0-9-]+$/,

  async search(q, { limit, fetchJSON }) {
    const data = await fetchJSON("https://sepiasearch.org/api/v1/search/videos?" +
      util.qs({ search: q, count: limit, nsfw: "false", sort: "-match" }));
    return (data.data || []).filter((it) => it.url && it.embedUrl).map((it) => ({
      id: it.uuid, title: it.name, url: it.url, domain: util.host(it.url),
      thumbnail: it.thumbnailUrl, duration: it.duration,
      channel: it.channel?.displayName || it.account?.displayName, views: it.views,
      published: util.date(it.publishedAt),
      play: { kind: "iframe", src: it.embedUrl + "?autoplay=1" },
    }));
  },

  match: [
    { re: /^https:\/\/([a-z0-9.-]+)\/(?:w|videos\/watch)\/([A-Za-z0-9]{22}|[0-9a-f-]{36})(?:[?#].*)?$/i,
      video: (m) => ({ id: m[2], domain: m[1],
                       play: { kind: "iframe", src: `https://${m[1]}/videos/embed/${m[2]}?autoplay=1` } }) },
  ],
};
