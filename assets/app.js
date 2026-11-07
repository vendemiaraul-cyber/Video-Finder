import { Gol, interleave } from "../gol/gol.js";
import sites from "../gol/sites/index.js";
import { card, player, badge, formatCount } from "../gol/render.js";

const $ = (s) => document.querySelector(s);
const STORE = "meodeo.settings.v2";
const PREFS = "meodeo.sites.v1";
const DEFAULTS = { autoOpenCookies: "on" };

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
const gol = new Gol({ keys: settings }).register(sites);

const els = {
  form: $("#search-form"), q: $("#q"), filters: $("#site-filters"),
  status: $("#status"), siteStatus: $("#site-status"), results: $("#results"),
  player: $("#player"), frame: $("#player-frame"), settings: $("#settings"), settingsForm: $("#settings-form"),
};

/* ---------- MeoDeo server (SearXNG) ---------- */

const serverBase = () => (settings.serverUrl || "").replace(/\/+$/, "");

async function checkServer() {
  gol.unavailable.set("searxng", "checking…");
  try {
    const res = await fetch(serverBase() + "/api/health", { signal: AbortSignal.timeout(4000) });
    const data = res.ok ? await res.json() : null;
    if (data?.app !== "meodeo") throw new Error("no MeoDeo server");
    if (!data.searxng) gol.unavailable.set("searxng", `server can't reach SearXNG at ${data.searxngUrl}`);
    else gol.unavailable.delete("searxng");
  } catch {
    gol.unavailable.set("searxng", "needs the MeoDeo server (Settings)");
  }
  renderFilters();
}

/* ---------- site filter chips ---------- */

function renderFilters() {
  const off = new Set(store.get(PREFS, []));
  els.filters.replaceChildren(...[...gol.sites.values()].filter((s) => s.search).map((site) => {
    const missingKey = !gol.hasKeys(site);
    const why = gol.unavailable.get(site.id) || (missingKey ? `Add a ${site.name} API key in Settings to search it` : "");
    const label = document.createElement("label");
    label.className = "chip" + (why ? " chip-off" : "");
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
    else if (why) label.append(Object.assign(document.createElement("small"), { className: "key", textContent: "server" }));
    return label;
  }));
}

const chosenSites = () => [...els.filters.querySelectorAll("input:checked")].map((i) => i.value);

/* ---------- search ---------- */

let run = 0;

async function search(query) {
  const id = ++run;
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
  els.status.textContent = `Searching ${ids.length} sources for “${query}”…`;

  const perSite = {};
  const draw = () => {
    if (id !== run) return;
    const videos = interleave(ids.map((s) => perSite[s] || []));
    els.results.replaceChildren(...videos.map((v) => card(v, { gol, onOpen: open })));
  };
  const { videos, status } = await gol.search(query, {
    sites: ids, limit: ids.length === 1 ? 40 : 8,
    onPartial: (siteId, list) => { if (list) { perSite[siteId] = list; draw(); } },
  });
  if (id !== run) return;
  draw();
  const websites = new Set(videos.map((v) => v.domain)).size;
  els.status.textContent = videos.length
    ? `${videos.length} videos from ${websites} websites for “${query}”`
    : `No videos found for “${query}”.`;
  els.siteStatus.replaceChildren(...ids.filter((s) => status[s]).map((s) => {
    const st = status[s], site = gol.sites.get(s);
    const li = document.createElement("li");
    li.textContent = st.ok ? `${site.name}: ${st.count}` : `${site.name}: unavailable (${siteError(st.error)})`;
    if (!st.ok) li.className = "err";
    return li;
  }));
}

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
  // Sites that need their own cookies can't work inside MeoDeo: open them there.
  if (video.needsCookies && settings.autoOpenCookies === "on") {
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
  ads.textContent = video.ads ? `Playing in ${video.siteName}'s own player. ${video.siteName} may show ads.` : "";
  const link = $("#player-link");
  link.href = video.url;
  link.textContent = `Watch on ${video.domain} ↗`;
  player(video, els.frame, { gol });
  els.player.showModal();
}

els.player.addEventListener("close", () => els.frame.replaceChildren());
$("#player-close").addEventListener("click", () => els.player.close());
els.player.addEventListener("click", (e) => { if (e.target === els.player) els.player.close(); });

/* ---------- settings ---------- */

function fillSettings() {
  const f = els.settingsForm;
  f.serverUrl.value = settings.serverUrl || "";
  f.autoOpenCookies.checked = settings.autoOpenCookies === "on";
  const why = gol.unavailable.get("searxng");
  $("#server-state").textContent = why
    ? `SearXNG: ${why}. Run the MeoDeo server (npm start) and leave this empty when you open MeoDeo from it.`
    : "SearXNG: connected ✓";
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
$("#clear-keys").addEventListener("click", () => {
  settings = { ...DEFAULTS, serverUrl: settings.serverUrl, autoOpenCookies: settings.autoOpenCookies };
  store.set(STORE, settings);
  gol.keys = settings;
  fillSettings();
  renderFilters();
});
els.settings.addEventListener("close", () => {
  if (els.settings.returnValue !== "save") return;
  const data = Object.fromEntries(new FormData(els.settingsForm));
  const next = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v).trim()]).filter(([, v]) => v));
  next.autoOpenCookies = data.autoOpenCookies ? "on" : "off";
  const serverChanged = (next.serverUrl || "") !== (settings.serverUrl || "");
  settings = next;
  store.set(STORE, settings);
  gol.keys = settings;
  renderFilters();
  if (serverChanged) checkServer();
});

/* ---------- boot ---------- */

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = els.q.value.trim();
  if (q) search(q);
});
renderFilters();
const directCount = [...gol.sites.values()].filter((s) => s.search && !s.needsServer).length;
els.status.textContent = `Search ${directCount} video websites at once, plus the whole web through SearXNG.`;
const initial = new URLSearchParams(location.search).get("q");
checkServer().then(() => {
  if (initial) { els.q.value = initial; search(initial); }
});
