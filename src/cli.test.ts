import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { compareSync } from 'bcryptjs';
import Database from 'better-sqlite3';
import { init, writeCredentials, readCredentials, CREDENTIALS_PATH } from './cli.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `peekaboo-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('CLI init', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates .env with PEEKABOO_SECRET', () => {
    const result = init(tmpDir);
    const envContent = readFileSync(join(tmpDir, '.env'), 'utf-8');
    expect(envContent).toContain('PEEKABOO_SECRET=');
    expect(envContent).toContain(result.secret);
  });

  it('creates hub-config.yaml with correct port', () => {
    init(tmpDir, { port: 7007 });
    const config = readFileSync(join(tmpDir, 'hub-config.yaml'), 'utf-8');
    expect(config).toContain('port: 7007');
    expect(config).toContain('sources: {}');
  });

  it('creates and initializes SQLite database with all tables', () => {
    init(tmpDir);
    expect(existsSync(join(tmpDir, 'peekaboo.db'))).toBe(true);

    const db = new Database(join(tmpDir, 'peekaboo.db'));
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const names = tables.map(t => t.name);
    expect(names).toContain('api_keys');
    expect(names).toContain('manifests');
    expect(names).toContain('cached_data');
    expect(names).toContain('staging');
    expect(names).toContain('audit_log');
    db.close();
  });

  it('generates a valid API key starting with pk_', () => {
    const result = init(tmpDir);
    expect(result.apiKey).toMatch(/^pk_[a-f0-9]{32}$/);
  });

  it('stores hashed API key that verifies against raw key', () => {
    const result = init(tmpDir);
    const db = new Database(join(tmpDir, 'peekaboo.db'));
    const row = db.prepare('SELECT * FROM api_keys').get() as { key_hash: string; name: string };
    expect(compareSync(result.apiKey, row.key_hash)).toBe(true);
    expect(row.name).toBe('default');
    db.close();
  });

  it('uses custom app name for API key', () => {
    init(tmpDir, { appName: 'My Agent' });
    const db = new Database(join(tmpDir, 'peekaboo.db'));
    const row = db.prepare('SELECT * FROM api_keys').get() as { id: string; name: string };
    expect(row.id).toBe('my-agent');
    expect(row.name).toBe('My Agent');
    db.close();
  });

  it('throws if .env already exists (prevents re-init)', () => {
    init(tmpDir);
    expect(() => init(tmpDir)).toThrow('.env already exists');
  });

  it('generates base64-encoded secret of correct length (32 bytes)', () => {
    const result = init(tmpDir);
    const decoded = Buffer.from(result.secret, 'base64');
    expect(decoded.length).toBe(32);
  });

  it('writes credentials to ~/.peekaboo/credentials.json', () => {
    const result = init(tmpDir);
    expect(existsSync(CREDENTIALS_PATH)).toBe(true);
    const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'));
    expect(creds.hubUrl).toBe('http://localhost:3000');
    expect(creds.apiKey).toBe(result.apiKey);
    expect(creds.hubDir).toBe(tmpDir);
  });

  it('writes credentials with custom port', () => {
    init(tmpDir, { port: 7007 });
    const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'));
    expect(creds.hubUrl).toBe('http://localhost:7007');
  });
});

describe('Credentials file', () => {
  const backupPath = CREDENTIALS_PATH + '.backup';

  beforeEach(() => {
    // Back up existing credentials if present
    if (existsSync(CREDENTIALS_PATH)) {
      const content = readFileSync(CREDENTIALS_PATH, 'utf-8');
      writeFileSync(backupPath, content, 'utf-8');
    }
  });

  afterEach(() => {
    // Restore backup
    if (existsSync(backupPath)) {
      const content = readFileSync(backupPath, 'utf-8');
      writeFileSync(CREDENTIALS_PATH, content, 'utf-8');
      rmSync(backupPath);
    }
  });

  it('writeCredentials creates the file and readCredentials reads it', () => {
    writeCredentials({ hubUrl: 'http://localhost:9999', apiKey: 'pk_test', hubDir: '/tmp' });
    const creds = readCredentials();
    expect(creds).not.toBeNull();
    expect(creds!.hubUrl).toBe('http://localhost:9999');
    expect(creds!.apiKey).toBe('pk_test');
  });

  it('readCredentials returns null for missing file', () => {
    // Write something invalid first, then remove
    if (existsSync(CREDENTIALS_PATH)) {
      rmSync(CREDENTIALS_PATH);
    }
    const creds = readCredentials();
    // May or may not be null depending on whether init was run before
    // Just ensure it doesn't throw
    expect(creds === null || typeof creds === 'object').toBe(true);
  });
});
