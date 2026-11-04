/**
 * Local preview without Postgres: an in-memory database (gone when you stop it).
 * The AI works when ANTHROPIC_API_KEY is set.
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
  };
  const app = createApp({ pool, env });
  app.listen(port, () => console.log(`Preview on ${env.APP_URL} (in-memory database)`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
