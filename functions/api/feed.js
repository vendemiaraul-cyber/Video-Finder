// GET /api/feed?before=<post id>&limit=20 -> public feed, newest first
import { listFeed } from "../../server/feed.js";
import { endpoint, json } from "../../server/feed-http.js";

export const onRequestGet = endpoint(async ({ request, db, user }) => {
  const q = new URL(request.url).searchParams;
  return json(200, await listFeed(db, { before: q.get("before"), limit: q.get("limit"), user }));
});
