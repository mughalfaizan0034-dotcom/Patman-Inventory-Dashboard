import { authenticate, requireRole } from '../middleware/authenticate.js';
import { AppError } from '../utils/errors.js';
import { z } from 'zod';

const createOrgSchema = z.object({
  display_name: z.string().min(1).max(100),
  slug:         z.string().min(2).max(40).regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with hyphens'),
});

const updateOrgSchema = z.object({
  display_name: z.string().min(1).max(100).optional(),
  slug:         z.string().min(2).max(40).regex(/^[a-z0-9-]+$/).optional(),
  is_active:    z.boolean().optional(),
});

export async function organizationsRoutes(fastify, { orgsRepo, membershipsRepo }) {
  const { randomUUID } = await import('crypto');

  // List all organizations (super_admin only for now).
  fastify.get('/', { preHandler: [authenticate, requireRole('admin')] }, async (request, reply) => {
    try {
      const data = await orgsRepo.findAll();
      return reply.send({ success: true, data });
    } catch (err) {
      request.log.error({ err }, 'Orgs list error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // Create a new organization.
  fastify.post('/', { preHandler: [authenticate, requireRole('admin')] }, async (request, reply) => {
    const parsed = createOrgSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: 'Invalid request body', details: parsed.error.flatten() });
    }
    try {
      const existing = await orgsRepo.findBySlug(parsed.data.slug);
      if (existing) return reply.code(409).send({ success: false, error: 'Organization slug already exists' });

      const orgId = randomUUID();
      await orgsRepo.insert({
        organization_id: orgId,
        slug:            parsed.data.slug,
        display_name:    parsed.data.display_name,
        is_active:       true,
      });

      // Automatically add the creating user as admin of the new org.
      await membershipsRepo.createMembership({
        membership_id:   randomUUID(),
        user_id:         request.user.user_id,
        organization_id: orgId,
        role:            'admin',
      });

      request.log.info({ event: 'org_created', organization_id: orgId, by: request.user.user_id }, 'Organization created');
      return reply.code(201).send({ success: true, data: { organization_id: orgId, ...parsed.data } });
    } catch (err) {
      if (err instanceof AppError) {
        return reply.code(err.statusCode).send({ success: false, error: err.message });
      }
      request.log.error({ err }, 'Create org error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // Update organization metadata.
  fastify.patch('/:id', { preHandler: [authenticate, requireRole('admin')] }, async (request, reply) => {
    const parsed = updateOrgSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: 'Invalid request body' });
    }
    try {
      const org = await orgsRepo.findById(request.params.id);
      if (!org) return reply.code(404).send({ success: false, error: 'Organization not found' });

      await orgsRepo.update(request.params.id, parsed.data);
      return reply.send({ success: true });
    } catch (err) {
      request.log.error({ err }, 'Update org error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });
}
