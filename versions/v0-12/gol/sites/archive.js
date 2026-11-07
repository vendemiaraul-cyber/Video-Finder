import { util } from "../gol.js";

const video = (id, extra = {}) => ({
  id, url: `https://archive.org/details/${id}`, thumbnail: `https://archive.org/services/img/${id}`,
  play: { kind: "iframe", src: `https://archive.org/embed/${id}?autoplay=1` }, ...extra,
});

export default {
  id: "archive",
  name: "Internet Archive",
  domain: "archive.org",
  color: "#555f6d",
  ads: false,
  embedHosts: ["archive.org"],

  async search(q, { limit, fetchJSON }) {
    const fields = ["identifier", "title", "creator", "date", "downloads"].map((f) => "fl[]=" + f).join("&");
    const data = await fetchJSON("https://archive.org/advancedsearch.php?" + util.qs({
      q: `(${q}) AND mediatype:(movies) AND NOT collection:(tvnews OR tvarchive)`,
      rows: limit, output: "json", "sort[]": "downloads desc",
    }) + "&" + fields);
    return (data.response?.docs || []).map((d) => video(d.identifier, {
      title: util.first(d.title) || d.identifier,
      channel: [].concat(d.creator || []).join(", ") || undefined,
      views: d.downloads, published: util.date(d.date),
    }));
  },

  match: [{ re: /^https?:\/\/(?:www\.)?archive\.org\/(?:details|embed)\/([^/?#]+)/, video: (m) => video(m[1]) }],
};
