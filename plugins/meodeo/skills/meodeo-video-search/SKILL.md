---
name: meodeo-video-search
description: Search for videos across many websites at once (YouTube, Dailymotion, PeerTube, Odysee, Vimeo, TikTok, Wikimedia Commons, Internet Archive and more) through the user's own MeoDeo site, video-finder.pages.dev, powered by Gol and SearXNG. Use this whenever the user wants to find, list, compare or embed videos on a topic, needs video links or embed codes for a page, app or document, wants "videos about X", "a YouTube link for Y", clips, trailers, tutorials or footage, or mentions MeoDeo, Video-Finder or Gol, even if they don't say "search".
---

# MeoDeo video search

MeoDeo is the user's own video search site, at **https://video-finder.pages.dev**. Its API searches many video websites in one call and returns each video with the website it came from, a watch link and an official embed link. Prefer it over a general web search when the goal is videos: it returns real, playable videos with consistent fields, instead of pages that merely mention videos.

## Search

Run the bundled script (Node 18+, no installs needed):

```bash
node scripts/search.mjs "moon landing"                     # SearXNG + YouTube, readable list
node scripts/search.mjs "lofi beats" --source youtube --limit 5
node scripts/search.mjs "cat videos" --json                # full data for code
node scripts/search.mjs --health                           # is SearXNG awake?
```

Options: `--source all|searxng|youtube` (default `all`), `--limit N` (default 15), `--json`. Set `MEODEO_URL` to use another MeoDeo deployment.

If Node isn't available, call the API directly with any HTTP tool (curl, fetch, a web-fetch tool):

- `GET https://video-finder.pages.dev/api/search?q=QUERY`: SearXNG results from many sites, as `{ videos: [...] }`
- `GET https://video-finder.pages.dev/api/youtube?q=QUERY`: YouTube results, as `{ videos: [{ id, title, channel, duration, views }] }`
- `GET https://video-finder.pages.dev/api/health`: `{ searxng: true|false, reason }`

## Timing

SearXNG runs on a free server that sleeps after 15 minutes without use. The first search after a break can take **up to about a minute**. The script waits up to 100 seconds, so let it finish rather than retrying early. If SearXNG still fails, YouTube results still come back; say that SearXNG was asleep or unavailable, and offer to try again.

## What a video looks like (`--json`)

```json
{
  "id": "xc1SzgGhMKc", "site": "youtube", "siteName": "YouTube", "domain": "youtube.com",
  "title": "Apollo 11: The Complete Descent", "url": "https://www.youtube.com/watch?v=xc1SzgGhMKc",
  "channel": "Apollo Flight Journal", "duration": 1192, "views": 3163291,
  "thumbnail": "https://i.ytimg.com/vi/xc1SzgGhMKc/hqdefault.jpg",
  "ads": true, "needsCookies": false,
  "play": { "kind": "iframe", "src": "https://www.youtube.com/embed/xc1SzgGhMKc" }
}
```

- `domain` is the website the video really lives on (for PeerTube, the specific server). Always show it, so people know where a video comes from.
- `play` says how to show it: `iframe` (that site's official embed player), `video` (a plain file: `play.sources[].src`), or `link` (the site doesn't allow embedding, so link to `url`).
- `ads: true` means the site shows its own ads in its player. Keep embeds on the official player so those ads, and the creator's income, stay intact. Never strip or re-host the video.
- `needsCookies: true` means the site only plays with its own cookies (consent or sign-in). Link to `url` instead of embedding.
- `duration` is in seconds.

## Presenting results

For a person, give a short numbered list: title, website (domain), length, channel, and the watch link. For code or a web page, use `play.src` in an iframe with `allow="autoplay; encrypted-media; picture-in-picture; fullscreen"` and `referrerpolicy="strict-origin-when-cross-origin"` (YouTube refuses to play without a referrer). Add `playsinline=1` to YouTube embeds, so phones play them in the page. Don't add `?autoplay` to Odysee embeds: it breaks their player.

Pick the results that best fit what the user asked for. Don't just paste everything; spread picks across websites when the matches are similarly good.
