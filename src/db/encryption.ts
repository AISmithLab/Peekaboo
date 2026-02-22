import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SALT = 'pdh-salt-v1';

/**
 * Derive a 32-byte encryption key from a master secret.
 */
function deriveKey(masterSecret: string): Buffer {
  return scryptSync(masterSecret, SALT, 32);
}

/**
 * Encrypt a plaintext string. Returns a base64-encoded string containing IV + ciphertext + auth tag.
 */
export function encryptField(plaintext: string, masterSecret: string): string {
  const key = deriveKey(masterSecret);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Format: iv (12 bytes) + tag (16 bytes) + ciphertext
  const result = Buffer.concat([iv, tag, encrypted]);
  return result.toString('base64');
}

/**
 * Decrypt a base64-encoded encrypted string back to plaintext.
 */
export function decryptField(encryptedBase64: string, masterSecret: string): string {
  const key = deriveKey(masterSecret);
  const data = Buffer.from(encryptedBase64, 'base64');

  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}
