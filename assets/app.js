import { Gol, interleave } from "../gol/gol.js";
import { rank } from "../gol/relevance.js";
import sites from "../gol/sites/index.js";
import { card, player, badge, formatCount, showFallback } from "../gol/render.js";
import { initLanguages } from "./translate.js";
import { isSafe, canonicalUrl } from "../gol/safety.js";

const $ = (s) => document.querySelector(s);
const STORE = "meodeo.settings.v2";
const PREFS = "meodeo.sites.v1";
const DEFAULTS = { cookieMode: "inside" };

// Settings live only in this browser. Storage can be unavailable (private
// mode, blocked site data), so every access is guarded.
const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* not persisted */ }
  },
};

let settings = { ...DEFAULTS, ...store.get(STORE, {}) };
// Pexels now goes through MeoDeo's server with a private key: forget any key
// an older version kept in this browser.
if (settings.pexelsKey) { delete settings.pexelsKey; store.set(STORE, settings); }
const gol = new Gol({ keys: settings }).register(sites);

const els = {
  form: $("#search-form"), q: $("#q"), filters: $("#site-filters"),
  status: $("#status"), siteStatus: $("#site-status"), results: $("#results"),
  player: $("#player"), frame: $("#player-frame"), settings: $("#settings"), settingsForm: $("#settings-form"),
};

/* ---------- MeoDeo server (SearXNG) ---------- */

const serverBase = () => (settings.serverUrl || "").replace(/\/+$/, "");

const SEARXNG_PROBLEMS = {
  "json-off": (u) => `SearXNG at ${u} is running, but its JSON API is off. Add "json" under search.formats in its settings.yml and restart it.`,
  "limiter-on": (u) => `SearXNG at ${u} is blocking MeoDeo with its limiter. Set server.limiter: false and restart it.`,
  "unreachable": (u) => `Can't reach SearXNG at ${u}. If it's on Render's free plan it may be waking up: wait a minute and tap Check again. On your own computer, start it with docker compose up -d.`,
  "auth": (u) => `SearXNG at ${u} refused MeoDeo's key. Check SEARXNG_KEY in the Cloudflare project's settings.`,
  "not-set": () => "No SearXNG address is set (SEARXNG_URL in Cloudflare or on the MeoDeo server).",
};
let searxngState = { on: false, text: "Checking…" };

let wakeTries = 0;
let serverCheck = Promise.resolve();
function checkServer(opts) {
  serverCheck = runServerCheck(opts);
  return serverCheck;
}
async function runServerCheck({ fresh = false } = {}) {
  gol.unavailable.set("searxng", "checking…");
  searxngState = { on: false, text: "Checking…" };
  showServerState();
  try {
    const res = await fetch(serverBase() + "/api/health" + (fresh ? "?fresh=1" : ""), { signal: AbortSignal.timeout(8000) });
    const data = res.ok ? await res.json() : null;
    if (data?.app !== "meodeo") throw new Error("no MeoDeo server");
    if (data.searxng) {
      wakeTries = 0;
      gol.unavailable.delete("searxng");
      searxngState = { on: true, text: `SearXNG is on ✓ (${data.searxngUrl})` };
    } else {
      const text = (SEARXNG_PROBLEMS[data.reason] || SEARXNG_PROBLEMS.unreachable)(data.searxngUrl);
      gol.unavailable.set("searxng", "SearXNG is off: see Settings");
      searxngState = { on: false, text };
      // A sleeping free server answers after about a minute: check again by itself.
      if (data.reason === "unreachable" && wakeTries < 4) {
        wakeTries++;
        searxngState.text = "SearXNG is waking up (free servers sleep when unused). Checking again in 20 seconds…";
        setTimeout(() => checkServer({ fresh: true }), 20000);
      }
    }
  } catch {
    gol.unavailable.set("searxng", "SearXNG is off: see Settings");
    searxngState = { on: false, text: serverBase()
      ? `No MeoDeo server answered at ${serverBase()}.`
      : "SearXNG is off: this copy of MeoDeo isn't running on the MeoDeo server." };
  }
  showServerState();
  renderFilters();
}

function showServerState() {
  const state = $("#server-state");
  if (!state) return;
  state.textContent = searxngState.text;
  state.classList.toggle("ok", searxngState.on);
  $("#searxng-help").hidden = searxngState.on;
}

/* ---------- content rules ---------- */
// Adult/shock content and links removed after a takedown request never show.
let removedLinks = new Set();
fetch("/api/takedown", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null))
  .then((d) => { if (Array.isArray(d?.removed)) removedLinks = new Set(d.removed); }).catch(() => {});
const allowed = (videos) => videos.filter((v) => isSafe(v) && !removedLinks.has(canonicalUrl(v.url)));

/* ---------- site filter chips ---------- */

function renderFilters() {
  const off = new Set(store.get(PREFS, []));
  els.filters.replaceChildren(...[...gol.sites.values()].filter((s) => s.search).map((site) => {
    const missingKey = !gol.hasKeys(site);
    const why = gol.unavailable.get(site.id) || (missingKey ? `Add a ${site.name} API key in Settings to search it` : "");
    const label = document.createElement("label");
    label.className = "chip notranslate" + (why ? " chip-off" : "");
    label.title = why || `Search ${site.id === "searxng" ? "the web through SearXNG" : site.domain}`;
    const cb = Object.assign(document.createElement("input"), { type: "checkbox", value: site.id,
      checked: !why && !off.has(site.id), disabled: !!why });
    cb.addEventListener("change", () => {
      const now = new Set(store.get(PREFS, []));
      cb.checked ? now.delete(site.id) : now.add(site.id);
      store.set(PREFS, [...now]);
      if (els.q.value.trim()) search(els.q.value.trim());
    });
    const dot = Object.assign(document.createElement("i"), { className: "dot" });
    dot.style.background = site.color;
    label.append(cb, dot, Object.assign(document.createElement("span"), { textContent: site.name }));
    if (site.ads) label.append(Object.assign(document.createElement("small"), { textContent: "ads", title: "Plays with the site's own ads" }));
    if (missingKey) label.append(Object.assign(document.createElement("small"), { className: "key", textContent: "key" }));
    else if (why) label.append(Object.assign(document.createElement("small"), { className: "key", textContent: site.id === "searxng" ? "off" : "server" }));
    return label;
  }));
}

const chosenSites = () => [...els.filters.querySelectorAll("input[value]:checked")].map((i) => i.value);

/* ---------- search ---------- */

let run = 0;

async function search(query) {
  const id = ++run;
  await humanReady; // verify first (no-op when not needed)
  if (id !== run) return;
  othersOpen = false;
  // If the SearXNG check is still running (a sleeping server wakes slowly), wait for it,
  // so SearXNG isn't skipped just because the answer hasn't arrived yet.
  if (gol.unavailable.get("searxng") === "checking…") {
    els.status.textContent = "Waking up SearXNG…";
    await serverCheck;
    if (id !== run) return;
  }
  history.replaceState(null, "", "?q=" + encodeURIComponent(query));
  document.title = `${query} · MeoDeo`;
  const ids = chosenSites();
  els.siteStatus.replaceChildren();
  if (!ids.length) {
    els.results.replaceChildren();
    els.status.textContent = "Pick at least one website.";
    return;
  }
  els.results.replaceChildren(...skeletons(8));
  $("#others").hidden = true;
  els.status.textContent = `Searching ${ids.length} sources for “${query}”…`;

  const perSite = {};
  const playsHere = (v) => v.play.kind !== "link" || !!v.play.inside || (v.needsCookies && settings.cookieMode !== "open");
  // Direct matches first; videos not really about the search (songs, games,
  // unrelated titles...) go below, behind "Show other results".
  const draw = () => {
    if (id !== run) return;
    let videos = allowed(interleave(ids.map((s) => perSite[s] || [])));
    if (settings.playableOnly === "on") videos = videos.filter(playsHere);
    const { main, others } = rank(query, videos);
    els.results.replaceChildren(...main.map((v) => card(v, { gol, onOpen: open })));
    showOthers(query, others);
    return { main, others };
  };
  let { videos, status } = await gol.search(query, {
    sites: ids, limit: ids.length === 1 ? 40 : 8,
    onPartial: (siteId, list) => { if (list) { perSite[siteId] = list; draw(); } },
  });
  if (id !== run) return;
  draw();
  videos = allowed(videos);
  if (settings.playableOnly === "on") videos = videos.filter(playsHere);
  const { main, others } = rank(query, videos);
  const websites = new Set(main.map((v) => v.domain)).size;
  els.status.textContent = main.length
    ? `${main.length} videos about “${query}” from ${websites} websites` + (others.length ? ` · ${others.length} other results below` : "")
    : others.length ? `No videos directly about “${query}”. ${others.length} other results below.` : `No videos found for “${query}”.`;
  els.siteStatus.replaceChildren(...ids.filter((s) => status[s]).map((s) => {
    const st = status[s], site = gol.sites.get(s);
    const li = document.createElement("li");
    li.textContent = st.ok ? `${site.name}: ${st.count}` : `${site.name}: unavailable (${siteError(st.error)})`;
    if (!st.ok) li.className = "err";
    return li;
  }));
}

let othersOpen = false;
function showOthers(query, list) {
  const box = $("#others");
  box.hidden = !list.length;
  const btn = $("#others-toggle");
  btn.textContent = `${othersOpen ? "Hide" : "Show"} ${list.length} other result${list.length === 1 ? "" : "s"} (not directly about “${query}”: songs, games, other topics)`;
  btn.setAttribute("aria-expanded", String(othersOpen));
  $("#others-list").hidden = !othersOpen;
  $("#others-list").replaceChildren(...(othersOpen ? list.map((v) => card(v, { gol, onOpen: open })) : []));
  showOthers.last = [query, list];
}
$("#others-toggle").addEventListener("click", () => {
  othersOpen = !othersOpen;
  if (showOthers.last) showOthers(...showOthers.last);
});

function siteError(msg) {
  if (/429/.test(msg)) return "busy, try again in a minute";
  if (/HTTP 40[13]/.test(msg)) return "key rejected, check Settings";
  return msg;
}

function skeletons(n) {
  return Array.from({ length: n }, () => Object.assign(document.createElement("div"), { className: "gol-card skeleton" }));
}

/* ---------- opening a video ---------- */

function open(video) {
  // Videos that need their site's cookies: open on that site if the viewer chose so.
  if (video.needsCookies && settings.cookieMode === "open") {
    window.open(video.url, "_blank", "noopener,noreferrer");
    return;
  }
  openPlayer(video);
}

function openPlayer(video) {
  $("#player-title").textContent = video.title;
  $("#player-badge").replaceChildren(badge(video, gol));
  $("#player-meta").textContent = [video.channel, video.published, video.views != null ? formatCount(video.views) + " views" : null, video.note]
    .filter(Boolean).join(" · ");
  const ads = $("#player-ads");
  ads.hidden = !video.ads;
  const siteLabel = gol.sites.get(video.site)?.name || video.domain;
  ads.textContent = video.ads ? `Playing in ${siteLabel}'s own player. ${siteLabel} may show ads.` : "";
  const link = $("#player-link");
  link.href = video.url;
  link.textContent = `Watch on ${video.domain} ↗`;
  const hint = $("#player-hint");
  hint.hidden = !(video.needsCookies && settings.cookieMode !== "open");
  hint.textContent = hint.hidden ? "" : `🍪 ${video.domain} needs its cookies: accept them or sign in inside the player.`;
  stopPlayer = player(video, els.frame, { gol, cookieMode: settings.cookieMode || "inside" });
  currentVideo = video;
  $("#player-share").hidden = !(me.feed && me.user && playsInMeoDeo(video));
  const notPlaying = $("#player-notplaying");
  notPlaying.hidden = video.play.kind === "link" && !(video.needsCookies && settings.cookieMode !== "open");
  notPlaying.disabled = false;
  notPlaying.textContent = "Not playing?";
  els.player.showModal();
}
let currentVideo = null;

let stopPlayer = null;
els.player.addEventListener("close", () => { stopPlayer?.(); stopPlayer = null; els.frame.replaceChildren(); });
$("#player-close").addEventListener("click", () => els.player.close());
els.player.addEventListener("click", (e) => { if (e.target === els.player) els.player.close(); });

/* ---------- settings ---------- */

function fillSettings() {
  const f = els.settingsForm;
  f.serverUrl.value = settings.serverUrl || "";
  for (const r of f.querySelectorAll('input[name="cookieMode"]')) r.checked = r.value === (settings.cookieMode || "inside");
  f.playableOnly.checked = settings.playableOnly === "on";
  showServerState();
  const box = $("#site-keys");
  box.querySelectorAll("label").forEach((n) => n.remove());
  for (const site of gol.sites.values()) {
    for (const k of site.keys || []) {
      const label = document.createElement("label");
      label.textContent = k.label;
      label.append(Object.assign(document.createElement("input"), { type: "password", name: k.name, autocomplete: "off",
        value: settings[k.name] || "", placeholder: k.optional ? "optional" : "needed to search " + site.name }));
      if (k.help) label.append(Object.assign(document.createElement("a"), { href: k.help, target: "_blank", rel: "noopener", textContent: " get one" }));
      box.append(label);
    }
  }
}

$("#open-settings").addEventListener("click", () => { fillSettings(); els.settings.showModal(); });
$("#check-server").addEventListener("click", () => {
  const typed = els.settingsForm.serverUrl.value.trim();
  if (typed !== (settings.serverUrl || "")) {
    settings = { ...settings, serverUrl: typed || undefined };
    store.set(STORE, settings);
    gol.keys = settings;
  }
  checkServer({ fresh: true });
});
$("#clear-keys").addEventListener("click", () => {
  settings = { ...DEFAULTS, serverUrl: settings.serverUrl, cookieMode: settings.cookieMode };
  store.set(STORE, settings);
  gol.keys = settings;
  fillSettings();
  renderFilters();
});
els.settings.addEventListener("close", () => {
  if (els.settings.returnValue !== "save") return;
  const data = Object.fromEntries(new FormData(els.settingsForm));
  const next = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v).trim()]).filter(([, v]) => v));
  next.cookieMode = data.cookieMode === "open" ? "open" : "inside";
  next.playableOnly = data.playableOnly ? "on" : "off";
  const serverChanged = (next.serverUrl || "") !== (settings.serverUrl || "");
  settings = next;
  store.set(STORE, settings);
  gol.keys = settings;
  renderFilters();
  if (serverChanged) checkServer();
  if (els.q.value.trim()) search(els.q.value.trim()); // apply the new result settings
});

/* ---------- account and public feed ---------- */

let me = { feed: false, user: null };
let meReady = false;
const playsInMeoDeo = (v) => v.play.kind !== "link" || !!v.play.inside;

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method, credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* not JSON (e.g. no feed on this host) */ }
  if (res.status === 401 && data.code === "verify-required" && !path.startsWith("/api/verify")) {
    humanReady = new Promise((r) => (humanResolve = r));
    showGate();
    await humanReady;
    return api(path, { method, body });
  }
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, code: data.code });
  return data;
}

async function loadMe() {
  try { me = await api("/api/me"); } catch { me = { feed: false, user: null }; }
  meReady = true;
  showAccount();
}

function showAccount() {
  const btn = $("#account-btn");
  btn.hidden = !me.feed;
  btn.textContent = me.user ? "@" + me.user.username : "Sign in";
  $("#post-form").hidden = !(me.feed && me.user);
  $("#post-signin").hidden = !me.feed || !!me.user;
}

/* views: #search (default) and #feed */
function route() {
  const feed = location.hash === "#feed";
  $("#view-search").hidden = feed;
  $("#view-feed").hidden = !feed;
  $("#tab-search").setAttribute("aria-current", feed ? "false" : "page");
  $("#tab-feed").setAttribute("aria-current", feed ? "page" : "false");
  $("#tab-search").classList.toggle("active", !feed);
  $("#tab-feed").classList.toggle("active", feed);
  if (feed && !feedLoaded && meReady) loadFeed(true);
}
window.addEventListener("hashchange", route);

let feedLoaded = false;
let feedNext = null;

const timeAgo = (ms) => {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  for (const [n, unit] of [[86400 * 365, "y"], [86400 * 30, "mo"], [86400, "d"], [3600, "h"], [60, "min"]]) if (s >= n) return `${Math.floor(s / n)} ${unit} ago`;
  return "just now";
};

/* report dialog */
let reporting = null;
function openReport(post, node) {
  reporting = { post, node };
  $("#report-form").reset();
  $("#report-error").hidden = true;
  $("#report-what").textContent = post.video?.title || "this post";
  $("#report").showModal();
}
$("#report-form").addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "send" || !reporting) return;
  e.preventDefault();
  const reason = new FormData(e.target).get("reason");
  const err = $("#report-error");
  if (!reason) { err.textContent = "Pick a reason."; err.hidden = false; return; }
  e.submitter.disabled = true;
  try {
    const out = await api("/api/report", { method: "POST", body: { postId: reporting.post.id, reason, details: $("#report-details").value } });
    if (out.hidden) reporting.node.remove();
    $("#report").close();
    $("#feed-status").textContent = reason === "copyright"
      ? "Thanks, we got your report. If you own the rights, also send a takedown request (Copyright page) so the video comes down right away."
      : "Thanks, we got your report. Posts that several people report are hidden.";
  } catch (ex) {
    err.textContent = ex.message; err.hidden = false;
  } finally {
    e.submitter.disabled = false;
  }
});

function postCard(post) {
  const raw = post.video || {};
  const v = gol.normalize(gol.sites.get(raw.site) || gol.sites.get("web"), raw);
  if (!v) return null;
  const node = card(v, { gol, onOpen: open });
  const meta = document.createElement("div");
  meta.className = "post-meta";
  const who = Object.assign(document.createElement("strong"), { textContent: "@" + post.username });
  const when = Object.assign(document.createElement("span"), { textContent: timeAgo(post.createdAt) });
  meta.append(who, when);
  if (post.mine) {
    const del = Object.assign(document.createElement("button"), { type: "button", className: "post-delete", textContent: "Delete" });
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      del.disabled = true;
      try { await api(`/api/posts/${post.id}`, { method: "DELETE" }); node.remove(); }
      catch (err) { del.disabled = false; $("#feed-status").textContent = "Couldn't delete: " + err.message; }
    });
    meta.append(del);
  } else {
    const rep = Object.assign(document.createElement("button"), { type: "button", className: "post-report", textContent: "Report" });
    rep.addEventListener("click", (e) => { e.stopPropagation(); openReport(post, node); });
    meta.append(rep);
  }
  if (post.caption) meta.append(Object.assign(document.createElement("p"), { className: "post-caption", textContent: post.caption }));
  meta.addEventListener("click", (e) => e.stopPropagation());
  node.append(meta);
  return node;
}

async function loadFeed(reset = false) {
  const status = $("#feed-status");
  if (!me.feed) {
    status.textContent = "The feed isn't available on this copy of MeoDeo.";
    return;
  }
  if (reset) { feedNext = null; $("#feed-list").replaceChildren(); }
  status.textContent = "Loading…";
  try {
    const data = await api("/api/feed" + (feedNext ? `?before=${feedNext}` : ""));
    feedLoaded = true;
    $("#feed-list").append(...data.posts.map(postCard).filter(Boolean));
    feedNext = data.next;
    $("#feed-more").hidden = !feedNext;
    status.textContent = $("#feed-list").children.length ? "" : "No posts yet. Be the first to share a video!";
  } catch (err) {
    status.textContent = "Couldn't load the feed: " + err.message;
  }
}
$("#feed-more").addEventListener("click", () => loadFeed(false));

$("#post-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const status = $("#post-status");
  const btn = f.querySelector("button[type=submit]");
  btn.disabled = true;
  status.textContent = "Checking the video…";
  try {
    const { post } = await api("/api/posts", { method: "POST", body: { url: f.url.value.trim(), caption: f.caption.value.trim() } });
    const node = postCard(post);
    if (node) $("#feed-list").prepend(node);
    $("#feed-status").textContent = "";
    f.reset();
    status.textContent = "Posted ✓";
  } catch (err) {
    status.textContent = err.status === 401 ? "Please sign in again." : err.message;
    if (err.status === 401) { me.user = null; showAccount(); }
  } finally {
    btn.disabled = false;
  }
});

/* account dialog */
let authMode = "login";
function setAuthMode(mode) {
  authMode = mode;
  $("#auth-mode-login").classList.toggle("active", mode === "login");
  $("#auth-mode-signup").classList.toggle("active", mode === "signup");
  $("#auth-title").textContent = mode === "login" ? "Sign in" : "Create a MeoDeo account";
  $("#auth-submit").textContent = mode === "login" ? "Sign in" : "Create account";
  $("#auth-password").autocomplete = mode === "login" ? "current-password" : "new-password";
  $("#auth-agree-row").hidden = mode === "login";
  $("#auth-agree").required = mode === "signup";
}
function openAuth(mode) {
  const signedIn = !!me.user;
  $("#auth-fields").hidden = signedIn;
  $("#auth-signed-in").hidden = !signedIn;
  $("#auth-logout").hidden = !signedIn;
  $("#auth-submit").hidden = signedIn;
  $("#auth-error").hidden = true;
  for (const id of ["#auth-username", "#auth-password"]) $(id).disabled = signedIn;
  if (signedIn) { $("#auth-title").textContent = "Your account"; $("#auth-who").textContent = "@" + me.user.username; }
  else setAuthMode(mode || authMode);
  $("#auth").showModal();
}
$("#account-btn").addEventListener("click", () => openAuth());
$("#post-signin-btn").addEventListener("click", () => openAuth("signup"));
$("#auth-mode-login").addEventListener("click", () => setAuthMode("login"));
$("#auth-mode-signup").addEventListener("click", () => setAuthMode("signup"));
$("#auth-form").addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "submit" || me.user) return; // the close button
  e.preventDefault();
  const err = $("#auth-error");
  err.hidden = true;
  $("#auth-submit").disabled = true;
  try {
    const data = await api(authMode === "login" ? "/api/auth/login" : "/api/auth/signup", {
      method: "POST", body: { username: $("#auth-username").value.trim(), password: $("#auth-password").value,
        ...(authMode === "signup" ? { agree: $("#auth-agree").checked } : {}) },
    });
    me.user = data.user;
    $("#auth-password").value = "";
    showAccount();
    $("#auth").close();
    if (feedLoaded) loadFeed(true); // show your posts' delete buttons
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    $("#auth-submit").disabled = false;
  }
});
$("#auth-logout").addEventListener("click", async () => {
  try { await api("/api/auth/logout", { method: "POST" }); } catch { /* signed out locally anyway */ }
  me.user = null;
  showAccount();
  $("#auth").close();
  if (feedLoaded) loadFeed(true);
});

/* "Not playing?": show the watch-on-site panel, and report the site so searches can flag it */
$("#player-notplaying").addEventListener("click", async (e) => {
  if (!currentVideo) return;
  stopPlayer?.();
  stopPlayer = null;
  showFallback(currentVideo, els.frame);
  e.currentTarget.disabled = true;
  e.currentTarget.textContent = "Thanks, noted";
  // Only pages Gol has no definition for are judged by reports (known sites have official players).
  if (currentVideo.site === "web") {
    try { await api("/api/site-report", { method: "POST", body: { url: currentVideo.url } }); } catch { /* best effort */ }
  }
});

/* "Post to feed" from the player */
$("#player-share").addEventListener("click", () => {
  if (!currentVideo) return;
  const url = currentVideo.url;
  els.player.close();
  location.hash = "#feed";
  $("#post-url").value = url;
  $("#post-caption").focus();
});

/* ---------- human verification (hCaptcha or Cloudflare Turnstile; in-app browsers skip) ---------- */

let humanResolve;
let humanReady = new Promise((r) => (humanResolve = r));
let verifyKeys = {};
const vErr = (msg) => { const e = $("#verify-error"); e.textContent = msg || ""; e.hidden = !msg; };

const WIDGETS = {
  hcaptcha: { script: "https://js.hcaptcha.com/1/api.js?render=explicit&onload=meodeoWidgetReady", global: "hcaptcha" },
  turnstile: { script: "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=meodeoWidgetReady", global: "turnstile" },
};

async function checkHuman() {
  let st;
  try {
    const res = await fetch("/api/verify", { credentials: "same-origin" });
    st = res.ok ? await res.json() : { required: false };
  } catch { st = { required: false }; } // static copy (e.g. GitHub Pages): nothing to verify
  if (!st.required || st.verified) {
    if (st.inApp) fetch("/api/verify", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: '{"method":"inapp"}' }).catch(() => {});
    return humanResolve();
  }
  verifyKeys = { hcaptcha: st.hcaptchaSiteKey, turnstile: st.turnstileSiteKey };
  $("#verify-pick-hcaptcha").hidden = !verifyKeys.hcaptcha;
  $("#verify-pick-turnstile").hidden = !verifyKeys.turnstile;
  showGate();
}

function showGate() {
  vErr("");
  $("#verify-widget").hidden = true;
  if (!$("#verify").open) $("#verify").showModal();
}
// The check can't be dismissed with Esc.
$("#verify").addEventListener("cancel", (e) => e.preventDefault());

async function passed(method, token) {
  vErr("");
  try {
    await api("/api/verify", { method: "POST", body: { method, token } });
    $("#verify").close();
    humanResolve();
  } catch (err) {
    vErr(err.message);
    openWidget(method); // a fresh check
  }
}

const loading = {};
function loadWidget(id) {
  const w = WIDGETS[id];
  if (window[w.global]?.render) return Promise.resolve(window[w.global]);
  loading[id] ||= new Promise((resolve, reject) => {
    window.meodeoWidgetReady = () => resolve(window[w.global]);
    const s = document.createElement("script");
    s.src = w.script;
    s.async = true;
    s.onerror = () => { loading[id] = null; reject(new Error("blocked")); };
    document.head.append(s);
  });
  return loading[id];
}

async function openWidget(id) {
  const box = $("#verify-widget");
  box.hidden = false;
  box.replaceChildren(Object.assign(document.createElement("p"), { className: "hint", textContent: "Loading…" }));
  try {
    const lib = await loadWidget(id);
    const slot = document.createElement("div");
    box.replaceChildren(slot);
    lib.render(slot, {
      sitekey: verifyKeys[id],
      theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
      callback: (token) => passed(id, token),
      "error-callback": () => vErr("The check had a problem. Please try again, or pick the other option."),
    });
  } catch {
    box.replaceChildren();
    vErr(`${id === "hcaptcha" ? "hCaptcha" : "Cloudflare Turnstile"} couldn't load (a blocker may be stopping it). Try the other option.`);
  }
}
$("#verify-pick-hcaptcha").addEventListener("click", () => openWidget("hcaptcha"));
$("#verify-pick-turnstile").addEventListener("click", () => openWidget("turnstile"));

/* ---------- boot ---------- */

gol.unavailable.set("searxng", "checking…"); // until the first check answers
// Pexels is searched by MeoDeo's server with its own private key, when one is set up.
gol.unavailable.set("pexels", "checking…");
fetch(serverBase() + "/api/pexels?check=1", { signal: AbortSignal.timeout(8000) })
  .then((r) => (r.ok ? r.json() : null)).catch(() => null)
  .then((d) => {
    if (d?.ready) gol.unavailable.delete("pexels");
    else gol.unavailable.set("pexels", "Pexels isn't set up on this MeoDeo yet");
    renderFilters();
  });
els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = els.q.value.trim();
  if (q) { if (location.hash === "#feed") location.hash = "#search"; search(q); }
});
renderFilters();
const directCount = [...gol.sites.values()].filter((s) => s.search && !s.needsServer).length;
els.status.textContent = `Search ${directCount} video websites at once, plus the whole web through SearXNG.`;
checkHuman();
route();
loadMe().then(() => { if (location.hash === "#feed") loadFeed(true); });
const initial = new URLSearchParams(location.search).get("q");
checkServer().then(() => {
  if (initial) { els.q.value = initial; search(initial); }
});

// Languages (Google's free website translator, loaded only when a language is picked).
initLanguages(document.getElementById("lang"), {
  onError: () => { const st = document.getElementById("status"); if (st) st.textContent = "Couldn't load the translator right now. Check your connection, or try again later."; },
});
