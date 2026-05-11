import { z } from 'zod';

export const loginBodySchema = z.object({
  username: z.string().min(1).max(32),
  password: z.string().min(1),
});

export const refreshBodySchema = z.object({
  refresh_token: z.string().min(1),
  membership_id: z.string().uuid().optional(),
});
