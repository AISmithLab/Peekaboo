import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { getDb } from '../db/db.js';
import { createServer } from '../server/server.js';
import type { ConnectorRegistry } from '../connectors/types.js';
import type { HubConfigParsed } from '../config/schema.js';
import type Database from 'better-sqlite3';
import type { Hono } from 'hono';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `peekaboo-gui-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
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
    app = createServer({
      db, connectorRegistry: registry, config: makeConfig(), encryptionKey: 'test',
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
    expect(text).toContain('Peekaboo');
    expect(text).toContain('Personal Data Hub');
  });

  it('GET /api/sources returns configured sources', async () => {
    const res = await app.request('/api/sources');
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; sources: Array<{ name: string }> };
    expect(json.ok).toBe(true);
    expect(json.sources).toHaveLength(2);
    expect(json.sources.map((s: { name: string }) => s.name).sort()).toEqual(['github', 'gmail']);
  });

  it('POST /api/manifests creates a manifest', async () => {
    const res = await app.request('/api/manifests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'test-manifest',
        source: 'gmail',
        purpose: 'Test',
        raw_text: '@purpose: "Test"\n@graph: pull\npull: pull { source: "gmail" }',
      }),
    });
    expect(res.status).toBe(200);

    const manifests = await app.request('/api/manifests');
    const json = await manifests.json() as { manifests: Array<{ id: string }> };
    expect(json.manifests).toHaveLength(1);
    expect(json.manifests[0].id).toBe('test-manifest');
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
});
