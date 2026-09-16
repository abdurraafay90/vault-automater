import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { ChainType } from './chains.js';
import type { TransferMethod } from './errors.js';

export type AutomationStatus = 'running' | 'paused' | 'stopped';
export type RunStatus = 'pending' | 'success' | 'failed';
export type BatchStatus = 'running' | 'completed' | 'cancelled';
export type BatchRowStatus = 'pending' | 'sending' | 'success' | 'failed' | 'cancelled';

/** An automation as exposed to clients. Never includes the stored secret. */
export type AutomationRecord = {
  id: string;
  vaultKey: string;
  vaultName: string;
  chainType: ChainType;
  vaultAddress: string;
  assetSymbol: string;
  senderAddress: string;
  minAmount: string;
  maxAmount: string;
  intervalSeconds: number;
  status: AutomationStatus;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastError: string | null;
  inFlightSince: number | null;
  runCount: number;
  hasSecret: boolean;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ClaimedAutomation = AutomationRecord & { secretCiphertext: string | null };

export type RunRecord = {
  id: string;
  automationId: string | null;
  batchId: string | null;
  batchRow: number | null;
  vaultKey: string;
  chainType: ChainType;
  vaultAddress: string;
  senderAddress: string;
  assetSymbol: string;
  amountBaseUnits: string;
  status: RunStatus;
  method: TransferMethod | null;
  txHash: string | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
};

export type BatchRowRecord = {
  rowIndex: number;
  walletAddress: string;
  senderAddress: string;
  amount: string;
  status: BatchRowStatus;
  txHash: string | null;
  error: string | null;
};

export type BatchRecord = {
  id: string;
  vaultKey: string;
  vaultName: string;
  chainType: ChainType;
  vaultAddress: string;
  assetSymbol: string;
  delaySeconds: number;
  status: BatchStatus;
  nextRow: number;
  rowCount: number;
  nextRunAt: number | null;
  inFlightSince: number | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  rows: BatchRowRecord[];
};

export type ClaimedBatchRow = {
  batch: Omit<BatchRecord, 'rows'>;
  row: BatchRowRecord & { secretCiphertext: string | null };
};

export type WorkerHeartbeat = { instanceId: string; pid: number; startedAt: number; beatAt: number };

export const INTERRUPTED_MESSAGE = 'The worker stopped while this send was in progress. It may have been broadcast — check the explorer before retrying.';

type Row = Record<string, unknown>;

const str = (value: unknown) => (value == null ? null : String(value));
const num = (value: unknown) => (value == null ? null : Number(value));

function toAutomation(row: Row): AutomationRecord {
  return {
    id: String(row.id),
    vaultKey: String(row.vault_key),
    vaultName: String(row.vault_name),
    chainType: row.chain_type as ChainType,
    vaultAddress: String(row.vault_address),
    assetSymbol: String(row.asset_symbol),
    senderAddress: String(row.sender_address),
    minAmount: String(row.min_amount),
    maxAmount: String(row.max_amount),
    intervalSeconds: Number(row.interval_seconds),
    status: row.status as AutomationStatus,
    nextRunAt: num(row.next_run_at),
    lastRunAt: num(row.last_run_at),
    lastError: str(row.last_error),
    inFlightSince: num(row.in_flight_since),
    runCount: Number(row.run_count),
    hasSecret: row.secret_ciphertext != null,
    createdBy: str(row.created_by),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toRun(row: Row): RunRecord {
  return {
    id: String(row.id),
    automationId: str(row.automation_id),
    batchId: str(row.batch_id),
    batchRow: num(row.batch_row),
    vaultKey: String(row.vault_key),
    chainType: row.chain_type as ChainType,
    vaultAddress: String(row.vault_address),
    senderAddress: String(row.sender_address),
    assetSymbol: String(row.asset_symbol),
    amountBaseUnits: String(row.amount_base_units),
    status: row.status as RunStatus,
    method: str(row.method) as TransferMethod | null,
    txHash: str(row.tx_hash),
    error: str(row.error),
    startedAt: Number(row.started_at),
    finishedAt: num(row.finished_at),
  };
}

function toBatch(row: Row): Omit<BatchRecord, 'rows'> {
  return {
    id: String(row.id),
    vaultKey: String(row.vault_key),
    vaultName: String(row.vault_name),
    chainType: row.chain_type as ChainType,
    vaultAddress: String(row.vault_address),
    assetSymbol: String(row.asset_symbol),
    delaySeconds: Number(row.delay_seconds),
    status: row.status as BatchStatus,
    nextRow: Number(row.next_row),
    rowCount: Number(row.row_count),
    nextRunAt: num(row.next_run_at),
    inFlightSince: num(row.in_flight_since),
    createdBy: str(row.created_by),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toBatchRow(row: Row): BatchRowRecord {
  return {
    rowIndex: Number(row.row_index),
    walletAddress: String(row.wallet_address),
    senderAddress: String(row.sender_address),
    amount: String(row.amount),
    status: row.status as BatchRowStatus,
    txHash: str(row.tx_hash),
    error: str(row.error),
  };
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS automations (
    id TEXT PRIMARY KEY,
    vault_key TEXT NOT NULL,
    vault_name TEXT NOT NULL,
    chain_type TEXT NOT NULL CHECK (chain_type IN ('zigchain', 'erc', 'bnb')),
    vault_address TEXT NOT NULL,
    asset_symbol TEXT NOT NULL,
    sender_address TEXT NOT NULL,
    secret_ciphertext TEXT,
    min_amount TEXT NOT NULL,
    max_amount TEXT NOT NULL,
    interval_seconds INTEGER NOT NULL CHECK (interval_seconds >= 1),
    status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'stopped')),
    next_run_at INTEGER,
    last_run_at INTEGER,
    last_error TEXT,
    in_flight_since INTEGER,
    lease_until INTEGER,
    run_count INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS automations_one_active_per_vault ON automations(vault_key) WHERE status != 'stopped';
  CREATE INDEX IF NOT EXISTS automations_due ON automations(status, next_run_at);

  CREATE TABLE IF NOT EXISTS automation_runs (
    id TEXT PRIMARY KEY,
    automation_id TEXT,
    batch_id TEXT,
    batch_row INTEGER,
    vault_key TEXT NOT NULL,
    chain_type TEXT NOT NULL,
    vault_address TEXT NOT NULL,
    sender_address TEXT NOT NULL,
    asset_symbol TEXT NOT NULL,
    amount_base_units TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'success', 'failed')),
    method TEXT,
    tx_hash TEXT,
    error TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS automation_runs_recent ON automation_runs(started_at DESC);

  CREATE TABLE IF NOT EXISTS automation_batches (
    id TEXT PRIMARY KEY,
    vault_key TEXT NOT NULL,
    vault_name TEXT NOT NULL,
    chain_type TEXT NOT NULL CHECK (chain_type IN ('zigchain', 'erc', 'bnb')),
    vault_address TEXT NOT NULL,
    asset_symbol TEXT NOT NULL,
    delay_seconds INTEGER NOT NULL CHECK (delay_seconds >= 1),
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'cancelled')),
    next_row INTEGER NOT NULL DEFAULT 0,
    row_count INTEGER NOT NULL,
    next_run_at INTEGER,
    in_flight_since INTEGER,
    lease_until INTEGER,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS automation_batches_one_running_per_vault ON automation_batches(vault_key) WHERE status = 'running';

  CREATE TABLE IF NOT EXISTS automation_batch_rows (
    batch_id TEXT NOT NULL REFERENCES automation_batches(id) ON DELETE CASCADE,
    row_index INTEGER NOT NULL,
    wallet_address TEXT NOT NULL,
    sender_address TEXT NOT NULL,
    secret_ciphertext TEXT,
    amount TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'success', 'failed', 'cancelled')),
    tx_hash TEXT,
    error TEXT,
    PRIMARY KEY (batch_id, row_index)
  );

  CREATE TABLE IF NOT EXISTS automation_worker_heartbeat (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    instance_id TEXT NOT NULL,
    pid INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    beat_at INTEGER NOT NULL
  );
`;

export type CreateAutomationInput = {
  vaultKey: string;
  vaultName: string;
  chainType: ChainType;
  vaultAddress: string;
  assetSymbol: string;
  senderAddress: string;
  secretCiphertext: string;
  minAmount: string;
  maxAmount: string;
  intervalSeconds: number;
  createdBy: string | null;
};

export type CreateBatchInput = {
  vaultKey: string;
  vaultName: string;
  chainType: ChainType;
  vaultAddress: string;
  assetSymbol: string;
  delaySeconds: number;
  createdBy: string | null;
  /**
   * Valid rows are 'pending' with an encrypted key. A row that failed
   * validation is stored as 'failed' with its reason and no key, so it is
   * visible in the batch but never sent — and never blocks the other rows.
   */
  rows: (
    | { status: 'pending'; walletAddress: string; senderAddress: string; secretCiphertext: string; amount: string }
    | { status: 'failed'; walletAddress: string; senderAddress: string; amount: string; error: string }
  )[];
};

export class AutomationStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(SCHEMA);
  }

  /** Opens the shared database the API's auth store also uses (.data/auth.sqlite). */
  static open(dataDirectory = process.env.VAULTFLOW_DATA_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../.data')): AutomationStore {
    mkdirSync(dataDirectory, { recursive: true });
    return new AutomationStore(new DatabaseSync(resolve(dataDirectory, 'auth.sqlite')));
  }

  close(): void {
    this.#db.close();
  }

  #transaction<T>(work: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  // ---------------------------------------------------------------- automations

  /** Starts a new automation for a vault, stopping (and wiping) any existing one. */
  createAutomation(input: CreateAutomationInput, now = Date.now()): AutomationRecord {
    return this.#transaction(() => {
      this.#db.prepare(`UPDATE automations SET status = 'stopped', next_run_at = NULL, secret_ciphertext = NULL, updated_at = ?
        WHERE vault_key = ? AND status != 'stopped'`).run(now, input.vaultKey);
      const row = this.#db.prepare(`INSERT INTO automations (id, vault_key, vault_name, chain_type, vault_address, asset_symbol, sender_address,
          secret_ciphertext, min_amount, max_amount, interval_seconds, status, next_run_at, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?) RETURNING *`).get(
        randomUUID(), input.vaultKey, input.vaultName, input.chainType, input.vaultAddress, input.assetSymbol, input.senderAddress,
        input.secretCiphertext, input.minAmount, input.maxAmount, input.intervalSeconds, now, input.createdBy, now, now,
      ) as Row;
      return toAutomation(row);
    });
  }

  /** The most recent automation for each vault. */
  listAutomations(): AutomationRecord[] {
    return (this.#db.prepare(`SELECT * FROM automations a
      WHERE a.created_at = (SELECT MAX(b.created_at) FROM automations b WHERE b.vault_key = a.vault_key)
      ORDER BY a.created_at DESC`).all() as Row[]).map(toAutomation);
  }

  getAutomation(id: string): AutomationRecord | null {
    const row = this.#db.prepare('SELECT * FROM automations WHERE id = ?').get(id) as Row | undefined;
    return row ? toAutomation(row) : null;
  }

  pauseAutomation(id: string, now = Date.now()): AutomationRecord | null {
    const row = this.#db.prepare(`UPDATE automations SET status = 'paused', next_run_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'running' RETURNING *`).get(now, id) as Row | undefined;
    return row ? toAutomation(row) : null;
  }

  resumeAutomation(id: string, now = Date.now()): AutomationRecord | null {
    const row = this.#db.prepare(`UPDATE automations SET status = 'running', next_run_at = ?, last_error = NULL, updated_at = ?
      WHERE id = ? AND status = 'paused' AND secret_ciphertext IS NOT NULL RETURNING *`).get(now, now, id) as Row | undefined;
    return row ? toAutomation(row) : null;
  }

  /** Stops for good and wipes the stored key. */
  stopAutomation(id: string, now = Date.now()): AutomationRecord | null {
    const row = this.#db.prepare(`UPDATE automations SET status = 'stopped', next_run_at = NULL, secret_ciphertext = NULL, updated_at = ?
      WHERE id = ? AND status != 'stopped' RETURNING *`).get(now, id) as Row | undefined;
    return row ? toAutomation(row) : null;
  }

  listDueAutomations(now: number, limit: number): { id: string; chainType: ChainType; senderAddress: string }[] {
    return (this.#db.prepare(`SELECT id, chain_type, sender_address FROM automations
      WHERE status = 'running' AND next_run_at <= ? AND in_flight_since IS NULL AND (lease_until IS NULL OR lease_until < ?)
      ORDER BY next_run_at LIMIT ?`).all(now, now, limit) as Row[])
      .map((row) => ({ id: String(row.id), chainType: row.chain_type as ChainType, senderAddress: String(row.sender_address) }));
  }

  /** Atomically takes a due automation; null if another claim or a status change won. */
  claimAutomation(id: string, now: number, leaseMs: number): ClaimedAutomation | null {
    const row = this.#db.prepare(`UPDATE automations SET in_flight_since = ?, lease_until = ?, next_run_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'running' AND next_run_at <= ? AND in_flight_since IS NULL AND (lease_until IS NULL OR lease_until < ?)
      RETURNING *`).get(now, now + leaseMs, now, id, now, now) as Row | undefined;
    return row ? { ...toAutomation(row), secretCiphertext: str(row.secret_ciphertext) } : null;
  }

  /**
   * Success schedules the next run from completion time. Failure pauses, so a
   * broken configuration cannot keep sending. A pause or stop made while the
   * run was in flight is preserved.
   */
  finishAutomationCycle(id: string, outcome: { ok: true } | { ok: false; error: string }, now = Date.now()): void {
    if (outcome.ok) {
      this.#db.prepare(`UPDATE automations SET in_flight_since = NULL, lease_until = NULL, last_run_at = ?, last_error = NULL,
          run_count = run_count + 1, updated_at = ?,
          next_run_at = CASE WHEN status = 'running' THEN ? + interval_seconds * 1000 ELSE NULL END
        WHERE id = ?`).run(now, now, now, id);
    } else {
      this.#db.prepare(`UPDATE automations SET in_flight_since = NULL, lease_until = NULL, last_run_at = ?, last_error = ?,
          next_run_at = NULL, updated_at = ?, status = CASE WHEN status = 'running' THEN 'paused' ELSE status END
        WHERE id = ?`).run(now, outcome.error, now, id);
    }
  }

  // ----------------------------------------------------------------------- runs

  startRun(input: Omit<RunRecord, 'id' | 'status' | 'method' | 'txHash' | 'error' | 'finishedAt'>): string {
    const id = randomUUID();
    this.#db.prepare(`INSERT INTO automation_runs (id, automation_id, batch_id, batch_row, vault_key, chain_type, vault_address,
        sender_address, asset_symbol, amount_base_units, status, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).run(
      id, input.automationId, input.batchId, input.batchRow, input.vaultKey, input.chainType, input.vaultAddress,
      input.senderAddress, input.assetSymbol, input.amountBaseUnits, input.startedAt,
    );
    return id;
  }

  finishRun(id: string, outcome: { status: 'success' | 'failed'; method?: TransferMethod | null; txHash?: string | null; error?: string | null }, now = Date.now()): void {
    this.#db.prepare(`UPDATE automation_runs SET status = ?, method = ?, tx_hash = ?, error = ?, finished_at = ? WHERE id = ?`)
      .run(outcome.status, outcome.method ?? null, outcome.txHash ?? null, outcome.error ?? null, now, id);
  }

  listRuns(limit = 100): RunRecord[] {
    return (this.#db.prepare('SELECT * FROM automation_runs ORDER BY started_at DESC LIMIT ?').all(limit) as Row[]).map(toRun);
  }

  // -------------------------------------------------------------------- batches

  createBatch(input: CreateBatchInput, now = Date.now()): BatchRecord {
    return this.#transaction(() => {
      const id = randomUUID();
      this.#db.prepare(`INSERT INTO automation_batches (id, vault_key, vault_name, chain_type, vault_address, asset_symbol, delay_seconds,
          status, next_row, row_count, next_run_at, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'running', 0, ?, ?, ?, ?, ?)`).run(
        id, input.vaultKey, input.vaultName, input.chainType, input.vaultAddress, input.assetSymbol, input.delaySeconds,
        input.rows.length, now, input.createdBy, now, now,
      );
      const insertRow = this.#db.prepare(`INSERT INTO automation_batch_rows (batch_id, row_index, wallet_address, sender_address, secret_ciphertext, amount, status, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      input.rows.forEach((row, index) => insertRow.run(
        id, index, row.walletAddress, row.senderAddress,
        row.status === 'pending' ? row.secretCiphertext : null,
        row.amount, row.status, row.status === 'failed' ? row.error : null,
      ));
      return this.getBatch(id)!;
    });
  }

  getBatch(id: string): BatchRecord | null {
    const row = this.#db.prepare('SELECT * FROM automation_batches WHERE id = ?').get(id) as Row | undefined;
    if (!row) return null;
    const rows = (this.#db.prepare('SELECT * FROM automation_batch_rows WHERE batch_id = ? ORDER BY row_index').all(id) as Row[]).map(toBatchRow);
    return { ...toBatch(row), rows };
  }

  listBatches(limit = 10): BatchRecord[] {
    return (this.#db.prepare('SELECT id FROM automation_batches ORDER BY created_at DESC LIMIT ?').all(limit) as Row[])
      .map((row) => this.getBatch(String(row.id))!)
      .filter(Boolean);
  }

  /** Cancels remaining rows and wipes every stored key in the batch. */
  cancelBatch(id: string, now = Date.now()): BatchRecord | null {
    return this.#transaction(() => {
      const changed = this.#db.prepare(`UPDATE automation_batches SET status = 'cancelled', next_run_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'running'`).run(now, id);
      if (Number(changed.changes) === 0) return null;
      this.#db.prepare(`UPDATE automation_batch_rows SET status = 'cancelled' WHERE batch_id = ? AND status = 'pending'`).run(id);
      this.#db.prepare('UPDATE automation_batch_rows SET secret_ciphertext = NULL WHERE batch_id = ?').run(id);
      return this.getBatch(id);
    });
  }

  listDueBatchRows(now: number, limit: number): { batchId: string; rowIndex: number; chainType: ChainType; senderAddress: string }[] {
    return (this.#db.prepare(`SELECT b.id AS batch_id, r.row_index, b.chain_type, r.sender_address
      FROM automation_batches b
      JOIN automation_batch_rows r ON r.batch_id = b.id
        AND r.row_index = (SELECT MIN(row_index) FROM automation_batch_rows WHERE batch_id = b.id AND status = 'pending')
      WHERE b.status = 'running' AND b.next_run_at <= ? AND b.in_flight_since IS NULL AND (b.lease_until IS NULL OR b.lease_until < ?)
      ORDER BY b.next_run_at LIMIT ?`).all(now, now, limit) as Row[])
      .map((row) => ({ batchId: String(row.batch_id), rowIndex: Number(row.row_index), chainType: row.chain_type as ChainType, senderAddress: String(row.sender_address) }));
  }

  claimBatchRow(batchId: string, rowIndex: number, now: number, leaseMs: number): ClaimedBatchRow | null {
    const rowGone = new Error('BATCH_ROW_NO_LONGER_PENDING');
    try {
      return this.#transaction(() => {
        const batch = this.#db.prepare(`UPDATE automation_batches SET in_flight_since = ?, lease_until = ?, next_run_at = NULL, updated_at = ?
          WHERE id = ? AND status = 'running' AND next_run_at <= ? AND in_flight_since IS NULL AND (lease_until IS NULL OR lease_until < ?)
          RETURNING *`).get(now, now + leaseMs, now, batchId, now, now) as Row | undefined;
        if (!batch) return null;
        const row = this.#db.prepare(`UPDATE automation_batch_rows SET status = 'sending'
          WHERE batch_id = ? AND row_index = ? AND status = 'pending' RETURNING *`).get(batchId, rowIndex) as Row | undefined;
        // Roll back the batch lease too: the row was cancelled or taken meanwhile.
        if (!row) throw rowGone;
        return { batch: toBatch(batch), row: { ...toBatchRow(row), secretCiphertext: str(row.secret_ciphertext) } };
      });
    } catch (error) {
      if (error === rowGone) return null;
      throw error;
    }
  }

  finishBatchRow(batchId: string, rowIndex: number, outcome: { status: 'success' | 'failed'; txHash?: string | null; error?: string | null }, now = Date.now()): void {
    this.#transaction(() => {
      this.#db.prepare(`UPDATE automation_batch_rows SET status = ?, tx_hash = ?, error = ?, secret_ciphertext = NULL
        WHERE batch_id = ? AND row_index = ?`).run(outcome.status, outcome.txHash ?? null, outcome.error ?? null, batchId, rowIndex);
      this.#db.prepare(`UPDATE automation_batches SET in_flight_since = NULL, lease_until = NULL, next_row = ?, updated_at = ?,
          next_run_at = CASE WHEN status = 'running' THEN ? + delay_seconds * 1000 ELSE NULL END
        WHERE id = ?`).run(rowIndex + 1, now, now, batchId);
    });
    this.completeFinishedBatches(now);
  }

  /** Marks running batches with no pending rows left as completed. */
  completeFinishedBatches(now = Date.now()): void {
    this.#db.prepare(`UPDATE automation_batches SET status = 'completed', next_run_at = NULL, updated_at = ?
      WHERE status = 'running' AND in_flight_since IS NULL
        AND NOT EXISTS (SELECT 1 FROM automation_batch_rows r WHERE r.batch_id = automation_batches.id AND r.status IN ('pending', 'sending'))`).run(now);
  }

  // ------------------------------------------------------------ worker lifecycle

  /**
   * Called once at worker start, after confirming no other worker is alive.
   * Anything left in flight was interrupted: it is marked failed and never
   * resent automatically, because the transaction may already be on-chain.
   */
  recoverInterrupted(now = Date.now()): { runs: number; automations: number; batchRows: number } {
    return this.#transaction(() => {
      const runs = this.#db.prepare(`UPDATE automation_runs SET status = 'failed', error = ?, finished_at = ? WHERE status = 'pending'`).run(INTERRUPTED_MESSAGE, now);
      const automations = this.#db.prepare(`UPDATE automations SET in_flight_since = NULL, lease_until = NULL, next_run_at = NULL, last_error = ?,
          updated_at = ?, status = CASE WHEN status = 'running' THEN 'paused' ELSE status END
        WHERE in_flight_since IS NOT NULL`).run(INTERRUPTED_MESSAGE, now);
      const batchRows = this.#db.prepare(`UPDATE automation_batch_rows SET status = 'failed', error = ?, secret_ciphertext = NULL WHERE status = 'sending'`).run(INTERRUPTED_MESSAGE);
      this.#db.prepare(`UPDATE automation_batches SET in_flight_since = NULL, lease_until = NULL, updated_at = ?,
          next_run_at = CASE WHEN status = 'running' THEN ? ELSE NULL END
        WHERE in_flight_since IS NOT NULL`).run(now, now);
      return { runs: Number(runs.changes), automations: Number(automations.changes), batchRows: Number(batchRows.changes) };
    });
  }

  beat(heartbeat: Omit<WorkerHeartbeat, 'beatAt'>, now = Date.now()): void {
    this.#db.prepare(`INSERT INTO automation_worker_heartbeat (id, instance_id, pid, started_at, beat_at) VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET instance_id = excluded.instance_id, pid = excluded.pid, started_at = excluded.started_at, beat_at = excluded.beat_at`)
      .run(heartbeat.instanceId, heartbeat.pid, heartbeat.startedAt, now);
  }

  readHeartbeat(): WorkerHeartbeat | null {
    const row = this.#db.prepare('SELECT * FROM automation_worker_heartbeat WHERE id = 1').get() as Row | undefined;
    return row ? { instanceId: String(row.instance_id), pid: Number(row.pid), startedAt: Number(row.started_at), beatAt: Number(row.beat_at) } : null;
  }

  clearHeartbeat(instanceId: string): void {
    this.#db.prepare('DELETE FROM automation_worker_heartbeat WHERE id = 1 AND instance_id = ?').run(instanceId);
  }
}
