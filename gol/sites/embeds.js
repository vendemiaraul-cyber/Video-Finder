// Sites Gol can't search directly from a browser (no open search API), but
// can recognise and play when a link to them turns up - for example when
// SearXNG finds one on the web. Each uses the site's official embed player.

const iframe = (src) => ({ kind: "iframe", src });

export default [
  {
    id: "vimeo", name: "Vimeo", domain: "vimeo.com", color: "#17d5ff", ads: false,
    embedHosts: ["player.vimeo.com"],
    match: [{ re: /^https?:\/\/(?:www\.|player\.)?vimeo\.com\/(?:video\/|channels\/[^/]+\/|groups\/[^/]+\/videos\/)?(\d{6,})(?:\/([0-9a-f]{6,}))?/,
      video: (m) => ({ id: m[1], url: `https://vimeo.com/${m[1]}${m[2] ? "/" + m[2] : ""}`,
        play: iframe(`https://player.vimeo.com/video/${m[1]}?autoplay=1${m[2] ? "&h=" + m[2] : ""}`) }) }],
  },
  {
    id: "twitch", name: "Twitch", domain: "twitch.tv", color: "#9146ff", ads: true,
    embedHosts: ["player.twitch.tv", "clips.twitch.tv"],
    match: [
      { re: /^https?:\/\/(?:www\.)?twitch\.tv\/videos\/(\d+)/,
        video: (m) => ({ id: m[1], play: iframe(`https://player.twitch.tv/?video=v${m[1]}&parent={parent}&autoplay=true`) }) },
      { re: /^https?:\/\/(?:clips\.twitch\.tv\/|(?:www\.)?twitch\.tv\/[^/]+\/clip\/)([A-Za-z0-9_-]+)/,
        video: (m) => ({ id: m[1], play: iframe(`https://clips.twitch.tv/embed?clip=${m[1]}&parent={parent}&autoplay=true`) }) },
      { re: /^https?:\/\/(?:www\.)?twitch\.tv\/([a-z0-9_]{3,25})\/?$/i,
        video: (m) => ({ id: m[1], title: `${m[1]} (live channel)`, channel: m[1],
                         play: iframe(`https://player.twitch.tv/?channel=${m[1]}&parent={parent}&autoplay=true`) }) },
    ],
  },
  {
    id: "tiktok", name: "TikTok", domain: "tiktok.com", color: "#111111", ads: false,
    embedHosts: ["www.tiktok.com"],
    // TikTok's official Embed Player (player/v1): real controls, no "watch on TikTok"
    // overlay like the older embed/v2. TikToks are vertical.
    match: [{ re: /^https?:\/\/(?:www\.|m\.)?tiktok\.com\/@([^/]+)\/video\/(\d+)/,
      video: (m) => ({ id: m[2], channel: "@" + m[1],
        play: { kind: "iframe", vertical: true,
                src: `https://www.tiktok.com/player/v1/${m[2]}?music_info=1&description=1&rel=0&playsinline=1` } }) }],
  },
  {
    id: "ted", name: "TED", domain: "ted.com", color: "#e62b1e", ads: false,
    embedHosts: ["embed.ted.com"],
    match: [{ re: /^https?:\/\/(?:www\.)?ted\.com\/talks\/([a-z0-9_]+)/i,
      video: (m) => ({ id: m[1], title: m[1].replace(/_/g, " "), play: iframe(`https://embed.ted.com/talks/${m[1]}`) }) }],
  },
  {
    id: "streamable", name: "Streamable", domain: "streamable.com", color: "#0f90fa", ads: false,
    embedHosts: ["streamable.com"],
    match: [{ re: /^https?:\/\/(?:www\.)?streamable\.com\/(?:e\/)?([a-z0-9]+)$/i,
      video: (m) => ({ id: m[1], play: iframe(`https://streamable.com/e/${m[1]}?autoplay=1`) }) }],
  },
  {
    id: "bilibili", name: "Bilibili", domain: "bilibili.com", color: "#00a1d6", ads: false,
    embedHosts: ["player.bilibili.com"],
    match: [{ re: /^https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/(BV[0-9A-Za-z]{10})/,
      video: (m) => ({ id: m[1], play: iframe(`https://player.bilibili.com/player.html?bvid=${m[1]}&autoplay=0`) }) }],
  },
  {
    id: "facebook", name: "Facebook", domain: "facebook.com", color: "#1877f2", ads: true, needsCookies: true,
    embedHosts: ["www.facebook.com"],
    match: [{ re: /^https?:\/\/(?:www\.|m\.)?facebook\.com\/(?:[^/]+\/videos\/(?:[^/]+\/)?(\d+)|watch\/?\?v=(\d+)|reel\/(\d+))/,
      video: (m, u) => ({ id: m[1] || m[2] || m[3],
        play: iframe(`https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(u.href)}&show_text=false`) }) }],
  },
  {
    id: "instagram", name: "Instagram", domain: "instagram.com", color: "#d62976", ads: false, needsCookies: true,
    embedHosts: ["www.instagram.com"],
    match: [{ re: /^https?:\/\/(?:www\.)?instagram\.com\/(?:[^/]+\/)?(reel|p|tv)\/([A-Za-z0-9_-]+)/,
      video: (m) => ({ id: m[2], url: `https://www.instagram.com/${m[1]}/${m[2]}/`,
                       play: iframe(`https://www.instagram.com/${m[1]}/${m[2]}/embed`) }) }],
  },
  {
    id: "loom", name: "Loom", domain: "loom.com", color: "#625df5", ads: false,
    embedHosts: ["www.loom.com"],
    match: [{ re: /^https?:\/\/(?:www\.)?loom\.com\/(?:share|embed)\/([0-9a-f]{32})/,
      video: (m) => ({ id: m[1], url: `https://www.loom.com/share/${m[1]}`, play: iframe(`https://www.loom.com/embed/${m[1]}`) }) }],
  },
];
