/**
 * Site embedding memory: what each website did the last times MeoDeo checked
 * one of its pages. Sites that absolutely refuse embedding get flagged, so
 * later searches skip checking them and spend their checks on other sites.
 *
 * A record per domain: { allowed, inside, blocked, cookies, updated }
 *   allowed  pages with a player MeoDeo can show (embed, oEmbed, video file)
 *   inside   pages that may be shown inside MeoDeo ("Play here")
 *   blocked  pages with a video but no way to show it in MeoDeo
 *   cookies  pages behind a cookie wall / sign-in
 */

/** How a probe result counts for its site. */
export function outcomeOf(p) {
  if (!p || p.kind === "unreachable") return null;
  if (p.kind === "iframe" || p.kind === "file" || p.kind === "gol") return "allowed";
  if (p.kind === "cookies") return "cookies";
  if (p.kind === "link") return p.inside ? "inside" : "blocked";
  return null;
}

/** A site that has refused at least twice and never allowed anything. */
export function refusesEmbedding(rec) {
  return !!rec && (rec.blocked || 0) >= 2 && !(rec.allowed || 0) && !(rec.inside || 0);
}

const bump = (rec, outcome) => ({ allowed: 0, inside: 0, blocked: 0, cookies: 0, ...rec, [outcome]: ((rec && rec[outcome]) || 0) + 1, updated: Date.now() });

/** In memory (Node server, tests). */
export class MemoryPolicy {
  constructor() { this.map = new Map(); }
  async get(domain) { return this.map.get(domain) || null; }
  async record(domain, outcome) { if (domain && outcome) this.map.set(domain, bump(this.map.get(domain), outcome)); }
}

/** Cloudflare Cache API (per data centre, free, no setup). */
export class CachePolicy {
  constructor(cache) { this.cache = cache; }
  key(domain) { return new Request(`https://site-policy.meodeo.invalid/${encodeURIComponent(domain)}`); }
  async get(domain) {
    try { const r = await this.cache.match(this.key(domain)); return r ? await r.json() : null; } catch { return null; }
  }
  async record(domain, outcome) {
    if (!domain || !outcome) return;
    const rec = bump(await this.get(domain), outcome);
    try {
      await this.cache.put(this.key(domain), new Response(JSON.stringify(rec), {
        headers: { "content-type": "application/json", "cache-control": "public, max-age=2592000" },
      }));
    } catch { /* best effort */ }
  }
}

/** Cloudflare D1 (one database for all data centres), when the feed database is set up. */
export class D1Policy {
  constructor(db) { this.db = db; }
  async get(domain) {
    try { return await this.db.prepare("SELECT allowed, inside, blocked, cookies, updated FROM site_policy WHERE domain = ?").bind(domain).first(); } catch { return null; }
  }
  async record(domain, outcome) {
    if (!domain || !outcome) return;
    try {
      await this.db.prepare(`INSERT INTO site_policy (domain, ${outcome}, updated) VALUES (?, 1, ?)
        ON CONFLICT(domain) DO UPDATE SET ${outcome} = ${outcome} + 1, updated = excluded.updated`).bind(domain, Date.now()).run();
    } catch { /* best effort */ }
  }
}
