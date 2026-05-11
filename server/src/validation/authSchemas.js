import { z } from 'zod';

export const loginBodySchema = z.object({
  organization: z.string().min(1).max(64),
  username:     z.string().min(1).max(32),
  password:     z.string().min(1),
});

export const refreshBodySchema = z.object({
  refresh_token: z.string().min(1),
});
