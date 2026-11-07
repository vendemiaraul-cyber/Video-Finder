// SearXNG: a metasearch engine that asks dozens of search engines at once.
// MeoDeo talks to it through the MeoDeo Node server (server/server.js),
// which keeps only pages that really offer a video and works out how to
// play each one. Results keep their real website (YouTube, Vimeo, a news
// site...), so they render like any other Gol video.
export default {
  id: "searxng",
  name: "SearXNG",
  domain: "searxng.org",
  color: "#3050ff",
  ads: false,
  needsServer: true,
  limit: 40, // SearXNG gathers many sites, so it may return more than one site's share
  // A free server (e.g. Render) sleeps when unused and takes about a minute to wake.
  deadlineMs: 90000,

  async search(q, { fetchJSON, keys }) {
    const base = (keys.serverUrl || "").replace(/\/+$/, "");
    const data = await fetchJSON(`${base}/api/search?q=${encodeURIComponent(q)}`).catch((e) => {
      throw new Error(e.message === "HTTP 502" ? "SearXNG problem, see the server log" : e.message);
    });
    return data.videos || [];
  },
};
