import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { getDb } from './db/db.js';
import { loadDemoData, unloadDemoData } from './demo.js';
import { DEMO_EMAILS } from './fixtures/emails.js';
import type Database from 'better-sqlite3';
import { makeTmpDir } from './test-utils.js';

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

  it('loadDemoData inserts expected number of emails', () => {
    const result = loadDemoData(db);
    expect(result.emailCount).toBe(DEMO_EMAILS.length);

    const emails = db.prepare('SELECT * FROM cached_data').all();
    expect(emails).toHaveLength(DEMO_EMAILS.length);
  });

  it('unloadDemoData removes all demo data', () => {
    loadDemoData(db);
    const result = unloadDemoData(db);
    expect(result.emailsRemoved).toBe(DEMO_EMAILS.length);

    const emails = db.prepare('SELECT * FROM cached_data').all();
    expect(emails).toHaveLength(0);
  });

  it('load is idempotent — running twice does not duplicate', () => {
    loadDemoData(db);
    loadDemoData(db);

    const emails = db.prepare('SELECT * FROM cached_data').all();
    expect(emails).toHaveLength(DEMO_EMAILS.length);
  });

  it('unload on empty DB is a no-op (returns 0)', () => {
    const result = unloadDemoData(db);
    expect(result.emailsRemoved).toBe(0);
  });

  it('demo emails are readable from cached_data', () => {
    loadDemoData(db);

    const rows = db.prepare("SELECT * FROM cached_data WHERE source = 'gmail'").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(DEMO_EMAILS.length);

    for (const row of rows) {
      expect(row.source).toBe('gmail');
      expect(row.type).toBe('email');
      const data = JSON.parse(row.data as string);
      expect(data).toHaveProperty('title');
      expect(data).toHaveProperty('body');
    }
  });
});
