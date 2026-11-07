import { util } from "../gol.js";

// Europeana gathers videos from hundreds of European archives and
// broadcasters. Most can only be watched on the archive's own website, so
// Gol shows them as "watch on <site>" cards.
export default {
  id: "europeana",
  name: "Europeana",
  domain: "europeana.eu",
  color: "#0a72cc",
  ads: false,
  keys: [{ name: "europeanaKey", label: "Europeana API key (optional, a shared demo key is used otherwise)",
           optional: true, help: "https://pro.europeana.eu/page/get-api" }],

  async search(q, { limit, fetchJSON, keys }) {
    const data = await fetchJSON("https://api.europeana.eu/record/v2/search.json?" + util.qs({
      wskey: keys.europeanaKey || "api2demo", query: q, media: "true", qf: "TYPE:VIDEO", rows: limit, profile: "rich",
    }));
    return (data.items || []).map((it) => {
      const url = (util.first(it.edmIsShownAt) || it.guid || "").replace(/^http:/, "https:");
      if (!url) return null;
      const titles = [].concat(it.title || []);
      return {
        id: it.id, url, domain: util.host(url),
        title: titles.find((t) => /[a-z]/i.test(t) && !/:$/.test(t)) || titles[0],
        thumbnail: util.first(it.edmPreview),
        channel: util.first(it.dataProvider), published: util.first(it.year),
        play: { kind: "link" },
      };
    }).filter(Boolean);
  },
};
