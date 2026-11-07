/**
 * Page fetching for the probe on Cloudflare (Pages Functions / Workers),
 * using plain fetch(). Same result shape as fetchPage in net.js:
 * { status, headers (lower-case keys), body, url, chain, loop?, tooManyRedirects? }
 *
 * Cloudflare already refuses requests from Functions to private networks,
 * so the private-address guard of net.js isn't needed here.
 */
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 MeoDeo/0.2";

async function readLimited(res, maxBytes) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
  reader.cancel().catch(() => {});
  return text.slice(0, maxBytes);
}

export async function workerFetchPage(url, { timeoutMs = 6000, maxBytes = 250_000, maxRedirects = 5, fetchImpl = fetch } = {}) {
  const chain = [url];
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!/^https?:$/.test(new URL(current).protocol)) throw new Error("unsupported protocol");
    const res = await fetchImpl(current, {
      redirect: "manual",
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,*/*;q=0.8", "accept-language": "en-US,en;q=0.8" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const headers = {};
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      res.body?.cancel().catch(() => {});
      const next = new URL(loc, current).href;
      if (chain.includes(next)) return { status: res.status, headers, body: "", url: current, chain, loop: true };
      chain.push(next);
      current = next;
      continue;
    }
    const body = /html|xml|json|text/i.test(headers["content-type"] || "") ? await readLimited(res, maxBytes) : (res.body?.cancel().catch(() => {}), "");
    return { status: res.status, headers, body, url: current, chain };
  }
  return { status: 0, headers: {}, body: "", url: current, chain, tooManyRedirects: true };
}
