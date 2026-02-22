import type Database from 'better-sqlite3';

const CREATE_API_KEYS = `
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  allowed_manifests TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

const CREATE_MANIFESTS = `
CREATE TABLE IF NOT EXISTS manifests (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  purpose TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

const CREATE_CACHED_DATA = `
CREATE TABLE IF NOT EXISTS cached_data (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_item_id TEXT NOT NULL,
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  data TEXT NOT NULL,
  cached_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT
)`;

const CREATE_CACHED_DATA_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_cached_data_source ON cached_data(source)`,
  `CREATE INDEX IF NOT EXISTS idx_cached_data_type ON cached_data(type)`,
  `CREATE INDEX IF NOT EXISTS idx_cached_data_timestamp ON cached_data(timestamp)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_cached_data_source_item ON cached_data(source, source_item_id)`,
];

const CREATE_STAGING = `
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
)`;

const CREATE_AUDIT_LOG = `
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  event TEXT NOT NULL,
  source TEXT,
  details TEXT NOT NULL DEFAULT '{}'
)`;

const CREATE_OAUTH_TOKENS = `
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
)`;

const CREATE_GITHUB_REPOS = `
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
)`;

export function createTables(db: Database.Database): void {
  db.exec(CREATE_API_KEYS);
  db.exec(CREATE_MANIFESTS);
  db.exec(CREATE_CACHED_DATA);
  for (const idx of CREATE_CACHED_DATA_INDEXES) {
    db.exec(idx);
  }
  db.exec(CREATE_STAGING);
  db.exec(CREATE_AUDIT_LOG);
  db.exec(CREATE_OAUTH_TOKENS);
  db.exec(CREATE_GITHUB_REPOS);
}
