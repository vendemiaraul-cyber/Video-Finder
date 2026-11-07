// HTTP helpers shared by the feed's Cloudflare Pages Functions.
import { Gol } from "../gol/gol.js";
import sites from "../gol/sites/index.js";
import { toVideos } from "./searxng.js";
import { workerFetchPage } from "./worker-fetch.js";
import { oembedMeta } from "./oembed.js";
import { FeedError, ensureSchema, currentUser } from "./feed.js";

const SESSION_MAX_AGE = 30 * 86400;

export const json = (status, data, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
});
export const sessionCookie = (token) => `meodeo_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`;
export const clearCookie = "meodeo_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
export const clientIp = (request) => request.headers.get("cf-connecting-ip") || "";

/** Requests that change something must come from MeoDeo itself (blocks cross-site forgery). */
function fromThisSite(request) {
  const origin = request.headers.get("origin");
  if (origin) return origin === new URL(request.url).origin;
  return request.headers.get("sec-fetch-site") !== "cross-site";
}

export async function readJson(request) {
  if (!(request.headers.get("content-type") || "").includes("application/json")) throw new FeedError(415, "json-required", "Send JSON.");
  try { return await request.json(); } catch { throw new FeedError(400, "bad-json", "That request wasn't valid JSON."); }
}

/**
 * Wrap a feed endpoint: database check, same-site check for writes, schema,
 * current user, and errors as JSON.
 */
export function endpoint(fn, { write = false } = {}) {
  return async (context) => {
    const { request, env } = context;
    if (!env.DB) return json(503, { error: "The feed isn't set up yet: this Cloudflare project has no D1 database bound as DB.", code: "no-db" });
    if (write && !fromThisSite(request)) return json(403, { error: "Requests must come from MeoDeo.", code: "cross-site" });
    try {
      await ensureSchema(env.DB);
      const user = await currentUser(env.DB, request);
      return await fn({ ...context, db: env.DB, user });
    } catch (err) {
      if (err instanceof FeedError) return json(err.status, { error: err.message, code: err.code });
      console.error(err);
      return json(500, { error: "Something went wrong on MeoDeo's side.", code: "server" });
    }
  };
}

/** Turn a posted link into a Gol video: known sites directly, other pages through the probe. */
export async function resolveVideo(url) {
  const gol = new Gol().register(sites);
  const budget = { left: 12 };
  const { videos } = await toVideos([{ url, category: "videos" }], {
    gol, skip: new Set(), perSite: 1, probeLimit: 1,
    probeOpts: { fetch: (u, o) => workerFetchPage(u, { ...o, budget }), timeoutMs: 6000 },
  });
  const video = videos[0];
  if (!video) return null;
  // A bare link (e.g. youtu.be/...) has no title: ask the site's oEmbed for it.
  if (!video.title || video.title === "(untitled)" || video.title === video.url) {
    const meta = await oembedMeta(video.url, (u, o) => workerFetchPage(u, { ...o, budget }), { timeoutMs: 5000 });
    if (meta) {
      if (meta.title) video.title = meta.title;
      video.channel ||= meta.channel;
      video.thumbnail ||= meta.thumbnail;
    }
  }
  return video;
}
