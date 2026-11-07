# MeoDeo

**Search videos across many websites at once. Powered by Gol and SearXNG.**

Type what you want to watch. MeoDeo asks lots of video websites at the same time, shows every result with the website it came from, and plays it right on the page using that website's own player.

## Websites

| Website | How MeoDeo finds videos | Plays on MeoDeo | Ads |
|---|---|---|---|
| YouTube | Search (your own key, else MeoDeo's backend on Cloudflare or the MeoDeo server, else public Piped servers) | ✅ official YouTube player | ✅ YouTube's ads |
| Dailymotion | Search | ✅ official player | ✅ Dailymotion's ads |
| PeerTube (thousands of independent sites) | Search via SepiaSearch | ✅ each site's own player | none |
| Odysee | Search | ✅ official player | ✅ Odysee's ads |
| Internet Archive | Search | ✅ official player | none |
| Wikimedia Commons | Search | ✅ browser video player | none |
| NASA Image & Video Library | Search | ✅ browser video player | none |
| Europeana (hundreds of European archives) | Search | opens on the archive's website | none |
| Pexels | Search (free key needed) | ✅ browser video player | none |
| Vimeo, Twitch, TikTok, TED, Streamable, Bilibili, Facebook, Instagram, Loom | Found through SearXNG | ✅ official players | Twitch and Facebook show their own ads |
| Any other website with a video | Found through SearXNG, checked by the MeoDeo server | its own player if it allows embedding, otherwise opens on the site | - |

**YouTube player:** MeoDeo uses YouTube's official IFrame Player API. Videos play inside the page on phones (no forced fullscreen), links with a time (`&t=1m30s`) start there, and Shorts play in a vertical player. When YouTube won't play a video on other sites, MeoDeo shows an **Open in YouTube** button (it opens the YouTube app on phones) instead of a dead "Video unavailable" screen.

**Ads:** MeoDeo never downloads, re-streams or strips videos. Ad-supported sites always play in their own official player, so their ads run normally and creators still get paid. These sites have an **ADS** tag, and the player shows a note when one is playing.

## Powered by Gol

[Gol](gol/README.md) is MeoDeo's own library for video websites. Each website is one small definition file that tells Gol how to search the site and how to play its videos. Gol then searches every site in parallel, recognises video links from any site it knows, and renders cards and players safely.

## Powered by SearXNG

[SearXNG](https://docs.searxng.org/) is a metasearch engine that asks dozens of search engines at once. MeoDeo uses its JSON API through the **MeoDeo server** (`server/`), a small Node.js server with no dependencies:

1. It asks SearXNG for videos (`categories=videos`, 2 result pages).
2. Links to sites Gol knows play in that site's official player.
3. Every other link is opened by the server, which keeps only pages that really offer a video:
   - an article that embeds a YouTube/Vimeo/... player plays that player
   - a page with its own player (`og:video`, `twitter:player`, JSON-LD `VideoObject`) plays it, if the player allows embedding
   - a page with a plain mp4/webm file plays in the browser's player
   - a page with no video at all is dropped
4. Pages behind a cookie wall, consent page or sign-in are marked **🍪 cookies**.

**Playing other websites' videos inside MeoDeo** (all open standards and open-source tools):
- **oEmbed**: the official embed player a site publishes, found through the site's own oEmbed tag or the [oembed.com provider list](https://oembed.com/providers.json) (kept in `gol/oembed-providers.js`; refresh with `node scripts/update-oembed-providers.mjs`).
- **HLS streams** (`.m3u8`, used by many news and TV sites) play with [hls.js](https://github.com/video-dev/hls.js) where the browser has no native HLS.
- **"Play here"**: when a page has no embeddable player but allows being shown inside other sites, MeoDeo can open the page itself in its player.
- **Many more pages checked**: the search answers with SearXNG's candidates at once, and the browser has each page checked by its own request (`/api/probe`, answers kept 3 days), up to 48 pages per search, with a second SearXNG page when needed. Results appear as they're confirmed.
- MeoDeo never pulls a video out of a site's player or works around a site's embedding rules, so sites' ads and protections stay as they are.

**Cookies setting (⚙ Settings → 🍪 Cookies):** some sites only play after you accept their cookies or sign in. By default MeoDeo plays those **inside its player**, where you accept the site's cookies or sign in (embedded players get the browser's Storage Access permission). Choose "Open them on their own website" to open them in a new tab instead. Safari limits cookies inside other sites more than other browsers; "Watch on …" under the player always works.

### Turn SearXNG on: one command

On any computer with [Docker](https://docs.docker.com/get-docker/):

```bash
git clone https://github.com/vendemiaraul-cyber/Video-Finder
cd Video-Finder
docker compose up -d          # or: npm run up
```

Open **http://localhost:8787**. From your phone on the same Wi-Fi, open `http://<the computer's IP>:8787`. This starts SearXNG, already set up for MeoDeo (`searxng/settings.yml`: JSON API on, limiter off), next to the MeoDeo server. Stop it with `docker compose down`.

Optional: copy `.env.example` to `.env` and set your own `SEARXNG_SECRET`.

MeoDeo's ⚙ Settings shows whether SearXNG is on, explains what's wrong when it isn't (not running, JSON API off, limiter on), and has a **Check again** button.

### Use your own SearXNG

Your SearXNG needs the JSON API on. In its `settings.yml`:

```yaml
search:
  formats:
    - html
    - json        # MeoDeo needs this
server:
  limiter: false  # your own instance: don't rate-limit MeoDeo
```

Then start MeoDeo (Node 18+, nothing to install):

```bash
SEARXNG_URL=http://127.0.0.1:8888 npm start
# open http://127.0.0.1:8787
```

| Variable | Default | Meaning |
|---|---|---|
| `SEARXNG_URL` | `http://127.0.0.1:8888` | your SearXNG; several, comma-separated, are tried in order |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | where MeoDeo listens |
| `SEARXNG_PAGES` | `2` | SearXNG result pages per search (1-5) |
| `SEARXNG_CATEGORIES` | `videos` | e.g. `videos,general` to check more pages |
| `PROBE_LIMIT` | `16` | max unknown pages checked per search |
| `ALLOW_ORIGIN` | `*` | CORS, so the GitHub Pages copy can use your server |
| `YOUTUBE_API_KEY` | (none) | official YouTube Data API for `/api/youtube`; without it, YouTube's web search is used |

The server only opens public web pages: it refuses private and local network addresses, caps time and size, and serves only the app's own files.

On GitHub Pages (no server), MeoDeo still searches the other websites directly. To add SearXNG there, run the MeoDeo server and put its address in ⚙ Settings → SearXNG.

## Human verification (hCaptcha or Cloudflare Turnstile)

On first visit MeoDeo asks visitors to prove they're human, so bots don't use up the free servers. They pick one of two free services:

- **🧩 hCaptcha**: the classic CAPTCHA (pick the matching pictures).
- **☁️ Cloudflare Turnstile**: usually takes a moment with no puzzle; sometimes one click.

Passing sets a signed cookie for 7 days. **In-app browsers** (TikTok, Instagram, Facebook, Snapchat, X, LinkedIn, LINE, WeChat, Pinterest, Threads) skip the check. That's detected from the browser's user agent, which a bot could fake, so rate limits stay in place. Page checks (`/api/probe`), sign-ups and posting require verification; the Claude skill's endpoints (`/api/search`, `/api/youtube`) don't.

Verification is **off until a service has its keys**. Add them to the Cloudflare Pages project (Settings → Variables and Secrets), then redeploy:

| Name | Type | Where to get it |
|---|---|---|
| `HCAPTCHA_SITE_KEY` | Text | dashboard.hcaptcha.com → Sites → your site |
| `HCAPTCHA_SECRET` | Secret | dashboard.hcaptcha.com → Settings → Secret key |
| `TURNSTILE_SITE_KEY` | Text | Cloudflare dashboard → Turnstile → your widget |
| `TURNSTILE_SECRET` | Secret | same widget → Secret key |

Either pair alone turns on that option. Both services are free (Turnstile: unlimited checks; hCaptcha: free Basic plan). The cookie-signing secret is created automatically in D1 (or set `MEODEO_SECRET`).

## Black screens

Some players load but never show anything. MeoDeo switches to the "watch on site" panel by itself when a player doesn't load in 20 seconds (15 for video files), and the player has a **Not playing?** button. For websites without a Gol definition, that also reports the site; after a few reports (more than times it worked), searches flag it as "site only".

## Public feed and MeoDeo accounts

The **Feed** tab shows videos shared by MeoDeo users. Anyone can watch; to post, create a free MeoDeo account (username + password) and paste a video link. MeoDeo checks the link first and only accepts videos that play inside MeoDeo, names them from the site's oEmbed, and lets you delete your own posts. The player has a **Post to feed** button too.

It runs on Cloudflare Pages Functions (`functions/api/auth/*`, `me.js`, `feed.js`, `posts/*`) with a **Cloudflare D1** database (free plan, no card). Setup:

1. Cloudflare dashboard → **Storage & databases → D1 SQL database → Create** → name it `meodeo`.
2. **Workers & Pages → video-finder → Settings → Bindings → Add → D1 database**: variable name **`DB`**, database **`meodeo`** → Save.
3. Redeploy. MeoDeo creates its tables on first use.

Safety: passwords are stored as salted PBKDF2 hashes; session cookies are HttpOnly, Secure and SameSite, and the database keeps only their hash; posting and account changes are only accepted from MeoDeo's own pages; sign-ups (5 per IP a day), failed log-ins (20 per IP an hour) and posts (30 per user a day) are rate limited, with IPs stored only as hashes. As the site owner you're responsible for what's posted, so keep an eye on the feed.

The D1 database also stores which websites allow or refuse embedding, shared by all searches.

## Use MeoDeo from Claude (skill)

The `meodeo-video-search` skill lets Claude search videos through MeoDeo in any project.

- **claude.ai / Claude apps:** save the `meodeo-video-search.skill` file (Save skill), or upload the `plugins/meodeo/skills/meodeo-video-search` folder as a zip under Settings → Skills.
- **Claude Code, any project:** `/plugin marketplace add vendemiaraul-cyber/Video-Finder`, then `/plugin install meodeo@meodeo`.

It calls `https://video-finder.pages.dev/api/search`, `/api/youtube` and `/api/health` (set `MEODEO_URL` for another deployment).

## Publish on Cloudflare Pages (free, no card)

1. On **dash.cloudflare.com**, open **Workers & Pages → Create → Pages → Connect to Git**, and pick **Video-Finder**.
2. Production branch: the branch with MeoDeo. **Build command:** leave empty. **Build output directory:** `/`.
3. **Save and Deploy.** MeoDeo goes live at `https://<project>.pages.dev`.

Cloudflare also runs `functions/api/youtube.js` (a Pages Function), which gives MeoDeo its own YouTube search, so YouTube works without a key and without the public Piped servers. Optional: in the Pages project's **Settings → Variables and Secrets**, add `YOUTUBE_API_KEY` to use the official YouTube Data API instead. On the free plan, going over the daily request allowance makes this function return an error until the next day; Cloudflare never charges you without a paid plan.

**SearXNG on Cloudflare:** SearXNG itself can't run on Cloudflare, so it runs on **Render's free plan** (Docker web service, no card) from `searxng-host/`: SearXNG with the JSON API on, behind a small lock (`gate.py`) that only answers requests carrying `MEODEO_KEY`. Two Pages Functions (`functions/api/search.js`, `functions/api/health.js`) reach it. Set:

| Where | Name | Value |
|---|---|---|
| Render service | `MEODEO_KEY` | a long random string |
| Render service | `SEARXNG_SECRET` | another long random string |
| Cloudflare Pages | `SEARXNG_URL` | the Render address, e.g. `https://meodeo-searxng.onrender.com` |
| Cloudflare Pages (secret) | `SEARXNG_KEY` | the same value as `MEODEO_KEY` |

Then redeploy. ⚙ Settings in MeoDeo shows whether SearXNG is on. Render's free plan sleeps after 15 minutes without use, so the first search after a break takes about a minute.

## Publish on GitHub Pages

MeoDeo is plain HTML, CSS and JavaScript with no build step.

1. On GitHub, open the repository's **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
3. Choose the branch (`main` once this work is merged) and the **/ (root)** folder, then **Save**.
4. After a minute the site is live at `https://vendemiaraul-cyber.github.io/Video-Finder/`.

## Run it locally

```bash
npm start                       # MeoDeo server with SearXNG: http://localhost:8787
npm run static                  # website only, without SearXNG: http://localhost:8000
```

Opening `index.html` directly as a file won't work, because browsers block ES modules on `file://`.

## Tests

```bash
npm test      # Node 18+, no dependencies
```

## Dailymotion Player ID

Since 28 September 2026 Dailymotion only plays embeds that include a **Player ID**
(`geo.dailymotion.com/player/<ID>.html`); the old `player.html` link answers 403
and shows a black screen. Until MeoDeo has one, Dailymotion videos open on
dailymotion.com instead of playing inside MeoDeo.

To turn playing back on (free):

1. Sign in (or make a free account) at <https://www.dailymotion.com/partner>.
2. Go to **Players → Create player**, keep the defaults, save.
3. Copy its ID (it starts with `x`, e.g. `xabc1`) and put it in `PLAYER_ID` in
   `gol/sites/dailymotion.js`. It's public, not a secret.

Anyone can also paste their own Player ID in MeoDeo's Settings.

## Languages

The 🌐 menu translates MeoDeo with Google's free website translator
(`translate.google.com/translate_a/element.js`: no key, no account, no billing).
Google's script is only loaded after someone picks a language other than English.
Site names, the MeoDeo name and links are marked `translate="no"`.

## Rules, reports and takedowns

- **Content filter** (`gol/safety.js`): blocks adult, shock and piracy websites
  and words in search results (browser, SearXNG server, skill) and in feed posts,
  on top of each site's own safe search.
- **Terms, Rules, Privacy, Copyright**: `legal.html`, linked from the footer.
  Sign-up requires confirming 13+ and agreeing to the Terms.
- **Report** button on feed posts (`POST /api/report`): hidden automatically once
  3 different people report a post.
- **Takedown requests** (`POST /api/takedown`, form on `legal.html#copyright`):
  the link is removed at once from the feed and from search results
  (`GET /api/takedown` lists removed links), then reviewed.

Review in Cloudflare → D1 → your database → Console:

```sql
SELECT * FROM takedowns ORDER BY id DESC;                    -- requests
SELECT post_id, reason, details FROM reports ORDER BY id DESC; -- reports
UPDATE takedowns SET status = 'rejected' WHERE id = 1;       -- put a link back
UPDATE posts SET hidden = 0 WHERE id = 1;                    -- restore a post
DELETE FROM posts WHERE id = 1;                              -- delete a post for good
```

## Pexels (private key on the server)

Pexels is searched by MeoDeo's server (`/api/pexels`) with the site's own key.
The key is never sent to browsers: it's stored as an encrypted Cloudflare
Secret, only sent to api.pexels.com, and Pexels' error messages aren't passed
on. Only MeoDeo's own pages can use the route, each visitor gets 60 searches an
hour, and results are cached for a day in D1, so the free Pexels allowance
(200 requests an hour, 20,000 a month) isn't used up. Pexels is free: no card
or bank account.

1. Get a free key at <https://www.pexels.com/api/> (Pexels account needed).
2. Cloudflare → Workers & Pages → your project → Settings → Variables and Secrets →
   **Add** → Type **Secret** → Name `PEXELS_API_KEY` → paste the key → Save
   (for Production).
3. Deployments → latest → **Retry deployment** (secrets apply to new deployments).

On the Node server, set `PEXELS_API_KEY` in its environment instead.

## Admin page and ban list

`admin.html` (not linked anywhere, not indexed) is the owner's moderation page:
ban or unban websites, review takedown requests, reports and hidden posts.
It shows text only (no thumbnails, players or clickable links).

Turn it on: Cloudflare → your project → Settings → Variables and Secrets → Add →
Type **Secret** → Name `ADMIN_KEY` → a long password only you know → Save,
then retry the latest deployment. Wrong passwords are limited to 10 an hour per visitor.

A banned website (and its subdomains) is left out of search (`GET /api/blocklist`),
its feed posts are hidden, and it can't be posted.

**Automatic bans:** when MeoDeo checks a web page and the page labels itself
adult-only (the RTA "Restricted To Adults" label, `<meta name="rating" content="adult">`,
schema.org `isFamilyFriendly: false`, an 18+ age restriction tag, or a
"18 U.S.C. 2257" statement), the page is dropped and its website is banned for
everyone, so nobody has to open it to decide. SearXNG now uses strict safe search.

## Versions (legacy copies for testing)

`versions.html` lists every MeoDeo version, newest first: date, what changed,
the commit, and a link to the website exactly as it was (`versions/v0-1/` …).
The copies are built from git with `node scripts/build-versions.mjs` (needs the
full history). Each copy uses today's servers and gets today's content filter,
takedowns and ban list (`versions/legacy-guard.js`), a "Legacy version" bar and
a noindex tag. The first version's Claude finder is switched off (it needed a
paid Anthropic API key).
