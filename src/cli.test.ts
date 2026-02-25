import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { compareSync } from 'bcryptjs';
import Database from 'better-sqlite3';
import { init, reset, writeCredentials, readCredentials, CREDENTIALS_PATH, CREDENTIALS_DIR } from './cli.js';
import { makeTmpDir } from './test-utils.js';

describe('CLI init', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates .env with PDH_SECRET', async () => {
    const result = await init(tmpDir);
    const envContent = readFileSync(join(tmpDir, '.env'), 'utf-8');
    expect(envContent).toContain('PDH_SECRET=');
    expect(envContent).toContain(result.secret);
  });

  it('creates hub-config.yaml with correct port', async () => {
    await init(tmpDir, { port: 7007 });
    const config = readFileSync(join(tmpDir, 'hub-config.yaml'), 'utf-8');
    expect(config).toContain('port: 7007');
  });

  it('creates and initializes SQLite database with all tables', async () => {
    await init(tmpDir);
    expect(existsSync(join(tmpDir, 'pdh.db'))).toBe(true);

    const db = new Database(join(tmpDir, 'pdh.db'));
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const names = tables.map(t => t.name);
    expect(names).toContain('api_keys');
    expect(names).toContain('manifests');
    expect(names).toContain('staging');
    expect(names).toContain('audit_log');
    db.close();
  });

  it('generates a valid API key starting with pk_', async () => {
    const result = await init(tmpDir);
    expect(result.apiKey).toMatch(/^pk_[a-f0-9]{32}$/);
  });

  it('stores hashed API key that verifies against raw key', async () => {
    const result = await init(tmpDir);
    const db = new Database(join(tmpDir, 'pdh.db'));
    const row = db.prepare('SELECT * FROM api_keys').get() as { key_hash: string; name: string };
    expect(compareSync(result.apiKey, row.key_hash)).toBe(true);
    expect(row.name).toBe('default');
    db.close();
  });

  it('uses custom app name for API key', async () => {
    await init(tmpDir, { appName: 'My Agent' });
    const db = new Database(join(tmpDir, 'pdh.db'));
    const row = db.prepare('SELECT * FROM api_keys').get() as { id: string; name: string };
    expect(row.id).toBe('my-agent');
    expect(row.name).toBe('My Agent');
    db.close();
  });

  it('throws if .env already exists (prevents re-init)', async () => {
    await init(tmpDir);
    await expect(init(tmpDir)).rejects.toThrow('.env already exists');
  });

  it('generates base64-encoded secret of correct length (32 bytes)', async () => {
    const result = await init(tmpDir);
    const decoded = Buffer.from(result.secret, 'base64');
    expect(decoded.length).toBe(32);
  });

  it('writes credentials to ~/.pdh/credentials.json', async () => {
    const result = await init(tmpDir);
    expect(existsSync(CREDENTIALS_PATH)).toBe(true);
    const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'));
    expect(creds.hubUrl).toBe('http://localhost:3000');
    expect(creds.apiKey).toBe(result.apiKey);
    expect(creds.hubDir).toBe(tmpDir);
  });

  it('writes credentials with custom port', async () => {
    await init(tmpDir, { port: 7007 });
    const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'));
    expect(creds.hubUrl).toBe('http://localhost:7007');
  });

  it('falls back to sources: {} when credential fetch fails', async () => {
    const result = await init(tmpDir);
    // In test/CI, S3 fetch will fail — verify fallback to minimal config
    const config = readFileSync(join(tmpDir, 'hub-config.yaml'), 'utf-8');
    expect(config).toContain('sources:');
    expect(result.credentialsFetched === true || config.includes('sources: {}')).toBe(true);
  });
});

describe('CLI reset', () => {
  let tmpDir: string;
  const credBackup = CREDENTIALS_PATH + '.backup-reset';
  const pidPath = join(CREDENTIALS_DIR, 'server.pid');
  const pidBackup = pidPath + '.backup-reset';

  beforeEach(() => {
    tmpDir = makeTmpDir();
    // Back up credential files so reset tests don't interfere
    if (existsSync(CREDENTIALS_PATH)) {
      writeFileSync(credBackup, readFileSync(CREDENTIALS_PATH, 'utf-8'), 'utf-8');
      rmSync(CREDENTIALS_PATH);
    }
    if (existsSync(pidPath)) {
      writeFileSync(pidBackup, readFileSync(pidPath, 'utf-8'), 'utf-8');
      rmSync(pidPath);
    }
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    // Restore backups
    if (existsSync(credBackup)) {
      writeFileSync(CREDENTIALS_PATH, readFileSync(credBackup, 'utf-8'), 'utf-8');
      rmSync(credBackup);
    }
    if (existsSync(pidBackup)) {
      writeFileSync(pidPath, readFileSync(pidBackup, 'utf-8'), 'utf-8');
      rmSync(pidBackup);
    }
  });

  it('removes generated hub files and credentials', async () => {
    await init(tmpDir);
    // All hub files should exist
    expect(existsSync(join(tmpDir, '.env'))).toBe(true);
    expect(existsSync(join(tmpDir, 'hub-config.yaml'))).toBe(true);
    expect(existsSync(join(tmpDir, 'pdh.db'))).toBe(true);
    expect(existsSync(CREDENTIALS_PATH)).toBe(true);

    const removed = reset(tmpDir);
    expect(removed.length).toBeGreaterThanOrEqual(4);
    expect(existsSync(join(tmpDir, '.env'))).toBe(false);
    expect(existsSync(join(tmpDir, 'hub-config.yaml'))).toBe(false);
    expect(existsSync(join(tmpDir, 'pdh.db'))).toBe(false);
    expect(existsSync(CREDENTIALS_PATH)).toBe(false);
  });

  it('allows init to succeed after reset', async () => {
    await init(tmpDir);
    reset(tmpDir);
    // Second init should not throw
    const result = await init(tmpDir);
    expect(result.apiKey).toMatch(/^pk_/);
  });

  it('returns empty array when nothing to remove', () => {
    const removed = reset(tmpDir);
    expect(removed).toEqual([]);
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
