/**
 * The web server: the tool itself, and the API that replaces the Claude features (shared
 * database, AI, web research, who's online).
 *
 * The site is public: no sign-in, one shared project list for everyone. Because anyone with
 * the link can use it, every costly or heavy route has a brake:
 *   - AI and web search: daily caps in ai.js (all visitors together, and per visitor/address)
 *   - reading pages: per address per hour
 *   - saving: per address per minute, and a size limit per document
 * and search engines are asked not to index it.
 */
const path = require("path");
const fs = require("fs");
const express = require("express");
const { createDocStore, docParent, DocError } = require("./docs");
const { createAi, AiError } = require("./ai");
const { readPage, WebError } = require("./web");
const { visitorMiddleware, limiter } = require("./visitor");

const PUBLIC = path.join(__dirname, "..", "public");

class LimitError extends Error {
  constructor(message) {
    super(message);
    this.code = "rate_limited";
  }
}

function createApp({ pool, env = process.env, aiClient, webFetch, lookup }) {
  const appUrl = env.APP_URL || "http://localhost:3000";
  const store = createDocStore(pool);
  const ai = createAi({ pool, client: aiClient, env });

  const writesPerMinute = limiter(Number(env.WRITE_LIMIT_PER_MINUTE || 240), 60 * 1000);
  const readsPerHour = limiter(Number(env.READ_LIMIT_PER_HOUR || 120), 60 * 60 * 1000);

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "2mb" }));
  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "same-origin");
    res.set("X-Frame-Options", "DENY");
    res.set("X-Robots-Tag", "noindex, nofollow");
    next();
  });

  // Writes only from our own page: another site can't use a visitor's browser to change projects.
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
  app.get("/robots.txt", (req, res) => res.type("text").send("User-agent: *\nDisallow: /\n"));

  app.use(visitorMiddleware({ secureCookie: appUrl.startsWith("https://") }));

  const appHtml = () => fs.readFileSync(path.join(PUBLIC, "app.html"), "utf8");
  app.get("/", (req, res) => res.type("html").set("Cache-Control", "no-store").send(appHtml()));
  app.use("/assets", express.static(path.join(PUBLIC, "assets"), { maxAge: "1h" }));

  app.get("/api/me", (req, res) => {
    const { id, name, color } = req.visitor;
    res.json({ id, name, color });
  });

  // ── Documents (only the "projects" tree) ──────────────────────────────────
  const inProjects = (p) => {
    if (!String(p || "").startsWith("projects")) throw new DocError("not_granted", "not allowed");
  };
  app.get("/api/doc", async (req, res, next) => {
    try {
      const p = String(req.query.path || "");
      docParent(p);
      inProjects(p);
      res.json(await store.get(p));
    } catch (e) {
      next(e);
    }
  });
  app.put("/api/doc", async (req, res, next) => {
    try {
      const { path: p, data, mode } = req.body || {};
      inProjects(p);
      if (!writesPerMinute(req.visitor.ip)) throw new LimitError("Too many changes in a short time. Wait a moment.");
      if (mode === "set") await store.set(p, data);
      else await store.update(p, data);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  app.get("/api/collection", async (req, res, next) => {
    try {
      const p = String(req.query.path || "");
      inProjects(p);
      const rows = await store.list(p, { orderBy: req.query.orderBy || null, dir: req.query.dir, limit: req.query.limit });
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
      res.json({ result: await ai.json(req.visitor, prompt, { tier, signal: abortOnClose(req, res) }) });
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/web/search", async (req, res, next) => {
    try {
      res.json({ results: await ai.search(req.visitor, req.body && req.body.q, { signal: abortOnClose(req, res) }) });
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/web/read", async (req, res, next) => {
    try {
      if (!readsPerHour(req.visitor.ip)) throw new LimitError("Too many pages read in the last hour. Try again later.");
      res.json(await readPage(String((req.body && req.body.url) || ""), { fetchImpl: webFetch, lookup }));
    } catch (e) {
      next(e);
    }
  });

  // ── Live sync and presence (Server-Sent Events) ──────────────────────────
  const streams = new Set();
  const rooms = new Map(); // room -> Map(visitor id -> {presence, at})
  const send = (s, obj) => s.res.write(`data: ${JSON.stringify(obj)}\n\n`);

  store.events.on("change", ({ path: p, parent }) => {
    for (const s of streams) send(s, { type: "doc", path: p, parent });
  });

  const validRoom = (room) => /^p-[A-Za-z0-9_-]{1,120}$/.test(String(room || ""));
  function broadcastPeers(room) {
    const members = rooms.get(room) || new Map();
    for (const s of streams) {
      if (!s.rooms.has(room)) continue;
      const peers = [...members.entries()].filter(([id]) => id !== s.visitor.id).map(([, v]) => ({ presence: v.presence }));
      send(s, { type: "peers", room, peers });
    }
  }
  setInterval(() => {
    const now = Date.now();
    for (const [room, members] of rooms) {
      let changed = false;
      for (const [id, v] of members) if (now - v.at > 60000) (members.delete(id), (changed = true));
      if (!members.size) rooms.delete(room);
      if (changed) broadcastPeers(room);
    }
  }, 15000).unref();

  app.get("/api/events", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    const s = { visitor: req.visitor, res, rooms: new Set() };
    streams.add(s);
    res.write(": connected\n\n");
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => {
      clearInterval(ping);
      streams.delete(s);
    });
  });
  app.post("/api/room", (req, res, next) => {
    try {
      const { room, presence, leave } = req.body || {};
      if (!validRoom(room)) throw new DocError("invalid_argument", "bad room");
      const members = rooms.get(room) || new Map();
      if (leave) members.delete(req.visitor.id);
      else {
        // The tool sends a name; without sign-in everyone is "Visitor" with their own colour.
        const pres = { ...(presence || {}), name: req.visitor.name, color: req.visitor.color };
        members.set(req.visitor.id, { presence: pres, at: Date.now() });
        for (const s of streams) if (s.visitor.id === req.visitor.id) s.rooms.add(room);
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
    if (err instanceof LimitError) return res.status(429).json({ error: { code: err.code, message: err.message } });
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

module.exports = { createApp };
