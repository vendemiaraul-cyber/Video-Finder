// POST /api/auth/login  { username, password }
import { login } from "../../../server/feed.js";
import { endpoint, json, readJson, sessionCookie, clientIp } from "../../../server/feed-http.js";

export const onRequestPost = endpoint(async ({ request, db }) => {
  const { user, token } = await login(db, await readJson(request), clientIp(request));
  return json(200, { user: { username: user.username } }, { "set-cookie": sessionCookie(token) });
}, { write: true });
