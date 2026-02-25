import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { hashSync } from 'bcryptjs';
import { getDb } from '../../src/db/db.js';
import { createServer } from '../../src/server/server.js';
import { TokenManager } from '../../src/auth/token-manager.js';
import { AuditLog } from '../../src/audit/log.js';
import type { DataRow, SourceConnector, ConnectorRegistry } from '../../src/connectors/types.js';
import type { HubConfigParsed } from '../../src/config/schema.js';
import type Database from 'better-sqlite3';
import type { Hono } from 'hono';

export function makeTmpDir(): string {
  const dir = join(tmpdir(), `pdh-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function makeGmailRows(): DataRow[] {
  return [
    {
      source: 'gmail',
      source_item_id: 'msg_e2e_1',
      type: 'email',
      timestamp: '2026-02-20T10:00:00Z',
      data: {
        title: 'Q4 Report Draft',
        body: 'Revenue was $2.3M. SSN: 123-45-6789. Phone: 555-123-4567. Card: 4111111111111111.',
        author_name: 'Alice Smith',
        author_email: 'alice@company.com',
        participants: [{ name: 'Bob', email: 'bob@co.com', role: 'to' }],
        labels: ['INBOX', 'IMPORTANT'],
        timestamp_field: '2026-02-20T10:00:00Z',
        url: 'https://mail.google.com/mail/u/0/#inbox/msg_e2e_1',
        threadId: 'thread_1',
        isUnread: true,
        snippet: 'Revenue was $2.3M...',
      },
    },
    {
      source: 'gmail',
      source_item_id: 'msg_e2e_2',
      type: 'email',
      timestamp: '2026-02-19T08:00:00Z',
      data: {
        title: 'Deployment Failed',
        body: 'Deploy to prod failed at 3am. SSN: 987-65-4321. Need to fix ASAP.',
        author_name: 'Bob Jones',
        author_email: 'bob@company.com',
        participants: [{ name: 'Alice', email: 'alice@co.com', role: 'to' }],
        labels: ['INBOX'],
        timestamp_field: '2026-02-19T08:00:00Z',
        url: 'https://mail.google.com/mail/u/0/#inbox/msg_e2e_2',
        threadId: 'thread_2',
        isUnread: false,
        snippet: 'Deploy to prod failed...',
      },
    },
    {
      source: 'gmail',
      source_item_id: 'msg_e2e_3',
      type: 'email',
      timestamp: '2026-02-18T12:00:00Z',
      data: {
        title: 'Holiday Plans',
        body: 'Planning vacation for March. ' + 'A'.repeat(6000),
        author_name: 'Charlie',
        author_email: 'charlie@company.com',
        participants: [],
        labels: ['INBOX', 'PERSONAL'],
        timestamp_field: '2026-02-18T12:00:00Z',
        url: 'https://mail.google.com/mail/u/0/#inbox/msg_e2e_3',
        threadId: 'thread_3',
        isUnread: true,
        snippet: 'Planning vacation...',
      },
    },
  ];
}

export function makeMockGmailConnector(rows: DataRow[]): SourceConnector {
  let executeActionCalled = false;
  return {
    name: 'gmail',
    async fetch() {
      return rows;
    },
    async executeAction(actionType, actionData) {
      executeActionCalled = true;
      return { success: true, message: `Executed: ${actionType}`, resultData: { executed: true } };
    },
    get _executeActionCalled() { return executeActionCalled; },
  } as SourceConnector & { _executeActionCalled: boolean };
}

export function makeConfig(): HubConfigParsed {
  return {
    sources: {
      gmail: {
        enabled: true,
        owner_auth: { type: 'oauth2' },
        boundary: { after: '2026-01-01' },
      },
    },
    port: 3000,
  };
}

export function setupE2eApp(gmailRows?: DataRow[], configOverride?: HubConfigParsed): {
  app: Hono;
  db: Database.Database;
  tmpDir: string;
  audit: AuditLog;
  connector: SourceConnector;
  config: HubConfigParsed;
  connectorRegistry: ConnectorRegistry;
  sessionCookie: string;
} {
  const tmpDir = makeTmpDir();
  const db = getDb(join(tmpDir, 'test.db'));

  // Set up owner auth and a session for GUI admin endpoints
  db.prepare('INSERT INTO owner_auth (id, password_hash) VALUES (1, ?)').run(hashSync('e2e-test-pass', 10));
  const sessionToken = 'e2e-session-token';
  db.prepare("INSERT INTO sessions (token, expires_at) VALUES (?, datetime('now', '+1 day'))").run(sessionToken);

  const connector = makeMockGmailConnector(gmailRows ?? makeGmailRows());
  const registry: ConnectorRegistry = new Map([['gmail', connector]]);
  const config = configOverride ?? makeConfig();

  const tokenManager = new TokenManager(db, 'e2e-test-secret');
  // Store a mock token so the source counts as "connected"
  tokenManager.storeToken('gmail', { access_token: 'mock-access', refresh_token: 'mock-refresh' });

  const app = createServer({
    db,
    connectorRegistry: registry,
    config,
    tokenManager,
  });

  const audit = new AuditLog(db);

  return { app, db, tmpDir, audit, connector, config, connectorRegistry: registry, sessionCookie: `pdh_session=${sessionToken}` };
}

export async function request(
  app: Hono,
  method: string,
  path: string,
  body?: unknown,
) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  const init: RequestInit = { method, headers };
  if (body) {
    init.body = JSON.stringify(body);
  }
  return app.request(path, init);
}

export function cleanup(db: Database.Database, tmpDir: string): void {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
}
