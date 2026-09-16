import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { ChainType } from './chains.js';
import { evmWalletFromSecret } from './evm.js';
import { ExecutionError } from './errors.js';
import { zigSignerFromSecret } from './zig.js';

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * AUTOMATION_ENCRYPTION_KEY must decode to exactly 32 bytes (base64 or hex).
 * Generate one with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */
export function parseEncryptionKey(raw: string | undefined): Buffer {
  const value = (raw ?? '').trim();
  if (!value) throw new Error('AUTOMATION_ENCRYPTION_KEY is not set. Server-side automation stores wallet keys encrypted and cannot run without it.');
  const key = /^[0-9a-fA-F]{64}$/.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('AUTOMATION_ENCRYPTION_KEY must decode to exactly 32 bytes (base64 or 64 hex characters).');
  return key;
}

/** AES-256-GCM. Output: "v1:" + base64(iv | authTag | ciphertext). */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')}`;
}

export function decryptSecret(payload: string, key: Buffer): string {
  const [version, body] = payload.split(':', 2);
  if (version !== VERSION || !body) throw new ExecutionError('Stored wallet key has an unknown format. Stop this automation and start it again.');
  const raw = Buffer.from(body, 'base64');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
  } catch {
    throw new ExecutionError('Stored wallet key could not be decrypted — AUTOMATION_ENCRYPTION_KEY has changed. Stop this automation and start it again with the wallet key.');
  }
}

/** The address a secret controls; also validates the secret's format. */
export async function deriveSenderAddress(chainType: ChainType, secret: string): Promise<string> {
  if (chainType === 'zigchain') {
    const [account] = await (await zigSignerFromSecret(secret)).getAccounts();
    if (!account) throw new ExecutionError('No ZIGChain account could be derived from the key.');
    return account.address;
  }
  return evmWalletFromSecret(secret).address;
}
