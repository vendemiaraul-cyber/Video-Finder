// Loaded first by every Legacy Version (versions/<slug>/index.html).
// 1. Applies today's moderation to the old code: content filter, takedowns and
//    the owner's ban list (old Gol's normalize() asks globalThis.__meodeoBlocked).
// 2. Shows a bar saying which version this is, with links back.
import { isSafe, canonicalUrl } from "../gol/safety.js";

let removed = new Set();
let banned = [];
globalThis.__meodeoBlocked = (video) => !isSafe(video, { bannedSites: banned }) || removed.has(canonicalUrl(video.url));
fetch("/api/blocklist", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).then((d) => {
  if (Array.isArray(d?.links)) removed = new Set(d.links);
  if (Array.isArray(d?.sites)) banned = d.sites;
}).catch(() => {});

const me = document.querySelector('script[src$="legacy-guard.js"]');
const version = me?.dataset.version || "?";
const date = me?.dataset.date ? new Date(me.dataset.date + "T12:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
function bar() {
  const b = document.createElement("div");
  b.className = "notranslate";
  b.setAttribute("translate", "no");
  b.setAttribute("role", "note");
  b.style.cssText = "position:relative;z-index:10;display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;justify-content:center;" +
    "padding:8px 16px;background:#1f1b4d;color:#fff;font:600 14px/1.4 system-ui,sans-serif;text-align:center";
  const link = (href, text) => Object.assign(document.createElement("a"), { href, textContent: text, style: "color:#ffcf4a" });
  b.append(Object.assign(document.createElement("span"), { textContent: `🕰️ Legacy version ${version}${date ? " · " + date : ""} · for testing` }),
    link("../../versions.html#v" + version.replace(/\./g, "-"), "About this version"), link("../../", "Current MeoDeo →"));
  document.body.prepend(b);
}
if (document.body) bar(); else document.addEventListener("DOMContentLoaded", bar);
