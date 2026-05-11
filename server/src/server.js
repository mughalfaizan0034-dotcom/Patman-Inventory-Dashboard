import { randomUUID } from 'crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import sensible from '@fastify/sensible';

import { env } from './config/env.js';
import bigqueryPlugin from './plugins/bigquery.js';
import { createTokenFactory } from './auth/tokens.js';
import { createOrganizationsRepository } from './repositories/organizationsRepository.js';
import { createUsersRepository } from './repositories/usersRepository.js';
import { createInventoryRepository } from './repositories/inventoryRepository.js';
import { createAuthService } from './services/authService.js';
import { createInventoryService } from './services/inventoryService.js';
import { createUsernameService } from './services/usernameService.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { inventoryRoutes } from './routes/inventory.js';

export async function buildApp() {
  const fastify = Fastify({
    logger: {
      level:     env.LOG_LEVEL,
      transport: env.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
      // Serialize errors consistently
      serializers: {
        err: (err) => ({ type: err.name, message: err.message, stack: err.stack }),
      },
    },
    // Use x-request-id header if present, otherwise generate one
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
  });

  // Propagate request ID to every response
  fastify.addHook('onSend', (request, reply, _payload, done) => {
    reply.header('x-request-id', request.id);
    done();
  });

  // Inject Cloud Trace context so Cloud Logging can correlate requests to traces
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

  // Centralized error handler — masks internals in production, includes request_id always
  fastify.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode ?? error.status ?? 500;
    const isServer   = statusCode >= 500;

    if (isServer) {
      request.log.error({ err: error }, 'Unhandled server error');
    }

    const body = {
      success:    false,
      error:      isServer && env.NODE_ENV === 'production' ? 'Internal server error' : error.message,
      request_id: request.id,
    };

    if (env.NODE_ENV !== 'production' && error.stack) {
      body.stack = error.stack;
    }

    return reply.code(statusCode).send(body);
  });

  // Plugins are queued; after() fires once they've all loaded (during ready/listen)
  fastify.register(helmet, { global: true });
  fastify.register(cors, {
    origin:  env.CORS_ORIGIN,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });
  fastify.register(jwt,  { secret: env.JWT_SECRET });
  fastify.register(jwt,  { secret: env.REFRESH_SECRET, namespace: 'refreshJwt' });
  fastify.register(sensible);
  fastify.register(bigqueryPlugin);

  fastify.after(() => {
    const deps = { bq: fastify.bq, projectId: env.GCP_PROJECT_ID };

    const orgsRepo      = createOrganizationsRepository(deps);
    const usersRepo     = createUsersRepository(deps);
    const inventoryRepo = createInventoryRepository(deps);

    const usernameService  = createUsernameService({ usersRepo });
    const authService      = createAuthService({ orgsRepo, usersRepo });
    const inventoryService = createInventoryService({ inventoryRepo });

    const tokenFactory = createTokenFactory(fastify);

    fastify.register(healthRoutes);
    fastify.register(authRoutes,      { prefix: '/auth',      authService, usersRepo, tokenFactory });
    fastify.register(inventoryRoutes, { prefix: '/inventory', inventoryService });
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
