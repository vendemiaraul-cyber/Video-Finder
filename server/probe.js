/**
 * The probe opens a page and decides whether it really offers a video, and
 * how MeoDeo can play it:
 *
 *   1. the page embeds a video from a site Gol knows (e.g. a news article
 *      with a YouTube player)      -> that site's official player
 *   2. the page announces its own player (og:video, twitter:player,
 *      JSON-LD VideoObject) and the player allows embedding -> that player
 *   3. the page links a plain video file (mp4/webm)        -> browser player
 *   4. the page shows a video but blocks embedding         -> "watch on site"
 *   5. the page hides behind a cookie wall / consent / login -> needsCookies
 *   6. no video at all                                     -> dropped
 */

const COOKIE_PATH = /(^|[./_-])(consent|cookies?|gdpr|privacy-?gate|login|log-in|signin|sign-in|sign_in|accounts?|auth|captcha|challenge)([./_?-]|$)/i;
const COOKIE_TEXT = /(please\s+)?(enable|accept|allow)\s+(all\s+)?cookies|cookies\s+(are|is)\s+(disabled|required|blocked)|requires?\s+cookies|cookie[\s_-]?wall|consent\.(google|youtube|yahoo)\.com|you\s+must\s+(be\s+)?(logged|signed)\s+in/i;
const FILE_TYPE = /^video\/(mp4|webm|ogg)$/i;
const FILE_EXT = /\.(mp4|webm|ogv|m4v)(\?|#|$)/i;

/** Pull the video-related metadata out of a page's HTML. */
export function extract(html, baseUrl) {
  const meta = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = attr(tag, "property") || attr(tag, "name") || attr(tag, "itemprop");
    const content = attr(tag, "content");
    if (key && content != null && !(key.toLowerCase() in meta)) meta[key.toLowerCase()] = decode(content);
  }
  const abs = (u) => { try { return u ? new URL(u, baseUrl).href : undefined; } catch { return undefined; } };
  const out = {
    title: meta["og:title"] || meta["twitter:title"] || decode((html.match(/<title[^>]*>([^<]{1,300})<\/title>/i) || [])[1] || "").trim() || undefined,
    thumbnail: abs(meta["og:image:secure_url"] || meta["og:image"] || meta["twitter:image"] || meta["thumbnailurl"]),
    duration: num(meta["og:video:duration"] || meta["video:duration"]) || isoDuration(meta["duration"]),
    channel: meta["author"] || meta["og:site_name"] || undefined,
    embeds: [],   // iframe-able player URLs announced by the page
    files: [],    // plain video files
    iframes: [],  // <iframe src> found in the page
  };
  const ogVideo = abs(meta["og:video:secure_url"] || meta["og:video:url"] || meta["og:video"]);
  const ogType = meta["og:video:type"] || "";
  if (ogVideo) (FILE_TYPE.test(ogType) || FILE_EXT.test(ogVideo) ? out.files : out.embeds).push(ogVideo);
  if (meta["twitter:player"]) out.embeds.push(abs(meta["twitter:player"]));
  if (meta["twitter:player:stream"]) out.files.push(abs(meta["twitter:player:stream"]));

  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      for (const node of walk(JSON.parse(m[1].trim()))) {
        if (![].concat(node["@type"] || []).some((t) => /VideoObject/i.test(t))) continue;
        if (node.embedUrl) out.embeds.push(abs(first(node.embedUrl)));
        if (node.contentUrl && FILE_EXT.test(first(node.contentUrl))) out.files.push(abs(first(node.contentUrl)));
        out.title ||= node.name;
        out.thumbnail ||= abs(first(node.thumbnailUrl?.url || node.thumbnailUrl));
        out.duration ||= isoDuration(node.duration);
        out.published = (node.uploadDate || "").slice(0, 10) || undefined;
        out.hasVideoObject = true;
      }
    } catch { /* bad JSON-LD is common; ignore it */ }
  }
  for (const m of html.matchAll(/<(?:video|source)\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
    const u = abs(decode(m[1]));
    if (u && FILE_EXT.test(u)) out.files.push(u);
  }
  for (const m of html.matchAll(/<iframe\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
    const u = abs(decode(m[1]));
    if (u) out.iframes.push(u);
  }
  out.embeds = [...new Set(out.embeds.filter(Boolean))];
  out.files = [...new Set(out.files.filter(Boolean))];
  out.hasVideo = !!(out.embeds.length || out.files.length || out.hasVideoObject || /<video\b/i.test(html));
  return out;
}

/** Can this player URL be shown inside another website? */
export function allowsFraming(headers) {
  const xfo = String(headers["x-frame-options"] || "").toLowerCase();
  if (xfo.includes("deny") || xfo.includes("sameorigin")) return false;
  const csp = String(headers["content-security-policy"] || "");
  const fa = csp.match(/frame-ancestors([^;]*)/i);
  if (fa) {
    const v = fa[1].trim();
    if (!/(^|\s)(\*|https:)(\s|$)/.test(v)) return false;
  }
  return true;
}

function looksLikeCookieWall(res, startUrl) {
  const start = new URL(startUrl);
  for (const hop of res.chain.slice(1)) {
    const u = new URL(hop);
    if (COOKIE_PATH.test(u.hostname.split(".")[0]) || COOKIE_PATH.test(u.pathname) ||
        (u.hostname !== start.hostname && /consent|login|accounts|auth/.test(u.hostname))) return true;
  }
  if (res.loop || res.tooManyRedirects) return true; // a cookie check that redirects forever
  if ([401, 403, 451].includes(res.status) && res.headers["set-cookie"]) return true;
  return COOKIE_TEXT.test(stripTags(res.body).slice(0, 20000));
}

/**
 * Probe one page.
 * @returns {Promise<null | {kind:'gol', video} | {kind:'iframe', src} | {kind:'file', sources} | {kind:'link'} | {kind:'cookies'} , ...meta>}
 *          null means "this page offers no video".
 */
export async function probe(url, { gol, fetch, allowPrivate = false, timeoutMs = 6000 } = {}) {
  if (!fetch) throw new Error("probe needs a page fetcher (fetchPage on Node, workerFetchPage on Cloudflare)");
  let res;
  try {
    res = await fetch(url, { timeoutMs, allowPrivate });
  } catch (err) {
    return { kind: "unreachable", reason: err.code === "EBLOCKED" ? "blocked" : err.message };
  }
  const info = res.body ? extract(res.body, res.url) : { embeds: [], files: [], iframes: [], hasVideo: false };
  const base = { finalUrl: res.url, title: info.title, thumbnail: info.thumbnail, duration: info.duration,
                 channel: info.channel, published: info.published };

  // 1. a player from a site Gol already knows, embedded in the page
  for (const src of [...info.embeds, ...info.iframes]) {
    const v = gol.fromUrl(src);
    if (v && v.site !== "web") return { ...base, kind: "gol", video: v };
  }
  // 2. the page's own player, if it may be framed
  for (const src of info.embeds) {
    if (!/^https:/.test(src)) continue;
    try {
      const head = await fetch(src, { timeoutMs, allowPrivate, maxBytes: 20000 });
      if (looksLikeCookieWall(head, src) && !head.status.toString().startsWith("2")) return { ...base, kind: "cookies" };
      if (head.status >= 200 && head.status < 300 && allowsFraming(head.headers)) return { ...base, kind: "iframe", src };
    } catch { /* try the next one */ }
  }
  // 3. plain video files
  const files = info.files.filter((f) => /^https:/.test(f));
  if (files.length) return { ...base, kind: "file", sources: files.slice(0, 2).map((src) => ({ src, type: mime(src) })) };
  // 5. cookie wall: the page didn't show us any video, but asked for cookies / consent / login
  if (!info.hasVideo && looksLikeCookieWall(res, url)) return { ...base, kind: "cookies" };
  // 4. a video we can't embed
  if (info.hasVideo) return { ...base, kind: "link" };
  if (res.status >= 400) return { ...base, kind: "unreachable", reason: `HTTP ${res.status}` };
  // 6. nothing to watch here
  return null;
}

/* ---------- small helpers ---------- */
function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? (m[2] ?? m[3] ?? m[4]) : undefined;
}
function decode(s) {
  return String(s).replace(/&(amp|quot|#39|apos|lt|gt|#x2F|#47);/gi, (_, e) =>
    ({ amp: "&", quot: '"', "#39": "'", apos: "'", lt: "<", gt: ">", "#x2f": "/", "#47": "/" })[e.toLowerCase()]);
}
function stripTags(html) {
  return String(html).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
}
function* walk(node) {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (node && typeof node === "object") {
    yield node;
    if (node["@graph"]) yield* walk(node["@graph"]);
    if (node.video) yield* walk(node.video);
  }
}
const first = (x) => (Array.isArray(x) ? x[0] : x);
const num = (x) => (x && Number.isFinite(+x) && +x > 0 ? Math.round(+x) : undefined);
export function isoDuration(s) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(String(s || "").trim());
  if (!m) return undefined;
  const t = (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + Math.round(+m[4] || 0);
  return t || undefined;
}
const mime = (u) => (/\.webm/i.test(u) ? "video/webm" : /\.ogv/i.test(u) ? "video/ogg" : "video/mp4");
