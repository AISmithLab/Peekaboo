import type Database from 'better-sqlite3';
import type { DataRow, ConnectorRegistry, ActionResult } from '../connectors/types.js';
import type { HubConfigParsed } from '../config/schema.js';

export interface PipelineContext {
  db: Database.Database;
  connectorRegistry: ConnectorRegistry;
  config: HubConfigParsed;
  appId: string;
  manifestId: string;
  encryptionKey?: string;
  cacheOnly?: boolean;
}

export type OperatorResult = DataRow[] | ActionResult | void;

export interface Operator {
  type: string;
  execute(
    input: DataRow[],
    context: PipelineContext,
    props: Record<string, unknown>,
  ): Promise<OperatorResult>;
}
