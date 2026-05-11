import { loginBodySchema, refreshBodySchema } from '../validation/authSchemas.js';
import { AppError } from '../utils/errors.js';

export async function authRoutes(fastify, { authService, tokenFactory }) {
  fastify.post('/login', async (request, reply) => {
    const parsed = loginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: 'Invalid request body', details: parsed.error.flatten() });
    }

    const { email, password } = parsed.data;

    try {
      const user = await authService.login(email, password);
      const accessToken  = tokenFactory.signAccessToken(user);
      const refreshToken = tokenFactory.signRefreshToken(user);

      return reply.send({
        success: true,
        data: {
          access_token:  accessToken,
          refresh_token: refreshToken,
          user,
        },
      });
    } catch (err) {
      if (err instanceof AppError) {
        return reply.code(err.statusCode).send({ success: false, error: err.message });
      }
      request.log.error({ err }, 'Login error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });

  fastify.post('/refresh', async (request, reply) => {
    const parsed = refreshBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: 'Invalid request body' });
    }

    try {
      const payload = fastify.jwt.verify(parsed.data.refresh_token);
      if (payload.type !== 'refresh') {
        return reply.code(401).send({ success: false, error: 'Invalid token type' });
      }

      // Re-fetch user to get current role and active status would require usersRepo here.
      // For now, sign a new access token from the refresh payload — role is preserved.
      const accessToken = tokenFactory.signAccessToken({
        user_id: payload.user_id,
        email:   payload.email ?? '',
        role:    payload.role  ?? 'viewer',
      });

      return reply.send({ success: true, data: { access_token: accessToken } });
    } catch {
      return reply.code(401).send({ success: false, error: 'Refresh token invalid or expired' });
    }
  });
}
