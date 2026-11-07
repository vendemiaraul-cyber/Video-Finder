/**
 * Safe page fetching for the probe, using only Node's built-in modules.
 *
 * - Refuses private, loopback and link-local addresses on every hop
 *   (checked inside the DNS lookup itself, so DNS rebinding can't slip past).
 * - Follows redirects by hand so the probe can see where a page sends you
 *   (consent and login pages mean "needs cookies").
 * - Caps time and size; decodes gzip, deflate and brotli.
 */
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import zlib from "node:zlib";

export const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 MeoDeo/0.2";

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("ff");
}

function guardedLookup(allowPrivate) {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const bad = !allowPrivate && addresses.find((a) => isPrivateAddress(a.address));
      if (bad) return callback(Object.assign(new Error(`blocked private address ${bad.address}`), { code: "EBLOCKED" }));
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

/** One request, no redirect following. Resolves { status, headers, body (string), url }. */
function requestOnce(url, { timeoutMs, maxBytes, allowPrivate, method = "GET" }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return reject(new Error("unsupported protocol"));
    const literal = u.hostname.replace(/^\[|\]$/g, "");
    if (!allowPrivate && (literal === "localhost" || (net.isIP(literal) && isPrivateAddress(literal)))) {
      return reject(Object.assign(new Error("blocked private address"), { code: "EBLOCKED" }));
    }
    if (u.port && !["80", "443"].includes(u.port) && !allowPrivate) {
      return reject(Object.assign(new Error("unsupported port"), { code: "EBLOCKED" }));
    }
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(u, {
      method,
      lookup: guardedLookup(allowPrivate),
      headers: {
        "user-agent": UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.8",
        "accept-encoding": "gzip, deflate, br",
      },
      timeout: timeoutMs,
    }, (res) => {
      const enc = String(res.headers["content-encoding"] || "").toLowerCase();
      let stream = res;
      if (enc === "gzip") stream = res.pipe(zlib.createGunzip());
      else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
      else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
      const type = String(res.headers["content-type"] || "");
      const chunks = [];
      let size = 0;
      const finish = () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8"), url });
      if (method === "HEAD" || res.statusCode >= 300 && res.statusCode < 400 || !/html|xml|json|text/i.test(type)) {
        res.resume();
        return finish();
      }
      stream.on("data", (c) => {
        size += c.length;
        if (size > maxBytes) {
          chunks.push(c.subarray(0, Math.max(0, c.length - (size - maxBytes))));
          req.destroy();
          finish();
        } else chunks.push(c);
      });
      stream.on("end", finish);
      stream.on("error", (e) => (chunks.length ? finish() : reject(e)));
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end();
  });
}

/**
 * GET with manual redirects. Resolves { status, headers, body, url, chain }
 * where chain lists every URL visited.
 */
export async function fetchPage(url, { timeoutMs = 6000, maxBytes = 1_500_000, maxRedirects = 5, allowPrivate = false, method } = {}) {
  const chain = [url];
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await requestOnce(current, { timeoutMs, maxBytes, allowPrivate, method });
    const loc = res.headers.location;
    if (res.status >= 300 && res.status < 400 && loc) {
      const next = new URL(loc, current).href;
      if (chain.includes(next)) return { ...res, chain, loop: true };
      chain.push(next);
      current = next;
      continue;
    }
    return { ...res, url: current, chain };
  }
  return { status: 0, headers: {}, body: "", url: current, chain, tooManyRedirects: true };
}
