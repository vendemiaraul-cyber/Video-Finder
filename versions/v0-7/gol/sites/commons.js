import { util } from "../gol.js";

// Wikimedia Commons: free-licensed video files, played with the browser's
// own <video> element straight from Wikimedia's servers.
const MIME = { webm: "video/webm", ogv: "video/ogg", mp4: "video/mp4", mpg: "video/mpeg", mpeg: "video/mpeg" };

export default {
  id: "commons",
  name: "Wikimedia Commons",
  domain: "commons.wikimedia.org",
  color: "#339966",
  ads: false,

  async search(q, { limit, fetchJSON }) {
    const data = await fetchJSON("https://commons.wikimedia.org/w/api.php?" + util.qs({
      action: "query", generator: "search", gsrsearch: `${q} filetype:video`, gsrnamespace: 6,
      gsrlimit: limit, prop: "imageinfo", iiprop: "url|mime|size|extmetadata",
      iiextmetadatafilter: "Artist|DateTimeOriginal", iiurlwidth: 480, format: "json", origin: "*",
    }));
    return Object.values(data.query?.pages || {})
      .sort((a, b) => a.index - b.index)
      .map((p) => {
        const ii = p.imageinfo?.[0];
        if (!ii || !/^video\//.test(ii.mime)) return null;
        const artist = ii.extmetadata?.Artist?.value?.replace(/<[^>]*>/g, "").trim();
        return {
          id: String(p.pageid),
          title: p.title.replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, "").replace(/_/g, " "),
          url: ii.descriptionurl, thumbnail: ii.thumburl,
          duration: ii.duration ? Math.round(ii.duration) : undefined,
          channel: artist || undefined,
          published: util.date(ii.extmetadata?.DateTimeOriginal?.value),
          play: { kind: "video", sources: [{ src: ii.url, type: ii.mime }] },
        };
      })
      .filter(Boolean);
  },

  match: [
    { re: /^https?:\/\/commons\.wikimedia\.org\/wiki\/File:([^?#]+\.(webm|ogv|mp4|mpe?g))$/i,
      video: (m) => ({ id: m[1], title: decodeURIComponent(m[1]).replace(/_/g, " "),
        play: { kind: "video", sources: [{
          src: `https://commons.wikimedia.org/wiki/Special:FilePath/${m[1]}`, type: MIME[m[2].toLowerCase()] }] } }) },
  ],
};
