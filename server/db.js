/**
 * Postgres connection and schema. Every table is created on start (idempotent), so a fresh
 * Render database needs no manual setup.
 */
const { Pool } = require("pg");

function makePool(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is not set");
  // Render's internal URL needs no TLS; an external URL does. DATABASE_SSL=1 turns it on.
  const ssl = process.env.DATABASE_SSL === "1" ? { rejectUnauthorized: false } : undefined;
  return new Pool({ connectionString: url, ssl, max: 10 });
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS docs (
     path TEXT PRIMARY KEY,
     parent TEXT NOT NULL,
     data JSONB NOT NULL,
     updated_at BIGINT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS docs_parent ON docs (parent)`,
  `CREATE TABLE IF NOT EXISTS users (
     email TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     created_at BIGINT NOT NULL,
     last_login BIGINT
   )`,
  `CREATE TABLE IF NOT EXISTS login_tokens (
     token_hash TEXT PRIMARY KEY,
     email TEXT NOT NULL,
     expires_at BIGINT NOT NULL,
     used BOOLEAN NOT NULL DEFAULT FALSE
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     id_hash TEXT PRIMARY KEY,
     email TEXT NOT NULL,
     created_at BIGINT NOT NULL,
     expires_at BIGINT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS ai_usage (
     id SERIAL PRIMARY KEY,
     email TEXT NOT NULL,
     kind TEXT NOT NULL,
     model TEXT NOT NULL,
     input_tokens INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0,
     searches INTEGER NOT NULL DEFAULT 0,
     created_at BIGINT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS ai_usage_email_time ON ai_usage (email, created_at)`,
];

async function migrate(pool) {
  for (const sql of SCHEMA) await pool.query(sql);
}

module.exports = { makePool, migrate };
