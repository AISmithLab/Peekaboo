import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupE2eApp, request, cleanup } from './helpers.js';
import type { DataRow } from '../../src/connectors/types.js';
import type Database from 'better-sqlite3';
import type { Hono } from 'hono';
import type { AuditLog } from '../../src/audit/log.js';

describe('E2E: Gmail with Time and Sender Filters', () => {
  let app: Hono;
  let db: Database.Database;
  let tmpDir: string;
  let audit: AuditLog;

  beforeEach(() => {
    ({ app, db, tmpDir, audit } = setupE2eApp());
  });

  afterEach(() => cleanup(db, tmpDir));

  it('time_after filter excludes old emails', async () => {
    db.prepare(
      "INSERT INTO filters (id, source, type, value, enabled) VALUES (?, ?, ?, ?, 1)",
    ).run('f1', 'gmail', 'time_after', '2026-02-19T09:00:00Z');

    const res = await request(app, 'POST', '/app/v1/pull', {
      source: 'gmail',
      purpose: 'Time filter check',
    });

    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; data: DataRow[] };
    expect(json.ok).toBe(true);
    // Only msg_e2e_1 (Feb 20) should pass; msg_e2e_2 (Feb 19 08:00) and msg_e2e_3 (Feb 18) excluded
    expect(json.data.length).toBe(1);
    expect(json.data[0].source_item_id).toBe('msg_e2e_1');
  });

  it('from_include filter keeps only matching senders', async () => {
    db.prepare(
      "INSERT INTO filters (id, source, type, value, enabled) VALUES (?, ?, ?, ?, 1)",
    ).run('f1', 'gmail', 'from_include', 'bob');

    const res = await request(app, 'POST', '/app/v1/pull', {
      source: 'gmail',
      purpose: 'Sender filter check',
    });

    const json = await res.json() as { ok: boolean; data: DataRow[] };
    expect(json.ok).toBe(true);
    expect(json.data.length).toBe(1);
    expect(json.data[0].data.author_email).toContain('bob');
  });

  it('creates audit log entry', async () => {
    await request(app, 'POST', '/app/v1/pull', {
      source: 'gmail',
      purpose: 'Audit test',
    });

    const entries = audit.getEntries({ event: 'data_pull' });
    expect(entries).toHaveLength(1);
    expect(entries[0].details.purpose).toBe('Audit test');
    expect(entries[0].details.resultsReturned).toBe(3);
  });
});
