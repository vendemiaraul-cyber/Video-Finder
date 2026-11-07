/**
 * Gol - a small library that knows how to search video websites and how to
 * render their videos safely.
 *
 * Every website is a "site definition" (see gol/sites/). Gol does the rest:
 *   - searches many sites in parallel, with a deadline per search
 *   - recognises a video URL from any known site (Gol.fromUrl)
 *   - renders cards and players (see gol/render.js), only through each
 *     site's official embed player, so ad-supported sites keep their ads
 *
 * No build step, no dependencies: plain ES modules that work in browsers and
 * in Node 18+ (for tests).
 */

/** @typedef {{kind:'iframe', src:string} | {kind:'video', sources:{src:string,type?:string}[]} | {kind:'link'}} Play */
/**
 * @typedef {Object} GolVideo
 * @property {string} id
 * @property {string} site        site id, e.g. "youtube"
 * @property {string} siteName    e.g. "YouTube"
 * @property {string} domain      website the video lives on, e.g. "youtube.com"
 * @property {boolean} ads        the site shows ads in its player
 * @property {string} title
 * @property {string} url         watch page on the original website
 * @property {Play} play          how Gol plays it
 * @property {string} [thumbnail]
 * @property {number} [duration]  seconds
 * @property {string} [channel]
 * @property {number} [views]
 * @property {string} [published] YYYY-MM-DD
 * @property {string} [via]       which search found it, e.g. "searxng"
 * @property {boolean} [needsCookies] the site only works with its own cookies: open it there
 * @property {string} [note]      short note, e.g. "YouTube video on bbc.com"
 */

export const VERSION = "0.2.0";

export class Gol {
  constructor({ fetch: fetchImpl, deadlineMs = 12000, keys = {} } = {}) {
    this.sites = new Map();
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
    this.deadlineMs = deadlineMs;
    this.keys = keys; // API keys / settings some sites need, e.g. { youtubeKey: "..." }
    this.unavailable = new Map(); // site id -> reason it can't be searched right now
  }

  /** Add one site definition (or an array of them). */
  register(defs) {
    for (const def of [].concat(defs)) {
      validateSite(def);
      this.sites.set(def.id, def);
    }
    return this;
  }

  /** Sites that can be searched right now (have their keys, if they need any). */
  searchableSites() {
    return [...this.sites.values()].filter((s) => s.search && this.hasKeys(s) && !this.unavailable.has(s.id));
  }

  hasKeys(site) {
    return (site.keys || []).every((k) => k.optional || this.keys[k.name]);
  }

  /** Context handed to a site's search(). */
  context(signal) {
    return {
      keys: this.keys,
      signal,
      fetchJSON: async (url, init = {}) => {
        const res = await this.fetch(url, { ...init, signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      },
    };
  }

  /**
   * Search sites in parallel.
   * onPartial(siteId, videos|null, error|null) fires as each site answers,
   * so the UI can show results progressively.
   */
  async search(query, { sites, limit = 8, onPartial } = {}) {
    query = String(query || "").trim();
    if (!query) throw new Error("empty query");
    const chosen = (sites ? sites.map((id) => this.sites.get(id)) : this.searchableSites())
      .filter((s) => s && s.search && this.hasKeys(s) && !this.unavailable.has(s.id));

    const status = {};
    const perSite = {};
    await Promise.all(
      chosen.map(async (site) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(new Error("timed out")), this.deadlineMs);
        try {
          const raw = await site.search(query, { ...this.context(ctrl.signal), limit });
          const videos = raw.map((v) => this.normalize(site, v)).filter(Boolean).slice(0, site.limit || limit);
          perSite[site.id] = videos;
          status[site.id] = { ok: true, count: videos.length };
          onPartial?.(site.id, videos, null);
        } catch (err) {
          const msg = ctrl.signal.aborted ? "timed out" : err?.message || String(err);
          status[site.id] = { ok: false, count: 0, error: msg };
          onPartial?.(site.id, null, msg);
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    return { query, videos: interleave(chosen.map((s) => perSite[s.id] || [])), status };
  }

  /**
   * Turn any URL into a Gol video if a registered site recognises it.
   * Unknown https URLs become a "link" video that opens on the original site.
   */
  fromUrl(url, extra = {}) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    for (const site of this.sites.values()) {
      for (const rule of site.match || []) {
        const m = u.href.match(rule.re);
        if (m) {
          const v = this.normalize(site, { url: u.href, ...rule.video(m, u), ...extra });
          if (v) return v;
        }
      }
    }
    if (u.protocol !== "https:") return null;
    const host = u.hostname.replace(/^www\./, "");
    const web = { id: u.href, site: "web", siteName: host, domain: host, ads: false,
                  title: u.href, url: u.href, play: { kind: "link" }, ...extra };
    return this.sites.has("web") ? this.normalize(this.sites.get("web"), web) : web;
  }

  /** Fill site fields, and drop anything Gol cannot render safely. */
  normalize(site, v) {
    if (!v || !v.id || !v.url || !v.play) return null;
    // A search source (e.g. SearXNG) can return videos from other sites:
    // check each one against its own site definition.
    if (v.site && v.site !== site.id) site = this.sites.get(v.site) || null;
    if (!site) return null;
    const video = {
      site: site.id,
      siteName: site.name,
      domain: site.domain,
      ads: !!site.ads,
      needsCookies: !!site.needsCookies,
      title: "(untitled)",
      ...v,
    };
    video.title = String(video.title || "(untitled)").trim();
    if (!isHttps(video.url)) return null;
    if (video.thumbnail && !isHttps(video.thumbnail)) delete video.thumbnail;
    if (!isSafePlay(site, video.play)) return null;
    return video;
  }
}

/** Round-robin across sites so no single site fills the top of the list. */
export function interleave(lists) {
  const out = [];
  const seen = new Set();
  const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max; i++) {
    for (const list of lists) {
      const v = list[i];
      if (!v) continue;
      const key = v.site + ":" + v.id;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(v);
      }
    }
  }
  return out;
}

export function isHttps(url) {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** A player may only point at https URLs on hosts the site definition allows. */
export function isSafePlay(site, play) {
  if (play.kind === "link") return true;
  if (play.kind === "iframe") {
    if (!isHttps(play.src.replace("{parent}", "localhost"))) return false;
    const u = new URL(play.src.replace("{parent}", "localhost"));
    const hosts = site.embedHosts || [];
    if (hosts.includes("*")) return !site.embedPath || site.embedPath.test(u.pathname);
    return hosts.includes(u.hostname);
  }
  if (play.kind === "video") {
    return Array.isArray(play.sources) && play.sources.length > 0 && play.sources.every((s) => isHttps(s.src));
  }
  return false;
}

function validateSite(def) {
  for (const field of ["id", "name", "domain"]) {
    if (!def[field]) throw new Error(`Gol site is missing "${field}"`);
  }
  if (!def.search && !(def.match && def.match.length) && !def.generic) {
    throw new Error(`Gol site "${def.id}" needs search() or match rules`);
  }
}

/* Small helpers that site definitions share. */
export const util = {
  qs: (params) =>
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v))
      .join("&"),
  date: (s) => (s ? String(s).slice(0, 10) : undefined),
  first: (x) => (Array.isArray(x) ? x[0] : x),
  host: (url) => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return undefined;
    }
  },
  /** "PT1H2M3S" -> 3723 */
  isoDuration: (s) => {
    const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(s || "");
    return m ? ((+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0)) || undefined : undefined;
  },
};
