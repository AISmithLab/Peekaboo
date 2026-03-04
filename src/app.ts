/**
 * Shared app factory — reads config, creates the right DataStore,
 * and builds the gateway. Used by both src/index.ts and src/lambda.ts.
 */

import { resolve } from 'node:path';
import type { Hono } from 'hono';
import type { DataStore } from './database/datastore.js';
import type { ConnectorRegistry } from './gateway/connectors/types.js';
import type { HubConfigParsed } from './config/schema.js';
import type { TokenManager } from './gateway/auth/token-manager.js';
import { createGateway } from './gateway/gateway.js';

export interface AppResult {
  app: Hono;
  store: DataStore;
  config: HubConfigParsed;
  tokenManager: TokenManager;
  connectorRegistry: ConnectorRegistry;
}

export async function createApp(config: HubConfigParsed): Promise<AppResult> {
  // Create DataStore based on deployment.database
  let store: DataStore;
  if (config.deployment.database === 'dynamodb') {
    const tableName = config.deployment.dynamodb_table ?? process.env.DYNAMODB_TABLE;
    if (!tableName) {
      throw new Error('deployment.dynamodb_table (or DYNAMODB_TABLE env var) is required when database is "dynamodb"');
    }
    const { DynamoDataStore } = await import('./database/dynamo-store.js');
    store = new DynamoDataStore(tableName);
  } else {
    const { getDb } = await import('./database/db.js');
    const { SqliteDataStore } = await import('./database/sqlite-store.js');
    store = new SqliteDataStore(getDb(resolve('pdh.db')));
  }

  const encryptionKey = config.encryption_key ?? process.env.PDH_ENCRYPTION_KEY ?? 'pdh-default-key';

  // Expose AI provider config as env vars
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
    if (config.ai.model && !process.env.AI_MODEL) {
      process.env.AI_MODEL = config.ai.model;
    }
  }

  const { app, tokenManager, connectorRegistry } = await createGateway({ store, config, encryptionKey });

  return { app, store, config, tokenManager, connectorRegistry };
}
