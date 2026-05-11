import { loginBodySchema, refreshBodySchema } from '../validation/authSchemas.js';
import { AppError } from '../utils/errors.js';

export async function authRoutes(fastify, { authService, usersRepo, tokenFactory }) {
  fastify.post('/login', async (request, reply) => {
    const parsed = loginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        success: false,
        error:   'Invalid request body',
        details: parsed.error.flatten(),
      });
    }

    const { organization, username, password } = parsed.data;

    try {
      const user = await authService.login(organization, username, password);
      const accessToken  = tokenFactory.signAccessToken(user);
      const refreshToken = tokenFactory.signRefreshToken(user);

      return reply.send({
        success: true,
        data: {
          access_token:  accessToken,
          refresh_token: refreshToken,
          user: {
            user_id:         user.user_id,
            organization_id: user.organization_id,
            username:        user.username,
            display_name:    user.display_name,
            role:            user.role,
          },
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
      const payload = await fastify.refreshJwt.verify(parsed.data.refresh_token);
      if (payload.type !== 'refresh') {
        return reply.code(401).send({ success: false, error: 'Invalid token type' });
      }

      const user = await usersRepo.findById(payload.user_id);
      if (!user || !user.is_active) {
        return reply.code(401).send({ success: false, error: 'Account inactive or not found' });
      }

      const accessToken = tokenFactory.signAccessToken({
        user_id:         user.user_id,
        organization_id: user.organization_id,
        username:        user.username,
        display_name:    user.display_name,
        role:            user.role,
      });

      return reply.send({ success: true, data: { access_token: accessToken } });
    } catch {
      return reply.code(401).send({ success: false, error: 'Refresh token invalid or expired' });
    }
  });
}
