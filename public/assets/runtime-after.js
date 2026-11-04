/**
 * Runs right AFTER the tool's script. The tool's web research drove the Claude desktop app's
 * browser; here its two steps go to our server instead:
 *   Web.search(q)  -> /api/web/search (Anthropic web search)
 *   Web.read(url)  -> /api/web/read   (the server reads the page)
 * The tool's own checks on a page (blocked pages, too little text) stay as they were.
 */
/* global Web, BAD_PAGE, excerptFrom */
(function () {
  "use strict";
  const api = window.ME_API;

  if (typeof Web === "object" && Web) {
    Web.search = async (q) => (await api("POST", "/api/web/search", { q })).results || [];
    Web.read = async (url) => {
      const p = await api("POST", "/api/web/read", { url });
      const title = String(p.title || "");
      const body = String(p.text || "");
      if (BAD_PAGE.test(title) || BAD_PAGE.test(body.slice(0, 400))) throw { code: "bad_page", message: "page blocked or unavailable" };
      const ex = excerptFrom(body, 3500);
      if (ex.length < 200) throw { code: "thin_page", message: "too little readable text" };
      return { title: title.trim(), excerpt: ex };
    };
  }
})();
