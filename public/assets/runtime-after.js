/**
 * Runs right AFTER the tool's script. The tool's web research drove the Claude desktop app's
 * browser; here its two steps go to our server instead:
 *   Web.search(q)  -> /api/web/search (Anthropic web search)
 *   Web.read(url)  -> /api/web/read   (the server reads the page)
 * The tool's own checks on a page (blocked pages, too little text) stay as they were.
 * Also adds a small "Sign out" button.
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

  const form = document.createElement("form");
  form.method = "post";
  form.action = "/auth/logout";
  form.className = "me-signout";
  form.innerHTML = '<button type="submit" title="Sign out">Sign out</button>';
  const style = document.createElement("style");
  style.textContent =
    ".me-signout{position:fixed;right:14px;bottom:12px;z-index:50}" +
    ".me-signout button{font:inherit;font-size:12px;padding:5px 10px;border-radius:999px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;opacity:.65;cursor:pointer}" +
    ".me-signout button:hover{opacity:1}" +
    "@media print{.me-signout{display:none}}";
  document.head.appendChild(style);
  document.body.appendChild(form);
})();
