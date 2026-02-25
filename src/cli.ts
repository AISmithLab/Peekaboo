#!/usr/bin/env node
/**
 * PersonalDataHub CLI — bootstrap and manage a PersonalDataHub installation.
 *
 * Usage:
 *   npx pdh init [app-name]    Bootstrap a new installation
 *   npx pdh start              Start the server in the background
 *   npx pdh stop               Stop the background server
 *   npx pdh status             Check if the server is running
 *   npx pdh mcp                Start a stdio MCP server for agent access
 *   npx pdh install-service    Install a systemd/launchd service for auto-start
 *   npx pdh uninstall-service  Remove the auto-start service
 *   npx pdh reset              Remove all generated files and start fresh
 */

import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { spawn, execSync } from 'node:child_process';
import { hashSync } from 'bcryptjs';
import { getDb } from './db/db.js';
import { osUserExists, createOsUser, lockdownFiles, checkProcessOwner, PDH_USER, ensureSudo, isRunningAsPdhUser } from './os-user.js';


// --- Config file path ---

export const CONFIG_DIR = join(homedir(), '.pdh');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
const PID_PATH = join(CONFIG_DIR, 'server.pid');

export interface HubConfig {
  hubUrl: string;
  hubDir: string;
}

/**
 * Write config to ~/.pdh/config.json.
 * Creates the directory if it doesn't exist.
 */
export function writeConfig(config: HubConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * Read config from ~/.pdh/config.json.
 * Returns null if the file doesn't exist or is malformed.
 */
export function readConfig(): HubConfig | null {
  try {
    if (!existsSync(CONFIG_PATH)) return null;
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed.hubUrl) return parsed as HubConfig;
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
  password: string;
  dbPath: string;
  configPath: string;
  envPath: string;
  globalConfigPath: string;
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
 * and writes config to ~/.pdh/config.json.
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

  // Generate owner password
  const password = randomBytes(16).toString('base64url');
  const passwordHash = hashSync(password, 10);
  db.prepare(
    'INSERT INTO owner_auth (id, password_hash) VALUES (1, ?)',
  ).run(passwordHash);

  db.close();

  // Write config file for auto-discovery by agents
  const hubUrl = `http://localhost:${port}`;
  writeConfig({ hubUrl, hubDir: dir });

  return { secret, password, dbPath, configPath, envPath, globalConfigPath: CONFIG_PATH, credentialsFetched };
}

// --- Start / Stop / Status ---

/**
 * Start the PersonalDataHub server in the background.
 * If the `personaldatahub` OS user exists, launches the server as that user
 * via `sudo -u` for process isolation. Otherwise runs as the current user.
 * Writes the PID to ~/.pdh/server.pid.
 */
export function startBackground(hubDir?: string): { pid: number; hubDir: string; isolated: boolean } {
  const dir = hubDir ?? readConfig()?.hubDir ?? process.cwd();
  const indexPath = resolve(dir, 'dist', 'index.js');

  if (!existsSync(indexPath)) {
    throw new Error(`Server entry not found at ${indexPath}. Run 'pnpm build' first.`);
  }

  // Check if already running
  const existing = getServerPid();
  if (existing !== null) {
    throw new Error(`Server is already running (PID ${existing}). Run 'npx pdh stop' first.`);
  }

  const alreadyPdh = isRunningAsPdhUser();
  const isolated = !alreadyPdh && osUserExists();
  let child;

  if (isolated) {
    // Running as main user but personaldatahub user exists — launch via sudo
    ensureSudo();
    child = spawn('sudo', ['-n', '-u', PDH_USER, 'node', indexPath], {
      cwd: dir,
      detached: true,
      stdio: 'ignore',
    });
  } else {
    // Running as personaldatahub directly, or no dedicated user — launch node directly
    child = spawn('node', [indexPath], {
      cwd: dir,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
  }

  child.unref();

  const pid = child.pid!;
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(PID_PATH, String(pid), 'utf-8');

  return { pid, hubDir: dir, isolated };
}

/**
 * Stop the background PersonalDataHub server.
 * Uses `sudo kill` if the server is running as a different user.
 */
export function stopBackground(): boolean {
  const pid = getServerPid();
  if (pid === null) return false;

  const owner = checkProcessOwner(pid);

  if (owner === 'other_user') {
    // Server runs as personaldatahub user — need sudo to kill
    try {
      execSync(`sudo kill ${pid}`, { stdio: 'inherit' });
    } catch {
      // Process may have already exited
    }
  } else if (owner === 'same_user') {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Process already gone
    }
  }

  try { unlinkSync(PID_PATH); } catch { /* ignore */ }
  return true;
}

/**
 * Get the PID of the background server, or null if not running.
 * Handles processes owned by the `personaldatahub` user (EPERM on signal).
 */
export function getServerPid(): number | null {
  if (!existsSync(PID_PATH)) return null;
  const pid = parseInt(readFileSync(PID_PATH, 'utf-8').trim(), 10);
  if (isNaN(pid)) return null;

  const owner = checkProcessOwner(pid);
  if (owner === 'not_found') return null;
  return pid;
}

// --- Reset ---

const HUB_FILES = ['.env', 'hub-config.yaml', 'pdh.db', 'pdh.db-wal', 'pdh.db-shm'];
const CRED_FILES = [CONFIG_PATH, PID_PATH];

/**
 * Remove all generated PersonalDataHub files so `init` can run again cleanly.
 * Stops the background server first if it's running.
 * Uses sudo to remove files owned by the `personaldatahub` user if needed.
 * Returns the list of files that were actually deleted.
 */
export function reset(hubDir?: string): string[] {
  // Stop the server if running
  stopBackground();

  // Resolve hubDir from config, fall back to cwd
  const dir = hubDir ?? readConfig()?.hubDir ?? process.cwd();

  const removed: string[] = [];

  for (const name of HUB_FILES) {
    const p = resolve(dir, name);
    if (existsSync(p)) {
      try {
        unlinkSync(p);
      } catch {
        // File may be owned by personaldatahub — try sudo
        execSync(`sudo rm "${p}"`, { stdio: 'inherit' });
      }
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

// --- Service install / uninstall ---

const SYSTEMD_PATH = '/etc/systemd/system/personaldatahub.service';
const LAUNCHD_PATH = '/Library/LaunchDaemons/com.personaldatahub.server.plist';

/**
 * Install a system service so PersonalDataHub starts automatically on reboot.
 * Creates a systemd unit (Linux) or launchd plist (macOS).
 * Requires sudo.
 */
export function installService(hubDir?: string): { platform: string; servicePath: string } {
  const dir = hubDir ?? readConfig()?.hubDir ?? process.cwd();
  const nodePath = process.execPath;
  const os = process.platform;

  if (os === 'linux') {
    const unit = [
      '[Unit]',
      'Description=PersonalDataHub Server',
      'After=network.target',
      '',
      '[Service]',
      'Type=simple',
      `User=${PDH_USER}`,
      `WorkingDirectory=${dir}`,
      `ExecStart=${nodePath} dist/index.js`,
      'Restart=on-failure',
      'RestartSec=5',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      '',
    ].join('\n');

    writeFileSync(SYSTEMD_PATH, unit, 'utf-8');
    execSync('systemctl daemon-reload', { stdio: 'inherit' });
    execSync('systemctl enable personaldatahub', { stdio: 'inherit' });

    return { platform: 'linux', servicePath: SYSTEMD_PATH };
  } else if (os === 'darwin') {
    const plist = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>Label</key>',
      '  <string>com.personaldatahub.server</string>',
      '  <key>UserName</key>',
      `  <string>${PDH_USER}</string>`,
      '  <key>WorkingDirectory</key>',
      `  <string>${dir}</string>`,
      '  <key>ProgramArguments</key>',
      '  <array>',
      `    <string>${nodePath}</string>`,
      '    <string>dist/index.js</string>',
      '  </array>',
      '  <key>RunAtLoad</key>',
      '  <true/>',
      '  <key>KeepAlive</key>',
      '  <true/>',
      '  <key>StandardOutPath</key>',
      `  <string>${resolve(dir, 'pdh.log')}</string>`,
      '  <key>StandardErrorPath</key>',
      `  <string>${resolve(dir, 'pdh.log')}</string>`,
      '</dict>',
      '</plist>',
      '',
    ].join('\n');

    writeFileSync(LAUNCHD_PATH, plist, 'utf-8');
    execSync(`launchctl load ${LAUNCHD_PATH}`, { stdio: 'inherit' });

    return { platform: 'darwin', servicePath: LAUNCHD_PATH };
  } else {
    throw new Error(`Unsupported platform: ${os}. Service install requires macOS or Linux.`);
  }
}

/**
 * Uninstall the system service created by installService().
 */
export function uninstallService(): { removed: boolean; servicePath: string } {
  const os = process.platform;

  if (os === 'linux') {
    if (!existsSync(SYSTEMD_PATH)) {
      return { removed: false, servicePath: SYSTEMD_PATH };
    }
    execSync('systemctl stop personaldatahub', { stdio: 'inherit' });
    execSync('systemctl disable personaldatahub', { stdio: 'inherit' });
    unlinkSync(SYSTEMD_PATH);
    execSync('systemctl daemon-reload', { stdio: 'inherit' });
    return { removed: true, servicePath: SYSTEMD_PATH };
  } else if (os === 'darwin') {
    if (!existsSync(LAUNCHD_PATH)) {
      return { removed: false, servicePath: LAUNCHD_PATH };
    }
    execSync(`launchctl unload ${LAUNCHD_PATH}`, { stdio: 'inherit' });
    unlinkSync(LAUNCHD_PATH);
    return { removed: true, servicePath: LAUNCHD_PATH };
  } else {
    throw new Error(`Unsupported platform: ${os}. Service uninstall requires macOS or Linux.`);
  }
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
      console.log(`  Config saved             ${result.globalConfigPath}`);

      // Phase 4: Process isolation — create OS user and lock down sensitive files
      try {
        console.log('\n  Setting up process isolation...');
        if (isRunningAsPdhUser()) {
          // Already running as personaldatahub — just chmod, no sudo needed
          lockdownFiles([result.envPath, result.configPath, result.dbPath]);
          console.log(`  Running as '${PDH_USER}' — files locked down with mode 0600`);
        } else {
          createOsUser();
          lockdownFiles([result.envPath, result.configPath, result.dbPath]);
          console.log(`  Created '${PDH_USER}' OS user`);
          console.log(`  Sensitive files owned by '${PDH_USER}' with mode 0600`);
        }
      } catch (isoErr) {
        console.log(`\n  Warning: Process isolation not configured: ${(isoErr as Error).message}`);
        console.log('  The server will run as the current user. See docs/SETUP.md for manual setup.');
      }

      console.log(`\n  Owner password: ${result.password}`);
      console.log('  (Save this — you need it to log into the GUI)\n');
      console.log('  Next steps:');
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
      if (result.isolated) {
        console.log(`  Running as: ${PDH_USER} (process isolation enabled)`);
      }
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
  } else if (command === 'mcp') {
    try {
      const { startMcpServer } = await import('./mcp/server.js');
      await startMcpServer();
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  } else if (command === 'install-service') {
    try {
      const result = installService();
      console.log(`\n  Service installed (${result.platform}).`);
      console.log(`  Service file: ${result.servicePath}`);
      console.log('  PersonalDataHub will start automatically on reboot.');
      if (result.platform === 'linux') {
        console.log('\n  Manage with:');
        console.log('    sudo systemctl status personaldatahub');
        console.log('    sudo systemctl stop personaldatahub');
        console.log('    sudo systemctl restart personaldatahub');
        console.log('    journalctl -u personaldatahub -f');
      } else {
        console.log('\n  Manage with:');
        console.log('    sudo launchctl list | grep personaldatahub');
        console.log(`    sudo launchctl unload ${result.servicePath}`);
        console.log(`    sudo launchctl load ${result.servicePath}`);
      }
      console.log('\n  To remove: npx pdh uninstall-service\n');
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  } else if (command === 'uninstall-service') {
    try {
      const result = uninstallService();
      if (result.removed) {
        console.log(`\n  Service removed: ${result.servicePath}`);
        console.log('  PersonalDataHub will no longer start on reboot.\n');
      } else {
        console.log('\n  No service found to remove.\n');
      }
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
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
  } else {
    console.log('PersonalDataHub CLI v0.1.0');
    console.log('\nUsage:');
    console.log('  npx pdh init [app-name]   Bootstrap a new PersonalDataHub installation');
    console.log('  npx pdh start             Start the server in the background');
    console.log('  npx pdh stop              Stop the background server');
    console.log('  npx pdh status            Check if the server is running');
    console.log('  npx pdh mcp               Start a stdio MCP server for agent access');
    console.log('  npx pdh install-service   Install a systemd/launchd service for auto-start');
    console.log('  npx pdh uninstall-service Remove the auto-start service');
    console.log('  npx pdh reset             Remove all generated files and start fresh');
  }
}
