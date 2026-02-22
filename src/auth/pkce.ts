import { randomBytes, createHash } from 'node:crypto';
import type { HubConfigParsed } from '../config/schema.js';

// --- PKCE utilities ---

/**
 * Generate a cryptographically random code verifier (RFC 7636 §4.1).
 * 64 random bytes → base64url → 86 characters.
 */
export function generateCodeVerifier(): string {
  return randomBytes(64).toString('base64url');
}

/**
 * Compute the S256 code challenge from a code verifier (RFC 7636 §4.2).
 * SHA-256 hash of the verifier → base64url.
 */
export function computeCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

// --- Credential resolution ---

export interface ResolvedCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Returns Gmail OAuth credentials from config.
 * Credentials are set in hub-config.yaml under sources.gmail.owner_auth.
 */
export function getGmailCredentials(config: HubConfigParsed): ResolvedCredentials {
  const gmailConfig = config.sources.gmail;
  return {
    clientId: gmailConfig?.owner_auth.clientId ?? '',
    clientSecret: gmailConfig?.owner_auth.clientSecret ?? '',
  };
}

/**
 * Returns GitHub OAuth credentials from config.
 * Credentials are set in hub-config.yaml under sources.github.owner_auth.
 */
export function getGitHubCredentials(config: HubConfigParsed): ResolvedCredentials {
  const githubConfig = config.sources.github;
  return {
    clientId: githubConfig?.owner_auth.clientId ?? '',
    clientSecret: githubConfig?.owner_auth.clientSecret ?? '',
  };
}
