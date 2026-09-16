import { ethers } from 'ethers';
import { formatBaseUnits } from './amounts.js';
import { EVM_CHAIN_IDS, EVM_GAS_SYMBOLS, type EvmChainType, type StablecoinAsset } from './chains.js';
import { ExecutionError, type TransferResult } from './errors.js';

const RPC_TIMEOUT_MS = 10_000;
const CONFIRMATION_TIMEOUT_MS = 10 * 60_000;

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

const VAULT_DEPOSIT_ABI = ['function deposit(uint256 amount) returns (uint256)'];

// Node-side problems another endpoint may not have.
const ENDPOINT_FAULT_PATTERN = /header not found|missing trie node|rate.?limit|too many requests|not whitelisted|not supported|method not found|unauthori[sz]ed|forbidden|capacity|timeout|timed out|unavailable|internal error/i;

// The EVM itself failed. Includes `assert`-style failures: mainnet USDT's
// SafeMath uses assert, so an insufficient-balance transfer surfaces as
// "invalid opcode: INVALID" / "EVM error: InvalidFEOpcode", never as "revert".
const EVM_EXECUTION_FAILURE_PATTERN = /revert|invalid opcode|InvalidFEOpcode|EVM error|out of gas|gas required exceeds|stack (?:underflow|overflow)|invalid jump|bad jump destination/i;

/**
 * True when the error describes the request itself, so every other endpoint
 * would answer the same way. Everything else is an endpoint fault and retried.
 */
export function isRequestError(error: unknown): boolean {
  if (
    ethers.isError(error, 'INSUFFICIENT_FUNDS')
    || ethers.isError(error, 'NONCE_EXPIRED')
    || ethers.isError(error, 'REPLACEMENT_UNDERPRICED')
    || ethers.isError(error, 'TRANSACTION_REPLACED')
    || ethers.isError(error, 'ACTION_REJECTED')
    || ethers.isError(error, 'INVALID_ARGUMENT')
  ) return true;
  if (ethers.isError(error, 'CALL_EXCEPTION')) {
    // ethers reports ANY JSON-RPC error on eth_call/estimateGas as
    // CALL_EXCEPTION, including an endpoint refusing the method or lacking
    // state. Only an actual EVM execution failure is final.
    const rpcError = (error.info as { error?: { message?: unknown } } | undefined)?.error;
    const message = String(rpcError?.message ?? '');
    if (typeof error.data === 'string' && error.data !== '0x') return true;
    if (ENDPOINT_FAULT_PATTERN.test(message)) return false;
    return EVM_EXECUTION_FAILURE_PATTERN.test(message);
  }
  return false;
}

function isAlreadyBroadcast(error: unknown): boolean {
  const rpcMessage = String(((error as { info?: { error?: { message?: unknown } } })?.info?.error?.message) ?? '');
  return ethers.isError(error, 'NONCE_EXPIRED')
    || /already known|known transaction|already imported/i.test(`${(error as Error)?.message ?? ''} ${rpcMessage}`);
}

type RpcEndpoint = {
  url: string;
  provider: ethers.JsonRpcProvider;
  chainCheck: Promise<void> | null;
  wrongChain: boolean;
};

/**
 * Tries endpoints strictly in listed order, verifying each endpoint's chain ID
 * once and skipping wrong-chain endpoints for good. Endpoint faults fall
 * through to the next endpoint; request errors (reverts, insufficient funds,
 * nonce) are thrown immediately. Children use staticNetwork so a dead host
 * fails fast instead of looping on network detection.
 */
export class SequentialRpcProvider extends ethers.AbstractProvider {
  readonly #network: ethers.Network;
  readonly #endpoints: RpcEndpoint[];

  constructor(urls: readonly string[], chainId: number) {
    const network = ethers.Network.from(chainId);
    super(network);
    this.#network = network;
    this.#endpoints = urls.map((url) => {
      const request = new ethers.FetchRequest(url);
      request.timeout = RPC_TIMEOUT_MS;
      return {
        url,
        provider: new ethers.JsonRpcProvider(request, network, { staticNetwork: network, batchMaxCount: 1 }),
        chainCheck: null,
        wrongChain: false,
      };
    });
  }

  override async _detectNetwork(): Promise<ethers.Network> {
    return this.#network;
  }

  #verifyChain(endpoint: RpcEndpoint): Promise<void> {
    endpoint.chainCheck ??= (async () => {
      const actual = BigInt(await endpoint.provider.send('eth_chainId', []));
      if (actual !== this.#network.chainId) {
        endpoint.wrongChain = true;
        throw new Error(`${endpoint.url} serves chain ${actual}, expected ${this.#network.chainId}.`);
      }
    })().catch((error: unknown) => {
      if (!endpoint.wrongChain) endpoint.chainCheck = null;
      throw error;
    });
    return endpoint.chainCheck;
  }

  override async _perform<T = unknown>(req: ethers.PerformActionRequest): Promise<T> {
    let lastError: unknown = null;
    let broadcastReachedNode = false;
    for (const endpoint of this.#endpoints) {
      if (endpoint.wrongChain) continue;
      let verified = false;
      try {
        await this.#verifyChain(endpoint);
        verified = true;
        return await endpoint.provider._perform(req) as T;
      } catch (error) {
        if (req.method === 'broadcastTransaction' && broadcastReachedNode && isAlreadyBroadcast(error)) {
          return ethers.Transaction.from(req.signedTransaction).hash as T;
        }
        if (verified && isRequestError(error)) throw error;
        if (verified && req.method === 'broadcastTransaction') broadcastReachedNode = true;
        lastError = error;
      }
    }
    throw ethers.makeError(`All RPC endpoints failed for ${req.method}.`, 'NETWORK_ERROR', {
      event: 'rpcFallbackExhausted',
      info: { lastError },
    });
  }

  override destroy(): void {
    for (const endpoint of this.#endpoints) endpoint.provider.destroy();
    super.destroy();
  }
}

export function evmWalletFromSecret(secret: string, provider?: ethers.Provider): ethers.Wallet {
  const trimmed = secret.trim();
  if (/\s/.test(trimmed)) return new ethers.Wallet(ethers.HDNodeWallet.fromPhrase(trimmed).privateKey, provider);
  const hex = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new ExecutionError('Use a 32-byte (64 hex characters) private key or a 12/24-word mnemonic.');
  return new ethers.Wallet(hex, provider);
}

async function confirm(tx: ethers.TransactionResponse, what: string): Promise<void> {
  let receipt: ethers.TransactionReceipt | null;
  try {
    receipt = await tx.wait(1, CONFIRMATION_TIMEOUT_MS);
  } catch (error) {
    if (ethers.isError(error, 'TIMEOUT')) {
      throw new ExecutionError(`${what} ${tx.hash} was broadcast but not confirmed within 10 minutes. Check the explorer before retrying.`, tx.hash);
    }
    throw error;
  }
  if (!receipt || receipt.status === 0) throw new ExecutionError(`${what} ${tx.hash} was reverted on-chain.`, tx.hash);
}

export type EvmTransferInput = {
  secret: string;
  chainType: EvmChainType;
  rpcUrls: readonly string[];
  vaultAddress: string;
  asset: StablecoinAsset;
  amount: bigint;
};

/**
 * Same behaviour as the console's browser send path: a plain token transfer to
 * an EOA; for a contract, approve (if needed) then deposit(uint256), falling
 * back to a plain transfer if deposit fails. The method used is returned so a
 * fallback is visible in run history.
 */
export async function sendEvmStablecoin(input: EvmTransferInput): Promise<TransferResult> {
  const { asset, amount, vaultAddress, chainType } = input;
  if (!asset.address) throw new ExecutionError(`${asset.symbol} has no token contract on ${chainType}.`);
  const provider = new SequentialRpcProvider(input.rpcUrls, EVM_CHAIN_IDS[chainType]);
  try {
    const wallet = evmWalletFromSecret(input.secret, provider);
    const who = `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`;
    const gasSymbol = EVM_GAS_SYMBOLS[chainType];

    const gasBalance = await provider.getBalance(wallet.address);
    if (gasBalance === 0n) throw new ExecutionError(`Insufficient funds for gas: ${who} holds 0 ${gasSymbol}.`);

    const token = new ethers.Contract(asset.address, ERC20_ABI, wallet);
    const balance = await token.getFunction('balanceOf').staticCall(wallet.address) as bigint;
    if (balance < amount) {
      throw new ExecutionError(`Insufficient balance: ${who} holds ${formatBaseUnits(balance, asset.decimals)} ${asset.symbol}, needs ${formatBaseUnits(amount, asset.decimals)} ${asset.symbol}.`);
    }

    const code = await provider.getCode(vaultAddress);
    const isContract = code !== '0x' && code !== '0x0';

    if (!isContract) {
      const tx = await token.getFunction('transfer').send(vaultAddress, amount) as ethers.TransactionResponse;
      await confirm(tx, `${asset.symbol} transfer`);
      return { hash: tx.hash, method: 'transfer' };
    }

    const allowance = await token.getFunction('allowance').staticCall(wallet.address, vaultAddress) as bigint;
    if (allowance < amount) {
      const approveTx = await token.getFunction('approve').send(vaultAddress, ethers.MaxUint256) as ethers.TransactionResponse;
      await confirm(approveTx, `${asset.symbol} approval`);
    }

    const vault = new ethers.Contract(vaultAddress, VAULT_DEPOSIT_ABI, wallet);
    try {
      const tx = await vault.getFunction('deposit').send(amount) as ethers.TransactionResponse;
      await confirm(tx, 'Vault deposit');
      return { hash: tx.hash, method: 'deposit' };
    } catch {
      const tx = await token.getFunction('transfer').send(vaultAddress, amount) as ethers.TransactionResponse;
      await confirm(tx, `${asset.symbol} transfer`);
      return { hash: tx.hash, method: 'transfer-fallback' };
    }
  } finally {
    provider.destroy();
  }
}
