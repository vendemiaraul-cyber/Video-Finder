/**
 * Auto-Filter: picks the sources most likely to have what you search for.
 *
 * 1. Topics: words in the search point to sources (space -> NASA, Wikimedia,
 *    Internet Archive; music -> YouTube, Dailymotion, Odysee...).
 * 2. Learning: after each search, sources that found something for its words
 *    gain points, sources that found nothing lose points. Next time, sources
 *    with points for those words are added, and sources that keep finding
 *    nothing are left out.
 */
export const TOPICS = [
  { name: "space", words: /\b(nasa|space|moon|lunar|apollo|mars|rocket|astronauts?|iss|planets?|galaxy|nebula|telescope|hubble|webb|spacex|orbit|satellites?|asteroid|comet|eclipse|artemis)\b/i,
    sources: ["nasa", "commons", "archive", "youtube", "searxng"] },
  { name: "history and old films", words: /\b(history|historic(al)?|wars?|ww1|ww2|wwii|vintage|old|archives?|archival|newsreels?|silent|classic|public domain|documentar(y|ies)|1[89]\d0s|1[89]\d\d)\b/i,
    sources: ["archive", "europeana", "commons", "youtube", "peertube", "searxng"] },
  { name: "stock footage", words: /\b(stock|b-?roll|footage|background|drone|aerial|time-?lapse|slow motion|4k|loop)\b/i,
    sources: ["pexels", "commons", "archive", "youtube", "searxng"] },
  { name: "nature and science", words: /\b(nature|animals?|wildlife|birds?|ocean|sea|forest|volcano|science|biology|physics|chemistry|experiment)\b/i,
    sources: ["commons", "nasa", "youtube", "dailymotion", "peertube", "searxng"] },
  { name: "music", words: /\b(music|songs?|concerts?|album|live|remix|lo-?fi|band|rap|jazz|rock|pop|dj|playlist|cover)\b/i,
    sources: ["youtube", "dailymotion", "odysee", "peertube", "searxng"] },
  { name: "news", words: /\b(news|today|breaking|elections?|interview|press|politics?|political|minister|president)\b/i,
    sources: ["searxng", "dailymotion", "youtube"] },
  { name: "learning", words: /\b(how to|tutorials?|learn(ing)?|course|lectures?|lessons?|explained|guide|talks?|conference|programming|coding|linux)\b/i,
    sources: ["youtube", "peertube", "searxng", "odysee"] },
  { name: "gaming", words: /\b(games?|gaming|gameplay|minecraft|fortnite|speedrun|walkthrough|playthrough|let'?s play|esports)\b/i,
    sources: ["youtube", "odysee", "peertube", "dailymotion"] },
  { name: "cooking", words: /\b(recipes?|cooking|cook|food|baking|bake|pasta|chef|kitchen)\b/i,
    sources: ["youtube", "dailymotion", "searxng", "peertube"] },
];
export const DEFAULT_SOURCES = ["youtube", "dailymotion", "peertube", "odysee", "searxng"];
const STOP = new Set(["the", "and", "for", "with", "from", "video", "videos", "watch", "full", "best", "how", "what", "who", "why", "una", "the"]);

export function words(query) {
  return [...new Set(String(query).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [])].filter((w) => !STOP.has(w)).slice(0, 8);
}

/**
 * @param {string} query
 * @param {string[]} available  sources that can be searched right now
 * @param {object} learned      { word: { source: score } }
 * @returns {{ sources: string[], topics: string[] }}
 */
export function pickSources(query, available, learned = {}) {
  const can = new Set(available);
  const topics = TOPICS.filter((t) => t.words.test(query));
  const picked = new Set((topics.length ? topics.flatMap((t) => t.sources) : DEFAULT_SOURCES).filter((s) => can.has(s)));
  const ws = words(query);
  for (const s of can) {
    const score = ws.reduce((n, w) => n + (learned[w]?.[s] || 0), 0);
    if (score >= 2) picked.add(s);          // found things for these words before
    if (score <= -3) picked.delete(s);      // keeps finding nothing for them
  }
  if (!picked.size) for (const s of DEFAULT_SOURCES) if (can.has(s)) picked.add(s);
  return { sources: available.filter((s) => picked.has(s)), topics: topics.map((t) => t.name) };
}

/** Learn from a finished search: status = { source: { ok, count } }. Returns the updated table. */
export function learn(learned, query, status, maxWords = 400) {
  const out = { ...learned };
  for (const w of words(query)) {
    const row = { ...(out[w] || {}) };
    for (const [s, st] of Object.entries(status)) {
      if (!st.ok) continue; // a source that was down says nothing about the words
      row[s] = Math.max(-5, Math.min(5, (row[s] || 0) + (st.count > 0 ? 1 : -1)));
    }
    delete out[w];
    out[w] = row; // most recent last
  }
  const keys = Object.keys(out);
  for (const k of keys.slice(0, Math.max(0, keys.length - maxWords))) delete out[k];
  return out;
}
