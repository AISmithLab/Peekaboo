import type Database from 'better-sqlite3';
import { encryptField, decryptField } from '../db/encryption.js';

export interface TokenData {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_at?: string;
  scopes?: string;
  account_info?: Record<string, unknown>;
}

interface StoredRow {
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

export class TokenManager {
  constructor(
    private db: Database.Database,
    private masterSecret: string,
  ) {}

  storeToken(source: string, data: TokenData): void {
    const encAccess = encryptField(data.access_token, this.masterSecret);
    const encRefresh = data.refresh_token
      ? encryptField(data.refresh_token, this.masterSecret)
      : null;

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
        encAccess,
        encRefresh,
        data.token_type ?? 'Bearer',
        data.expires_at ?? null,
        data.scopes ?? '',
        JSON.stringify(data.account_info ?? {}),
      );
  }

  getToken(source: string): TokenData | null {
    const row = this.db
      .prepare('SELECT * FROM oauth_tokens WHERE source = ?')
      .get(source) as StoredRow | undefined;

    if (!row) return null;

    return {
      access_token: decryptField(row.access_token, this.masterSecret),
      refresh_token: row.refresh_token
        ? decryptField(row.refresh_token, this.masterSecret)
        : undefined,
      token_type: row.token_type,
      expires_at: row.expires_at ?? undefined,
      scopes: row.scopes,
      account_info: JSON.parse(row.account_info),
    };
  }

  hasToken(source: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM oauth_tokens WHERE source = ?')
      .get(source);
    return !!row;
  }

  getAccountInfo(source: string): Record<string, unknown> | null {
    const row = this.db
      .prepare('SELECT account_info FROM oauth_tokens WHERE source = ?')
      .get(source) as { account_info: string } | undefined;

    if (!row) return null;
    return JSON.parse(row.account_info);
  }

  deleteToken(source: string): void {
    this.db.prepare('DELETE FROM oauth_tokens WHERE source = ?').run(source);
  }

  isExpired(source: string): boolean {
    const row = this.db
      .prepare('SELECT expires_at FROM oauth_tokens WHERE source = ?')
      .get(source) as { expires_at: string | null } | undefined;

    if (!row || !row.expires_at) return false;
    return new Date(row.expires_at) <= new Date();
  }

  updateAccessToken(source: string, accessToken: string, expiresAt?: string): void {
    const encAccess = encryptField(accessToken, this.masterSecret);
    this.db
      .prepare(
        `UPDATE oauth_tokens SET access_token = ?, expires_at = ?, updated_at = datetime('now') WHERE source = ?`,
      )
      .run(encAccess, expiresAt ?? null, source);
  }

  /**
   * Refresh a Gmail access token using the stored refresh token.
   * Returns the new access token or null if refresh fails.
   */
  async refreshGmailToken(clientId: string, clientSecret: string): Promise<string | null> {
    const token = this.getToken('gmail');
    if (!token?.refresh_token) return null;

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: token.refresh_token,
        grant_type: 'refresh_token',
      }),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as { access_token: string; expires_in?: number };
    const expiresAt = data.expires_in
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : undefined;

    this.updateAccessToken('gmail', data.access_token, expiresAt);
    return data.access_token;
  }

  /**
   * Refresh a GitHub App user access token.
   * Returns the new access token or null if refresh fails.
   */
  async refreshGitHubToken(clientId: string, clientSecret: string): Promise<string | null> {
    const token = this.getToken('github');
    if (!token?.refresh_token) return null;

    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: token.refresh_token,
        grant_type: 'refresh_token',
      }),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
      refresh_token_expires_in?: number;
    };

    if (!data.access_token) return null;

    const expiresAt = data.expires_in
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : undefined;

    // GitHub may rotate the refresh token
    this.storeToken('github', {
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? token.refresh_token,
      token_type: 'Bearer',
      expires_at: expiresAt,
      scopes: token.scopes,
      account_info: token.account_info,
    });

    return data.access_token;
  }

  /**
   * Get a valid access token, refreshing if needed.
   */
  async getValidToken(
    source: string,
    credentials?: { clientId: string; clientSecret: string },
  ): Promise<string | null> {
    const token = this.getToken(source);
    if (!token) return null;

    if (!this.isExpired(source)) return token.access_token;

    // Token is expired — try to refresh
    if (!credentials) return null;

    if (source === 'gmail') {
      return this.refreshGmailToken(credentials.clientId, credentials.clientSecret);
    }
    if (source === 'github') {
      return this.refreshGitHubToken(credentials.clientId, credentials.clientSecret);
    }

    return null;
  }
}
