# Market Estimator (tamsamsom.peaknine.studio)

Peak Nine's TAM/SAM/SOM tool, hosted on Render. The tool itself (`tool/market-estimator.html`)
was built as a Claude artifact; this repo runs it as a normal website, with our own server for
the parts that used to come from Claude:

| On claude.ai | Here |
|---|---|
| Shared project database | Postgres on Render, live updates over Server-Sent Events |
| The visitor's own Claude | Peak Nine's Anthropic API key, on the server |
| Web research through the Claude desktop app | Anthropic's web search tool + the server reads the pages |
| Claude download | A normal browser download (Excel and PDF) |
| Claude login | Sign-in by email link, for an allow list |
| (new) | "Download a PDF report" on the Summary page |

## How it fits together

- `tool/market-estimator.html` is the original tool, unchanged. `npm run build` writes `public/app.html`
  from it with a few named edits (`scripts/build.js`). If a new version of the tool no longer fits an
  edit, the build stops and names it.
- `public/assets/runtime.js` gives the tool the same `window.claude.use(...)` features it was written
  for (db, sample, mcp, downloads, user, room), backed by `/api/*`.
- `public/assets/runtime-after.js` sends web research to the server and adds "Sign out".
- `public/assets/report.js` builds the PDF report in the browser (jsPDF, served from this site).
- `server/` is an Express app: `auth.js` (email links, sessions), `access.js` (who sees which project),
  `docs.js` (document store), `ai.js` (Anthropic), `web.js` (reading pages safely), `app.js` (routes).

**Who sees what:** everyone on `ALLOWED_DOMAINS` (the team) sees every project. Addresses on
`ALLOWED_EMAILS` (clients) see only the projects they created, or where their email is in the
project's `members` list. Clients can't change `createdBy` or `members`.

**AI models:** the tool asks for two levels. "default" (definitions, formulas, extracting figures)
uses `AI_MODEL` (default `claude-opus-5-5`); "quick" (short ideas and plans) uses `AI_MODEL_QUICK`
(default `claude-haiku-5-5`). Web searches run on `AI_MODEL`. Every call is logged in the `ai_usage`
table, and each person has a daily cap (`AI_DAILY_LIMIT`, default 300 requests per 24 hours).

## Settings (environment variables on Render)

| Variable | What | Example |
|---|---|---|
| `DATABASE_URL` | Postgres connection (Render fills it in when you link the database) | |
| `ANTHROPIC_API_KEY` | API key from console.anthropic.com | `sk-ant-…` |
| `APP_URL` | The public address, used in sign-in links and the cross-site check | `https://tamsamsom.peaknine.studio` |
| `ALLOWED_DOMAINS` | Domains whose addresses are team members | `peaknine.studio` |
| `ALLOWED_EMAILS` | Single client addresses, comma separated | `ann@client.org, bob@ngo.org` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Mail server for the sign-in links | |
| `MAIL_FROM` | Sender of the sign-in email | `Peak Nine <tools@peaknine.studio>` |
| `AI_MODEL`, `AI_MODEL_QUICK`, `AI_DAILY_LIMIT` | Optional, see above | |
| `NODE_ENV` | `production` | |

## Deploy on Render

1. **Postgres:** New → Postgres. Name `tamsamsom-db`, same region as the web service. Pick a paid plan
   if you want it to last (check Render's pricing page for what the free plan keeps and for how long).
2. **Web service:** New → Web Service → connect `Peak-Nine/tamsamsom`.
   - Runtime: Node. Build command: `npm ci && npm run build`. Start command: `npm start`.
   - Health check path: `/healthz`. Pick an instance that doesn't sleep.
   - Environment: add the variables above. For `DATABASE_URL`, use the database's *Internal* connection string.
3. **Domain:** Settings → Custom Domains → add `tamsamsom.peaknine.studio`. Render shows a target; add a
   `CNAME` record `tamsamsom` → that target where peaknine.studio's DNS is managed. Render then issues HTTPS.
4. Open the site, sign in with your email, create a project.

## Run it locally

```bash
npm ci
npm run build
node scripts/dev.js        # in-memory database; sign-in links print in the terminal
npm test                   # 19 tests, no network or API key needed
```
