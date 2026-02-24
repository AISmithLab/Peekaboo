import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupE2eApp, makeConfigWithCache, request, cleanup, makeGmailRows } from './helpers.js';
import { encryptField } from '../../src/db/encryption.js';
import type { DataRow } from '../../src/connectors/types.js';
import type Database from 'better-sqlite3';
import type { Hono } from 'hono';

describe('E2E: Gmail Cache/Sync', () => {
  let app: Hono;
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    // Use cache-enabled config so pull reads from DB
    ({ app, db, tmpDir } = setupE2eApp(undefined, makeConfigWithCache()));
  });

  afterEach(() => cleanup(db, tmpDir));

  it('syncSource populates cache, pull reads from cache', async () => {
    const { syncSource } = await import('../../src/sync/scheduler.js');
    const env = setupE2eApp(undefined, makeConfigWithCache());
    await syncSource(
      { db, connectorRegistry: env.connectorRegistry, config: env.config, encryptionKey: 'e2e-test-secret' },
      'gmail',
    );
    cleanup(env.db, env.tmpDir);

    // Verify cache is populated
    const cached = db.prepare('SELECT COUNT(*) as count FROM cached_data WHERE source = ?').get('gmail') as { count: number };
    expect(cached.count).toBe(3);

    // Pull should read from cache
    const readRes = await request(app, 'POST', '/app/v1/pull', {
      source: 'gmail',
      purpose: 'Read from cache',
    });
    expect(readRes.status).toBe(200);
    const readJson = await readRes.json() as { data: DataRow[] };
    expect(readJson.data).toHaveLength(3);
  });

  it('pre-populated cache serves pull requests', async () => {
    // Manually insert cached data
    const rows = makeGmailRows();
    const encryptionKey = 'e2e-test-secret';

    for (const row of rows) {
      const dataStr = encryptField(JSON.stringify(row.data), encryptionKey);
      db.prepare(
        `INSERT INTO cached_data (id, source, source_item_id, type, timestamp, data)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(`cache_${row.source_item_id}`, row.source, row.source_item_id, row.type, row.timestamp, dataStr);
    }

    const res = await request(app, 'POST', '/app/v1/pull', {
      source: 'gmail',
      purpose: 'Serve from pre-populated cache',
    });

    expect(res.status).toBe(200);
    const json = await res.json() as { data: DataRow[] };
    expect(json.data).toHaveLength(3);
    // All fields should be present (no select operator)
    for (const row of json.data) {
      expect(Object.keys(row.data)).toContain('title');
      expect(Object.keys(row.data)).toContain('body');
      expect(Object.keys(row.data)).toContain('labels');
    }
  });

  it('filters are applied to cached data', async () => {
    // Pre-populate cache
    const rows = makeGmailRows();
    const encryptionKey = 'e2e-test-secret';
    for (const row of rows) {
      const dataStr = encryptField(JSON.stringify(row.data), encryptionKey);
      db.prepare(
        `INSERT INTO cached_data (id, source, source_item_id, type, timestamp, data)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(`cache_${row.source_item_id}`, row.source, row.source_item_id, row.type, row.timestamp, dataStr);
    }

    // Add a filter
    db.prepare(
      "INSERT INTO filters (id, source, type, value, enabled) VALUES (?, ?, ?, ?, 1)",
    ).run('f1', 'gmail', 'subject_include', 'Q4');

    const res = await request(app, 'POST', '/app/v1/pull', {
      source: 'gmail',
      purpose: 'Filtered cache read',
    });

    const json = await res.json() as { data: DataRow[] };
    expect(json.data).toHaveLength(1);
    expect(json.data[0].data.title).toContain('Q4');
  });
});
