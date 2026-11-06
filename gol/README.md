# Gol

Gol is MeoDeo's library for video websites. It knows how to **search** each website, how to **recognise** a link to one of its videos, and how to **render** that video safely with the website's own player.

It is plain ES modules with no dependencies and no build step. It runs in browsers and in Node 18+.

```js
import { Gol } from "./gol/gol.js";
import sites from "./gol/sites/index.js";
import { card, player } from "./gol/render.js";

const gol = new Gol({ keys: { youtubeKey: "optional" } }).register(sites);

const { videos, status } = await gol.search("moon landing", {
  limit: 8,
  onPartial: (siteId, list, error) => { /* show results as each site answers */ },
});

document.body.append(card(videos[0], { gol, onOpen: (v) => player(v, someContainer) }));

gol.fromUrl("https://vimeo.com/76979871"); // -> a playable Gol video
```

## A Gol video

```js
{
  id, site, siteName, domain,   // domain = the website it really lives on, e.g. "tilvids.com"
  title, url,                   // url = the watch page on that website
  ads,                          // true if that website shows ads in its player
  thumbnail, duration, channel, views, published,
  play: { kind: "iframe", src }               // the site's official embed player
      | { kind: "video", sources: [{ src, type }] }  // a plain video file
      | { kind: "link" }                      // can't be embedded: open on the site
}
```

## Teaching Gol a new website

Create `gol/sites/<name>.js` and add it to `gol/sites/index.js`:

```js
import { util } from "../gol.js";

export default {
  id: "example",                 // unique key
  name: "Example Video",         // shown on badges
  domain: "example.com",
  color: "#ff6600",              // badge colour
  ads: false,                    // true if the site's player shows ads
  embedHosts: ["player.example.com"],   // the only hosts its iframe may load
  keys: [{ name: "exampleKey", label: "Example API key", optional: true }],

  // Optional: search the site. Return plain objects; Gol fills in the rest.
  async search(query, { limit, fetchJSON, keys }) {
    const data = await fetchJSON("https://api.example.com/search?" + util.qs({ q: query, n: limit }));
    return data.items.map((it) => ({
      id: it.id, title: it.title, url: `https://example.com/v/${it.id}`, thumbnail: it.thumb,
      play: { kind: "iframe", src: `https://player.example.com/embed/${it.id}` },
    }));
  },

  // Optional: recognise links to the site's videos.
  match: [{ re: /^https?:\/\/example\.com\/v\/(\w+)/,
            video: (m) => ({ id: m[1], play: { kind: "iframe", src: `https://player.example.com/embed/${m[1]}` } }) }],
};
```

The site's search API must allow requests from browsers (CORS), because MeoDeo runs on GitHub Pages with no server.

## Safety rules Gol enforces

- Watch pages, thumbnails and video files must be `https`.
- An iframe may only load a host listed in the site's `embedHosts`. PeerTube allows any host, but only on the `/videos/embed/<id>` path.
- Cards and players are built with DOM APIs, never `innerHTML`, so titles from websites can't inject code.
- Gol always plays through the website's own player or file. It never strips ads.
