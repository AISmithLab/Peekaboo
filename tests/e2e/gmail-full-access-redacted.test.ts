import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupE2eApp, request, cleanup } from './helpers.js';
import type { DataRow } from '../../src/connectors/types.js';
import type Database from 'better-sqlite3';
import type { Hono } from 'hono';

describe('E2E: Gmail Full Access (no filters)', () => {
  let app: Hono;
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    ({ app, db, tmpDir } = setupE2eApp());
  });

  afterEach(() => cleanup(db, tmpDir));

  it('returns all fields when no filters are set', async () => {
    const res = await request(app, 'POST', '/app/v1/pull', {
      source: 'gmail',
      purpose: 'Full access check',
    });

    const json = await res.json() as { data: DataRow[] };
    expect(json.data.length).toBe(3);
    const row = json.data[0];
    expect(row.data.title).toBeDefined();
    expect(row.data.body).toBeDefined();
    expect(row.data.author_name).toBeDefined();
    expect(row.data.labels).toBeDefined();
  });

  it('hide_field filter removes specified fields', async () => {
    // Add a hide_field filter for body
    db.prepare(
      "INSERT INTO filters (id, source, type, value, enabled) VALUES (?, ?, ?, ?, 1)",
    ).run('f1', 'gmail', 'hide_field', 'body');

    const res = await request(app, 'POST', '/app/v1/pull', {
      source: 'gmail',
      purpose: 'Hide field check',
    });

    const json = await res.json() as { data: DataRow[] };
    for (const row of json.data) {
      expect(row.data.body).toBeUndefined();
      expect(row.data.title).toBeDefined();
    }
  });
});
