import { util } from "../gol.js";

// Since 28 September 2026 Dailymotion only plays embeds that name a Player ID
// (geo.dailymotion.com/player/<ID>.html). Without one its player answers 403
// and shows a black screen. A Player ID is free: make one at
// https://www.dailymotion.com/partner (Players > Create) and put it here, or
// in MeoDeo's settings. It is public, not a secret.
export const PLAYER_ID = "";

const PLAYER_RE = /^x[a-z0-9]{3,12}$/i;
export const playerId = (keys = {}) => [keys.dailymotionPlayer, PLAYER_ID].map((s) => String(s || "").trim()).find((s) => PLAYER_RE.test(s)) || "";

const VIDEO_RE = /^x[a-z0-9]+$/i;
/** How a Dailymotion video plays: its official player when we have a Player ID, otherwise on dailymotion.com. */
export function playFor(id, keys) {
  const player = playerId(keys);
  if (!player || !VIDEO_RE.test(id)) return { kind: "link" };
  return { kind: "iframe", src: `https://geo.dailymotion.com/player/${player}.html?` + util.qs({ video: id, autoplay: 1 }) };
}

const watchUrl = (id) => `https://www.dailymotion.com/video/${id}`;

export default {
  id: "dailymotion",
  name: "Dailymotion",
  domain: "dailymotion.com",
  color: "#0066dc",
  ads: true,
  embedHosts: ["geo.dailymotion.com"],
  keys: [{ name: "dailymotionPlayer", label: "Dailymotion Player ID", optional: true, help: "https://www.dailymotion.com/partner" }],

  // Rebuild the player for every Dailymotion video, wherever it came from
  // (search, SearXNG, feed posts saved before the Player ID rule).
  prepare(video, keys) {
    if (!VIDEO_RE.test(String(video.id))) return;
    if (video.noEmbed) { video.play = { kind: "link" }; return; }
    video.play = playFor(video.id, keys);
    if (video.play.kind === "link") video.linkNote = "Dailymotion now needs a Player ID to play its videos on other websites, and MeoDeo doesn't have one yet.";
    else delete video.linkNote;
  },

  async search(q, { limit, fetchJSON }) {
    const data = await fetchJSON("https://api.dailymotion.com/videos?" + util.qs({
      search: q, limit, family_filter: "true", sort: "relevance",
      fields: "id,title,url,thumbnail_360_url,duration,owner.screenname,views_total,created_time,description,explicit,allow_embed",
    }));
    return (data.list || []).filter((it) => !it.explicit).map((it) => ({
      id: it.id, title: it.title, url: it.url || watchUrl(it.id),
      thumbnail: it.thumbnail_360_url, duration: it.duration, channel: it["owner.screenname"],
      views: it.views_total,
      description: util.text(it.description),
      published: it.created_time != null ? new Date(it.created_time * 1000).toISOString().slice(0, 10) : undefined,
      play: it.allow_embed === false ? { kind: "link" } : { kind: "dailymotion" },
      ...(it.allow_embed === false ? { noEmbed: true } : {}),
    }));
  },

  match: [
    { re: /^https?:\/\/(?:www\.)?dailymotion\.com\/video\/([a-z0-9]+)/i,
      video: (m) => ({ id: m[1], url: watchUrl(m[1]), play: { kind: "dailymotion" } }) },
    { re: /^https?:\/\/dai\.ly\/([a-z0-9]+)/i,
      video: (m) => ({ id: m[1], url: watchUrl(m[1]), play: { kind: "dailymotion" } }) },
    { re: /^https?:\/\/geo\.dailymotion\.com\/player(?:\/[a-z0-9]+)?\.html\?(?:.*&)?video=([a-z0-9]+)/i,
      video: (m) => ({ id: m[1], url: watchUrl(m[1]), play: { kind: "dailymotion" } }) },
  ],
};
