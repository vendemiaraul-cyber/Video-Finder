/**
 * Relevance: which results are really about what was searched.
 *
 *   "match"   every search word is in the title (or most of them, for long searches)
 *   "related" every search word is in the title or the description
 *   "other"   the rest, plus songs, poems/nursery rhymes and game videos whose
 *             title merely contains the word (unless the search asks for music,
 *             poems or games). A channel name alone doesn't count.
 *
 * rank() keeps each tier in its original (site-mixed) order.
 */
const STOP = new Set(["the", "a", "an", "of", "in", "on", "and", "or", "to", "for", "with", "at", "by", "from", "video", "videos",
  "de", "la", "el", "le", "les", "des", "du", "di", "il", "lo", "y", "e", "et", "und", "der", "die", "das"]);

const fold = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function queryWords(query) {
  return [...new Set(fold(query).match(/[\p{L}\p{N}]+/gu) || [])].filter((w) => w.length >= 2 && !STOP.has(w));
}

// whole words only ("moon" matches "moons", not "honeymoon")
const wordRe = (w) => new RegExp(`(?<![\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(s|es)?(?![\\p{L}\\p{N}])`, "u");

/* Titles that are something else that happens to contain the word. */
const KINDS = {
  music: {
    // (alternatives starting or ending with punctuation can't use \b, so each carries its own boundaries)
    title: /(official\s+(music\s+)?(video|audio|visuali[sz]er|m\/?v)|\blyrics?\b|[([]\s*(audio|official|lyrics?|m\/?v)\s*[)\]]|\bm\/v\b|\bmv\b|\bvisuali[sz]er\b|\bft\.|\bfeat\.?\s|\bremix\b|\bkaraoke\b|\binstrumental\b|\bhd rip\b|\bcover\b|\bacoustic\b|\bsong\b|-productions\b|\blive (at|in|from)\b|\bmusic video\b|\bdance (practice|cover|tutorial|challenge)\b|\bchoreograph|\bconcert\b)/i,
    channel: /(vevo|\bmusic\b|records\b|\brecordings\b| - topic$|\bband\b|\borchestra\b|\bsongs?\b)/i,
    query: /\b(music|songs?|lyrics?|bands?|album|concert|remix|cover|mv|karaoke|singer|rap|jazz|rock|pop|lofi|lo-fi|playlist|dj)\b/i,
  },
  poems: {
    title: /\b(poem|poetry|nursery|lullaby|rhyme)s?\b/i,
    channel: /(poemhunter|poetry|nursery)/i,
    query: /\b(poem|poetry|nursery|lullaby|rhyme)s?\b/i,
  },
  games: {
    title: /\b(playthrough|gameplay|walkthrough|let'?s play|speedrun|level runs?|mission [a-z]-?\d|full game|no commentary)\b/i,
    channel: /(gaming|\bgames\b|letsplay)/i,
    query: /\b(games?|gaming|gameplay|playthrough|walkthrough|speedrun|minecraft|fortnite|nintendo|playstation|xbox)\b/i,
  },
};

const QUOTES_OPEN = `'"\u2018\u201C\u300A\u300C\u300E\u3010`;   // ' " ‘ “ 《 「 『 【
const QUOTES_CLOSE = `'"\u2019\u201D\u300B\u300D\u300F\u3011`;  // ' " ’ ” 》 」 』 】

/** The search word written as a quoted title, like 'MOON' or 《MOON》: a song (or show) name. */
function quotedTitle(title, query) {
  const t = fold(title);
  return queryWords(query).some((w) => new RegExp(`[${QUOTES_OPEN}]\\s*${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[${QUOTES_CLOSE}]`, "u").test(t));
}

/** What kind of off-topic video this looks like (null if none). */
export function offTopicKind(video, query) {
  if (!KINDS.music.query.test(query) && quotedTitle(video.title, query)) return "music";
  for (const [kind, k] of Object.entries(KINDS)) {
    if (k.query.test(query)) continue; // the search asks for this kind
    if (k.title.test(video.title || "") || k.channel.test(video.channel || "")) return kind;
  }
  return null;
}

/** "match" | "related" | "other" */
export function tierOf(video, query, words = queryWords(query)) {
  if (!words.length) return "match";
  const title = fold(video.title);
  const desc = fold(video.description);
  const inTitle = words.filter((w) => wordRe(w).test(title)).length;
  const inEither = words.filter((w) => wordRe(w).test(title) || wordRe(w).test(desc)).length;
  const need = words.length >= 3 ? Math.ceil(words.length * 0.67) : words.length;
  let tier = inTitle >= need ? "match" : inEither >= need ? "related" : "other";
  if (tier !== "other" && offTopicKind(video, query)) tier = "other";
  return tier;
}

/** Split results: { main: [matches..., related...], others: [...] } */
export function rank(query, videos) {
  const words = queryWords(query);
  const match = [], related = [], others = [];
  for (const v of videos) ({ match, related, other: others })[tierOf(v, query, words)].push(v);
  return { main: [...match, ...related], others, counts: { match: match.length, related: related.length, other: others.length } };
}
