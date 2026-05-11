import { randomUUID } from 'crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import sensible from '@fastify/sensible';

import { env } from './config/env.js';
import bigqueryPlugin from './plugins/bigquery.js';
import { createTokenFactory } from './auth/tokens.js';

import { createOrganizationsRepository } from './repositories/organizationsRepository.js';
import { createUsersRepository } from './repositories/usersRepository.js';
import { createMembershipsRepository } from './repositories/membershipsRepository.js';
import { createInventoryRepository } from './repositories/inventoryRepository.js';
import { createOrdersRepository } from './repositories/ordersRepository.js';
import { createDashboardRepository } from './repositories/dashboardRepository.js';
import { createUploadsRepository } from './repositories/uploadsRepository.js';

import { createAuthService } from './services/authService.js';
import { createInventoryService } from './services/inventoryService.js';
import { createOrdersService } from './services/ordersService.js';
import { createDashboardService } from './services/dashboardService.js';
import { createUploadsService } from './services/uploadsService.js';
import { createUsersService } from './services/usersService.js';
import { createUsernameService } from './services/usernameService.js';

import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { inventoryRoutes } from './routes/inventory.js';
import { ordersRoutes } from './routes/orders.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { uploadsRoutes } from './routes/uploads.js';
import { usersRoutes } from './routes/users.js';
import { membershipsRoutes } from './routes/memberships.js';
import { organizationsRoutes } from './routes/organizations.js';

export async function buildApp() {
  const fastify = Fastify({
    bodyLimit: 20 * 1024 * 1024, // 20 MB — covers large JSON payloads
    logger: {
      level:     env.LOG_LEVEL,
      transport: env.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
      serializers: {
        err: (err) => ({ type: err.name, message: err.message, stack: err.stack }),
      },
    },
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
  });

  fastify.addHook('onSend', (request, reply, _payload, done) => {
    reply.header('x-request-id', request.id);
    done();
  });

  fastify.addHook('onRequest', (request, _reply, done) => {
    const traceHeader = request.headers['x-cloud-trace-context'];
    if (traceHeader) {
      const traceId = traceHeader.split('/')[0];
      request.log = request.log.child({
        'logging.googleapis.com/trace': `projects/${env.GCP_PROJECT_ID}/traces/${traceId}`,
      });
    }
    done();
  });

  fastify.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode ?? error.status ?? 500;
    const isServer   = statusCode >= 500;

    if (isServer) request.log.error({ err: error }, 'Unhandled server error');

    const body = {
      success:    false,
      error:      isServer && env.NODE_ENV === 'production' ? 'Internal server error' : error.message,
      request_id: request.id,
    };
    if (env.NODE_ENV !== 'production' && error.stack) body.stack = error.stack;

    return reply.code(statusCode).send(body);
  });

  fastify.register(helmet, { global: true });
  fastify.register(cors, {
    origin:  env.CORS_ORIGIN,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });
  fastify.register(jwt, { secret: env.JWT_SECRET });
  fastify.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB per file
  });
  fastify.register(sensible);
  fastify.register(bigqueryPlugin);

  fastify.after(() => {
    const deps = { bq: fastify.bq, projectId: env.GCP_PROJECT_ID };

    // Repositories
    const orgsRepo         = createOrganizationsRepository(deps);
    const usersRepo        = createUsersRepository(deps);
    const membershipsRepo  = createMembershipsRepository(deps);
    const inventoryRepo    = createInventoryRepository(deps);
    const ordersRepo       = createOrdersRepository(deps);
    const dashboardRepo    = createDashboardRepository(deps);
    const uploadsRepo      = createUploadsRepository(deps);

    // Services
    const usernameService  = createUsernameService({ usersRepo });
    const authService      = createAuthService({ usersRepo, membershipsRepo });
    const inventoryService = createInventoryService({ inventoryRepo });
    const ordersService    = createOrdersService({ ordersRepo });
    const dashboardService = createDashboardService({ dashboardRepo });
    const uploadsService   = createUploadsService({ uploadsRepo });
    const usersService     = createUsersService({ usersRepo, membershipsRepo, usernameService });

    const tokenFactory = createTokenFactory(fastify);

    fastify.register(healthRoutes);
    fastify.register(authRoutes,          { prefix: '/auth',          authService, usersRepo, membershipsRepo, tokenFactory });
    fastify.register(inventoryRoutes,     { prefix: '/inventory',     inventoryService });
    fastify.register(ordersRoutes,        { prefix: '/orders',        ordersService });
    fastify.register(dashboardRoutes,     { prefix: '/dashboard',     dashboardService });
    fastify.register(uploadsRoutes,       { prefix: '/uploads',       uploadsService });
    fastify.register(usersRoutes,         { prefix: '/users',         usersService });
    fastify.register(membershipsRoutes,   { prefix: '/memberships',   membershipsRepo });
    fastify.register(organizationsRoutes, { prefix: '/organizations', orgsRepo, membershipsRepo });
  });

  return fastify;
}

async function start() {
  const app = await buildApp();

  const shutdown = async (signal) => {
    app.log.info({ signal }, 'Shutting down');
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
