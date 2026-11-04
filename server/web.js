/**
 * Reading a web page for the research step (it used to go through the Claude desktop app's
 * browser). The server fetches the page and turns its HTML into plain text.
 *
 * Because the server fetches URLs on a user's behalf, it guards against reaching anything
 * internal: only http(s) on the standard ports, every hostname is resolved and private,
 * loopback and link-local addresses are refused (also after each redirect), with a time and
 * size limit.
 */
const dns = require("dns").promises;
const net = require("net");

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 4;

class WebError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === "::" || x === "::1") return true;
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(x);
  }
  return true;
}

async function checkUrl(raw, lookup = dns.lookup) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new WebError("tool_error", "not a valid link");
  }
  if (!["http:", "https:"].includes(u.protocol)) throw new WebError("tool_error", "only http and https links");
  if (u.port && !["80", "443"].includes(u.port)) throw new WebError("tool_error", "unusual port");
  if (u.username || u.password) throw new WebError("tool_error", "links with a login are not read");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new WebError("tool_error", "the site could not be found");
  if (addrs.some((a) => isPrivateIp(a.address))) throw new WebError("tool_error", "that address is not reachable from here");
  return u;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", euro: "€" };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** HTML → {title, text}: drops scripts, styles and navigation chrome, keeps paragraph breaks. */
function htmlToText(html) {
  let h = String(html || "");
  const title = decodeEntities(((h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "").replace(/\s+/g, " ").trim());
  h = h
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|head|title|nav|footer|form)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/?(p|div|section|article|main|header|li|ul|ol|tr|table|h[1-6]|blockquote|pre|dd|dt|figcaption)\b[^>]*>/gi, "\n")
    .replace(/<\/(td|th)>/gi, " \t ")
    .replace(/<[^>]+>/g, " ");
  const text = decodeEntities(h)
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return { title, text };
}

async function readPage(url, { fetchImpl = fetch, lookup = dns.lookup, signal } = {}) {
  let current = await checkUrl(url, lookup);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    if (signal) signal.addEventListener("abort", () => ctrl.abort(), { once: true });
    let res;
    try {
      res = await fetchImpl(current.toString(), {
        redirect: "manual",
        signal: ctrl.signal,
        headers: { "user-agent": "Mozilla/5.0 (compatible; PeakNineMarketEstimator/1.0)", accept: "text/html,text/plain;q=0.9,*/*;q=0.5" },
      });
    } catch (e) {
      clearTimeout(timer);
      throw new WebError("tool_error", e && e.name === "AbortError" ? "the page took too long" : "the page could not be opened");
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      clearTimeout(timer);
      current = await checkUrl(new URL(res.headers.get("location"), current).toString(), lookup);
      continue;
    }
    try {
      if (!res.ok) throw new WebError("bad_page", `the page answered ${res.status}`);
      const type = String(res.headers.get("content-type") || "");
      if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) throw new WebError("tool_error", "not a web page (maybe a PDF or a file)");
      const body = await readLimited(res);
      if (/text\/plain/i.test(type)) return { title: "", text: body.trim() };
      return htmlToText(body);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new WebError("tool_error", "too many redirects");
}

async function readLimited(res) {
  if (!res.body || !res.body.getReader) return (await res.text()).slice(0, MAX_BYTES);
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    chunks.push(value);
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

module.exports = { readPage, htmlToText, isPrivateIp, checkUrl, WebError };
