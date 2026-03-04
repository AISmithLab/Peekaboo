import type { DataStore } from '../../database/datastore.js';
import { encryptField, decryptField } from '../../database/encryption.js';

export interface TokenData {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_at?: string;
  scopes?: string;
  account_info?: Record<string, unknown>;
}

export class TokenManager {
  constructor(
    private store: DataStore,
    private masterSecret: string,
  ) {}

  async storeToken(source: string, data: TokenData): Promise<void> {
    const encAccess = encryptField(data.access_token, this.masterSecret);
    const encRefresh = data.refresh_token
      ? encryptField(data.refresh_token, this.masterSecret)
      : null;

    await this.store.upsertToken(source, {
      access_token: encAccess,
      refresh_token: encRefresh,
      token_type: data.token_type ?? 'Bearer',
      expires_at: data.expires_at ?? null,
      scopes: data.scopes ?? '',
      account_info: JSON.stringify(data.account_info ?? {}),
    });
  }

  async getToken(source: string): Promise<TokenData | null> {
    const row = await this.store.getToken(source);
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

  async hasToken(source: string): Promise<boolean> {
    return this.store.hasToken(source);
  }

  async getAccountInfo(source: string): Promise<Record<string, unknown> | null> {
    const info = await this.store.getAccountInfo(source);
    if (!info) return null;
    return JSON.parse(info);
  }

  async updateAccountInfo(source: string, info: Record<string, unknown>): Promise<void> {
    await this.store.updateAccountInfo(source, JSON.stringify(info));
  }

  async deleteToken(source: string): Promise<void> {
    await this.store.deleteToken(source);
  }

  async isExpired(source: string): Promise<boolean> {
    const expiresAt = await this.store.getTokenExpiresAt(source);
    if (!expiresAt) return false;
    return new Date(expiresAt) <= new Date();
  }

  async updateAccessToken(source: string, accessToken: string, expiresAt?: string): Promise<void> {
    const encAccess = encryptField(accessToken, this.masterSecret);
    await this.store.updateAccessToken(source, encAccess, expiresAt ?? null);
  }

  /**
   * Refresh a Gmail access token using the stored refresh token.
   * Returns the new access token or null if refresh fails.
   */
  async refreshGmailToken(clientId: string, clientSecret: string): Promise<string | null> {
    const token = await this.getToken('gmail');
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

    await this.updateAccessToken('gmail', data.access_token, expiresAt);
    return data.access_token;
  }

  /**
   * Refresh a GitHub App user access token.
   * Returns the new access token or null if refresh fails.
   */
  async refreshGitHubToken(clientId: string, clientSecret: string): Promise<string | null> {
    const token = await this.getToken('github');
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
    await this.storeToken('github', {
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
    const token = await this.getToken(source);
    if (!token) return null;

    if (!(await this.isExpired(source))) return token.access_token;

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
