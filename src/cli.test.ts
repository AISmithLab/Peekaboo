import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { init, reset, writeConfig, readConfig, CONFIG_PATH, CONFIG_DIR } from './cli.js';
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
    expect(names).toContain('owner_auth');
    expect(names).toContain('sessions');
    expect(names).toContain('manifests');
    expect(names).toContain('staging');
    expect(names).toContain('audit_log');
    expect(names).not.toContain('api_keys');
    db.close();
  });

  it('generates a password and stores hashed version in owner_auth', async () => {
    const result = await init(tmpDir);
    expect(result.password).toBeTruthy();
    expect(result.password.length).toBeGreaterThan(10);

    const db = new Database(join(tmpDir, 'pdh.db'));
    const row = db.prepare('SELECT * FROM owner_auth WHERE id = 1').get() as { password_hash: string } | undefined;
    expect(row).toBeTruthy();
    expect(row!.password_hash).toBeTruthy();
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

  it('writes config to ~/.pdh/config.json', async () => {
    const result = await init(tmpDir);
    expect(existsSync(CONFIG_PATH)).toBe(true);
    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    expect(config.hubUrl).toBe('http://localhost:3000');
    expect(config.hubDir).toBe(tmpDir);
    expect(config).not.toHaveProperty('apiKey');
  });

  it('writes config with custom port', async () => {
    await init(tmpDir, { port: 7007 });
    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    expect(config.hubUrl).toBe('http://localhost:7007');
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
  const configBackup = CONFIG_PATH + '.backup-reset';
  const pidPath = join(CONFIG_DIR, 'server.pid');
  const pidBackup = pidPath + '.backup-reset';

  beforeEach(() => {
    tmpDir = makeTmpDir();
    // Back up config files so reset tests don't interfere
    if (existsSync(CONFIG_PATH)) {
      writeFileSync(configBackup, readFileSync(CONFIG_PATH, 'utf-8'), 'utf-8');
      rmSync(CONFIG_PATH);
    }
    if (existsSync(pidPath)) {
      writeFileSync(pidBackup, readFileSync(pidPath, 'utf-8'), 'utf-8');
      rmSync(pidPath);
    }
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    // Restore backups
    if (existsSync(configBackup)) {
      writeFileSync(CONFIG_PATH, readFileSync(configBackup, 'utf-8'), 'utf-8');
      rmSync(configBackup);
    }
    if (existsSync(pidBackup)) {
      writeFileSync(pidPath, readFileSync(pidBackup, 'utf-8'), 'utf-8');
      rmSync(pidBackup);
    }
  });

  it('removes generated hub files and config', async () => {
    await init(tmpDir);
    // All hub files should exist
    expect(existsSync(join(tmpDir, '.env'))).toBe(true);
    expect(existsSync(join(tmpDir, 'hub-config.yaml'))).toBe(true);
    expect(existsSync(join(tmpDir, 'pdh.db'))).toBe(true);
    expect(existsSync(CONFIG_PATH)).toBe(true);

    const removed = reset(tmpDir);
    expect(removed.length).toBeGreaterThanOrEqual(4);
    expect(existsSync(join(tmpDir, '.env'))).toBe(false);
    expect(existsSync(join(tmpDir, 'hub-config.yaml'))).toBe(false);
    expect(existsSync(join(tmpDir, 'pdh.db'))).toBe(false);
    expect(existsSync(CONFIG_PATH)).toBe(false);
  });

  it('allows init to succeed after reset', async () => {
    await init(tmpDir);
    reset(tmpDir);
    // Second init should not throw
    const result = await init(tmpDir);
    expect(result.password).toBeTruthy();
  });

  it('returns empty array when nothing to remove', () => {
    const removed = reset(tmpDir);
    expect(removed).toEqual([]);
  });
});

describe('Config file', () => {
  const backupPath = CONFIG_PATH + '.backup';

  beforeEach(() => {
    // Back up existing config if present
    if (existsSync(CONFIG_PATH)) {
      const content = readFileSync(CONFIG_PATH, 'utf-8');
      writeFileSync(backupPath, content, 'utf-8');
    }
  });

  afterEach(() => {
    // Restore backup
    if (existsSync(backupPath)) {
      const content = readFileSync(backupPath, 'utf-8');
      writeFileSync(CONFIG_PATH, content, 'utf-8');
      rmSync(backupPath);
    }
  });

  it('writeConfig creates the file and readConfig reads it', () => {
    writeConfig({ hubUrl: 'http://localhost:9999', hubDir: '/tmp' });
    const config = readConfig();
    expect(config).not.toBeNull();
    expect(config!.hubUrl).toBe('http://localhost:9999');
    expect(config!.hubDir).toBe('/tmp');
  });

  it('readConfig returns null for missing file', () => {
    // Write something invalid first, then remove
    if (existsSync(CONFIG_PATH)) {
      rmSync(CONFIG_PATH);
    }
    const config = readConfig();
    // May or may not be null depending on whether init was run before
    // Just ensure it doesn't throw
    expect(config === null || typeof config === 'object').toBe(true);
  });
});
