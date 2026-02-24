import type { Operator, PipelineContext, OperatorResult } from './types.js';
import type { DataRow } from '../connectors/types.js';
import { decryptField } from '../db/encryption.js';

export const pullOperator: Operator = {
  type: 'pull',

  async execute(
    _input: DataRow[],
    context: PipelineContext,
    props: Record<string, unknown>,
  ): Promise<OperatorResult> {
    const source = props.source as string;
    const type = props.type as string | undefined;

    if (!source) {
      throw new Error('pull operator requires "source" property');
    }

    // Cache enabled: read only from local DB, never hit live API
    if (context.cacheOnly) {
      return readFromCache(context, source, type);
    }

    // Cache disabled: always fetch live from connector
    const connector = context.connectorRegistry.get(source);
    if (!connector) {
      throw new Error(`No connector registered for source: "${source}"`);
    }

    const sourceConfig = context.config.sources[source];
    const boundary = sourceConfig?.boundary ?? {};

    const rows = await connector.fetch(boundary, { type, ...props });
    return rows;
  },
};

function readFromCache(
  context: PipelineContext,
  source: string,
  type?: string,
): DataRow[] {
  let query = 'SELECT * FROM cached_data WHERE source = ?';
  const params: unknown[] = [source];

  if (type) {
    query += ' AND type = ?';
    params.push(type);
  }

  // Check boundary after date
  const sourceConfig = context.config.sources[source];
  if (sourceConfig?.boundary?.after) {
    query += ' AND timestamp >= ?';
    params.push(sourceConfig.boundary.after);
  }

  // Check expiration
  query += " AND (expires_at IS NULL OR expires_at > datetime('now'))";

  const rows = context.db.prepare(query).all(...params) as Array<{
    source: string;
    source_item_id: string;
    type: string;
    timestamp: string;
    data: string;
  }>;

  return rows.map((row) => {
    let dataStr = row.data;
    // Try to decrypt if encryption key is available
    if (context.encryptionKey) {
      try {
        dataStr = decryptField(row.data, context.encryptionKey);
      } catch {
        // Data might not be encrypted, use as-is
      }
    }

    return {
      source: row.source,
      source_item_id: row.source_item_id,
      type: row.type,
      timestamp: row.timestamp,
      data: JSON.parse(dataStr),
    };
  });
}
