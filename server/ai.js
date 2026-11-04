/**
 * The AI behind the tool, on Peak Nine's own Anthropic API key (it used to run on each
 * visitor's own Claude). The tool asks for JSON answers at two levels:
 *   - "default": the thinking work (definitions, formulas, extracting figures)  -> AI_MODEL
 *   - "quick":   short ideas and plans                                          -> AI_MODEL_QUICK
 * Errors come back with the same codes the tool already understands (rate_limited, refused, …).
 * Every call is logged in ai_usage, and each person has a daily cap (AI_DAILY_LIMIT).
 */
const Anthropic = require("@anthropic-ai/sdk");

const DEFAULTS = {
  model: "claude-opus-5-5",
  quick: "claude-haiku-5-5",
};

// Models that take the server-side refusal fallback ("default" routing).
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

class AiError extends Error {
  constructor(code, message, extra = {}) {
    super(message || code);
    this.code = code;
    Object.assign(this, extra);
  }
}

function modelsFrom(env = process.env) {
  return { model: env.AI_MODEL || DEFAULTS.model, quick: env.AI_MODEL_QUICK || DEFAULTS.quick };
}

/** Parse the model's reply as JSON, forgiving code fences and text around it. */
function parseJsonReply(text) {
  const t = String(text || "").trim();
  if (!t) throw new AiError("empty_completion");
  try {
    return JSON.parse(t);
  } catch {
    /* try harder below */
  }
  const unfenced = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(unfenced);
  } catch {
    /* fall through */
  }
  const i = unfenced.search(/[{[]/);
  const j = Math.max(unfenced.lastIndexOf("}"), unfenced.lastIndexOf("]"));
  if (i >= 0 && j > i) {
    try {
      return JSON.parse(unfenced.slice(i, j + 1));
    } catch {
      /* fall through */
    }
  }
  throw new AiError("invalid_json", "The answer was not valid JSON", { text: t.slice(0, 20000) });
}

function requestFor(model, prompt, { quick = false, tools, maxTokens = 16000 } = {}) {
  const req = {
    model,
    max_tokens: maxTokens,
    // Opus 5.5 and Haiku 5.5 default to medium; set it explicitly.
    output_config: { effort: quick ? "low" : "medium" },
    messages: [{ role: "user", content: prompt }],
  };
  if (tools) req.tools = tools;
  if (FALLBACK_MODELS.has(model)) {
    req.betas = ["server-side-fallback-2026-07-01"];
    req.fallbacks = "default";
  }
  return req;
}

/** Map SDK errors to the tool's own error codes. */
function mapError(e) {
  if (e instanceof AiError) return e;
  if (e && e.name === "AbortError") return new AiError("cancelled");
  if (e instanceof Anthropic.RateLimitError) return new AiError("rate_limited");
  if (e instanceof Anthropic.BadRequestError && /too long|too many tokens|prompt is too long/i.test(e.message || "")) {
    return new AiError("prompt_too_large");
  }
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return new AiError("sampling_disabled", "The AI key on the server is missing or not valid.");
  }
  if (e instanceof Anthropic.APIError && e.status >= 500) return new AiError("rate_limited", "The AI service is busy.");
  return new AiError("unavailable", (e && e.message) || "unknown error");
}

function textOf(msg) {
  return (msg.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function createAi({ pool, client, env = process.env }) {
  // Created on first use, so the site still starts (and only the AI says so) when the key is missing.
  let anthropic = client || null;
  const sdk = () => {
    if (!anthropic) {
      if (!env.ANTHROPIC_API_KEY) throw new AiError("sampling_disabled", "ANTHROPIC_API_KEY is not set on the server.");
      anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    }
    return anthropic;
  };
  const models = modelsFrom(env);
  const dailyLimit = Number(env.AI_DAILY_LIMIT || 300);

  async function checkBudget(email) {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const r = await pool.query("SELECT COUNT(*)::int AS n FROM ai_usage WHERE email = $1 AND created_at > $2", [email, since]);
    if ((r.rows[0] && r.rows[0].n) >= dailyLimit) {
      throw new AiError("rate_limited", `Daily AI limit reached (${dailyLimit} requests per person per day).`);
    }
  }

  async function log(email, kind, msg) {
    const u = (msg && msg.usage) || {};
    const searches = (u.server_tool_use && u.server_tool_use.web_search_requests) || 0;
    await pool
      .query("INSERT INTO ai_usage (email, kind, model, input_tokens, output_tokens, searches, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)", [
        email,
        kind,
        (msg && msg.model) || "?",
        (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        u.output_tokens || 0,
        searches,
        Date.now(),
      ])
      .catch((e) => console.warn("[ai] usage log failed:", e.message));
  }

  async function call(req, signal) {
    const opts = signal ? { signal } : undefined;
    const c = sdk();
    return req.betas ? c.beta.messages.create(req, opts) : c.messages.create(req, opts);
  }

  /** The tool's sample.json(prompt, {modelTier}) on the server. */
  async function json(user, prompt, { tier = "default", signal } = {}) {
    if (typeof prompt !== "string" || !prompt.trim()) throw new AiError("empty_completion", "empty prompt");
    if (prompt.length > 200000) throw new AiError("prompt_too_large");
    await checkBudget(user.email);
    const quick = tier === "quick";
    let msg;
    try {
      msg = await call(requestFor(quick ? models.quick : models.model, prompt, { quick }), signal);
    } catch (e) {
      throw mapError(e);
    }
    await log(user.email, quick ? "json-quick" : "json", msg);
    if (msg.stop_reason === "refusal") throw new AiError("refused");
    return parseJsonReply(textOf(msg));
  }

  /** One web search through Anthropic's web search tool; returns the result list. */
  async function search(user, query, { signal } = {}) {
    const q = String(query || "").trim().slice(0, 300);
    if (!q) return [];
    await checkBudget(user.email);
    const req = requestFor(
      models.model,
      `Run exactly one web search for this query, then reply with the single word "done".\n\nQuery: ${q}`,
      { quick: true, maxTokens: 2000, tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 1 }] }
    );
    let msg;
    try {
      msg = await call(req, signal);
    } catch (e) {
      throw mapError(e);
    }
    await log(user.email, "search", msg);
    return searchResults(msg);
  }

  return { json, search, models };
}

/** Pull {title, url, domain, pdf} out of the web search result blocks. */
function searchResults(msg) {
  const out = [];
  for (const b of msg.content || []) {
    if (b.type !== "web_search_tool_result") continue;
    // On error, content is an object ({error_code}); on success, a list.
    if (!Array.isArray(b.content)) {
      const code = b.content && b.content.error_code;
      if (code && !out.length) throw new AiError("tool_error", `web search failed: ${code}`);
      continue;
    }
    for (const r of b.content) {
      if (r.type !== "web_search_result" || !r.url) continue;
      let domain = "";
      try {
        domain = new URL(r.url).hostname.replace(/^www\./i, "");
      } catch {
        continue;
      }
      out.push({ title: r.title || domain, url: r.url, domain, snippet: "", pdf: /\.pdf($|[?#])/i.test(r.url) });
    }
  }
  return out;
}

module.exports = { createAi, parseJsonReply, requestFor, searchResults, mapError, modelsFrom, AiError, FALLBACK_MODELS };
