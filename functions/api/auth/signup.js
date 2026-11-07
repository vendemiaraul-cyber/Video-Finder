// POST /api/auth/signup  { username, password }
import { signup } from "../../../server/feed.js";
import { endpoint, json, readJson, sessionCookie, clientIp } from "../../../server/feed-http.js";

export const onRequestPost = endpoint(async ({ request, db }) => {
  const { user, token } = await signup(db, await readJson(request), clientIp(request));
  return json(200, { user: { username: user.username } }, { "set-cookie": sessionCookie(token) });
}, { write: true });
