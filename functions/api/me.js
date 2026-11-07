// GET /api/me -> { feed: is the feed set up, user: { username } | null }
import { endpoint, json } from "../../server/feed-http.js";

const withDb = endpoint(async ({ user }) => json(200, { feed: true, user: user ? { username: user.username } : null }));
export const onRequestGet = (context) => (context.env.DB ? withDb(context) : json(200, { feed: false, user: null }));
