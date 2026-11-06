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

function el(tag, attrs = {}, ...children) {
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

/** Coloured label naming the site. */
export function badge(video, gol) {
  const color = gol?.sites.get(video.site)?.color || "#5d6573";
  return el("span", { class: "gol-badge", style: { background: color }, text: video.siteName });
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
      video.play.kind === "link" ? el("span", { class: "gol-linkout", text: "Opens on site ↗" }) : null,
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
        video.via === "claude" ? el("span", { class: "gol-via", title: "Found by Claude", text: "✦ Claude" }) : null,
      ),
    ),
  );
  return node;
}

/**
 * Mount a player for `video` into `container` (replacing its contents).
 * Returns a function that stops playback.
 */
export function player(video, container) {
  container.replaceChildren();
  const { play } = video;
  if (play.kind === "iframe") {
    const src = play.src.replace("{parent}", encodeURIComponent(location.hostname || "localhost"));
    container.append(el("iframe", {
      src, title: video.title, allowfullscreen: true,
      allow: "autoplay; encrypted-media; picture-in-picture; fullscreen; clipboard-write",
      // Some players (YouTube) refuse to play without a referrer.
      referrerpolicy: "strict-origin-when-cross-origin",
    }));
  } else if (play.kind === "video") {
    const v = el("video", { controls: true, autoplay: true, playsinline: true, preload: "metadata",
                            poster: video.thumbnail });
    for (const s of play.sources) v.append(el("source", { src: s.src, type: s.type }));
    container.append(v);
  } else {
    container.append(el("div", { class: "gol-linkpanel" },
      video.thumbnail ? el("img", { src: video.thumbnail, alt: "", referrerpolicy: "no-referrer" }) : null,
      el("p", { text: `${video.domain} doesn't allow its videos to be played on other websites.` }),
      el("a", { class: "gol-button", href: video.url, target: "_blank", rel: "noopener noreferrer",
                text: `Watch on ${video.domain} ↗` }),
    ));
  }
  return () => container.replaceChildren();
}

/**
 * Fill in a missing title/thumbnail through oEmbed (noembed.com proxies
 * oEmbed for hundreds of sites and allows browser requests).
 */
export async function enrich(video, fetchImpl = fetch) {
  if (video.thumbnail && video.title && video.title !== video.url) return video;
  try {
    const res = await fetchImpl("https://noembed.com/embed?url=" + encodeURIComponent(video.url));
    const d = await res.json();
    if (d.error) return video;
    const out = { ...video };
    if (!out.thumbnail && /^https:/.test(d.thumbnail_url || "")) out.thumbnail = d.thumbnail_url;
    if ((!out.title || out.title === out.url) && d.title) out.title = d.title;
    if (!out.channel && d.author_name) out.channel = d.author_name;
    return out;
  } catch {
    return video;
  }
}
