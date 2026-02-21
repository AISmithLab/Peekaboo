import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDb } from './db/db.js';
import { loadConfig } from './config/loader.js';
import { startServer } from './server/server.js';
import { GmailConnector } from './connectors/gmail/connector.js';
import { GitHubConnector } from './connectors/github/connector.js';
import type { ConnectorRegistry } from './connectors/types.js';

const configPath = process.argv[2] ?? resolve('hub-config.yaml');

if (!existsSync(configPath)) {
  console.log('Peekaboo v0.1.0 — Privacy-first personal data gateway');
  console.log(`\nNo config file found at: ${configPath}`);
  console.log('Copy hub-config.example.yaml to hub-config.yaml and configure your sources.');
  process.exit(1);
}

const config = loadConfig(configPath);
const dbPath = resolve('peekaboo.db');
const db = getDb(dbPath);
const encryptionKey = config.encryption_key ?? process.env.PEEKABOO_ENCRYPTION_KEY ?? 'peekaboo-default-key';

// Register connectors
const connectorRegistry: ConnectorRegistry = new Map();

if (config.sources.gmail?.enabled) {
  const gmailConfig = config.sources.gmail;
  connectorRegistry.set('gmail', new GmailConnector({
    clientId: gmailConfig.owner_auth.clientId ?? '',
    clientSecret: gmailConfig.owner_auth.clientSecret ?? '',
  }));
}

if (config.sources.github?.enabled) {
  const githubConfig = config.sources.github;
  connectorRegistry.set('github', new GitHubConnector({
    ownerToken: githubConfig.owner_auth.token ?? '',
    agentUsername: githubConfig.agent_identity?.github_username ?? '',
    allowedRepos: githubConfig.boundary.repos ?? [],
  }));
}

startServer({ db, connectorRegistry, config, encryptionKey });
