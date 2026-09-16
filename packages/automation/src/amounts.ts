const ZERO = 0n;
const ONE = 1n;
const TEN = 10n;

/**
 * Parse a decimal token amount into base units with exact bigint math.
 * Rejects exponents, hex, garbage suffixes and excess decimals rather than
 * approximating. Commas are accepted only as well-formed thousands separators,
 * so a decimal comma ("1,5") is rejected instead of being read as 15.
 */
export function parseTokenAmount(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  if (trimmed.includes(',') && !/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(trimmed)) {
    throw new Error('Use "." for decimals; commas are only allowed as thousands separators (e.g. 1,000.5).');
  }
  const normalized = trimmed.replaceAll(',', '');
  const pattern = decimals === 0 ? /^\d+$/ : new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`);
  if (!pattern.test(normalized)) throw new Error(`Enter a valid amount with no more than ${decimals} decimals.`);
  const [whole = '0', fraction = ''] = normalized.split('.');
  const amount = BigInt(whole) * TEN ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (amount <= ZERO) throw new Error('Transfer amount must be greater than zero.');
  return amount;
}

export function formatBaseUnits(value: bigint | string, decimals: number): string {
  const padded = value.toString().padStart(decimals + 1, '0');
  const whole = decimals === 0 ? padded : padded.slice(0, -decimals);
  const fraction = decimals === 0 ? '' : padded.slice(-decimals).replace(/0+$/, '');
  return `${BigInt(whole).toLocaleString('en-US')}${fraction ? `.${fraction}` : ''}`;
}

/**
 * Uniform random bigint in [minimum, maximum], by rejection sampling over as
 * many random bytes as the range needs — no modulo bias and no ceiling.
 */
export function randomAmount(minimum: bigint, maximum: bigint): bigint {
  if (maximum < minimum) throw new RangeError('Maximum amount must be at least the minimum.');
  if (minimum === maximum) return minimum;
  const range = maximum - minimum + ONE;
  const byteLength = Math.ceil(range.toString(2).length / 8);
  const ceiling = ONE << BigInt(byteLength * 8);
  const limit = ceiling - (ceiling % range);
  const bytes = new Uint8Array(byteLength);
  for (;;) {
    globalThis.crypto.getRandomValues(bytes);
    let value = ZERO;
    for (const byte of bytes) value = (value << 8n) | BigInt(byte);
    if (value < limit) return minimum + (value % range);
  }
}

/** Strict 32-byte hex private key, with or without a 0x prefix. */
export function hexToBytes(value: string): Uint8Array {
  const normalized = value.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) throw new Error('Use a 32-byte hex private key or a 12/24-word mnemonic.');
  return Uint8Array.from(normalized.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)));
}
