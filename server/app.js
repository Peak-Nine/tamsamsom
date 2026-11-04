/**
 * The web server: login, the tool itself, and the API that replaces the Claude features
 * (shared database, AI, web research, who's online).
 */
const path = require("path");
const fs = require("fs");
const express = require("express");
const { createDocStore, docParent, projectOf, DocError } = require("./docs");
const { createAccess } = require("./access");
const { createAuth, createMailer } = require("./auth");
const { createAi, AiError } = require("./ai");
const { readPage, WebError } = require("./web");

const PUBLIC = path.join(__dirname, "..", "public");

function createApp({ pool, env = process.env, mailer, aiClient, webFetch, lookup }) {
  const appUrl = env.APP_URL || "http://localhost:3000";
  const store = createDocStore(pool);
  const access = createAccess(store);
  const auth = createAuth({ pool, mailer: mailer || createMailer(env), appUrl, secureCookie: appUrl.startsWith("https://"), env });
  const ai = createAi({ pool, client: aiClient, env });

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "same-origin");
    res.set("X-Frame-Options", "DENY");
    next();
  });

  // Writes only from our own pages: a cross-site form or script can't use someone's session.
  const allowedOrigin = new URL(appUrl).origin;
  app.use((req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const origin = req.get("origin");
    if (origin && origin !== allowedOrigin && origin !== `${req.protocol}://${req.get("host")}`) {
      return res.status(403).json({ error: { code: "not_granted", message: "cross-site request refused" } });
    }
    next();
  });

  app.get("/healthz", (req, res) => res.type("text").send("ok"));

  // ── Sign in ───────────────────────────────────────────────────────────────
  const page = (name) => fs.readFileSync(path.join(PUBLIC, name), "utf8");
  app.get("/login", (req, res) => res.type("html").send(page("login.html")));
  app.post("/auth/request", async (req, res, next) => {
    try {
      const r = await auth.requestLink(req.body && req.body.email, req.ip);
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      next(e);
    }
  });
  app.get("/auth/verify", (req, res) => {
    const token = String(req.query.token || "").replace(/[^A-Za-z0-9_-]/g, "");
    res.type("html").send(page("verify.html").replace("__TOKEN__", token));
  });
  app.post("/auth/verify", async (req, res, next) => {
    try {
      const sid = await auth.verify(req.body && req.body.token);
      if (!sid) return res.redirect(303, "/login?expired=1");
      res.set("Set-Cookie", auth.sessionCookie(sid)).redirect(303, "/");
    } catch (e) {
      next(e);
    }
  });
  app.post("/auth/logout", async (req, res, next) => {
    try {
      await auth.signOut(req);
      res.set("Set-Cookie", auth.clearCookie()).redirect(303, "/login");
    } catch (e) {
      next(e);
    }
  });

  // ── Everything below needs a signed-in user ────────────────────────────────
  app.use(async (req, res, next) => {
    try {
      req.user = await auth.userFor(req);
      if (req.user) return next();
      if (req.path.startsWith("/api/")) return res.status(401).json({ error: { code: "session_expired", message: "Sign in again." } });
      return res.redirect(302, "/login");
    } catch (e) {
      next(e);
    }
  });

  app.get("/", (req, res) => res.type("html").set("Cache-Control", "no-store").send(page("app.html")));
  app.use("/assets", express.static(path.join(PUBLIC, "assets"), { maxAge: "1h" }));

  app.get("/api/me", (req, res) => {
    const { id, name, email, color, role } = req.user;
    res.json({ id, name, email, color, role });
  });

  // ── Documents ─────────────────────────────────────────────────────────────
  app.get("/api/doc", async (req, res, next) => {
    try {
      const p = String(req.query.path || "");
      docParent(p);
      if (!(await access.canRead(req.user, p))) throw new DocError("not_granted", "not allowed");
      res.json(await store.get(p));
    } catch (e) {
      next(e);
    }
  });
  app.put("/api/doc", async (req, res, next) => {
    try {
      const { path: p, data, mode } = req.body || {};
      const existing = await store.get(p);
      const isCreate = mode === "set" || !existing.exists;
      const clean = await access.checkWrite(req.user, p, data, isCreate);
      if (mode === "set") await store.set(p, clean);
      else await store.update(p, clean);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  app.get("/api/collection", async (req, res, next) => {
    try {
      const p = String(req.query.path || "");
      if (!(await access.canRead(req.user, p))) throw new DocError("not_granted", "not allowed");
      let rows = await store.list(p, { orderBy: req.query.orderBy || null, dir: req.query.dir, limit: req.query.limit });
      if (p === "projects") rows = await access.filterProjects(req.user, rows);
      res.json({ docs: rows.map((r) => ({ id: r.id, data: r.data })) });
    } catch (e) {
      next(e);
    }
  });

  // ── AI and web research ───────────────────────────────────────────────────
  // Stop the AI call when the browser goes away before the answer was sent (e.g. "Stop" or a reload).
  const abortOnClose = (req, res) => {
    const ctrl = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) ctrl.abort();
    });
    return ctrl.signal;
  };
  app.post("/api/ai/json", async (req, res, next) => {
    try {
      const { prompt, tier } = req.body || {};
      res.json({ result: await ai.json(req.user, prompt, { tier, signal: abortOnClose(req, res) }) });
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/web/search", async (req, res, next) => {
    try {
      res.json({ results: await ai.search(req.user, req.body && req.body.q, { signal: abortOnClose(req, res) }) });
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/web/read", async (req, res, next) => {
    try {
      res.json(await readPage(String((req.body && req.body.url) || ""), { fetchImpl: webFetch, lookup }));
    } catch (e) {
      next(e);
    }
  });

  // ── Live sync and presence (Server-Sent Events) ──────────────────────────
  const streams = new Set();
  const rooms = new Map(); // room -> Map(email -> {presence, at})
  const send = (s, obj) => s.res.write(`data: ${JSON.stringify(obj)}\n\n`);

  store.events.on("change", async ({ path: p, parent }) => {
    for (const s of streams) {
      try {
        if (await access.canRead(s.user, p)) send(s, { type: "doc", path: p, parent });
      } catch {
        /* skip this listener */
      }
    }
  });

  const roomProject = (room) => (String(room).startsWith("p-") ? String(room).slice(2) : null);
  async function canJoin(user, room) {
    const pid = roomProject(room);
    return !!pid && /^[A-Za-z0-9_-]{1,120}$/.test(pid) && access.canRead(user, `projects/${pid}`);
  }
  function broadcastPeers(room) {
    const members = rooms.get(room) || new Map();
    for (const s of streams) {
      if (!members.has(s.user.email) && !s.rooms.has(room)) continue;
      const peers = [...members.entries()].filter(([email]) => email !== s.user.email).map(([, v]) => ({ presence: v.presence }));
      send(s, { type: "peers", room, peers });
    }
  }
  setInterval(() => {
    const now = Date.now();
    for (const [room, members] of rooms) {
      let changed = false;
      for (const [email, v] of members) if (now - v.at > 60000) (members.delete(email), (changed = true));
      if (!members.size) rooms.delete(room);
      if (changed) broadcastPeers(room);
    }
  }, 15000).unref();

  app.get("/api/events", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    const s = { user: req.user, res, rooms: new Set() };
    streams.add(s);
    res.write(": connected\n\n");
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => {
      clearInterval(ping);
      streams.delete(s);
    });
  });
  app.post("/api/room", async (req, res, next) => {
    try {
      const { room, presence, leave } = req.body || {};
      if (!(await canJoin(req.user, room))) throw new DocError("not_granted", "not allowed");
      const members = rooms.get(room) || new Map();
      if (leave) members.delete(req.user.email);
      else {
        const pres = { ...(presence || {}), name: req.user.name, color: req.user.color };
        members.set(req.user.email, { presence: pres, at: Date.now() });
        for (const s of streams) if (s.user.email === req.user.email) s.rooms.add(room);
      }
      rooms.set(room, members);
      broadcastPeers(room);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ── Errors, in the codes the tool understands ─────────────────────────────
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof DocError) {
      return res.status(err.code === "not_granted" ? 403 : 400).json({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof AiError || err instanceof WebError) {
      return res.status(422).json({ error: { code: err.code, message: err.message, text: err.text } });
    }
    if (err && err.type === "entity.too.large") return res.status(413).json({ error: { code: "prompt_too_large", message: "too large" } });
    console.error("[server]", err);
    res.status(500).json({ error: { code: "unavailable", message: "Something went wrong on the server." } });
  });

  app.locals.store = store;
  return app;
}

module.exports = { createApp, projectOf };
