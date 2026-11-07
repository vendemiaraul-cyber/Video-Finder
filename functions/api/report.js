// POST /api/report  { postId, reason, details } -> report a feed post (anyone)
import { reportPost } from "../../server/feed.js";
import { endpoint, json, readJson, clientIp } from "../../server/feed-http.js";

export const onRequestPost = endpoint(async ({ request, db, user }) => {
  return json(200, await reportPost(db, user, await readJson(request), clientIp(request)));
}, { write: true });
