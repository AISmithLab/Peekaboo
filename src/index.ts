import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDb } from './db/db.js';
import { loadConfig } from './config/loader.js';
import { startServer } from './server/server.js';
import { GmailConnector } from './connectors/gmail/connector.js';
import { GitHubConnector } from './connectors/github/connector.js';
import { TokenManager } from './auth/token-manager.js';
import { getGmailCredentials } from './auth/pkce.js';
import type { ConnectorRegistry } from './connectors/types.js';

const configPath = process.argv[2] ?? resolve('hub-config.yaml');

if (!existsSync(configPath)) {
  console.log('PersonalDataHub v0.1.0');
  console.log(`\nNo config file found at: ${configPath}`);
  console.log("Run 'npx pdh init' to get started.");
  process.exit(1);
}

const config = loadConfig(configPath);
const dbPath = resolve('pdh.db');
const db = getDb(dbPath);
const encryptionKey = config.encryption_key ?? process.env.PDH_ENCRYPTION_KEY ?? 'pdh-default-key';

// Expose AI provider API key from config as env var
if (config.ai?.api_key) {
  const envVarMap: Record<string, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    google: 'GOOGLE_AI_API_KEY',
  };
  const envVar = envVarMap[config.ai.provider];
  if (envVar && !process.env[envVar]) {
    process.env[envVar] = config.ai.api_key;
  }
}

// Token manager for encrypted OAuth token storage
const tokenManager = new TokenManager(db, encryptionKey);

// Register connectors
const connectorRegistry: ConnectorRegistry = new Map();

// Try to restore Gmail connector from stored OAuth tokens, else fall back to config
if (config.sources.gmail?.enabled) {
  const { clientId, clientSecret } = getGmailCredentials(config);

  const storedToken = tokenManager.getToken('gmail');
  if (storedToken) {
    const connector = new GmailConnector({
      clientId,
      clientSecret,
      accessToken: storedToken.access_token,
      refreshToken: storedToken.refresh_token,
    });
    connectorRegistry.set('gmail', connector);

    // Persist refreshed tokens back to DB
    connector.getAuth().on('tokens', (newTokens) => {
      if (newTokens.access_token) {
        const expiresAt = newTokens.expiry_date
          ? new Date(newTokens.expiry_date).toISOString()
          : undefined;
        tokenManager.updateAccessToken('gmail', newTokens.access_token, expiresAt);
      }
    });

    console.log('Gmail connector restored from stored OAuth token');
  } else {
    connectorRegistry.set('gmail', new GmailConnector({ clientId, clientSecret }));
  }
}

// Try to restore GitHub connector from stored OAuth tokens, else fall back to config
if (config.sources.github?.enabled) {
  const githubConfig = config.sources.github;
  const configRepos = githubConfig.boundary.repos ?? [];
  const agentUsername = githubConfig.agent_identity?.github_username ?? '';

  // Load user-selected repos from DB (merged with config repos)
  const dbEnabledRepos = (db.prepare(
    "SELECT full_name FROM github_repos WHERE enabled = 1",
  ).all() as Array<{ full_name: string }>).map((r) => r.full_name);
  const allowedRepos = dbEnabledRepos.length > 0 ? dbEnabledRepos : configRepos;

  const storedToken = tokenManager.getToken('github');
  if (storedToken) {
    connectorRegistry.set('github', new GitHubConnector({
      ownerToken: storedToken.access_token,
      agentUsername,
      allowedRepos,
    }));
    console.log(`GitHub connector restored from stored OAuth token (${allowedRepos.length} repos)`);
  } else {
    connectorRegistry.set('github', new GitHubConnector({
      ownerToken: githubConfig.owner_auth.token ?? '',
      agentUsername,
      allowedRepos,
    }));
  }
}

startServer({ db, connectorRegistry, config, encryptionKey, tokenManager });
