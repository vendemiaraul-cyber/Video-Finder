// Cloudflare Pages Function: GET /api/youtube?q=...
// Gives MeoDeo on Cloudflare its own YouTube search (browsers can't call
// YouTube's search directly). Optional: set YOUTUBE_API_KEY in the Pages
// project's environment variables to use the official YouTube Data API.
// On the free plan, going over the daily request allowance makes this
// return an error until the next day; it never charges you.
import { searchYouTube } from "../../server/youtube.js";

export async function onRequestGet({ request, env }) {
  const q = (new URL(request.url).searchParams.get("q") || "").trim();
  if (!q || q.length > 300) return Response.json({ error: "missing or too long q" }, { status: 400 });
  try {
    const videos = await searchYouTube(q, { limit: 12, apiKey: env.YOUTUBE_API_KEY });
    return Response.json({ videos }, { headers: { "cache-control": "public, max-age=600" } });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 502 });
  }
}
