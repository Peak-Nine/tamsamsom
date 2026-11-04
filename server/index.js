/** Entry point: connect to Postgres, create the tables, start the web server. */
const { makePool, migrate } = require("./db");
const { createApp } = require("./app");

async function main() {
  for (const k of ["DATABASE_URL", "ANTHROPIC_API_KEY", "APP_URL"]) {
    if (!process.env[k]) console.warn(`[start] ${k} is not set`);
  }
  const pool = makePool();
  await migrate(pool);
  const app = createApp({ pool });
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`Market Estimator running on port ${port} (${process.env.APP_URL || "no APP_URL"})`));
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
