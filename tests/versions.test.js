import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync(new URL("../versions/versions.json", import.meta.url)));

test("every legacy version is a complete copy with today's moderation and a noindex tag", () => {
  assert.ok(manifest.versions.length >= 10);
  assert.ok(manifest.current?.version);
  for (const v of manifest.versions) {
    const dir = new URL(`../${v.path}`, import.meta.url);
    const html = fs.readFileSync(new URL("index.html", dir), "utf8");
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/, v.version);
    assert.match(html, /src="\.\.\/legacy-guard\.js" data-version="[\d.]+"/, v.version);
    assert.ok(html.indexOf("legacy-guard.js") < html.indexOf('src="assets/app.js"'), "the guard loads before the app");
    assert.match(fs.readFileSync(new URL("gol/gol.js", dir), "utf8"), /globalThis\.__meodeoBlocked\?\.\(video\)/, v.version);
    assert.ok(fs.existsSync(new URL("assets/app.js", dir)), v.version);
    assert.match(v.commitUrl, /^https:\/\/github\.com\/vendemiaraul-cyber\/Video-Finder\/commit\/[0-9a-f]{40}$/);
  }
});

test("the first version's paid Claude finder is switched off", () => {
  const finder = fs.readFileSync(new URL("../versions/v0-1/claude/finder.js", import.meta.url), "utf8");
  assert.match(finder, /switched off/);
  assert.doesNotMatch(finder, /api\.anthropic\.com|anthropic-ai\/sdk/);
});
