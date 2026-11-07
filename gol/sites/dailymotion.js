import { util } from "../gol.js";

const embed = (id) => ({ kind: "iframe", src: `https://geo.dailymotion.com/player.html?video=${id}&autoplay=1` });

export default {
  id: "dailymotion",
  name: "Dailymotion",
  domain: "dailymotion.com",
  color: "#0066dc",
  ads: true,
  embedHosts: ["geo.dailymotion.com"],

  async search(q, { limit, fetchJSON }) {
    const data = await fetchJSON("https://api.dailymotion.com/videos?" + util.qs({
      search: q, limit, family_filter: "true",
      fields: "id,title,url,thumbnail_360_url,duration,owner.screenname,views_total,created_time,description",
    }));
    return (data.list || []).map((it) => ({
      id: it.id, title: it.title, url: it.url || `https://www.dailymotion.com/video/${it.id}`,
      thumbnail: it.thumbnail_360_url, duration: it.duration, channel: it["owner.screenname"],
      views: it.views_total,
      description: util.text(it.description),
      published: it.created_time != null ? new Date(it.created_time * 1000).toISOString().slice(0, 10) : undefined,
      play: embed(it.id),
    }));
  },

  match: [
    { re: /^https?:\/\/(?:www\.)?dailymotion\.com\/video\/([a-z0-9]+)/i,
      video: (m) => ({ id: m[1], url: `https://www.dailymotion.com/video/${m[1]}`, play: embed(m[1]) }) },
    { re: /^https?:\/\/dai\.ly\/([a-z0-9]+)/i,
      video: (m) => ({ id: m[1], url: `https://www.dailymotion.com/video/${m[1]}`, play: embed(m[1]) }) },
  ],
};
