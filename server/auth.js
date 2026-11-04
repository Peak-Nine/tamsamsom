/**
 * Login by email link, no passwords.
 *
 *   1. POST /auth/request {email}: if the email is allowed, we email a one-time link (15 minutes).
 *   2. GET /auth/verify?token=…: a page with a "Sign in" button. It does not sign in by itself,
 *      because mail scanners open links in advance and would use up the token.
 *   3. POST /auth/verify {token}: the token is used once, a session cookie is set (30 days).
 *
 * Who may sign in: every address on ALLOWED_DOMAINS (the team, e.g. peaknine.studio) and the
 * single addresses on ALLOWED_EMAILS (clients). Tokens and session ids are stored hashed.
 */
const crypto = require("crypto");

const TOKEN_MS = 15 * 60 * 1000;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const COOKIE = "tss_session";

const list = (s) =>
  String(s || "")
    .split(/[,\s]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

function accessConfig(env = process.env) {
  return { domains: list(env.ALLOWED_DOMAINS), emails: list(env.ALLOWED_EMAILS) };
}

const normEmail = (e) => String(e || "").trim().toLowerCase();
const validEmail = (e) => /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i.test(e) && e.length <= 200;

/** "team" (sees every project), "guest" (sees its own projects) or null (not allowed). */
function roleOf(email, cfg = accessConfig()) {
  const e = normEmail(email);
  if (!validEmail(e)) return null;
  const domain = e.split("@")[1];
  if (cfg.domains.includes(domain)) return "team";
  if (cfg.emails.includes(e)) return "guest";
  return null;
}

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const randomToken = () => crypto.randomBytes(32).toString("base64url");

function nameFromEmail(email) {
  const local = normEmail(email).split("@")[0].split(/[._+-]/)[0] || "Someone";
  return local.charAt(0).toUpperCase() + local.slice(1);
}

/** A soft colour per person, stable across visits (used for the "who's here" dots). */
function colorFor(email) {
  const palette = ["#A9C3C9", "#C9B8A9", "#B5C9A9", "#C9A9BE", "#A9AFC9", "#C9C3A9", "#A9C9BB", "#C9A9A9"];
  const h = parseInt(sha(normEmail(email)).slice(0, 8), 16);
  return palette[h % palette.length];
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
    if (hits.size > 10000) hits.clear();
    return true;
  };
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createAuth({ pool, mailer, appUrl, secureCookie = true, env = process.env }) {
  const perEmail = limiter(5, 15 * 60 * 1000);
  const perIp = limiter(20, 15 * 60 * 1000);

  async function requestLink(email, ip) {
    const e = normEmail(email);
    // Same answer whether or not the address is allowed, so the form can't be used to probe the list.
    const generic = { ok: true };
    if (!validEmail(e)) return { ok: false, error: "That doesn't look like an email address." };
    if (!perIp(ip || "?") || !perEmail(e)) return { ok: false, error: "Too many requests. Wait a few minutes and try again." };
    if (!roleOf(e, accessConfig(env))) return generic;
    const token = randomToken();
    await pool.query("INSERT INTO login_tokens (token_hash, email, expires_at) VALUES ($1, $2, $3)", [sha(token), e, Date.now() + TOKEN_MS]);
    const link = `${appUrl.replace(/\/$/, "")}/auth/verify?token=${encodeURIComponent(token)}`;
    await mailer.send({
      to: e,
      subject: "Your sign-in link for the Market Estimator",
      text: `Hi,\n\nClick this link to sign in to the Peak Nine Market Estimator:\n\n${link}\n\nThe link works once and expires in 15 minutes. If you didn't ask for it, you can ignore this email.\n\nPeak Nine`,
      link,
    });
    return generic;
  }

  /** Use a token once; returns the new session id or null. */
  async function verify(token) {
    if (!token || typeof token !== "string" || token.length > 200) return null;
    const r = await pool.query(
      "UPDATE login_tokens SET used = TRUE WHERE token_hash = $1 AND used = FALSE AND expires_at > $2 RETURNING email",
      [sha(token), Date.now()]
    );
    if (!r.rows.length) return null;
    const email = r.rows[0].email;
    if (!roleOf(email, accessConfig(env))) return null; // removed from the list since
    const sid = randomToken();
    const now = Date.now();
    await pool.query("INSERT INTO sessions (id_hash, email, created_at, expires_at) VALUES ($1, $2, $3, $4)", [sha(sid), email, now, now + SESSION_MS]);
    await pool.query(
      `INSERT INTO users (email, name, created_at, last_login) VALUES ($1, $2, $3, $3)
       ON CONFLICT (email) DO UPDATE SET last_login = EXCLUDED.last_login`,
      [email, nameFromEmail(email), now]
    );
    return sid;
  }

  /** The signed-in user for a request, or null. Re-checks the allow list on every request. */
  async function userFor(req) {
    const sid = parseCookies(req.headers.cookie)[COOKIE];
    if (!sid) return null;
    const r = await pool.query("SELECT email FROM sessions WHERE id_hash = $1 AND expires_at > $2", [sha(sid), Date.now()]);
    if (!r.rows.length) return null;
    const email = r.rows[0].email;
    const role = roleOf(email, accessConfig(env));
    if (!role) return null;
    const u = await pool.query("SELECT name FROM users WHERE email = $1", [email]);
    return { id: email, email, role, name: (u.rows[0] && u.rows[0].name) || nameFromEmail(email), color: colorFor(email) };
  }

  async function signOut(req) {
    const sid = parseCookies(req.headers.cookie)[COOKIE];
    if (sid) await pool.query("DELETE FROM sessions WHERE id_hash = $1", [sha(sid)]);
  }

  function sessionCookie(sid) {
    return `${COOKIE}=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secureCookie ? "; Secure" : ""}`;
  }
  const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie ? "; Secure" : ""}`;

  return { requestLink, verify, userFor, signOut, sessionCookie, clearCookie };
}

/** Sends mail over SMTP (works with Google Workspace, Resend, Postmark, …). Without SMTP_HOST, outside production, it logs the link. */
function createMailer(env = process.env) {
  if (!env.SMTP_HOST) {
    return {
      async send({ to, link }) {
        if (env.NODE_ENV === "production") throw new Error("SMTP is not configured");
        console.log(`[mail] sign-in link for ${to}: ${link}`);
      },
    };
  }
  const nodemailer = require("nodemailer");
  const t = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT || 587),
    secure: Number(env.SMTP_PORT) === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  return {
    async send({ to, subject, text }) {
      await t.sendMail({ from: env.MAIL_FROM || env.SMTP_USER, to, subject, text });
    },
  };
}

module.exports = { createAuth, createMailer, roleOf, accessConfig, nameFromEmail, colorFor, parseCookies, limiter, COOKIE };
