/**
 * Stands in for the Claude runtime the Market Estimator was written for (window.claude.use),
 * backed by our own server. It offers the same features under the same names, so the tool's
 * code stays as it was:
 *   db         shared projects in Postgres, with live updates over Server-Sent Events
 *   sample     AI answers (JSON) on Peak Nine's API key
 *   mcp        reports that "web research" is available (the calls are wired in runtime-after.js)
 *   downloads  a normal browser download
 *   user       the visitor (anonymous; the site has no sign-in)
 *   room       who else is in the project
 * Load this BEFORE the tool's own script.
 */
(function () {
  "use strict";

  async function api(method, url, body, signal) {
    let res;
    try {
      res = await fetch(url, {
        method,
        credentials: "same-origin",
        headers: body ? { "content-type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (e) {
      if (e && e.name === "AbortError") throw { code: "cancelled", message: "Stopped." };
      throw { code: "unavailable", message: "No connection to the server." };
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* empty body */
    }
    if (!res.ok) {
      const e = (json && json.error) || { code: "unavailable", message: `HTTP ${res.status}` };
      throw Object.assign(new Error(e.message || e.code), e);
    }
    return json;
  }

  // ── Live events: one stream for document changes and presence ───────────────
  const listeners = new Set();
  let stream = null;
  function connect() {
    stream = new EventSource("/api/events");
    let opened = false;
    stream.onopen = () => {
      // After a reconnect, changes may have been missed: everyone reloads once.
      if (opened) listeners.forEach((f) => safe(f, { type: "reconnect" }));
      opened = true;
    };
    stream.onmessage = (m) => {
      let ev;
      try {
        ev = JSON.parse(m.data);
      } catch {
        return;
      }
      listeners.forEach((f) => safe(f, ev));
    };
  }
  const safe = (f, ev) => {
    try {
      f(ev);
    } catch (e) {
      console.warn(e);
    }
  };
  connect();

  // ── db: the Firestore-like subset the tool uses ─────────────────────────────
  const copy = (v) => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));

  function docSnapshot(path, r) {
    return {
      id: path.split("/").pop(),
      exists: !!r.exists,
      metadata: { fromCache: false },
      data: () => (r.exists ? copy(r.data) : undefined),
    };
  }

  /** Re-run `load` when an event matches; coalesces bursts into one reload. */
  function subscribe(matches, load) {
    let timer = null;
    const f = (ev) => {
      if (ev.type === "reconnect" || (ev.type === "doc" && matches(ev))) {
        clearTimeout(timer);
        timer = setTimeout(load, 120);
      }
    };
    listeners.add(f);
    return () => {
      clearTimeout(timer);
      listeners.delete(f);
    };
  }

  function docRef(path) {
    const ref = {
      id: path.split("/").pop(),
      path,
      async get() {
        return docSnapshot(path, await api("GET", "/api/doc?path=" + encodeURIComponent(path)));
      },
      async set(data) {
        await api("PUT", "/api/doc", { path, data, mode: "set" });
      },
      async update(patch) {
        await api("PUT", "/api/doc", { path, data: patch, mode: "update" });
      },
      onSnapshot(onNext, onError) {
        let alive = true;
        const load = () =>
          ref.get().then(
            (s) => alive && onNext(s),
            (e) => alive && onError && onError(e)
          );
        load();
        const off = subscribe((ev) => ev.path === path, load);
        return () => {
          alive = false;
          off();
        };
      },
    };
    return ref;
  }

  function query(path, opts) {
    const q = {
      orderBy: (field, dir) => query(path, { ...opts, orderBy: field, dir: dir || "asc" }),
      limit: (n) => query(path, { ...opts, limit: n }),
      doc: (id) => docRef(path + "/" + id),
      async get() {
        const p = new URLSearchParams({ path });
        if (opts.orderBy) {
          p.set("orderBy", opts.orderBy);
          p.set("dir", opts.dir || "asc");
        }
        if (opts.limit) p.set("limit", String(opts.limit));
        const r = await api("GET", "/api/collection?" + p.toString());
        const docs = (r.docs || []).map((d) => ({ id: d.id, exists: true, data: () => copy(d.data) }));
        return { docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false } };
      },
      onSnapshot(onNext, onError) {
        let alive = true;
        const load = () =>
          q.get().then(
            (s) => alive && onNext(s),
            (e) => alive && onError && onError(e)
          );
        load();
        const off = subscribe((ev) => ev.parent === path, load);
        return () => {
          alive = false;
          off();
        };
      },
    };
    return q;
  }

  const db = { collection: (p) => query(p, {}), doc: (p) => docRef(p) };

  // ── sample: AI answers ──────────────────────────────────────────────────────
  const sample = {
    async json(prompt, opts) {
      const o = opts || {};
      const r = await api("POST", "/api/ai/json", { prompt, tier: o.modelTier || "default" }, o.signal);
      return r.result;
    },
  };

  // ── mcp: tells the tool web research is available (see runtime-after.js) ───
  const BROWSER = "host:claude_browser";
  const mcp = {
    async listTools() {
      return { servers: [{ server: BROWSER, tools: [{ name: "preview_start" }, { name: "navigate" }, { name: "get_page_text" }] }] };
    },
    async callTool() {
      throw { code: "tool_error", message: "not used on this site" };
    },
  };

  // ── downloads: a plain browser download ─────────────────────────────────────
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename || "download";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    },
  };

  // ── user ────────────────────────────────────────────────────────────────────
  let mePromise = null;
  const user = { me: () => (mePromise = mePromise || api("GET", "/api/me")) };

  // ── room: who else is here ──────────────────────────────────────────────────
  const room = {
    async join(name) {
      let presence = {};
      let gone = false;
      const callbacks = new Set();
      const send = () => (gone ? Promise.resolve() : api("POST", "/api/room", { room: name, presence }).catch(() => {}));
      const f = (ev) => {
        if (ev.type === "peers" && ev.room === name) callbacks.forEach((cb) => safe(cb, { peers: ev.peers || [] }));
        if (ev.type === "reconnect") send();
      };
      listeners.add(f);
      const beat = setInterval(send, 20000);
      return {
        onPeers(cb) {
          callbacks.add(cb);
          return () => callbacks.delete(cb);
        },
        presence(p) {
          presence = p || {};
          return send();
        },
        leave() {
          gone = true;
          clearInterval(beat);
          listeners.delete(f);
          return api("POST", "/api/room", { room: name, leave: true }).catch(() => {});
        },
      };
    },
  };

  const caps = { db, sample, mcp, downloads, user, room };
  window.claude = {
    use(name) {
      return caps[name] ? Promise.resolve(caps[name]) : Promise.reject({ code: "not_in_manifest" });
    },
  };
  window.ME_API = api;
})();
