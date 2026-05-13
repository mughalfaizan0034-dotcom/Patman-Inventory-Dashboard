import { authenticate, requireRole } from '../middleware/authenticate.js';
import { AppError } from '../utils/errors.js';
import { z } from 'zod';

const createUserSchema = z.object({
  display_name:      z.string().min(1).max(100),
  username:          z.string().min(2).max(32),
  password:          z.string().min(8),
  role:              z.enum(['admin', 'manager', 'staff', 'viewer']),
  organization_ids:  z.array(z.string().uuid()).min(1),
});

const updateUserSchema = z.object({
  role:         z.enum(['admin', 'manager', 'staff', 'viewer']).optional(),
  is_active:    z.boolean().optional(),
  display_name: z.string().min(1).max(100).optional(),
  password:     z.string().min(8).optional(),
});

export async function usersRoutes(fastify, { usersService }) {

  // Live availability check for the Add User form.
  // Returns { username, valid, available, suggestions } — suggestions[] is
  // populated only when the requested username is unavailable.
  fastify.get('/check-username', { preHandler: [authenticate, requireRole('admin')] }, async (request, reply) => {
    const username = String(request.query.username || '').trim();
    if (!username) {
      return reply.code(400).send({ success: false, error: 'username query parameter required' });
    }
    try {
      const result = await usersService.checkUsername(username);
      return reply.send({ success: true, data: result });
    } catch (err) {
      request.log.error({ err }, 'Check-username error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // Find global user by username — for assigning existing users to the current org.
  fastify.get('/search', { preHandler: [authenticate, requireRole('admin')] }, async (request, reply) => {
    const username = String(request.query.username || '').trim().toLowerCase();
    if (!username) {
      return reply.code(400).send({ success: false, error: 'username query parameter required' });
    }
    try {
      const user = await usersService.findByUsername(username);
      if (!user) return reply.code(404).send({ success: false, error: 'User not found' });
      return reply.send({ success: true, data: user });
    } catch (err) {
      request.log.error({ err }, 'User search error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // List members of the current org (via memberships).
  fastify.get('/', { preHandler: [authenticate, requireRole('manager')] }, async (request, reply) => {
    try {
      const data = await usersService.list(request.user.organization_id);
      return reply.send({ success: true, data });
    } catch (err) {
      request.log.error({ err }, 'Users list error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // Create new global user + membership(s).
  fastify.post('/', { preHandler: [authenticate, requireRole('admin')] }, async (request, reply) => {
    const parsed = createUserSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: 'Invalid request body', details: parsed.error.flatten() });
    }
    try {
      const data = await usersService.create(request.user.organization_id, parsed.data);
      request.log.info({ event: 'user_created', new_user_id: data.user_id, by: request.user.user_id }, 'User created');
      return reply.code(201).send({ success: true, data });
    } catch (err) {
      if (err instanceof AppError) {
        return reply.code(err.statusCode).send({ success: false, error: err.message });
      }
      request.log.error({ err }, 'User create error');

      // Surface the underlying error so schema mismatches are diagnosable.
      // BigQuery returns descriptive messages for NOT NULL violations etc.
      const raw = err?.message || String(err);
      let hint = '';
      if (/not null|cannot be null|required field/i.test(raw)) {
        hint = ' — looks like the users table still has legacy NOT NULL columns. Run the Phase B migration (server/sql/migrations/20260513_003).';
      }
      return reply.code(500).send({ success: false, error: `User create failed: ${raw}${hint}` });
    }
  });

  // Update membership role/status and optionally user profile (display_name, password).
  fastify.patch('/:id', { preHandler: [authenticate, requireRole('admin')] }, async (request, reply) => {
    const parsed = updateUserSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: 'Invalid request body' });
    }
    try {
      await usersService.updateUser(request.params.id, request.user.organization_id, parsed.data);
      request.log.info({ event: 'user_updated', target_id: request.params.id, by: request.user.user_id }, 'User updated');
      return reply.send({ success: true });
    } catch (err) {
      if (err instanceof AppError) {
        return reply.code(err.statusCode).send({ success: false, error: err.message });
      }
      request.log.error({ err }, 'User update error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // Deactivate membership (does not delete the global user account).
  fastify.delete('/:id', { preHandler: [authenticate, requireRole('admin')] }, async (request, reply) => {
    try {
      await usersService.deactivateMembership(
        request.params.id, request.user.organization_id, request.user.membership_id
      );
      request.log.info({ event: 'membership_deactivated', target_id: request.params.id, by: request.user.user_id }, 'Membership deactivated');
      return reply.send({ success: true });
    } catch (err) {
      if (err instanceof AppError) {
        return reply.code(err.statusCode).send({ success: false, error: err.message });
      }
      request.log.error({ err }, 'User delete error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });
}
