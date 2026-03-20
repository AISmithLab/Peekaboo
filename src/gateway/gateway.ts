/**
 * Shared gateway setup — creates the Hono app with connectors wired up.
 *
 * Both src/index.ts (local) and src/lambda.ts (serverless) call this
 * function. The only things that differ between modes are the DataStore
 * and how config is loaded — everything else is shared here.
 */

import type { Hono } from 'hono';
import type { DataStore } from '../database/datastore.js';
import type { HubConfigParsed } from '../config/schema.js';
import type { ConnectorRegistry } from './connectors/types.js';
import { TokenManager } from './auth/token-manager.js';
import { GmailConnector } from './connectors/gmail/connector.js';
import { GoogleCalendarConnector } from './connectors/calendar/connector.js';
import { GitHubConnector } from './connectors/github/connector.js';
import { createServer, type ServerDeps } from './server.js';

export interface GatewayOptions {
  store: DataStore;
  config: HubConfigParsed;
  encryptionKey: string;
}

export interface GatewayResult {
  app: Hono;
  store: DataStore;
  tokenManager: TokenManager;
  connectorRegistry: ConnectorRegistry;
}

export async function createGateway(opts: GatewayOptions): Promise<GatewayResult> {
  const { store, config, encryptionKey } = opts;
  const tokenManager = new TokenManager(store, encryptionKey);
  const connectorRegistry: ConnectorRegistry = new Map();

  // Gmail connector — restore from stored token or create empty
  if (config.sources.gmail?.enabled) {
    const clientId = config.sources.gmail.owner_auth.clientId ?? '';
    const clientSecret = config.sources.gmail.owner_auth.clientSecret ?? '';

    const storedToken = await tokenManager.getToken('gmail');
    if (storedToken) {
      const connector = new GmailConnector({
        clientId,
        clientSecret,
        accessToken: storedToken.access_token,
        refreshToken: storedToken.refresh_token,
      });
      connectorRegistry.set('gmail', connector);

      // Persist refreshed tokens back to store
      connector.getAuth().on('tokens', async (newTokens) => {
        if (newTokens.access_token) {
          const expiresAt = newTokens.expiry_date
            ? new Date(newTokens.expiry_date).toISOString()
            : undefined;
          await tokenManager.updateAccessToken('gmail', newTokens.access_token, expiresAt);
        }
      });
    } else {
      connectorRegistry.set('gmail', new GmailConnector({ clientId, clientSecret }));
    }
  }

  // Google Calendar connector
  if (config.sources.google_calendar?.enabled) {
    const clientId = config.sources.google_calendar.owner_auth.clientId ?? '';
    const clientSecret = config.sources.google_calendar.owner_auth.clientSecret ?? '';

    const storedToken = await tokenManager.getToken('google_calendar');
    if (storedToken) {
      const connector = new GoogleCalendarConnector({
        clientId,
        clientSecret,
        accessToken: storedToken.access_token,
        refreshToken: storedToken.refresh_token,
      });
      connectorRegistry.set('google_calendar', connector);

      connector.getAuth().on('tokens', async (newTokens) => {
        if (newTokens.access_token) {
          const expiresAt = newTokens.expiry_date
            ? new Date(newTokens.expiry_date).toISOString()
            : undefined;
          await tokenManager.updateAccessToken('google_calendar', newTokens.access_token, expiresAt);
        }
      });
    } else {
      connectorRegistry.set('google_calendar', new GoogleCalendarConnector({ clientId, clientSecret }));
    }
  }

  // GitHub connector — restore from stored token or create empty
  if (config.sources.github?.enabled) {
    const githubConfig = config.sources.github;
    const configRepos = githubConfig.boundary.repos ?? [];
    const agentUsername = githubConfig.agent_identity?.github_username ?? '';

    const dbEnabledRepos = (await store.getEnabledGitHubRepos()).map((r) => r.full_name);
    const allowedRepos = dbEnabledRepos.length > 0 ? dbEnabledRepos : configRepos;

    const storedToken = await tokenManager.getToken('github');
    connectorRegistry.set('github', new GitHubConnector({
      ownerToken: storedToken?.access_token ?? githubConfig.owner_auth.token ?? '',
      agentUsername,
      allowedRepos,
    }));
  }

  const deps: ServerDeps = { store, connectorRegistry, config, tokenManager };
  const app = createServer(deps);

  return { app, store, tokenManager, connectorRegistry };
}
