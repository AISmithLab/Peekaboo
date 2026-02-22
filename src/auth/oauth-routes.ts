import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { google } from 'googleapis';
import type Database from 'better-sqlite3';
import type { ConnectorRegistry } from '../connectors/types.js';
import type { HubConfigParsed } from '../config/schema.js';
import type { TokenManager } from './token-manager.js';
import { AuditLog } from '../audit/log.js';
import { GmailConnector } from '../connectors/gmail/connector.js';
import { GitHubConnector } from '../connectors/github/connector.js';
import { generateCodeVerifier, computeCodeChallenge, getGmailCredentials, getGitHubCredentials } from './pkce.js';

interface OAuthDeps {
  db: Database.Database;
  connectorRegistry: ConnectorRegistry;
  config: HubConfigParsed;
  tokenManager: TokenManager;
}

// CSRF state store: state -> { source, createdAt, codeVerifier }
const pendingStates = new Map<string, { source: string; createdAt: number; codeVerifier: string }>();

// Clean up stale states every 5 minutes
const STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [state, entry] of pendingStates) {
    if (now - entry.createdAt > STATE_MAX_AGE_MS) {
      pendingStates.delete(state);
    }
  }
}, 5 * 60 * 1000).unref();

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
];

function getBaseUrl(config: HubConfigParsed): string {
  const port = config.port ?? 3000;
  return `http://127.0.0.1:${port}`;
}

export function createOAuthRoutes(deps: OAuthDeps): Hono {
  const app = new Hono();
  const auditLog = new AuditLog(deps.db);

  // --- Gmail OAuth ---

  app.get('/gmail/start', (c) => {
    const gmailConfig = deps.config.sources.gmail;
    if (!gmailConfig) {
      return c.redirect('/?oauth_error=gmail_not_configured');
    }

    const { clientId, clientSecret } = getGmailCredentials(deps.config);
    if (!clientId || !clientSecret) {
      return c.redirect('/?oauth_error=gmail_missing_credentials');
    }

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = computeCodeChallenge(codeVerifier);

    const state = randomBytes(32).toString('hex');
    pendingStates.set(state, { source: 'gmail', createdAt: Date.now(), codeVerifier });

    const oauth2Client = new google.auth.OAuth2(
      clientId,
      clientSecret,
      `${getBaseUrl(deps.config)}/oauth/gmail/callback`,
    );

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: GMAIL_SCOPES,
      state,
      code_challenge: codeChallenge,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      code_challenge_method: 'S256' as any,
    });

    return c.redirect(authUrl);
  });

  app.get('/gmail/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    const error = c.req.query('error');

    if (error) {
      return c.redirect(`/?oauth_error=${encodeURIComponent(error)}`);
    }

    if (!code || !state) {
      return c.redirect('/?oauth_error=missing_code_or_state');
    }

    // Validate CSRF state
    const pending = pendingStates.get(state);
    if (!pending || pending.source !== 'gmail') {
      return c.redirect('/?oauth_error=invalid_state');
    }
    const { codeVerifier } = pending;
    pendingStates.delete(state);

    const { clientId, clientSecret } = getGmailCredentials(deps.config);

    const oauth2Client = new google.auth.OAuth2(
      clientId,
      clientSecret,
      `${getBaseUrl(deps.config)}/oauth/gmail/callback`,
    );

    try {
      // Exchange code for tokens (with PKCE code_verifier)
      const { tokens } = await oauth2Client.getToken({ code, codeVerifier });
      console.log('Gmail OAuth tokens received:', {
        has_access_token: !!tokens.access_token,
        has_refresh_token: !!tokens.refresh_token,
        token_type: tokens.token_type,
        expiry_date: tokens.expiry_date,
      });

      // Fetch account info
      oauth2Client.setCredentials(tokens);
      let userInfo: { data: { email?: string | null; name?: string | null; picture?: string | null } } = { data: {} };
      try {
        const oauth2Api = google.oauth2({ version: 'v2', auth: oauth2Client });
        userInfo = await oauth2Api.userinfo.get();
      } catch (infoErr) {
        console.warn('Failed to fetch userinfo (non-fatal):', (infoErr as Error).message);
      }

      const expiresAt = tokens.expiry_date
        ? new Date(tokens.expiry_date).toISOString()
        : undefined;

      // Store tokens encrypted
      deps.tokenManager.storeToken('gmail', {
        access_token: tokens.access_token!,
        refresh_token: tokens.refresh_token ?? undefined,
        token_type: tokens.token_type ?? 'Bearer',
        expires_at: expiresAt,
        scopes: GMAIL_SCOPES.join(' '),
        account_info: {
          email: userInfo.data.email,
          name: userInfo.data.name,
          picture: userInfo.data.picture,
        },
      });

      // Re-create GmailConnector with live tokens
      const connector = new GmailConnector({
        clientId,
        clientSecret,
        accessToken: tokens.access_token!,
        refreshToken: tokens.refresh_token ?? undefined,
      });
      deps.connectorRegistry.set('gmail', connector);

      // Wire up token refresh event so refreshed tokens get persisted
      connector.getAuth().on('tokens', (newTokens) => {
        if (newTokens.access_token) {
          const newExpiry = newTokens.expiry_date
            ? new Date(newTokens.expiry_date).toISOString()
            : undefined;
          deps.tokenManager.updateAccessToken('gmail', newTokens.access_token, newExpiry);
        }
      });

      auditLog.insert('oauth_connected', 'gmail', {
        email: userInfo.data.email,
      });

      return c.redirect('/?oauth_success=gmail');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown_error';
      return c.redirect(`/?oauth_error=${encodeURIComponent(message)}`);
    }
  });

  app.post('/gmail/disconnect', (c) => {
    deps.tokenManager.deleteToken('gmail');
    deps.connectorRegistry.delete('gmail');
    auditLog.insert('oauth_disconnected', 'gmail', {});
    return c.json({ ok: true });
  });

  // --- GitHub OAuth ---

  app.get('/github/start', (c) => {
    const githubConfig = deps.config.sources.github;
    if (!githubConfig) {
      return c.redirect('/?oauth_error=github_not_configured');
    }

    const { clientId } = getGitHubCredentials(deps.config);
    if (!clientId) {
      return c.redirect('/?oauth_error=github_missing_credentials');
    }

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = computeCodeChallenge(codeVerifier);

    const state = randomBytes(32).toString('hex');
    pendingStates.set(state, { source: 'github', createdAt: Date.now(), codeVerifier });

    const redirectUri = `${getBaseUrl(deps.config)}/oauth/github/callback`;
    const authUrl =
      `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${state}` +
      `&code_challenge=${encodeURIComponent(codeChallenge)}` +
      `&code_challenge_method=S256`;

    return c.redirect(authUrl);
  });

  app.get('/github/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    const error = c.req.query('error');

    if (error) {
      return c.redirect(`/?oauth_error=${encodeURIComponent(error)}`);
    }

    if (!code || !state) {
      return c.redirect('/?oauth_error=missing_code_or_state');
    }

    const pending = pendingStates.get(state);
    if (!pending || pending.source !== 'github') {
      return c.redirect('/?oauth_error=invalid_state');
    }
    const { codeVerifier } = pending;
    pendingStates.delete(state);

    const githubConfig = deps.config.sources.github;
    const { clientId, clientSecret } = getGitHubCredentials(deps.config);

    try {
      // Exchange code for token (with PKCE code_verifier)
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          code_verifier: codeVerifier,
        }),
      });

      const tokenData = (await tokenRes.json()) as {
        access_token?: string;
        token_type?: string;
        scope?: string;
        expires_in?: number;
        refresh_token?: string;
        refresh_token_expires_in?: number;
        error?: string;
        error_description?: string;
      };

      if (tokenData.error || !tokenData.access_token) {
        const errMsg = tokenData.error_description || tokenData.error || 'token_exchange_failed';
        return c.redirect(`/?oauth_error=${encodeURIComponent(errMsg)}`);
      }

      // Fetch user info
      const userRes = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'PersonalDataHub/0.1.0',
        },
      });

      const userData = (await userRes.json()) as {
        login?: string;
        avatar_url?: string;
        name?: string;
        html_url?: string;
      };

      const expiresAt = tokenData.expires_in
        ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
        : undefined;

      deps.tokenManager.storeToken('github', {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        token_type: tokenData.token_type ?? 'Bearer',
        expires_at: expiresAt,
        scopes: tokenData.scope ?? '',
        account_info: {
          login: userData.login,
          name: userData.name,
          avatar_url: userData.avatar_url,
          html_url: userData.html_url,
        },
      });

      // Re-create GitHubConnector with the OAuth token
      const allowedRepos = githubConfig?.boundary.repos ?? [];
      const connector = new GitHubConnector({
        ownerToken: tokenData.access_token,
        agentUsername: githubConfig?.agent_identity?.github_username ?? '',
        allowedRepos,
      });
      deps.connectorRegistry.set('github', connector);

      auditLog.insert('oauth_connected', 'github', {
        login: userData.login,
      });

      return c.redirect('/?oauth_success=github');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown_error';
      return c.redirect(`/?oauth_error=${encodeURIComponent(message)}`);
    }
  });

  app.post('/github/disconnect', (c) => {
    deps.tokenManager.deleteToken('github');
    deps.connectorRegistry.delete('github');
    auditLog.insert('oauth_disconnected', 'github', {});
    return c.json({ ok: true });
  });

  return app;
}
