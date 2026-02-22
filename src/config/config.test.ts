import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, loadConfigFiles } from './loader.js';
import { hubConfigSchema } from './schema.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `pdh-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('Config', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses valid config YAML and returns typed object', () => {
    const yaml = `
sources:
  gmail:
    enabled: true
    owner_auth:
      type: oauth2
      clientId: "test-client-id"
      clientSecret: "test-secret"
    boundary:
      after: "2026-01-01"
port: 4000
`;
    const configPath = join(tmpDir, 'config.yaml');
    writeFileSync(configPath, yaml);
    const config = loadConfig(configPath);

    expect(config.sources.gmail).toBeDefined();
    expect(config.sources.gmail.enabled).toBe(true);
    expect(config.sources.gmail.owner_auth.type).toBe('oauth2');
    expect(config.sources.gmail.owner_auth.clientId).toBe('test-client-id');
    expect(config.sources.gmail.boundary.after).toBe('2026-01-01');
    expect(config.port).toBe(4000);
  });

  it('rejects config with missing required fields', () => {
    const yaml = `
sources:
  gmail:
    enabled: true
`;
    const configPath = join(tmpDir, 'config.yaml');
    writeFileSync(configPath, yaml);

    expect(() => loadConfig(configPath)).toThrow();
  });

  it('rejects config with bad types', () => {
    const yaml = `
sources:
  gmail:
    enabled: "not-a-boolean"
    owner_auth:
      type: oauth2
    boundary: {}
`;
    const configPath = join(tmpDir, 'config.yaml');
    writeFileSync(configPath, yaml);

    expect(() => loadConfig(configPath)).toThrow();
  });

  it('resolves ${ENV_VAR} placeholders from process.env', () => {
    process.env.TEST_CLIENT_ID = 'env-client-id';
    process.env.TEST_SECRET = 'env-secret';

    const yaml = `
sources:
  gmail:
    enabled: true
    owner_auth:
      type: oauth2
      clientId: "\${TEST_CLIENT_ID}"
      clientSecret: "\${TEST_SECRET}"
    boundary:
      after: "2026-01-01"
`;
    const configPath = join(tmpDir, 'config.yaml');
    writeFileSync(configPath, yaml);
    const config = loadConfig(configPath);

    expect(config.sources.gmail.owner_auth.clientId).toBe('env-client-id');
    expect(config.sources.gmail.owner_auth.clientSecret).toBe('env-secret');

    delete process.env.TEST_CLIENT_ID;
    delete process.env.TEST_SECRET;
  });

  it('throws when env var is not set', () => {
    delete process.env.MISSING_VAR;

    const yaml = `
sources:
  gmail:
    enabled: true
    owner_auth:
      type: oauth2
      clientId: "\${MISSING_VAR}"
    boundary: {}
`;
    const configPath = join(tmpDir, 'config.yaml');
    writeFileSync(configPath, yaml);

    expect(() => loadConfig(configPath)).toThrow('Environment variable MISSING_VAR is not set');
  });

  it('accepts disabled source (enabled: false)', () => {
    const yaml = `
sources:
  gmail:
    enabled: false
    owner_auth:
      type: oauth2
    boundary: {}
`;
    const configPath = join(tmpDir, 'config.yaml');
    writeFileSync(configPath, yaml);
    const config = loadConfig(configPath);

    expect(config.sources.gmail.enabled).toBe(false);
  });

  it('parses config with cache block correctly', () => {
    const yaml = `
sources:
  gmail:
    enabled: true
    owner_auth:
      type: oauth2
    boundary:
      after: "2026-01-01"
    cache:
      enabled: true
      sync_interval: "30m"
      ttl: "7d"
      encrypt: true
`;
    const configPath = join(tmpDir, 'config.yaml');
    writeFileSync(configPath, yaml);
    const config = loadConfig(configPath);

    expect(config.sources.gmail.cache).toBeDefined();
    expect(config.sources.gmail.cache!.enabled).toBe(true);
    expect(config.sources.gmail.cache!.sync_interval).toBe('30m');
    expect(config.sources.gmail.cache!.ttl).toBe('7d');
    expect(config.sources.gmail.cache!.encrypt).toBe(true);
  });

  it('defaults cache to { enabled: false } when not specified', () => {
    const yaml = `
sources:
  gmail:
    enabled: true
    owner_auth:
      type: oauth2
    boundary: {}
`;
    const configPath = join(tmpDir, 'config.yaml');
    writeFileSync(configPath, yaml);
    const config = loadConfig(configPath);

    expect(config.sources.gmail.cache).toEqual({ enabled: false, encrypt: true });
  });

  it('parses config with multiple sources', () => {
    const yaml = `
sources:
  gmail:
    enabled: true
    owner_auth:
      type: oauth2
      clientId: "gmail-id"
    boundary:
      after: "2026-01-01"
  github:
    enabled: true
    owner_auth:
      type: personal_access_token
      token: "ghp_xxx"
    boundary:
      repos:
        - "myorg/frontend"
        - "myorg/api-server"
      types:
        - "issue"
        - "pr"
`;
    const configPath = join(tmpDir, 'config.yaml');
    writeFileSync(configPath, yaml);
    const config = loadConfig(configPath);

    expect(Object.keys(config.sources)).toEqual(['gmail', 'github']);
    expect(config.sources.github.boundary.repos).toEqual(['myorg/frontend', 'myorg/api-server']);
    expect(config.sources.github.boundary.types).toEqual(['issue', 'pr']);
  });

  it('defaults port to 3000', () => {
    const yaml = `
sources:
  gmail:
    enabled: true
    owner_auth:
      type: oauth2
    boundary: {}
`;
    const configPath = join(tmpDir, 'config.yaml');
    writeFileSync(configPath, yaml);
    const config = loadConfig(configPath);

    expect(config.port).toBe(3000);
  });

  it('schema rejects direct invalid input', () => {
    const result = hubConfigSchema.safeParse({ sources: 'not-an-object' });
    expect(result.success).toBe(false);
  });

  it('schema defaults sources to {} when not provided', () => {
    const result = hubConfigSchema.parse({});
    expect(result.sources).toEqual({});
    expect(result.port).toBe(3000);
  });

  it('loadConfigFiles merges multiple source config files', () => {
    const gmailYaml = `
sources:
  gmail:
    enabled: true
    owner_auth:
      type: oauth2
      clientId: "gmail-id"
    boundary: {}
`;
    const githubYaml = `
sources:
  github:
    enabled: true
    owner_auth:
      type: github_app
      clientId: "github-id"
    boundary:
      repos:
        - "myorg/repo"
port: 4000
`;
    const gmailPath = join(tmpDir, 'gmail.yaml');
    const githubPath = join(tmpDir, 'github.yaml');
    writeFileSync(gmailPath, gmailYaml);
    writeFileSync(githubPath, githubYaml);

    const config = loadConfigFiles([gmailPath, githubPath]);
    expect(Object.keys(config.sources).sort()).toEqual(['github', 'gmail']);
    expect(config.sources.gmail.owner_auth.clientId).toBe('gmail-id');
    expect(config.sources.github.owner_auth.clientId).toBe('github-id');
    expect(config.port).toBe(4000);
  });

  it('loadConfigFiles works with a single file', () => {
    const yaml = `
sources:
  gmail:
    enabled: true
    owner_auth:
      type: oauth2
    boundary: {}
`;
    const path = join(tmpDir, 'gmail.yaml');
    writeFileSync(path, yaml);
    const config = loadConfigFiles([path]);
    expect(config.sources.gmail).toBeDefined();
    expect(config.port).toBe(3000);
  });

  it('loadConfigFiles returns empty sources for empty list', () => {
    const config = loadConfigFiles([]);
    expect(config.sources).toEqual({});
    expect(config.port).toBe(3000);
  });
});
