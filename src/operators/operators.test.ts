import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { getDb } from '../db/db.js';
import { encryptField, decryptField } from '../db/encryption.js';
import type { DataRow, SourceConnector, ConnectorRegistry } from '../connectors/types.js';
import type { PipelineContext } from './types.js';
import { pullOperator } from './pull.js';
import { selectOperator } from './select.js';
import { filterOperator } from './filter.js';
import { transformOperator } from './transform.js';
import { stageOperator } from './stage.js';
import { storeOperator } from './store.js';
import { getOperator } from './registry.js';
import type Database from 'better-sqlite3';
import type { HubConfigParsed } from '../config/schema.js';
import { makeTmpDir } from '../test-utils.js';

const TEST_SECRET = 'test-encryption-key-123';

function makeTestRows(): DataRow[] {
  return [
    {
      source: 'gmail',
      source_item_id: 'msg_1',
      type: 'email',
      timestamp: '2026-02-20T10:00:00Z',
      data: {
        title: 'Q4 Report',
        body: 'Revenue was $2.3M. SSN: 123-45-6789. Contact: alice@co.com',
        author_name: 'Alice',
        author_email: 'alice@co.com',
        labels: ['inbox', 'important'],
      },
    },
    {
      source: 'gmail',
      source_item_id: 'msg_2',
      type: 'email',
      timestamp: '2026-02-19T08:00:00Z',
      data: {
        title: 'Deployment Failed',
        body: 'The deploy to prod failed at 3am. SSN: 987-65-4321.',
        author_name: 'Bob',
        author_email: 'bob@co.com',
        labels: ['inbox', 'bug'],
      },
    },
    {
      source: 'gmail',
      source_item_id: 'msg_3',
      type: 'email',
      timestamp: '2026-02-18T12:00:00Z',
      data: {
        title: 'Holiday Plans',
        body: 'Planning vacation for March.',
        author_name: 'Charlie',
        author_email: 'charlie@co.com',
        labels: ['personal'],
      },
    },
  ];
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

function makeContext(db: Database.Database, connectorRegistry?: ConnectorRegistry): PipelineContext {
  const config: HubConfigParsed = {
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

  return {
    db,
    connectorRegistry: connectorRegistry ?? new Map(),
    config,
    appId: 'test-app',
    manifestId: 'test-manifest',
    encryptionKey: TEST_SECRET,
  };
}

describe('Pull Operator', () => {
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

  it('cache miss: fetches from connector', async () => {
    const testRows = makeTestRows();
    const connector = makeMockConnector(testRows);
    const registry: ConnectorRegistry = new Map([['gmail', connector]]);
    const ctx = makeContext(db, registry);

    const result = await pullOperator.execute([], ctx, { source: 'gmail', type: 'email' });
    expect(result).toHaveLength(3);
    expect((result as DataRow[])[0].data.title).toBe('Q4 Report');
  });

  it('cacheOnly: returns empty on cache miss, connector never called', async () => {
    let connectorCalled = false;
    const connector: SourceConnector = {
      name: 'gmail',
      async fetch() {
        connectorCalled = true;
        return makeTestRows();
      },
      async executeAction() {
        return { success: true, message: 'done' };
      },
    };
    const registry: ConnectorRegistry = new Map([['gmail', connector]]);
    const ctx = { ...makeContext(db, registry), cacheOnly: true };

    const result = await pullOperator.execute([], ctx, { source: 'gmail', type: 'email' });
    expect(connectorCalled).toBe(false);
    expect(result).toHaveLength(0);
  });

  it('cache hit: returns from cache without calling connector', async () => {
    let connectorCalled = false;
    const connector: SourceConnector = {
      name: 'gmail',
      async fetch() {
        connectorCalled = true;
        return [];
      },
      async executeAction() {
        return { success: true, message: 'done' };
      },
    };
    const registry: ConnectorRegistry = new Map([['gmail', connector]]);
    const ctx = makeContext(db, registry);

    // Pre-populate cache
    const dataStr = encryptField(JSON.stringify({ title: 'Cached Email', body: 'From cache' }), TEST_SECRET);
    db.prepare(
      `INSERT INTO cached_data (id, source, source_item_id, type, timestamp, data) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('cd_1', 'gmail', 'msg_cached', 'email', '2026-02-20T10:00:00Z', dataStr);

    const result = await pullOperator.execute([], ctx, { source: 'gmail', type: 'email' });
    expect(connectorCalled).toBe(false);
    expect(result).toHaveLength(1);
    expect((result as DataRow[])[0].data.title).toBe('Cached Email');
  });
});

describe('Select Operator', () => {
  it('keeps only specified fields in data', async () => {
    const rows = makeTestRows();
    const result = (await selectOperator.execute(rows, {} as PipelineContext, {
      fields: ['title', 'body'],
    })) as DataRow[];

    expect(result).toHaveLength(3);
    for (const row of result) {
      expect(Object.keys(row.data)).toEqual(['title', 'body']);
    }
  });
});

describe('Filter Operator', () => {
  it('contains: filters rows by label', async () => {
    const rows = makeTestRows();
    const result = (await filterOperator.execute(rows, {} as PipelineContext, {
      field: 'labels',
      op: 'contains',
      value: 'bug',
    })) as DataRow[];

    expect(result).toHaveLength(1);
    expect(result[0].data.title).toBe('Deployment Failed');
  });

  it('eq: filters by exact string match', async () => {
    const rows = makeTestRows();
    const result = (await filterOperator.execute(rows, {} as PipelineContext, {
      field: 'author_name',
      op: 'eq',
      value: 'Alice',
    })) as DataRow[];

    expect(result).toHaveLength(1);
    expect(result[0].data.title).toBe('Q4 Report');
  });

  it('matches: filters by regex', async () => {
    const rows = makeTestRows();
    const result = (await filterOperator.execute(rows, {} as PipelineContext, {
      field: 'body',
      op: 'matches',
      value: 'SSN.*\\d{3}-\\d{2}-\\d{4}',
    })) as DataRow[];

    expect(result).toHaveLength(2);
  });
});

describe('Transform Operator', () => {
  it('redact: replaces SSN pattern with [REDACTED]', async () => {
    const rows = makeTestRows();
    const result = (await transformOperator.execute(rows, {} as PipelineContext, {
      kind: 'redact',
      field: 'body',
      pattern: '\\b\\d{3}-\\d{2}-\\d{4}\\b',
      replacement: '[REDACTED]',
    })) as DataRow[];

    expect(result[0].data.body).toContain('[REDACTED]');
    expect(result[0].data.body).not.toContain('123-45-6789');
    expect(result[1].data.body).toContain('[REDACTED]');
    expect(result[1].data.body).not.toContain('987-65-4321');
    // Row 3 has no SSN, should be unchanged
    expect(result[2].data.body).toBe('Planning vacation for March.');
  });

  it('truncate: truncates body to specified length', async () => {
    const rows = makeTestRows();
    const result = (await transformOperator.execute(rows, {} as PipelineContext, {
      kind: 'truncate',
      field: 'body',
      max_length: 20,
    })) as DataRow[];

    expect((result[0].data.body as string).length).toBeLessThanOrEqual(23); // 20 + '...'
    expect(result[0].data.body).toMatch(/\.\.\.$/);
    // Row 3 body is 28 chars, also truncated to 20
    expect((result[2].data.body as string).length).toBeLessThanOrEqual(23);
  });
});

describe('Stage Operator', () => {
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

  it('inserts a row into staging table with pending status', async () => {
    const ctx = makeContext(db);
    const result = await stageOperator.execute([], ctx, {
      action_type: 'send_email',
      source: 'gmail',
      purpose: 'Draft reply to Alice',
    });

    // Check result
    expect(result).toBeDefined();
    const actionResult = result as unknown as { success: boolean; resultData: { actionId: string; status: string } };
    expect(actionResult.success).toBe(true);
    expect(actionResult.resultData.status).toBe('pending');

    // Check DB
    const rows = db.prepare('SELECT * FROM staging').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].action_type).toBe('send_email');
    expect(rows[0].status).toBe('pending');
    expect(rows[0].source).toBe('gmail');
  });
});

describe('Store Operator', () => {
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

  it('writes DataRows to cached_data with encrypted data column', async () => {
    const ctx = makeContext(db);
    const rows = makeTestRows().slice(0, 1);
    const result = await storeOperator.execute(rows, ctx, {});

    // Returns pass-through
    expect(result).toHaveLength(1);

    // Check DB
    const cached = db.prepare('SELECT * FROM cached_data').all() as Array<Record<string, unknown>>;
    expect(cached).toHaveLength(1);
    expect(cached[0].source).toBe('gmail');
    expect(cached[0].source_item_id).toBe('msg_1');

    // Data should be encrypted
    const decrypted = decryptField(cached[0].data as string, TEST_SECRET);
    expect(JSON.parse(decrypted).title).toBe('Q4 Report');
  });

  it('upsert: writing same source_item_id twice updates the row', async () => {
    const ctx = makeContext(db);
    const row1: DataRow = {
      source: 'gmail',
      source_item_id: 'msg_upsert',
      type: 'email',
      timestamp: '2026-02-20T10:00:00Z',
      data: { title: 'Version 1' },
    };

    await storeOperator.execute([row1], ctx, {});

    const row2: DataRow = {
      source: 'gmail',
      source_item_id: 'msg_upsert',
      type: 'email',
      timestamp: '2026-02-20T11:00:00Z',
      data: { title: 'Version 2' },
    };

    await storeOperator.execute([row2], ctx, {});

    const cached = db.prepare('SELECT * FROM cached_data WHERE source_item_id = ?').all('msg_upsert') as Array<Record<string, unknown>>;
    expect(cached).toHaveLength(1);
    const decrypted = decryptField(cached[0].data as string, TEST_SECRET);
    expect(JSON.parse(decrypted).title).toBe('Version 2');
  });

  it('store + pull: stored rows are returned from cache by pull', async () => {
    let connectorCalled = false;
    const connector: SourceConnector = {
      name: 'gmail',
      async fetch() {
        connectorCalled = true;
        return [];
      },
      async executeAction() {
        return { success: true, message: 'done' };
      },
    };
    const registry: ConnectorRegistry = new Map([['gmail', connector]]);
    const ctx = makeContext(db, registry);

    const rows = makeTestRows().slice(0, 1);
    await storeOperator.execute(rows, ctx, {});

    const result = await pullOperator.execute([], ctx, { source: 'gmail', type: 'email' });
    expect(connectorCalled).toBe(false);
    expect(result).toHaveLength(1);
    expect((result as DataRow[])[0].data.title).toBe('Q4 Report');
  });
});

describe('Operator Registry', () => {
  it('returns operators for all V1 types', () => {
    expect(getOperator('pull')).toBeDefined();
    expect(getOperator('select')).toBeDefined();
    expect(getOperator('filter')).toBeDefined();
    expect(getOperator('transform')).toBeDefined();
    expect(getOperator('stage')).toBeDefined();
    expect(getOperator('store')).toBeDefined();
  });

  it('throws for unknown operator type', () => {
    expect(() => getOperator('unknown')).toThrow('Unknown operator type');
  });
});
