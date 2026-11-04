/**
 * No sign-in: every browser gets an anonymous visitor id in a cookie. It is only used to
 * share out the AI budget fairly and to show "someone else is here"; it identifies nobody.
 */
const crypto = require("crypto");

const COOKIE = "tss_visitor";
const YEAR_S = 365 * 24 * 60 * 60;

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** A soft colour per visitor, stable across visits (used for the "who's here" dots). */
function colorFor(id) {
  const palette = ["#A9C3C9", "#C9B8A9", "#B5C9A9", "#C9A9BE", "#A9AFC9", "#C9C3A9", "#A9C9BB", "#C9A9A9"];
  const h = parseInt(crypto.createHash("sha256").update(String(id)).digest("hex").slice(0, 8), 16);
  return palette[h % palette.length];
}

/** Express middleware: sets req.visitor = {id, name, color, ip}, creating the cookie on first visit. */
function visitorMiddleware({ secureCookie }) {
  return (req, res, next) => {
    let id = parseCookies(req.headers.cookie)[COOKIE];
    if (!id || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
      id = crypto.randomBytes(18).toString("base64url");
      res.append("Set-Cookie", `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${YEAR_S}${secureCookie ? "; Secure" : ""}`);
    }
    req.visitor = { id, name: "Visitor", color: colorFor(id), ip: req.ip || "?" };
    next();
  };
}

/** In-memory limiter: at most `max` hits per key in `ms`. */
function limiter(max, ms) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < ms);
    if (arr.length >= max) {
      hits.set(key, arr);
      return false;
    }
    arr.push(now);
    hits.set(key, arr);
    if (hits.size > 20000) hits.clear();
    return true;
  };
}

module.exports = { visitorMiddleware, limiter, parseCookies, colorFor, COOKIE };
