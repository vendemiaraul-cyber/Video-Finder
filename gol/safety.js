/**
 * MeoDeo's content filter: keeps adult and shock content out of search
 * results and the feed, on top of each website's own safe search (YouTube
 * safeSearch, Dailymotion family filter, PeerTube/Odysee nsfw=false,
 * SearXNG safesearch). Used in the browser and on the server.
 */

// Adult, gore and piracy websites: never shown, never accepted in the feed.
const BLOCKED_DOMAINS = [
  "pornhub.com", "xvideos.com", "xnxx.com", "xhamster.com", "redtube.com", "youporn.com", "tube8.com", "spankbang.com",
  "eporner.com", "beeg.com", "porn.com", "hqporner.com", "txxx.com", "tnaflix.com", "motherless.com", "rule34video.com",
  "onlyfans.com", "fansly.com", "chaturbate.com", "stripchat.com", "bongacams.com", "cam4.com", "livejasmin.com", "myfreecams.com",
  "hentaihaven.xxx", "hanime.tv", "nhentai.net", "efukt.com", "theync.com", "bestgore.fun", "kaotic.com",
  "fmovies.to", "123movies.to", "soap2day.to", "putlocker.to", "gomovies.sx", "solarmovie.pe",
];
const BLOCKED_TLDS = [".xxx", ".porn", ".sex", ".adult"];

// Words in a title, channel or description that mark adult or shock content.
const UNSAFE = new RegExp(String.raw`(?<![\p{L}\p{N}])(` + [
  "porn\\w*", "xxx+", "nsfw", "hentai", "rule ?34", "onlyfans", "fansly", "nudes", "nude (pics?|photos?|scenes?|videos?|girls?|women|models?)", "nudity",
  "naked (girls?|wom[ae]n|m[ae]n|models?|body|bodies)", "topless",
  "erotic\\w*", "fetish\\w*", "camgirls?", "cam ?show", "stripteases?", "milf", "blowjobs?", "hardcore sex", "sex tape",
  "18\\+ only", "adults? only", "uncensored sex", "gore (videos?|compilation|footage)", "beheading", "execution video", "snuff films?",
  "pornografia", "porno", "desnud[oa]s?", "nackt", "nue?s? intégral",
].join("|") + String.raw`)(?![\p{L}\p{N}])`, "iu");

export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

/** "https://www.Example.com/x" or "example.com" -> "example.com" ("" if it isn't a website name). */
export function domainOf(input) {
  let s = String(input || "").trim().toLowerCase();
  if (!s) return "";
  if (!/^[a-z]+:\/\//.test(s)) s = "https://" + s;
  const host = hostOf(s);
  return /^(?=.{3,253}$)([a-z0-9-]{1,63}\.)+[a-z0-9-]{2,63}$/.test(host) ? host : "";
}

const inList = (host, list) => [...list].some((d) => host === d || host.endsWith("." + d));

/** True for adult/gore/piracy websites, built in or banned by MeoDeo's owner (extra). */
export function isBlockedDomain(urlOrHost, extra = []) {
  const host = domainOf(urlOrHost);
  if (!host) return false;
  if (BLOCKED_TLDS.some((t) => host.endsWith(t))) return true;
  return inList(host, BLOCKED_DOMAINS) || inList(host, extra);
}

/** Why a video is kept out of MeoDeo, or "" when it's fine. bannedSites: the owner's ban list. */
export function unsafeReason(video, { bannedSites = [] } = {}) {
  if (!video) return "";
  for (const u of [video.url, video.play?.src, video.play?.inside?.src, ...(video.play?.sources || []).map((s) => s.src)]) {
    if (u && isBlockedDomain(u, bannedSites)) return "blocked-site";
  }
  const text = [video.title, video.channel, video.description].filter(Boolean).join(" \n ");
  return UNSAFE.test(text) ? "adult" : "";
}

export const isSafe = (video, opts) => !unsafeReason(video, opts);

/** Normalise a link so takedowns match however it was written (no www, no tracking bits, no trailing slash). */
export function canonicalUrl(url) {
  try {
    const u = new URL(String(url).trim());
    u.hash = "";
    u.hostname = u.hostname.toLowerCase().replace(/^www\.|^m\./, "");
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|si$|feature$|ref$|t$|start$)/i.test(k)) u.searchParams.delete(k);
    u.searchParams.sort();
    return u.origin + u.pathname.replace(/\/+$/, "") + (u.search || "");
  } catch {
    return "";
  }
}
