import { util } from "../gol.js";
import { el } from "../render.js";

// Search goes through the official YouTube Data API when you add a key in
// Settings. Without one, Gol asks a public Piped instance for search results.
// Either way, playback always uses YouTube's own player, so YouTube's ads run
// as normal.
const PIPED = ["https://api.piped.private.coffee", "https://pipedapi.kavin.rocks", "https://pipedapi.adminforge.de"];
const ID = "([A-Za-z0-9_-]{11})";

/** "1h2m3s", "90s", "90" -> seconds */
export function parseStart(t) {
  if (!t) return 0;
  if (/^\d+$/.test(t)) return +t;
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}

function play(id, { start = 0, vertical = false } = {}) {
  const src = `https://www.youtube.com/embed/${id}?autoplay=1&rel=0&playsinline=1` + (start ? `&start=${start}` : "");
  return { kind: "iframe", src, youtube: { id, start, vertical } };
}

const watchUrl = (id, start) => `https://www.youtube.com/watch?v=${id}` + (start ? `&t=${start}s` : "");

function fromLink(id, u, vertical = false) {
  const start = parseStart(u.searchParams.get("t") || u.searchParams.get("start"));
  return { id, url: watchUrl(id, start), thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, play: play(id, { start, vertical }) };
}

/* ---------- player: YouTube's IFrame Player API ---------- */

let apiPromise = null;
function loadApi() {
  if (globalThis.YT?.Player) return Promise.resolve(globalThis.YT);
  if (!apiPromise) {
    apiPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { apiPromise = null; reject(new Error("timeout")); }, 8000);
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { clearTimeout(timer); previous?.(); resolve(window.YT); };
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      s.onerror = () => { clearTimeout(timer); apiPromise = null; reject(new Error("blocked")); };
      document.head.append(s);
    });
  }
  return apiPromise;
}

// https://developers.google.com/youtube/iframe_api_reference#onError
export const ERRORS = {
  2: "This YouTube link looks broken.",
  5: "Your browser couldn't play this YouTube video.",
  100: "This video was removed or made private.",
  101: "YouTube won't play this video here. The owner may not allow other websites, or YouTube wants it watched on YouTube.",
  150: "YouTube won't play this video here. The owner may not allow other websites, or YouTube wants it watched on YouTube.",
  153: "YouTube refused to play here (missing page address).",
};

function blockedPanel(video, code) {
  const { id, start } = video.play.youtube;
  return el("div", { class: "gol-linkpanel", "data-yt-error": String(code) },
    el("img", { src: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, alt: "", referrerpolicy: "no-referrer" }),
    el("p", { text: ERRORS[code] || "YouTube couldn't play this video here." }),
    // On phones this link opens the YouTube app.
    el("a", { class: "gol-button", href: watchUrl(id, start), target: "_blank", rel: "noopener noreferrer", text: "Open in YouTube ↗" }),
  );
}

function plainIframe(video) {
  return el("iframe", {
    src: video.play.src, title: video.title, allowfullscreen: true,
    allow: "autoplay; encrypted-media; picture-in-picture; fullscreen",
    referrerpolicy: "strict-origin-when-cross-origin",
  });
}

/**
 * Mount YouTube's player. Uses the IFrame Player API so MeoDeo can tell when a
 * video can't be embedded and offer "Open in YouTube" instead of a dead player.
 */
function mount(video, container) {
  const { id, start, vertical } = video.play.youtube;
  container.classList.toggle("gol-vertical", vertical);
  const slot = el("div", { class: "gol-yt-slot" });
  container.replaceChildren(slot);
  let player = null;
  let closed = false;

  loadApi().then((YT) => {
    if (closed) return;
    player = new YT.Player(slot, {
      videoId: id,
      width: "100%",
      height: "100%",
      host: "https://www.youtube.com", // the normal player, so YouTube's ads run as usual
      playerVars: { autoplay: 1, playsinline: 1, rel: 0, start, origin: location.origin, enablejsapi: 1 },
      events: {
        onReady: (e) => { try { e.target.playVideo(); } catch { /* autoplay may be blocked; the viewer taps play */ } },
        onError: (e) => { if (!closed) container.replaceChildren(blockedPanel(video, e.data)); },
      },
    });
  }).catch(() => {
    // The API script was blocked (e.g. by a content blocker): use the plain embed.
    if (!closed) container.replaceChildren(plainIframe(video));
  });

  return () => {
    closed = true;
    try { player?.destroy(); } catch { /* already gone */ }
    container.classList.remove("gol-vertical");
    container.replaceChildren();
  };
}

export default {
  id: "youtube",
  name: "YouTube",
  domain: "youtube.com",
  color: "#e62117",
  ads: true,
  embedHosts: ["www.youtube.com"],
  keys: [{ name: "youtubeKey", label: "YouTube Data API key", optional: true,
           help: "https://developers.google.com/youtube/v3/getting-started" }],
  mount,

  async search(q, { limit, fetchJSON, keys }) {
    if (keys.youtubeKey) {
      const data = await fetchJSON("https://www.googleapis.com/youtube/v3/search?" +
        util.qs({ part: "snippet", type: "video", maxResults: limit, q, key: keys.youtubeKey, safeSearch: "moderate" }));
      return (data.items || []).map((it) => ({
        id: it.id.videoId,
        title: decodeEntities(it.snippet.title),
        url: watchUrl(it.id.videoId),
        thumbnail: it.snippet.thumbnails?.high?.url || it.snippet.thumbnails?.default?.url,
        channel: it.snippet.channelTitle,
        published: util.date(it.snippet.publishedAt),
        play: play(it.id.videoId),
      }));
    }
    let lastErr;
    for (const base of PIPED) {
      try {
        const data = await fetchJSON(`${base}/search?` + util.qs({ q, filter: "videos" }));
        return (data.items || [])
          .filter((it) => it.type === "stream" && /[?&]v=/.test(it.url || ""))
          .slice(0, limit)
          .map((it) => {
            const id = new URLSearchParams(it.url.split("?")[1]).get("v");
            return {
              id, title: it.title, url: watchUrl(id),
              thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
              duration: it.duration > 0 ? it.duration : undefined,
              channel: it.uploaderName, views: it.views >= 0 ? it.views : undefined,
              published: it.uploaded > 0 ? new Date(it.uploaded).toISOString().slice(0, 10) : undefined,
              play: play(id, { vertical: !!it.isShort }),
            };
          });
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error("no search backend answered - add a YouTube API key in Settings (" + (lastErr?.message || "") + ")");
  },

  match: [
    { re: new RegExp(`^https?://(?:www\\.|m\\.|music\\.)?youtube\\.com/shorts/${ID}`), video: (m, u) => fromLink(m[1], u, true) },
    { re: new RegExp(`^https?://(?:www\\.|m\\.|music\\.)?youtube(?:-nocookie)?\\.com/(?:watch\\?(?:.*&)?v=|embed/|live/|v/)${ID}`), video: (m, u) => fromLink(m[1], u) },
    { re: new RegExp(`^https?://youtu\\.be/${ID}`), video: (m, u) => fromLink(m[1], u) },
  ],
};

function decodeEntities(s) {
  return String(s || "").replace(/&(#39|quot|amp|lt|gt);/g, (_, e) =>
    ({ "#39": "'", quot: '"', amp: "&", lt: "<", gt: ">" })[e]);
}
