import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { getDb } from './db/db.js';
import { loadDemoData, unloadDemoData } from './demo.js';
import { DEMO_EMAILS } from './fixtures/emails.js';
import { parseManifest } from './manifest/parser.js';
import { executePipeline } from './pipeline/engine.js';
import { createPipelineContext } from './pipeline/context.js';
import type { ConnectorRegistry } from './connectors/types.js';
import type { HubConfigParsed } from './config/schema.js';
import type Database from 'better-sqlite3';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `pdh-demo-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('Demo data', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    db = getDb(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loadDemoData inserts expected number of emails and manifests', () => {
    const result = loadDemoData(db);
    expect(result.emailCount).toBe(DEMO_EMAILS.length);
    expect(result.manifestCount).toBe(3);

    const emails = db.prepare('SELECT * FROM cached_data').all();
    expect(emails).toHaveLength(DEMO_EMAILS.length);

    const manifests = db.prepare('SELECT * FROM manifests').all();
    expect(manifests).toHaveLength(3);
  });

  it('unloadDemoData removes all demo data', () => {
    loadDemoData(db);
    const result = unloadDemoData(db);
    expect(result.emailsRemoved).toBe(DEMO_EMAILS.length);
    expect(result.manifestsRemoved).toBe(3);

    const emails = db.prepare('SELECT * FROM cached_data').all();
    expect(emails).toHaveLength(0);

    const manifests = db.prepare('SELECT * FROM manifests').all();
    expect(manifests).toHaveLength(0);
  });

  it('load is idempotent — running twice does not duplicate', () => {
    loadDemoData(db);
    loadDemoData(db);

    const emails = db.prepare('SELECT * FROM cached_data').all();
    expect(emails).toHaveLength(DEMO_EMAILS.length);

    const manifests = db.prepare('SELECT * FROM manifests').all();
    expect(manifests).toHaveLength(3);
  });

  it('unload on empty DB is a no-op (returns 0)', () => {
    const result = unloadDemoData(db);
    expect(result.emailsRemoved).toBe(0);
    expect(result.manifestsRemoved).toBe(0);
  });

  it('demo emails are pullable via the pull operator (end-to-end)', async () => {
    loadDemoData(db);

    // Read back a manifest to use for the pipeline
    const row = db.prepare("SELECT * FROM manifests WHERE id = 'demo-gmail-readonly'").get() as {
      raw_text: string;
      id: string;
    };
    expect(row).toBeDefined();

    const manifest = parseManifest(row.raw_text, row.id);

    // Empty connector registry — pull should read from cached_data instead
    const registry: ConnectorRegistry = new Map();
    const config: HubConfigParsed = {
      sources: {
        gmail: {
          enabled: true,
          owner_auth: { type: 'oauth2' },
          boundary: {},
          cache: { enabled: true, ttl: '7d', encrypt: false },
        },
      },
      port: 3000,
    };

    const ctx = createPipelineContext({
      db,
      connectorRegistry: registry,
      config,
      appId: 'test',
      manifestId: row.id,
    });

    const result = await executePipeline(manifest, ctx);
    expect(result.data.length).toBe(DEMO_EMAILS.length);

    // The select operator should have narrowed to only these fields
    for (const item of result.data) {
      const keys = Object.keys(item.data).sort();
      expect(keys).toEqual(['author_name', 'body', 'labels', 'title']);
    }
  });

  it('demo redacted manifest strips SSNs from email bodies', async () => {
    loadDemoData(db);

    const row = db.prepare("SELECT * FROM manifests WHERE id = 'demo-gmail-redacted'").get() as {
      raw_text: string;
      id: string;
    };

    const manifest = parseManifest(row.raw_text, row.id);
    const registry: ConnectorRegistry = new Map();
    const config: HubConfigParsed = {
      sources: {
        gmail: {
          enabled: true,
          owner_auth: { type: 'oauth2' },
          boundary: {},
          cache: { enabled: true, ttl: '7d', encrypt: false },
        },
      },
      port: 3000,
    };

    const ctx = createPipelineContext({
      db,
      connectorRegistry: registry,
      config,
      appId: 'test',
      manifestId: row.id,
    });

    const result = await executePipeline(manifest, ctx);

    // Emails that contained SSNs should now have them redacted
    const bodiesWithSSN = result.data.filter(
      (r) => typeof r.data.body === 'string' && (r.data.body as string).includes('[SSN REDACTED]'),
    );
    expect(bodiesWithSSN.length).toBeGreaterThan(0);

    // No raw SSN patterns should remain in any body
    for (const item of result.data) {
      if (typeof item.data.body === 'string') {
        expect(item.data.body).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/);
      }
    }
  });
});
