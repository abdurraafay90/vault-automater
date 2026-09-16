import { randomUUID } from 'node:crypto';
import {
  AutomationStore,
  DEFAULT_BSC_RPC_URLS,
  DEFAULT_ETH_RPC_URLS,
  WORKER_HEARTBEAT_STALE_MS,
  decryptSecret,
  describeExecutionError,
  findStablecoin,
  parseEncryptionKey,
  parseTokenAmount,
  randomAmount,
  sendEvmStablecoin,
  sendZigStablecoin,
  splitUrlList,
  type ChainType,
  type ClaimedAutomation,
  type ClaimedBatchRow,
  type IbcConfig,
  type StablecoinAsset,
  type TransferResult,
} from '@vaultflow/automation';

if (process.env.NODE_ENV !== 'production') {
  try {
    process.loadEnvFile(new URL('../../../.env', import.meta.url));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

// A lease outlives the longest possible send (10 min confirmation timeout) so a
// slow send is never claimed twice.
const LEASE_MS = 15 * 60_000;
const TICK_MS = Math.max(250, Number(process.env.AUTOMATION_TICK_MS ?? 1000));
const MAX_CONCURRENCY = Math.max(1, Number(process.env.AUTOMATION_MAX_CONCURRENCY ?? 4));

function log(event: string, fields: Record<string, unknown> = {}) {
  console.info(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
}

let encryptionKey: Buffer;
try {
  encryptionKey = parseEncryptionKey(process.env.AUTOMATION_ENCRYPTION_KEY);
} catch (error) {
  log('worker_configuration_invalid', { error: (error as Error).message });
  process.exit(1);
}

const chain = {
  ethRpcUrls: splitUrlList(process.env.ETH_RPC_URLS, DEFAULT_ETH_RPC_URLS),
  bscRpcUrls: splitUrlList(process.env.BSC_RPC_URLS, DEFAULT_BSC_RPC_URLS),
  zigRpcUrl: process.env.RPC_URL?.trim() ?? '',
  zigGasDenom: process.env.NATIVE_TOKEN_DENOM?.trim() || 'uzig',
  ibc: {
    sourcePort: process.env.IBC_SOURCE_PORT?.trim() || 'transfer',
    sourceChannel: process.env.IBC_SOURCE_CHANNEL?.trim() || 'channel-3',
    timeoutSeconds: Number(process.env.IBC_TIMEOUT_SECONDS ?? 600),
    orbiter: {
      enabled: process.env.ORBITER_CCTP_ENABLED === 'true',
      feeRecipient: process.env.ORBITER_FEE_RECIPIENT ?? '',
      feeAmount: process.env.ORBITER_FEE_AMOUNT ?? '',
      destinationDomain: Number(process.env.ORBITER_CCTP_DESTINATION_DOMAIN ?? 0),
      mintRecipient: process.env.ORBITER_CCTP_MINT_RECIPIENT ?? '',
      destinationCaller: process.env.ORBITER_CCTP_DESTINATION_CALLER ?? '',
      passthroughPayload: process.env.ORBITER_PASSTHROUGH_PAYLOAD ?? '',
    },
  } satisfies IbcConfig,
};

const store = AutomationStore.open();
const instanceId = randomUUID();
const startedAt = Date.now();

// Only one worker may run against the database: two would double-send. A
// fresh heartbeat may just be a previous instance that was hard-killed (tsx
// watch restarts, Windows has no graceful SIGTERM), so wait one stale window
// and only give up if that heartbeat is still advancing.
const existing = store.readHeartbeat();
if (existing && Date.now() - existing.beatAt < WORKER_HEARTBEAT_STALE_MS) {
  log('worker_waiting_for_previous_instance', { pid: existing.pid });
  await new Promise((resolve) => setTimeout(resolve, WORKER_HEARTBEAT_STALE_MS + 500));
  const latest = store.readHeartbeat();
  if (latest && latest.beatAt !== existing.beatAt && Date.now() - latest.beatAt < WORKER_HEARTBEAT_STALE_MS) {
    log('worker_already_running', { pid: latest.pid, lastBeatMsAgo: Date.now() - latest.beatAt });
    process.exit(1);
  }
}
store.beat({ instanceId, pid: process.pid, startedAt });
const recovered = store.recoverInterrupted();
store.completeFinishedBatches();

async function transfer(chainType: ChainType, asset: StablecoinAsset, secret: string, vaultAddress: string, amount: bigint): Promise<TransferResult> {
  if (chainType === 'zigchain') {
    return sendZigStablecoin({ secret, rpcUrl: chain.zigRpcUrl, gasDenom: chain.zigGasDenom, vaultAddress, asset, amount, ibc: chain.ibc });
  }
  return sendEvmStablecoin({ secret, chainType, rpcUrls: chainType === 'bnb' ? chain.bscRpcUrls : chain.ethRpcUrls, vaultAddress, asset, amount });
}

async function runAutomation(automation: ClaimedAutomation): Promise<void> {
  const asset = findStablecoin(automation.chainType, automation.assetSymbol);
  if (!automation.secretCiphertext || !asset) {
    // Stopped between listing and claiming, or an unsupported asset slipped in.
    store.finishAutomationCycle(automation.id, { ok: false, error: asset ? 'No stored wallet key. Start the automation again.' : `${automation.assetSymbol} is not supported on ${automation.chainType}.` });
    return;
  }

  let secret = '';
  let amount = 0n;
  let runId: string | null = null;
  try {
    amount = randomAmount(parseTokenAmount(automation.minAmount, asset.decimals), parseTokenAmount(automation.maxAmount, asset.decimals));
    runId = store.startRun({
      automationId: automation.id, batchId: null, batchRow: null, vaultKey: automation.vaultKey, chainType: automation.chainType,
      vaultAddress: automation.vaultAddress, senderAddress: automation.senderAddress, assetSymbol: asset.symbol,
      amountBaseUnits: amount.toString(), startedAt: Date.now(),
    });
    secret = decryptSecret(automation.secretCiphertext, encryptionKey);
    const result = await transfer(automation.chainType, asset, secret, automation.vaultAddress, amount);
    store.finishRun(runId, { status: 'success', method: result.method, txHash: result.hash });
    store.finishAutomationCycle(automation.id, { ok: true });
    log('automation_run_succeeded', { automationId: automation.id, vault: automation.vaultName, amount: amount.toString(), txHash: result.hash, method: result.method });
  } catch (error) {
    const message = describeExecutionError(error, asset.symbol, secret);
    const txHash = (error as { txHash?: string }).txHash ?? null;
    if (runId) store.finishRun(runId, { status: 'failed', error: message, txHash });
    store.finishAutomationCycle(automation.id, { ok: false, error: message });
    log('automation_run_failed_paused', { automationId: automation.id, vault: automation.vaultName, error: message });
  }
}

async function runBatchRow({ batch, row }: ClaimedBatchRow): Promise<void> {
  const asset = findStablecoin(batch.chainType, batch.assetSymbol);
  let secret = '';
  let runId: string | null = null;
  try {
    if (!asset) throw new Error(`${batch.assetSymbol} is not supported on ${batch.chainType}.`);
    if (!row.secretCiphertext) throw new Error('No stored wallet key for this row.');
    const amount = parseTokenAmount(row.amount, asset.decimals);
    runId = store.startRun({
      automationId: null, batchId: batch.id, batchRow: row.rowIndex, vaultKey: batch.vaultKey, chainType: batch.chainType,
      vaultAddress: batch.vaultAddress, senderAddress: row.senderAddress, assetSymbol: asset.symbol,
      amountBaseUnits: amount.toString(), startedAt: Date.now(),
    });
    secret = decryptSecret(row.secretCiphertext, encryptionKey);
    const result = await transfer(batch.chainType, asset, secret, batch.vaultAddress, amount);
    store.finishRun(runId, { status: 'success', method: result.method, txHash: result.hash });
    store.finishBatchRow(batch.id, row.rowIndex, { status: 'success', txHash: result.hash });
    log('batch_row_succeeded', { batchId: batch.id, row: row.rowIndex, txHash: result.hash, method: result.method });
  } catch (error) {
    // A failed row does not stop the batch, matching the console's behaviour.
    const message = describeExecutionError(error, batch.assetSymbol, secret);
    const txHash = (error as { txHash?: string }).txHash ?? null;
    if (runId) store.finishRun(runId, { status: 'failed', error: message, txHash });
    store.finishBatchRow(batch.id, row.rowIndex, { status: 'failed', error: message, txHash });
    log('batch_row_failed', { batchId: batch.id, row: row.rowIndex, error: message });
  }
}

// One send at a time per sending wallet per chain, so concurrent jobs from the
// same wallet cannot race for the same nonce / account sequence.
const busyWallets = new Set<string>();
const inFlight = new Set<Promise<void>>();
let stopping = false;
let timer: NodeJS.Timeout | null = null;

function track(walletKey: string, work: Promise<void>) {
  busyWallets.add(walletKey);
  const tracked = work
    .catch((error: unknown) => log('worker_job_crashed', { error: (error as Error).message }))
    .finally(() => {
      busyWallets.delete(walletKey);
      inFlight.delete(tracked);
    });
  inFlight.add(tracked);
}

function tick() {
  try {
    const now = Date.now();
    store.beat({ instanceId, pid: process.pid, startedAt }, now);
    if (stopping) return;

    for (const due of store.listDueAutomations(now, 50)) {
      if (inFlight.size >= MAX_CONCURRENCY) break;
      const walletKey = `${due.chainType}:${due.senderAddress.toLowerCase()}`;
      if (busyWallets.has(walletKey)) continue;
      const claimed = store.claimAutomation(due.id, now, LEASE_MS);
      if (claimed) track(walletKey, runAutomation(claimed));
    }

    store.completeFinishedBatches(now);
    for (const due of store.listDueBatchRows(now, 50)) {
      if (inFlight.size >= MAX_CONCURRENCY) break;
      const walletKey = `${due.chainType}:${due.senderAddress.toLowerCase()}`;
      if (busyWallets.has(walletKey)) continue;
      const claimed = store.claimBatchRow(due.batchId, due.rowIndex, now, LEASE_MS);
      if (claimed) track(walletKey, runBatchRow(claimed));
    }
  } catch (error) {
    log('worker_tick_failed', { error: (error as Error).message });
  } finally {
    if (!stopping) timer = setTimeout(tick, TICK_MS);
  }
}

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  if (timer) clearTimeout(timer);
  log('worker_stopping', { signal, inFlight: inFlight.size });
  // Let sends already broadcasting finish and record their result.
  await Promise.allSettled([...inFlight]);
  store.clearHeartbeat(instanceId);
  store.close();
  log('worker_stopped');
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

log('worker_ready', {
  instanceId, pid: process.pid, tickMs: TICK_MS, maxConcurrency: MAX_CONCURRENCY, recovered,
  ethRpcEndpoints: chain.ethRpcUrls.length, bscRpcEndpoints: chain.bscRpcUrls.length, zigRpcConfigured: Boolean(chain.zigRpcUrl),
});
tick();
