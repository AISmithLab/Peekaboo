/**
 * Schema initialisation for sql.js (mobile / pure-JS SQLite).
 *
 * Mirrors schema.ts but takes a duck-typed object with an exec() method
 * instead of a better-sqlite3 Database, avoiding native-module imports.
 */

interface ExecDb {
  exec(sql: string): void;
}

const TABLES = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS manifests (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  purpose TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  explanation TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'inactive',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS staging (
  action_id TEXT PRIMARY KEY,
  manifest_id TEXT,
  source TEXT NOT NULL,
  action_type TEXT NOT NULL,
  action_data TEXT NOT NULL DEFAULT '{}',
  purpose TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  proposed_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  event TEXT NOT NULL,
  source TEXT,
  details TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  source TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  token_type TEXT NOT NULL DEFAULT 'Bearer',
  expires_at TEXT,
  scopes TEXT NOT NULL DEFAULT '',
  account_info TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS filters (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS github_repos (
  full_name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  private INTEGER NOT NULL DEFAULT 0,
  description TEXT DEFAULT '',
  is_org INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 0,
  permissions TEXT NOT NULL DEFAULT '["code","issues","pull_requests"]',
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function createTables(db: ExecDb): void {
  // sql.js supports multiple statements in a single exec() call
  db.exec(TABLES);
}
