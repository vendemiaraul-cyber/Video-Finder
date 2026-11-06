# MeoDeo

**Search videos across many websites at once. Powered by Gol and Claude.**

Type what you want to watch. MeoDeo asks lots of video websites at the same time, shows every result with the website it came from, and plays it right on the page using that website's own player.

## Websites

| Website | How MeoDeo finds videos | Plays on MeoDeo | Ads |
|---|---|---|---|
| YouTube | Search (official API with your key, otherwise a public Piped server) | ✅ official YouTube player | ✅ YouTube's ads |
| Dailymotion | Search | ✅ official player | ✅ Dailymotion's ads |
| PeerTube (thousands of independent sites) | Search via SepiaSearch | ✅ each site's own player | none |
| Odysee | Search | ✅ official player | ✅ Odysee's ads |
| Internet Archive | Search | ✅ official player | none |
| Wikimedia Commons | Search | ✅ browser video player | none |
| NASA Image & Video Library | Search | ✅ browser video player | none |
| Europeana (hundreds of European archives) | Search | opens on the archive's website | none |
| Pexels | Search (free key needed) | ✅ browser video player | none |
| Vimeo, Twitch, TikTok, TED, Streamable, Bilibili, Facebook, Instagram, Loom | Found by Claude on the web | ✅ official players | Twitch and Facebook show their own ads |
| Any other website | Found by Claude on the web | opens on that website | - |

**Ads:** MeoDeo never downloads, re-streams or strips videos. Ad-supported sites always play in their own official player, so their ads run normally and creators still get paid. These sites have an **ADS** tag, and the player shows a note when one is playing.

## Powered by Gol

[Gol](gol/README.md) is MeoDeo's own library for video websites. Each website is one small definition file that tells Gol how to search the site and how to play its videos. Gol then searches every site in parallel, recognises video links from any site it knows, and renders cards and players safely.

## Powered by Claude

Turn on **✦ Ask Claude too** and Claude searches the whole web for matching videos. It can find videos on sites Gol can't search directly, such as Vimeo, TED or news websites, and it says why it picked each one. Gol then plays every link it recognises.

Claude needs your own Anthropic API key (⚙ Settings). The key is kept only in your browser and is sent only to `api.anthropic.com`; each Claude search is billed to your Anthropic account. MeoDeo uses Claude Opus 5.5 by default, with Sonnet 5.5 and Haiku 5.5 as faster, cheaper choices. On Opus and Sonnet, if Claude declines a request, Anthropic's server automatically retries it on a fallback model (`fallbacks: "default"`).

## Publish on GitHub Pages

MeoDeo is plain HTML, CSS and JavaScript with no build step.

1. On GitHub, open the repository's **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
3. Choose the branch (`main` once this work is merged) and the **/ (root)** folder, then **Save**.
4. After a minute the site is live at `https://vendemiaraul-cyber.github.io/Video-Finder/`.

## Run it locally

```bash
python3 -m http.server 8000     # or: npm start
# open http://localhost:8000
```

Opening `index.html` directly as a file won't work, because browsers block ES modules on `file://`.

## Tests

```bash
npm test      # Node 18+, no dependencies
```
