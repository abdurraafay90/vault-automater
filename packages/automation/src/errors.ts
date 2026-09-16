import { ethers } from 'ethers';

export type TransferMethod = 'transfer' | 'deposit' | 'transfer-fallback' | 'bank-send' | 'ibc-transfer';

export type TransferResult = { hash: string; method: TransferMethod };

/** A failure whose message is already safe and readable for operators. */
export class ExecutionError extends Error {
  constructor(message: string, readonly txHash?: string) {
    super(message);
    this.name = 'ExecutionError';
  }
}

/**
 * Operator-facing description of a failed send. Never echoes the secret: the
 * caller passes it so any accidental occurrence is redacted.
 */
export function describeExecutionError(error: unknown, symbol: string, secret?: string): string {
  const message = (() => {
    if (error instanceof ExecutionError) return error.message;
    if (ethers.isError(error, 'NETWORK_ERROR') && error.message.startsWith('All RPC endpoints failed')) {
      return 'Network connection error: every configured RPC endpoint failed.';
    }
    if (ethers.isError(error, 'INSUFFICIENT_FUNDS')) {
      return 'Insufficient funds for gas: the sending wallet cannot pay the network fee.';
    }
    if (ethers.isError(error, 'NONCE_EXPIRED') || ethers.isError(error, 'REPLACEMENT_UNDERPRICED')) {
      return 'Transaction sequence error: another transaction from this wallet is still pending. Resume once it confirms.';
    }
    if (ethers.isError(error, 'CALL_EXCEPTION')) {
      return error.reason
        ? `Transaction reverted by the contract: ${error.reason}.`
        : `Transaction reverted by the contract with no reason given. Check the vault accepts deposits, the ${symbol} allowance and balance.`;
    }
    const raw = error instanceof Error ? ((error as { shortMessage?: string }).shortMessage ?? error.message) : String(error);
    if (/account .* does not exist on chain/i.test(raw)) {
      return 'The sending ZIGChain account does not exist on-chain yet. Fund it with ZIG for gas first.';
    }
    if (/insufficient fees|insufficient funds/i.test(raw)) {
      return `Insufficient funds: the sending wallet cannot cover the ${symbol} amount plus network fees.`;
    }
    return raw.replace(/\{[\s\S]*\}/g, '').trim().slice(0, 300) || 'Transfer failed.';
  })();
  return secret && secret.length >= 8 ? message.split(secret).join('[redacted]') : message;
}
