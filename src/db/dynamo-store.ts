/**
 * DynamoDataStore — DataStore implementation backed by DynamoDB.
 *
 * Used in serverless / AWS Lambda mode. Single-table design with
 * PK/SK patterns to store all entities.
 *
 * PK/SK patterns:
 *   USER#{email}    / PROFILE         — user accounts (email + password hash)
 *   SESSION#{token} / SESSION        — browser sessions (TTL)
 *   TOKEN#{source}  / TOKEN          — OAuth tokens
 *   STAGING#{id}    / STAGING        — staged actions
 *   AUDIT#{ts}#{uuid} / AUDIT        — audit log entries
 *   FILTER#{id}     / FILTER         — data filters
 *   GHREPO#{name}   / GHREPO         — GitHub repos
 *   STATE#{state}   / STATE          — OAuth CSRF state (TTL)
 */

import {
  DynamoDBClient,
  type DynamoDBClientConfig,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
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

export class DynamoDataStore implements DataStore {
  private docClient: DynamoDBDocumentClient;

  constructor(
    private tableName: string,
    clientConfig?: DynamoDBClientConfig,
  ) {
    const client = new DynamoDBClient(clientConfig ?? {});
    this.docClient = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  // --- Sessions ---

  async getValidSession(token: string): Promise<{ token: string } | null> {
    const result = await this.docClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { PK: `SESSION#${token}`, SK: 'SESSION' },
    }));
    if (!result.Item) return null;
    // Check TTL — DynamoDB may not have purged expired items yet
    if (result.Item.ttl && result.Item.ttl < Math.floor(Date.now() / 1000)) return null;
    return { token };
  }

  async createSession(token: string, expiresAt: string): Promise<void> {
    const ttl = Math.floor(new Date(expiresAt).getTime() / 1000);
    await this.docClient.send(new PutCommand({
      TableName: this.tableName,
      Item: { PK: `SESSION#${token}`, SK: 'SESSION', token, expires_at: expiresAt, ttl },
    }));
  }

  async deleteSession(token: string): Promise<void> {
    await this.docClient.send(new DeleteCommand({
      TableName: this.tableName,
      Key: { PK: `SESSION#${token}`, SK: 'SESSION' },
    }));
  }

  // --- Users ---

  async getUserByEmail(email: string): Promise<{ id: number; email: string; password_hash: string } | null> {
    const result = await this.docClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { PK: `USER#${email.toLowerCase()}`, SK: 'PROFILE' },
    }));
    if (!result.Item?.email) return null;
    return {
      id: result.Item.id as number ?? 1,
      email: result.Item.email as string,
      password_hash: result.Item.password_hash as string,
    };
  }

  async createUser(email: string, passwordHash: string): Promise<void> {
    await this.docClient.send(new PutCommand({
      TableName: this.tableName,
      Item: { PK: `USER#${email.toLowerCase()}`, SK: 'PROFILE', email, password_hash: passwordHash, id: Date.now() },
    }));
  }

  async getUserCount(): Promise<number> {
    const result = await this.docClient.send(new ScanCommand({
      TableName: this.tableName,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :sk',
      ExpressionAttributeValues: { ':prefix': 'USER#', ':sk': 'PROFILE' },
      Select: 'COUNT',
    }));
    return result.Count ?? 0;
  }

  // --- OAuth Tokens ---

  async upsertToken(source: string, fields: {
    access_token: string;
    refresh_token: string | null;
    token_type: string;
    expires_at: string | null;
    scopes: string;
    account_info: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.docClient.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        PK: `TOKEN#${source}`,
        SK: 'TOKEN',
        source,
        access_token: fields.access_token,
        refresh_token: fields.refresh_token,
        token_type: fields.token_type,
        expires_at: fields.expires_at,
        scopes: fields.scopes,
        account_info: fields.account_info,
        created_at: now,
        updated_at: now,
      },
    }));
  }

  async getToken(source: string): Promise<StoredTokenRow | null> {
    const result = await this.docClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { PK: `TOKEN#${source}`, SK: 'TOKEN' },
    }));
    if (!result.Item) return null;
    return {
      source: result.Item.source,
      access_token: result.Item.access_token,
      refresh_token: result.Item.refresh_token ?? null,
      token_type: result.Item.token_type,
      expires_at: result.Item.expires_at ?? null,
      scopes: result.Item.scopes,
      account_info: result.Item.account_info,
      created_at: result.Item.created_at,
      updated_at: result.Item.updated_at,
    };
  }

  async hasToken(source: string): Promise<boolean> {
    const result = await this.docClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { PK: `TOKEN#${source}`, SK: 'TOKEN' },
      ProjectionExpression: 'PK',
    }));
    return !!result.Item;
  }

  async getAccountInfo(source: string): Promise<string | null> {
    const result = await this.docClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { PK: `TOKEN#${source}`, SK: 'TOKEN' },
      ProjectionExpression: 'account_info',
    }));
    return result.Item?.account_info ?? null;
  }

  async updateAccountInfo(source: string, info: string): Promise<void> {
    await this.docClient.send(new UpdateCommand({
      TableName: this.tableName,
      Key: { PK: `TOKEN#${source}`, SK: 'TOKEN' },
      UpdateExpression: 'SET account_info = :info, updated_at = :now',
      ExpressionAttributeValues: { ':info': info, ':now': new Date().toISOString() },
    }));
  }

  async deleteToken(source: string): Promise<void> {
    await this.docClient.send(new DeleteCommand({
      TableName: this.tableName,
      Key: { PK: `TOKEN#${source}`, SK: 'TOKEN' },
    }));
  }

  async getTokenExpiresAt(source: string): Promise<string | null> {
    const result = await this.docClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { PK: `TOKEN#${source}`, SK: 'TOKEN' },
      ProjectionExpression: 'expires_at',
    }));
    return result.Item?.expires_at ?? null;
  }

  async updateAccessToken(source: string, accessToken: string, expiresAt: string | null): Promise<void> {
    await this.docClient.send(new UpdateCommand({
      TableName: this.tableName,
      Key: { PK: `TOKEN#${source}`, SK: 'TOKEN' },
      UpdateExpression: 'SET access_token = :at, expires_at = :ea, updated_at = :now',
      ExpressionAttributeValues: {
        ':at': accessToken,
        ':ea': expiresAt,
        ':now': new Date().toISOString(),
      },
    }));
  }

  // --- Staging ---

  async insertStagingAction(action: {
    actionId: string;
    manifestId: string;
    source: string;
    actionType: string;
    actionData: string;
    purpose: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.docClient.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        PK: `STAGING#${action.actionId}`,
        SK: 'STAGING',
        action_id: action.actionId,
        manifest_id: action.manifestId || null,
        source: action.source,
        action_type: action.actionType,
        action_data: action.actionData,
        purpose: action.purpose,
        status: 'pending',
        proposed_at: now,
        resolved_at: null,
      },
    }));
  }

  async getStagingAction(actionId: string): Promise<StagingRow | null> {
    const result = await this.docClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { PK: `STAGING#${actionId}`, SK: 'STAGING' },
    }));
    if (!result.Item) return null;
    return this.toStagingRow(result.Item);
  }

  async getAllStagingActions(): Promise<StagingRow[]> {
    const result = await this.docClient.send(new ScanCommand({
      TableName: this.tableName,
      FilterExpression: 'SK = :sk',
      ExpressionAttributeValues: { ':sk': 'STAGING' },
    }));
    const rows = (result.Items ?? []).map((item) => this.toStagingRow(item));
    // Sort by proposed_at descending (matching SQLite ORDER BY proposed_at DESC)
    rows.sort((a, b) => b.proposed_at.localeCompare(a.proposed_at));
    return rows;
  }

  async updateStagingStatus(actionId: string, status: string): Promise<void> {
    await this.docClient.send(new UpdateCommand({
      TableName: this.tableName,
      Key: { PK: `STAGING#${actionId}`, SK: 'STAGING' },
      UpdateExpression: 'SET #s = :status, resolved_at = :now',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':status': status, ':now': new Date().toISOString() },
    }));
  }

  async updateStagingActionData(actionId: string, actionData: string): Promise<void> {
    await this.docClient.send(new UpdateCommand({
      TableName: this.tableName,
      Key: { PK: `STAGING#${actionId}`, SK: 'STAGING' },
      UpdateExpression: 'SET action_data = :ad',
      ExpressionAttributeValues: { ':ad': actionData },
    }));
  }

  // --- Filters ---

  async getFiltersBySource(source: string): Promise<FilterRow[]> {
    const result = await this.docClient.send(new ScanCommand({
      TableName: this.tableName,
      FilterExpression: 'SK = :sk AND #src = :source',
      ExpressionAttributeNames: { '#src': 'source' },
      ExpressionAttributeValues: { ':sk': 'FILTER', ':source': source },
    }));
    const rows = (result.Items ?? []).map((item) => this.toFilterRow(item));
    rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return rows;
  }

  async getAllFilters(): Promise<FilterRow[]> {
    const result = await this.docClient.send(new ScanCommand({
      TableName: this.tableName,
      FilterExpression: 'SK = :sk',
      ExpressionAttributeValues: { ':sk': 'FILTER' },
    }));
    const rows = (result.Items ?? []).map((item) => this.toFilterRow(item));
    rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return rows;
  }

  async getEnabledFiltersBySource(source: string): Promise<FilterRow[]> {
    const result = await this.docClient.send(new ScanCommand({
      TableName: this.tableName,
      FilterExpression: 'SK = :sk AND #src = :source AND enabled = :e',
      ExpressionAttributeNames: { '#src': 'source' },
      ExpressionAttributeValues: { ':sk': 'FILTER', ':source': source, ':e': 1 },
    }));
    return (result.Items ?? []).map((item) => this.toFilterRow(item));
  }

  async createFilter(filter: { id: string; source: string; type: string; value: string; enabled: number }): Promise<void> {
    await this.docClient.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        PK: `FILTER#${filter.id}`,
        SK: 'FILTER',
        id: filter.id,
        source: filter.source,
        type: filter.type,
        value: filter.value,
        enabled: filter.enabled,
        created_at: new Date().toISOString(),
      },
    }));
  }

  async updateFilter(id: string, value: string, enabled: number): Promise<void> {
    await this.docClient.send(new UpdateCommand({
      TableName: this.tableName,
      Key: { PK: `FILTER#${id}`, SK: 'FILTER' },
      UpdateExpression: 'SET #v = :value, enabled = :enabled',
      ExpressionAttributeNames: { '#v': 'value' },
      ExpressionAttributeValues: { ':value': value, ':enabled': enabled },
    }));
  }

  async deleteFilter(id: string): Promise<void> {
    await this.docClient.send(new DeleteCommand({
      TableName: this.tableName,
      Key: { PK: `FILTER#${id}`, SK: 'FILTER' },
    }));
  }

  // --- Audit Log ---

  async insertAuditEntry(entry: { timestamp: string; event: string; source: string | null; details: string }): Promise<void> {
    const uuid = randomUUID();
    await this.docClient.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        PK: `AUDIT#${entry.timestamp}#${uuid}`,
        SK: 'AUDIT',
        timestamp: entry.timestamp,
        event: entry.event,
        source: entry.source,
        details: entry.details,
        // Synthetic auto-increment for ordering
        id: Date.now(),
      },
    }));
  }

  async queryAuditEntries(filters: { after?: string; before?: string; event?: string; source?: string; limit?: number }): Promise<AuditRow[]> {
    const filterParts: string[] = ['SK = :sk'];
    const exprValues: Record<string, unknown> = { ':sk': 'AUDIT' };
    const exprNames: Record<string, string> = {};

    if (filters.after) {
      filterParts.push('#ts >= :after');
      exprNames['#ts'] = 'timestamp';
      exprValues[':after'] = filters.after;
    }
    if (filters.before) {
      filterParts.push('#ts <= :before');
      if (!exprNames['#ts']) exprNames['#ts'] = 'timestamp';
      exprValues[':before'] = filters.before;
    }
    if (filters.event) {
      filterParts.push('#ev = :event');
      exprNames['#ev'] = 'event';
      exprValues[':event'] = filters.event;
    }
    if (filters.source) {
      filterParts.push('#src = :source');
      exprNames['#src'] = 'source';
      exprValues[':source'] = filters.source;
    }

    const result = await this.docClient.send(new ScanCommand({
      TableName: this.tableName,
      FilterExpression: filterParts.join(' AND '),
      ExpressionAttributeValues: exprValues,
      ...(Object.keys(exprNames).length > 0 ? { ExpressionAttributeNames: exprNames } : {}),
    }));

    const rows: AuditRow[] = (result.Items ?? []).map((item) => ({
      id: item.id as number,
      timestamp: item.timestamp as string,
      event: item.event as string,
      source: (item.source as string | null) ?? null,
      details: item.details as string,
    }));

    // Sort by id ASC (matching SQLite ORDER BY id ASC)
    rows.sort((a, b) => a.id - b.id);

    if (filters.limit) {
      return rows.slice(0, filters.limit);
    }
    return rows;
  }

  // --- GitHub Repos ---

  async upsertGitHubRepos(repos: GitHubRepoInput[]): Promise<void> {
    // DynamoDB BatchWrite supports max 25 items per call
    const now = new Date().toISOString();
    const chunks = this.chunk(repos, 25);
    for (const batch of chunks) {
      await this.docClient.send(new BatchWriteCommand({
        RequestItems: {
          [this.tableName]: batch.map((repo) => ({
            PutRequest: {
              Item: {
                PK: `GHREPO#${repo.full_name}`,
                SK: 'GHREPO',
                full_name: repo.full_name,
                owner: repo.owner,
                name: repo.name,
                private: repo.isPrivate ? 1 : 0,
                description: repo.description,
                is_org: repo.isOrg ? 1 : 0,
                enabled: 0,
                permissions: 'read',
                fetched_at: now,
              },
            },
          })),
        },
      }));
    }
  }

  async getAllGitHubRepos(): Promise<GitHubRepoRow[]> {
    const result = await this.docClient.send(new ScanCommand({
      TableName: this.tableName,
      FilterExpression: 'SK = :sk',
      ExpressionAttributeValues: { ':sk': 'GHREPO' },
    }));
    const rows = (result.Items ?? []).map((item) => this.toGitHubRepoRow(item));
    rows.sort((a, b) => {
      const ownerCmp = a.owner.localeCompare(b.owner);
      return ownerCmp !== 0 ? ownerCmp : a.name.localeCompare(b.name);
    });
    return rows;
  }

  async getEnabledGitHubRepos(): Promise<Array<{ full_name: string }>> {
    const result = await this.docClient.send(new ScanCommand({
      TableName: this.tableName,
      FilterExpression: 'SK = :sk AND enabled = :e',
      ExpressionAttributeValues: { ':sk': 'GHREPO', ':e': 1 },
      ProjectionExpression: 'full_name',
    }));
    return (result.Items ?? []).map((item) => ({ full_name: item.full_name as string }));
  }

  async updateGitHubRepoSettings(updates: Array<{ full_name: string; enabled: boolean; permissions: string }>): Promise<void> {
    for (const u of updates) {
      await this.docClient.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { PK: `GHREPO#${u.full_name}`, SK: 'GHREPO' },
        UpdateExpression: 'SET enabled = :e, permissions = :p',
        ExpressionAttributeValues: { ':e': u.enabled ? 1 : 0, ':p': u.permissions },
      }));
    }
  }

  // --- OAuth State (CSRF) ---

  async setOAuthState(state: string, data: OAuthStateData): Promise<void> {
    const ttl = Math.floor(Date.now() / 1000) + 600; // 10 minutes
    await this.docClient.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        PK: `STATE#${state}`,
        SK: 'STATE',
        source: data.source,
        createdAt: data.createdAt,
        codeVerifier: data.codeVerifier,
        ttl,
      },
    }));
  }

  async getAndDeleteOAuthState(state: string): Promise<OAuthStateData | null> {
    const result = await this.docClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { PK: `STATE#${state}`, SK: 'STATE' },
    }));
    if (!result.Item) return null;
    // Check TTL
    if (result.Item.ttl && (result.Item.ttl as number) < Math.floor(Date.now() / 1000)) {
      return null;
    }
    // Delete after reading (consume-once)
    await this.docClient.send(new DeleteCommand({
      TableName: this.tableName,
      Key: { PK: `STATE#${state}`, SK: 'STATE' },
    }));
    return {
      source: result.Item.source as string,
      createdAt: result.Item.createdAt as number,
      codeVerifier: result.Item.codeVerifier as string,
    };
  }

  // --- Helpers ---

  private toStagingRow(item: Record<string, unknown>): StagingRow {
    return {
      action_id: item.action_id as string,
      manifest_id: (item.manifest_id as string | null) ?? null,
      source: item.source as string,
      action_type: item.action_type as string,
      action_data: item.action_data as string,
      purpose: item.purpose as string,
      status: item.status as string,
      proposed_at: item.proposed_at as string,
      resolved_at: (item.resolved_at as string | null) ?? null,
    };
  }

  private toFilterRow(item: Record<string, unknown>): FilterRow {
    return {
      id: item.id as string,
      source: item.source as string,
      type: item.type as string,
      value: item.value as string,
      enabled: item.enabled as number,
      created_at: item.created_at as string,
    };
  }

  private toGitHubRepoRow(item: Record<string, unknown>): GitHubRepoRow {
    return {
      full_name: item.full_name as string,
      owner: item.owner as string,
      name: item.name as string,
      private: item.private as number,
      description: item.description as string,
      is_org: item.is_org as number,
      enabled: item.enabled as number,
      permissions: item.permissions as string,
      fetched_at: item.fetched_at as string,
    };
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }
}
