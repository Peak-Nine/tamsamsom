/**
 * Who may read or write which document.
 *   - team (ALLOWED_DOMAINS): everything.
 *   - guest (ALLOWED_EMAILS, e.g. a client): only projects they created, or where their email is
 *     in the project's `members` list. Guests can't change `createdBy` or `members`.
 * Only the "projects" tree exists; any other top-level path is refused.
 */
const { projectOf, DocError } = require("./docs");

function createAccess(store) {
  // Project docs are read on every guest request; a short cache keeps that cheap.
  const cache = new Map();
  const TTL = 5000;
  store.events.on("change", ({ path }) => {
    const pid = projectOf(path);
    if (pid) cache.delete(pid);
  });

  async function projectDoc(pid) {
    const hit = cache.get(pid);
    if (hit && Date.now() - hit.at < TTL) return hit.doc;
    const r = await store.get(`projects/${pid}`);
    const doc = r.exists ? r.data : null;
    cache.set(pid, { at: Date.now(), doc });
    if (cache.size > 5000) cache.clear();
    return doc;
  }

  const ownsProject = (user, doc) =>
    !!doc && (doc.createdBy === user.email || (Array.isArray(doc.members) && doc.members.map((m) => String(m).toLowerCase()).includes(user.email)));

  async function canRead(user, path) {
    if (!String(path).startsWith("projects")) return false;
    if (user.role === "team") return true;
    const pid = projectOf(path);
    if (!pid) return path === "projects"; // the list itself; filtered per document
    return ownsProject(user, await projectDoc(pid));
  }

  /** Throws when the user may not write; returns the (possibly cleaned) data to write. */
  async function checkWrite(user, path, data, isCreate) {
    if (!String(path).startsWith("projects/")) throw new DocError("not_granted", "not allowed");
    if (user.role === "team") return data;
    const pid = projectOf(path);
    const doc = await projectDoc(pid);
    const isProjectDoc = path === `projects/${pid}`;
    if (!doc) {
      // A guest may only create a new project of their own.
      if (isProjectDoc && isCreate) return { ...data, createdBy: user.email, members: [] };
      throw new DocError("not_granted", "not allowed");
    }
    if (!ownsProject(user, doc)) throw new DocError("not_granted", "not allowed");
    if (isProjectDoc) {
      const { createdBy, members, ...rest } = data || {};
      if (isCreate) return { ...rest, createdBy: doc.createdBy, members: doc.members || [] };
      return rest;
    }
    return data;
  }

  async function filterProjects(user, rows) {
    if (user.role === "team") return rows;
    return rows.filter((r) => ownsProject(user, r.data));
  }

  return { canRead, checkWrite, filterProjects };
}

module.exports = { createAccess };
