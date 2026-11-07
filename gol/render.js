/**
 * Gol renderer: turns Gol videos into DOM. Everything is built with DOM
 * APIs (never innerHTML with site data), and players only load URLs that
 * passed Gol's checks in gol.js.
 */

export function formatDuration(s) {
  if (!s) return "";
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(sec).padStart(2, "0");
}

export function formatCount(n) {
  return n == null ? "" : new Intl.NumberFormat(undefined, { notation: "compact" }).format(n);
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "style") Object.assign(node.style, v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  node.append(...children.filter(Boolean));
  return node;
}

/** Coloured label: the site's name, or "SearXNG Results" for videos SearXNG found. */
export function badge(video, gol) {
  const fromSearxng = video.via === "searxng";
  const site = gol?.sites.get(fromSearxng ? "searxng" : video.site);
  return el("span", {
    class: "gol-badge", style: { background: site?.color || "#5d6573" },
    title: fromSearxng ? `Found through SearXNG${video.foundBy ? ` (${video.foundBy})` : ""}; plays from ${video.domain}` : null,
    text: fromSearxng ? "SearXNG Results" : video.siteName,
  });
}

/** A result card. onOpen(video) fires when it is clicked or activated by keyboard. */
export function card(video, { gol, onOpen } = {}) {
  const meta = [video.channel, video.views != null ? formatCount(video.views) + " views" : null, video.published]
    .filter(Boolean).join(" · ");
  const open = () => onOpen?.(video);
  const node = el("article", {
      class: "gol-card", tabindex: "0", "data-site": video.site,
      onclick: open,
      onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } },
    },
    el("div", { class: "gol-thumb" },
      video.thumbnail
        ? el("img", { src: video.thumbnail, alt: "", loading: "lazy", referrerpolicy: "no-referrer",
                      onerror: (e) => e.target.remove() })
        : el("span", { class: "gol-thumb-fallback", text: video.siteName }),
      video.duration ? el("span", { class: "gol-duration", text: formatDuration(video.duration) }) : null,
      video.play.kind === "link" ? el("span", { class: "gol-linkout", text: video.needsCookies ? "Needs cookies · opens on site ↗" : "Opens on site ↗" }) : null,
    ),
    el("div", { class: "gol-body" },
      el("h3", { class: "gol-title", title: video.title, text: video.title }),
      meta ? el("p", { class: "gol-meta", text: meta }) : null,
      video.note ? el("p", { class: "gol-note", text: video.note }) : null,
      el("p", { class: "gol-origin" },
        badge(video, gol),
        el("a", { class: "gol-domain", href: video.url, target: "_blank", rel: "noopener noreferrer",
                  text: video.domain, onclick: (e) => e.stopPropagation() }),
        video.ads ? el("span", { class: "gol-ads", title: "This site shows its own ads in its player", text: "ads" }) : null,
        video.needsCookies ? el("span", { class: "gol-cookies", title: "This site needs its own cookies, so it opens on the site", text: "🍪 cookies" }) : null,
      ),
    ),
  );
  return node;
}

/**
 * Mount a player for `video` into `container` (replacing its contents).
 * Returns a function that stops playback.
 */
// hls.js (open source, Apache-2.0) plays HLS streams in browsers without native HLS.
const HLS_URL = "https://cdn.jsdelivr.net/npm/hls.js@1.7.3/dist/hls.min.js";
let hlsPromise = null;
function loadHls() {
  if (globalThis.Hls) return Promise.resolve(globalThis.Hls);
  hlsPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = HLS_URL;
    s.onload = () => (globalThis.Hls ? resolve(globalThis.Hls) : reject(new Error("hls.js missing")));
    s.onerror = () => { hlsPromise = null; reject(new Error("hls.js blocked")); };
    document.head.append(s);
  });
  return hlsPromise;
}
const isHls = (s) => /mpegurl/i.test(s.type || "") || /\.m3u8(\?|#|$)/i.test(s.src);

const PAGE_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation allow-storage-access-by-user-activation";
const IFRAME_ALLOW = "autoplay; encrypted-media; picture-in-picture; fullscreen; clipboard-write; storage-access";

/** A whole web page shown inside MeoDeo (e.g. to accept its cookies there). */
function pageFrame(video, src) {
  return el("iframe", { src, title: video.title, allowfullscreen: true, allow: IFRAME_ALLOW,
                        referrerpolicy: "strict-origin-when-cross-origin", sandbox: PAGE_SANDBOX });
}

/**
 * Mount a player for `video` into `container` (replacing its contents).
 * Options: gol, cookieMode ("inside" plays cookie-needing videos in MeoDeo,
 * "open" leaves them to the site itself).
 * Returns a function that stops playback.
 */
export function player(video, container, { gol, cookieMode = "inside" } = {}) {
  container.replaceChildren();
  container.classList.remove("gol-vertical");
  const { play } = video;
  const fallback = () => container.replaceChildren(linkPanel(video, container));
  // Cookie-needing page that may be shown inside MeoDeo: open it right here.
  if (video.needsCookies && cookieMode === "inside" && play.kind === "link" && play.inside) {
    container.append(pageFrame(video, play.inside.src));
    return () => container.replaceChildren();
  }
  // A site can bring its own player (e.g. YouTube's IFrame Player API).
  const site = gol?.sites.get(video.site);
  if (play.kind === "iframe" && site?.mount) return site.mount(video, container) || (() => container.replaceChildren());
  if (play.vertical) container.classList.add("gol-vertical"); // e.g. TikTok
  if (play.kind === "iframe") {
    const src = play.src.replace("{parent}", encodeURIComponent(location.hostname || "localhost"));
    const sandboxed = gol?.sites.get(video.site)?.sandboxed;
    container.append(el("iframe", {
      src, title: video.title, allowfullscreen: true,
      // storage-access lets the embedded site use its own cookies (sign-in, consent)
      allow: IFRAME_ALLOW,
      // Some players (YouTube) refuse to play without a referrer.
      referrerpolicy: "strict-origin-when-cross-origin",
      // Players from websites Gol has no definition for can't navigate MeoDeo away.
      sandbox: sandboxed ? "allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox" : null,
    }));
  } else if (play.kind === "video") {
    const v = el("video", { controls: true, autoplay: true, playsinline: true, preload: "metadata",
                            poster: video.thumbnail });
    let hls = null;
    const hlsSource = play.sources.find(isHls);
    if (hlsSource && !v.canPlayType("application/vnd.apple.mpegurl")) {
      // Chrome, Firefox, Android: play the HLS stream with hls.js
      loadHls().then((Hls) => {
        if (!Hls.isSupported()) return fallback();
        hls = new Hls();
        hls.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal) { hls.destroy(); fallback(); } });
        hls.loadSource(hlsSource.src);
        hls.attachMedia(v);
      }).catch(fallback);
    } else {
      for (const s of play.sources) v.append(el("source", { src: s.src, type: s.type }));
    }
    // The file can't be played here (format, blocked by the site...): offer the site instead.
    v.addEventListener("error", fallback, true);
    container.append(v);
    return () => { try { hls?.destroy(); } catch { /* gone */ } container.replaceChildren(); };
  } else {
    container.append(linkPanel(video, container));
  }
  return () => container.replaceChildren();
}

/** "Watch on site" panel, with "Play here" when the page may be shown inside MeoDeo. */
function linkPanel(video, container) {
  const inside = video.play.inside;
  return el("div", { class: "gol-linkpanel" },
    video.thumbnail ? el("img", { src: video.thumbnail, alt: "", referrerpolicy: "no-referrer" }) : null,
    el("p", { text: video.needsCookies
      ? `${video.domain} needs its own cookies (consent or sign-in).` + (inside ? " You can open it here and accept them, or watch on the site." : " It only plays on the site itself.")
      : inside
        ? `${video.domain} has no embeddable player, but you can open its page here.`
        : `${video.domain} doesn't allow its videos to be played on other websites.` }),
    el("div", { class: "gol-actions" },
      inside ? el("button", { class: "gol-button", type: "button", text: "Play here",
                              onclick: () => container.replaceChildren(pageFrame(video, inside.src)) }) : null,
      el("a", { class: "gol-button" + (inside ? " gol-button-alt" : ""), href: video.url, target: "_blank", rel: "noopener noreferrer",
                text: `Watch on ${video.domain} ↗` }),
    ),
  );
}
