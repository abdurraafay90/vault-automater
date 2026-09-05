import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export type AuthRole = 'ADMIN' | 'USER';
export type AuthUser = { id: string; email: string; role: AuthRole; active: boolean; createdAt: string };

const dataDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../../.data');
mkdirSync(dataDirectory, { recursive: true });
const database = new DatabaseSync(resolve(dataDirectory, 'auth.sqlite'));
database.exec('PRAGMA journal_mode = WAL');
database.exec('PRAGMA foreign_keys = ON');
database.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('ADMIN', 'USER')),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_token_idx ON sessions(token_hash, expires_at);
  CREATE TABLE IF NOT EXISTS custom_vaults (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT NOT NULL,
    chain_type TEXT NOT NULL,
    evm_network TEXT,
    token_address TEXT,
    token_symbol TEXT NOT NULL,
    token_decimals INTEGER NOT NULL,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

try {
  database.exec('ALTER TABLE custom_vaults ADD COLUMN evm_network TEXT');
} catch {}
try {
  database.exec('ALTER TABLE custom_vaults ADD COLUMN token_address TEXT');
} catch {}
try {
  database.exec(`
    UPDATE custom_vaults
    SET token_address = '0xebe4f4ac8a99979934aad3db24edd0caf6a6e934'
    WHERE (LOWER(token_symbol) = 'musdc') AND (token_address IS NULL OR token_address = '')
  `);
} catch {}

function normalizeEmail(email: string) { return email.trim().toLowerCase(); }
function tokenHash(token: string) { return createHash('sha256').update(token).digest('hex'); }

function passwordHash(password: string) {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

function verifyPassword(password: string, stored: string) {
  const [algorithm, encodedSalt, encodedHash] = stored.split('$');
  if (algorithm !== 'scrypt' || !encodedSalt || !encodedHash) return false;
  const expected = Buffer.from(encodedHash, 'base64');
  const actual = scryptSync(password, Buffer.from(encodedSalt, 'base64'), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function toUser(row: Record<string, unknown>): AuthUser {
  return { id: String(row.id), email: String(row.email), role: row.role as AuthRole, active: Boolean(row.active), createdAt: String(row.created_at) };
}

export function ensureAdmin(email: string, password: string) {
  const existingAdmin = database.prepare("SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1").get() as { id: string } | undefined;
  if (existingAdmin) {
    database.prepare('UPDATE users SET email = ?, password_hash = ?, active = 1 WHERE id = ?')
      .run(normalizeEmail(email), passwordHash(password), existingAdmin.id);
    return;
  }
  database.prepare('INSERT INTO users (id, email, password_hash, role, active, created_at) VALUES (?, ?, ?, ?, 1, ?)')
    .run(randomUUID(), normalizeEmail(email), passwordHash(password), 'ADMIN', new Date().toISOString());
}

export function authenticate(email: string, password: string): AuthUser | null {
  const row = database.prepare('SELECT * FROM users WHERE email = ? AND active = 1 LIMIT 1').get(normalizeEmail(email)) as Record<string, unknown> | undefined;
  if (!row || !verifyPassword(password, String(row.password_hash))) return null;
  return toUser(row);
}

export function createSession(userId: string, ttlSeconds: number) {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  database.prepare('INSERT INTO sessions (id, token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(randomUUID(), tokenHash(token), userId, expiresAt.toISOString(), now.toISOString());
  return { token, expiresAt };
}

export function userForSession(token: string): AuthUser | null {
  const row = database.prepare(`
    SELECT users.* FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.revoked_at IS NULL AND sessions.expires_at > ? AND users.active = 1
    LIMIT 1
  `).get(tokenHash(token), new Date().toISOString()) as Record<string, unknown> | undefined;
  return row ? toUser(row) : null;
}

export function revokeSession(token: string) {
  database.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(new Date().toISOString(), tokenHash(token));
}

export function listUsers() {
  return (database.prepare('SELECT id, email, role, active, created_at FROM users ORDER BY created_at ASC').all() as Record<string, unknown>[]).map(toUser);
}

export function createUser(email: string, password: string): AuthUser {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  database.prepare('INSERT INTO users (id, email, password_hash, role, active, created_at) VALUES (?, ?, ?, ?, 1, ?)')
    .run(id, normalizeEmail(email), passwordHash(password), 'USER', createdAt);
  return { id, email: normalizeEmail(email), role: 'USER', active: true, createdAt };
}

export type CustomVault = {
  id: string;
  name: string;
  address: string;
  chainType: 'zigchain' | 'erc';
  evmNetwork?: 'mainnet' | 'testnet' | undefined;
  tokenSymbol: string;
  tokenDecimals: number;
  tokenAddress?: string | undefined;
  summary: string;
  createdAt: string;
};

export function listCustomVaults(): CustomVault[] {
  return (database.prepare('SELECT id, name, address, chain_type, evm_network, token_address, token_symbol, token_decimals, summary, created_at FROM custom_vaults ORDER BY created_at ASC').all() as Record<string, unknown>[]).map((row) => ({
    id: String(row.id),
    name: String(row.name),
    address: String(row.address),
    chainType: (row.chain_type === 'erc' ? 'erc' : 'zigchain') as 'zigchain' | 'erc',
    evmNetwork: row.evm_network === 'mainnet' ? 'mainnet' : row.evm_network === 'testnet' ? 'testnet' : undefined,
    tokenAddress: row.token_address ? String(row.token_address) : undefined,
    tokenSymbol: String(row.token_symbol || (row.chain_type === 'erc' ? 'ETH' : 'ZIG')),
    tokenDecimals: Number(row.token_decimals || (row.chain_type === 'erc' ? 18 : 6)),
    summary: String(row.summary || ''),
    createdAt: String(row.created_at),
  }));
}

export function createCustomVault(data: { name: string; address: string; chainType: 'zigchain' | 'erc'; evmNetwork?: 'mainnet' | 'testnet' | undefined; tokenSymbol?: string | undefined; tokenDecimals?: number | undefined; tokenAddress?: string | undefined; summary?: string | undefined }): CustomVault {
  const id = `vault-${randomUUID()}`;
  const createdAt = new Date().toISOString();
  const tokenSymbol = data.tokenSymbol || (data.chainType === 'erc' ? 'ETH' : 'ZIG');
  const tokenDecimals = data.tokenDecimals ?? (data.chainType === 'erc' ? 18 : 6);
  const tokenAddress = data.tokenAddress ? data.tokenAddress.trim() : null;
  const summary = data.summary || `${data.chainType === 'erc' ? 'ERC / EVM' : 'ZIGChain'} custom strategy`;
  const evmNetwork = data.chainType === 'erc' ? (data.evmNetwork || 'testnet') : null;
  database.prepare(`
    INSERT INTO custom_vaults (id, name, address, chain_type, evm_network, token_address, token_symbol, token_decimals, summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, data.name.trim(), data.address.trim(), data.chainType, evmNetwork, tokenAddress, tokenSymbol, tokenDecimals, summary, createdAt);
  return { id, name: data.name.trim(), address: data.address.trim(), chainType: data.chainType, evmNetwork: evmNetwork || undefined, tokenAddress: tokenAddress || undefined, tokenSymbol, tokenDecimals, summary, createdAt };
}

export function deleteCustomVault(id: string): boolean {
  const result = database.prepare('DELETE FROM custom_vaults WHERE id = ?').run(id);
  return (result.changes ?? 0) > 0;
}

