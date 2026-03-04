/**
 * DataStore — the storage abstraction for PersonalDataHub.
 *
 * The gateway (routes, auth, audit) programs to this interface.
 * Two implementations exist:
 *   - SqliteDataStore  (local / on-device mode)
 *   - DynamoDataStore  (serverless / AWS Lambda mode)
 */

// --- Row types returned by DataStore methods ---

export interface StoredTokenRow {
  source: string;
  access_token: string;
  refresh_token: string | null;
  token_type: string;
  expires_at: string | null;
  scopes: string;
  account_info: string;
  created_at: string;
  updated_at: string;
}

export interface StagingRow {
  action_id: string;
  manifest_id: string | null;
  source: string;
  action_type: string;
  action_data: string;
  purpose: string;
  status: string;
  proposed_at: string;
  resolved_at: string | null;
}

export interface FilterRow {
  id: string;
  source: string;
  type: string;
  value: string;
  enabled: number;
  created_at: string;
}

export interface AuditRow {
  id: number;
  timestamp: string;
  event: string;
  source: string | null;
  details: string;
}

export interface GitHubRepoRow {
  full_name: string;
  owner: string;
  name: string;
  private: number;
  description: string;
  is_org: number;
  enabled: number;
  permissions: string;
  fetched_at: string;
}

export interface GitHubRepoInput {
  full_name: string;
  owner: string;
  name: string;
  isPrivate: boolean;
  description: string;
  isOrg: boolean;
}

export interface OAuthStateData {
  source: string;
  createdAt: number;
  codeVerifier: string;
}

// --- Utility type ---
// Allows DataStore methods to return either sync (SQLite) or async (DynamoDB) values.
// Consumers must always `await` the result.
type MaybePromise<T> = T | Promise<T>;

// --- DataStore interface ---

export interface DataStore {
  // --- Sessions ---
  getValidSession(token: string): MaybePromise<{ token: string } | null>;
  createSession(token: string, expiresAt: string): MaybePromise<void>;
  deleteSession(token: string): MaybePromise<void>;

  // --- Users ---
  getUserByEmail(email: string): MaybePromise<{ id: number; email: string; password_hash: string } | null>;
  createUser(email: string, passwordHash: string): MaybePromise<void>;
  getUserCount(): MaybePromise<number>;

  // --- OAuth Tokens ---
  upsertToken(source: string, fields: {
    access_token: string;
    refresh_token: string | null;
    token_type: string;
    expires_at: string | null;
    scopes: string;
    account_info: string;
  }): MaybePromise<void>;
  getToken(source: string): MaybePromise<StoredTokenRow | null>;
  hasToken(source: string): MaybePromise<boolean>;
  getAccountInfo(source: string): MaybePromise<string | null>;
  updateAccountInfo(source: string, info: string): MaybePromise<void>;
  deleteToken(source: string): MaybePromise<void>;
  getTokenExpiresAt(source: string): MaybePromise<string | null>;
  updateAccessToken(source: string, accessToken: string, expiresAt: string | null): MaybePromise<void>;

  // --- Staging ---
  insertStagingAction(action: {
    actionId: string;
    manifestId: string;
    source: string;
    actionType: string;
    actionData: string;
    purpose: string;
  }): MaybePromise<void>;
  getStagingAction(actionId: string): MaybePromise<StagingRow | null>;
  getAllStagingActions(): MaybePromise<StagingRow[]>;
  updateStagingStatus(actionId: string, status: string): MaybePromise<void>;
  updateStagingActionData(actionId: string, actionData: string): MaybePromise<void>;

  // --- Filters ---
  getFiltersBySource(source: string): MaybePromise<FilterRow[]>;
  getAllFilters(): MaybePromise<FilterRow[]>;
  getEnabledFiltersBySource(source: string): MaybePromise<FilterRow[]>;
  createFilter(filter: { id: string; source: string; type: string; value: string; enabled: number }): MaybePromise<void>;
  updateFilter(id: string, value: string, enabled: number): MaybePromise<void>;
  deleteFilter(id: string): MaybePromise<void>;

  // --- Audit Log ---
  insertAuditEntry(entry: { timestamp: string; event: string; source: string | null; details: string }): MaybePromise<void>;
  queryAuditEntries(filters: { after?: string; before?: string; event?: string; source?: string; limit?: number }): MaybePromise<AuditRow[]>;

  // --- GitHub Repos ---
  upsertGitHubRepos(repos: GitHubRepoInput[]): MaybePromise<void>;
  getAllGitHubRepos(): MaybePromise<GitHubRepoRow[]>;
  getEnabledGitHubRepos(): MaybePromise<Array<{ full_name: string }>>;
  updateGitHubRepoSettings(updates: Array<{ full_name: string; enabled: boolean; permissions: string }>): MaybePromise<void>;

  // --- OAuth State (CSRF) ---
  setOAuthState(state: string, data: OAuthStateData): MaybePromise<void>;
  getAndDeleteOAuthState(state: string): MaybePromise<OAuthStateData | null>;
}
