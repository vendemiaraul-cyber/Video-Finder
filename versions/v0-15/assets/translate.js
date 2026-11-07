// Languages for MeoDeo through Google's free website translator
// (translate.google.com/translate_a/element.js: no API key, no account, no billing).
// Google's script is only loaded once someone picks a language other than English,
// so visitors who stay in English never contact Google.

export const LANGUAGES = [
  ["en", "English"], ["es", "Español"], ["fr", "Français"], ["de", "Deutsch"], ["it", "Italiano"],
  ["pt", "Português"], ["nl", "Nederlands"], ["pl", "Polski"], ["ro", "Română"], ["sv", "Svenska"],
  ["el", "Ελληνικά"], ["tr", "Türkçe"], ["ru", "Русский"], ["uk", "Українська"], ["ar", "العربية"],
  ["he", "עברית"], ["fa", "فارسی"], ["hi", "हिन्दी"], ["bn", "বাংলা"], ["ur", "اردو"],
  ["id", "Bahasa Indonesia"], ["ms", "Bahasa Melayu"], ["vi", "Tiếng Việt"], ["th", "ไทย"], ["tl", "Filipino"],
  ["zh-CN", "中文（简体）"], ["zh-TW", "中文（繁體）"], ["ja", "日本語"], ["ko", "한국어"], ["sw", "Kiswahili"],
];
const CODES = new Set(LANGUAGES.map(([c]) => c));
const KEY = "meodeo.lang.v1";
const SCRIPT = "https://translate.google.com/translate_a/element.js?cb=meodeoTranslateReady";

const read = () => { try { return localStorage.getItem(KEY) || ""; } catch { return ""; } };
const write = (v) => { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch {} };

// Google's translator reads its target language from the "googtrans" cookie.
function setCookie(lang) {
  const value = lang && lang !== "en" ? `/en/${lang}` : "";
  const age = value ? "max-age=31536000" : "max-age=0";
  document.cookie = `googtrans=${value}; path=/; ${age}; SameSite=Lax`;
  if (location.hostname.includes(".")) document.cookie = `googtrans=${value}; path=/; domain=.${location.hostname}; ${age}; SameSite=Lax`;
}

let loading = null;
function loadGoogle() {
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    window.meodeoTranslateReady = () => {
      // eslint-disable-next-line no-undef
      new google.translate.TranslateElement({ pageLanguage: "en", autoDisplay: false }, "gt-host");
      resolve();
    };
    const s = Object.assign(document.createElement("script"), { src: SCRIPT, async: true });
    s.onerror = () => { loading = null; reject(new Error("Google Translate didn't load")); };
    document.head.append(s);
  });
  return loading;
}

// The widget builds a hidden <select class="goog-te-combo">; choosing in it translates the page.
async function applyWith(lang, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const combo = document.querySelector(".goog-te-combo");
    if (combo && combo.options.length > 1) {
      combo.value = lang;
      combo.dispatchEvent(new Event("change"));
      return true;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function setDir(lang) {
  document.documentElement.lang = lang || "en";
}

/** Pick a language: "en" (or "") goes back to the original English page. */
export async function setLanguage(lang, { onError } = {}) {
  lang = CODES.has(lang) ? lang : "en";
  write(lang === "en" ? "" : lang);
  setCookie(lang);
  if (lang === "en") {
    // Translated text can't be cleanly undone in place: reload the untouched page.
    if (document.documentElement.classList.contains("translated-ltr") || document.documentElement.classList.contains("translated-rtl") || loading) location.reload();
    return;
  }
  try {
    await loadGoogle();
    if (!(await applyWith(lang))) throw new Error("Google Translate didn't start");
    setDir(lang);
  } catch (e) {
    onError?.(e);
  }
}

/** Fill the language menu and restore the visitor's last choice. */
export function initLanguages(select, { onError } = {}) {
  if (!select) return;
  const saved = CODES.has(read()) ? read() : "en";
  select.replaceChildren(...LANGUAGES.map(([code, name]) => Object.assign(document.createElement("option"), { value: code, textContent: name, selected: code === saved })));
  select.classList.add("notranslate");
  select.translate = false;
  select.addEventListener("change", () => setLanguage(select.value, { onError }));
  if (saved !== "en") setLanguage(saved, { onError });
}
