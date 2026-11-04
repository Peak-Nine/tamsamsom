const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { deepMerge, docParent, projectOf } = require("../server/docs");
const { parseCookies, colorFor, limiter } = require("../server/visitor");
const { parseJsonReply, requestFor, searchResults } = require("../server/ai");
const { htmlToText, isPrivateIp, checkUrl } = require("../server/web");
const { applyEdits, toolFile, EDITS } = require("../scripts/build");

test("deepMerge merges objects and replaces everything else, like the tool", () => {
  assert.deepEqual(deepMerge({ a: { b: 1, c: 2 }, d: [1, 2] }, { a: { c: 3 }, d: [9] }), { a: { b: 1, c: 3 }, d: [9] });
  assert.deepEqual(deepMerge({ a: 1 }, { a: null }), { a: null });
});

test("paths: documents vs collections, and the project they belong to", () => {
  assert.equal(docParent("projects/p1"), "projects");
  assert.equal(docParent("projects/p1/markets/TAM"), "projects/p1/markets");
  assert.throws(() => docParent("projects"), /not a document/);
  assert.throws(() => docParent("projects/../x"), /bad path/);
  assert.equal(projectOf("projects/p1/parts/intro"), "p1");
  assert.equal(projectOf("users/x"), null);
});

test("visitor helpers: cookies, a stable colour, and the limiter", () => {
  assert.deepEqual(parseCookies("a=1; tss_visitor=abc%3D"), { a: "1", tss_visitor: "abc=" });
  assert.equal(colorFor("v1"), colorFor("v1"));
  const ok = limiter(2, 60000);
  assert.deepEqual([ok("ip"), ok("ip"), ok("ip"), ok("other")], [true, true, false, true]);
});

test("AI replies are parsed even with fences or text around them", () => {
  assert.deepEqual(parseJsonReply('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonReply('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonReply('Here you go: [1,2] done'), [1, 2]);
  assert.throws(() => parseJsonReply(""), (e) => e.code === "empty_completion");
  assert.throws(() => parseJsonReply("no json here"), (e) => e.code === "invalid_json" && e.text === "no json here");
});

test("model requests: effort is explicit, fallbacks only where the model takes them", () => {
  const opus = requestFor("claude-opus-5-5", "hi");
  assert.equal(opus.output_config.effort, "medium");
  assert.equal(opus.fallbacks, "default");
  assert.deepEqual(opus.betas, ["server-side-fallback-2026-07-01"]);
  const haiku = requestFor("claude-haiku-5-5", "hi", { quick: true });
  assert.equal(haiku.output_config.effort, "low");
  assert.equal(haiku.fallbacks, undefined);
  assert.equal(haiku.betas, undefined);
  assert.equal("temperature" in opus, false);
});

test("web search results are read from the tool result blocks", () => {
  const msg = {
    content: [
      { type: "server_tool_use", name: "web_search" },
      {
        type: "web_search_tool_result",
        content: [
          { type: "web_search_result", url: "https://www.example.org/report.pdf", title: "A report", encrypted_content: "x", page_age: null },
          { type: "web_search_result", url: "https://stats.example.com/a", title: "Stats", encrypted_content: "x", page_age: null },
        ],
      },
      { type: "text", text: "done" },
    ],
  };
  assert.deepEqual(searchResults(msg), [
    { title: "A report", url: "https://www.example.org/report.pdf", domain: "example.org", snippet: "", pdf: true },
    { title: "Stats", url: "https://stats.example.com/a", domain: "stats.example.com", snippet: "", pdf: false },
  ]);
  assert.throws(() => searchResults({ content: [{ type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "unavailable" } }] }), /unavailable/);
});

test("HTML becomes readable text without scripts or navigation", () => {
  const { title, text } = htmlToText(
    "<html><head><title>Market &amp; size</title><style>p{}</style></head><body><nav>Menu</nav><h1>Bikes</h1><p>Delft has 1&nbsp;200 bikes.<br>More&#8230;</p><script>x()</script><footer>©</footer></body></html>"
  );
  assert.equal(title, "Market & size");
  assert.equal(text, "Bikes\nDelft has 1 200 bikes.\nMore…");
  assert.equal(htmlToText("<title>T</title><p>Body</p>").text, "Body");
});

test("the server never reads internal addresses", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "::ffff:127.0.0.1"]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  assert.equal(isPrivateIp("93.184.216.34"), false);
  const lookupPrivate = async () => [{ address: "10.0.0.5" }];
  await assert.rejects(checkUrl("http://intranet.example/", lookupPrivate), /not reachable/);
  await assert.rejects(checkUrl("http://169.254.169.254/latest/meta-data"), /not reachable/);
  await assert.rejects(checkUrl("file:///etc/passwd"), /only http/);
  await assert.rejects(checkUrl("http://example.com:8080/"), /port/);
  await assert.rejects(checkUrl("http://user:pw@example.com/"), /login/);
});

for (const version of ["v1", "v2"]) {
  test(`the build edits fit tool ${version} exactly once, and stop loudly when they don't`, () => {
    const src = fs.readFileSync(toolFile(version), "utf8");
    const out = applyEdits(src, version);
    assert.match(out, /<script src="\/assets\/runtime.js"><\/script>\n<script src="\/assets\/vendor\/jszip.min.js">/);
    assert.doesNotMatch(out, /cdnjs\.cloudflare\.com/);
    assert.match(out, /data-act="exportpdf"/);
    assert.match(out, /case 'exportpdf'/);
    assert.doesNotMatch(out, /Open the tool on claude\.ai or in the Claude app/);
    assert.ok(out.indexOf("/assets/runtime-after.js") > out.lastIndexOf("init();"));
    // The PDF card sits in the right-hand column, before the block-by-block section.
    assert.ok(out.indexOf('data-act="exportpdf"') < out.indexOf("The computation, block by block"));
    assert.throws(() => applyEdits(src.replace("    case 'exportfresh': exportFresh(); break;", ""), version), /PDF button action/);
    assert.equal(EDITS.length, 11);
    if (version === "v2") {
      // The Circucare demo is built into v2; on the shared list its button must stay visible.
      assert.match(out, /data-act="loaddemo"/);
      assert.match(out, /const hasDemo = \(\) => false;/);
      assert.match(out, /window\.ME_DEMO/);
    }
  });
}

test("TOOL_VERSION picks the tool file; unknown versions stop the build", () => {
  assert.match(toolFile(undefined), /tool\/market-estimator\.html$/);
  assert.match(toolFile("V2"), /tool\/market-estimator-v2\.html$/);
  assert.throws(() => toolFile("v3"), /Unknown TOOL_VERSION "v3"/);
});
