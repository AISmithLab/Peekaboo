import type Database from 'better-sqlite3';
import type { ConnectorRegistry } from '../connectors/types.js';
import type { HubConfigParsed } from '../config/schema.js';
import type { PipelineContext } from '../operators/types.js';

export function createPipelineContext(opts: {
  db: Database.Database;
  connectorRegistry: ConnectorRegistry;
  config: HubConfigParsed;
  appId: string;
  manifestId: string;
  encryptionKey?: string;
}): PipelineContext {
  return {
    db: opts.db,
    connectorRegistry: opts.connectorRegistry,
    config: opts.config,
    appId: opts.appId,
    manifestId: opts.manifestId,
    encryptionKey: opts.encryptionKey,
  };
}
