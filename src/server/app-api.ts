import { Hono } from 'hono';
import { compareSync } from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ConnectorRegistry, DataRow } from '../connectors/types.js';
import type { HubConfigParsed } from '../config/schema.js';
import { AuditLog } from '../audit/log.js';
import { applyFilters, type QuickFilter } from '../filters.js';
import { decryptField } from '../db/encryption.js';

interface AppApiDeps {
  db: Database.Database;
  connectorRegistry: ConnectorRegistry;
  config: HubConfigParsed;
  encryptionKey?: string;
}

interface ApiKeyRow {
  id: string;
  key_hash: string;
  name: string;
  allowed_manifests: string;
  enabled: number;
}

type Env = { Variables: { apiKey: ApiKeyRow } };

export function createAppApi(deps: AppApiDeps): Hono<Env> {
  const app = new Hono<Env>();
  const auditLog = new AuditLog(deps.db);

  // Auth middleware
  app.use('*', async (c, next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Missing or invalid Authorization header' } }, 401);
    }

    const token = authHeader.slice('Bearer '.length);
    const apiKey = verifyApiKey(deps.db, token);
    if (!apiKey) {
      return c.json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } }, 401);
    }

    c.set('apiKey', apiKey);
    await next();
  });

  // POST /pull
  app.post('/pull', async (c) => {
    const body = await c.req.json();
    const { source, purpose } = body;

    if (!purpose) {
      return c.json({ ok: false, error: { code: 'BAD_REQUEST', message: 'Missing required field: purpose' } }, 400);
    }

    if (!source) {
      return c.json({ ok: false, error: { code: 'BAD_REQUEST', message: 'Missing required field: source' } }, 400);
    }

    const apiKey = c.get('apiKey');
    const sourceConfig = deps.config.sources[source];
    if (!sourceConfig) {
      return c.json({ ok: false, error: { code: 'NOT_FOUND', message: `Unknown source: "${source}"` } }, 404);
    }

    const cacheEnabled = sourceConfig.cache?.enabled === true;

    let rows: DataRow[];

    if (cacheEnabled) {
      // Read from cached_data
      rows = readFromCache(deps.db, source, sourceConfig, deps.encryptionKey);
    } else {
      // Fetch live from connector
      const connector = deps.connectorRegistry.get(source);
      if (!connector) {
        return c.json({ ok: false, error: { code: 'NOT_FOUND', message: `No connector for source: "${source}"` } }, 404);
      }
      const boundary = sourceConfig.boundary ?? {};
      rows = await connector.fetch(boundary);
    }

    // Load enabled filters and apply
    const filters = deps.db
      .prepare('SELECT * FROM filters WHERE source = ? AND enabled = 1')
      .all(source) as QuickFilter[];
    const filtered = applyFilters(rows, filters);

    // Log to audit
    auditLog.logPull(source, purpose, filtered.length, `app:${apiKey.id}`);

    return c.json({
      ok: true,
      data: filtered,
      meta: { itemsFetched: rows.length, itemsReturned: filtered.length },
    });
  });

  // POST /propose
  app.post('/propose', async (c) => {
    const body = await c.req.json();
    const { source, action_type, action_data, purpose } = body;

    if (!purpose) {
      return c.json({ ok: false, error: { code: 'BAD_REQUEST', message: 'Missing required field: purpose' } }, 400);
    }

    if (!source || !action_type) {
      return c.json({ ok: false, error: { code: 'BAD_REQUEST', message: 'Missing required fields: source, action_type' } }, 400);
    }

    const apiKey = c.get('apiKey');

    // Insert into staging
    const actionId = `act_${randomUUID().slice(0, 12)}`;
    deps.db.prepare(
      `INSERT INTO staging (action_id, manifest_id, source, action_type, action_data, purpose, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    ).run(actionId, '', source, action_type, JSON.stringify(action_data ?? {}), purpose);

    // Log to audit
    auditLog.logActionProposed(actionId, source, action_type, purpose, `app:${apiKey.id}`);

    return c.json({
      ok: true,
      actionId,
      status: 'pending_review',
    });
  });

  return app;
}

function verifyApiKey(db: Database.Database, token: string): ApiKeyRow | null {
  const rows = db.prepare('SELECT * FROM api_keys WHERE enabled = 1').all() as ApiKeyRow[];

  for (const row of rows) {
    if (compareSync(token, row.key_hash)) {
      return row;
    }
  }

  return null;
}

function readFromCache(
  db: Database.Database,
  source: string,
  sourceConfig: HubConfigParsed['sources'][string],
  encryptionKey?: string,
): DataRow[] {
  let query = 'SELECT * FROM cached_data WHERE source = ?';
  const params: unknown[] = [source];

  if (sourceConfig?.boundary?.after) {
    query += ' AND timestamp >= ?';
    params.push(sourceConfig.boundary.after);
  }

  query += " AND (expires_at IS NULL OR expires_at > datetime('now'))";

  const rows = db.prepare(query).all(...params) as Array<{
    source: string;
    source_item_id: string;
    type: string;
    timestamp: string;
    data: string;
  }>;

  return rows.map((row) => {
    let dataStr = row.data;
    if (encryptionKey) {
      try {
        dataStr = decryptField(row.data, encryptionKey);
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
