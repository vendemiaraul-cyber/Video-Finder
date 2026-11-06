/**
 * Claude video finder: Claude searches the web (server-side web_search tool)
 * for videos on ANY website, then reports them through the show_videos tool.
 * Gol recognises each URL and plays it with that site's official player, or
 * shows a "watch on <site>" card when the site can't be embedded.
 *
 * Runs entirely in the browser with the visitor's own Anthropic API key,
 * which never leaves their browser except to go to api.anthropic.com.
 */

export const SDK_URL = "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.1.0/+esm";

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (best results)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (faster, cheaper)" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (fastest, cheapest)" },
];
export const DEFAULT_MODEL = MODELS[0].id;

// Models that accept the server-side refusal fallback ("default" routing).
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);
const MAX_TURNS = 6;

const SHOW_VIDEOS = {
  name: "show_videos",
  description: "Show the videos you found to the user. Call this exactly once, after searching.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["videos"],
    properties: {
      videos: {
        type: "array",
        description: "The videos, best match first.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["url", "title", "site", "channel", "why"],
          properties: {
            url: { type: "string", description: "The video's own watch-page URL, exactly as it appeared in a search result." },
            title: { type: "string" },
            site: { type: "string", description: "Name of the website, e.g. Vimeo" },
            channel: { type: "string", description: "Creator or channel name, or an empty string if unknown." },
            why: { type: "string", description: "Under 15 words: why this video fits the request." },
          },
        },
      },
    },
  },
};

export function systemPrompt(playableSites, count) {
  return `You are the video finder inside MeoDeo, a website that gathers videos from many websites into one page.

The user types what they want to watch. Use web search to find individual videos that match it, then call show_videos once with up to ${count} of them.

- Every URL must be the watch page of one specific video (not a channel, playlist, search page or article), and must have appeared in your search results. Never construct or guess a URL.
- Spread the results across different websites when good matches exist; don't return only one site.
- MeoDeo can play videos from these sites inside the page, so prefer them when the match is equally good: ${playableSites.join(", ")}. Videos from other sites are still welcome; they open on their own website.
- If the request is in another language, search and answer in that language too.
- If you find nothing suitable, call show_videos with an empty list.`;
}

/** Normalise a URL for comparing "did this appear in search results?". */
export function urlKey(url) {
  try {
    const u = new URL(url);
    return (u.hostname.replace(/^(www|m)\./, "") + u.pathname.replace(/\/+$/, "") + u.search).toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Ask Claude for videos.
 * @param {string} query
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {import("../gol/gol.js").Gol} opts.gol
 * @param {string} [opts.model]
 * @param {number} [opts.count]
 * @param {AbortSignal} [opts.signal]
 * @param {(msg: string) => void} [opts.onStatus]
 * @param {(apiKey: string) => Promise<any>} [opts.createClient]  injectable for tests
 */
export async function findWithClaude(query, opts) {
  const { apiKey, gol, model = DEFAULT_MODEL, count = 10, signal, onStatus = () => {} } = opts;
  if (!apiKey) throw new Error("Add your Anthropic API key in Settings to search with Claude.");
  const client = await (opts.createClient || defaultClient)(apiKey);

  const playable = [...gol.sites.values()].filter((s) => s.match || s.embedHosts).map((s) => s.name);
  const params = {
    model,
    max_tokens: 16000,
    system: systemPrompt(playable, count),
    output_config: { effort: "medium" },
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 6 }, SHOW_VIDEOS],
  };
  if (FALLBACK_MODELS.has(model)) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }

  const messages = [{ role: "user", content: `Find videos: ${query}` }];
  const seen = new Set(); // URLs that came back from web search
  onStatus("Claude is searching the web…");

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await client.beta.messages.create({ ...params, messages }, { signal });

    let searches = 0;
    for (const block of res.content) {
      if (block.type === "server_tool_use" && block.name === "web_search") searches++;
      if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
        for (const r of block.content) if (r.url) seen.add(urlKey(r.url));
      }
    }
    if (searches) onStatus(`Claude searched the web ${searches}×, reading results…`);

    if (res.stop_reason === "refusal") {
      throw new Error("Claude declined this search" + (res.stop_details?.explanation ? `: ${res.stop_details.explanation}` : "."));
    }
    const call = res.content.find((b) => b.type === "tool_use" && b.name === "show_videos");
    if (call) return buildVideos(call.input?.videos, { gol, seen, count });

    messages.push({ role: "assistant", content: res.content });
    if (res.stop_reason === "pause_turn") continue; // server resumes the search where it stopped
    if (res.stop_reason === "max_tokens") throw new Error("Claude's answer was cut off; try a shorter request.");
    messages.push({ role: "user", content: "Please call show_videos with the videos you found." });
  }
  throw new Error("Claude didn't finish in time; try again.");
}

async function defaultClient(apiKey) {
  const { default: Anthropic } = await import(SDK_URL);
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
}

/** Turn Claude's list into Gol videos, keeping only URLs web search returned. */
export function buildVideos(list, { gol, seen, count }) {
  const out = [];
  const ids = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item.url !== "string") continue;
    if (seen.size && !seen.has(urlKey(item.url))) continue; // drop anything Claude didn't actually find
    const v = gol.fromUrl(item.url, {
      title: item.title || undefined,
      channel: item.channel || undefined,
      note: item.why || undefined,
      via: "claude",
      ...(item.site ? { siteName: item.site } : {}),
    });
    if (!v) continue;
    // A recognised site keeps its own name; only unknown sites use Claude's label.
    if (v.site !== "web") v.siteName = gol.sites.get(v.site).name;
    const key = v.site + ":" + v.id;
    if (ids.has(key)) continue;
    ids.add(key);
    out.push(v);
    if (out.length >= count) break;
  }
  return out;
}
