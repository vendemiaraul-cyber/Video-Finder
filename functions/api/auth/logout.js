// POST /api/auth/logout
import { logout } from "../../../server/feed.js";
import { endpoint, json, clearCookie } from "../../../server/feed-http.js";

export const onRequestPost = endpoint(async ({ request, db }) => {
  await logout(db, request);
  return json(200, { ok: true }, { "set-cookie": clearCookie });
}, { write: true });
