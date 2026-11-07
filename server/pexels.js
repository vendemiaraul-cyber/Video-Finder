/**
 * Pexels search for MeoDeo's backends (Cloudflare Pages Function and the Node
 * server). The Pexels API key stays on the server: it's only ever sent to
 * api.pexels.com, and the browser only receives the video results.
 */
import { isSafe } from "../gol/safety.js";

export class PexelsError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

/** Search Pexels videos. Returns plain results without anything secret in them. */
export async function searchPexels(q, { apiKey, limit = 15, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  if (!apiKey) throw new PexelsError(503, "no-key", "Pexels isn't set up on this MeoDeo yet.");
  const url = "https://api.pexels.com/videos/search?" + new URLSearchParams({ query: q, per_page: String(Math.min(40, limit)), size: "medium" });
  let res;
  try {
    res = await fetchImpl(url, { headers: { authorization: apiKey, accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new PexelsError(502, "unreachable", "Pexels didn't answer.");
  }
  // Never pass Pexels' own error text through: report a plain reason instead.
  if (res.status === 401 || res.status === 403) throw new PexelsError(502, "bad-key", "Pexels refused MeoDeo's key.");
  if (res.status === 429) throw new PexelsError(429, "pexels-limit", "Pexels' free hourly limit is used up. Try again later.");
  if (!res.ok) throw new PexelsError(502, "pexels-error", `Pexels answered ${res.status}.`);
  const data = await res.json();
  return (data.videos || []).map((v) => {
    const files = (v.video_files || []).filter((f) => f.file_type === "video/mp4" && /^https:\/\//.test(f.link || ""))
      .sort((a, b) => Math.abs((a.width || 0) - 1280) - Math.abs((b.width || 0) - 1280));
    if (!files.length) return null;
    const slug = String(v.url || "").match(/video\/([^/]+?)-?\d*\/?$/)?.[1];
    return {
      id: String(v.id),
      title: slug ? slug.replace(/-/g, " ") : `Pexels video ${v.id}`,
      url: v.url,
      thumbnail: v.image,
      duration: v.duration,
      channel: v.user?.name,
      files: files.slice(0, 2).map((f) => ({ src: f.link, type: "video/mp4" })),
    };
  }).filter((v) => v && isSafe(v));
}
