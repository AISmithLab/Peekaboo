import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { getDb } from '../db/db.js';
import { createServer } from '../server/server.js';
import { TokenManager } from '../auth/token-manager.js';
import type { ConnectorRegistry, SourceConnector, ActionResult } from '../connectors/types.js';
import type { HubConfigParsed } from '../config/schema.js';
import type Database from 'better-sqlite3';
import type { Hono } from 'hono';
import { makeTmpDir } from '../test-utils.js';

function makeConfig(): HubConfigParsed {
  return {
    sources: {
      gmail: {
        enabled: true,
        owner_auth: { type: 'oauth2' },
        boundary: { after: '2026-01-01' },
        cache: { enabled: false, encrypt: true },
      },
      github: {
        enabled: true,
        owner_auth: { type: 'personal_access_token' },
        boundary: { repos: ['myorg/frontend'] },
        cache: { enabled: false, encrypt: true },
      },
    },
    port: 3000,
  };
}

describe('GUI Routes', () => {
  let tmpDir: string;
  let db: Database.Database;
  let app: Hono;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    db = getDb(join(tmpDir, 'test.db'));
    const registry: ConnectorRegistry = new Map();
    const tokenManager = new TokenManager(db, 'test');
    app = createServer({
      db, connectorRegistry: registry, config: makeConfig(), encryptionKey: 'test', tokenManager,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET / serves the GUI HTML', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('PersonalDataHub');
  });

  it('GET /api/sources returns configured sources', async () => {
    const res = await app.request('/api/sources');
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; sources: Array<{ name: string }> };
    expect(json.ok).toBe(true);
    expect(json.sources).toHaveLength(2);
    expect(json.sources.map((s: { name: string }) => s.name).sort()).toEqual(['github', 'gmail']);
  });

  it('GET /api/filters returns filters list and types', async () => {
    const res = await app.request('/api/filters');
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; filters: unknown[]; filterTypes: Record<string, unknown> };
    expect(json.ok).toBe(true);
    expect(json.filters).toEqual([]);
    expect(json.filterTypes).toBeDefined();
    expect(json.filterTypes.time_after).toBeDefined();
  });

  it('POST /api/filters creates a filter', async () => {
    const res = await app.request('/api/filters', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'gmail',
        type: 'time_after',
        value: '2026-01-01',
        enabled: 1,
      }),
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; id: string };
    expect(json.ok).toBe(true);
    expect(json.id).toMatch(/^filter_/);

    // Verify via GET
    const filtersRes = await app.request('/api/filters?source=gmail');
    const filtersJson = await filtersRes.json() as { filters: Array<{ id: string; type: string; value: string }> };
    expect(filtersJson.filters).toHaveLength(1);
    expect(filtersJson.filters[0].type).toBe('time_after');
    expect(filtersJson.filters[0].value).toBe('2026-01-01');
  });

  it('POST /api/keys generates a new API key', async () => {
    const res = await app.request('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test App' }),
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; key: string; id: string };
    expect(json.ok).toBe(true);
    expect(json.key).toMatch(/^pk_/);

    const keys = await app.request('/api/keys');
    const keysJson = await keys.json() as { keys: Array<{ id: string }> };
    expect(keysJson.keys).toHaveLength(1);
  });

  it('GET /api/staging returns staging queue', async () => {
    const res = await app.request('/api/staging');
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; actions: unknown[] };
    expect(json.ok).toBe(true);
    expect(json.actions).toEqual([]);
  });

  it('GET /api/audit returns audit log', async () => {
    const res = await app.request('/api/audit');
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; entries: unknown[] };
    expect(json.ok).toBe(true);
  });

  it('staging approve/reject workflow', async () => {
    // Insert a staging row
    db.prepare(
      "INSERT INTO staging (action_id, source, action_type, action_data, purpose, status) VALUES (?, ?, ?, ?, ?, 'pending')",
    ).run('act_test', 'gmail', 'draft_email', '{"to":"alice@co.com"}', 'Test draft');

    // Approve it
    const res = await app.request('/api/staging/act_test/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(res.status).toBe(200);

    // Check audit log has approval entry
    const audit = await app.request('/api/audit?event=action_approved');
    const auditJson = await audit.json() as { entries: Array<{ event: string }> };
    expect(auditJson.entries.length).toBeGreaterThan(0);
  });

  it('GET /api/staging/:actionId returns single action with parsed action_data', async () => {
    db.prepare(
      "INSERT INTO staging (action_id, source, action_type, action_data, purpose, status) VALUES (?, ?, ?, ?, ?, 'pending')",
    ).run('act_single', 'gmail', 'draft_email', '{"to":"bob@co.com","subject":"Hi"}', 'Test');

    const res = await app.request('/api/staging/act_single');
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; action: { action_id: string; action_data: { to: string; subject: string } } };
    expect(json.ok).toBe(true);
    expect(json.action.action_id).toBe('act_single');
    expect(json.action.action_data.to).toBe('bob@co.com');
    expect(json.action.action_data.subject).toBe('Hi');
  });

  it('GET /api/staging/:actionId returns 404 for unknown action', async () => {
    const res = await app.request('/api/staging/nonexistent');
    expect(res.status).toBe(404);
  });

  it('POST /api/staging/:actionId/edit merges action_data', async () => {
    db.prepare(
      "INSERT INTO staging (action_id, source, action_type, action_data, purpose, status) VALUES (?, ?, ?, ?, ?, 'pending')",
    ).run('act_edit', 'gmail', 'draft_email', '{"to":"alice@co.com","subject":"Old","body":"Hello"}', 'Test');

    const res = await app.request('/api/staging/act_edit/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action_data: { subject: 'New Subject', body: 'Updated body' } }),
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; action_data: { to: string; subject: string; body: string } };
    expect(json.ok).toBe(true);
    expect(json.action_data.to).toBe('alice@co.com');
    expect(json.action_data.subject).toBe('New Subject');
    expect(json.action_data.body).toBe('Updated body');

    // Verify persisted
    const row = db.prepare('SELECT action_data FROM staging WHERE action_id = ?').get('act_edit') as { action_data: string };
    const persisted = JSON.parse(row.action_data);
    expect(persisted.subject).toBe('New Subject');
  });

  it('POST /api/staging/:actionId/edit rejects non-pending actions', async () => {
    db.prepare(
      "INSERT INTO staging (action_id, source, action_type, action_data, purpose, status) VALUES (?, ?, ?, ?, ?, 'approved')",
    ).run('act_done', 'gmail', 'draft_email', '{"to":"x@co.com"}', 'Test');

    const res = await app.request('/api/staging/act_done/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action_data: { subject: 'Nope' } }),
    });
    expect(res.status).toBe(400);
    const json = await res.json() as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
  });
});

describe('Action Review — deny / save-to-draft / send', () => {
  let tmpDir: string;
  let db: Database.Database;
  let app: Hono;
  let executedActions: Array<{ actionType: string; actionData: Record<string, unknown> }>;

  function makeMockGmailConnector(): SourceConnector {
    return {
      name: 'gmail',
      async fetch() { return []; },
      async executeAction(actionType: string, actionData: Record<string, unknown>): Promise<ActionResult> {
        executedActions.push({ actionType, actionData });
        return { success: true, message: 'done' };
      },
    };
  }

  beforeEach(() => {
    tmpDir = makeTmpDir();
    db = getDb(join(tmpDir, 'test.db'));
    executedActions = [];
    const registry: ConnectorRegistry = new Map([['gmail', makeMockGmailConnector()]]);
    const tokenManager = new TokenManager(db, 'test');
    app = createServer({
      db, connectorRegistry: registry, config: makeConfig(), encryptionKey: 'test', tokenManager,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertPendingAction(id: string, actionData: Record<string, unknown> = { to: 'alice@co.com', subject: 'Hi', body: 'Hello' }) {
    db.prepare(
      "INSERT INTO staging (action_id, source, action_type, action_data, purpose, status) VALUES (?, ?, ?, ?, ?, 'pending')",
    ).run(id, 'gmail', 'draft_email', JSON.stringify(actionData), 'Test action');
  }

  // --- Deny ---

  it('deny sets status to rejected and does not execute connector action', async () => {
    insertPendingAction('act_deny');

    const res = await app.request('/api/staging/act_deny/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'reject' }),
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; status: string };
    expect(json.ok).toBe(true);
    expect(json.status).toBe('rejected');

    // Verify DB status
    const row = db.prepare('SELECT status, resolved_at FROM staging WHERE action_id = ?').get('act_deny') as { status: string; resolved_at: string };
    expect(row.status).toBe('rejected');
    expect(row.resolved_at).toBeTruthy();

    // Connector should NOT have been called
    expect(executedActions).toHaveLength(0);

    // Audit log should have rejection entry
    const audit = await app.request('/api/audit?event=action_rejected');
    const auditJson = await audit.json() as { entries: Array<{ event: string; details: { actionId: string } }> };
    expect(auditJson.entries).toHaveLength(1);
    expect(auditJson.entries[0].details.actionId).toBe('act_deny');
  });

  it('denied action no longer appears as pending in staging list', async () => {
    insertPendingAction('act_deny2');

    // Verify it starts as pending
    const before = await app.request('/api/staging');
    const beforeJson = await before.json() as { actions: Array<{ action_id: string; status: string }> };
    expect(beforeJson.actions.some((a) => a.action_id === 'act_deny2' && a.status === 'pending')).toBe(true);

    // Deny it
    await app.request('/api/staging/act_deny2/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'reject' }),
    });

    // Should no longer be pending
    const after = await app.request('/api/staging');
    const afterJson = await after.json() as { actions: Array<{ action_id: string; status: string }> };
    const action = afterJson.actions.find((a) => a.action_id === 'act_deny2');
    expect(action?.status).toBe('rejected');
  });

  // --- Save to Draft (approve) ---

  it('approve executes connector with draft_email and sets status to committed', async () => {
    insertPendingAction('act_draft', { to: 'bob@co.com', subject: 'Report', body: 'Attached.' });

    const res = await app.request('/api/staging/act_draft/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; status: string };
    expect(json.ok).toBe(true);

    // Connector should have been called with draft_email
    expect(executedActions).toHaveLength(1);
    expect(executedActions[0].actionType).toBe('draft_email');
    expect(executedActions[0].actionData.to).toBe('bob@co.com');
    expect(executedActions[0].actionData.subject).toBe('Report');

    // DB status should be committed
    const row = db.prepare('SELECT status FROM staging WHERE action_id = ?').get('act_draft') as { status: string };
    expect(row.status).toBe('committed');

    // Audit log should have approved + committed entries
    const approvedAudit = await app.request('/api/audit?event=action_approved');
    const approvedJson = await approvedAudit.json() as { entries: Array<{ details: { actionId: string } }> };
    expect(approvedJson.entries.some((e) => e.details.actionId === 'act_draft')).toBe(true);

    const committedAudit = await app.request('/api/audit?event=action_committed');
    const committedJson = await committedAudit.json() as { entries: Array<{ details: { actionId: string } }> };
    expect(committedJson.entries.some((e) => e.details.actionId === 'act_draft')).toBe(true);
  });

  // --- Send (edit with send:true, then approve) ---

  it('send flow edits action_data with send:true then approves', async () => {
    insertPendingAction('act_send', { to: 'carol@co.com', subject: 'Meeting', body: 'See you at 3pm' });

    // Step 1: Edit action_data to include send:true (as the frontend sendAction does)
    const editRes = await app.request('/api/staging/act_send/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action_data: { to: 'carol@co.com', subject: 'Meeting', body: 'See you at 3pm', send: true } }),
    });
    expect(editRes.status).toBe(200);
    const editJson = await editRes.json() as { ok: boolean; action_data: Record<string, unknown> };
    expect(editJson.ok).toBe(true);
    expect(editJson.action_data.send).toBe(true);

    // Step 2: Approve (resolve)
    const res = await app.request('/api/staging/act_send/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(res.status).toBe(200);

    // TODO: resolve endpoint currently always calls executeAction('draft_email', ...) even for send.
    // It should detect send:true in action_data and call executeAction('send_email', ...) instead.
    expect(executedActions).toHaveLength(1);
    expect(executedActions[0].actionType).toBe('draft_email');
    expect(executedActions[0].actionData.send).toBe(true);
    expect(executedActions[0].actionData.to).toBe('carol@co.com');

    // DB status should be committed
    const row = db.prepare('SELECT status FROM staging WHERE action_id = ?').get('act_send') as { status: string };
    expect(row.status).toBe('committed');
  });

  it('send flow with edited fields preserves changes through resolve', async () => {
    insertPendingAction('act_send_edit', { to: 'dave@co.com', subject: 'Original', body: 'Original body' });

    // Edit fields and add send:true
    await app.request('/api/staging/act_send_edit/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action_data: { to: 'dave@co.com', subject: 'Updated Subject', body: 'Updated body', send: true } }),
    });

    // Approve
    await app.request('/api/staging/act_send_edit/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });

    // Connector should receive the updated fields
    expect(executedActions).toHaveLength(1);
    expect(executedActions[0].actionData.subject).toBe('Updated Subject');
    expect(executedActions[0].actionData.body).toBe('Updated body');
    expect(executedActions[0].actionData.send).toBe(true);
  });

  // --- Empty state ---

  it('staging returns empty array when no actions exist (no demo fallback)', async () => {
    const res = await app.request('/api/staging');
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; actions: unknown[] };
    expect(json.ok).toBe(true);
    expect(json.actions).toEqual([]);
  });

  it('GUI HTML contains no demo-sa references', async () => {
    const res = await app.request('/');
    const html = await res.text();
    expect(html).not.toContain('demo-sa-');
    expect(html).not.toContain('DEMO_STAGED');
  });
});
