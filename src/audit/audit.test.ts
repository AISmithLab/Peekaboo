import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { getDb } from '../db/db.js';
import { AuditLog } from './log.js';
import type Database from 'better-sqlite3';
import { makeTmpDir } from '../test-utils.js';

describe('AuditLog', () => {
  let tmpDir: string;
  let db: Database.Database;
  let audit: AuditLog;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    db = getDb(join(tmpDir, 'test.db'));
    audit = new AuditLog(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('logPull creates entry with event "data_pull" and purpose', () => {
    audit.logPull('gmail', 'Find Q4 report emails', 3, 'app:openclaw');

    const entries = audit.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].event).toBe('data_pull');
    expect(entries[0].source).toBe('gmail');
    expect(entries[0].details.purpose).toBe('Find Q4 report emails');
    expect(entries[0].details.resultsReturned).toBe(3);
    expect(entries[0].details.initiatedBy).toBe('app:openclaw');
  });

  it('logActionProposed creates entry with purpose and action_type', () => {
    audit.logActionProposed('act_123', 'gmail', 'draft_email', 'Draft reply to Alice', 'app:openclaw');

    const entries = audit.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].event).toBe('action_proposed');
    expect(entries[0].details.purpose).toBe('Draft reply to Alice');
    expect(entries[0].details.action_type).toBe('draft_email');
    expect(entries[0].details.actionId).toBe('act_123');
  });

  it('proposed → approved → committed creates 3 entries in order', () => {
    audit.logActionProposed('act_456', 'gmail', 'send_email', 'Send reply', 'app:openclaw');
    audit.logActionApproved('act_456', 'owner');
    audit.logActionCommitted('act_456', 'gmail', 'success');

    const entries = audit.getEntries();
    expect(entries).toHaveLength(3);
    expect(entries[0].event).toBe('action_proposed');
    expect(entries[1].event).toBe('action_approved');
    expect(entries[2].event).toBe('action_committed');

    expect(entries[1].details.actionId).toBe('act_456');
    expect(entries[1].details.initiatedBy).toBe('owner');
    expect(entries[2].details.result).toBe('success');
  });

  it('logActionRejected creates entry with event "action_rejected"', () => {
    audit.logActionRejected('act_789', 'owner');

    const entries = audit.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].event).toBe('action_rejected');
    expect(entries[0].details.actionId).toBe('act_789');
    expect(entries[0].details.initiatedBy).toBe('owner');
  });

  it('getEntries({ event: "data_pull" }) filters correctly', () => {
    audit.logPull('gmail', 'Search emails', 5, 'app:openclaw');
    audit.logActionProposed('act_1', 'gmail', 'draft_email', 'Draft', 'app:openclaw');
    audit.logPull('github', 'Search issues', 10, 'app:openclaw');

    const pulls = audit.getEntries({ event: 'data_pull' });
    expect(pulls).toHaveLength(2);
    expect(pulls[0].source).toBe('gmail');
    expect(pulls[1].source).toBe('github');
  });

  it('getEntries({ after }) filters by time', () => {
    // Insert entries with known timestamps
    db.prepare(
      `INSERT INTO audit_log (timestamp, event, source, details) VALUES (?, ?, ?, ?)`,
    ).run('2026-02-19T10:00:00.000Z', 'data_pull', 'gmail', '{"purpose":"old"}');
    db.prepare(
      `INSERT INTO audit_log (timestamp, event, source, details) VALUES (?, ?, ?, ?)`,
    ).run('2026-02-21T10:00:00.000Z', 'data_pull', 'gmail', '{"purpose":"new"}');

    const entries = audit.getEntries({ after: '2026-02-20T00:00:00.000Z' });
    expect(entries).toHaveLength(1);
    expect(entries[0].details.purpose).toBe('new');
  });

  it('entries are append-only (no update/delete methods exposed)', () => {
    audit.logPull('gmail', 'test', 1, 'app:test');

    // AuditLog class has no update or delete methods
    expect(typeof (audit as unknown as Record<string, unknown>).updateEntry).toBe('undefined');
    expect(typeof (audit as unknown as Record<string, unknown>).deleteEntry).toBe('undefined');
  });

});
