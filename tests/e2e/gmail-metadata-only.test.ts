import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupE2eApp, request, cleanup } from './helpers.js';
import type { DataRow } from '../../src/connectors/types.js';
import type Database from 'better-sqlite3';
import type { Hono } from 'hono';

describe('E2E: Gmail with Quick Filters', () => {
  let app: Hono;
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    ({ app, db, tmpDir } = setupE2eApp());
  });

  afterEach(() => cleanup(db, tmpDir));

  it('subject_include filter keeps only matching emails', async () => {
    db.prepare(
      "INSERT INTO filters (id, source, type, value, enabled) VALUES (?, ?, ?, ?, 1)",
    ).run('f1', 'gmail', 'subject_include', 'Q4');

    const res = await request(app, 'POST', '/app/v1/pull', {
      source: 'gmail',
      purpose: 'Subject filter check',
    });

    const json = await res.json() as { ok: boolean; data: DataRow[] };
    expect(json.ok).toBe(true);
    expect(json.data.length).toBe(1);
    expect(json.data[0].data.title).toContain('Q4');
  });

  it('exclude_sender filter removes matching emails', async () => {
    db.prepare(
      "INSERT INTO filters (id, source, type, value, enabled) VALUES (?, ?, ?, ?, 1)",
    ).run('f1', 'gmail', 'exclude_sender', 'alice');

    const res = await request(app, 'POST', '/app/v1/pull', {
      source: 'gmail',
      purpose: 'Exclude sender check',
    });

    const json = await res.json() as { ok: boolean; data: DataRow[] };
    expect(json.ok).toBe(true);
    // Alice's email should be excluded
    for (const row of json.data) {
      const sender = String(row.data.author_email || row.data.author_name || '').toLowerCase();
      expect(sender).not.toContain('alice');
    }
  });

  it('disabled filters are not applied', async () => {
    db.prepare(
      "INSERT INTO filters (id, source, type, value, enabled) VALUES (?, ?, ?, ?, 0)",
    ).run('f1', 'gmail', 'subject_include', 'Q4');

    const res = await request(app, 'POST', '/app/v1/pull', {
      source: 'gmail',
      purpose: 'Disabled filter check',
    });

    const json = await res.json() as { ok: boolean; data: DataRow[] };
    expect(json.ok).toBe(true);
    expect(json.data.length).toBe(3); // All emails returned
  });
});
