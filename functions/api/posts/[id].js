// DELETE /api/posts/:id -> delete one of your own posts
import { deletePost } from "../../../server/feed.js";
import { endpoint, json } from "../../../server/feed-http.js";

export const onRequestDelete = endpoint(async ({ params, db, user }) => {
  await deletePost(db, user, params.id);
  return json(200, { ok: true });
}, { write: true });
