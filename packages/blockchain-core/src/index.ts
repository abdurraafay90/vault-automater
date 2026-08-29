export type SimulationResult = { ok: true; estimatedFeeBaseUnits?: bigint } | { ok: false; code: string; message: string };
export type TransactionResult = { hash: string; nonceOrSequence?: string };

export interface SignerProvider {
  readonly mode: 'browser-wallet' | 'manual-interactive' | 'backend-managed';
  getPublicAddress(): Promise<string>;
  destroy(): Promise<void>;
}

export interface VaultAdapter {
  readonly vaultId: string;
  readonly vaultAddress: string;
  getBalance(walletAddress: string): Promise<bigint>;
  simulateDeposit(walletAddress: string, amountBaseUnits: bigint): Promise<SimulationResult>;
  executeDeposit(signer: SignerProvider, amountBaseUnits: bigint): Promise<TransactionResult>;
}

export interface TransactionCoordinator {
  execute<T>(chainKey: string, walletAddress: string, operation: () => Promise<T>): Promise<T>;
}

export class UnconfiguredVaultAdapter implements VaultAdapter {
  constructor(public readonly vaultId: string, public readonly vaultAddress: string) {}
  async getBalance(): Promise<bigint> { throw new Error('VAULT_INTERFACE_NOT_CONFIGURED'); }
  async simulateDeposit(): Promise<SimulationResult> { return { ok: false, code: 'VAULT_INTERFACE_NOT_CONFIGURED', message: 'A verified vault interface is required.' }; }
  async executeDeposit(): Promise<TransactionResult> { throw new Error('VAULT_INTERFACE_NOT_CONFIGURED'); }
}
