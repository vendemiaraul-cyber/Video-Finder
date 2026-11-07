// GET /api/blocklist -> { links, sites }: links removed after takedown requests and
// websites banned by MeoDeo's owner, left out of search results in the browser.
import { listTakenDown, listBannedSites } from "../../server/feed.js";
import { endpoint, json } from "../../server/feed-http.js";

export const onRequestGet = endpoint(async ({ db }) => {
  return json(200, { links: await listTakenDown(db), sites: await listBannedSites(db) }, { "cache-control": "public, max-age=120" });
});
