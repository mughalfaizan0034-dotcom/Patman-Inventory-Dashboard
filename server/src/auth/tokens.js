import { env } from '../config/env.js';

// Token factory — requires the fastify.jwt decoration (registered via @fastify/jwt).
// Called only from route layer; services remain framework-agnostic.
export function createTokenFactory(fastify) {
  return {
    signAccessToken(user) {
      return fastify.jwt.sign(
        {
          user_id: user.user_id,
          email:   user.email,
          role:    user.role,
          type:    'access',
        },
        { expiresIn: env.JWT_ACCESS_EXPIRES }
      );
    },

    signRefreshToken(user) {
      return fastify.jwt.sign(
        { user_id: user.user_id, type: 'refresh' },
        { expiresIn: env.JWT_REFRESH_EXPIRES }
      );
    },
  };
}
