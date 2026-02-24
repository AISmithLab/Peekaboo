import { Hono } from 'hono';
import { compareSync } from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ConnectorRegistry } from '../connectors/types.js';
import type { HubConfigParsed } from '../config/schema.js';
import { parseManifest } from '../manifest/parser.js';
import { executePipeline } from '../pipeline/engine.js';
import { createPipelineContext } from '../pipeline/context.js';
import { AuditLog } from '../audit/log.js';

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
    const { source, type, params, purpose } = body;

    if (!purpose) {
      return c.json({ ok: false, error: { code: 'BAD_REQUEST', message: 'Missing required field: purpose' } }, 400);
    }

    if (!source) {
      return c.json({ ok: false, error: { code: 'BAD_REQUEST', message: 'Missing required field: source' } }, 400);
    }

    const apiKey = c.get('apiKey');

    // Find a manifest for this source
    const manifest = findManifestForSource(deps.db, apiKey, source);
    if (!manifest) {
      return c.json({ ok: false, error: { code: 'NO_MANIFEST', message: `No active manifest found for source "${source}"` } }, 404);
    }

    // Parse the manifest
    const parsed = parseManifest(manifest.raw_text, manifest.id);

    // Override pull operator params if provided
    if (type || params) {
      for (const [, op] of parsed.operators) {
        if (op.type === 'pull') {
          if (type) op.properties.type = type;
          if (params) {
            Object.assign(op.properties, params);
          }
        }
      }
    }

    const sourceConfig = deps.config.sources[source];
    const cacheEnabled = sourceConfig?.cache?.enabled === true;

    const ctx = createPipelineContext({
      db: deps.db,
      connectorRegistry: deps.connectorRegistry,
      config: deps.config,
      appId: apiKey.id,
      manifestId: manifest.id,
      encryptionKey: deps.encryptionKey,
      cacheOnly: cacheEnabled,
    });

    const result = await executePipeline(parsed, ctx);

    // Log to audit
    auditLog.logPull(source, purpose, result.data.length, `app:${apiKey.id}`);

    return c.json({
      ok: true,
      data: result.data,
      meta: result.meta,
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

function findManifestForSource(
  db: Database.Database,
  apiKey: ApiKeyRow,
  source: string,
): { id: string; raw_text: string } | null {
  const allowed: string[] = JSON.parse(apiKey.allowed_manifests);

  let query: string;
  let params: unknown[];

  if (allowed.includes('*')) {
    query = "SELECT id, raw_text FROM manifests WHERE source = ? AND status = 'active' LIMIT 1";
    params = [source];
  } else {
    const placeholders = allowed.map(() => '?').join(',');
    query = `SELECT id, raw_text FROM manifests WHERE id IN (${placeholders}) AND source = ? AND status = 'active' LIMIT 1`;
    params = [...allowed, source];
  }

  return db.prepare(query).get(...params) as { id: string; raw_text: string } | undefined ?? null;
}
