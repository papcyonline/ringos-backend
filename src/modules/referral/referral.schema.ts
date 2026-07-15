import { z } from 'zod';

export const redeemReferralSchema = z.object({
  code: z.string().trim().min(3).max(16),
});
