import { util } from "../gol.js";

// NASA Image and Video Library: public-domain NASA footage.
const asset = (id, suffix) => `https://images-assets.nasa.gov/video/${encodeURIComponent(id)}/${encodeURIComponent(id)}${suffix}`;

export default {
  id: "nasa",
  name: "NASA",
  domain: "images.nasa.gov",
  color: "#0b3d91",
  ads: false,

  async search(q, { limit, fetchJSON }) {
    const data = await fetchJSON("https://images-api.nasa.gov/search?" + util.qs({ q, media_type: "video", page_size: limit }));
    return (data.collection?.items || []).map((it) => {
      const d = it.data?.[0];
      if (!d?.nasa_id) return null;
      return {
        id: d.nasa_id, title: d.title, url: `https://images.nasa.gov/details/${encodeURIComponent(d.nasa_id)}`,
        thumbnail: asset(d.nasa_id, "~medium.jpg"), channel: d.center ? `NASA ${d.center}` : "NASA",
        published: util.date(d.date_created),
        description: util.text(d.description),
        play: { kind: "video", sources: [
          { src: asset(d.nasa_id, "~medium.mp4"), type: "video/mp4" },
          { src: asset(d.nasa_id, "~orig.mp4"), type: "video/mp4" },
        ] },
      };
    }).filter(Boolean);
  },
};
