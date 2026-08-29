import { randomBytes } from 'node:crypto';
import { z } from 'zod';

export const intervalSeconds = [30, 60, 300, 900, 1800, 3600] as const;
export const automationStatus = z.enum(['STOPPED','STARTING','RUNNING','PAUSED','WAITING','SUBMITTING','WAITING_FOR_CONFIRMATION','SUCCESS','INSUFFICIENT_BALANCE','INSUFFICIENT_GAS','ERROR']);
export const automationSettings = z.object({ minAmountBaseUnits: z.string().regex(/^\d+$/), maxAmountBaseUnits: z.string().regex(/^\d+$/), intervalSeconds: z.number().int().positive() }).superRefine((value, context) => {
  if (BigInt(value.maxAmountBaseUnits) < BigInt(value.minAmountBaseUnits)) context.addIssue({ code: 'custom', message: 'Maximum amount must be at least the minimum.' });
});

export function secureRandomBigInt(minimum: bigint, maximum: bigint): bigint {
  if (minimum < 0n || maximum < minimum) throw new RangeError('Invalid bigint range');
  const range = maximum - minimum + 1n;
  const byteLength = Math.max(1, Math.ceil(range.toString(2).length / 8));
  const ceiling = 1n << BigInt(byteLength * 8);
  const limit = ceiling - (ceiling % range);
  for (;;) {
    const candidate = BigInt(`0x${randomBytes(byteLength).toString('hex')}`);
    if (candidate < limit) return minimum + (candidate % range);
  }
}
