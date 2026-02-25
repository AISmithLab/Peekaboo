import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { getDb } from './db.js';
import { encryptField, decryptField } from './encryption.js';
import type Database from 'better-sqlite3';
import { makeTmpDir } from '../test-utils.js';

describe('Database', () => {
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

  it('creates a new database file with all tables', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('api_keys');
    expect(tableNames).toContain('manifests');
    expect(tableNames).toContain('staging');
    expect(tableNames).toContain('audit_log');
    expect(tableNames).not.toContain('cached_data');
  });

  it('api_keys table has correct columns', () => {
    const cols = db.prepare("PRAGMA table_info('api_keys')").all() as { name: string; type: string }[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toEqual(['id', 'key_hash', 'name', 'allowed_manifests', 'enabled', 'created_at']);
  });

  it('manifests table has correct columns', () => {
    const cols = db.prepare("PRAGMA table_info('manifests')").all() as { name: string }[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toEqual(['id', 'name', 'source', 'purpose', 'raw_text', 'explanation', 'status', 'created_at', 'updated_at']);
  });

  it('staging table has correct columns', () => {
    const cols = db.prepare("PRAGMA table_info('staging')").all() as { name: string }[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toEqual(['action_id', 'manifest_id', 'source', 'action_type', 'action_data', 'purpose', 'status', 'proposed_at', 'resolved_at']);
  });

  it('audit_log table has correct columns', () => {
    const cols = db.prepare("PRAGMA table_info('audit_log')").all() as { name: string }[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toEqual(['id', 'timestamp', 'event', 'source', 'details']);
  });

  it('inserts and reads api_keys with allowed_manifests JSON', () => {
    const manifests = JSON.stringify(['email-search', 'github-issues']);
    db.prepare(
      'INSERT INTO api_keys (id, key_hash, name, allowed_manifests) VALUES (?, ?, ?, ?)',
    ).run('openclaw', 'hash_abc', 'OpenClaw Agent', manifests);

    const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get('openclaw') as Record<string, unknown>;
    expect(row.id).toBe('openclaw');
    expect(row.key_hash).toBe('hash_abc');
    expect(row.name).toBe('OpenClaw Agent');
    expect(JSON.parse(row.allowed_manifests as string)).toEqual(['email-search', 'github-issues']);
    expect(row.enabled).toBe(1);
  });

  it('inserts and reads manifests', () => {
    db.prepare(
      'INSERT INTO manifests (id, source, purpose, raw_text) VALUES (?, ?, ?, ?)',
    ).run('email-search', 'gmail', 'Search emails', '@purpose: "Search emails"');

    const row = db.prepare('SELECT * FROM manifests WHERE id = ?').get('email-search') as Record<string, unknown>;
    expect(row.id).toBe('email-search');
    expect(row.source).toBe('gmail');
    expect(row.status).toBe('inactive');
  });

  it('inserts and reads staging', () => {
    db.prepare(
      'INSERT INTO staging (action_id, source, action_type, action_data, purpose) VALUES (?, ?, ?, ?, ?)',
    ).run('act_1', 'gmail', 'send_email', '{"to":"a@b.com"}', 'Draft reply');

    const row = db.prepare('SELECT * FROM staging WHERE action_id = ?').get('act_1') as Record<string, unknown>;
    expect(row.source).toBe('gmail');
    expect(row.status).toBe('pending');
    expect(row.purpose).toBe('Draft reply');
  });

  it('audit_log is append-only with auto-increment', () => {
    db.prepare(
      'INSERT INTO audit_log (event, source, details) VALUES (?, ?, ?)',
    ).run('data_pull', 'gmail', '{"purpose":"test"}');

    db.prepare(
      'INSERT INTO audit_log (event, source, details) VALUES (?, ?, ?)',
    ).run('action_proposed', 'gmail', '{"actionId":"act_1"}');

    const rows = db.prepare('SELECT * FROM audit_log ORDER BY id').all() as { id: number; event: string }[];
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(1);
    expect(rows[0].event).toBe('data_pull');
    expect(rows[1].id).toBe(2);
    expect(rows[1].event).toBe('action_proposed');
  });

});

describe('Encryption', () => {
  const secret = 'test-master-secret-key-123';

  it('encryptField → decryptField round-trips correctly', () => {
    const plaintext = 'Hello, this is sensitive data!';
    const encrypted = encryptField(plaintext, secret);
    const decrypted = decryptField(encrypted, secret);
    expect(decrypted).toBe(plaintext);
  });

  it('encrypted output differs from plaintext', () => {
    const plaintext = 'sensitive data';
    const encrypted = encryptField(plaintext, secret);
    expect(encrypted).not.toBe(plaintext);
    expect(encrypted).not.toContain(plaintext);
  });

  it('different encryptions produce different ciphertexts (random IV)', () => {
    const plaintext = 'same input';
    const e1 = encryptField(plaintext, secret);
    const e2 = encryptField(plaintext, secret);
    expect(e1).not.toBe(e2);
  });

  it('decryption with wrong key fails', () => {
    const encrypted = encryptField('test', secret);
    expect(() => decryptField(encrypted, 'wrong-key')).toThrow();
  });

  it('handles JSON data round-trip', () => {
    const data = JSON.stringify({ title: 'Q4 Report', body: 'Revenue was $2.3M', labels: ['important'] });
    const encrypted = encryptField(data, secret);
    const decrypted = decryptField(encrypted, secret);
    expect(JSON.parse(decrypted)).toEqual({ title: 'Q4 Report', body: 'Revenue was $2.3M', labels: ['important'] });
  });
});
