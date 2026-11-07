/**
 * oEmbed: the open standard websites use to publish their official embed
 * player. Gol keeps a copy of the public provider list (gol/oembed-providers.js,
 * from oembed.com) and also reads <link rel="alternate" type="application/json+oembed">
 * tags that pages announce themselves.
 */
import providers from "../gol/oembed-providers.js";

let compiled = null;
function compile() {
  if (compiled) return compiled;
  compiled = providers.map((p) => ({
    ...p,
    patterns: p.schemes.map((s) => new RegExp("^" + s.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i")),
  }));
  return compiled;
}

/** The oEmbed endpoint URL for a page, from the provider list, or null. */
export function endpointFor(pageUrl) {
  const httpish = pageUrl.replace(/^http:/, "https:");
  for (const p of compile()) {
    if (p.patterns.some((re) => re.test(pageUrl) || re.test(httpish))) {
      const u = new URL(p.endpoint);
      u.searchParams.set("url", pageUrl);
      u.searchParams.set("format", "json");
      u.searchParams.set("maxwidth", "1280");
      return { url: u.href, provider: p.name };
    }
  }
  return null;
}

/** First iframe src inside oEmbed HTML. */
export function iframeSrc(html) {
  const m = String(html || "").match(/<iframe\b[^>]*\bsrc=["']([^"']+)["']/i);
  if (!m) return null;
  const src = m[1].replace(/&amp;/g, "&");
  return src.startsWith("//") ? "https:" + src : src;
}

/**
 * Ask an oEmbed endpoint for a video player.
 * @param {string} endpoint  full endpoint URL (with ?url=...)
 * @param {(url: string, opts: object) => Promise<{status:number, body:string}>} fetchPage
 * @returns {Promise<null | {src, title, thumbnail, channel, provider}>}
 */
export async function fetchOembed(endpoint, fetchPage, opts = {}) {
  try {
    const res = await fetchPage(endpoint, { ...opts, maxBytes: 100_000 });
    if (res.status < 200 || res.status >= 300 || !res.body) return null;
    const data = JSON.parse(res.body);
    if (data.type !== "video") return null; // only videos (not photos, podcasts, posts)
    const src = iframeSrc(data.html);
    if (!src || !/^https:/.test(src)) return null;
    return {
      src,
      title: data.title || undefined,
      thumbnail: /^https:/.test(data.thumbnail_url || "") ? data.thumbnail_url : undefined,
      channel: data.author_name || undefined,
      provider: data.provider_name || undefined,
    };
  } catch {
    return null;
  }
}
