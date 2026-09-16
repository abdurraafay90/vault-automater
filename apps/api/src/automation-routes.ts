import {
  AutomationStore,
  WORKER_HEARTBEAT_STALE_MS,
  deriveSenderAddress,
  encryptSecret,
  findStablecoin,
  isValidVaultAddress,
  parseEncryptionKey,
  parseTokenAmount,
  type ChainType,
  type CreateBatchInput,
} from '@vaultflow/automation';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

type CurrentUser = (request: FastifyRequest) => { id: string } | undefined;

const MAX_INTERVAL_SECONDS = 7 * 24 * 60 * 60;
const MAX_BATCH_ROWS = 1000;

const targetShape = {
  vaultKey: z.string().trim().min(1).max(200),
  vaultName: z.string().trim().min(1).max(100),
  chainType: z.enum(['zigchain', 'erc', 'bnb']),
  vaultAddress: z.string().trim().min(1).max(128),
  assetSymbol: z.enum(['USDT', 'USDC']),
  // What the console believes the asset is. The server always sends its own
  // preset contract/denom, so a mismatch (e.g. a custom token that is merely
  // named "USDT") is rejected instead of silently sending the real USDT.
  assetAddress: z.string().trim().max(128).optional(),
  assetDenom: z.string().trim().max(128).optional(),
};

type Target = { chainType: ChainType; vaultAddress: string; assetSymbol: string; assetAddress?: string | undefined; assetDenom?: string | undefined };

function checkTarget(target: Target, context: z.RefinementCtx) {
  if (!isValidVaultAddress(target.chainType, target.vaultAddress)) {
    context.addIssue({ code: 'custom', path: ['vaultAddress'], message: `Invalid ${target.chainType} vault address.` });
  }
  const asset = findStablecoin(target.chainType, target.assetSymbol);
  if (!asset) {
    context.addIssue({ code: 'custom', path: ['assetSymbol'], message: `${target.assetSymbol} is not available on ${target.chainType}.` });
    return;
  }
  if (target.assetAddress && target.assetAddress.toLowerCase() !== asset.address?.toLowerCase()) {
    context.addIssue({ code: 'custom', path: ['assetAddress'], message: `Automation only sends the standard ${asset.symbol} contract (${asset.address ?? 'none on this chain'}).` });
  }
  if (target.assetDenom && target.assetDenom !== asset.denom) {
    context.addIssue({ code: 'custom', path: ['assetDenom'], message: `Automation only sends the standard ${asset.symbol} denom on ZIGChain.` });
  }
}

const automationBody = z.object({
  ...targetShape,
  minAmount: z.string().trim().min(1).max(64),
  maxAmount: z.string().trim().min(1).max(64),
  intervalSeconds: z.number().int().min(1).max(MAX_INTERVAL_SECONDS),
  secret: z.string().min(1).max(512),
}).superRefine(checkTarget);

const batchBody = z.object({
  ...targetShape,
  delaySeconds: z.number().int().min(1).max(3600),
  // Row fields are deliberately permissive here: an empty or malformed field
  // must fail only that row (checked below), never the whole batch.
  rows: z.array(z.object({
    walletAddress: z.string().max(4096).default(''),
    secret: z.string().max(4096).default(''),
    amount: z.string().max(4096).default(''),
  })).min(1).max(MAX_BATCH_ROWS),
}).superRefine(checkTarget);

const idParams = z.object({ id: z.string().min(1).max(64) });

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Invalid request.';
  // Never echo a submitted secret back.
  const path = issue.path.join('.');
  return path.endsWith('secret') ? 'A wallet key is required.' : `${path ? `${path}: ` : ''}${issue.message}`;
}

/**
 * Server-side automation. The worker process executes everything created here,
 * so schedules keep running with the console closed. Wallet keys are accepted
 * once, stored AES-256-GCM encrypted, and wiped when an automation is stopped
 * or a batch finishes. Every route requires a session.
 */
export function registerAutomationRoutes(app: FastifyInstance, currentUser: CurrentUser) {
  const store = AutomationStore.open();

  let encryptionKey: Buffer | null = null;
  let encryptionError: string | null = null;
  try {
    encryptionKey = parseEncryptionKey(process.env.AUTOMATION_ENCRYPTION_KEY);
  } catch (error) {
    encryptionError = (error as Error).message;
    app.log.warn({ event: 'automation_encryption_key_missing' }, encryptionError);
  }

  function workerStatus() {
    const heartbeat = store.readHeartbeat();
    return {
      workerOnline: Boolean(heartbeat && Date.now() - heartbeat.beatAt < WORKER_HEARTBEAT_STALE_MS),
      workerLastBeatAt: heartbeat?.beatAt ?? null,
    };
  }

  function requireKey(reply: FastifyReply): Buffer | null {
    if (encryptionKey) return encryptionKey;
    void reply.code(503).send({ code: 'AUTOMATION_KEY_NOT_CONFIGURED', message: encryptionError });
    return null;
  }

  // Polled every 2.5s by each open console, so it has its own, higher limit.
  app.get('/api/automation/state', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async () => ({
    ...workerStatus(),
    encryptionConfigured: Boolean(encryptionKey),
    automations: store.listAutomations(),
    batches: store.listBatches(5),
    runs: store.listRuns(150),
  }));

  app.post('/api/automations', async (request, reply) => {
    const key = requireKey(reply);
    if (!key) return;
    const parsed = automationBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_AUTOMATION', message: firstIssue(parsed.error) });
    const input = parsed.data;
    const asset = findStablecoin(input.chainType, input.assetSymbol)!;

    try {
      const min = parseTokenAmount(input.minAmount, asset.decimals);
      const max = parseTokenAmount(input.maxAmount, asset.decimals);
      if (max < min) return reply.code(400).send({ code: 'INVALID_AMOUNT', message: 'Maximum amount must be at least the minimum.' });
    } catch (error) {
      return reply.code(400).send({ code: 'INVALID_AMOUNT', message: (error as Error).message });
    }

    let senderAddress: string;
    try {
      senderAddress = await deriveSenderAddress(input.chainType, input.secret);
    } catch {
      return reply.code(400).send({ code: 'INVALID_WALLET_KEY', message: 'The wallet key is not a valid private key or mnemonic for this chain.' });
    }

    const automation = store.createAutomation({
      vaultKey: input.vaultKey,
      vaultName: input.vaultName,
      chainType: input.chainType,
      vaultAddress: input.vaultAddress,
      assetSymbol: asset.symbol,
      senderAddress,
      secretCiphertext: encryptSecret(input.secret.trim(), key),
      minAmount: input.minAmount,
      maxAmount: input.maxAmount,
      intervalSeconds: input.intervalSeconds,
      createdBy: currentUser(request)?.id ?? null,
    });
    return reply.code(201).send({ automation, ...workerStatus() });
  });

  const transitions = {
    pause: (id: string) => store.pauseAutomation(id),
    resume: (id: string) => store.resumeAutomation(id),
    stop: (id: string) => store.stopAutomation(id),
  } as const;

  for (const [action, apply] of Object.entries(transitions)) {
    app.post(`/api/automations/:id/${action}`, async (request, reply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ code: 'INVALID_AUTOMATION_ID' });
      if (!store.getAutomation(params.data.id)) return reply.code(404).send({ code: 'AUTOMATION_NOT_FOUND' });
      const automation = apply(params.data.id);
      if (!automation) {
        const message = action === 'resume'
          ? 'Only a paused automation with a stored key can be resumed. Start it again instead.'
          : `Cannot ${action} this automation in its current state.`;
        return reply.code(409).send({ code: 'INVALID_AUTOMATION_STATE', message });
      }
      return { automation, ...workerStatus() };
    });
  }

  app.post('/api/automation-batches', async (request, reply) => {
    const key = requireKey(reply);
    if (!key) return;
    const parsed = batchBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_BATCH', message: firstIssue(parsed.error) });
    const input = parsed.data;
    const asset = findStablecoin(input.chainType, input.assetSymbol)!;

    // Each row is checked on its own. A bad row is recorded as failed with its
    // reason and skipped; every valid row still runs.
    const rows: CreateBatchInput['rows'] = [];
    for (const row of input.rows) {
      const walletAddress = row.walletAddress.trim().slice(0, 128);
      const amount = row.amount.trim().slice(0, 64);
      const secret = row.secret.trim();
      const fail = (error: string, senderAddress = '') => rows.push({ status: 'failed', walletAddress, senderAddress, amount, error });

      if (!secret) { fail('Missing private key.'); continue; }
      if (secret.length > 512) { fail('Private key or mnemonic is too long.'); continue; }
      if (!amount) { fail('Missing amount.'); continue; }
      try {
        parseTokenAmount(amount, asset.decimals);
      } catch (error) {
        fail(`Invalid amount '${amount}': ${(error as Error).message}`);
        continue;
      }
      let senderAddress: string;
      try {
        senderAddress = await deriveSenderAddress(input.chainType, secret);
      } catch {
        fail('Invalid private key or mnemonic for this chain.');
        continue;
      }
      // A key for a different wallet than the row names is skipped, not sent:
      // the operator expected funds to leave the named wallet.
      const same = input.chainType === 'zigchain'
        ? walletAddress === senderAddress
        : walletAddress.toLowerCase() === senderAddress.toLowerCase();
      if (walletAddress && !same) {
        fail(`The key controls ${senderAddress}, not ${walletAddress}.`, senderAddress);
        continue;
      }
      rows.push({ status: 'pending', walletAddress: walletAddress || senderAddress, senderAddress, secretCiphertext: encryptSecret(secret, key), amount });
    }

    try {
      const batch = store.createBatch({
        vaultKey: input.vaultKey,
        vaultName: input.vaultName,
        chainType: input.chainType,
        vaultAddress: input.vaultAddress,
        assetSymbol: asset.symbol,
        delaySeconds: input.delaySeconds,
        createdBy: currentUser(request)?.id ?? null,
        rows,
      });
      // If no row was valid there is nothing to send: close it out now so it
      // does not hold the vault's one-running-batch slot until the worker runs.
      store.completeFinishedBatches();
      const queued = rows.filter((row) => row.status === 'pending').length;
      return reply.code(201).send({ batch: store.getBatch(batch.id), queued, skipped: rows.length - queued, ...workerStatus() });
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        return reply.code(409).send({ code: 'BATCH_ALREADY_RUNNING', message: 'A batch is already running for this vault. Cancel it first.' });
      }
      throw error;
    }
  });

  app.post('/api/automation-batches/:id/cancel', async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ code: 'INVALID_BATCH_ID' });
    const batch = store.cancelBatch(params.data.id);
    if (!batch) return reply.code(409).send({ code: 'INVALID_BATCH_STATE', message: 'Only a running batch can be cancelled.' });
    return { batch, ...workerStatus() };
  });
}
