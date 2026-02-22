import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { hashSync } from 'bcryptjs';
import { getDb } from '../db/db.js';
import { createServer } from './server.js';
import { AuditLog } from '../audit/log.js';
import { TokenManager } from '../auth/token-manager.js';
import type { DataRow, SourceConnector, ConnectorRegistry } from '../connectors/types.js';
import type { HubConfigParsed } from '../config/schema.js';
import type Database from 'better-sqlite3';
import type { Hono } from 'hono';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `pdh-server-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const TEST_API_KEY = 'pk_test_key_123';
const TEST_KEY_HASH = hashSync(TEST_API_KEY, 10);

function makeTestRows(): DataRow[] {
  return [
    {
      source: 'gmail',
      source_item_id: 'msg_1',
      type: 'email',
      timestamp: '2026-02-20T10:00:00Z',
      data: { title: 'Q4 Report', body: 'Revenue details...' },
    },
    {
      source: 'gmail',
      source_item_id: 'msg_2',
      type: 'email',
      timestamp: '2026-02-19T08:00:00Z',
      data: { title: 'Deploy Notice', body: 'Deployment at 3pm.' },
    },
  ];
}

function makeMockConnector(): SourceConnector {
  return {
    name: 'gmail',
    async fetch() {
      return makeTestRows();
    },
    async executeAction() {
      return { success: true, message: 'done' };
    },
  };
}

function makeConfig(): HubConfigParsed {
  return {
    sources: {
      gmail: {
        enabled: true,
        owner_auth: { type: 'oauth2' },
        boundary: { after: '2026-01-01' },
        cache: { enabled: false, encrypt: true },
      },
    },
    port: 3000,
  };
}

function setupDb(db: Database.Database): void {
  // Insert API key
  db.prepare(
    'INSERT INTO api_keys (id, key_hash, name, allowed_manifests) VALUES (?, ?, ?, ?)',
  ).run('openclaw', TEST_KEY_HASH, 'OpenClaw Agent', '["*"]');

  // Insert a manifest for gmail
  const manifestText = `
@purpose: "Search emails"
@graph: pull_emails -> select_fields
pull_emails: pull { source: "gmail", type: "email" }
select_fields: select { fields: ["title", "body", "timestamp"] }
`;
  db.prepare(
    "INSERT INTO manifests (id, source, purpose, raw_text, status) VALUES (?, ?, ?, ?, 'active')",
  ).run('gmail-search', 'gmail', 'Search emails', manifestText);
}

async function request(app: Hono, method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  const init: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  };
  if (body) {
    init.body = JSON.stringify(body);
  }
  return app.request(path, init);
}

describe('HTTP Server', () => {
  let tmpDir: string;
  let db: Database.Database;
  let app: Hono;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    db = getDb(join(tmpDir, 'test.db'));
    setupDb(db);

    const registry: ConnectorRegistry = new Map([['gmail', makeMockConnector()]]);
    const tokenManager = new TokenManager(db, 'test-secret');
    app = createServer({
      db,
      connectorRegistry: registry,
      config: makeConfig(),
      encryptionKey: 'test-secret',
      tokenManager,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('POST /app/v1/pull without valid API key → 401', async () => {
    const res = await request(app, 'POST', '/app/v1/pull', {
      source: 'gmail',
      purpose: 'test',
    });
    expect(res.status).toBe(401);
  });

  it('POST /app/v1/pull with invalid bearer token → 401', async () => {
    const res = await request(app, 'POST', '/app/v1/pull', {
      source: 'gmail',
      purpose: 'test',
    }, { Authorization: 'Bearer invalid_key' });
    expect(res.status).toBe(401);
  });

  it('POST /app/v1/pull with valid key and purpose → returns data, audit log entry', async () => {
    const res = await request(app, 'POST', '/app/v1/pull', {
      source: 'gmail',
      type: 'email',
      purpose: 'Find Q4 report emails',
    }, { Authorization: `Bearer ${TEST_API_KEY}` });

    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; data: DataRow[] };
    expect(json.ok).toBe(true);
    expect(json.data.length).toBeGreaterThan(0);

    // Check audit log
    const audit = new AuditLog(db);
    const entries = audit.getEntries({ event: 'data_pull' });
    expect(entries).toHaveLength(1);
    expect(entries[0].details.purpose).toBe('Find Q4 report emails');
  });

  it('POST /app/v1/pull without purpose → 400', async () => {
    const res = await request(app, 'POST', '/app/v1/pull', {
      source: 'gmail',
    }, { Authorization: `Bearer ${TEST_API_KEY}` });

    expect(res.status).toBe(400);
    const json = await res.json() as { ok: boolean; error: { message: string } };
    expect(json.ok).toBe(false);
    expect(json.error.message).toContain('purpose');
  });

  it('POST /app/v1/propose with valid key and purpose → creates staging row, audit entry', async () => {
    const res = await request(app, 'POST', '/app/v1/propose', {
      source: 'gmail',
      action_type: 'draft_email',
      action_data: { to: 'alice@co.com', subject: 'Re: Q4', body: 'Looks good.' },
      purpose: 'Draft reply to Alice about Q4 report',
    }, { Authorization: `Bearer ${TEST_API_KEY}` });

    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; actionId: string; status: string };
    expect(json.ok).toBe(true);
    expect(json.actionId).toMatch(/^act_/);
    expect(json.status).toBe('pending_review');

    // Check staging table
    const staging = db.prepare('SELECT * FROM staging').all() as Array<Record<string, unknown>>;
    expect(staging).toHaveLength(1);
    expect(staging[0].status).toBe('pending');

    // Check audit log
    const audit = new AuditLog(db);
    const entries = audit.getEntries({ event: 'action_proposed' });
    expect(entries).toHaveLength(1);
    expect(entries[0].details.purpose).toBe('Draft reply to Alice about Q4 report');
  });

  it('GET /health → 200', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean };
    expect(json.ok).toBe(true);
  });
});
