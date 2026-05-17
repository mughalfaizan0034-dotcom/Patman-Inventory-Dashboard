// App version tag. Bumped on each shipped architecture milestone so the
// Settings → System Status panel surfaces what's currently deployed.
// Keep this in sync with the entry in CLAUDE.md → "Build version log".
const APP_VERSION = '2026-05-17-phaseB-validation';

export async function healthRoutes(fastify) {
  fastify.get('/health', { logLevel: 'warn' }, async () => {
    return {
      status:    'ok',
      version:   APP_VERSION,
      timestamp: new Date().toISOString(),
    };
  });

  fastify.get('/health/ready', { logLevel: 'warn' }, async (request, reply) => {
    try {
      await fastify.bq.query({ query: 'SELECT 1' });
      return { status: 'ok', bigquery: 'reachable', timestamp: new Date().toISOString() };
    } catch (err) {
      request.log.error({ err }, 'Readiness check failed');
      return reply.code(503).send({ status: 'error', bigquery: 'unreachable' });
    }
  });
}
