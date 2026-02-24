import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupE2eApp, request, cleanup } from './helpers.js';
import type Database from 'better-sqlite3';
import type { Hono } from 'hono';
import type { AuditLog } from '../../src/audit/log.js';
import type { SourceConnector } from '../../src/connectors/types.js';

describe('E2E: Gmail Staged Action', () => {
  let app: Hono;
  let db: Database.Database;
  let tmpDir: string;
  let audit: AuditLog;
  let connector: SourceConnector;

  beforeEach(() => {
    ({ app, db, tmpDir, audit, connector } = setupE2eApp());
  });

  afterEach(() => cleanup(db, tmpDir));

  it('propose a draft email → staging row created with pending status', async () => {
    const res = await request(app, 'POST', '/app/v1/propose', {
      source: 'gmail',
      action_type: 'draft_email',
      action_data: { to: 'alice@co.com', subject: 'Re: Q4 Report', body: 'Looks good!' },
      purpose: 'Draft reply to Alice about Q4 report',
    });

    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; actionId: string; status: string };
    expect(json.ok).toBe(true);
    expect(json.actionId).toMatch(/^act_/);
    expect(json.status).toBe('pending_review');

    // Check staging table
    const staging = db.prepare('SELECT * FROM staging WHERE action_id = ?').get(json.actionId) as Record<string, unknown>;
    expect(staging.status).toBe('pending');
    expect(staging.action_type).toBe('draft_email');
    expect(staging.purpose).toBe('Draft reply to Alice about Q4 report');
  });

  it('approve action → connector executeAction called → audit trail', async () => {
    // Propose
    const proposeRes = await request(app, 'POST', '/app/v1/propose', {
      source: 'gmail',
      action_type: 'draft_email',
      action_data: { to: 'alice@co.com', subject: 'Re: Q4', body: 'LGTM' },
      purpose: 'Draft reply',
    });
    const { actionId } = await proposeRes.json() as { actionId: string };

    // Approve via GUI API
    const approveRes = await app.request(`/api/staging/${actionId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(approveRes.status).toBe(200);

    // Verify staging status updated
    const staging = db.prepare('SELECT * FROM staging WHERE action_id = ?').get(actionId) as Record<string, unknown>;
    expect(staging.status).toBe('committed');

    // Verify audit log: proposed → approved → committed
    const entries = audit.getEntries();
    const events = entries.map(e => e.event);
    expect(events).toContain('action_proposed');
    expect(events).toContain('action_approved');
    expect(events).toContain('action_committed');
  });

  it('reject action → audit trail with rejection', async () => {
    const proposeRes = await request(app, 'POST', '/app/v1/propose', {
      source: 'gmail',
      action_type: 'send_email',
      action_data: { to: 'spam@co.com', subject: 'Spam', body: 'Spammy' },
      purpose: 'Test rejection',
    });
    const { actionId } = await proposeRes.json() as { actionId: string };

    // Reject
    await app.request(`/api/staging/${actionId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'reject' }),
    });

    const staging = db.prepare('SELECT * FROM staging WHERE action_id = ?').get(actionId) as Record<string, unknown>;
    expect(staging.status).toBe('rejected');

    const entries = audit.getEntries({ event: 'action_rejected' });
    expect(entries).toHaveLength(1);
  });
});
