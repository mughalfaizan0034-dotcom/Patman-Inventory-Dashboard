import { randomUUID } from 'crypto';
import { env } from '../config/env.js';

export function createTokenFactory(fastify) {
  return {
    // Access token is always scoped to a specific membership.
    signAccessToken(membership) {
      return fastify.jwt.sign(
        {
          user_id:         membership.user_id,
          organization_id: membership.organization_id,
          membership_id:   membership.membership_id,
          username:        membership.username,
          display_name:    membership.display_name,
          role:            membership.role,
          type:            'access',
        },
        { expiresIn: env.JWT_ACCESS_EXPIRES }
      );
    },

    // Refresh token carries only user identity, no org context.
    signRefreshToken(userId) {
      return fastify.jwt.sign(
        { user_id: userId, type: 'refresh', jti: randomUUID() },
        { expiresIn: env.JWT_REFRESH_EXPIRES }
      );
    },

    // Short-lived token issued after password check when user has multiple orgs.
    // Only grants access to /auth/select-org.
    signPendingToken(user) {
      return fastify.jwt.sign(
        {
          user_id:      user.user_id,
          username:     user.username,
          display_name: user.display_name,
          type:         'pending',
        },
        { expiresIn: '5m' }
      );
    },
  };
}
