import { EVM_CHAIN_IDS, SequentialRpcProvider, type EvmChainType } from '@vaultflow/automation';
import { ethers } from 'ethers';
import type { FastifyBaseLogger } from 'fastify';

const VAULT_STATS_ABI = [
  'function vaultStats() view returns (tuple(uint256 totalShares, uint256 activeAUM, uint256 pendingLiabilities, uint256 vaultBalance, uint256 pricePerShare, uint256 pendingCount, bool isPaused, address fundsManager, address asset) stats)',
];
const ERC20_METADATA_ABI = ['function decimals() view returns (uint8)', 'function symbol() view returns (string)'];

export type VaultStatsTarget = {
  vaultKey: string;
  vaultName: string;
  chainType: EvmChainType;
  contract: string;
};

export type VaultStatsEntry = {
  vaultKey: string;
  vaultName: string;
  chainType: EvmChainType;
  contract: string;
  /** activeAUM + pendingLiabilities, in the asset's base units. */
  tvlBaseUnits: string | null;
  assetAddress: string | null;
  assetSymbol: string | null;
  assetDecimals: number | null;
  activeAUM: string | null;
  pendingLiabilities: string | null;
  totalShares: string | null;
  pricePerShare: string | null;
  pendingCount: string | null;
  isPaused: boolean | null;
  fundsManager: string | null;
  /** Time of the last successful read; values are kept if a later read fails. */
  updatedAt: number | null;
  lastAttemptAt: number | null;
  error: string | null;
};

/**
 * Reads vaultStats() for configured vault contracts on a fixed schedule and
 * keeps the latest values in memory. TVL is activeAUM + pendingLiabilities.
 */
export class VaultStatsService {
  readonly #targets: VaultStatsTarget[];
  readonly #rpcUrls: Record<EvmChainType, readonly string[]>;
  readonly #refreshMs: number;
  readonly #log: FastifyBaseLogger;
  readonly #entries = new Map<string, VaultStatsEntry>();
  readonly #assetMetadata = new Map<string, { decimals: number; symbol: string }>();
  #timer: NodeJS.Timeout | null = null;
  #refreshing: Promise<void> | null = null;

  constructor(options: { targets: VaultStatsTarget[]; rpcUrls: Record<EvmChainType, readonly string[]>; refreshMinutes: number; log: FastifyBaseLogger }) {
    this.#targets = options.targets;
    this.#rpcUrls = options.rpcUrls;
    this.#refreshMs = options.refreshMinutes * 60_000;
    this.#log = options.log;
    for (const target of this.#targets) {
      this.#entries.set(target.vaultKey, {
        ...target, tvlBaseUnits: null, assetAddress: null, assetSymbol: null, assetDecimals: null, activeAUM: null,
        pendingLiabilities: null, totalShares: null, pricePerShare: null, pendingCount: null, isPaused: null,
        fundsManager: null, updatedAt: null, lastAttemptAt: null, error: null,
      });
    }
  }

  get refreshMinutes() {
    return this.#refreshMs / 60_000;
  }

  start(): void {
    if (this.#targets.length === 0) return;
    void this.refresh();
    this.#timer = setInterval(() => void this.refresh(), this.#refreshMs);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  list(): VaultStatsEntry[] {
    return [...this.#entries.values()];
  }

  refresh(): Promise<void> {
    // Never overlap refreshes if RPCs are slow.
    this.#refreshing ??= Promise.all(this.#targets.map((target) => this.#refreshOne(target)))
      .then(() => undefined)
      .finally(() => { this.#refreshing = null; });
    return this.#refreshing;
  }

  async #refreshOne(target: VaultStatsTarget): Promise<void> {
    const entry = this.#entries.get(target.vaultKey)!;
    entry.lastAttemptAt = Date.now();
    const provider = new SequentialRpcProvider(this.#rpcUrls[target.chainType], EVM_CHAIN_IDS[target.chainType]);
    try {
      const vault = new ethers.Contract(target.contract, VAULT_STATS_ABI, provider);
      const stats = await vault.getFunction('vaultStats').staticCall() as {
        totalShares: bigint; activeAUM: bigint; pendingLiabilities: bigint; pricePerShare: bigint;
        pendingCount: bigint; isPaused: boolean; fundsManager: string; asset: string;
      };
      const asset = ethers.getAddress(stats.asset);
      const metadataKey = `${target.chainType}:${asset}`;
      let metadata = this.#assetMetadata.get(metadataKey);
      if (!metadata) {
        const token = new ethers.Contract(asset, ERC20_METADATA_ABI, provider);
        const [decimals, symbol] = await Promise.all([
          token.getFunction('decimals').staticCall() as Promise<bigint>,
          (token.getFunction('symbol').staticCall() as Promise<string>).catch(() => 'TOKEN'),
        ]);
        metadata = { decimals: Number(decimals), symbol: String(symbol) };
        this.#assetMetadata.set(metadataKey, metadata);
      }
      Object.assign(entry, {
        tvlBaseUnits: (stats.activeAUM + stats.pendingLiabilities).toString(),
        assetAddress: asset,
        assetSymbol: metadata.symbol,
        assetDecimals: metadata.decimals,
        activeAUM: stats.activeAUM.toString(),
        pendingLiabilities: stats.pendingLiabilities.toString(),
        totalShares: stats.totalShares.toString(),
        pricePerShare: stats.pricePerShare.toString(),
        pendingCount: stats.pendingCount.toString(),
        isPaused: stats.isPaused,
        fundsManager: ethers.getAddress(stats.fundsManager),
        updatedAt: Date.now(),
        error: null,
      });
    } catch (error) {
      const message = error instanceof Error ? ((error as { shortMessage?: string }).shortMessage ?? error.message) : String(error);
      entry.error = `vaultStats() read failed: ${message.slice(0, 200)}`;
      this.#log.warn({ event: 'vault_stats_refresh_failed', vault: target.vaultName, chain: target.chainType, contract: target.contract }, entry.error);
    } finally {
      provider.destroy();
    }
  }
}
