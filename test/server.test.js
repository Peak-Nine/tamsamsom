const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp, browser, signIn, fakeAnthropic, textReply } = require("./helpers");

test("sign-in by email link, sessions and sign-out", async (t) => {
  const app = await startApp();
  t.after(app.close);
  const go = browser(app.base);

  // Not signed in: the tool redirects to /login, the API says 401.
  assert.equal((await go("/")).headers.get("location"), "/login");
  assert.equal((await go.json("GET", "/api/me")).status, 401);
  assert.equal((await go("/login")).status, 200);

  // An address that isn't allowed gets the same answer, but no mail.
  assert.deepEqual((await go.json("POST", "/auth/request", { email: "stranger@gmail.com" })).json, { ok: true });
  assert.equal(app.mails.length, 0);

  // The link opens a page with a button; only the POST signs in.
  await go.json("POST", "/auth/request", { email: "Niels@peaknine.studio" });
  const link = app.mails[0].link;
  assert.match(link, /^http:\/\/localhost\/auth\/verify\?token=/);
  const token = new URL(link).searchParams.get("token");
  const pageRes = await go(`/auth/verify?token=${token}`);
  const pageHtml = await pageRes.text();
  assert.match(pageHtml, new RegExp(`value="${token}"`));
  // "no-referrer" would make browsers send Origin: null on the form post, which the server refuses.
  assert.match(pageHtml, /<meta name="referrer" content="same-origin">/);
  assert.equal((await go.json("GET", "/api/me")).status, 401);

  const post = () => go("/auth/verify", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "token=" + token });
  const first = await post();
  assert.equal(first.status, 303);
  assert.equal(first.headers.get("location"), "/");
  assert.match(first.headers.get("set-cookie"), /tss_session=.+; Path=\/; HttpOnly; SameSite=Lax/);
  // A link works once.
  const again = await browser(app.base)("/auth/verify", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "token=" + token });
  assert.equal(again.headers.get("location"), "/login?expired=1");

  const me = await go.json("GET", "/api/me");
  assert.equal(me.status, 200);
  assert.deepEqual({ id: me.json.id, name: me.json.name, role: me.json.role }, { id: "niels@peaknine.studio", name: "Niels", role: "team" });

  const page = await go("/");
  const html = await page.text();
  assert.match(html, /\/assets\/runtime\.js/);

  await go("/auth/logout", { method: "POST" });
  assert.equal((await go.json("GET", "/api/me")).status, 401);
});

test("too many link requests are slowed down", async (t) => {
  const app = await startApp();
  t.after(app.close);
  const go = browser(app.base);
  for (let i = 0; i < 5; i++) assert.equal((await go.json("POST", "/auth/request", { email: "niels@peaknine.studio" })).status, 200);
  const r = await go.json("POST", "/auth/request", { email: "niels@peaknine.studio" });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Too many/);
});

test("documents: set, merge-update, list in order, and the update-then-set fallback", async (t) => {
  const app = await startApp();
  t.after(app.close);
  const go = await signIn(app, browser(app.base), "niels@peaknine.studio");

  assert.equal((await go.json("PUT", "/api/doc", { path: "projects/p1", data: { id: "p1", name: "Bikes", updatedAt: 1 }, mode: "set" })).status, 200);
  await go.json("PUT", "/api/doc", { path: "projects/p2", data: { id: "p2", name: "Food", updatedAt: 5 }, mode: "set" });
  await go.json("PUT", "/api/doc", { path: "projects/p1", data: { summary: { defs: 2 } }, mode: "update" });

  const doc = await go.json("GET", "/api/doc?path=projects/p1");
  assert.deepEqual(doc.json, { exists: true, data: { id: "p1", name: "Bikes", updatedAt: 1, summary: { defs: 2 } } });
  assert.deepEqual((await go.json("GET", "/api/doc?path=projects/nope")).json, { exists: false, data: null });

  // update() on a missing document fails with invalid_argument, so the tool falls back to set().
  const miss = await go.json("PUT", "/api/doc", { path: "projects/p1/parts/intro", data: { a: 1 }, mode: "update" });
  assert.equal(miss.status, 400);
  assert.equal(miss.json.error.code, "invalid_argument");

  const list = await go.json("GET", "/api/collection?path=projects&orderBy=updatedAt&dir=desc&limit=100");
  assert.deepEqual(list.json.docs.map((d) => d.id), ["p2", "p1"]);

  // Paths outside the projects tree, or malformed ones, are refused.
  assert.equal((await go.json("PUT", "/api/doc", { path: "users/x", data: {}, mode: "set" })).status, 403);
  assert.equal((await go.json("GET", "/api/doc?path=projects/../x")).status, 400);
});

test("a client (guest) only sees and changes their own projects", async (t) => {
  const app = await startApp();
  t.after(app.close);
  const team = await signIn(app, browser(app.base), "jonas@peaknine.studio");
  const guest = await signIn(app, browser(app.base), "client@acme.org");
  const other = await signIn(app, browser(app.base), "other@client.org");

  await team.json("PUT", "/api/doc", { path: "projects/team1", data: { id: "team1", name: "Internal", updatedAt: 1 }, mode: "set" });

  // The guest creates a project; createdBy and members are set by the server, not the browser.
  await guest.json("PUT", "/api/doc", { path: "projects/g1", data: { id: "g1", name: "Acme", updatedAt: 2, createdBy: "someone@else", members: ["x@y.z"] }, mode: "set" });
  const g1 = await team.json("GET", "/api/doc?path=projects/g1");
  assert.equal(g1.json.data.createdBy, "client@acme.org");
  assert.deepEqual(g1.json.data.members, []);
  await guest.json("PUT", "/api/doc", { path: "projects/g1/parts/intro", data: { answers: { problem: "x" } }, mode: "set" });

  // The guest's list only holds their own project; the team sees both.
  assert.deepEqual((await guest.json("GET", "/api/collection?path=projects")).json.docs.map((d) => d.id), ["g1"]);
  assert.deepEqual((await team.json("GET", "/api/collection?path=projects&orderBy=updatedAt&dir=desc")).json.docs.map((d) => d.id), ["g1", "team1"]);

  // No reading or writing someone else's project, and no handing yourself access.
  assert.equal((await guest.json("GET", "/api/doc?path=projects/team1")).status, 403);
  assert.equal((await guest.json("PUT", "/api/doc", { path: "projects/team1/parts/intro", data: { a: 1 }, mode: "set" })).status, 403);
  assert.equal((await other.json("GET", "/api/doc?path=projects/g1/parts/intro")).status, 403);
  await guest.json("PUT", "/api/doc", { path: "projects/g1", data: { members: ["other@client.org"], name: "Acme 2" }, mode: "update" });
  const after = (await team.json("GET", "/api/doc?path=projects/g1")).json.data;
  assert.equal(after.name, "Acme 2");
  assert.deepEqual(after.members, []);

  // The team adds the other client as a member; now they can read it.
  await team.json("PUT", "/api/doc", { path: "projects/g1", data: { members: ["other@client.org"] }, mode: "update" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await other.json("GET", "/api/doc?path=projects/g1/parts/intro")).status, 200);
});

test("live sync: changes stream to people who may see them", async (t) => {
  const app = await startApp();
  t.after(app.close);
  const team = await signIn(app, browser(app.base), "niels@peaknine.studio");
  const guest = await signIn(app, browser(app.base), "client@acme.org");

  const listen = async (go) => {
    const res = await go("/api/events");
    const reader = res.body.getReader();
    const events = [];
    (async () => {
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true }));
        if (done) return;
        buf += dec.decode(value);
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (chunk.startsWith("data: ")) events.push(JSON.parse(chunk.slice(6)));
        }
      }
    })();
    return { events, stop: () => reader.cancel().catch(() => {}) };
  };
  const teamStream = await listen(team);
  const guestStream = await listen(guest);
  t.after(() => (teamStream.stop(), guestStream.stop()));

  await team.json("PUT", "/api/doc", { path: "projects/p9", data: { id: "p9", updatedAt: 1 }, mode: "set" });
  await team.json("PUT", "/api/doc", { path: "projects/p9/markets/TAM", data: { a: 1 }, mode: "set" });
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(teamStream.events.filter((e) => e.type === "doc").map((e) => e.path), ["projects/p9", "projects/p9/markets/TAM"]);
  assert.equal(teamStream.events[1].parent, "projects/p9/markets");
  assert.deepEqual(guestStream.events.filter((e) => e.type === "doc"), []);

  // Presence: the guest can't join a project room they can't see; the team can.
  assert.equal((await guest.json("POST", "/api/room", { room: "p-p9", presence: { name: "x" } })).status, 403);
  assert.equal((await team.json("POST", "/api/room", { room: "p-p9", presence: { view: "compute" } })).status, 200);
});

test("AI: models per level, refusals, broken JSON and the daily limit", async (t) => {
  let next = () => textReply('{"ideas":["a","b"]}');
  const client = fakeAnthropic((req) => next(req));
  const app = await startApp({ aiClient: client, env: { AI_DAILY_LIMIT: "3" } });
  t.after(app.close);
  const go = await signIn(app, browser(app.base), "niels@peaknine.studio");

  const r1 = await go.json("POST", "/api/ai/json", { prompt: "Give ideas. Reply with JSON only.", tier: "default" });
  assert.deepEqual(r1.json, { result: { ideas: ["a", "b"] } });
  assert.equal(client.calls[0].model, "claude-opus-5-5");
  assert.equal(client.calls[0].fallbacks, "default");
  assert.equal(client.calls[0].messages[0].content, "Give ideas. Reply with JSON only.");

  await go.json("POST", "/api/ai/json", { prompt: "Quick one", tier: "quick" });
  assert.equal(client.calls[1].model, "claude-haiku-5-5");
  assert.equal(client.calls[1].output_config.effort, "low");

  next = () => textReply("Sorry, that is not JSON");
  const bad = await go.json("POST", "/api/ai/json", { prompt: "x" });
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error.code, "invalid_json");
  assert.equal(bad.json.error.text, "Sorry, that is not JSON");

  next = () => textReply("{}");
  const limited = await go.json("POST", "/api/ai/json", { prompt: "x" });
  assert.equal(limited.json.error.code, "rate_limited");
  assert.match(limited.json.error.message, /Daily AI limit/);

  const usage = await app.pool.query("SELECT kind, email FROM ai_usage ORDER BY id");
  assert.deepEqual(usage.rows.map((r) => r.kind), ["json", "json-quick", "json"]);
});

test("AI: a refused request comes back as 'refused'", async (t) => {
  const client = fakeAnthropic(() => ({ model: "fake", stop_reason: "refusal", content: [], usage: {} }));
  const app = await startApp({ aiClient: client });
  t.after(app.close);
  const go = await signIn(app, browser(app.base), "niels@peaknine.studio");
  const r = await go.json("POST", "/api/ai/json", { prompt: "x" });
  assert.equal(r.json.error.code, "refused");
});

test("web research: search through Anthropic, read pages on the server", async (t) => {
  const client = fakeAnthropic((req) => {
    assert.deepEqual(req.tools, [{ type: "web_search_20260209", name: "web_search", max_uses: 1 }]);
    return {
      model: "fake",
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 3, server_tool_use: { web_search_requests: 1 } },
      content: [
        { type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://cbs.example.nl/bikes", title: "Bikes in NL", encrypted_content: "x", page_age: null }] },
        { type: "text", text: "done" },
      ],
    };
  });
  const pages = {
    "https://cbs.example.nl/bikes": () => new Response("<title>Bikes in NL</title><p>There are 23 million bikes in the Netherlands.</p>", { headers: { "content-type": "text/html" } }),
    "https://moved.example.org/": () => new Response("", { status: 301, headers: { location: "http://10.0.0.1/admin" } }),
  };
  const webFetch = async (url) => (pages[url] ? pages[url]() : new Response("nope", { status: 404, headers: { "content-type": "text/html" } }));
  const lookup = async (host) => [{ address: host === "10.0.0.1" ? "10.0.0.1" : "93.184.216.34" }];
  const app = await startApp({ aiClient: client, webFetch, lookup });
  t.after(app.close);
  const go = await signIn(app, browser(app.base), "sankhya@peaknine.studio");

  const s = await go.json("POST", "/api/web/search", { q: "number of bikes Netherlands" });
  assert.deepEqual(s.json.results, [{ title: "Bikes in NL", url: "https://cbs.example.nl/bikes", domain: "cbs.example.nl", snippet: "", pdf: false }]);
  assert.match(client.calls[0].messages[0].content, /Query: number of bikes Netherlands/);
  const usage = await app.pool.query("SELECT searches FROM ai_usage");
  assert.equal(usage.rows[0].searches, 1);

  const page = await go.json("POST", "/api/web/read", { url: "https://cbs.example.nl/bikes" });
  assert.deepEqual(page.json, { title: "Bikes in NL", text: "There are 23 million bikes in the Netherlands." });

  // A redirect to an internal address is refused, as is a direct one.
  assert.equal((await go.json("POST", "/api/web/read", { url: "https://moved.example.org/" })).json.error.code, "tool_error");
  assert.match((await go.json("POST", "/api/web/read", { url: "http://127.0.0.1:80/" })).json.error.message, /not reachable/);
  assert.equal((await go.json("POST", "/api/web/read", { url: "https://cbs.example.nl/missing" })).json.error.code, "bad_page");
});

test("requests from another site are refused", async (t) => {
  const app = await startApp();
  t.after(app.close);
  const go = await signIn(app, browser(app.base), "niels@peaknine.studio");
  const r = await go("/api/doc", { method: "PUT", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ path: "projects/x", data: {}, mode: "set" }) });
  assert.equal(r.status, 403);
});

test("without an API key the site works and the AI says it isn't set up", async (t) => {
  const { createApp } = require("../server/app");
  const { memoryPool } = require("./helpers");
  const pool = await memoryPool();
  const mails = [];
  const app = createApp({ pool, env: { APP_URL: "http://localhost", ALLOWED_DOMAINS: "peaknine.studio" }, mailer: { send: async (m) => mails.push(m) } });
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  t.after(() => new Promise((r) => (server.closeAllConnections(), server.close(r))));
  const go = await signIn({ mails }, browser(`http://127.0.0.1:${server.address().port}`), "niels@peaknine.studio");
  const r = await go.json("POST", "/api/ai/json", { prompt: "x" });
  assert.equal(r.json.error.code, "sampling_disabled");
  assert.equal((await go.json("GET", "/api/me")).status, 200);
});
