import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import sensible from '@fastify/sensible';

import { env } from './config/env.js';
import bigqueryPlugin from './plugins/bigquery.js';
import { createTokenFactory } from './auth/tokens.js';
import { createUsersRepository } from './repositories/usersRepository.js';
import { createInventoryRepository } from './repositories/inventoryRepository.js';
import { createAuthService } from './services/authService.js';
import { createInventoryService } from './services/inventoryService.js';
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
    },
  });

  // Plugins are queued; after() fires once they've all loaded (during ready/listen)
  fastify.register(cors, { origin: env.CORS_ORIGIN });
  fastify.register(jwt,  { secret: env.JWT_SECRET });
  fastify.register(sensible);
  fastify.register(bigqueryPlugin);

  fastify.after(() => {
    const deps = { bq: fastify.bq, projectId: env.GCP_PROJECT_ID };

    const usersRepo     = createUsersRepository(deps);
    const inventoryRepo = createInventoryRepository(deps);

    const authService      = createAuthService({ usersRepo });
    const inventoryService = createInventoryService({ inventoryRepo });

    const tokenFactory = createTokenFactory(fastify);

    fastify.register(healthRoutes);
    fastify.register(authRoutes,      { prefix: '/auth',      authService, tokenFactory });
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
