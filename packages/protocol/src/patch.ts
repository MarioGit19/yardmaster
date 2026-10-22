import { z } from 'zod';

/** Path of keys into `BoardState`, e.g. `['sessions', '<id>', 'status']`. */
export const PatchPath = z.array(z.string().min(1).max(256)).min(1).max(16);
export type PatchPath = z.infer<typeof PatchPath>;

export const PatchOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), path: PatchPath, value: z.unknown() }),
  z.object({ op: z.literal('merge'), path: PatchPath, value: z.record(z.string(), z.unknown()) }),
  z.object({ op: z.literal('delete'), path: PatchPath }),
]);
export type PatchOp = z.infer<typeof PatchOp>;
