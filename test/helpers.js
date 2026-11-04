/** Test helpers: an in-memory Postgres, a fake Anthropic client, a running app and a small cookie-keeping fetch. */
const { newDb } = require("pg-mem");
const { migrate } = require("../server/db");
const { createApp } = require("../server/app");

async function memoryPool() {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  await migrate(pool);
  return pool;
}

/** A stand-in for the Anthropic SDK client: records requests and returns whatever `reply(req)` gives. */
function fakeAnthropic(reply) {
  const calls = [];
  const create = async (req) => {
    calls.push(req);
    return reply(req);
  };
  return { calls, messages: { create }, beta: { messages: { create } } };
}

const textReply = (text, extra = {}) => ({ model: "fake", stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 5 }, ...extra });

async function startApp(opts = {}) {
  const pool = opts.pool || (await memoryPool());
  const env = { APP_URL: "http://localhost", ANTHROPIC_API_KEY: "test", ...(opts.env || {}) };
  const app = createApp({
    pool,
    env,
    aiClient: opts.aiClient === null ? undefined : opts.aiClient || fakeAnthropic(() => textReply('{"ok":true}')),
    webFetch: opts.webFetch,
    lookup: opts.lookup || (async () => [{ address: "93.184.216.34" }]),
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { app, server, base, pool, env, close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(r))) };
}

/** fetch that keeps the visitor cookie, like a browser. Each call to browser() is a different visitor. */
function browser(base) {
  let cookie = "";
  const go = async (path, init = {}) => {
    const headers = { ...(init.headers || {}) };
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + path, { redirect: "manual", ...init, headers });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0].endsWith("=") ? "" : set.split(";")[0];
    return res;
  };
  go.json = async (method, path, body) => {
    const res = await go(path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* none */
    }
    return { status: res.status, json };
  };
  return go;
}

module.exports = { memoryPool, fakeAnthropic, textReply, startApp, browser };
