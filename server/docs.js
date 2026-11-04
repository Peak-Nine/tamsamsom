/**
 * A small document store with the subset of Firestore behaviour the Market Estimator uses
 * (it was written against Claude's shared database):
 *   - documents live at paths like "projects/p1" or "projects/p1/markets/TAM"
 *   - set() replaces a document, update() deep-merges into an existing one (and fails with
 *     code "invalid_argument" when it doesn't exist, so the tool falls back to set())
 *   - a collection lists the documents directly under it, ordered and limited
 * Every write is announced on `events`, which the live-sync stream (SSE) forwards.
 */
const { EventEmitter } = require("events");

const SEGMENT = /^[A-Za-z0-9_-]{1,120}$/;
const MAX_DOC_BYTES = 900 * 1024;

class DocError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

function splitPath(path) {
  const parts = String(path || "").split("/");
  if (!parts.length || parts.some((p) => !SEGMENT.test(p))) throw new DocError("invalid_argument", `bad path: ${path}`);
  return parts;
}

/** "projects/p1/markets/TAM" → its collection "projects/p1/markets". Documents have an even number of segments. */
function docParent(path) {
  const parts = splitPath(path);
  if (parts.length % 2 !== 0) throw new DocError("invalid_argument", `not a document path: ${path}`);
  return parts.slice(0, -1).join("/");
}

function checkCollection(path) {
  const parts = splitPath(path);
  if (parts.length % 2 !== 1) throw new DocError("invalid_argument", `not a collection path: ${path}`);
  return parts;
}

/** The project a path belongs to ("projects/p1/..." → "p1"), or null for anything else. */
function projectOf(path) {
  const parts = String(path || "").split("/");
  return parts[0] === "projects" && parts[1] ? parts[1] : null;
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** The same merge the tool does client-side: objects merge, everything else replaces. */
function deepMerge(base, patch) {
  if (!isObj(base) || !isObj(patch)) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  return out;
}

function checkSize(data) {
  if (!isObj(data)) throw new DocError("invalid_argument", "a document must be an object");
  if (Buffer.byteLength(JSON.stringify(data)) > MAX_DOC_BYTES) throw new DocError("invalid_argument", "document too large");
}

function createDocStore(pool) {
  const events = new EventEmitter();
  events.setMaxListeners(0);

  async function get(path) {
    docParent(path);
    const r = await pool.query("SELECT data FROM docs WHERE path = $1", [path]);
    return r.rows.length ? { exists: true, data: r.rows[0].data } : { exists: false, data: null };
  }

  async function set(path, data) {
    const parent = docParent(path);
    checkSize(data);
    const now = Date.now();
    await pool.query(
      `INSERT INTO docs (path, parent, data, updated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
      [path, parent, JSON.stringify(data), now]
    );
    events.emit("change", { path, parent });
  }

  async function update(path, patch) {
    const parent = docParent(path);
    if (!isObj(patch)) throw new DocError("invalid_argument", "a patch must be an object");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query("SELECT data FROM docs WHERE path = $1 FOR UPDATE", [path]);
      if (!r.rows.length) throw new DocError("invalid_argument", "document does not exist");
      const merged = deepMerge(r.rows[0].data, patch);
      checkSize(merged);
      await client.query("UPDATE docs SET data = $2, updated_at = $3 WHERE path = $1", [path, JSON.stringify(merged), Date.now()]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    events.emit("change", { path, parent });
  }

  /** Documents directly under a collection, ordered by a top-level field. */
  async function list(collection, { orderBy = null, dir = "asc", limit = 100 } = {}) {
    checkCollection(collection);
    const r = await pool.query("SELECT path, data FROM docs WHERE parent = $1", [collection]);
    let rows = r.rows.map((x) => ({ id: x.path.split("/").pop(), path: x.path, data: x.data }));
    if (orderBy) {
      const key = (d) => (d.data && d.data[orderBy] !== undefined ? d.data[orderBy] : null);
      rows.sort((a, b) => {
        const x = key(a);
        const y = key(b);
        if (x === y) return 0;
        if (x === null) return 1;
        if (y === null) return -1;
        return (x < y ? -1 : 1) * (dir === "desc" ? -1 : 1);
      });
    }
    return rows.slice(0, Math.max(1, Math.min(500, Number(limit) || 100)));
  }

  return { get, set, update, list, events };
}

module.exports = { createDocStore, deepMerge, docParent, projectOf, DocError };
