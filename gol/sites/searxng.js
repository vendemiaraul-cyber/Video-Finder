// SearXNG: a metasearch engine that asks dozens of search engines at once.
// MeoDeo reaches it through its backend (Cloudflare Pages Functions or the
// MeoDeo Node server). The search returns SearXNG's candidates right away;
// then each page is checked for a playable video by its own /api/probe
// request, so a search can check many pages, and results appear as they're
// confirmed. Results keep their real website, so they render like any other
// Gol video.
const MAX_CHECKS = 48;      // pages checked per search
const PARALLEL = 6;         // checks at the same time
const ENOUGH = 15;          // stop asking SearXNG for more pages once this many play in MeoDeo
const MAX_PAGES = 2;

const playsHere = (v) => v.play.kind !== "link" || !!v.play.inside;
const rank = (v) => (v.play.kind !== "link" ? 0 : v.play.inside ? 1 : 2);

async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

export default {
  id: "searxng",
  name: "SearXNG",
  domain: "searxng.org",
  color: "#3050ff",
  ads: false,
  needsServer: true,
  limit: 60, // SearXNG gathers many sites, so it may return more than one site's share
  // A free server (e.g. Render) sleeps when unused and takes about a minute to wake.
  deadlineMs: 150000,

  async search(q, { fetchJSON, keys, emit, signal }) {
    const base = (keys.serverUrl || "").replace(/\/+$/, "");
    const found = [];
    const seen = new Set();
    const add = (list) => {
      for (const v of list || []) if (v && v.url && !seen.has(v.url)) { seen.add(v.url); found.push(v); }
      found.sort((a, b) => rank(a) - rank(b));
      emit?.(found.slice());
    };
    let checks = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      let data;
      try {
        data = await fetchJSON(`${base}/api/search?mode=candidates&page=${page}&q=${encodeURIComponent(q)}`);
      } catch (e) {
        if (page > 1) break; // keep what page 1 found
        throw new Error(e.message === "HTTP 502" ? "SearXNG problem, try again in a minute" : e.message);
      }
      if (!Array.isArray(data.candidates)) { add(data.videos); return found; } // older backend: already checked
      add(data.videos);
      const todo = data.candidates.filter((c) => !seen.has(c.url)).slice(0, MAX_CHECKS - checks);
      await pool(todo, PARALLEL, async (result) => {
        if (signal?.aborted) return;
        checks++;
        try {
          const r = await fetchJSON(`${base}/api/probe`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ result }),
          });
          if (r.video) add([r.video]);
        } catch { /* one page failing doesn't matter */ }
      });
      if (found.filter(playsHere).length >= ENOUGH || !data.candidates.length || checks >= MAX_CHECKS) break;
    }
    return found;
  },
};
