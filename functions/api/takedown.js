// POST /api/takedown  { url, name, contact, work, kind, details, sworn } -> copyright / legal removal request
// GET  /api/takedown -> links removed from MeoDeo (left out of search results)
import { requestTakedown, listTakenDown } from "../../server/feed.js";
import { endpoint, json, readJson, clientIp } from "../../server/feed-http.js";

export const onRequestPost = endpoint(async ({ request, db }) => {
  return json(200, await requestTakedown(db, await readJson(request), clientIp(request)));
}, { write: true });

export const onRequestGet = endpoint(async ({ db }) => {
  return json(200, { removed: await listTakenDown(db) }, { "cache-control": "public, max-age=300" });
});
