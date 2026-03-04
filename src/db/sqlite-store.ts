/**
 * SqliteDataStore — DataStore implementation backed by better-sqlite3.
 *
 * Used in local / on-device mode. Every method is a thin wrapper
 * around a prepared statement on the underlying SQLite database.
 *
 * OAuth CSRF state is kept in an in-memory Map (same as the original
 * module-level pendingStates). This is fine for a single-process server.
 */

import type Database from 'better-sqlite3';
import type {
  DataStore,
  StoredTokenRow,
  StagingRow,
  FilterRow,
  AuditRow,
  GitHubRepoRow,
  GitHubRepoInput,
  OAuthStateData,
} from './datastore.js';

export class SqliteDataStore implements DataStore {
  private pendingStates = new Map<string, OAuthStateData>();

  constructor(private db: Database.Database) {}

  // --- Sessions ---

  getValidSession(token: string): { token: string } | null {
    return (this.db
      .prepare("SELECT token FROM sessions WHERE token = ? AND expires_at > datetime('now')")
      .get(token) as { token: string } | undefined) ?? null;
  }

  createSession(token: string, expiresAt: string): void {
    this.db
      .prepare('INSERT INTO sessions (token, expires_at) VALUES (?, ?)')
      .run(token, expiresAt);
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  // --- Users ---

  getUserByEmail(email: string): { id: number; email: string; password_hash: string } | null {
    return (this.db
      .prepare('SELECT id, email, password_hash FROM users WHERE email = ?')
      .get(email) as { id: number; email: string; password_hash: string } | undefined) ?? null;
  }

  createUser(email: string, passwordHash: string): void {
    this.db
      .prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
      .run(email, passwordHash);
  }

  getUserCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
    return row.count;
  }

  // --- OAuth Tokens ---

  upsertToken(source: string, fields: {
    access_token: string;
    refresh_token: string | null;
    token_type: string;
    expires_at: string | null;
    scopes: string;
    account_info: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO oauth_tokens (source, access_token, refresh_token, token_type, expires_at, scopes, account_info, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(source) DO UPDATE SET
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           token_type = excluded.token_type,
           expires_at = excluded.expires_at,
           scopes = excluded.scopes,
           account_info = excluded.account_info,
           updated_at = excluded.updated_at`,
      )
      .run(
        source,
        fields.access_token,
        fields.refresh_token,
        fields.token_type,
        fields.expires_at,
        fields.scopes,
        fields.account_info,
      );
  }

  getToken(source: string): StoredTokenRow | null {
    return (this.db
      .prepare('SELECT * FROM oauth_tokens WHERE source = ?')
      .get(source) as StoredTokenRow | undefined) ?? null;
  }

  hasToken(source: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM oauth_tokens WHERE source = ?')
      .get(source);
  }

  getAccountInfo(source: string): string | null {
    const row = this.db
      .prepare('SELECT account_info FROM oauth_tokens WHERE source = ?')
      .get(source) as { account_info: string } | undefined;
    return row?.account_info ?? null;
  }

  updateAccountInfo(source: string, info: string): void {
    this.db
      .prepare("UPDATE oauth_tokens SET account_info = ?, updated_at = datetime('now') WHERE source = ?")
      .run(info, source);
  }

  deleteToken(source: string): void {
    this.db.prepare('DELETE FROM oauth_tokens WHERE source = ?').run(source);
  }

  getTokenExpiresAt(source: string): string | null {
    const row = this.db
      .prepare('SELECT expires_at FROM oauth_tokens WHERE source = ?')
      .get(source) as { expires_at: string | null } | undefined;
    return row?.expires_at ?? null;
  }

  updateAccessToken(source: string, accessToken: string, expiresAt: string | null): void {
    this.db
      .prepare("UPDATE oauth_tokens SET access_token = ?, expires_at = ?, updated_at = datetime('now') WHERE source = ?")
      .run(accessToken, expiresAt, source);
  }

  // --- Staging ---

  insertStagingAction(action: {
    actionId: string;
    manifestId: string;
    source: string;
    actionType: string;
    actionData: string;
    purpose: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO staging (action_id, manifest_id, source, action_type, action_data, purpose, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .run(action.actionId, action.manifestId, action.source, action.actionType, action.actionData, action.purpose);
  }

  getStagingAction(actionId: string): StagingRow | null {
    return (this.db
      .prepare('SELECT * FROM staging WHERE action_id = ?')
      .get(actionId) as StagingRow | undefined) ?? null;
  }

  getAllStagingActions(): StagingRow[] {
    return this.db
      .prepare('SELECT * FROM staging ORDER BY proposed_at DESC')
      .all() as StagingRow[];
  }

  updateStagingStatus(actionId: string, status: string): void {
    this.db
      .prepare("UPDATE staging SET status = ?, resolved_at = datetime('now') WHERE action_id = ?")
      .run(status, actionId);
  }

  updateStagingActionData(actionId: string, actionData: string): void {
    this.db
      .prepare('UPDATE staging SET action_data = ? WHERE action_id = ?')
      .run(actionData, actionId);
  }

  // --- Filters ---

  getFiltersBySource(source: string): FilterRow[] {
    return this.db
      .prepare('SELECT * FROM filters WHERE source = ? ORDER BY created_at DESC')
      .all(source) as FilterRow[];
  }

  getAllFilters(): FilterRow[] {
    return this.db
      .prepare('SELECT * FROM filters ORDER BY created_at DESC')
      .all() as FilterRow[];
  }

  getEnabledFiltersBySource(source: string): FilterRow[] {
    return this.db
      .prepare('SELECT * FROM filters WHERE source = ? AND enabled = 1')
      .all(source) as FilterRow[];
  }

  createFilter(filter: { id: string; source: string; type: string; value: string; enabled: number }): void {
    this.db
      .prepare('INSERT INTO filters (id, source, type, value, enabled) VALUES (?, ?, ?, ?, ?)')
      .run(filter.id, filter.source, filter.type, filter.value, filter.enabled);
  }

  updateFilter(id: string, value: string, enabled: number): void {
    this.db
      .prepare('UPDATE filters SET value = ?, enabled = ? WHERE id = ?')
      .run(value, enabled, id);
  }

  deleteFilter(id: string): void {
    this.db.prepare('DELETE FROM filters WHERE id = ?').run(id);
  }

  // --- Audit Log ---

  insertAuditEntry(entry: { timestamp: string; event: string; source: string | null; details: string }): void {
    this.db
      .prepare('INSERT INTO audit_log (timestamp, event, source, details) VALUES (?, ?, ?, ?)')
      .run(entry.timestamp, entry.event, entry.source, entry.details);
  }

  queryAuditEntries(filters: { after?: string; before?: string; event?: string; source?: string; limit?: number }): AuditRow[] {
    let query = 'SELECT * FROM audit_log WHERE 1=1';
    const params: unknown[] = [];

    if (filters.after) {
      query += ' AND timestamp >= ?';
      params.push(filters.after);
    }
    if (filters.before) {
      query += ' AND timestamp <= ?';
      params.push(filters.before);
    }
    if (filters.event) {
      query += ' AND event = ?';
      params.push(filters.event);
    }
    if (filters.source) {
      query += ' AND source = ?';
      params.push(filters.source);
    }

    query += ' ORDER BY id ASC';

    if (filters.limit) {
      query += ' LIMIT ?';
      params.push(filters.limit);
    }

    return this.db.prepare(query).all(...params) as AuditRow[];
  }

  // --- GitHub Repos ---

  upsertGitHubRepos(repos: GitHubRepoInput[]): void {
    const upsert = this.db.prepare(`
      INSERT INTO github_repos (full_name, owner, name, private, description, is_org, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(full_name) DO UPDATE SET
        private = excluded.private,
        description = excluded.description,
        is_org = excluded.is_org,
        fetched_at = excluded.fetched_at
    `);

    const upsertMany = this.db.transaction(() => {
      for (const repo of repos) {
        upsert.run(
          repo.full_name,
          repo.owner,
          repo.name,
          repo.isPrivate ? 1 : 0,
          repo.description,
          repo.isOrg ? 1 : 0,
        );
      }
    });
    upsertMany();
  }

  getAllGitHubRepos(): GitHubRepoRow[] {
    return this.db
      .prepare('SELECT * FROM github_repos ORDER BY owner, name')
      .all() as GitHubRepoRow[];
  }

  getEnabledGitHubRepos(): Array<{ full_name: string }> {
    return this.db
      .prepare('SELECT full_name FROM github_repos WHERE enabled = 1')
      .all() as Array<{ full_name: string }>;
  }

  updateGitHubRepoSettings(updates: Array<{ full_name: string; enabled: boolean; permissions: string }>): void {
    const stmt = this.db.prepare(
      'UPDATE github_repos SET enabled = ?, permissions = ? WHERE full_name = ?',
    );

    const updateMany = this.db.transaction(() => {
      for (const u of updates) {
        stmt.run(u.enabled ? 1 : 0, u.permissions, u.full_name);
      }
    });
    updateMany();
  }

  // --- OAuth State (CSRF) ---

  setOAuthState(state: string, data: OAuthStateData): void {
    this.pendingStates.set(state, data);
  }

  getAndDeleteOAuthState(state: string): OAuthStateData | null {
    const data = this.pendingStates.get(state);
    if (!data) return null;
    this.pendingStates.delete(state);
    return data;
  }
}
