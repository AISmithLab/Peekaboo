/**
 * OS user management for process isolation.
 *
 * PersonalDataHub runs as a dedicated OS user (`personaldatahub`) so that
 * agents cannot read OAuth tokens or the database directly. This module
 * handles creating that user and locking down sensitive files.
 */

import { execSync } from 'node:child_process';
import { platform, userInfo } from 'node:os';
import { existsSync, chmodSync, chownSync } from 'node:fs';

export const PDH_USER = 'personaldatahub';

/**
 * Check whether the `personaldatahub` OS user exists.
 */
export function osUserExists(): boolean {
  try {
    execSync(`id ${PDH_USER}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the home directory for the `personaldatahub` user.
 */
export function getOsUserHome(): string {
  if (platform() === 'darwin') {
    return `/Users/${PDH_USER}`;
  }
  return `/home/${PDH_USER}`;
}

/**
 * Create the `personaldatahub` OS user. Requires sudo.
 * No-op if the user already exists.
 *
 * On macOS: creates a hidden system user via dscl.
 * On Linux: creates a system user via useradd.
 */
export function createOsUser(): void {
  if (osUserExists()) return;

  const os = platform();

  if (os === 'darwin') {
    createOsUserMac();
  } else if (os === 'linux') {
    createOsUserLinux();
  } else {
    throw new Error(
      `Unsupported platform: ${os}. Process isolation requires macOS or Linux.`,
    );
  }
}

function createOsUserMac(): void {
  const home = getOsUserHome();
  const uid = findAvailableUidMac();

  const cmds = [
    `sudo dscl . -create /Users/${PDH_USER}`,
    `sudo dscl . -create /Users/${PDH_USER} UserShell /bin/zsh`,
    `sudo dscl . -create /Users/${PDH_USER} RealName "PersonalDataHub"`,
    `sudo dscl . -create /Users/${PDH_USER} UniqueID ${uid}`,
    `sudo dscl . -create /Users/${PDH_USER} PrimaryGroupID 20`,
    `sudo dscl . -create /Users/${PDH_USER} NFSHomeDirectory ${home}`,
    `sudo dscl . -create /Users/${PDH_USER} IsHidden 1`,
  ];

  for (const cmd of cmds) {
    execSync(cmd, { stdio: 'inherit' });
  }

  if (!existsSync(home)) {
    execSync(`sudo mkdir -p ${home}`, { stdio: 'inherit' });
  }
  execSync(`sudo chown ${PDH_USER}:staff ${home}`, { stdio: 'inherit' });
}

function createOsUserLinux(): void {
  execSync(
    `sudo useradd --system --create-home --shell /bin/bash ${PDH_USER}`,
    { stdio: 'inherit' },
  );
}

/**
 * Find an available UID in the macOS system user range (400-499).
 * UIDs below 500 are hidden from the login window.
 */
export function findAvailableUidMac(): number {
  const output = execSync('dscl . -list /Users UniqueID', { encoding: 'utf-8' });
  const usedUids = new Set<number>();

  for (const line of output.trim().split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) {
      const uid = parseInt(parts[parts.length - 1], 10);
      if (!isNaN(uid)) usedUids.add(uid);
    }
  }

  for (let uid = 400; uid < 500; uid++) {
    if (!usedUids.has(uid)) return uid;
  }

  throw new Error('No available UID in system range 400-499');
}

/**
 * Check if the current process is running as the `personaldatahub` user.
 */
export function isRunningAsPdhUser(): boolean {
  try {
    return userInfo().username === PDH_USER;
  } catch {
    return false;
  }
}

/**
 * Change ownership of files to the `personaldatahub` user and set mode 0600.
 * If already running as `personaldatahub`, uses direct chmod (no sudo needed).
 * Otherwise requires sudo.
 */
export function lockdownFiles(paths: string[]): void {
  const alreadyPdh = isRunningAsPdhUser();

  for (const p of paths) {
    if (!existsSync(p)) continue;
    if (alreadyPdh) {
      chmodSync(p, 0o600);
    } else {
      const group = platform() === 'darwin' ? 'staff' : PDH_USER;
      execSync(`sudo chown ${PDH_USER}:${group} "${p}"`, { stdio: 'inherit' });
      execSync(`sudo chmod 600 "${p}"`, { stdio: 'inherit' });
    }
  }
}

/**
 * Ensure sudo credentials are cached (prompts the user if needed).
 * Subsequent `sudo -n` calls will succeed without prompting.
 */
export function ensureSudo(): void {
  execSync('sudo -v', { stdio: 'inherit' });
}

/**
 * Check if a process exists but is owned by a different user.
 * Returns 'same_user' if we can signal it, 'other_user' if EPERM, 'not_found' if gone.
 */
export function checkProcessOwner(pid: number): 'same_user' | 'other_user' | 'not_found' {
  try {
    process.kill(pid, 0);
    return 'same_user';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') {
      return 'other_user';
    }
    return 'not_found';
  }
}
