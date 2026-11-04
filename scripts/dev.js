/**
 * Local preview without Postgres or email: an in-memory database (gone when you stop it) and
 * sign-in links printed in this terminal. The AI works when ANTHROPIC_API_KEY is set.
 *
 *   npm run build && node scripts/dev.js     then open http://localhost:3000
 */
const { newDb } = require("pg-mem");
const { migrate } = require("../server/db");
const { createApp } = require("../server/app");

async function main() {
  const { Pool } = newDb().adapters.createPg();
  const pool = new Pool();
  await migrate(pool);
  const port = Number(process.env.PORT) || 3000;
  const env = {
    ...process.env,
    NODE_ENV: "development",
    APP_URL: process.env.APP_URL || `http://localhost:${port}`,
    ALLOWED_DOMAINS: process.env.ALLOWED_DOMAINS || "peaknine.studio",
  };
  const app = createApp({ pool, env });
  app.listen(port, () => console.log(`Preview on ${env.APP_URL} (in-memory database; sign-in links appear below)`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
