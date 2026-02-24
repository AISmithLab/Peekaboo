import { describe, it, expect, afterEach } from 'vitest';
import { setupE2eApp, makeConfigWithCache, request, insertManifest, cleanup } from './helpers.js';
import { parseInterval, syncSource } from '../../src/sync/scheduler.js';
import type Database from 'better-sqlite3';

const MANIFEST_TEXT = `
@purpose: "Read gmail emails"
@graph: fetch_emails
fetch_emails: pull { source: "gmail", type: "email" }
`;

describe('Cache-First Pull with Background Sync', () => {
  let db: Database.Database;
  let tmpDir: string;

  afterEach(() => {
    if (db) cleanup(db, tmpDir);
  });

  it('cache-enabled pull returns empty when cache is empty (no live fallback)', async () => {
    const env = setupE2eApp(undefined, makeConfigWithCache());
    db = env.db;
    tmpDir = env.tmpDir;

    insertManifest(db, 'mf_cache_1', 'gmail', 'Read emails', MANIFEST_TEXT);

    const res = await request(env.app, 'POST', '/app/v1/pull', {
      source: 'gmail',
      type: 'email',
      purpose: 'test cache-only pull',
    });

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(0);
  });

  it('cache-enabled pull reads from cache when data exists', async () => {
    const env = setupE2eApp(undefined, makeConfigWithCache());
    db = env.db;
    tmpDir = env.tmpDir;

    insertManifest(db, 'mf_cache_2', 'gmail', 'Read emails', MANIFEST_TEXT);

    // Pre-populate cache
    db.prepare(
      `INSERT INTO cached_data (id, source, source_item_id, type, timestamp, data) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('cd_1', 'gmail', 'msg_cached_1', 'email', '2026-02-20T10:00:00Z', JSON.stringify({ title: 'Cached Email' }));

    const res = await request(env.app, 'POST', '/app/v1/pull', {
      source: 'gmail',
      type: 'email',
      purpose: 'test cache hit',
    });

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].data.title).toBe('Cached Email');
  });

  it('syncSource populates cache via live fetch with auto-appended store', async () => {
    const env = setupE2eApp(undefined, makeConfigWithCache());
    db = env.db;
    tmpDir = env.tmpDir;

    insertManifest(db, 'mf_sync_1', 'gmail', 'Read emails', MANIFEST_TEXT);

    // Run sync — should fetch live data and store in cache
    await syncSource(
      {
        db,
        connectorRegistry: env.connectorRegistry,
        config: env.config,
        encryptionKey: 'e2e-test-secret',
      },
      'gmail',
    );

    // Verify cache was populated
    const cached = db.prepare('SELECT * FROM cached_data WHERE source = ?').all('gmail') as Array<Record<string, unknown>>;
    expect(cached.length).toBeGreaterThan(0);

    // Now a cache-only pull should return data
    const res = await request(env.app, 'POST', '/app/v1/pull', {
      source: 'gmail',
      type: 'email',
      purpose: 'test after sync',
    });

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
  });
});

describe('parseInterval', () => {
  it('parses seconds', () => {
    expect(parseInterval('30s')).toBe(30_000);
  });

  it('parses minutes', () => {
    expect(parseInterval('10m')).toBe(600_000);
  });

  it('parses hours', () => {
    expect(parseInterval('1h')).toBe(3_600_000);
  });

  it('throws on invalid format', () => {
    expect(() => parseInterval('10')).toThrow('Invalid interval format');
    expect(() => parseInterval('abc')).toThrow('Invalid interval format');
    expect(() => parseInterval('10d')).toThrow('Invalid interval format');
  });
});
