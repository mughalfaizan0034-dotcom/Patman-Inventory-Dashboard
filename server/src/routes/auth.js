import { loginBodySchema, refreshBodySchema } from '../validation/authSchemas.js';
import { AppError } from '../utils/errors.js';

export async function authRoutes(fastify, { authService, usersRepo, membershipsRepo, tokenFactory }) {

  /* ── POST /auth/login ──────────────────────────────────────── */
  fastify.post('/login', async (request, reply) => {
    const parsed = loginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: 'Invalid request body' });
    }

    const { username, password } = parsed.data;

    try {
      const result = await authService.login(username, password);
      request.log.info({ event: 'login_success', user_id: result.user_id }, 'User authenticated');

      if (result.memberships.length === 1) {
        // Single membership: auto-select org and issue tokens immediately.
        // role on the JWT comes from users.role (canonical), not memberships.role.
        const m           = result.memberships[0];
        const accessToken = tokenFactory.signAccessToken({ ...m, ...result });
        const refreshToken = tokenFactory.signRefreshToken(result.user_id);

        return reply.send({
          success: true,
          data: {
            access_token:  accessToken,
            refresh_token: refreshToken,
            user: { user_id: result.user_id, username: result.username, display_name: result.display_name },
            organization: {
              organization_id: m.organization_id,
              display_name:    m.org_display_name,
              slug:            m.org_slug,
              membership_id:   m.membership_id,
              role:            result.role,
            },
          },
        });
      }

      // Multiple memberships: issue a pending token for org selection.
      const pendingToken = tokenFactory.signPendingToken(result);
      return reply.send({
        success: true,
        data: {
          requires_org_selection: true,
          pending_token: pendingToken,
          user: { user_id: result.user_id, username: result.username, display_name: result.display_name },
          memberships: result.memberships.map(m => ({
            membership_id:   m.membership_id,
            organization_id: m.organization_id,
            display_name:    m.org_display_name,
            slug:            m.org_slug,
            role:            m.role,
          })),
        },
      });
    } catch (err) {
      if (err instanceof AppError) {
        request.log.warn({ event: 'login_failure', username, ip: request.ip }, 'Authentication failed');
        return reply.code(err.statusCode).send({ success: false, error: err.message });
      }
      request.log.error({ err }, 'Login error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });

  /* ── POST /auth/select-org ─────────────────────────────────── */
  // Called after multi-org login to select a workspace.
  // Requires the pending_token in the Authorization header.
  fastify.post('/select-org', async (request, reply) => {
    const rawToken = request.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!rawToken) return reply.code(401).send({ success: false, error: 'Authorization header required' });

    let payload;
    try {
      payload = fastify.jwt.verify(rawToken);
      if (payload.type !== 'pending') throw new Error('wrong type');
    } catch {
      return reply.code(401).send({ success: false, error: 'Invalid or expired session — please log in again' });
    }

    const { membership_id } = request.body ?? {};
    if (!membership_id) {
      return reply.code(400).send({ success: false, error: 'membership_id is required' });
    }

    try {
      const memberships = await membershipsRepo.getUserMemberships(payload.user_id);
      const m = memberships.find(x => x.membership_id === membership_id);
      if (!m) return reply.code(403).send({ success: false, error: 'Invalid membership selection' });

      const user = await usersRepo.findById(payload.user_id);
      if (!user || !user.is_active) {
        return reply.code(401).send({ success: false, error: 'Account inactive' });
      }

      // role on JWT comes from users.role (canonical global role).
      const accessToken  = tokenFactory.signAccessToken({ ...m, user_id: user.user_id, username: user.username, display_name: user.display_name, role: user.role });
      const refreshToken = tokenFactory.signRefreshToken(user.user_id);

      request.log.info(
        { event: 'org_selected', user_id: user.user_id, organization_id: m.organization_id },
        'Organization selected'
      );

      return reply.send({
        success: true,
        data: {
          access_token:  accessToken,
          refresh_token: refreshToken,
          user: { user_id: user.user_id, username: user.username, display_name: user.display_name },
          organization: { organization_id: m.organization_id, display_name: m.org_display_name, slug: m.org_slug, membership_id: m.membership_id, role: user.role },
        },
      });
    } catch (err) {
      request.log.error({ err }, 'Select-org error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });

  /* ── POST /auth/switch-org ─────────────────────────────────── */
  // Switches org context for an already-authenticated user.
  fastify.post('/switch-org', async (request, reply) => {
    let payload;
    try {
      payload = fastify.jwt.verify(request.headers.authorization?.replace(/^Bearer\s+/i, '') || '');
      if (payload.type !== 'access') throw new Error('wrong type');
    } catch {
      return reply.code(401).send({ success: false, error: 'Token invalid or expired' });
    }

    const { membership_id } = request.body ?? {};
    if (!membership_id) {
      return reply.code(400).send({ success: false, error: 'membership_id is required' });
    }

    try {
      const memberships = await membershipsRepo.getUserMemberships(payload.user_id);
      const m = memberships.find(x => x.membership_id === membership_id);
      if (!m) return reply.code(403).send({ success: false, error: 'Invalid membership selection' });

      const user = await usersRepo.findById(payload.user_id);
      const accessToken  = tokenFactory.signAccessToken({ ...m, user_id: user.user_id, username: user.username, display_name: user.display_name, role: user.role });
      const refreshToken = tokenFactory.signRefreshToken(user.user_id);

      request.log.info(
        { event: 'org_switched', user_id: user.user_id, to_organization_id: m.organization_id },
        'Organization switched'
      );

      return reply.send({
        success: true,
        data: {
          access_token:  accessToken,
          refresh_token: refreshToken,
          organization: { organization_id: m.organization_id, display_name: m.org_display_name, slug: m.org_slug, membership_id: m.membership_id, role: user.role },
        },
      });
    } catch (err) {
      request.log.error({ err }, 'Switch-org error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });

  /* ── POST /auth/refresh ─────────────────────────────────────── */
  fastify.post('/refresh', async (request, reply) => {
    const parsed = refreshBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: 'Invalid request body' });
    }

    // Phase 1: verify the refresh token (pure crypto, no DB).
    let payload;
    try {
      payload = fastify.jwt.verify(parsed.data.refresh_token);
    } catch {
      request.log.warn({ event: 'refresh_failure' }, 'Refresh token invalid or expired');
      return reply.code(401).send({ success: false, error: 'Refresh token invalid or expired' });
    }
    if (payload.type !== 'refresh') {
      return reply.code(401).send({ success: false, error: 'Invalid token type' });
    }

    // Phase 2: load user and memberships (DB calls — may fail transiently).
    try {
      const user = await usersRepo.findById(payload.user_id);
      if (!user || !user.is_active) {
        request.log.warn({ event: 'refresh_failure', user_id: payload.user_id }, 'Account inactive');
        return reply.code(401).send({ success: false, error: 'Account inactive or not found' });
      }

      const memberships = await membershipsRepo.getUserMemberships(user.user_id);
      const m = (parsed.data.membership_id
        ? memberships.find(x => x.membership_id === parsed.data.membership_id)
        : null) ?? memberships[0];

      if (!m) {
        return reply.code(401).send({ success: false, error: 'No active membership found' });
      }

      const accessToken  = tokenFactory.signAccessToken({ ...m, user_id: user.user_id, username: user.username, display_name: user.display_name, role: user.role });
      const refreshToken = tokenFactory.signRefreshToken(user.user_id);

      request.log.info({ event: 'token_refresh', user_id: user.user_id }, 'Tokens rotated');
      return reply.send({ success: true, data: { access_token: accessToken, refresh_token: refreshToken } });
    } catch (err) {
      // DB / BigQuery error — NOT an auth failure. Return 503 so the frontend
      // keeps the session alive and retries rather than forcing logout.
      request.log.error({ err, user_id: payload.user_id }, 'Refresh DB error');
      return reply.code(503).send({ success: false, error: 'Service temporarily unavailable — please try again' });
    }
  });
}
