// POST /api/admin  (header X-MeoDeo-Admin: <ADMIN_KEY>)
// The owner's moderation tools: ban list, reports, takedown requests, hidden posts.
// ADMIN_KEY is an encrypted Secret in the Cloudflare project; without it this is off.
import { checkAdmin, moderationOverview, banSite, unbanSite, setPostHidden, deletePostAsOwner, setTakedownStatus, FeedError } from "../../server/feed.js";
import { endpoint, json, readJson, clientIp } from "../../server/feed-http.js";
import { setting } from "./search.js";

const ACTIONS = {
  overview: (db) => moderationOverview(db),
  ban: (db, b) => banSite(db, b.domain, b.reason),
  unban: (db, b) => unbanSite(db, b.domain),
  hidePost: (db, b) => setPostHidden(db, b.id, true),
  restorePost: (db, b) => setPostHidden(db, b.id, false),
  deletePost: (db, b) => deletePostAsOwner(db, b.id),
  rejectTakedown: (db, b) => setTakedownStatus(db, b.id, "rejected"),
  removeTakedown: (db, b) => setTakedownStatus(db, b.id, "removed"),
};

export const onRequestPost = endpoint(async ({ request, env, db }) => {
  await checkAdmin(db, request.headers.get("x-meodeo-admin"), setting(env, "ADMIN_KEY"), clientIp(request));
  const body = await readJson(request);
  const run = ACTIONS[body.action];
  if (!run) throw new FeedError(400, "bad-action", "Unknown action.");
  return json(200, await run(db, body));
}, { write: true });
