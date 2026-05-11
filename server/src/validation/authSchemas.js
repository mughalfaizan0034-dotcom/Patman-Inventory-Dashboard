import { z } from 'zod';

export const loginBodySchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
});

export const refreshBodySchema = z.object({
  refresh_token: z.string().min(1),
});
