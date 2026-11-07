#!/usr/bin/env node
/**
 * MeoDeo video search - asks the MeoDeo site's API for videos from many
 * websites at once. Node 18+, no dependencies.
 *
 *   node search.mjs "moon landing"                 # SearXNG + YouTube, Markdown list
 *   node search.mjs "lofi" --source youtube --limit 5
 *   node search.mjs "cats" --json                  # machine-readable
 *   node search.mjs --health                       # is SearXNG awake?
 *
 * MEODEO_URL overrides the site (default https://video-finder.pages.dev).
 */
const BASE = (process.env.MEODEO_URL || "https://video-finder.pages.dev").replace(/\/+$/, "");

function parseArgs(argv) {
  const opts = { query: [], limit: 15, source: "all", json: false, health: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--health") opts.health = true;
    else if (a === "--limit") opts.limit = Math.max(1, parseInt(argv[++i], 10) || 15);
    else if (a === "--source") opts.source = argv[++i];
    else if (a === "-h" || a === "--help") opts.help = true;
    else opts.query.push(a);
  }
  opts.query = opts.query.join(" ").trim();
  return opts;
}

async function getJSON(path, timeoutMs) {
  const res = await fetch(BASE + path, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`${path} returned non-JSON (HTTP ${res.status})`); }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const fmtTime = (s) => {
  if (!s) return "";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.round(s % 60);
  return (h ? `${h}:${String(m).padStart(2, "0")}` : m) + ":" + String(sec).padStart(2, "0");
};

/** YouTube results from /api/youtube are minimal: give them the same shape as Gol videos. */
const fromYouTube = (v) => ({
  id: v.id, site: "youtube", siteName: "YouTube", domain: "youtube.com", ads: true,
  title: v.title, url: `https://www.youtube.com/watch?v=${v.id}`, channel: v.channel,
  duration: v.duration, views: v.views, published: v.published,
  thumbnail: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
  play: { kind: "iframe", src: `https://www.youtube.com/embed/${v.id}` },
});

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help || (!o.query && !o.health)) {
    console.log('Usage: node search.mjs "query" [--source all|searxng|youtube] [--limit N] [--json] | --health');
    process.exit(o.help ? 0 : 2);
  }
  if (o.health) {
    const h = await getJSON("/api/health", 60000);
    console.log(o.json ? JSON.stringify(h, null, 2) : `SearXNG: ${h.searxng ? "on" : `off (${h.reason || "unknown"})`}`);
    return;
  }
  const q = encodeURIComponent(o.query);
  const jobs = {};
  // SearXNG runs on a free server that sleeps; waking it can take about a minute.
  if (o.source === "all" || o.source === "searxng") jobs.searxng = getJSON(`/api/search?q=${q}`, 100000).then((d) => d.videos || []);
  if (o.source === "all" || o.source === "youtube") jobs.youtube = getJSON(`/api/youtube?q=${q}`, 30000).then((d) => (d.videos || []).map(fromYouTube));
  const names = Object.keys(jobs);
  const settled = await Promise.allSettled(Object.values(jobs));
  const errors = {};
  const lists = settled.map((r, i) => (r.status === "fulfilled" ? r.value : ((errors[names[i]] = r.reason.message), [])));

  // Round-robin merge, dropping duplicates (same site + id, or same URL).
  const seen = new Set();
  const videos = [];
  for (let i = 0; videos.length < o.limit && lists.some((l) => i < l.length); i++) {
    for (const l of lists) {
      const v = l[i];
      if (!v || videos.length >= o.limit) continue;
      const key = `${v.site}:${v.id}`;
      if (seen.has(key) || seen.has(v.url)) continue;
      seen.add(key); seen.add(v.url);
      videos.push(v);
    }
  }

  if (o.json) {
    console.log(JSON.stringify({ query: o.query, site: BASE, count: videos.length, errors, videos }, null, 2));
    return;
  }
  console.log(`# ${videos.length} videos for "${o.query}" (via ${BASE})\n`);
  videos.forEach((v, n) => {
    const meta = [v.siteName + (v.domain && v.domain !== v.siteName ? ` (${v.domain})` : ""), fmtTime(v.duration), v.channel, v.ads ? "ads" : "", v.needsCookies ? "needs cookies" : ""]
      .filter(Boolean).join(" · ");
    console.log(`${n + 1}. **${v.title}**\n   ${meta}\n   ${v.url}` + (v.play?.kind === "iframe" ? `\n   embed: ${v.play.src}` : ""));
  });
  for (const [src, msg] of Object.entries(errors)) console.log(`\n(${src} unavailable: ${msg})`);
}

main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
