#!/usr/bin/env node
// Builds MeoDeo's Legacy Versions: the website exactly as it was at each
// milestone commit, copied from git into versions/<slug>/, plus
// versions/versions.json for the Versions page (versions.html).
//
//   node scripts/build-versions.mjs      (needs the full git history)
//
// Each copy keeps its own pages, styles and scripts. It talks to today's
// MeoDeo servers (/api/...), so search and the feed still answer. Three
// things are added to every copy, for safety:
//   1. today's content filter, takedowns and ban list (versions/legacy-guard.js),
//      so old versions can't be used to get around moderation;
//   2. a "Legacy version" bar and noindex, so search engines don't list them;
//   3. the first version's Claude finder is switched off (it needed a paid
//      Anthropic API key).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OUT = path.join(ROOT, "versions");
const REPO = "https://github.com/vendemiaraul-cyber/Video-Finder";
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "buffer", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] });
const gitText = (...args) => git(...args).toString("utf8");

const DAILYMOTION_NOTE = "Dailymotion videos don't play here: on 28 September 2026 Dailymotion started requiring a Player ID (fixed in v0.14).";
const OLD_SOURCES_NOTE = "Some sources may not answer anymore (public servers it used have changed).";

// Milestones: the versions people actually used, oldest first.
const VERSIONS = [
  { v: "0.1", commit: "70c4c2a", title: "First MeoDeo: Gol and Claude",
    notes: ["The Claude finder is switched off in this copy: it needed a paid Anthropic API key.", OLD_SOURCES_NOTE, DAILYMOTION_NOTE] },
  { v: "0.2", commit: "da44ae4", title: "SearXNG replaces Claude", notes: [OLD_SOURCES_NOTE, DAILYMOTION_NOTE] },
  { v: "0.3", commit: "5fd630f", title: "Better YouTube player, Odysee fix, YouTube's own search", notes: [DAILYMOTION_NOTE] },
  { v: "0.4", commit: "597da80", title: "SearXNG on Cloudflare, hosted on Render", notes: [DAILYMOTION_NOTE] },
  { v: "0.5", commit: "2e331d4", title: "TikTok player and the \"SearXNG Results\" label", notes: [DAILYMOTION_NOTE] },
  { v: "0.6", commit: "7240a0d", title: "SearXNG finds other websites; more videos play inside MeoDeo", notes: [DAILYMOTION_NOTE] },
  { v: "0.7", commit: "b77a038", title: "Remembers which sites allow embedding; \"site only\" flag", notes: [DAILYMOTION_NOTE] },
  { v: "0.8", commit: "186dabc", title: "Public feed with MeoDeo accounts",
    notes: ["Creating an account here fails: sign-up now needs the 13+ and Terms agreement added in v0.14. Signing in works.", DAILYMOTION_NOTE] },
  { v: "0.9", commit: "b21fa00", title: "Many more SearXNG results", notes: ["Sign-up: see v0.8.", DAILYMOTION_NOTE] },
  { v: "0.10", commit: "db9842d", title: "Auto-Filter, black-screen watchdog, \"Not playing?\"", notes: ["Sign-up: see v0.8.", DAILYMOTION_NOTE] },
  { v: "0.11", commit: "4af8ec9", title: "Auto-Filter removed", notes: ["Sign-up: see v0.8.", DAILYMOTION_NOTE] },
  { v: "0.12", commit: "19e58b5", title: "Human verification (hCaptcha or Cloudflare Turnstile)",
    notes: ["Verification stays switched off on the live site (no keys were added), so it doesn't appear.", "Sign-up: see v0.8.", DAILYMOTION_NOTE] },
  { v: "0.13", commit: "23a1440", title: "Videos that match the search come first", notes: ["Sign-up: see v0.8.", DAILYMOTION_NOTE] },
  { v: "0.14", commit: "809dd4a", title: "Languages, rules and takedowns; Dailymotion fix", notes: [] },
  { v: "0.15", commit: "d6075ef", title: "Pexels through the server with a private key", notes: [] },
];
// The live site: listed on the Versions page, not copied.
const CURRENT = { v: "0.16", title: "Admin page and automatic bans for adult-labelled sites" };

const FRONTEND = ["index.html", "legal.html", "assets", "gol", "claude"];
const TRAILER = /^(Co-Authored-By|Claude-Session):/i;

function commitInfo(ref) {
  const [hash, date, subject, ...body] = gitText("show", "-s", "--format=%H%n%aI%n%s%n%b", ref).split("\n");
  return { hash, short: hash.slice(0, 7), date, subject, body: body.filter((l) => !TRAILER.test(l.trim())).join("\n").trim() };
}
const changesBetween = (from, to) => gitText("log", "--reverse", "--format=%h\t%s", from ? `${from}..${to}` : to).trim().split("\n")
  .map((l) => l.split("\t")).filter(([, s]) => s && !/^Temporary:|^Remove the temporary|^Initial commit$/.test(s))
  .map(([h, s]) => ({ commit: h, subject: s }));
const slugOf = (v) => "v" + v.replace(/\./g, "-");

function extract(commit, dest) {
  const present = FRONTEND.filter((p) => { try { git("cat-file", "-e", `${commit}:${p}`); return true; } catch { return false; } });
  const files = gitText("ls-tree", "-r", "--name-only", commit, "--", ...present).trim().split("\n").filter(Boolean);
  for (const f of files) {
    const target = path.join(dest, f);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, git("show", `${commit}:${f}`));
  }
  return files;
}

function mustReplace(file, from, to) {
  const text = fs.readFileSync(file, "utf8");
  if (!text.includes(from)) throw new Error(`patch anchor not found in ${file}: ${from}`);
  fs.writeFileSync(file, text.replace(from, to));
}

function patch(dest, entry) {
  // 1. today's filter, takedowns and ban list inside Gol's normalize()
  mustReplace(path.join(dest, "gol/gol.js"), "if (!isSafePlay(site, video.play)) return null;",
    "if (!isSafePlay(site, video.play)) return null;\n    if (globalThis.__meodeoBlocked?.(video)) return null; // legacy copy: today's moderation");
  // 2. legacy bar + guard before the app starts; noindex
  mustReplace(path.join(dest, "index.html"), '<script type="module" src="assets/app.js"></script>',
    `<script type="module" src="../legacy-guard.js" data-version="${entry.v}" data-date="${entry.date.slice(0, 10)}"></script>\n  <script type="module" src="assets/app.js"></script>`);
  for (const page of ["index.html", "legal.html"]) {
    const file = path.join(dest, page);
    if (fs.existsSync(file)) mustReplace(file, "<head>", '<head>\n  <meta name="robots" content="noindex, nofollow">');
  }
  // 3. the Claude finder (v0.1) needed a paid API key: switch it off
  const finder = path.join(dest, "claude/finder.js");
  if (fs.existsSync(finder)) {
    const src = fs.readFileSync(finder, "utf8");
    const models = src.match(/export const MODELS = \[[\s\S]*?\];/)?.[0] || "export const MODELS = [];";
    fs.writeFileSync(finder, `// Legacy copy: the Claude finder is switched off (it needed a paid Anthropic API key).
${models}
export const DEFAULT_MODEL = MODELS[0]?.id;
export async function findWithClaude() {
  throw new Error("The Claude finder is switched off in this legacy version (it needed a paid Anthropic API key).");
}
`);
  }
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const manifest = { built: new Date().toISOString().slice(0, 10), repo: REPO, current: null, versions: [] };
let prev = null;
for (const entry of VERSIONS) {
  const info = commitInfo(entry.commit);
  const slug = slugOf(entry.v);
  const dest = path.join(OUT, slug);
  const files = extract(info.hash, dest);
  patch(dest, { ...entry, date: info.date });
  const bytes = files.reduce((n, f) => n + fs.statSync(path.join(dest, f)).size, 0);
  manifest.versions.push({
    version: entry.v, slug, title: entry.title, path: `versions/${slug}/`,
    commit: info.short, commitUrl: `${REPO}/commit/${info.hash}`, codeUrl: `${REPO}/tree/${info.hash}`,
    date: info.date, summary: info.subject, details: info.body, notes: entry.notes,
    changes: changesBetween(prev, info.hash), files: files.length, sizeKB: Math.round(bytes / 1024),
  });
  prev = info.hash;
  console.log(`v${entry.v.padEnd(5)} ${info.short} ${files.length} files  ${entry.title}`);
}
const head = commitInfo("HEAD");
// The live site keeps changing after this build: link its branch rather than one commit.
const BRANCH = gitText("rev-parse", "--abbrev-ref", "HEAD").trim();
manifest.current = { version: CURRENT.v, title: CURRENT.title, path: "./", commit: head.short, commitUrl: `${REPO}/commits/${BRANCH}`,
  codeUrl: `${REPO}/tree/${BRANCH}`, date: head.date, summary: head.subject, details: head.body, changes: changesBetween(prev, head.hash) };
manifest.versions.reverse(); // newest first
fs.writeFileSync(path.join(OUT, "versions.json"), JSON.stringify(manifest, null, 2) + "\n");
fs.copyFileSync(path.join(ROOT, "scripts/legacy-guard.js"), path.join(OUT, "legacy-guard.js"));
console.log(`wrote ${manifest.versions.length} legacy versions + versions.json`);
