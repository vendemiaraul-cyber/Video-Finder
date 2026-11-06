import { Gol, interleave } from "../gol/gol.js";
import sites from "../gol/sites/index.js";
import { card, player, badge, enrich, formatCount } from "../gol/render.js";
import { findWithClaude, MODELS, DEFAULT_MODEL } from "../claude/finder.js";

const $ = (s) => document.querySelector(s);
const STORE = "meodeo.settings.v1";
const PREFS = "meodeo.sites.v1";

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

let settings = store.get(STORE, {});
const gol = new Gol({ keys: settings }).register(sites);

const els = {
  form: $("#search-form"), q: $("#q"), useClaude: $("#use-claude"), filters: $("#site-filters"),
  status: $("#status"), siteStatus: $("#site-status"), results: $("#results"),
  claudeSection: $("#claude-section"), claudeStatus: $("#claude-status"), claudeResults: $("#claude-results"),
  player: $("#player"), frame: $("#player-frame"), settings: $("#settings"), settingsForm: $("#settings-form"),
};

/* ---------- site filter chips ---------- */

function renderFilters() {
  const off = new Set(store.get(PREFS, []));
  els.filters.replaceChildren(...[...gol.sites.values()].filter((s) => s.search).map((site) => {
    const ready = gol.hasKeys(site);
    const label = document.createElement("label");
    label.className = "chip" + (ready ? "" : " chip-off");
    label.title = ready ? `Search ${site.domain}` : `Add a ${site.name} API key in Settings to search it`;
    const cb = Object.assign(document.createElement("input"), { type: "checkbox", value: site.id,
      checked: ready && !off.has(site.id), disabled: !ready });
    cb.addEventListener("change", () => {
      const now = new Set(store.get(PREFS, []));
      cb.checked ? now.delete(site.id) : now.add(site.id);
      store.set(PREFS, [...now]);
      if (els.q.value.trim()) search(els.q.value.trim());
    });
    const dot = Object.assign(document.createElement("i"), { className: "dot" });
    dot.style.background = site.color;
    const name = Object.assign(document.createElement("span"), { textContent: site.name });
    label.append(cb, dot, name);
    if (site.ads) label.append(Object.assign(document.createElement("small"), { textContent: "ads", title: "Plays with the site's own ads" }));
    if (!ready) label.append(Object.assign(document.createElement("small"), { className: "key", textContent: "key" }));
    return label;
  }));
}

const chosenSites = () => [...els.filters.querySelectorAll("input:checked")].map((i) => i.value);

/* ---------- search ---------- */

let run = 0;
let claudeAbort = null;

async function search(query) {
  const id = ++run;
  claudeAbort?.abort();
  history.replaceState(null, "", "?q=" + encodeURIComponent(query));
  document.title = `${query} · MeoDeo`;
  const ids = chosenSites();
  const wantClaude = els.useClaude.checked;
  els.results.replaceChildren(...skeletons(8));
  els.siteStatus.replaceChildren();
  els.status.textContent = ids.length ? `Searching ${ids.length} websites for “${query}”…` : "";
  if (!ids.length && !wantClaude) { els.results.replaceChildren(); els.status.textContent = "Pick at least one website, or turn on Claude."; }

  if (wantClaude) searchClaude(query, id); else els.claudeSection.hidden = true;
  if (!ids.length) return;

  const perSite = {};
  const draw = () => {
    if (id !== run) return;
    const videos = interleave(ids.map((s) => perSite[s] || []));
    els.results.replaceChildren(...videos.map((v) => card(v, { gol, onOpen: openPlayer })));
  };
  const { videos, status } = await gol.search(query, {
    sites: ids, limit: 8,
    onPartial: (siteId, list) => { if (list) { perSite[siteId] = list; draw(); } },
  });
  if (id !== run) return;
  draw();
  const okSites = Object.values(status).filter((s) => s.ok && s.count).length;
  els.status.textContent = videos.length
    ? `${videos.length} videos from ${okSites} websites for “${query}”`
    : `No videos found for “${query}” on the selected websites.`;
  els.siteStatus.replaceChildren(...ids.map((s) => {
    const st = status[s], site = gol.sites.get(s);
    const li = document.createElement("li");
    li.textContent = st.ok ? `${site.name}: ${st.count}` : `${site.name}: unavailable (${siteError(st.error)})`;
    if (!st.ok) li.className = "err";
    return li;
  }));
}

async function searchClaude(query, id) {
  els.claudeSection.hidden = false;
  els.claudeResults.replaceChildren(...skeletons(4));
  if (!settings.anthropicKey) {
    els.claudeResults.replaceChildren();
    els.claudeStatus.textContent = "Add your Anthropic API key in Settings (⚙) to let Claude search the whole web.";
    return;
  }
  claudeAbort = new AbortController();
  try {
    const videos = await findWithClaude(query, {
      apiKey: settings.anthropicKey, model: settings.claudeModel || DEFAULT_MODEL, gol, count: 10,
      signal: claudeAbort.signal,
      onStatus: (m) => { if (id === run) els.claudeStatus.textContent = m; },
    });
    if (id !== run) return;
    const enriched = await Promise.all(videos.map((v) => enrich(v)));
    if (id !== run) return;
    const sitesUsed = new Set(enriched.map((v) => v.domain)).size;
    els.claudeStatus.textContent = enriched.length
      ? `${enriched.length} videos from ${sitesUsed} websites`
      : "Claude didn't find matching videos.";
    els.claudeResults.replaceChildren(...enriched.map((v) => card(v, { gol, onOpen: openPlayer })));
  } catch (err) {
    if (id !== run || err.name === "AbortError") return;
    els.claudeResults.replaceChildren();
    els.claudeStatus.textContent = "Claude search failed: " + friendlyError(err);
  }
}

function siteError(msg) {
  if (/429/.test(msg)) return "busy, try again in a minute";
  if (/HTTP 40[13]/.test(msg)) return "key rejected, check Settings";
  return msg;
}

function friendlyError(err) {
  const s = err?.status;
  if (s === 401) return "the Anthropic API key was rejected. Check it in Settings.";
  if (s === 429) return "rate limited. Wait a moment and try again.";
  if (s === 529 || s >= 500) return "Claude is busy right now. Try again shortly.";
  return err?.message || String(err);
}

function skeletons(n) {
  return Array.from({ length: n }, () => Object.assign(document.createElement("div"), { className: "gol-card skeleton" }));
}

/* ---------- player ---------- */

function openPlayer(video) {
  $("#player-title").textContent = video.title;
  $("#player-badge").replaceChildren(badge(video, gol));
  $("#player-meta").textContent = [video.channel, video.published, video.views != null ? formatCount(video.views) + " views" : null]
    .filter(Boolean).join(" · ");
  const ads = $("#player-ads");
  ads.hidden = !video.ads;
  ads.textContent = video.ads ? `Playing in ${video.siteName}'s own player. ${video.siteName} may show ads.` : "";
  const link = $("#player-link");
  link.href = video.url;
  link.textContent = `Watch on ${video.domain} ↗`;
  player(video, els.frame);
  els.player.showModal();
}

els.player.addEventListener("close", () => els.frame.replaceChildren());
$("#player-close").addEventListener("click", () => els.player.close());
els.player.addEventListener("click", (e) => { if (e.target === els.player) els.player.close(); });

/* ---------- settings ---------- */

function fillSettings() {
  const f = els.settingsForm;
  f.anthropicKey.value = settings.anthropicKey || "";
  f.claudeModel.replaceChildren(...MODELS.map((m) => new Option(m.label, m.id, false, m.id === (settings.claudeModel || DEFAULT_MODEL))));
  const box = $("#site-keys");
  box.querySelectorAll("label, p").forEach((n) => n.remove());
  for (const site of gol.sites.values()) {
    for (const k of site.keys || []) {
      const label = document.createElement("label");
      label.textContent = k.label;
      const input = Object.assign(document.createElement("input"), { type: "password", name: k.name, autocomplete: "off",
        value: settings[k.name] || "", placeholder: k.optional ? "optional" : "needed to search " + site.name });
      label.append(input);
      if (k.help) {
        const a = Object.assign(document.createElement("a"), { href: k.help, target: "_blank", rel: "noopener", textContent: " get one" });
        label.append(a);
      }
      box.append(label);
    }
  }
}

$("#open-settings").addEventListener("click", () => { fillSettings(); els.settings.showModal(); });
$("#clear-keys").addEventListener("click", () => {
  settings = {};
  store.set(STORE, settings);
  fillSettings();
});
els.settings.addEventListener("close", () => {
  if (els.settings.returnValue !== "save") return;
  const data = Object.fromEntries(new FormData(els.settingsForm));
  settings = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v).trim()]).filter(([, v]) => v));
  store.set(STORE, settings);
  gol.keys = settings;
  els.useClaude.checked = !!settings.anthropicKey;
  renderFilters();
});

/* ---------- boot ---------- */

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = els.q.value.trim();
  if (q) search(q);
});
els.useClaude.checked = !!settings.anthropicKey;
renderFilters();
const searchableCount = [...gol.sites.values()].filter((s) => s.search).length;
const playableCount = gol.sites.size;
els.status.textContent = `Search ${searchableCount} video websites at once, and play videos from ${playableCount}+ sites. Turn on Claude to search the whole web.`;
const initial = new URLSearchParams(location.search).get("q");
if (initial) { els.q.value = initial; search(initial); }
