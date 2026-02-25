import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ConnectorRegistry, DataRow } from '../connectors/types.js';
import type { HubConfigParsed } from '../config/schema.js';
import type { TokenManager } from '../auth/token-manager.js';
import { AuditLog } from '../audit/log.js';
import { applyFilters, type QuickFilter } from '../filters.js';

export interface AppApiDeps {
  db: Database.Database;
  connectorRegistry: ConnectorRegistry;
  config: HubConfigParsed;
  tokenManager: TokenManager;
}

export function createAppApi(deps: AppApiDeps): Hono {
  const app = new Hono();
  const auditLog = new AuditLog(deps.db);

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

    const sourceConfig = deps.config.sources[source];
    if (!sourceConfig) {
      return c.json({ ok: false, error: { code: 'NOT_FOUND', message: `Unknown source: "${source}"` } }, 404);
    }

    // Fetch live from connector
    const connector = deps.connectorRegistry.get(source);
    if (!connector) {
      return c.json({ ok: false, error: { code: 'NOT_FOUND', message: `No connector for source: "${source}"` } }, 404);
    }
    const boundary = sourceConfig.boundary ?? {};
    const rows = await connector.fetch(boundary);

    // Load enabled filters and apply
    const filters = deps.db
      .prepare('SELECT * FROM filters WHERE source = ? AND enabled = 1')
      .all(source) as QuickFilter[];
    const filtered = applyFilters(rows, filters);

    // Log to audit
    auditLog.logPull(source, purpose, filtered.length, 'agent');

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

    // Insert into staging
    const actionId = `act_${randomUUID().slice(0, 12)}`;
    deps.db.prepare(
      `INSERT INTO staging (action_id, manifest_id, source, action_type, action_data, purpose, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    ).run(actionId, '', source, action_type, JSON.stringify(action_data ?? {}), purpose);

    // Log to audit
    auditLog.logActionProposed(actionId, source, action_type, purpose, 'agent');

    return c.json({
      ok: true,
      actionId,
      status: 'pending_review',
    });
  });

  // GET /sources — discover which sources are connected (have OAuth tokens)
  app.get('/sources', (c) => {
    const sources: Record<string, { connected: boolean }> = {};
    for (const [name] of deps.connectorRegistry) {
      const hasToken = deps.tokenManager.hasToken(name);
      sources[name] = { connected: hasToken };
    }
    return c.json({ ok: true, sources });
  });

  return app;
}
