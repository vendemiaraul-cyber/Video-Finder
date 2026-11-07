// POST /api/posts  { url, caption } -> post a video to the public feed (signed in)
import { createPost } from "../../../server/feed.js";
import { endpoint, json, readJson, resolveVideo } from "../../../server/feed-http.js";

export const onRequestPost = endpoint(async ({ request, db, user }) => {
  const post = await createPost(db, user, await readJson(request), { resolveVideo });
  return json(201, { post });
}, { write: true });
