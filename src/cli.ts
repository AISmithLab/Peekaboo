#!/usr/bin/env node
/**
 * PersonalDataHub CLI — bootstrap and manage a PersonalDataHub installation.
 *
 * Usage:
 *   npx pdh init [app-name]    Bootstrap a new installation
 *   npx pdh start              Start the server in the background
 *   npx pdh stop               Stop the background server
 *   npx pdh status             Check if the server is running
 *   npx pdh reset              Remove all generated files and start fresh
 *   npx pdh demo-load          Load synthetic demo emails and manifests
 *   npx pdh demo-unload        Remove all demo data
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { hashSync } from 'bcryptjs';
import { getDb } from './db/db.js';
import { loadDemoData, unloadDemoData } from './demo.js';

// --- Credentials file path ---

export const CREDENTIALS_DIR = join(homedir(), '.pdh');
export const CREDENTIALS_PATH = join(CREDENTIALS_DIR, 'credentials.json');
const PID_PATH = join(CREDENTIALS_DIR, 'server.pid');

export interface Credentials {
  hubUrl: string;
  apiKey: string;
  hubDir: string;
}

/**
 * Write credentials to ~/.pdh/credentials.json.
 * Creates the directory if it doesn't exist.
 */
export function writeCredentials(creds: Credentials): void {
  mkdirSync(CREDENTIALS_DIR, { recursive: true });
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2) + '\n', 'utf-8');
}

/**
 * Read credentials from ~/.pdh/credentials.json.
 * Returns null if the file doesn't exist or is malformed.
 */
export function readCredentials(): Credentials | null {
  try {
    if (!existsSync(CREDENTIALS_PATH)) return null;
    const raw = readFileSync(CREDENTIALS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed.hubUrl && parsed.apiKey) return parsed as Credentials;
    return null;
  } catch {
    return null;
  }
}

// --- Init ---

const OAUTH_CREDENTIALS_URL = 'https://peekaboohub-config.s3.us-east-2.amazonaws.com/credentials.json';

interface OAuthCredentials {
  google?: { clientId: string; clientSecret: string };
  github?: { clientId: string; clientSecret: string };
}

async function fetchDefaultCredentials(): Promise<OAuthCredentials | null> {
  try {
    const res = await fetch(OAUTH_CREDENTIALS_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return await res.json() as OAuthCredentials;
  } catch {
    return null;
  }
}

export interface InitResult {
  secret: string;
  apiKey: string;
  dbPath: string;
  configPath: string;
  envPath: string;
  credentialsPath: string;
  credentialsFetched: boolean;
}

export interface InitOptions {
  appName?: string;
  port?: number;
}

/**
 * Bootstrap a new PersonalDataHub installation.
 *
 * Generates a master secret, writes .env and hub-config.yaml,
 * initializes the database, creates the first API key,
 * and writes credentials to ~/.pdh/credentials.json.
 */
export async function init(targetDir?: string, options?: InitOptions): Promise<InitResult> {
  const dir = targetDir ?? process.cwd();
  const envPath = resolve(dir, '.env');
  const configPath = resolve(dir, 'hub-config.yaml');
  const dbPath = resolve(dir, 'pdh.db');

  // Guard against re-initialization
  if (existsSync(envPath)) {
    throw new Error(`.env already exists at ${envPath}. Delete it first to re-initialize.`);
  }

  // Generate master secret
  const secret = randomBytes(32).toString('base64');

  // Write .env
  writeFileSync(envPath, `PDH_SECRET=${secret}\n`, 'utf-8');

  // Fetch default OAuth credentials from S3
  const oauthCreds = await fetchDefaultCredentials();
  const credentialsFetched = oauthCreds !== null;

  // Write hub-config.yaml
  const port = options?.port ?? 3000;
  let configContent: string;

  if (oauthCreds) {
    const lines = [
      '# PersonalDataHub configuration',
      '',
      'sources:',
    ];

    if (oauthCreds.google) {
      lines.push(
        '  gmail:',
        '    enabled: true',
        '    owner_auth:',
        '      type: oauth2',
        `      clientId: "${oauthCreds.google.clientId}"`,
        `      clientSecret: "${oauthCreds.google.clientSecret}"`,
      );
    }

    if (oauthCreds.github) {
      lines.push(
        '  github:',
        '    enabled: true',
        '    owner_auth:',
        '      type: github_app',
        `      clientId: "${oauthCreds.github.clientId}"`,
        `      clientSecret: "${oauthCreds.github.clientSecret}"`,
      );
    }

    lines.push('', `port: ${port}`, '');
    configContent = lines.join('\n');
  } else {
    configContent = [
      '# PersonalDataHub configuration — add OAuth credentials here',
      '# See docs/oauth-setup.md for setup instructions',
      '',
      'sources: {}',
      '',
      `port: ${port}`,
      '',
    ].join('\n');
  }

  writeFileSync(configPath, configContent, 'utf-8');

  // Initialize database
  const db = getDb(dbPath);

  // Generate API key
  const appName = options?.appName ?? 'default';
  const id = appName.toLowerCase().replace(/\s+/g, '-');
  const rawKey = `pk_${randomUUID().replace(/-/g, '')}`;
  const keyHash = hashSync(rawKey, 10);
  db.prepare(
    'INSERT INTO api_keys (id, key_hash, name, allowed_manifests) VALUES (?, ?, ?, ?)',
  ).run(id, keyHash, appName, JSON.stringify(['*']));

  db.close();

  // Write credentials file for auto-discovery by agents
  const hubUrl = `http://localhost:${port}`;
  writeCredentials({ hubUrl, apiKey: rawKey, hubDir: dir });

  return { secret, apiKey: rawKey, dbPath, configPath, envPath, credentialsPath: CREDENTIALS_PATH, credentialsFetched };
}

// --- Start / Stop / Status ---

/**
 * Start the PersonalDataHub server in the background.
 * Spawns a detached node process and writes the PID to ~/.pdh/server.pid.
 */
export function startBackground(hubDir?: string): { pid: number; hubDir: string } {
  const dir = hubDir ?? readCredentials()?.hubDir ?? process.cwd();
  const indexPath = resolve(dir, 'dist', 'index.js');

  if (!existsSync(indexPath)) {
    throw new Error(`Server entry not found at ${indexPath}. Run 'pnpm build' first.`);
  }

  // Check if already running
  const existing = getServerPid();
  if (existing !== null) {
    try {
      process.kill(existing, 0); // Check if process exists
      throw new Error(`Server is already running (PID ${existing}). Run 'npx pdh stop' first.`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
      // Process doesn't exist, stale PID file — clean up
    }
  }

  const child = spawn('node', [indexPath], {
    cwd: dir,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });

  child.unref();

  const pid = child.pid!;
  mkdirSync(CREDENTIALS_DIR, { recursive: true });
  writeFileSync(PID_PATH, String(pid), 'utf-8');

  return { pid, hubDir: dir };
}

/**
 * Stop the background PersonalDataHub server.
 */
export function stopBackground(): boolean {
  const pid = getServerPid();
  if (pid === null) return false;

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Process already gone
  }

  try { unlinkSync(PID_PATH); } catch { /* ignore */ }
  return true;
}

/**
 * Get the PID of the background server, or null if not running.
 */
export function getServerPid(): number | null {
  try {
    if (!existsSync(PID_PATH)) return null;
    const pid = parseInt(readFileSync(PID_PATH, 'utf-8').trim(), 10);
    if (isNaN(pid)) return null;
    process.kill(pid, 0); // Check if process exists
    return pid;
  } catch {
    return null;
  }
}

// --- Reset ---

const HUB_FILES = ['.env', 'hub-config.yaml', 'pdh.db', 'pdh.db-wal', 'pdh.db-shm'];
const CRED_FILES = [CREDENTIALS_PATH, PID_PATH];

/**
 * Remove all generated PersonalDataHub files so `init` can run again cleanly.
 * Stops the background server first if it's running.
 * Returns the list of files that were actually deleted.
 */
export function reset(hubDir?: string): string[] {
  // Stop the server if running
  stopBackground();

  // Resolve hubDir from credentials, fall back to cwd
  const dir = hubDir ?? readCredentials()?.hubDir ?? process.cwd();

  const removed: string[] = [];

  for (const name of HUB_FILES) {
    const p = resolve(dir, name);
    if (existsSync(p)) {
      unlinkSync(p);
      removed.push(p);
    }
  }

  for (const p of CRED_FILES) {
    if (existsSync(p)) {
      unlinkSync(p);
      removed.push(p);
    }
  }

  return removed;
}

// --- CLI runner (only executes when this file is the entry point) ---
// Resolve symlinks so this works with npx (which symlinks node_modules/.bin/pdh → dist/cli.js)
const isDirectRun = (() => {
  try {
    const self = fileURLToPath(import.meta.url);
    const invoked = realpathSync(process.argv[1]);
    return invoked === self;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  const command = process.argv[2];

  if (command === 'init') {
    const appName = process.argv[3] ?? 'default';
    try {
      const result = await init(undefined, { appName });
      console.log('\n  PersonalDataHub initialized successfully!\n');
      console.log(`  .env created            ${result.envPath}`);
      console.log(`  hub-config.yaml created  ${result.configPath}`);
      console.log(`  Database created         ${result.dbPath}`);
      console.log(`  Credentials saved        ${result.credentialsPath}`);
      console.log('\n  Next steps:');
      if (result.credentialsFetched) {
        console.log('    Default OAuth credentials configured. Just click Connect in the GUI.');
      } else {
        console.log('    Add OAuth credentials to hub-config.yaml — see docs/oauth-setup.md');
      }
      console.log('    Start the server:  npx pdh start');
      console.log('    Open the GUI:      http://localhost:3000\n');
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  } else if (command === 'start') {
    try {
      const result = startBackground();
      console.log(`\n  PersonalDataHub server started in background (PID ${result.pid})`);
      console.log(`  Hub directory: ${result.hubDir}`);
      console.log(`  GUI: http://localhost:3000`);
      console.log('\n  Note: The server does not auto-start on reboot.');
      console.log('  Run `npx pdh start` again after restarting your machine.\n');
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  } else if (command === 'stop') {
    if (stopBackground()) {
      console.log('\n  PersonalDataHub server stopped.\n');
    } else {
      console.log('\n  No running PersonalDataHub server found.\n');
    }
  } else if (command === 'status') {
    const pid = getServerPid();
    if (pid !== null) {
      console.log(`\n  PersonalDataHub server is running (PID ${pid})\n`);
    } else {
      console.log('\n  PersonalDataHub server is not running.\n');
    }
  } else if (command === 'reset') {
    try {
      const removed = reset();
      if (removed.length === 0) {
        console.log('\n  Nothing to remove — already clean.\n');
      } else {
        console.log('\n  PersonalDataHub reset complete. Removed:\n');
        for (const f of removed) {
          console.log(`    ${f}`);
        }
        console.log('\n  Run `npx pdh init` to start fresh.\n');
      }
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  } else if (command === 'demo-load') {
    try {
      const creds = readCredentials();
      const hubDir = creds?.hubDir && existsSync(resolve(creds.hubDir, 'pdh.db'))
        ? creds.hubDir
        : process.cwd();
      const dbPath = resolve(hubDir, 'pdh.db');
      if (!existsSync(dbPath)) {
        throw new Error(`No pdh.db found at ${dbPath}. Run 'npx pdh init' first.`);
      }
      const db = getDb(dbPath);
      const result = loadDemoData(db);
      db.close();
      console.log('\n  Demo data loaded successfully!\n');
      console.log(`  Emails:    ${result.emailCount} synthetic emails inserted`);
      console.log(`  Manifests: ${result.manifestCount} demo manifests created`);
      console.log('\n  Demo manifests:');
      console.log('    demo-gmail-readonly  — pull + select (title, body, labels, author_name)');
      console.log('    demo-gmail-metadata  — pull + select (title, labels, author_name only)');
      console.log('    demo-gmail-redacted  — pull + select + redact SSNs');
      console.log('\n  Try: npx pdh start, then POST /app/v1/pull with a demo manifest.\n');
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  } else if (command === 'demo-unload') {
    try {
      const creds = readCredentials();
      const hubDir = creds?.hubDir && existsSync(resolve(creds.hubDir, 'pdh.db'))
        ? creds.hubDir
        : process.cwd();
      const dbPath = resolve(hubDir, 'pdh.db');
      if (!existsSync(dbPath)) {
        throw new Error(`No pdh.db found at ${dbPath}. Run 'npx pdh init' first.`);
      }
      const db = getDb(dbPath);
      const result = unloadDemoData(db);
      db.close();
      console.log('\n  Demo data removed.\n');
      console.log(`  Emails removed:    ${result.emailsRemoved}`);
      console.log(`  Manifests removed: ${result.manifestsRemoved}\n`);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  } else {
    console.log('PersonalDataHub CLI v0.1.0');
    console.log('\nUsage:');
    console.log('  npx pdh init [app-name]   Bootstrap a new PersonalDataHub installation');
    console.log('  npx pdh start             Start the server in the background');
    console.log('  npx pdh stop              Stop the background server');
    console.log('  npx pdh status            Check if the server is running');
    console.log('  npx pdh reset             Remove all generated files and start fresh');
    console.log('  npx pdh demo-load         Load synthetic demo emails and manifests');
    console.log('  npx pdh demo-unload       Remove all demo data');
  }
}
