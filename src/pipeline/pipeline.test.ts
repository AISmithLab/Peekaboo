import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { getDb } from '../db/db.js';
import { decryptField } from '../db/encryption.js';
import { parseManifest } from '../manifest/parser.js';
import { executePipeline } from './engine.js';
import { createPipelineContext } from './context.js';
import type { DataRow, SourceConnector, ConnectorRegistry } from '../connectors/types.js';
import type { HubConfigParsed } from '../config/schema.js';
import type Database from 'better-sqlite3';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `peekaboo-pipe-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const TEST_SECRET = 'test-encryption-key-123';

function makeTestRows(): DataRow[] {
  return Array.from({ length: 10 }, (_, i) => ({
    source: 'gmail',
    source_item_id: `msg_${i}`,
    type: 'email',
    timestamp: `2026-02-${String(20 - i).padStart(2, '0')}T10:00:00Z`,
    data: {
      title: `Email ${i}`,
      body: `Body of email ${i}. SSN: ${100 + i}-${10 + i}-${1000 + i}. Also 123-45-6789.`,
      author_name: i % 3 === 0 ? 'Alice' : i % 3 === 1 ? 'Bob' : 'Charlie',
      author_email: `user${i}@co.com`,
      labels: i < 5 ? ['inbox', 'important'] : ['inbox', 'personal'],
      timestamp_field: `2026-02-${String(20 - i).padStart(2, '0')}T10:00:00Z`,
    },
  }));
}

function makeMockConnector(rows: DataRow[]): SourceConnector {
  return {
    name: 'gmail',
    async fetch() {
      return rows;
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
        cache: { enabled: true, ttl: '7d', encrypt: true },
      },
    },
    port: 3000,
  };
}

describe('Pipeline Engine', () => {
  let tmpDir: string;
  let db: Database.Database;
  let registry: ConnectorRegistry;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    db = getDb(join(tmpDir, 'test.db'));
    const connector = makeMockConnector(makeTestRows());
    registry = new Map([['gmail', connector]]);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('full pipeline: pull -> select -> transform(redact)', async () => {
    const manifest = parseManifest(`
@purpose: "Test pipeline"
@graph: pull_emails -> select_fields -> redact_ssn
pull_emails: pull { source: "gmail", type: "email" }
select_fields: select { fields: ["title", "body"] }
redact_ssn: transform { kind: "redact", field: "body", pattern: "\\d{3}-\\d{2}-\\d{4}", replacement: "[REDACTED]" }
`, 'test');

    const ctx = createPipelineContext({
      db, connectorRegistry: registry, config: makeConfig(),
      appId: 'test', manifestId: 'test', encryptionKey: TEST_SECRET,
    });

    const result = await executePipeline(manifest, ctx);
    expect(result.data).toHaveLength(10);

    // Only title and body should be present
    for (const row of result.data) {
      expect(Object.keys(row.data).sort()).toEqual(['body', 'title']);
    }

    // SSNs should be redacted
    for (const row of result.data) {
      expect(row.data.body).toContain('[REDACTED]');
      expect(row.data.body).not.toMatch(/\d{3}-\d{2}-\d{4}/);
    }
  });

  it('pipeline with filter: 10 rows, filter keeps some, select narrows fields', async () => {
    const manifest = parseManifest(`
@purpose: "Test filter pipeline"
@graph: pull_emails -> filter_important -> select_fields
pull_emails: pull { source: "gmail", type: "email" }
filter_important: filter { field: "labels", op: "contains", value: "important" }
select_fields: select { fields: ["title", "labels"] }
`, 'test-filter');

    const ctx = createPipelineContext({
      db, connectorRegistry: registry, config: makeConfig(),
      appId: 'test', manifestId: 'test-filter', encryptionKey: TEST_SECRET,
    });

    const result = await executePipeline(manifest, ctx);
    expect(result.data.length).toBeLessThan(10);
    expect(result.data.length).toBe(5);

    for (const row of result.data) {
      expect(Object.keys(row.data).sort()).toEqual(['labels', 'title']);
      expect(row.data.labels).toContain('important');
    }
  });

  it('pipeline with stage: writes to staging table, returns action result', async () => {
    const manifest = parseManifest(`
@purpose: "Stage email draft"
@graph: stage_it
stage_it: stage { action_type: "draft_email", source: "gmail" }
`, 'test-stage');

    const ctx = createPipelineContext({
      db, connectorRegistry: registry, config: makeConfig(),
      appId: 'test', manifestId: 'test-stage', encryptionKey: TEST_SECRET,
    });

    const result = await executePipeline(manifest, ctx);
    expect(result.actionResult).toBeDefined();
    expect(result.actionResult!.success).toBe(true);

    const staging = db.prepare('SELECT * FROM staging').all() as Array<Record<string, unknown>>;
    expect(staging).toHaveLength(1);
    expect(staging[0].status).toBe('pending');
  });

  it('pipeline with store as terminal: pull -> store writes to cache and returns rows', async () => {
    const manifest = parseManifest(`
@purpose: "Cache emails"
@graph: pull_emails -> store_locally
pull_emails: pull { source: "gmail", type: "email" }
store_locally: store { }
`, 'test-store');

    const ctx = createPipelineContext({
      db, connectorRegistry: registry, config: makeConfig(),
      appId: 'test', manifestId: 'test-store', encryptionKey: TEST_SECRET,
    });

    const result = await executePipeline(manifest, ctx);
    expect(result.data).toHaveLength(10);

    const cached = db.prepare('SELECT * FROM cached_data').all() as Array<Record<string, unknown>>;
    expect(cached).toHaveLength(10);
  });

  it('pipeline with store mid-chain: pull -> store -> select -> filter', async () => {
    const manifest = parseManifest(`
@purpose: "Cache and filter"
@graph: pull_emails -> store_locally -> select_fields -> filter_important
pull_emails: pull { source: "gmail", type: "email" }
store_locally: store { }
select_fields: select { fields: ["title", "labels"] }
filter_important: filter { field: "labels", op: "contains", value: "important" }
`, 'test-store-mid');

    const ctx = createPipelineContext({
      db, connectorRegistry: registry, config: makeConfig(),
      appId: 'test', manifestId: 'test-store-mid', encryptionKey: TEST_SECRET,
    });

    const result = await executePipeline(manifest, ctx);

    // Store passes through, then select + filter narrow
    expect(result.data.length).toBe(5);
    for (const row of result.data) {
      expect(Object.keys(row.data).sort()).toEqual(['labels', 'title']);
    }

    // But all 10 should be in cache
    const cached = db.prepare('SELECT * FROM cached_data').all() as Array<Record<string, unknown>>;
    expect(cached).toHaveLength(10);
  });

  it('reports correct operatorsApplied and item counts', async () => {
    const manifest = parseManifest(`
@purpose: "Test meta"
@graph: pull_emails -> filter_important
pull_emails: pull { source: "gmail", type: "email" }
filter_important: filter { field: "labels", op: "contains", value: "important" }
`, 'test-meta');

    const ctx = createPipelineContext({
      db, connectorRegistry: registry, config: makeConfig(),
      appId: 'test', manifestId: 'test-meta', encryptionKey: TEST_SECRET,
    });

    const result = await executePipeline(manifest, ctx);
    expect(result.meta.operatorsApplied).toEqual(['pull_emails:pull', 'filter_important:filter']);
    expect(result.meta.itemsFetched).toBe(10);
    expect(result.meta.itemsReturned).toBe(5);
    expect(result.meta.queryTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('throws on unknown operator name in graph', async () => {
    const manifest = parseManifest(`
@purpose: "Test error"
@graph: pull_emails -> unknown_op
pull_emails: pull { source: "gmail", type: "email" }
`, 'test-error');
    // Manually add the bogus node reference (parser won't add missing operators)
    manifest.graph = ['pull_emails', 'unknown_op'];

    const ctx = createPipelineContext({
      db, connectorRegistry: registry, config: makeConfig(),
      appId: 'test', manifestId: 'test-error', encryptionKey: TEST_SECRET,
    });

    await expect(executePipeline(manifest, ctx)).rejects.toThrow('undeclared operator');
  });

  it('empty result from pull propagates through pipeline without error', async () => {
    const emptyConnector = makeMockConnector([]);
    const emptyRegistry: ConnectorRegistry = new Map([['gmail', emptyConnector]]);

    const manifest = parseManifest(`
@purpose: "Test empty"
@graph: pull_emails -> select_fields
pull_emails: pull { source: "gmail", type: "email" }
select_fields: select { fields: ["title"] }
`, 'test-empty');

    const ctx = createPipelineContext({
      db, connectorRegistry: emptyRegistry, config: makeConfig(),
      appId: 'test', manifestId: 'test-empty', encryptionKey: TEST_SECRET,
    });

    const result = await executePipeline(manifest, ctx);
    expect(result.data).toEqual([]);
    expect(result.meta.itemsFetched).toBe(0);
    expect(result.meta.itemsReturned).toBe(0);
  });

  it('rejects manifest with stage not as the last operator', async () => {
    const manifest = parseManifest(`
@purpose: "Test stage position"
@graph: stage_it -> pull_emails
stage_it: stage { action_type: "draft_email" }
pull_emails: pull { source: "gmail", type: "email" }
`, 'test-stage-pos');

    const ctx = createPipelineContext({
      db, connectorRegistry: registry, config: makeConfig(),
      appId: 'test', manifestId: 'test-stage-pos', encryptionKey: TEST_SECRET,
    });

    await expect(executePipeline(manifest, ctx)).rejects.toThrow('stage');
  });
});
